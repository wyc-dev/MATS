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

  /**
   * Ensure the Hyperliquid real engine is initialized when switching to real mode.
   * If the engine was not created at startup (e.g. wallet keys were added to .env
   * after startup, or the user switched to real mode via UI), this method creates
   * it on demand using the stored wallet address + private key.
   *
   * Returns true if the engine is ready (or already was), false if keys are missing.
   */
  ensureHyperliquidEngine(): boolean {
    if (this.hyperliquidEngine) return true;

    const wallet = this.config.hyperliquidWalletAddress;
    const privKey = this.config.hyperliquidPrivateKey;

    if (!wallet || !privKey || wallet.length === 0 || privKey.length === 0) {
      log.warn('Cannot initialize Hyperliquid engine: wallet address or private key is empty. Set HYPERLIQUID_WALLET_ADDRESS + HYPERLIQUID_PRIVATE_KEY in .env');
      return false;
    }

    this.hyperliquidEngine = new HyperliquidRealEngine(wallet, privKey);
    log.info('✓ Hyperliquid real engine initialized on demand', {
      wallet: `${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
    });
    return true;
  }

  setTradeMode(mode: TradeMode): void {
    this.config.tradeMode = mode;
    log.info(`Trade mode set to: ${mode}`);

    // When switching to real mode, ensure the exchange engine is initialized.
    // The engine may not have been created at startup if .env keys were empty
    // at that time, or if the user is switching via the UI.
    if (mode === 'real' && this.config.exchange === 'hyperliquid') {
      this.ensureHyperliquidEngine();
    }
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
    } else if (this.config.tradeMode === 'real') {
      log.warn('Real mode is active but no exchange engine is initialized. Set HYPERLIQUID_WALLET_ADDRESS + HYPERLIQUID_PRIVATE_KEY in .env and restart.');
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
   * Get the user's most recent N fills from the active exchange (v2.0.19).
   * Only HyperliquidRealEngine supports this; returns [] for paper/Binance.
   * Used to sync the UI Trade Records panel with the real exchange.
   */
  async getRecentFills(limit = 5): Promise<Array<{
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
    closedPnl: number;
    fee: number;
    dir: string;
  }>> {
    const engine = this.getActiveEngine();
    if (engine instanceof HyperliquidRealEngine) {
      try {
        return await engine.getRecentFills(limit);
      } catch (err) {
        log.warn(`getRecentFills failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return [];
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
        // v2.0.32: Pass leverage via metadata so placeOrder() can call
        // updateLeverage() on HL before placing the order.
        metadata: { leverage: decision.leverage ?? 10 },
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

          // v2.0.32: Place SL/TP on the real exchange (Binance or Hyperliquid)
          if (engine instanceof BinanceRealEngine && slPrice && tpPrice) {
            await engine.setStopLossTakeProfit(
              decision.symbol,
              decision.action as OrderSide,
              quantity,
              slPrice,
              tpPrice,
            );
          }

          // v2.0.32: For Hyperliquid, place native trigger orders on HL
          // immediately after the position opens. This ensures SL/TP protection
          // exists on the exchange from the very first cycle, rather than
          // waiting for the next syncSLTP() call.
          if (engine instanceof HyperliquidRealEngine && (slPrice || tpPrice)) {
            try {
              await engine.adjustPosition(decision.symbol, slPrice, tpPrice);
              log.info(`🔧 SL/TP placed on HL immediately after open: ${decision.symbol} SL=${slPrice?.toFixed(2) ?? '-'} TP=${tpPrice?.toFixed(2) ?? '-'}`);
            } catch (sltpErr) {
              log.error(`Failed to place SL/TP on HL after open: ${sltpErr instanceof Error ? sltpErr.message : String(sltpErr)}`);
            }
          }

          // Renew the local mirror's SL/TP so the TradingView chart + SL/TP
          // monitoring reflect the real trade's levels (v2.0.16). The mirror
          // was opened by paperEngine.executeDecision above with default SL/TP;
          // override with the decision's actual SL/TP prices.
          const mirrorPos = this.portfolio.getPosition(decision.symbol.includes(':') ? decision.symbol : decision.symbol.toLowerCase());
          if (mirrorPos && (slPrice || tpPrice)) {
            const posId = mirrorPos.id;
            this.portfolio.adjustPosition(posId, slPrice, tpPrice);
            // v2.0.32: Mark the mirror as a real position so syncSLTP() picks it up
            mirrorPos.agentId = 'hyperliquid-real';
            log.info(`Mirror SL/TP renewed for ${decision.symbol}: SL=${slPrice?.toFixed(2) ?? '-'} TP=${tpPrice?.toFixed(2) ?? '-'}`);
          }
        } else {
          // v2.0.32: Even without explicit SL/TP from the decision, mark the
          // mirror as a real position so syncSLTP() can place default SL/TP.
          const mirrorPos = this.portfolio.getPosition(decision.symbol.includes(':') ? decision.symbol : decision.symbol.toLowerCase());
          if (mirrorPos) {
            mirrorPos.agentId = 'hyperliquid-real';
          }
        }

        // ── Immediate exchange sync after place/re-place (v2.0.16) ──
        // Fetch the real entry price from the exchange so the local mirror +
        // TradingView chart show the actual fill price, not the decision price.
        // This runs immediately after the order fills (not waiting for the next
        // cycle's syncExchangePositions).
        try {
          const exchangePositions = await engine.getPositions();
          const exPos = exchangePositions.find(
            p => p.symbol.toLowerCase() === decision.symbol.toLowerCase(),
          );
          if (exPos && this.portfolio.hasPosition(decision.symbol.toLowerCase())) {
            // Update the mirror's entry price to the real fill price + leverage
            this.portfolio.softUpdatePosition(decision.symbol.toLowerCase(), exPos.currentPrice);
            log.info(`Mirror synced to exchange fill: ${decision.symbol} entry=${exPos.averageEntryPrice.toFixed(2)} lev=${exPos.leverage}x`);
          }
        } catch (syncErr) {
          log.warn(`Post-trade exchange sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
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
   * v2.0.32: Full sync — when the exchange position differs from the local
   * mirror (side flip, quantity change, entry price change), the mirror is
   * replaced to match the exchange. This prevents stale SL/TP from the old
   * position being pushed to HL via syncSLTP(), which could immediately
   * trigger and close the new position.
   */
  async syncExchangePositions(): Promise<void> {
    const engine = this.getActiveEngine();
    if (!engine) return;

    try {
      const exchangePositions = await engine.getPositions();
      if (!exchangePositions) return;

      // Build a map of exchange positions by normalized symbol
      const exMap = new Map<string, Position>();
      for (const exPos of exchangePositions) {
        const sym = exPos.symbol.includes(':') ? exPos.symbol : exPos.symbol.toLowerCase();
        exMap.set(sym, exPos);
      }

      // v2.0.32: Remove local mirrors that no longer exist on the exchange.
      // This must happen BEFORE syncSLTP() runs, otherwise stale SL/TP from
      // closed positions get pushed to HL and may immediately trigger on
      // unrelated positions. Only remove exchange-imported positions
      // (agentId='hyperliquid-real') — paper positions are handled by
      // reconciliation later.
      // v2.0.32: Use closePosition() instead of removePosition() so that:
      //   1. Trade record is produced (appears in Trade Records UI)
      //   2. Margin is returned to balance
      //   3. Learning mechanisms are triggered (RBC, pattern classifier, etc.)
      //   4. Evolution system learns from the closed position
      // Exchange-imported positions don't have margin deducted (importExchangePosition
      // doesn't deduct), so closePosition() will add margin + PnL back.
      for (const localSym of this.portfolio.getOpenSymbols()) {
        const localPos = this.portfolio.getPosition(localSym);
        if (!localPos || localPos.agentId !== 'hyperliquid-real') continue;
        if (!exMap.has(localSym)) {
          log.info(`📉 Exchange position closed on HL: ${localSym} — closing local mirror (produces trade record + triggers learning)`);
          this.portfolio.closeExchangePosition(localSym, localPos.currentPrice);
        }
      }

      // Update or import exchange positions
      for (const [sym, exPos] of exMap) {
        if (this.portfolio.hasPosition(sym)) {
          const localPos = this.portfolio.getPosition(sym);
          if (localPos) {
            // v2.0.32: Check if the position has fundamentally changed
            // (side flip, quantity change, or entry price change).
            // If so, replace the mirror entirely with fresh SL/TP.
            const sideChanged = localPos.side !== exPos.side;
            const qtyChanged = Math.abs(localPos.quantity - exPos.quantity) > 0.0001;
            const entryChanged = Math.abs(localPos.averageEntryPrice - exPos.averageEntryPrice) > 0.01;

            if (sideChanged || qtyChanged || entryChanged) {
              log.info(`🔄 Position changed on HL: ${sym} side=${localPos.side}→${exPos.side} qty=${localPos.quantity}→${exPos.quantity} entry=${localPos.averageEntryPrice}→${exPos.averageEntryPrice} — replacing mirror`);
              // v2.0.32: Close the old mirror properly (produces trade record
              // + returns margin to balance) instead of silently removing it.
              // This prevents paper positions from "vanishing" without a trace
              // when the exchange position differs (e.g. side flip).
              // Only close if it's a paper position (agentId !== 'hyperliquid-real')
              // — exchange-imported positions don't have margin deducted.
              if (localPos.agentId !== 'hyperliquid-real') {
                this.portfolio.closePosition(sym, localPos.currentPrice);
                log.info(`  → Paper mirror closed: ${localPos.side.toUpperCase()} ${sym} PnL: ${(localPos.unrealizedPnl).toFixed(2)}`);
              } else {
                this.portfolio.removePosition(sym);
              }
              this.portfolio.importExchangePosition(
                exPos.symbol,
                exPos.side,
                exPos.quantity,
                exPos.averageEntryPrice,
                exPos.leverage,
                exPos.openedAt,
              );
            } else {
              // Only price changed — soft update
              this.portfolio.softUpdatePosition(sym, exPos.currentPrice);
            }
          }
        } else {
          // v2.0.31: Import exchange position that doesn't exist locally
          // (e.g. user opened a position manually on HL UI). Create a local
          // mirror so agents can see and manage it (SL/TP, consensus close).
          // Don't deduct margin from paper balance — this position was opened
          // on the exchange, not in the paper portfolio.
          log.info(`📥 Importing exchange position into local mirror: ${exPos.symbol} ${exPos.side.toUpperCase()} qty=${exPos.quantity} entry=${exPos.averageEntryPrice.toFixed(2)} lev=${exPos.leverage}x`);
          this.portfolio.importExchangePosition(
            exPos.symbol,
            exPos.side,
            exPos.quantity,
            exPos.averageEntryPrice,
            exPos.leverage,
            exPos.openedAt,
          );
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
        return positions.filter(p => Math.abs(p.quantity) > 0).map(p => p.symbol.includes(':') ? p.symbol : p.symbol.toLowerCase());
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
   * v2.0.31: Adjust SL/TP for a position. In real mode, this calls the HL API
   * to place native trigger orders AND updates the local mirror. In paper mode,
   * only updates the local mirror.
   */
  async adjustPosition(positionId: string, sl?: number, tp?: number): Promise<void> {
    // Always update local mirror first
    this.portfolio.adjustPosition(positionId, sl, tp);

    // In real mode, also place native trigger orders on HL
    const engine = this.getActiveEngine();
    if (engine) {
      try {
        // Get the position from local portfolio to extract the symbol
        const pos = this.portfolio.getPosition(positionId);
        if (pos) {
          // Pass the symbol to the engine — it matches by symbol, not positionId
          await engine.adjustPosition(pos.symbol, sl, tp);
          log.info(`🔧 Real SL/TP placed on HL: ${pos.symbol} SL=${sl?.toFixed(2) ?? '-'} TP=${tp?.toFixed(2) ?? '-'}`);
        } else {
          // Fallback: pass positionId directly
          await engine.adjustPosition(positionId, sl, tp);
          log.info(`🔧 Real SL/TP placed on HL: ${positionId.slice(0, 20)} SL=${sl?.toFixed(2) ?? '-'} TP=${tp?.toFixed(2) ?? '-'}`);
        }
      } catch (err) {
        log.error(`Failed to place SL/TP on HL: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * v2.0.32: Sync SL/TP from local mirror to HL exchange. For each real position
   * that has SL/TP in the local mirror, check if corresponding trigger orders
   * exist on HL. If not, place them. This runs every cycle in real mode to
   * ensure HL always has SL/TP protection.
   */
  async syncSLTP(): Promise<void> {
    const engine = this.getActiveEngine();
    if (!engine || !(engine instanceof HyperliquidRealEngine)) return;

    try {
      // Get all open orders on HL (both DEX 0 + xyz)
      const openOrders = await engine.getOpenOrders();

      // v2.0.32: Get actual HL positions to verify the local mirror matches.
      // This prevents pushing stale SL/TP from a local mirror that doesn't
      // match the real exchange position (e.g. side flip, stale entry price).
      const hlPositions = await engine.getPositions();
      const hlMap = new Map<string, { side: string; entry: number }>();
      for (const hp of hlPositions) {
        const sym = hp.symbol.includes(':') ? hp.symbol : hp.symbol.toLowerCase();
        hlMap.set(sym, { side: hp.side, entry: hp.averageEntryPrice });
      }

      // Get all local positions that are exchange-imported (real positions)
      const openSymbols = this.portfolio.getOpenSymbols();
      for (const sym of openSymbols) {
        const pos = this.portfolio.getPosition(sym);
        if (!pos || pos.agentId !== 'hyperliquid-real') continue;

        // v2.0.32: Verify the position actually exists on HL with matching side.
        // If the local mirror doesn't match HL, skip SL/TP placement entirely.
        const hlPos = hlMap.get(sym);
        if (!hlPos) {
          log.warn(`⚠️ syncSLTP: ${sym} not found on HL — skipping SL/TP`);
          continue;
        }
        if (hlPos.side !== pos.side) {
          log.warn(`⚠️ syncSLTP: ${sym} side mismatch (local=${pos.side} HL=${hlPos.side}) — skipping SL/TP`);
          continue;
        }

        const sl = pos.stopLossPrice;
        const tp = pos.takeProfitPrice;
        if (!sl && !tp) continue;

        // v2.0.32: Safety check — ensure SL/TP are on the correct side
        // of the entry price for the position's direction.
        // Use the HL entry price (not the local mirror's) for accuracy.
        // For BUY (long): SL < entry, TP > entry
        // For SELL (short): SL > entry, TP < entry
        // If SL/TP are on the wrong side, skip placing them (they would
        // immediately trigger and close the position).
        if (sl) {
          const slCorrect = pos.side === 'buy' ? sl < hlPos.entry : sl > hlPos.entry;
          if (!slCorrect) {
            log.warn(`⚠️ SL ${sl} is on wrong side for ${pos.side} ${pos.symbol} (HL entry=${hlPos.entry}) — skipping SL placement`);
            continue;
          }
        }
        if (tp) {
          const tpCorrect = pos.side === 'buy' ? tp > hlPos.entry : tp < hlPos.entry;
          if (!tpCorrect) {
            log.warn(`⚠️ TP ${tp} is on wrong side for ${pos.side} ${pos.symbol} (HL entry=${hlPos.entry}) — skipping TP placement`);
            continue;
          }
        }

        // v2.0.32: Check if HL already has trigger orders at the SL/TP prices.
        // HL openOrders response doesn't include tpsl field, so we match by
        // coin + side + triggerPx. Side is important: a short position's
        // SL/TP are buy orders (side=B), a long position's are sell orders
        // (side=S). We only manage orders matching the current position's
        // close side — this allows simultaneous long + short on the same asset.
        const closeSide = pos.side === 'buy' ? 'S' : 'B'; // sell to close long, buy to close short
        const myOrders = openOrders.filter(o =>
          o.coin.toLowerCase() === pos.symbol.toLowerCase() &&
          o.side === closeSide
        );
        // v2.0.32: Compare using rounded prices — HL stores triggerPx as
        // formatted strings (e.g. "60709" not "60709.38"), so we must round
        // our SL/TP values the same way before comparing.
        const slRounded = sl !== undefined ? parseFloat(sl.toFixed(2)) : undefined;
        const tpRounded = tp !== undefined ? parseFloat(tp.toFixed(2)) : undefined;
        const hasSL = slRounded !== undefined && myOrders.some(o =>
          o.triggerPx &&
          Math.abs(parseFloat(o.triggerPx) - slRounded) < 1
        );

        const hasTP = tpRounded !== undefined && myOrders.some(o =>
          o.triggerPx &&
          Math.abs(parseFloat(o.triggerPx) - tpRounded) < 1
        );

        // v2.0.32: Ensure each position (identified by coin + close side)
        // has EXACTLY one SL + one TP on HL. If there are more than 2 orders
        // for this side, or if SL/TP is missing, cancel all orders for this
        // side and re-place them fresh. This prevents duplicate/stale trigger
        // orders accumulating on HL without affecting the opposite side's
        // orders (e.g. if there's also a long position on the same asset).
        const needsRefresh = myOrders.length > 2 || 
          (sl !== undefined && !hasSL) ||
          (tp !== undefined && !hasTP);

        if (needsRefresh && myOrders.length > 0) {
          log.info(`🗑️ Refreshing trigger orders for ${pos.symbol} (${closeSide} side) — cancelling ${myOrders.length} existing order(s)`);
          // Cancel only orders matching this position's close side.
          // We need the correct asset index for each cancel, so we look it up.
          const asset = await engine.getAssetIndexForSymbol(pos.symbol);
          for (const o of myOrders) {
            await engine.cancelOrderWithAsset(asset, o.oid);
          }
          // Re-place both SL and TP fresh
          if (sl && sl > 0) {
            log.info(`🔧 Re-placing SL on HL for ${pos.symbol} @ $${sl.toFixed(2)}`);
            await engine.adjustPosition(pos.symbol, sl, undefined);
          }
          if (tp && tp > 0) {
            log.info(`🔧 Re-placing TP on HL for ${pos.symbol} @ $${tp.toFixed(2)}`);
            await engine.adjustPosition(pos.symbol, undefined, tp);
          }
        } else {
          // Place missing SL only if not already present
          if (sl && !hasSL) {
            log.info(`🔧 SL missing on HL for ${pos.symbol} — placing SL @ $${sl.toFixed(2)}`);
            await engine.adjustPosition(pos.symbol, sl, undefined);
          }

          // Place missing TP only if not already present
          if (tp && !hasTP) {
            log.info(`🔧 TP missing on HL for ${pos.symbol} — placing TP @ $${tp.toFixed(2)}`);
            await engine.adjustPosition(pos.symbol, undefined, tp);
          }
        }
      }
    } catch (err) {
      log.warn(`syncSLTP failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
