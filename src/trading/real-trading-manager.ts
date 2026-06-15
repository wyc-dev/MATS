// ─── Real Trading Manager ───
// Orchestrates between paper trading, Binance real, and Hyperliquid real engines.
// Provides a unified interface for the HACP system to execute trades regardless
// of the underlying exchange or trade mode.

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { PortfolioTracker } from './portfolio.ts';
import { RiskEngine } from '../risk/engine.ts';
import { PaperTradingEngine } from './paper-engine.ts';
import { BinanceRealEngine } from './binance-real-engine.ts';
import { HyperliquidRealEngine } from './hyperliquid-real-engine.ts';
import type {
  TradeMode,
  ExchangeType,
  TradingDecision,
  Order,
  OrderSide,
  Position,
  ExchangeAccountInfo,
  RealTradingEngine,
} from '../types/index.ts';

const log = createLogger({ phase: 'real-trading' });

export interface TradingManagerConfig {
  tradeMode: TradeMode;
  exchange: ExchangeType;
  binanceApiKey: string;
  binanceSecretKey: string;
  hyperliquidWalletAddress: string;
  hyperliquidPrivateKey: string;
}

export class RealTradingManager {
  private config: TradingManagerConfig;
  private paperEngine: PaperTradingEngine;
  private portfolio: PortfolioTracker;
  private riskEngine: RiskEngine;
  private binanceEngine: BinanceRealEngine | null = null;
  private hyperliquidEngine: HyperliquidRealEngine | null = null;

  constructor(
    config: TradingManagerConfig,
    portfolio: PortfolioTracker,
    riskEngine: RiskEngine,
    paperEngine: PaperTradingEngine,
  ) {
    this.config = config;
    this.portfolio = portfolio;
    this.riskEngine = riskEngine;
    this.paperEngine = paperEngine;

    // Initialize real engines if keys are provided
    if (config.binanceApiKey && config.binanceSecretKey) {
      this.binanceEngine = new BinanceRealEngine(
        config.binanceApiKey,
        config.binanceSecretKey,
        true, // use futures
      );
    }

    if (config.hyperliquidWalletAddress && config.hyperliquidPrivateKey) {
      this.hyperliquidEngine = new HyperliquidRealEngine(
        config.hyperliquidWalletAddress,
        config.hyperliquidPrivateKey,
      );
    }

    log.info('Real Trading Manager initialized', {
      tradeMode: config.tradeMode,
      exchange: config.exchange,
      binanceReady: !!this.binanceEngine,
      hyperliquidReady: !!this.hyperliquidEngine,
    });
  }

  /** Get the active engine based on current config */
  private getActiveEngine(): RealTradingEngine | null {
    if (this.config.tradeMode === 'paper') return null;

    switch (this.config.exchange) {
      case 'binance':
        return this.binanceEngine;
      case 'hyperliquid':
        return this.hyperliquidEngine;
      default:
        return null;
    }
  }

  /** Get the engine for a specific exchange (for data fetching regardless of trade mode) */
  getEngineForExchange(exchange: ExchangeType): RealTradingEngine | null {
    switch (exchange) {
      case 'binance':
        return this.binanceEngine;
      case 'hyperliquid':
        return this.hyperliquidEngine;
      default:
        return null;
    }
  }

  // ── Config Management ──

  setTradeMode(mode: TradeMode): void {
    this.config.tradeMode = mode;
    log.info(`Trade mode set to: ${mode}`);
  }

  setExchange(exchange: ExchangeType): void {
    this.config.exchange = exchange;
    log.info(`Exchange set to: ${exchange}`);
  }

  getTradeMode(): TradeMode {
    return this.config.tradeMode;
  }

  getExchange(): ExchangeType {
    return this.config.exchange;
  }

  // ── Balance & Positions ──

