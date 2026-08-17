// ─── Multi-Exchange WebSocket Manager ───
// Unified abstraction over Binance + Hyperliquid WebSocket connections.
// Routes to the correct exchange based on symbol format.
// Provides a single callback interface for price, order book, trades.
//
// Symbol routing:
//   - Contains ":" (xyz:GOLD, flx:NVDA) → Hyperliquid
//   - Ends with "USDT" or "USD" → Binance Futures
//   - Bare symbol on HL exchange setting → Hyperliquid

import { createLogger } from '../observability/logger.ts';
import { hlRateLimitedFetch } from '../utils/hl-global-limiter.ts';
import { HyperliquidWebSocketManager, type HLMarkPrice, type HLOrderBook, type HLTrade } from './hyperliquid-websocket.ts';
import type { Ticker } from '../types/index.ts';

const log = createLogger({ phase: 'data' });

// ─── Unified Types ───

export interface UnifiedPrice {
  symbol: string;
  price: number;
  markPrice?: number;
  fundingRate?: number;
  openInterest?: number;
  exchange: 'binance' | 'hyperliquid';
}

export interface UnifiedOrderBook {
  symbol: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  imbalance: number; // -1 to +1
  spread: number;
  exchange: 'binance' | 'hyperliquid';
}

export interface UnifiedTrade {
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  notional: number;
  timestamp: number;
  exchange: 'binance' | 'hyperliquid';
}

export type UnifiedPriceCallback = (price: UnifiedPrice) => void;
export type UnifiedOrderBookCallback = (book: UnifiedOrderBook) => void;
export type UnifiedTradeCallback = (trade: UnifiedTrade) => void;
export type UnifiedConnectionCallback = (exchange: 'binance' | 'hyperliquid', connected: boolean) => void;

// ─── Symbol Detection ───

export function detectExchange(symbol: string): 'hyperliquid' {
  // v2.0.869(主神 binance-websocket 剷除):HL-only mode——全部 hyperliquid
  return 'hyperliquid';
}

// ─── Manager ───

export class MultiExchangeWebSocketManager {
  readonly hyperliquid: HyperliquidWebSocketManager;

  private activeSymbol: string | null = null;
  private activeExchange: 'binance' | 'hyperliquid' | null = null;

  // REST polling fallback for DEX 1-8 symbols (xyz:META, flx:NVDA)
  // HL WebSocket only supports DEX 0 bare symbols.
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  private restPollSymbol: string | null = null;
  private readonly REST_POLL_INTERVAL_MS = 5000;

  // Unified callbacks
  private readonly priceCallbacks: Set<UnifiedPriceCallback> = new Set();
  private readonly orderBookCallbacks: Set<UnifiedOrderBookCallback> = new Set();
  private readonly tradeCallbacks: Set<UnifiedTradeCallback> = new Set();
  private readonly connectionCallbacks: Set<UnifiedConnectionCallback> = new Set();

  constructor(hyperliquidWs: HyperliquidWebSocketManager) {
    this.hyperliquid = hyperliquidWs;

    this.hyperliquid.onPrice((data: HLMarkPrice) => {
      this.emitUnifiedPrice({
        symbol: data.symbol,
        price: data.markPrice,
        markPrice: data.markPrice,
        fundingRate: data.fundingRate,
        openInterest: data.openInterest,
        exchange: 'hyperliquid',
      });
    });

    this.hyperliquid.onOrderBook((book: HLOrderBook) => {
      const bidTotal = book.bids.reduce((s, b) => s + b.size, 0);
      const askTotal = book.asks.reduce((s, a) => s + a.size, 0);
      const total = bidTotal + askTotal;
      const imbalance = total > 0 ? (bidTotal - askTotal) / total : 0;
      const bestBid = book.bids[0]?.price ?? 0;
      const bestAsk = book.asks[0]?.price ?? 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

      this.emitUnifiedOrderBook({
        symbol: book.symbol,
        bids: book.bids.map(b => ({ price: b.price, size: b.size })),
        asks: book.asks.map(a => ({ price: a.price, size: a.size })),
        imbalance,
        spread,
        exchange: 'hyperliquid',
      });
    });

    this.hyperliquid.onTrade((trade: HLTrade) => {
      this.emitUnifiedTrade({
        symbol: trade.symbol,
        side: trade.side === 'B' ? 'buy' : 'sell',
        price: trade.price,
        size: trade.size,
        notional: trade.price * trade.size,
        timestamp: trade.timestamp,
        exchange: 'hyperliquid',
      });
    });

    this.hyperliquid.onConnectionChange((connected: boolean) => {
      this.emitConnectionChange('hyperliquid', connected);
    });
  }

  // ── Public API ──

  getActiveSymbol(): string | null {
    return this.activeSymbol;
  }

  getActiveExchange(): 'binance' | 'hyperliquid' | null {
    return this.activeExchange;
  }

  isConnected(): boolean {
    // v2.0.869(主神 binance-websocket 剷除):HL-only——全部 hyperliquid
    if (this.activeExchange === 'hyperliquid') {
      // REST polling mode for DEX 1-8 symbols counts as "connected"
      if (this.restPollSymbol) return true;
      return this.hyperliquid.isConnected();
    }
    return false;
  }

