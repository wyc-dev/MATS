// ─── Hyperliquid WebSocket Manager ───
// Production-grade real-time market data connection for Hyperliquid perp DEXs.
// Subscribes to l2Book (order book), trades (tape), and activeAssetCtx (mark price + funding).
// Auto-reconnect with exponential backoff, graceful shutdown.
//
// Endpoint: wss://api.hyperliquid.xyz/ws
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket

import WebSocket from 'ws';
import { createLogger } from '../observability/logger.ts';
import { registerShutdownHandler, isShuttingDown } from '../utils/shutdown.ts';

const log = createLogger({ phase: 'data' });

// ─── Types ───

export interface HLMarkPrice {
  symbol: string;
  markPrice: number;
  fundingRate: number;
  openInterest: number;
  dayNtlVolume: number;
  prevDayPrice: number;
  oraclePrice: number;
}

export interface HLOrderBook {
  symbol: string;
  bids: Array<{ price: number; size: number; count: number }>;
  asks: Array<{ price: number; size: number; count: number }>;
  timestamp: number;
}

export interface HLTrade {
  symbol: string;
  side: 'B' | 'A';
  price: number;
  size: number;
  timestamp: number;
  hash: string;
  tid: number;
  buyer: string;
  seller: string;
}

/**
 * A position snapshot from the `clearinghouseState` user subscription.
 * Pushed on every position change (open/close/resize) — no REST polling needed.
 */
export interface HLUserPosition {
  symbol: string;
  side: 'buy' | 'sell';
  /** Absolute position size (base units) */
  size: number;
  /** Average entry price */
  entryPx: number;
  /** Unrealized PnL in USD */
  unrealizedPnl: number;
  /** Leverage value (e.g. 5 = 5x) */
  leverage: number;
  /** Liquidation price (0 if not provided) */
  liquidationPx: number;
  /** Whether this is the initial snapshot vs a streaming update */
  isSnapshot: boolean;
}

/**
 * A user fill from the `userFills` subscription. Pushed on every trade
 * execution — used to update the local portfolio entry point immediately
 * after a real order fills on Hyperliquid.
 */
export interface HLUserFill {
  symbol: string;
  side: 'B' | 'A';
  price: number;
  size: number;
  timestamp: number;
  /** Closed PnL if this fill closed part/all of a position (0 otherwise) */
  closedPnl: number;
  /** Fee paid (negative = rebate) */
  fee: number;
  /** Whether this is the initial snapshot vs a streaming fill */
  isSnapshot: boolean;
  /** v2.0.35: Direction string from HL — "Open Long", "Open Short",
   *  "Close Long", "Close Short", etc. Used to distinguish opening vs
   *  closing fills (closedPnl alone is unreliable for partial closes). */
  dir: string;
}

// ─── Callback Types ───

export type HLPriceCallback = (data: HLMarkPrice) => void;
export type HLOrderBookCallback = (book: HLOrderBook) => void;
export type HLTradeCallback = (trade: HLTrade) => void;
export type HLConnectionCallback = (connected: boolean) => void;
/** Called when the user's clearinghouse state changes (positions open/close/resize). */
export type HLPositionCallback = (positions: HLUserPosition[]) => void;
/** Called when a user fill arrives (order executed on Hyperliquid). */
export type HLFillCallback = (fill: HLUserFill) => void;

// ─── WS Message Types ───

interface HLWsMessage {
  channel: string;
  data: unknown;
}

interface HLWsBookData {
  coin: string;
  time: number;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
}

interface HLWsTradeData {
  coin: string;
  side: string;
  px: string;
  sz: string;
  hash: string;
  time: number;
  tid: number;
  users: [string, string];
}

interface HLWsAssetCtxData {
  coin: string;
  ctx: {
    dayNtlVlm: string;
    prevDayPx: string;
    markPx: string;
    midPx?: string;
    funding: string;
    openInterest: string;
    oraclePx: string;
  };
}

// ─── Manager ───

