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
import { BinanceWebSocketManager } from './binance-websocket.ts';
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

export function detectExchange(symbol: string): 'binance' | 'hyperliquid' {
  const upper = symbol.toUpperCase();
  if (symbol.includes(':')) return 'hyperliquid';
  if (upper.endsWith('USDT') || upper.endsWith('USD')) return 'binance';
  // Bare symbols (BTC, ETH, SOL) → Hyperliquid by default
  return 'hyperliquid';
}

// ─── Manager ───

export class MultiExchangeWebSocketManager {
  readonly binance: BinanceWebSocketManager | null;
  readonly hyperliquid: HyperliquidWebSocketManager;

  private activeSymbol: string | null = null;
  private activeExchange: 'binance' | 'hyperliquid' | null = null;

  // Unified callbacks
  private readonly priceCallbacks: Set<UnifiedPriceCallback> = new Set();
  private readonly orderBookCallbacks: Set<UnifiedOrderBookCallback> = new Set();
  private readonly tradeCallbacks: Set<UnifiedTradeCallback> = new Set();
  private readonly connectionCallbacks: Set<UnifiedConnectionCallback> = new Set();

  constructor(binanceWs: BinanceWebSocketManager | null, hyperliquidWs: HyperliquidWebSocketManager) {
    this.binance = binanceWs;
    this.hyperliquid = hyperliquidWs;

    // Wire internal callbacks to unified interface — Binance is optional (null in HL-only mode)
    if (this.binance) {
      this.binance.onPrice((ticker: Ticker) => {
        this.emitUnifiedPrice({
          symbol: ticker.symbol,
          price: ticker.price,
          exchange: 'binance',
        });
      });

      this.binance.onDepth((bids, asks) => {
        const bidTotal = bids.reduce((s, b) => s + b.qty, 0);
        const askTotal = asks.reduce((s, a) => s + a.qty, 0);
        const total = bidTotal + askTotal;
        const imbalance = total > 0 ? (bidTotal - askTotal) / total : 0;
        const bestBid = bids[0]?.price ?? 0;
        const bestAsk = asks[0]?.price ?? 0;
        const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

        this.emitUnifiedOrderBook({
          symbol: this.activeSymbol ?? 'btcusdt',
          bids: bids.map(b => ({ price: b.price, size: b.qty })),
          asks: asks.map(a => ({ price: a.price, size: a.qty })),
          imbalance,
          spread,
          exchange: 'binance',
        });

        const recentLarge = this.binance!.getRecentLargeTrades(5);
        for (const t of recentLarge) {
          this.emitUnifiedTrade({
            symbol: this.activeSymbol ?? 'btcusdt',
            side: t.side,
            price: t.price,
            size: t.size,
            notional: t.notional,
            timestamp: t.timestamp,
            exchange: 'binance',
          });
        }
      });

      this.binance.onConnectionChange((connected: boolean) => {
        this.emitConnectionChange('binance', connected);
      });
    }

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
    if (this.activeExchange === 'binance') return this.binance?.isConnected() ?? false;
    if (this.activeExchange === 'hyperliquid') return this.hyperliquid.isConnected();
    return false;
  }

  /** Connect to the appropriate exchange for the given symbol */
  async connect(symbol: string): Promise<void> {
    const exchange = detectExchange(symbol);

    if (this.activeSymbol === symbol && this.activeExchange === exchange) {
      return; // Already connected
    }

    log.info(`Multi-WS connecting: ${symbol} → ${exchange}`);

    // Disconnect previous if switching exchanges
    if (this.activeExchange && this.activeExchange !== exchange) {
      if (this.activeExchange === 'binance') await this.binance?.disconnect();
      else await this.hyperliquid.disconnect();
    }

    this.activeSymbol = symbol;
    this.activeExchange = exchange;

    if (exchange === 'binance') {
      await this.binance?.switchSymbol(symbol);
    } else {
      await this.hyperliquid.connect(symbol);
    }

    log.info(`Multi-WS connected: ${symbol} on ${exchange}`);
  }

  async disconnect(): Promise<void> {
    if (this.binance) await this.binance.disconnect();
    await this.hyperliquid.disconnect();
    this.activeSymbol = null;
    this.activeExchange = null;
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