// ─── Binance WebSocket Manager ───
// Production-grade real-time market data connection with auto-reconnect, backoff, and graceful shutdown.
// Connects to Binance USDⓈ-M Perpetual Futures for BTCUSDT perp mark price + order book depth.
// BTCUSDT on fstream.binance.com IS the perpetual contract (永續合約).

import WebSocket from 'ws';
import { config } from '../config/index.ts';
import { createLogger } from '../observability/logger.ts';
import { registerShutdownHandler, isShuttingDown } from '../utils/shutdown.ts';
import type { Ticker, MarketRegime, Trend } from '../types/index.ts';

const log = createLogger({ phase: 'data', agent: 'fractal_momentum_sentinel' });

export type PriceCallback = (ticker: Ticker) => void;
export type ConnectionCallback = (connected: boolean) => void;
export type DepthCallback = (bids: Array<{price: number; qty: number}>, asks: Array<{price: number; qty: number}>) => void;

interface StreamSubscription {
  symbol: string;
  channels: string[];
}

// Binance USDⓈ-M Perpetual Futures mark price message (BTCUSDT = 永續合約)
interface BinanceMarkPriceMessage {
  e: 'markPriceUpdate';
  E: number;
  s: string;      // symbol
  p: string;      // mark price
  P: string;      // index price
  i: string;      // estimated settle price
  r: string;      // funding rate
  T: number;      // next funding time
}

// Binance USDⓈ-M Perpetual Futures 24hr ticker
interface BinanceFuturesTickerMessage {
  e: '24hrTicker';
  E: number;
  s: string;
  p: string;      // price change
  P: string;      // price change percent
  w: string;      // weighted average price
  c: string;      // last price
  Q: string;      // last quantity
  v: string;      // total traded base volume
  h: string;      // high
  l: string;      // low
  n: string;      // number of trades
}

// Binance aggregated trade message
interface BinanceAggTradeMessage {
  e: 'aggTrade';
  E: number;
  s: string;
  a: number;  // aggregate trade ID
  p: string;  // price
  q: string;  // quantity
  f: number;  // first trade ID
  l: number;  // last trade ID
  T: number;  // trade time
  m: boolean; // buyer is maker?
}

// Binance partial depth message
interface BinanceDepthMessage {
  e: 'depthUpdate';
  E: number;
  s: string;
  U: number;
  u: number;
  b: string[][];  // bids [[price, qty], ...]
  a: string[][];  // asks [[price, qty], ...]
}

// Snapshot depth (from REST or first depth event)
interface DepthSnapshot {
  lastUpdateId: number;
  bids: string[][];
  asks: string[][];
}