  /**
   * Get account balance from the active exchange.
   * Falls back to paper portfolio if in paper mode.
   */
  async getBalance(): Promise<ExchangeAccountInfo> {
    const engine = this.getActiveEngine();
    if (engine) {
      try {
        return await engine.getBalance();
      } catch (err) {
        log.error(`Failed to get balance from ${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fallback to paper portfolio
    const p = this.portfolio.getPortfolio();
    return {
      free: p.balance,
      locked: 0,
      total: p.totalEquity,
      unrealizedPnl: p.totalPnl,
      marginUsed: 0,
    };
  }

  /**
   * Get positions from the active exchange.
   * Falls back to paper portfolio if in paper mode.
   */
  async getPositions(): Promise<Position[]> {
    const engine = this.getActiveEngine();
    if (engine) {
      try {
        return await engine.getPositions();
      } catch (err) {
        log.error(`Failed to get positions from ${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fallback to paper portfolio
    return Array.from(this.portfolio.getPortfolio().positions.values());
  }

  // ── Order Execution ──

  /**
   * Execute a trading decision through the active engine or paper trading.
   */
  async executeDecision(decision: TradingDecision): Promise<{
    success: boolean;
    orderId?: string;
    error?: string;
    paperReports?: any[];
  }> {
    const engine = this.getActiveEngine();

    if (engine) {
      // Real trading mode
      if (decision.action === 'hold') {
        log.info('HOLD — no real trade executed.');
        return { success: true };
      }

      const price = decision.entryPrice ?? 0;
      if (price <= 0) {
        return { success: false, error: 'No price available for real trade' };
      }

      const equity = this.portfolio.getEquity();
      const positionSize = decision.positionSizePct * equity;
      const quantity = positionSize / price;

      if (quantity <= 0) {
        return { success: false, error: 'Position size too small' };
      }

      const order: Order = {
        id: '' as any,
        symbol: decision.symbol,
        side: decision.action as OrderSide,
        type: 'market',
        quantity,
        price,
        status: 'pending',
        filledQuantity: 0,
        filledPrice: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agentId: '' as any,
      };

      const result = await engine.placeOrder(order);

      if (result.success && result.orderId) {
        log.info(`Real trade executed: ${decision.action.toUpperCase()} ${quantity.toFixed(6)} ${decision.symbol} via ${engine.name}`);

        // ── Mirror the real trade into the local paper portfolio ──
        // This ensures the local PortfolioTracker accurately tracks:
        //   - Leveraged P&L from entry-mark price differences
        //   - Stop-loss / take-profit monitoring
        //   - Unrealized PnL updates on every price tick
        //   - Trade records for evolution learning
        // The local mirror uses the same leverage as the real trade.
        const decisionWithLev = { ...decision, leverage: decision.leverage ?? 1 };
        const mirrorReports = await this.paperEngine.executeDecision(decisionWithLev);

        // Set SL/TP if provided
        if (decision.stopLossPct || decision.takeProfitPct) {
          const slPrice = decision.stopLossPct
            ? decision.action === 'buy'
              ? price * (1 - decision.stopLossPct)
              : price * (1 + decision.stopLossPct)
            : undefined;
          const tpPrice = decision.takeProfitPct
            ? decision.action === 'buy'
              ? price * (1 + decision.takeProfitPct)
              : price * (1 - decision.takeProfitPct)
            : undefined;

          if (engine instanceof BinanceRealEngine && slPrice && tpPrice) {
            await engine.setStopLossTakeProfit(
              decision.symbol,
              decision.action as OrderSide,
              quantity,
              slPrice,
              tpPrice,
            );
          }
        }

        return {
          success: result.success,
          orderId: result.orderId,
          paperReports: mirrorReports,
        };
      }

      return {
        success: result.success,
        orderId: result.orderId,
        error: result.error,
      };
    } else {
      // Paper trading mode
      const reports = await this.paperEngine.executeDecision(decision);
      return {
        success: reports.length === 0 || reports.every(r => !r.error),
        paperReports: reports,
      };
    }
  }

  /**
   * Sync positions from the exchange into the local portfolio tracker.
   * Called before each decision cycle so agents see real P&L.
   * Only updates currentPrice + unrealizedPnl on existing mirror positions;
   * does not auto-open/close (mirror handles that via HACP decisions).
   */
  async syncExchangePositions(): Promise<void> {
    const engine = this.getActiveEngine();
    if (!engine) return;

    try {
      const exchangePositions = await engine.getPositions();
      if (!exchangePositions || exchangePositions.length === 0) return;

      for (const exPos of exchangePositions) {
        if (this.portfolio.hasPosition(exPos.symbol)) {
          // Soft-update: P&L recalculated, but SL/TP not auto-triggered.
          // The exchange natively manages stop-losses; the mirror must not
          // prematurely close a position that's still open on the exchange.
          this.portfolio.softUpdatePosition(exPos.symbol, exPos.currentPrice);
        }
      }
    } catch (err) {
      log.warn(`syncExchangePositions failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get the list of symbols that have open positions on the active exchange.
   * In paper mode, returns the local portfolio's positions.
   * Used by PortfolioTracker.reconcilePositions() to detect stale local mirrors.
   */
  async getOpenPositionSymbols(): Promise<string[]> {
    const engine = this.getActiveEngine();
    if (engine) {
      try {
        const positions = await engine.getPositions();
        return positions.filter(p => Math.abs(p.quantity) > 0).map(p => p.symbol.toLowerCase());
      } catch (err) {
        log.warn(`getOpenPositionSymbols from exchange failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Paper mode: no external exchange to reconcile against.
    // Return all local positions (identity mapping = no effect).
    // Stale price-based detection still runs via the polling mechanism:
    // if a position's price stops updating because the data feed changed
    // to a different symbol, it'll eventually get detected.
    return this.portfolio.getOpenSymbols();
  }

  /**
   * Close a position on the active exchange or paper.
   */
  async closePosition(symbol: string): Promise<boolean> {
    const engine = this.getActiveEngine();
    if (engine) {
      const success = await engine.closePosition(symbol);
      if (success) {
        // Record the trade in portfolio so it appears in trade records
        const pos = this.portfolio.getPosition(symbol);
        if (pos) {
          this.portfolio.closePosition(symbol, pos.currentPrice);
        }
      }
      return success;
    }

    // Paper: close via portfolio
    const pos = this.portfolio.getPosition(symbol);
    if (pos) {
      this.portfolio.closePosition(symbol, pos.currentPrice);
      return true;
    }
    return false;
  }

  /**
   * Get current mark price from the active exchange.
   */
  async getMarkPrice(symbol: string): Promise<number> {
    const engine = this.getActiveEngine();
    if (engine) {
      try {
        if (engine instanceof BinanceRealEngine) {
          return await engine.getMarkPrice(symbol);
        }
      } catch { /* fallback */ }
    }
    return 0;
  }

  /**
   * Get exchange-specific account info for display.
   */
  async getExchangeAccountInfo(): Promise<{
    exchange: ExchangeType;
    tradeMode: TradeMode;
    balance: ExchangeAccountInfo;
    positions: Position[];
  }> {
    const balance = await this.getBalance();
    const positions = await this.getPositions();

    return {
      exchange: this.config.exchange,
      tradeMode: this.config.tradeMode,
      balance,
      positions,
    };
  }
}
