// ─── Real Trading Manager ───
// Orchestrates between paper trading, Binance real, and Hyperliquid real engines.
// Provides a unified interface for the HACP system to execute trades regardless
// of the underlying exchange or trade mode.

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { PortfolioTracker, normalizeSymbol } from './portfolio.ts';
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
      let quantity = positionSize / price;

      // v2.0.32: HL minimum notional floor — if position size is below HL's
      // minimum order notional ($10), bump it up to the minimum so the trade
      // can still execute. If balance can't even cover the minimum, stop.
      const HL_MIN_NOTIONAL_USD = 10;
      const notional = quantity * price;
      if (notional < HL_MIN_NOTIONAL_USD && (decision.action === 'buy' || decision.action === 'sell')) {
        if (equity < HL_MIN_NOTIONAL_USD) {
          log.warn(`⛔ Balance $${equity.toFixed(2)} too low for HL minimum notional $${HL_MIN_NOTIONAL_USD} — skipping trade`);
          return { success: false, error: `Insufficient balance for minimum notional ($${equity.toFixed(2)} < $${HL_MIN_NOTIONAL_USD})` };
        }
        quantity = HL_MIN_NOTIONAL_USD / price;
        log.info(`Position notional $${notional.toFixed(2)} below HL min $${HL_MIN_NOTIONAL_USD} — floored to ${quantity.toFixed(6)} ($${HL_MIN_NOTIONAL_USD} notional)`);
      }

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

        // v2.0.33: PRO ALGO FIRM PATTERN — place SL/TP immediately after fill,
        // using the ACTUAL fill price (not the decision price). Retry on failure.
        // The position must NEVER be left unprotected — if SL/TP placement fails,
        // retry up to 3 times. If still failing, close the position (safety first).
        const sym = decision.symbol.includes(':') ? decision.symbol : decision.symbol.toLowerCase();

        // Step 1: Fetch the actual fill price from the exchange
        let actualEntryPrice = price; // fallback to decision price
        let actualLeverage = decision.leverage ?? 10;
        let actualOpenedAt = Date.now();
        try {
          const exchangePositions = await engine.getPositions();
          const exPos = exchangePositions.find(
            p => normalizeSymbol(p.symbol) === normalizeSymbol(decision.symbol),
          );
          if (exPos) {
            actualEntryPrice = exPos.averageEntryPrice;
            actualLeverage = exPos.leverage;
            if (exPos.openedAt > 0) actualOpenedAt = exPos.openedAt;

            // Update the mirror with the real fill price + leverage + openedAt
            if (this.portfolio.hasPosition(sym)) {
              this.portfolio.softUpdatePosition(sym, exPos.currentPrice);
              const mirrorPos = this.portfolio.getPosition(sym);
              if (mirrorPos) {
                mirrorPos.averageEntryPrice = exPos.averageEntryPrice;
                mirrorPos.leverage = exPos.leverage;
                if (exPos.openedAt > 0) mirrorPos.openedAt = exPos.openedAt;
                mirrorPos.agentId = 'hyperliquid-real';
                log.info(`Mirror synced to exchange fill: ${decision.symbol} entry=${exPos.averageEntryPrice.toFixed(2)} lev=${exPos.leverage}x openedAt=${new Date(actualOpenedAt).toISOString()}`);
              }
            }
          } else {
            log.warn(`⚠️ Position ${decision.symbol} not found on exchange after fill — SL/TP will use decision price`);
          }
        } catch (syncErr) {
          log.warn(`Post-trade exchange sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)} — SL/TP will use decision price`);
        }

        // Step 2: Calculate SL/TP from the ACTUAL fill price
        // v2.0.33: Use S/R levels when available — SL just beyond nearest
        // support (for long) or resistance (for short), TP at the next S/R level.
        // Fall back to percentage-based if S/R not available.
        const srSupport = (decision as any).srSupport as number | null | undefined;
        const srResistance = (decision as any).srResistance as number | null | undefined;
        const slPctDefault = 0.015; // 1.5% default
        const tpPctDefault = 0.03;  // 3% default

        let slPrice: number, tpPrice: number;

        if (decision.action === 'buy') {
          // Long: SL below entry (below nearest support), TP above entry (at resistance)
          if (srSupport && srSupport > 0 && srSupport < actualEntryPrice) {
            // SL just below support (0.3% beyond support to avoid wick stop-outs)
            slPrice = srSupport * 0.997;
            // Ensure SL is at least 0.5% from entry (avoid noise stop-out)
            const minSL = actualEntryPrice * (1 - 0.005);
            slPrice = Math.min(slPrice, minSL);
          } else {
            slPrice = actualEntryPrice * (1 - (decision.stopLossPct ?? slPctDefault));
          }
          if (srResistance && srResistance > 0 && srResistance > actualEntryPrice) {
            tpPrice = srResistance;
          } else {
            tpPrice = actualEntryPrice * (1 + (decision.takeProfitPct ?? tpPctDefault));
          }
        } else {
          // Short: SL above entry (above nearest resistance), TP below entry (at support)
          if (srResistance && srResistance > 0 && srResistance > actualEntryPrice) {
            // SL just above resistance (0.3% beyond resistance to avoid wick stop-outs)
            slPrice = srResistance * 1.003;
            // Ensure SL is at least 0.5% from entry (avoid noise stop-out)
            const minSL = actualEntryPrice * (1 + 0.005);
            slPrice = Math.max(slPrice, minSL);
          } else {
            slPrice = actualEntryPrice * (1 + (decision.stopLossPct ?? slPctDefault));
          }
          if (srSupport && srSupport > 0 && srSupport < actualEntryPrice) {
            tpPrice = srSupport;
          } else {
            tpPrice = actualEntryPrice * (1 - (decision.takeProfitPct ?? tpPctDefault));
          }
        }

        // v2.0.33: Hard constraints — SL 0.5-5% from entry, TP 0.5-5% from entry
        // SL too tight = noise stop-out, SL too wide = excessive risk
        // TP too tight = not enough profit, TP too wide = unreachable
        const slDistPct = Math.abs(slPrice - actualEntryPrice) / actualEntryPrice;
        const tpDistPct = Math.abs(tpPrice - actualEntryPrice) / actualEntryPrice;
        if (slDistPct < 0.005) {
          // SL too tight — widen to 0.5%
          slPrice = decision.action === 'buy'
            ? actualEntryPrice * 0.995
            : actualEntryPrice * 1.005;
        }
        if (slDistPct > 0.05) {
          // SL too wide — narrow to 5%
          slPrice = decision.action === 'buy'
            ? actualEntryPrice * 0.95
            : actualEntryPrice * 1.05;
        }
        if (tpDistPct < 0.005) {
          // TP too tight — widen to 0.5%
          tpPrice = decision.action === 'buy'
            ? actualEntryPrice * 1.005
            : actualEntryPrice * 0.995;
        }
        if (tpDistPct > 0.05) {
          // TP too wide — narrow to 5%
          tpPrice = decision.action === 'buy'
            ? actualEntryPrice * 1.05
            : actualEntryPrice * 0.95;
        }

        // Risk:Reward — TP must be >= SL distance (never risk more than reward)
        const finalSlDist = Math.abs(slPrice - actualEntryPrice);
        const finalTpDist = Math.abs(tpPrice - actualEntryPrice);
        if (finalTpDist < finalSlDist) {
          // TP closer than SL — widen TP to match SL distance
          tpPrice = decision.action === 'buy'
            ? actualEntryPrice + finalSlDist
            : actualEntryPrice - finalSlDist;
        }

        const slPctActual = Math.abs(slPrice - actualEntryPrice) / actualEntryPrice;
        const tpPctActual = Math.abs(tpPrice - actualEntryPrice) / actualEntryPrice;
        log.info(`🎯 SL/TP from S/R: ${decision.symbol} entry=$${actualEntryPrice.toFixed(2)} SL=$${slPrice.toFixed(2)} (${(slPctActual*100).toFixed(2)}%) TP=$${tpPrice.toFixed(2)} (${(tpPctActual*100).toFixed(2)}%) S/R: support=${srSupport ?? 'N/A'} resistance=${srResistance ?? 'N/A'}`);

        // Step 3: Place SL/TP on the exchange with retry logic
        if (engine instanceof HyperliquidRealEngine) {
          let sltpSuccess = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              sltpSuccess = await engine.adjustPosition(decision.symbol, slPrice, tpPrice);
              if (sltpSuccess) {
                log.info(`✅ SL/TP placed on HL (attempt ${attempt}): ${decision.symbol} SL=$${slPrice.toFixed(2)} TP=$${tpPrice.toFixed(2)}`);
                break;
              }
            } catch (sltpErr) {
              log.error(`❌ SL/TP attempt ${attempt} failed: ${sltpErr instanceof Error ? sltpErr.message : String(sltpErr)}`);
            }
            if (attempt < 3) {
              log.warn(`🔄 Retrying SL/TP placement in 1s (attempt ${attempt + 1}/3)...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }

          if (!sltpSuccess) {
            // SAFETY: If SL/TP placement fails after 3 retries, close the position.
            // An unprotected position with 10x leverage is too dangerous to leave open.
            log.error(`🚨 SL/TP placement failed after 3 retries — CLOSING POSITION for safety: ${decision.symbol}`);
            try {
              await engine.closePosition(decision.symbol);
              log.warn(`🛡️ Safety close executed: ${decision.symbol} — position closed because SL/TP could not be placed`);
            } catch (closeErr) {
              log.error(`🚨🚨 SAFETY CLOSE ALSO FAILED: ${closeErr instanceof Error ? closeErr.message : String(closeErr)} — POSITION IS UNPROTECTED ON HL!`);
            }
          }
        } else if (engine instanceof BinanceRealEngine) {
          try {
            await engine.setStopLossTakeProfit(
              decision.symbol,
              decision.action as OrderSide,
              quantity,
              slPrice,
              tpPrice,
            );
            log.info(`✅ SL/TP placed on Binance: ${decision.symbol} SL=$${slPrice.toFixed(2)} TP=$${tpPrice.toFixed(2)}`);
          } catch (sltpErr) {
            log.error(`❌ Binance SL/TP placement failed: ${sltpErr instanceof Error ? sltpErr.message : String(sltpErr)}`);
          }
        }

        // Step 4: Update the local mirror's SL/TP with the actual fill-based prices
        const mirrorPos = this.portfolio.getPosition(sym);
        if (mirrorPos) {
          const posId = mirrorPos.id;
          this.portfolio.adjustPosition(posId, slPrice, tpPrice);
          mirrorPos.agentId = 'hyperliquid-real';
          log.info(`Mirror SL/TP set: ${decision.symbol} SL=$${slPrice.toFixed(2)} TP=$${tpPrice.toFixed(2)}`);
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

      // v2.0.32: Safety check — if getPositions() returned an empty array but
      // we have exchange-imported positions locally, we need to determine if
      // this is a genuine "all positions closed on HL" or an API failure.
      // v2.0.35 FIX: Previously this skipped close entirely when exMap.size === 0,
      // which meant the LAST position to close was never detected — the local
      // mirror stayed forever, no trade record was created, no learning happened.
      // Now we fetch recent fills to verify: if there's a closing fill after the
      // position was opened, the position was genuinely closed on HL.
      const localExchangePositions = this.portfolio.getOpenSymbols().filter(sym => {
        const pos = this.portfolio.getPosition(sym);
        return pos && pos.agentId === 'hyperliquid-real';
      });

      if (exMap.size === 0 && localExchangePositions.length > 0) {
        // v2.0.35: Don't just skip — check recent fills to see if the position
        // was actually closed on HL. If there's a closing fill after openedAt,
        // it's a genuine close, not an API failure.
        let recentFillsForCheck: Array<{ symbol: string; closedPnl: number; side: string; price: number; size: number; timestamp: number; fee: number; dir: string }> = [];
        if (engine instanceof HyperliquidRealEngine) {
          try {
            recentFillsForCheck = await engine.getRecentFills(50);
          } catch { /* non-critical */ }
        }
        const genuinelyClosed: string[] = [];
        const uncertain: string[] = [];
        for (const localSym of localExchangePositions) {
          const localPos = this.portfolio.getPosition(localSym);
          if (!localPos) continue;
          // Look for a closing fill (not "Open *") after this position was opened
          const closingFill = recentFillsForCheck.find(f =>
            f.symbol.toLowerCase() === localSym.toLowerCase() &&
            !f.dir.toLowerCase().startsWith('open') &&
            f.timestamp >= localPos.openedAt
          );
          if (closingFill) {
            genuinelyClosed.push(localSym);
          } else {
            uncertain.push(localSym);
          }
        }
        if (genuinelyClosed.length > 0) {
          log.info(`📉 syncExchangePositions: ${genuinelyClosed.length} position(s) confirmed closed via HL fills (exMap empty but closing fills found)`);
          for (const localSym of genuinelyClosed) {
            const localPos = this.portfolio.getPosition(localSym);
            if (!localPos) continue;
            const closingFill = recentFillsForCheck.find(f =>
              f.symbol.toLowerCase() === localSym.toLowerCase() &&
              !f.dir.toLowerCase().startsWith('open') &&
              f.timestamp >= localPos.openedAt
            );
            const hlPnl = closingFill?.closedPnl;
            const exitPrice = closingFill?.price ?? localPos.currentPrice;
            log.info(`📉 Exchange position closed on HL: ${localSym} — closing local mirror (HL PnL: ${hlPnl !== undefined ? '$'+hlPnl.toFixed(2) : 'N/A'})`);
            this.portfolio.closeExchangePosition(localSym, exitPrice, hlPnl);
          }
        }
        if (uncertain.length > 0) {
          // v2.0.37: Don't just skip — if the position is old (> 1h), it's very
          // likely been closed on HL (positions don't stay empty for hours if
          // genuinely open). Close the local mirror to prevent perpetual errors.
          for (const localSym of uncertain) {
            const localPos = this.portfolio.getPosition(localSym);
            if (!localPos) continue;
            const ageMs = Date.now() - localPos.openedAt;
            if (ageMs > 3_600_000) {
              // Position is old and not on HL — assume closed
              const exitPrice = localPos.currentPrice;
              log.info(`📉 syncExchangePositions: ${localSym} (age ${Math.round(ageMs / 3_600_000)}h) not on HL and no closing fill — assuming closed, cleaning up local mirror`);
              this.portfolio.closeExchangePosition(localSym, exitPrice);
            } else {
              log.warn(`⚠️ syncExchangePositions: ${localSym} (age ${Math.round(ageMs / 60_000)}min) not on HL and no closing fill — recent, might be API failure, skipping`);
            }
          }
        }
        // If all positions were either closed or uncertain, return (no exMap to iterate)
        if (exMap.size === 0) return;
      }

      // v2.0.32: Fetch recent HL fills to get actual realized PnL for closed positions.
      // HL's closedPnl is the real money gained/lost (not leveraged), already includes fees.
      let recentFills: Array<{ symbol: string; closedPnl: number; side: string; price: number; size: number; timestamp: number; fee: number; dir: string }> = [];
      if (engine instanceof HyperliquidRealEngine) {
        try {
          recentFills = await engine.getRecentFills(20);
        } catch { /* non-critical */ }
      }

      // v2.0.32: Close local mirrors for positions that are genuinely gone from HL.
      // Only close if exMap is non-empty (proving the API worked) but doesn't include
      // this symbol. This prevents false closes from API failures.
      for (const localSym of localExchangePositions) {
        const localPos = this.portfolio.getPosition(localSym);
        if (!localPos) continue;
        if (!exMap.has(localSym)) {
          // v2.0.33: Find the matching HL fill to get actual realized PnL.
          // HL closedPnl is the real PnL (not leveraged), already net of fees.
          // v2.0.33 FIX: Only match fills that occurred AFTER this position was
          // opened (openedAt). Previously matched ANY closing fill for the same
          // coin, which could match a stale fill from a previous close — creating
          // duplicate close records for positions that were never closed.
          const matchingFill = recentFills.find(f =>
            f.symbol.toLowerCase() === localSym.toLowerCase() &&
            !f.dir.toLowerCase().startsWith('open') && // only closing fills
            f.timestamp >= localPos.openedAt // must be after this position opened
          );
          const hlPnl = matchingFill?.closedPnl;
          const exitPrice = matchingFill?.price ?? localPos.currentPrice;
          log.info(`📉 Exchange position closed on HL: ${localSym} — closing local mirror (HL PnL: ${hlPnl !== undefined ? '$'+hlPnl.toFixed(2) : 'N/A'})`);
          this.portfolio.closeExchangePosition(localSym, exitPrice, hlPnl);
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
              log.info(`🔄 Position changed on HL: ${sym} side=${localPos.side}→${exPos.side} qty=${localPos.quantity}→${exPos.quantity} entry=${localPos.averageEntryPrice}→${exPos.averageEntryPrice} — updating mirror`);
              // v2.0.32: For exchange-imported positions, just update the fields
              // directly — don't close + re-import (which produces duplicate trade
              // records). For paper positions, close properly + re-import.
              if (localPos.agentId === 'hyperliquid-real') {
                // Update in-place — no trade record, no balance change
                localPos.side = exPos.side;
                localPos.quantity = exPos.quantity;
                localPos.averageEntryPrice = exPos.averageEntryPrice;
                localPos.leverage = exPos.leverage;
                // v2.0.33: Only update openedAt if the exchange returned a real
                // timestamp (non-zero). getPositions() returns 0 when no matching
                // open fill was found — in that case preserve the existing openedAt
                // instead of overwriting it with 0 or Date.now().
                if (exPos.openedAt > 0) {
                  localPos.openedAt = exPos.openedAt;
                }
                // Recalculate SL/TP based on new entry
                const slPct = 0.02;
                const tpPct = 0.05;
                localPos.stopLossPrice = exPos.side === 'buy'
                  ? exPos.averageEntryPrice * (1 - slPct)
                  : exPos.averageEntryPrice * (1 + slPct);
                localPos.takeProfitPrice = exPos.side === 'buy'
                  ? exPos.averageEntryPrice * (1 + tpPct)
                  : exPos.averageEntryPrice * (1 - tpPct);
                log.info(`  → Exchange mirror updated in-place (no trade record)`);
              } else {
                // Paper position — close properly + re-import as exchange position
                this.portfolio.closePosition(sym, localPos.currentPrice);
                log.info(`  → Paper mirror closed: ${localPos.side.toUpperCase()} ${sym} PnL: ${(localPos.unrealizedPnl).toFixed(2)}`);
                this.portfolio.importExchangePosition(
                  exPos.symbol,
                  exPos.side,
                  exPos.quantity,
                  exPos.averageEntryPrice,
                  exPos.leverage,
                  exPos.openedAt,
                );
              }
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
          // v2.0.33: If getPositions() couldn't find the open fill timestamp
          // (openedAt=0), fall back to Date.now() for new imports only.
          // For existing positions, syncExchangePositions preserves the
          // existing openedAt (see the in-place update fix above).
          this.portfolio.importExchangePosition(
            exPos.symbol,
            exPos.side,
            exPos.quantity,
            exPos.averageEntryPrice,
            exPos.leverage,
            exPos.openedAt > 0 ? exPos.openedAt : Date.now(),
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
        // v2.0.33: Use closeExchangePosition() for real positions (agentId='hyperliquid-real')
        // instead of closePosition(). closePosition() adds margin back to paper balance
        // and updates paper stats — wrong for real positions. closeExchangePosition()
        // only produces a trade record + triggers learning, without touching paper balance.
        const pos = this.portfolio.getPosition(symbol);
        if (pos) {
          if (pos.agentId === 'hyperliquid-real') {
            this.portfolio.closeExchangePosition(symbol, pos.currentPrice);
          } else {
            this.portfolio.closePosition(symbol, pos.currentPrice);
          }
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

        // v2.0.47: REVERSE SYNC — read the actual SL/TP trigger prices from HL
        // and update the local mirror so the UI shows what's really on the exchange.
        // The local mirror's SL/TP may drift from HL due to:
        //   - HL rounding/price decimals on placement
        //   - Manual adjustments on HL's web UI
        //   - Local adjustPosition() no-widen clamping that differs from HL
        // HL is the ground truth — the local mirror must match it.
        const hlSL = myOrders.find(o => o.triggerPx && o.side === closeSide && (o.tpsl === 'sl' || myOrders.filter(o2 => o2.triggerPx && o2.side === closeSide).indexOf(o) === 0));
        const hlTP = myOrders.find(o => o.triggerPx && o.side === closeSide && o.tpsl === 'tp');
        // Fallback: if tpsl field is undefined (HL doesn't always return it),
        // determine SL vs TP by price position relative to entry.
        // For SHORT (closeSide=B): SL is the higher price, TP is the lower price.
        // For LONG (closeSide=S): SL is the lower price, TP is the higher price.
        const triggerOrders = myOrders.filter(o => o.triggerPx);
        let actualSL: number | undefined;
        let actualTP: number | undefined;
        if (triggerOrders.length > 0) {
          if (hlSL?.triggerPx) {
            actualSL = parseFloat(hlSL.triggerPx);
          } else if (hlTP?.triggerPx) {
            actualTP = parseFloat(hlTP.triggerPx);
          }
          // If tpsl fields are missing, infer from price position
          if (actualSL === undefined && actualTP === undefined && triggerOrders.length >= 1) {
            const prices = triggerOrders.map(o => parseFloat(o.triggerPx!));
            if (pos.side === 'sell') {
              // SHORT: SL > entry, TP < entry → SL is the higher price
              actualSL = Math.max(...prices);
              actualTP = prices.length > 1 ? Math.min(...prices) : undefined;
            } else {
              // LONG: SL < entry, TP > entry → SL is the lower price
              actualSL = Math.min(...prices);
              actualTP = prices.length > 1 ? Math.max(...prices) : undefined;
            }
          } else if (actualSL === undefined && triggerOrders.length >= 2) {
            // We found TP via tpsl but not SL — SL is the other order
            const otherOrder = triggerOrders.find(o => o.triggerPx !== hlTP?.triggerPx);
            if (otherOrder?.triggerPx) actualSL = parseFloat(otherOrder.triggerPx);
          } else if (actualTP === undefined && triggerOrders.length >= 2) {
            // We found SL via tpsl but not TP — TP is the other order
            const otherOrder = triggerOrders.find(o => o.triggerPx !== hlSL?.triggerPx);
            if (otherOrder?.triggerPx) actualTP = parseFloat(otherOrder.triggerPx);
          }
        }
        // Sync the actual HL values back to the local mirror
        this.portfolio.syncSLTPFromExchange(pos.symbol, actualSL, actualTP);
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