export class BinanceWebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 50;
  private readonly baseDelay = 1000;
  private readonly maxDelay = 60_000;
  private subscriptions: StreamSubscription[] = [];
  private readonly priceCallbacks: Set<PriceCallback> = new Set();
  private readonly connectionCallbacks: Set<ConnectionCallback> = new Set();
  private readonly depthCallbacks: Set<DepthCallback> = new Set();
  private lastTicker: Map<string, Ticker> = new Map();
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Order book state
  private bids: Map<number, number> = new Map();
  private asks: Map<number, number> = new Map();
  // Large trade tracking
  private largeTrades: Array<{ price: number; size: number; notional: number; side: 'buy' | 'sell'; timestamp: number }> = [];
  private readonly LARGE_TRADE_THRESHOLD_USD = 50_000;

  constructor(symbols: string[] = ['btcusdt']) {
    this.subscriptions = symbols.map((s) => ({
      symbol: s.toLowerCase(),
      channels: ['markPrice@1s', 'depth20@100ms', 'aggTrade'],
    }));

    registerShutdownHandler('binance-websocket', async () => {
      await this.disconnect();
    }, 10);
  }

  onPrice(cb: PriceCallback): () => void {
    this.priceCallbacks.add(cb);
    return () => this.priceCallbacks.delete(cb);
  }

  onDepth(cb: DepthCallback): () => void {
    this.depthCallbacks.add(cb);
    return () => this.depthCallbacks.delete(cb);
  }

  onConnectionChange(cb: ConnectionCallback): () => void {
    this.connectionCallbacks.add(cb);
    return () => this.connectionCallbacks.delete(cb);
  }

  getLastTicker(symbol: string): Ticker | undefined {
    return this.lastTicker.get(symbol.toLowerCase());
  }

  getAllTickers(): Ticker[] {
    return Array.from(this.lastTicker.values());
  }

  /** Get order book imbalance: (bidVol - askVol) / (bidVol + askVol). Positive = bullish. */
  getOrderBookImbalance(): number {
    let bidVol = 0, askVol = 0;
    for (const qty of this.bids.values()) bidVol += qty;
    for (const qty of this.asks.values()) askVol += qty;
    const total = bidVol + askVol;
    return total > 0 ? (bidVol - askVol) / total : 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      log.warn('WebSocket already connected or connecting.');
      return;
    }

    // Use fstream.binance.com — BTCUSDT here IS the perpetual contract (永續合約)
    const streams = this.subscriptions.flatMap((sub) =>
      sub.channels.map((ch) => `${sub.symbol}@${ch}`)
    );
    const url = `${config.binance.futuresWsUrl}/${streams.join('/')}`;

    log.info(`Connecting to Binance Futures WebSocket: ${url.slice(0, 100)}...`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        log.info('✓ Binance Futures WebSocket connected.');
        this.startHeartbeat();
        this.notifyConnection(true);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const raw = data.toString();
          const json = JSON.parse(raw) as any;
          const eventType = json.e as string;

          if (eventType === 'markPriceUpdate') {
            const msg = json as any;
            const ticker: Ticker = {
              symbol: (msg.s ?? '').toLowerCase(),
              price: parseFloat(msg.p ?? '0'),
              volume: 0,
              quoteVolume: 0,
              priceChange: 0,
              priceChangePercent: 0,
              high24h: 0,
              low24h: 0,
              timestamp: msg.E ?? Date.now(),
            };
            this.lastTicker.set(ticker.symbol, ticker);
            this.notifyPrice(ticker);
          } else if (eventType === '24hrTicker') {
            const msg = json as any;
            const ticker: Ticker = {
              symbol: (msg.s ?? '').toLowerCase(),
              price: parseFloat(msg.c ?? '0'),
              volume: parseFloat(msg.v ?? '0'),
              quoteVolume: parseFloat(msg.w ?? '0') * parseFloat(msg.v ?? '0'),
              priceChange: parseFloat(msg.p ?? '0'),
              priceChangePercent: parseFloat(msg.P ?? '0'),
              high24h: parseFloat(msg.h ?? '0'),
              low24h: parseFloat(msg.l ?? '0'),
              timestamp: msg.E ?? Date.now(),
            };
            this.lastTicker.set(ticker.symbol, ticker);
            this.notifyPrice(ticker);
          } else if (eventType === 'depthUpdate') {
            const msg = json as any;
            if (msg.b) {
              for (const entry of msg.b) {
                const price = parseFloat(entry[0] ?? '0');
                const qty = parseFloat(entry[1] ?? '0');
                if (qty === 0) this.bids.delete(price);
                else this.bids.set(price, qty);
              }
            }
            if (msg.a) {
              for (const entry of msg.a) {
                const price = parseFloat(entry[0] ?? '0');
                const qty = parseFloat(entry[1] ?? '0');
                if (qty === 0) this.asks.delete(price);
                else this.asks.set(price, qty);
              }
            }
            // Notify depth callbacks with top 10
            const topBids = Array.from(this.bids.entries())
              .sort(([a], [b]) => b - a).slice(0, 10)
              .map(([price, qty]) => ({ price, qty }));
            const topAsks = Array.from(this.asks.entries())
              .sort(([a], [b]) => a - b).slice(0, 10)
              .map(([price, qty]) => ({ price, qty }));
            for (const cb of this.depthCallbacks) {
              try { cb(topBids, topAsks); } catch {}
            }
          } else if (eventType === 'aggTrade') {
            const msg = json as any;
            const price = parseFloat(msg.p ?? '0');
            const qty = parseFloat(msg.q ?? '0');
            const notional = price * qty;
            if (notional >= this.LARGE_TRADE_THRESHOLD_USD) {
              this.largeTrades.push({
                price,
                size: qty,
                notional,
                side: msg.m ? 'sell' : 'buy', // m=true means buyer is maker (passive) = sell pressure
                timestamp: msg.T ?? Date.now(),
              });
              if (this.largeTrades.length > 200) this.largeTrades.shift();
            }
          }
        } catch (err) {
          log.error('Failed to parse WS message.', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.connected = false;
        this.stopHeartbeat();
        this.notifyConnection(false);
        log.warn(`Futures WS disconnected. Code: ${code}`);
        if (!isShuttingDown()) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        log.error(`Futures WS error: ${err.message}`);
      });
    } catch (err) {
      log.error(`Failed to create Futures WS: ${err instanceof Error ? err.message : String(err)}`);
      if (!isShuttingDown()) this.scheduleReconnect();
    }
  }

  private notifyPrice(ticker: Ticker): void {
    for (const cb of this.priceCallbacks) {
      try {
        cb(ticker);
      } catch (err) {
        log.error('Price callback error.', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private notifyConnection(connected: boolean): void {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(connected);
      } catch (err) {
        log.error('Connection callback error.');
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.connected) {
        this.ws.ping();
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnect attempts reached. Giving up.');
      return;
    }

    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.maxDelay
    );

    this.reconnectAttempts++;
    log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.ws = null;
      void this.connect();
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Graceful shutdown');
      this.ws = null;
    }

    this.connected = false;
    this.bids.clear();
    this.asks.clear();
    this.largeTrades = [];
    this.notifyConnection(false);
    log.info('WebSocket disconnected cleanly.');
  }

  /** Switch to a new symbol dynamically */
  async switchSymbol(symbol: string): Promise<void> {
    const normalized = symbol.toLowerCase();
    const current = this.subscriptions.map(s => s.symbol);
    if (current.length === 1 && current[0] === normalized && this.connected) {
      return;
    }
    log.info('Binance WS switching: ' + current.join(',') + ' → ' + normalized);
    await this.disconnect();
    this.subscriptions = [{ symbol: normalized, channels: ['markPrice@1s', 'depth20@100ms'] }];
    this.reconnectAttempts = 0;
    await this.connect();
  }

  getActiveSymbols(): string[] {
    return this.subscriptions.map(s => s.symbol);
  }

  getLargeTradeCount(sinceMs = 60_000): number {
    const cutoff = Date.now() - sinceMs;
    return this.largeTrades.filter(t => t.timestamp >= cutoff).length;
  }

  getRecentLargeTrades(limit = 10): Array<{ price: number; size: number; notional: number; side: 'buy' | 'sell'; timestamp: number }> {
    return this.largeTrades.slice(-limit);
  }
}