  /** Connect to the appropriate exchange for the given symbol */
  async connect(symbol: string): Promise<void> {
    const exchange = detectExchange(symbol);

    if (this.activeSymbol === symbol && this.activeExchange === exchange && !this.restPollSymbol) {
      return; // Already connected
    }

    log.info(`Multi-WS connecting: ${symbol} → ${exchange}`);

    // ── DEX 1-8 symbols (xyz:META, flx:NVDA) ──
    // Hyperliquid WebSocket ONLY supports DEX 0 bare symbols (BTC, ETH, SOL).
    // For DEX 1-8 we must use REST polling via l2Book endpoint.
    if (symbol.includes(':') && exchange === 'hyperliquid') {
      // Disconnect any previous WS connection
      await this.hyperliquid.disconnect();

      this.activeSymbol = symbol;
      this.activeExchange = 'hyperliquid';
      await this.startRestPolling(symbol);
      log.info(`Multi-WS using REST polling for DEX 1-8 symbol: ${symbol}`);
      this.emitConnectionChange('hyperliquid', true);
      return;
    }

    // Stop REST polling if we were in fallback mode
    this.stopRestPolling();

    // Disconnect previous if switching exchanges
    if (this.activeExchange && this.activeExchange !== exchange) {
      await this.hyperliquid.disconnect();
    }

    this.activeSymbol = symbol;
    this.activeExchange = exchange;

    await this.hyperliquid.connect(symbol);

    log.info(`Multi-WS connected: ${symbol} on ${exchange}`);
  }

  async disconnect(): Promise<void> {
    this.stopRestPolling();
    await this.hyperliquid.disconnect();
    this.activeSymbol = null;
    this.activeExchange = null;
  }

  // ── REST Polling Fallback (DEX 1-8) ──

  private async pollHLRestPrice(symbol: string): Promise<void> {
    try {
      // v2.0.869-P11(主神 攞錯 data 調查):統一用 candleSnapshot close 價——
      // 同 scanDEX18AssetsInBackground 一致(即市 close ≈ mid)。之前用 l2Book
      // best bid(買方出價)≠ HL mark/mid 價——攞錯價。
      // v2.0.XX: Use global rate limiter instead of raw fetch.
      const coin = symbol;
      const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval: '1d', startTime: Date.now() - 172_800_000, endTime: Date.now() },
        }),
      });
      if (res.ok) {
        const snapData = await res.json() as Array<Record<string, string>>;
        const last = Array.isArray(snapData) && snapData.length > 0 ? snapData[snapData.length - 1]! : null;
        const px = last ? parseFloat(last['c'] ?? '0') : 0;
        if (px > 0) {
          this.emitUnifiedPrice({
            symbol,
            price: px,
            markPrice: px,
            exchange: 'hyperliquid',
          });
          // Emit a minimal orderbook for sentiment engine compatibility
          const bidPx = px;
          const askPx = px * 1.0001; // synthetic 1-bp spread
          this.emitUnifiedOrderBook({
            symbol,
            bids: [{ price: bidPx, size: 0 }],
            asks: [{ price: askPx, size: 0 }],
            imbalance: 0,
            spread: askPx - bidPx,
            exchange: 'hyperliquid',
          });
        }
      }
    } catch (err) {
      log.debug(`REST poll failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async startRestPolling(symbol: string): Promise<void> {
    this.stopRestPolling();
    this.restPollSymbol = symbol;
    // Immediate first poll
    await this.pollHLRestPrice(symbol);
    this.restPollTimer = setInterval(() => {
      if (this.restPollSymbol) {
        this.pollHLRestPrice(this.restPollSymbol).catch(() => { /* ignore */ });
      }
    }, this.REST_POLL_INTERVAL_MS);
  }

  private stopRestPolling(): void {
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
    }
    this.restPollSymbol = null;
  }

  // ── Unified Callbacks ──

  onPrice(cb: UnifiedPriceCallback): () => void {
    this.priceCallbacks.add(cb);
    return () => this.priceCallbacks.delete(cb);
  }

  onOrderBook(cb: UnifiedOrderBookCallback): () => void {
    this.orderBookCallbacks.add(cb);
    return () => this.orderBookCallbacks.delete(cb);
  }

  onTrade(cb: UnifiedTradeCallback): () => void {
    this.tradeCallbacks.add(cb);
    return () => this.tradeCallbacks.delete(cb);
  }

  onConnectionChange(cb: UnifiedConnectionCallback): () => void {
    this.connectionCallbacks.add(cb);
    return () => this.connectionCallbacks.delete(cb);
  }

  // ── Private ──

  private emitUnifiedPrice(price: UnifiedPrice): void {
    for (const cb of this.priceCallbacks) {
      try { cb(price); } catch { /* ignore */ }
    }
  }

  private emitUnifiedOrderBook(book: UnifiedOrderBook): void {
    for (const cb of this.orderBookCallbacks) {
      try { cb(book); } catch { /* ignore */ }
    }
  }

  private emitUnifiedTrade(trade: UnifiedTrade): void {
    for (const cb of this.tradeCallbacks) {
      try { cb(trade); } catch { /* ignore */ }
    }
  }

  private emitConnectionChange(exchange: 'binance' | 'hyperliquid', connected: boolean): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(exchange, connected); } catch { /* ignore */ }
    }
  }
}