export class HyperliquidWebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  // v2.0.XX: Infinite reconnect — network outages (DNS failure, WiFi drop)
  // can last longer than 50 × 60s = 50min. Giving up permanently means the
  // system never recovers when the network returns. Cap the backoff at 60s
  // but never stop trying.
  private readonly maxReconnectAttempts = Infinity;
  private readonly baseDelay = 1000;
  private readonly maxDelay = 60_000;
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Active subscriptions
  private activeSymbol: string | null = null;
  private subscribedChannels: Set<string> = new Set();

  // User-level subscription state (v2.0.16): clearinghouseState + userFills
  // require a wallet address. When set, the WS subscribes to the user's
  // position + fill feeds so the local portfolio + UI stay in sync with
  // Hyperliquid in real time (no REST polling).
  private walletAddress: string | null = null;
  private userSubscribed = false;

  // Callbacks
  private readonly priceCallbacks: Set<HLPriceCallback> = new Set();
  private readonly orderBookCallbacks: Set<HLOrderBookCallback> = new Set();
  private readonly tradeCallbacks: Set<HLTradeCallback> = new Set();
  private readonly connectionCallbacks: Set<HLConnectionCallback> = new Set();
  private readonly positionCallbacks: Set<HLPositionCallback> = new Set();
  private readonly fillCallbacks: Set<HLFillCallback> = new Set();

  // Local order book state
  private bids: Map<number, { size: number; count: number }> = new Map();
  private asks: Map<number, { size: number; count: number }> = new Map();
  private lastBookTimestamp = 0;

  // Latest mark price data
  private latestMarkPrice: HLMarkPrice | null = null;

  // Large trade tracking (for whale detection)
  private recentLargeTrades: HLTrade[] = [];
  private readonly LARGE_TRADE_THRESHOLD_USD = 50_000; // $50k+ = large

  constructor() {
    registerShutdownHandler('hyperliquid-websocket', async () => {
      await this.disconnect();
    }, 10);
  }

  // ── Public API ──

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getActiveSymbol(): string | null {
    return this.activeSymbol;
  }

  getLatestMarkPrice(): HLMarkPrice | null {
    return this.latestMarkPrice;
  }

  /**
   * Set the wallet address for user-level subscriptions (clearinghouseState +
   * userFills). When set and the WS is connected, subscribes to the user's
   * position + fill feeds. Call this once at startup when real trading is
   * enabled (v2.0.16).
   */
  setWalletAddress(address: string): void {
    this.walletAddress = address.toLowerCase();
    log.info(`HL WS wallet address set: ${address.slice(0, 6)}...${address.slice(-4)}`);
    // If already connected, subscribe immediately
    if (this.isConnected() && !this.userSubscribed) {
      this.subscribeUserFeeds();
    }
  }

  /** Register a callback for user position updates (clearinghouseState). */
  onPositions(cb: HLPositionCallback): void {
    this.positionCallbacks.add(cb);
  }

  /** Register a callback for user fill updates (userFills). */
  onFills(cb: HLFillCallback): void {
    this.fillCallbacks.add(cb);
  }

  /** Get the latest user positions from the last clearinghouseState push. */
  private latestUserPositions: HLUserPosition[] = [];
  getUserPositions(): HLUserPosition[] {
    return [...this.latestUserPositions];
  }

  /** Get the timestamp of the last order book update (ms epoch). 0 = never updated. */
  getLastBookTimestamp(): number {
    return this.lastBookTimestamp;
  }

  /**
   * Get top N order book levels as a flat array sorted by proximity to mid price.
   * Each entry: { price, size }. Used by SystemGuard for liquidity checks.
   */
  getOrderBookLevels(limit = 10): Array<{ price: number; size: number }> {
    try {
      const bestBid = this.getBestBid();
      const bestAsk = this.getBestAsk();
      if (!bestBid || !bestAsk) return [];

      const mid = (bestBid.price + bestAsk.price) / 2;

      const bidLevels = Array.from(this.bids.entries())
        .sort(([a], [b]) => b - a)
        .slice(0, limit)
        .map(([price, data]) => ({ price, size: data.size }));

      const askLevels = Array.from(this.asks.entries())
        .sort(([a], [b]) => a - b)
        .slice(0, limit)
        .map(([price, data]) => ({ price, size: data.size }));

      // Interleave: closest to mid first
      const result: Array<{ price: number; size: number }> = [];
      let bi = 0, ai = 0;
      while (bi < bidLevels.length || ai < askLevels.length) {
        if (ai >= askLevels.length || (bi < bidLevels.length && Math.abs(bidLevels[bi]!.price - mid) <= Math.abs(askLevels[ai]!.price - mid))) {
          result.push(bidLevels[bi]!);
          bi++;
        } else {
          result.push(askLevels[ai]!);
          ai++;
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  getOrderBookImbalance(): number {
    const bidTotal = Array.from(this.bids.values()).reduce((s, v) => s + v.size, 0);
    const askTotal = Array.from(this.asks.values()).reduce((s, v) => s + v.size, 0);
    const total = bidTotal + askTotal;
    if (total < 0.001) return 0;
    return (bidTotal - askTotal) / total; // -1 (all asks) to +1 (all bids)
  }

  getSpread(): number {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    if (!bestBid || !bestAsk) return 0;
    return bestAsk.price - bestBid.price;
  }

  getBestBid(): { price: number; size: number } | null {
    let best: { price: number; size: number } | null = null;
    for (const [price, data] of this.bids) {
      if (!best || price > best.price) best = { price, size: data.size };
    }
    return best;
  }

  getBestAsk(): { price: number; size: number } | null {
    let best: { price: number; size: number } | null = null;
    for (const [price, data] of this.asks) {
      if (!best || price < best.price) best = { price, size: data.size };
    }
    return best;
  }

  getRecentLargeTrades(limit = 10): HLTrade[] {
    return this.recentLargeTrades.slice(-limit);
  }

  getLargeTradeCount(sinceMs = 60_000): number {
    const cutoff = Date.now() - sinceMs;
    return this.recentLargeTrades.filter(t => t.timestamp >= cutoff).length;
  }

  // ── Callback Registration ──

  onPrice(cb: HLPriceCallback): () => void {
    this.priceCallbacks.add(cb);
    return () => this.priceCallbacks.delete(cb);
  }

  onOrderBook(cb: HLOrderBookCallback): () => void {
    this.orderBookCallbacks.add(cb);
    return () => this.orderBookCallbacks.delete(cb);
  }

  onTrade(cb: HLTradeCallback): () => void {
    this.tradeCallbacks.add(cb);
    return () => this.tradeCallbacks.delete(cb);
  }

  onConnectionChange(cb: HLConnectionCallback): () => void {
    this.connectionCallbacks.add(cb);
    return () => this.connectionCallbacks.delete(cb);
  }

  // ── Connection Management ──

  async connect(symbol: string): Promise<void> {
    // Hyperliquid WebSocket ONLY supports DEX 0 bare symbols (BTC, ETH, SOL).
    // DEX 1-8 colon-prefixed symbols (xyz:META, flx:NVDA) are NOT supported.
    // MultiExchangeWebSocketManager uses REST polling fallback for those.
    if (symbol.includes(':')) {
      log.warn(`HL WS does not support DEX 1-8 symbols like ${symbol}. Use REST polling via MultiExchangeWebSocketManager.`);
      this.connected = false;
      this.notifyConnectionChange(false);
      return;
    }

    if (this.isConnected() && this.activeSymbol === symbol) {
      log.info(`Already connected to HL WS for ${symbol}`);
      return;
    }

    // If symbol changed, disconnect and reconnect
    if (this.activeSymbol && this.activeSymbol !== symbol) {
      log.info(`Symbol changed: ${this.activeSymbol} → ${symbol}, reconnecting...`);
      await this.disconnect();
    }

    this.activeSymbol = symbol;
    this.reconnectAttempts = 0;
    await this.establishConnection();
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // Unsubscribe before closing
      if (this.connected && this.activeSymbol) {
        try {
          const wsCoin = this.activeSymbol.includes(':') ? this.activeSymbol : this.activeSymbol.toUpperCase();
          for (const channel of this.subscribedChannels) {
            this.sendUnsubscribe(wsCoin, channel);
          }
          this.unsubscribeUserFeeds();
        } catch { /* ignore */ }
      }

      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this.connected = false;
    this.subscribedChannels.clear();
    this.bids.clear();
    this.asks.clear();
    this.recentLargeTrades = [];
    this.latestMarkPrice = null;
    this.notifyConnectionChange(false);
    log.info('HL WebSocket disconnected');
  }

  // ── Private: Connection ──

  private async establishConnection(): Promise<void> {
    if (isShuttingDown()) return;

    const symbol = this.activeSymbol;
    if (!symbol) return;

    return new Promise((resolve, reject) => {
      const wsUrl = 'wss://api.hyperliquid.xyz/ws';
      log.info(`Connecting to HL WS: ${wsUrl} for ${symbol}`);

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!this.connected) {
          ws.close(1000, 'Connection timeout');
          reject(new Error('HL WS connection timeout'));
        }
      }, 15_000);

      ws.on('open', () => {
        clearTimeout(timeout);
        log.info(`HL WS connected for ${symbol}`);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.notifyConnectionChange(true);

        // Subscribe to market-data channels
        // v2.0.79: HL WS requires UPPERCASE coin names for DEX 0 assets
        // (e.g. "BTC", not "btc"). DEX 1-8 symbols (xyz:XYZ100) use the
        // full prefixed name as-is. normalizeSymbol lowercases DEX 0
        // assets, so we must uppercase them back for WS subscriptions.
        const wsCoin = symbol.includes(':') ? symbol : symbol.toUpperCase();
        this.subscribe(wsCoin, 'l2Book');
        this.subscribe(wsCoin, 'trades');
        this.subscribe(wsCoin, 'activeAssetCtx');

        // Subscribe to user-level feeds (clearinghouseState + userFills) if a
        // wallet address is configured. This keeps the local portfolio + UI in
        // real-time sync with Hyperliquid positions + fills (v2.0.16).
        this.userSubscribed = false; // reset on reconnect
        this.subscribeUserFeeds();

        this.startHeartbeat();
        resolve();
      });

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as HLWsMessage;
          this.handleMessage(msg);
        } catch (err) {
          log.warn(`Failed to parse HL WS message: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        this.connected = false;
        this.stopHeartbeat();
        this.notifyConnectionChange(false);
        log.warn(`HL WS closed: code=${code} reason=${reason.toString()}`);

        if (!isShuttingDown() && this.activeSymbol) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        log.error(`HL WS error: ${err.message}`);
        // close event will fire after error, triggering reconnect
      });
    });
  }

  private scheduleReconnect(): void {
    // v2.0.XX: Never give up — network outages can last hours.
    // Cap backoff at maxDelay (60s) but keep retrying forever.
    if (this.reconnectAttempts >= 1000) {
      // Safety valve — log every 1000 attempts but don't stop.
      log.warn(`HL WS: ${this.reconnectAttempts} reconnect attempts — still trying (network may be down).`);
    }

    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.maxDelay,
    );
    this.reconnectAttempts++;

    log.info(`HL WS: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      if (!isShuttingDown() && this.activeSymbol) {
        this.establishConnection().catch((err) => {
          log.warn(`HL WS reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }, delay);
  }

  // ── Private: Subscriptions ──

  private subscribe(symbol: string, type: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      method: 'subscribe',
      subscription: { type, coin: symbol },
    };

    this.ws.send(JSON.stringify(msg));
    this.subscribedChannels.add(type);
    log.debug(`HL WS subscribed: ${type} for ${symbol}`);
  }

  /**
   * Subscribe to user-level feeds (clearinghouseState + userFills) for the
   * configured wallet address. These push position + fill updates in real
   * time, replacing REST polling for portfolio sync (v2.0.16).
   */
  private subscribeUserFeeds(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.walletAddress || this.userSubscribed) return;

    const user = this.walletAddress;
    // clearinghouseState: pushes the user's full position set on every change
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'clearinghouseState', user },
    }));
    // userFills: pushes every fill (order execution) for the user
    this.ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'userFills', user },
    }));
    this.userSubscribed = true;
    log.info(`HL WS subscribed to user feeds (clearinghouseState + userFills) for ${user.slice(0, 6)}...${user.slice(-4)}`);
  }

  /** Unsubscribe from user-level feeds (called on disconnect / wallet change). */
  private unsubscribeUserFeeds(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.walletAddress) {
      this.userSubscribed = false;
      return;
    }
    const user = this.walletAddress;
    try {
      this.ws.send(JSON.stringify({
        method: 'unsubscribe',
        subscription: { type: 'clearinghouseState', user },
      }));
      this.ws.send(JSON.stringify({
        method: 'unsubscribe',
        subscription: { type: 'userFills', user },
      }));
    } catch { /* ignore */ }
    this.userSubscribed = false;
  }

  private sendUnsubscribe(symbol: string, type: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      method: 'unsubscribe',
      subscription: { type, coin: symbol },
    };

    try {
      this.ws.send(JSON.stringify(msg));
    } catch { /* ignore */ }
  }

  // ── Private: Message Handling ──

  private handleMessage(msg: HLWsMessage): void {
    const { channel, data } = msg;

    switch (channel) {
      case 'l2Book':
        this.handleOrderBook(data as HLWsBookData);
        break;
      case 'trades':
        this.handleTrades(data as HLWsTradeData[]);
        break;
      case 'activeAssetCtx':
        this.handleAssetCtx(data as HLWsAssetCtxData);
        break;
      case 'clearinghouseState':
        this.handleClearinghouseState(data as any);
        break;
      case 'userFills':
        this.handleUserFills(data as any);
        break;
      case 'subscriptionResponse':
        log.debug(`HL WS subscription confirmed: ${JSON.stringify(data)}`);
        break;
      default:
        // Ignore unknown channels
        break;
    }
  }

  /**
   * Handle clearinghouseState pushes — the user's full position set on every
   * change (open/close/resize). Forwards to position callbacks so the local
   * portfolio + UI stay in sync with Hyperliquid in real time (v2.0.16).
   */
  private handleClearinghouseState(data: any): void {
    try {
      const inner = data?.clearinghouseState ?? data;
      const assetPositions = inner?.assetPositions ?? [];
      const isSnapshot = data?.isSnapshot === true;

      const positions: HLUserPosition[] = [];
      for (const ap of assetPositions) {
        const p = ap?.position;
        if (!p) continue;
        const size = parseFloat(p.szi ?? '0');
        if (size === 0) continue; // skip closed positions
        const entryPx = parseFloat(p.entryPx ?? '0');
        const unrealizedPnl = parseFloat(p.unrealizedPnl ?? '0');
        const leverage = p.leverage?.value ?? 1;
        const liquidationPx = parseFloat(p.liquidationPx ?? '0');
        positions.push({
          symbol: p.coin,
          side: size > 0 ? 'buy' : 'sell',
          size: Math.abs(size),
          entryPx,
          unrealizedPnl,
          leverage,
          liquidationPx,
          isSnapshot,
        });
      }
      this.latestUserPositions = positions;
      for (const cb of this.positionCallbacks) {
        try { cb(positions); } catch { /* callback error */ }
      }
    } catch (err) {
      log.warn(`[handleClearinghouseState] parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle userFills pushes — every order execution for the user. Forwards to
   * fill callbacks so the local portfolio can update its entry point + SL/TP
   * immediately after a real order fills (v2.0.16).
   */
  private handleUserFills(data: any): void {
    try {
      const fills = data?.fills ?? [];
      const isSnapshot = data?.isSnapshot === true;
      for (const f of fills) {
        const fill: HLUserFill = {
          symbol: f.coin,
          side: f.side === 'B' ? 'B' : 'A',
          price: parseFloat(f.px ?? '0'),
          size: parseFloat(f.sz ?? '0'),
          timestamp: f.time ?? Date.now(),
          closedPnl: parseFloat(f.closedPnl ?? '0'),
          fee: parseFloat(f.fee ?? '0'),
          isSnapshot,
          dir: f.dir ?? '',
        };
        // Skip snapshot fills — only act on streaming fills (new executions)
        if (isSnapshot) continue;
        for (const cb of this.fillCallbacks) {
          try { cb(fill); } catch { /* callback error */ }
        }
      }
    } catch (err) {
      log.warn(`[handleUserFills] parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleOrderBook(data: HLWsBookData): void {
    if (!data?.levels || !Array.isArray(data.levels)) return;

    const [bidLevels, askLevels] = data.levels;

    // Apply bids
    for (const level of bidLevels) {
      const price = parseFloat(level.px);
      const size = parseFloat(level.sz);
      if (size === 0) {
        this.bids.delete(price);
      } else {
        this.bids.set(price, { size, count: level.n });
      }
    }

    // Apply asks
    for (const level of askLevels) {
      const price = parseFloat(level.px);
      const size = parseFloat(level.sz);
      if (size === 0) {
        this.asks.delete(price);
      } else {
        this.asks.set(price, { size, count: level.n });
      }
    }

    // v2.0.32: Use local Date.now() instead of HL server time (data.time)
    // so SystemGuard's staleness check (now - lastBookTimestamp) is accurate.
    // HL server time can differ from local UTC, causing false stale alerts.
    this.lastBookTimestamp = Date.now();

    // Notify callbacks
    const book: HLOrderBook = {
      symbol: data.coin,
      bids: Array.from(this.bids.entries()).map(([price, d]) => ({ price, size: d.size, count: d.count })),
      asks: Array.from(this.asks.entries()).map(([price, d]) => ({ price, size: d.size, count: d.count })),
      timestamp: data.time,
    };

    for (const cb of this.orderBookCallbacks) {
      try { cb(book); } catch { /* ignore */ }
    }
  }

  private handleTrades(data: HLWsTradeData[]): void {
    if (!Array.isArray(data)) return;

    for (const raw of data) {
      const trade: HLTrade = {
        symbol: raw.coin,
        side: raw.side as 'B' | 'A',
        price: parseFloat(raw.px),
        size: parseFloat(raw.sz),
        timestamp: raw.time,
        hash: raw.hash,
        tid: raw.tid,
        buyer: raw.users[0] ?? '',
        seller: raw.users[1] ?? '',
      };

      // Track large trades for whale detection
      const notionalValue = trade.price * trade.size;
      if (notionalValue >= this.LARGE_TRADE_THRESHOLD_USD) {
        this.recentLargeTrades.push(trade);
        // Keep only last 200 large trades
        if (this.recentLargeTrades.length > 200) {
          this.recentLargeTrades.shift();
        }
      }

      // Notify callbacks
      for (const cb of this.tradeCallbacks) {
        try { cb(trade); } catch { /* ignore */ }
      }
    }
  }

  private handleAssetCtx(data: HLWsAssetCtxData): void {
    if (!data?.ctx) return;

    const markPrice: HLMarkPrice = {
      symbol: data.coin,
      markPrice: parseFloat(data.ctx.markPx),
      fundingRate: parseFloat(data.ctx.funding),
      openInterest: parseFloat(data.ctx.openInterest),
      dayNtlVolume: parseFloat(data.ctx.dayNtlVlm),
      prevDayPrice: parseFloat(data.ctx.prevDayPx),
      oraclePrice: parseFloat(data.ctx.oraclePx),
    };

    this.latestMarkPrice = markPrice;

    // Notify callbacks
    for (const cb of this.priceCallbacks) {
      try { cb(markPrice); } catch { /* ignore */ }
    }
  }

  // ── Private: Heartbeat ──

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) {
        this.stopHeartbeat();
        return;
      }

      // Check for stale book data — if no l2Book update received in 60s,
      // the WS is likely in a silent disconnect state (TCP open but no data).
      // Force reconnect to recover.
      if (this.lastBookTimestamp > 0) {
        const bookAge = Date.now() - this.lastBookTimestamp;
        if (bookAge > 60_000) {
          log.warn(`HL WS: book data stale (${(bookAge / 1000).toFixed(0)}s old) — forcing reconnect`);
          this.stopHeartbeat();
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.terminate(); // force close → triggers onclose → scheduleReconnect
          }
          return;
        }
      }

      // Send ping to keep connection alive
      if (this.ws?.readyState === WebSocket.OPEN) {
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

  // ── Private: Notify ──

  private notifyConnectionChange(connected: boolean): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(connected); } catch { /* ignore */ }
    }
  }
}