// ─── Market State Aggregator ───

export interface AggregatedMarketState {
  primarySymbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  trend: Trend;
  volatility: number;
  regime: MarketRegime;
  orderBookImbalance: number;
  updatedAt: number;
}

/**
 * Dynamic regime threshold calibrator.
 * Tracks the actual distribution of detected regimes over a rolling window.
 * When any single regime dominates >80% of recent observations, the calibrator
 * widens that regime's threshold boundaries so the classifier distributes
 * more evenly across adjacent regimes.
 */
export class RegimeCalibrator {
  private history: string[] = [];
  private readonly maxHistory = 500;
  /** Current adjusted thresholds (multiples of the default threshold) */
  private volHighThreshold = 0.03;    // default
  private volLowThreshold = 0.003;    // default
  private trendThreshold = 0.5;       // default 24h change %
  private readonly minDistribution = 0.4;  // aim for at least 40% non-dominant
  private consecutiveDominantCount = 0;
  lastAdjustment: string = 'default';

  /** Feed one regime observation and auto-adjust if needed. Returns new thresholds */
  observe(regime: string): { volHigh: number; volLow: number; trend: number } {
    this.history.push(regime);
    if (this.history.length > this.maxHistory) this.history.shift();
    if (this.history.length < 50) return this.getThresholds(); // not enough data

    // Count distribution
    const counts = new Map<string, number>();
    for (const r of this.history) counts.set(r, (counts.get(r) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const dominant = sorted[0];
    if (!dominant) return this.getThresholds();
    const dominantPct = dominant[1] / this.history.length;

    if (dominantPct > 0.80) {
      this.consecutiveDominantCount++;
      // Widen the dominant regime's boundary to push observations into neighbours
      if (dominant[0] === 'mean_reverting') {
        // Widen trending/vol thresholds so less data falls into mean_reverting
        this.trendThreshold *= 0.90;      // easier to trigger bullish/bearish
        this.volHighThreshold *= 1.05;     // easier to trigger high_vol
        this.volLowThreshold *= 0.95;      // easier to trigger low_vol
      } else if (dominant[0] === 'low_volatility' || dominant[0] === 'high_volatility') {
        // Tighten the vol boundary
        const factor = dominant[0] === 'low_volatility' ? 0.90 : 1.10;
        this.volLowThreshold *= factor;
        this.volHighThreshold *= factor;
      } else if (dominant[0] === 'trending_bull' || dominant[0] === 'trending_bear') {
        // Require stronger trend
        this.trendThreshold *= 1.10;
      }
      // Clamp to prevent runaway
      this.volHighThreshold = Math.max(0.008, Math.min(0.10, this.volHighThreshold));
      this.volLowThreshold = Math.max(0.0005, Math.min(0.01, this.volLowThreshold));
      this.trendThreshold = Math.max(0.1, Math.min(2.0, this.trendThreshold));
      this.lastAdjustment = `widened ${dominant[0]} boundary (dominated ${(dominantPct*100).toFixed(1)}% of ${this.history.length} obs)`;
    } else {
      this.consecutiveDominantCount = 0;
    }

    return this.getThresholds();
  }

  getThresholds(): { volHigh: number; volLow: number; trend: number } {
    return { volHigh: this.volHighThreshold, volLow: this.volLowThreshold, trend: this.trendThreshold };
  }

  getCalibrationSummary(): string {
    const t = this.getThresholds();
    return `RegimeCalibrator: mean_reverting=${t.trend}% trend threshold, high_vol>${(t.volHigh*100).toFixed(2)}%, low_vol<${(t.volLow*100).toFixed(2)}%. ${this.lastAdjustment !== 'default' ? `Last: ${this.lastAdjustment}` : 'No adjustment yet.'}`;
  }
}

export class MarketStateAggregator {
  private priceHistory: Map<string, number[]> = new Map();
  private readonly historySize = 100;
  private tickers: Map<string, Ticker> = new Map();
  private orderBookImbalance = 0;
  readonly calibrator = new RegimeCalibrator();

  update(ticker: Ticker): void {
    // Normalize symbol to lowercase for case-insensitive matching.
    // HL WebSocket sends "BTC", Market Agent may use "btc" — both must land in the same bucket.
    const sym = ticker.symbol.toLowerCase();
    this.tickers.set(sym, ticker);
    if (!this.priceHistory.has(sym)) {
      this.priceHistory.set(sym, []);
    }
    const history = this.priceHistory.get(sym)!;
    history.push(ticker.price);
    if (history.length > this.historySize) {
      history.shift();
    }
  }

  /** Get per-symbol price history (for drift estimation). Returns copy of array. */
  getPriceHistory(symbol: string): number[] {
    const sym = symbol.toLowerCase();
    return [...(this.priceHistory.get(sym) ?? [])];
  }

  /** Update order book imbalance from depth callbacks */
  updateDepth(bids: Array<{price: number; qty: number}>, asks: Array<{price: number; qty: number}>): void {
    let bidVol = 0, askVol = 0;
    for (const b of bids) bidVol += b.price * b.qty;
    for (const a of asks) askVol += a.price * a.qty;
    const total = bidVol + askVol;
    this.orderBookImbalance = total > 0 ? (bidVol - askVol) / total : 0;
  }

  getState(symbol: string): AggregatedMarketState {
    // Normalize to lowercase — matches update()'s normalisation
    const sym = symbol.toLowerCase();
    const ticker = this.tickers.get(sym);
    const history = this.priceHistory.get(sym) ?? [];

    const volatility = this.calcVolatility(history);
    const trend = this.calcTrend(ticker, volatility);
    const regime = this.calcRegime(trend, volatility);

    // Feed the observation to the calibrator (auto-adjusts thresholds if >80% dominant)
    this.calibrator.observe(regime);

    return {
      primarySymbol: symbol,
      price: ticker?.price ?? 0,
      change24h: ticker?.priceChangePercent ?? 0,
      volume24h: ticker?.volume ?? 0,
      trend,
      volatility,
      regime,
      orderBookImbalance: this.orderBookImbalance,
      updatedAt: ticker?.timestamp ?? Date.now(),
    };
  }

  private calcVolatility(prices: number[]): number {
    if (prices.length < 10) return 0;
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.abs(prices[i]! - prices[i - 1]!) / prices[i - 1]!);
    }
    return returns.reduce((a, b) => a + b, 0) / returns.length;
  }

  private calcTrend(ticker: Ticker | undefined, volatility: number): Trend {
    if (!ticker) return 'sideways';
    const pct = ticker.priceChangePercent;
    const t = this.calibrator.getThresholds();
    if (Math.abs(pct) < t.trend) return 'sideways';
    if (volatility > 0.02) return 'volatile';
    return pct > 0 ? 'bullish' : 'bearish';
  }

  private calcRegime(trend: Trend, volatility: number): MarketRegime {
    const t = this.calibrator.getThresholds();
    if (volatility > t.volHigh) return 'high_volatility';
    if (volatility < t.volLow) return 'low_volatility';
    if (trend === 'bullish') return 'trending_bull';
    if (trend === 'bearish') return 'trending_bear';
    if (trend === 'volatile') return 'chaotic';
    return 'mean_reverting';
  }

  /**
   * v2.0.115: Get a short-term price trend summary for agent context.
   * Returns the price change over the last N ticks, direction, and momentum.
   * This helps agents see "BTC has been rising for the last 20 ticks" instead
   * of just seeing the current price in isolation.
   */
  getRecentPriceTrend(symbol: string, lookback = 20): { direction: 'up' | 'down' | 'flat'; pctChange: number; startPrice: number; endPrice: number; ticks: number } | null {
    const sym = symbol.toLowerCase();
    const history = this.priceHistory.get(sym);
    if (!history || history.length < 5) return null;
    const start = Math.max(0, history.length - lookback);
    const startPrice = history[start]!;
    const endPrice = history[history.length - 1]!;
    const pctChange = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
    const direction: 'up' | 'down' | 'flat' = pctChange > 0.1 ? 'up' : pctChange < -0.1 ? 'down' : 'flat';
    return { direction, pctChange, startPrice, endPrice, ticks: history.length - start };
  }
}