// ─── Real Trading Manager ───
// Orchestrates paper trading and Hyperliquid real engine.
// Provides a unified interface for the HACP system to execute trades.

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { PortfolioTracker, normalizeSymbol } from './portfolio.ts';
import { RiskEngine } from '../risk/engine.ts';
import { PaperTradingEngine } from './paper-engine.ts';
import { HyperliquidRealEngine } from './hyperliquid-real-engine.ts';
import { getATR, computeATRSLTP } from '../analysis/atr.ts';
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
  hyperliquidWalletAddress: string;
  hyperliquidPrivateKey: string;
}

export class RealTradingManager {
  private config: TradingManagerConfig;
  private paperEngine: PaperTradingEngine;
  private portfolio: PortfolioTracker;
  private riskEngine: RiskEngine;
  private hyperliquidEngine: HyperliquidRealEngine | null = null;
  /** v2.0.XX: Max portion of TOTAL equity for all positions combined (10%-100%).
   *  Synced from MarketAgent config via setMaxPortionPct(). Checked BEFORE
   *  placing real orders so we don't send a trade to HL that exceeds the cap.
   *  v2.0.131: Uses TOTAL equity (not free balance) — free balance is reduced
   *  by existing position margin, so comparing against free balance blocks
   *  all new trades when an existing position uses most of the margin.
   *  v2.0.131: Clamp raised from 50% to 100% to allow users to set higher
   *  when they have existing positions using most of the margin. */
  private maxPortionPct = 0.20;
  /** v2.0.66: Per-symbol debounce lock — prevents duplicate SL/TP placement
   *  when multiple code paths (syncSLTP, hacp adjustPositions, per-symbol
   *  consensus) all call adjustPosition() within the same cycle. */
  private lastSLTPPlacement: Map<string, { sl?: number; tp?: number; ts: number }> = new Map();
  private readonly SLTP_DEBOUNCE_MS = 10_000;

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

    // Initialize Hyperliquid engine if keys are provided
    if (config.hyperliquidWalletAddress && config.hyperliquidPrivateKey) {
      this.hyperliquidEngine = new HyperliquidRealEngine(
        config.hyperliquidWalletAddress,
        config.hyperliquidPrivateKey,
      );
    }

    log.info('Real Trading Manager initialized', {
      tradeMode: config.tradeMode,
      exchange: config.exchange,
      hyperliquidReady: !!this.hyperliquidEngine,
    });
  }

  /** Get the active engine based on current config */
  private getActiveEngine(): RealTradingEngine | null {
    if (this.config.tradeMode === 'paper') return null;
    return this.hyperliquidEngine;
  }

  /** Get the engine for a specific exchange (for data fetching regardless of trade mode) */
  getEngineForExchange(exchange: ExchangeType): RealTradingEngine | null {
    return this.hyperliquidEngine;
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

  /** v2.0.XX: Set max portion of balance for all positions combined.
   *  Checked BEFORE placing real orders on HL. */
  setMaxPortionPct(pct: number): void {
    this.maxPortionPct = Math.max(0.10, Math.min(1.00, pct));
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
   * Only HyperliquidRealEngine supports this; returns [] for paper mode.
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
   *
   * v2.0.127: In real mode, the paper engine mirror is called with
   * forceMirror=true to bypass canTrade() drawdown/daily-loss guards.
   * The real trade already executed on HL — the mirror must not be blocked
   * by paper portfolio guards. Previously, a 21.74% paper drawdown blocked
   * the mirror, causing positions to exist on HL but not in the local
   * portfolio (UI showed "No Open Positions").
   *
   * v2.0.131: The cumulative margin check uses TOTAL equity (exBal.total),
   * not free balance (exBal.free). Free balance is reduced by existing
   * position margin, so comparing total margin against free balance * maxPortion
   * blocks all new trades when an existing position uses most of the margin.
   *
   * Gate stack (in order):
   *   1. Symbol overlap guard (no duplicate positions)
   *   2. Price check (> 0)
   *   3. HL minimum notional floor ($10)
   *   4. Cumulative margin check (total margin vs maxPortion * total equity)
   *   5. HL engine.placeOrder() (actual exchange order)
   *   6. Paper engine mirror (forceMirror=true, bypasses canTrade)
   *   7. Post-trade sync (fetch actual fill price + leverage from HL)
   *   8. SL/TP placement (using actual fill price, not decision price)
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

      // v2.0.78: Symbol overlap guard (defence-in-depth).
      // index.ts has its own guard, but if the symbol normalization mismatches
      // or a different code path reaches here, we must NOT open a duplicate
      // position on the same symbol. HL would increase the position size,
      // effectively doubling the exposure without the system knowing.
      const sym = normalizeSymbol(decision.symbol);
      if (this.portfolio.hasPosition(sym)) {
        const existing = this.portfolio.getPosition(sym);
        if (existing && existing.side === decision.action) {
          log.warn(`🚫 Real engine symbol-guard: ${sym.toUpperCase()} already has ${existing.side.toUpperCase()} position. Blocking duplicate ${decision.action.toUpperCase()} trade.`);
          return { success: false, error: `Symbol overlap: ${sym} already positioned (${existing.side}).` };
        }
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

      // v2.0.XX: Cumulative margin check BEFORE sending the order to HL.
      // In real mode, the exchange holds the actual margin — but we check
      // locally first so we don't send an order that exceeds the user's
      // configured max portion. Uses realPositions (actual HL positions)
      // + the new position's margin. Margin = notional / leverage.
      // v2.0.131: Use TOTAL equity (not free balance) for the max portion
      // check. Free balance is reduced by existing position margin, so
      // comparing total margin against free balance * maxPortion blocks
      // all new trades when an existing position uses most of the margin.
      // The correct comparison is: total margin after new trade vs
      // maxPortion * total equity.
      const realPositions = this.portfolio.getRealPositions();
      let totalMarginExposure = 0;
      for (const pos of realPositions) {
        totalMarginExposure += (pos.quantity * pos.averageEntryPrice) / (pos.leverage ?? 1);
      }
      const newMargin = (quantity * price) / (decision.leverage ?? 10);
      const totalMarginAfter = totalMarginExposure + newMargin;
      // Use exchange TOTAL equity if available, otherwise paper equity as proxy
      const exBal = await this.getBalance();
      const checkBalance = exBal.total > 0 ? exBal.total : equity;
      const maxMargin = checkBalance * this.maxPortionPct;

      if (totalMarginAfter > maxMargin) {
        const allowedNewMargin = Math.max(0, maxMargin - totalMarginExposure);
        if (allowedNewMargin > 0) {
          // Scale down to fit within limit
          const scaledQty = (allowedNewMargin * (decision.leverage ?? 10)) / price;
          if (scaledQty * price >= HL_MIN_NOTIONAL_USD) {
            log.info(`Real position scaled down: ${quantity.toFixed(6)} → ${scaledQty.toFixed(6)} (cumulative margin ${((totalMarginAfter / checkBalance) * 100).toFixed(1)}% > ${(this.maxPortionPct * 100).toFixed(0)}%)`);
            quantity = scaledQty;
          } else {
            const err = `Real cumulative margin $${totalMarginAfter.toFixed(2)} exceeds ${(this.maxPortionPct * 100).toFixed(0)}% of balance $${checkBalance.toFixed(2)}. Scaled order below HL min notional — rejecting.`;
            log.warn(err);
            return { success: false, error: err };
          }
        } else {
          const err = `Real cumulative margin $${totalMarginAfter.toFixed(2)} exceeds ${(this.maxPortionPct * 100).toFixed(0)}% of balance $${checkBalance.toFixed(2)}. Cannot open new position.`;
          log.warn(err);
          return { success: false, error: err };
        }
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

        // v2.0.153: Mirror via importExchangePosition — stores in realPositions
        // WITHOUT deducting margin from paper balance. The old code called
        // paperEngine.executeDecision(decisionWithLev, true) which went through
        // openPosition() → portfolio.balance -= margin + entryFee, permanently
        // contaminating the paper balance on every real trade.
        this.portfolio.importExchangePosition(
          decision.symbol,
          decision.action as 'buy' | 'sell',
          quantity,
          price,
          decision.leverage ?? 1,
          Date.now(),
        );

        // v2.0.136: Tag is already set by importExchangePosition (agentId='hyperliquid-real').
        // No need to re-tag here.

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
        // v2.0.73 S2.3: ATR is now the PRIMARY method (volatility-adaptive).
        // Priority: ATR → S/R → fixed %.
        const srSupport = (decision as any).srSupport as number | null | undefined;
        const srResistance = (decision as any).srResistance as number | null | undefined;
        const slPctDefault = 0.015; // 1.5% default
        const tpPctDefault = 0.03;  // 3% default

        let slPrice: number, tpPrice: number;

        // v2.0.73 S2.3: Try ATR-based SL/TP first (volatility-adaptive).
        // SL = 1.5×ATR, TP = 3×ATR (R:R 2:1). Falls back to S/R or % if ATR unavailable.
        let atrSLTP: { sl: number; tp: number } | null = null;
        try {
          const atr = await getATR(decision.symbol);
          if (atr > 0) {
            atrSLTP = computeATRSLTP(actualEntryPrice, atr, decision.action as 'buy' | 'sell');
            if (atrSLTP) {
              log.info(`📐 ATR SL/TP: ${decision.symbol} entry=$${actualEntryPrice.toFixed(2)} ATR=$${atr.toFixed(2)} SL=$${atrSLTP.sl.toFixed(2)} TP=$${atrSLTP.tp.toFixed(2)}`);
            }
          }
        } catch { /* fall back below */ }

        if (atrSLTP) {
          slPrice = atrSLTP.sl;
          tpPrice = atrSLTP.tp;
        } else if (decision.action === 'buy') {
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
              sltpSuccess = await engine.adjustPosition(
                decision.symbol,
                slPrice,
                tpPrice,
                // v2.0.139: pass known fill data so SL/TP can be placed even when HL
                // REST getPositions() lags behind the fresh fill (WS-confirmed but
                // not yet REST-indexed). Prevents the race that left positions
                // unprotected on the open cycle.
                { quantity, side: decision.action === 'buy' ? 'buy' : 'sell', averageEntryPrice: actualEntryPrice, currentPrice: actualEntryPrice },
              );
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
        };
      }

      // v2.0.136: Log placeOrder failures. Previously the HL error was
      // returned silently, making it impossible to diagnose why a trade
      // that passed every gate still failed to execute.
      if (!result.success) {
        log.warn(`❌ [real-trading] placeOrder failed for ${decision.action.toUpperCase()} ${decision.symbol} qty=${quantity.toFixed(6)} @ $${price.toFixed(2)}: ${result.error ?? 'unknown error'}`);
      }
      return {
        success: result.success,
        orderId: result.orderId,
        error: result.error,
      };
    }

    // v2.0.143: Paper mode is no longer handled here. index.ts routes
    // paper trades directly to paperEngine.executeDecision(), and real
    // trades to this method. This ensures clean separation:
    //   - Paper trades never get tagged as 'hyperliquid-real'
    //   - Real trades never lose entryThesis from paper mirror re-imports
    //   - The trade execution pipeline is deterministic by trade mode
    log.warn(`⚠️ RealTradingManager.executeDecision called but no active engine (tradeMode=${this.config.tradeMode}). Paper trades should go through paperEngine directly.`);
    return { success: false, error: 'No active exchange engine — paper trades should use paperEngine directly' };
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

      // v2.0.79: Track which DEXes were successfully fetched.
      // If a DEX fetch failed (429/500), we must NOT close local mirrors
      // for symbols on that DEX — they may still be open on HL.
      const fetchedDexSymbols = new Set<string>();
      for (const exPos of exchangePositions) {
        if (exPos.symbol.includes(':')) {
          // DEX 1-8 symbol — mark the prefix as fetched
          fetchedDexSymbols.add(exPos.symbol.split(':')[0]!.toLowerCase());
        } else {
          // DEX 0 symbol
          fetchedDexSymbols.add('');
        }
      }

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
          // v2.0.159: Check closing direction matches — BUY position closed by SELL fill, etc.
          // v2.0.166: Use f.side not f.dir.startsWith() — see comment below.
          const expectedCloseSide = localPos.side === 'buy' ? 'sell' : 'buy';
          const closingFill = recentFillsForCheck.find(f =>
            f.symbol.toLowerCase() === localSym.toLowerCase() &&
            !f.dir.toLowerCase().startsWith('open') &&
            f.side === expectedCloseSide &&
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
            const expectedCloseSide2 = localPos.side === 'buy' ? 'sell' : 'buy';
            const closingFill = recentFillsForCheck.find(f =>
              f.symbol.toLowerCase() === localSym.toLowerCase() &&
              !f.dir.toLowerCase().startsWith('open') &&
              f.side === expectedCloseSide2 &&
              f.timestamp >= localPos.openedAt
            );
            const hlPnl = closingFill?.closedPnl;
            const exitPrice = closingFill?.price ?? localPos.currentPrice;
            log.info(`📉 Exchange position closed on HL: ${localSym} — closing local mirror (HL PnL: ${hlPnl !== undefined ? '$'+hlPnl.toFixed(2) : 'N/A'})`);
            this.portfolio.closeExchangePosition(localSym, exitPrice, hlPnl);
          }
        }
        if (uncertain.length > 0) {
          // v2.0.156: NEVER assume a position is closed just because the API
          // didn't return it. HL API failures (429/500/timeout) cause exMap
          // to be empty even when positions are still open. Assuming closed
          // creates phantom close records, then the next cycle re-imports the
          // position → close again → infinite loop of duplicate trades.
          // Only close if there's a confirmed closing fill on HL.
          for (const localSym of uncertain) {
            log.warn(`⚠️ syncExchangePositions: ${localSym} not on HL and no closing fill — NOT closing (could be API failure, position may still be open)`);
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
      // v2.0.79: Also check that the DEX for this symbol was successfully fetched.
      // If the DEX fetch failed (429/500), don't close local mirrors for symbols
      // on that DEX — they may still be open on HL.
      for (const localSym of localExchangePositions) {
        const localPos = this.portfolio.getPosition(localSym);
        if (!localPos) continue;
        if (!exMap.has(localSym)) {
          // v2.0.79: Check if this symbol's DEX was successfully fetched
          const localDex = localSym.includes(':') ? localSym.split(':')[0]!.toLowerCase() : '';
          if (!fetchedDexSymbols.has(localDex)) {
            log.warn(`⏭️ syncExchangePositions: ${localSym} — DEX "${localDex || 'default'}" fetch failed, skipping close (position may still be open on HL)`);
            continue;
          }
          // v2.0.33: Find the matching HL fill to get actual realized PnL.
          // HL closedPnl is the real PnL (not leveraged), already net of fees.
          // v2.0.33 FIX: Only match fills that occurred AFTER this position was
          // opened (openedAt). Previously matched ANY closing fill for the same
          // coin, which could match a stale fill from a previous close — creating
          // duplicate close records for positions that were never closed.
          // v2.0.156: Only close if there's a confirmed closing fill. Without a
          // fill, the position may still be open on HL — the DEX fetch may have
          // partially failed (returned some symbols but not others).
          // v2.0.159: Also check that the fill direction matches the closing side
          // of this position. A BUY position is closed by a SELL fill, and vice
          // versa. Without this check, a closing fill from a PREVIOUS position
          // (e.g. SELL CL closed → fill matches new BUY CL position) creates a
          // fake close record for the new position.
          // v2.0.166: Use f.side ("buy"/"sell") not f.dir.startsWith() — HL's dir
          // field is "close long"/"close short"/"open long"/"open short", which
          // never starts with "buy" or "sell". The old check always returned false,
          // silently blocking ALL legitimate closes. Use f.side instead.
          const expectedCloseSide = localPos.side === 'buy' ? 'sell' : 'buy';
          const matchingFill = recentFills.find(f =>
            f.symbol.toLowerCase() === localSym.toLowerCase() &&
            !f.dir.toLowerCase().startsWith('open') && // only closing fills
            f.side === expectedCloseSide && // must match closing direction (buy/sell)
            f.timestamp >= localPos.openedAt // must be after this position opened
          );
          if (matchingFill) {
            const hlPnl = matchingFill.closedPnl;
            const exitPrice = matchingFill.price;
            log.info(`📉 Exchange position closed on HL: ${localSym} — closing local mirror (HL PnL: $${hlPnl.toFixed(2)})`);
            this.portfolio.closeExchangePosition(localSym, exitPrice, hlPnl);
          } else {
            log.warn(`⚠️ syncExchangePositions: ${localSym} not in exMap but no closing fill found — NOT closing (position may still be open on HL)`);
          }
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
                // Paper position — close properly + re-import as exchange position.
                // v2.0.143: Preserve entryThesis + MAE/MFE from the paper mirror
                // so the system doesn't lose the learning context when the mirror
                // is replaced. Previously the re-import created a blank position
                // with no thesis, causing RIL/EXP to skip the trade entirely.
                const preservedThesis = localPos.entryThesis;
                const preservedMinValue = localPos.minValueReached;
                const preservedMaxValue = localPos.maxValueReached;
                const preservedHoldReason = localPos.holdReason;
                const preservedOriginalSL = localPos.originalStopLossPrice;
                const preservedOriginalTP = localPos.originalTakeProfitPrice;
                this.portfolio.closePosition(sym, localPos.currentPrice);
                log.info(`  → Paper mirror closed: ${localPos.side.toUpperCase()} ${sym} PnL: ${(localPos.unrealizedPnl).toFixed(2)}`);
                // v2.0.50: If exPos.openedAt is 0 (fill not found), preserve
                // the local mirror's openedAt — it's more accurate than 0.
                this.portfolio.importExchangePosition(
                  exPos.symbol,
                  exPos.side,
                  exPos.quantity,
                  exPos.averageEntryPrice,
                  exPos.leverage,
                  exPos.openedAt > 0 ? exPos.openedAt : (localPos.openedAt > 0 ? localPos.openedAt : Date.now()),
                );
                // v2.0.143: Restore preserved fields onto the re-imported position.
                const reimportedPos = this.portfolio.getPosition(sym);
                if (reimportedPos) {
                  if (preservedThesis) reimportedPos.entryThesis = preservedThesis;
                  if (preservedMinValue !== undefined) reimportedPos.minValueReached = preservedMinValue;
                  if (preservedMaxValue !== undefined) reimportedPos.maxValueReached = preservedMaxValue;
                  if (preservedHoldReason) reimportedPos.holdReason = preservedHoldReason;
                  if (preservedOriginalSL !== undefined) reimportedPos.originalStopLossPrice = preservedOriginalSL;
                  if (preservedOriginalTP !== undefined) reimportedPos.originalTakeProfitPrice = preservedOriginalTP;
                  log.info(`  → Preserved entryThesis + MAE/MFE + holdReason on re-imported ${sym}`);
                }
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
            // v2.0.143: This should not happen in real mode — paper positions
            // are closed via closeTrade() → portfolio.closePosition() directly.
            // But if a paper mirror exists in real mode, close it properly.
            this.portfolio.closePosition(symbol, pos.currentPrice);
          }
        }
      }
      return success;
    }

    // v2.0.143: Paper mode is no longer handled here. index.ts routes
    // paper position closes directly to portfolio.closePosition().
    log.warn(`⚠️ RealTradingManager.closePosition called but no active engine (tradeMode=${this.config.tradeMode}). Paper positions should be closed via portfolio.closePosition() directly.`);
    return false;
  }

  /**
   * v2.0.31: Adjust SL/TP for a position. In real mode, this calls the HL API
   * to place native trigger orders AND updates the local mirror. In paper mode,
   * only updates the local mirror.
   */
  /**
   * v2.0.54: Adjust position SL/TP — validates BEFORE sending to HL.
   *
   * Previously this method called portfolio.adjustPosition() (which validates
   * and may reject) but then UNCONDITIONALLY sent the raw sl/tp to the HL engine
   * — ignoring the portfolio's rejection. This meant invalid SL/TP (wrong side,
   * widening, too narrow) was placed on HL even though the local mirror rejected it.
   *
   * Now: portfolio.adjustPosition() returns true/false. If it returns false
   * (rejected), we do NOT send the raw values to HL. We read the position's
   * current validated SL/TP from the local mirror and send THOSE to HL instead.
   * This ensures HL always matches the local mirror's validated values.
   *
   * v2.0.129: portfolio.adjustPosition() now also enforces not-too-tight
   * constraints (MIN_SL_DIST_PCT=1%, MIN_TP_DIST_PCT=1.5%) in addition to
   * no-widen, max-narrow-step, and min-gap. This is the HARD SAFETY layer —
   * all callers (HACP adjustPositions, per-symbol consensus, manual trade)
   * go through this validation.
   *
   * v2.0.130: This method is called for ALL open positions (not just the
   * primary symbol). HACP's adjustPositions() now adjusts every position
   * with full market context, so non-primary positions (e.g. SILVER) get
   * proper LLM-driven SL/TP adjustments instead of only sub-agent averages.
   *
   * SL/TP validation chain (hard safety layers):
   *   1. hacp.ts adjustPositions() — LLM retry loop with error feedback
   *      (direction, no-widen, min-distance, min-gap, max-narrow-step)
   *   2. portfolio.ts adjustPosition() — hard safety layer
   *      (direction, no-widen, not-too-tight, min-gap, max-narrow-step)
   *   3. real-trading-manager.ts adjustPosition() — debounce + HL placement
   *      (uses validated values from layer 2, or existing if rejected)
   *   4. hyperliquid-real-engine.ts adjustPosition() — HL trigger orders
   *      (cancel existing + place fresh SL + TP)
   */
  async adjustPosition(positionId: string, sl?: number, tp?: number): Promise<void> {
    // Always update local mirror first — this validates SL/TP direction,
    // no-widen, gap, and narrowing constraints. Returns false if rejected.
    const accepted = this.portfolio.adjustPosition(positionId, sl, tp);

    // In real mode, place native trigger orders on HL
    const engine = this.getActiveEngine();
    if (engine) {
      try {
        const pos = this.portfolio.getPosition(positionId);
        if (pos) {
          // v2.0.54: If portfolio.adjustPosition() rejected the values,
          // use the position's EXISTING validated SL/TP (not the rejected ones).
          // This ensures HL gets the correct, validated values — not raw
          // unvalidated ones that the local mirror already rejected.
          const hlSl = accepted ? sl : pos.stopLossPrice;
          const hlTp = accepted ? tp : pos.takeProfitPrice;

          // v2.0.66: DEBOUNCE — skip if we already placed the same SL/TP
          // for this symbol within SLTP_DEBOUNCE_MS. Multiple code paths
          // (syncSLTP, hacp adjustPositions, per-symbol consensus) all call
          // this method in the same cycle. Without this lock, each path
          // places duplicate orders because HL's async processing means
          // getOpenOrders() returns stale data for all of them.
          const sym = normalizeSymbol(pos.symbol);
          const last = this.lastSLTPPlacement.get(sym);
          if (last && (Date.now() - last.ts) < this.SLTP_DEBOUNCE_MS) {
            const slMatch = hlSl === undefined || (last.sl !== undefined && Math.abs(last.sl - hlSl) < 1);
            const tpMatch = hlTp === undefined || (last.tp !== undefined && Math.abs(last.tp - hlTp) < 1);
            if (slMatch && tpMatch) {
              log.info(`⏭️ SL/TP debounced for ${pos.symbol} — already placed ${Date.now() - last.ts}ms ago (SL=${hlSl?.toFixed(2) ?? '-'} TP=${hlTp?.toFixed(2) ?? '-'})`);
              return;
            }
          }

          if (hlSl !== undefined || hlTp !== undefined) {
            this.lastSLTPPlacement.set(sym, { sl: hlSl, tp: hlTp, ts: Date.now() });
            await engine.adjustPosition(pos.symbol, hlSl, hlTp);
            log.info(`🔧 Real SL/TP placed on HL: ${pos.symbol} SL=${hlSl?.toFixed(2) ?? '-'} TP=${hlTp?.toFixed(2) ?? '-'}${accepted ? '' : ' (used existing — input rejected)'}`);
          }
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
  /**
   * v2.0.32: Sync SL/TP from local mirror to HL exchange. For each real position
   * that has SL/TP in the local mirror, check if corresponding trigger orders
   * exist on HL. If not, place them. This runs every cycle in real mode to
   * ensure HL always has SL/TP protection.
   *
   * v2.0.51: Now also runs in paper mode for legacy real positions. Uses
   * getEngineForExchange() instead of getActiveEngine() so it works regardless
   * of trade mode. Also called at startup before first pushToAPI() so the UI
   * shows real HL SL/TP values from the start.
   */
  async syncSLTP(): Promise<void> {
    // v2.0.51: Use getEngineForExchange so this works in paper mode too
    // (for legacy real positions that need SL/TP sync).
    const engine = this.getEngineForExchange('hyperliquid');
    if (!engine || !(engine instanceof HyperliquidRealEngine)) return;

    try {
      // Get all open orders on HL (both DEX 0 + xyz)
      const openOrders = await engine.getOpenOrders();

      // v2.0.66: BATCH DEDUP — before per-position sync, clean up duplicate
      // trigger orders left over from previous buggy cycles. Group by (coin, side),
      // and if any group has > 2 orders (should be exactly 1 SL + 1 TP), cancel
      // ALL orders in that group. Track which symbols were cleaned so the
      // per-position loop below FORCES re-placement of 1 SL + 1 TP.
      const cleanedSymbols = new Set<string>(); // normalized symbol → force re-place
      const groups = new Map<string, Array<{ oid: number; coin: string }>>();
      for (const o of openOrders) {
        if (!o.triggerPx) continue; // only trigger orders
        const key = `${o.coin.toLowerCase()}:${o.side}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ oid: o.oid, coin: o.coin });
      }
      for (const [key, orders] of groups) {
        if (orders.length > 2) {
          const coin = orders[0]!.coin;
          log.warn(`🧹 BATCH CLEANUP: ${coin} (${key}) has ${orders.length} duplicate trigger orders — cancelling ALL`);
          const assetIdx = await engine.getAssetIndexForSymbol(coin);
          for (const o of orders) {
            try {
              await engine.cancelOrderWithAsset(assetIdx, o.oid);
            } catch { /* best-effort */ }
          }
          // Mark this symbol for forced re-placement. HL cancel is async so
          // re-fetching openOrders may still show the old orders. We track
          // cleaned symbols separately to force needsRefresh=true below.
          cleanedSymbols.add(coin.toLowerCase());
        }
      }

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

        // v2.0.48: Safety check — ensure SL/TP are on the correct side.
        // SL can be on EITHER side of entry (trailing stop / profit-side SL
        // is allowed), BUT must be on the correct side of CURRENT MARK PRICE
        // to avoid immediate triggering:
        //   BUY (long): SL must be BELOW current price
        //   SELL (short): SL must be ABOVE current price
        // TP must be on the profit side of entry:
        //   BUY (long): TP > entry
        //   SELL (short): TP < entry
        // Use the HL entry price for TP validation, current price for SL.
        // ⚠️ MAINTENANCE NOTE: This matches the relaxed SL validation in
        // hacp.ts adjustPositions() and portfolio.ts adjustPosition().
        let slValid = true;
        let tpValid = true;
        if (sl) {
          const slOnLossSide = pos.side === 'buy' ? sl < hlPos.entry : sl > hlPos.entry;
          if (!slOnLossSide) {
            // SL is on the profit side of entry — check if it's still valid
            // relative to current price (must not trigger immediately).
            const currentPrice = pos.currentPrice;
            const slSafeVsPrice = pos.side === 'buy' ? sl < currentPrice : sl > currentPrice;
            if (!slSafeVsPrice) {
              log.warn(`⚠️ SL ${sl} would trigger immediately for ${pos.side} ${pos.symbol} (current=$${currentPrice}) — skipping SL placement`);
              slValid = false;
            } else {
              log.info(`📐 SL ${sl} is on profit side of entry ${hlPos.entry} for ${pos.side} ${pos.symbol} — trailing stop, valid (current=$${currentPrice})`);
            }
          }
        }
        if (tp) {
          const tpCorrect = pos.side === 'buy' ? tp > hlPos.entry : tp < hlPos.entry;
          if (!tpCorrect) {
            log.warn(`⚠️ TP ${tp} is on wrong side for ${pos.side} ${pos.symbol} (HL entry=${hlPos.entry}) — skipping TP placement`);
            tpValid = false;
          }
        }

        // v2.0.32: Check if HL already has trigger orders at the SL/TP prices.
        // HL openOrders response doesn't include tpsl field, so we match by
        // coin + side + triggerPx. Side is important: a short position's
        // SL/TP are buy orders (side=B), a long position's are sell orders
        // (side=S). We only manage orders matching the current position's
        // close side — this allows simultaneous long + short on the same asset.
        const closeSide = pos.side === 'buy' ? 'A' : 'B'; // HL: 'A'=Ask(sell), 'B'=Bid(buy). Sell to close long, buy to close short.
        const myOrders = openOrders.filter(o =>
          o.coin.toLowerCase() === pos.symbol.toLowerCase() &&
          o.side === closeSide
        );
        // v2.0.66: If this symbol was batch-cleaned, force re-placement
        // regardless of what the stale openOrders snapshot shows.
        const wasCleaned = cleanedSymbols.has(pos.symbol.toLowerCase());
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
        // v2.0.48: Only place SL/TP if they passed validation (slValid/tpValid).
        // v2.0.66: wasCleaned forces re-placement after batch cleanup.
        const needsRefresh = wasCleaned || myOrders.length > 2 || 
          (sl !== undefined && slValid && !hasSL) ||
          (tp !== undefined && tpValid && !hasTP);

        // v2.0.65: FIX — always pass BOTH SL + TP together to adjustPosition().
        // Previously we called adjustPosition(symbol, sl, undefined) then
        // adjustPosition(symbol, undefined, tp) separately. Each call cancels
        // ALL existing orders for the close side before placing new ones —
        // so the first call cancels TP (placing SL), then the second call
        // cancels SL (placing TP). Result: infinite ping-pong where SL/TP
        // alternate being present on HL, and duplicate orders accumulate.
        //
        // Now: if needsRefresh, cancel all then place BOTH together.
        // If only one is missing, place BOTH (the existing one will be
        // deduped by the engine's price-check guard).
        if (needsRefresh && myOrders.length > 0) {
          log.info(`🗑️ Refreshing trigger orders for ${pos.symbol} (${closeSide} side) — cancelling ${myOrders.length} existing order(s)`);
          const asset = await engine.getAssetIndexForSymbol(pos.symbol);
          for (const o of myOrders) {
            await engine.cancelOrderWithAsset(asset, o.oid);
          }
        }

        // Build the combined SL+TP to place. Only include values that are
        // valid and needed (missing or being refreshed).
        const placeSL = sl && sl > 0 && slValid;
        const placeTP = tp && tp > 0 && tpValid;
        let justPlaced = false;
        if (placeSL || placeTP) {
          const slToPlace = placeSL ? sl : undefined;
          const tpToPlace = placeTP ? tp : undefined;
          log.info(`🔧 Placing SL/TP on HL for ${pos.symbol}: SL=${slToPlace?.toFixed(2) ?? '-'} TP=${tpToPlace?.toFixed(2) ?? '-'}`);
          await engine.adjustPosition(pos.symbol, slToPlace, tpToPlace);
          justPlaced = true;
        }

        // v2.0.66: If we just placed orders, SKIP the reverse-sync + push-corrected
        // block entirely. Re-fetching getOpenOrders() 0.2s after placement will
        // return stale data (HL async processing hasn't completed), causing:
        //   1. correctInvertedSLTP() sees 0 orders → recalculates same values
        //   2. "Push corrected" sees mismatch → pushes AGAIN → DUPLICATES
        //   3. Next cycle: 2+ orders → needsRefresh → cancel all → place again
        // The local mirror already has the correct SL/TP — no need to re-verify.
        if (justPlaced) {
          continue;
        }

        // v2.0.47: REVERSE SYNC — read the actual SL/TP trigger prices from HL
        // and update the local mirror so the UI shows what's really on the exchange.
        // HL is the ground truth — the local mirror must match it.
        // Only runs when we did NOT just place orders (justPlaced=false).
        let freshOrders: Array<{ coin: string; side: string; orderType: string; triggerPx?: string; tpsl?: string; sz: string; oid: number }> = [];
        try {
          freshOrders = await engine.getOpenOrders();
        } catch { /* non-critical — fall back to stale myOrders */ }
        const freshMyOrders = freshOrders.length > 0
          ? freshOrders.filter(o =>
              o.coin.toLowerCase() === pos.symbol.toLowerCase() &&
              o.side === closeSide
            )
          : myOrders; // fallback to stale if re-fetch failed

        const hlSL = freshMyOrders.find(o => o.triggerPx && o.side === closeSide && o.tpsl === 'sl');
        const hlTP = freshMyOrders.find(o => o.triggerPx && o.side === closeSide && o.tpsl === 'tp');
        const triggerOrders = freshMyOrders.filter(o => o.triggerPx);
        let actualSL: number | undefined;
        let actualTP: number | undefined;
        if (triggerOrders.length > 0) {
          if (hlSL?.triggerPx) {
            actualSL = parseFloat(hlSL.triggerPx);
          }
          if (hlTP?.triggerPx) {
            actualTP = parseFloat(hlTP.triggerPx);
          }
          // v2.0.57: If tpsl fields are missing, infer from ENTRY PRICE + position direction.
          // SL is on the LOSS side of entry, TP is on the PROFIT side:
          //   LONG: SL < entry, TP > entry
          //   SHORT: SL > entry, TP < entry
          // If both are on the same side (trailing stop), the one FURTHER
          // from entry is SL, the one CLOSER is TP.
          if (actualSL === undefined && actualTP === undefined && triggerOrders.length >= 1) {
            const prices = triggerOrders.map(o => parseFloat(o.triggerPx!));
            const entry = hlPos.entry;
            const isLong = pos.side === 'buy';
            if (prices.length === 1) {
              // v2.0.65: Single order — use direction + entry to determine SL vs TP
              const singlePrice = prices[0]!;
              if (isLong) {
                if (singlePrice < entry) {
                  actualSL = singlePrice;  // LONG: below entry = SL
                } else {
                  actualTP = singlePrice;  // LONG: above entry = TP
                }
              } else {
                if (singlePrice > entry) {
                  actualSL = singlePrice;  // SHORT: above entry = SL
                } else {
                  actualTP = singlePrice;  // SHORT: below entry = TP
                }
              }
            } else {
              const aboveOrder = prices.find(p => p > entry);
              const belowOrder = prices.find(p => p < entry);
              if (aboveOrder !== undefined && belowOrder !== undefined) {
                // One above entry, one below — use direction to assign
                if (isLong) {
                  actualSL = belowOrder;  // LONG SL below entry
                  actualTP = aboveOrder;   // LONG TP above entry
                } else {
                  actualSL = aboveOrder;   // SHORT SL above entry
                  actualTP = belowOrder;   // SHORT TP below entry
                }
              } else {
                // Both on same side of entry (trailing stop)
                // SL is further from entry, TP is closer
                const sorted = prices.map(p => ({ price: p, dist: Math.abs(p - entry) })).sort((a, b) => b.dist - a.dist);
                actualSL = sorted[0]!.price; // furthest from entry = SL
                actualTP = sorted[1]!.price; // closest to entry = TP
              }
            }
          } else if (actualSL === undefined && triggerOrders.length >= 2) {
            const otherOrder = triggerOrders.find(o => o.triggerPx !== hlTP?.triggerPx);
            if (otherOrder?.triggerPx) actualSL = parseFloat(otherOrder.triggerPx);
          } else if (actualTP === undefined && triggerOrders.length >= 2) {
            const otherOrder = triggerOrders.find(o => o.triggerPx !== hlSL?.triggerPx);
            if (otherOrder?.triggerPx) actualTP = parseFloat(otherOrder.triggerPx);
          }
        }
        // Sync the actual HL values back to the local mirror.
        // v2.0.56: syncSLTPFromExchange() also runs correctInvertedSLTP()
        // which may recalculate SL/TP if the local mirror had inverted values.
        this.portfolio.syncSLTPFromExchange(pos.symbol, actualSL, actualTP);

        // v2.0.56: After correction, check if local SL/TP matches HL.
        // If correctInvertedSLTP() changed the local values, push them to HL
        // so the exchange has the correct trigger orders.
        // v2.0.65: Use FRESH orders (freshMyOrders) instead of stale myOrders.
        // Also pass BOTH SL+TP together to avoid ping-pong cancellation.
        const correctedPos = this.portfolio.getPosition(sym);
        if (correctedPos) {
          const localSL = correctedPos.stopLossPrice;
          const localTP = correctedPos.takeProfitPrice;
          let needsPushSL = false;
          let needsPushTP = false;
          if (localSL !== undefined && localSL > 0) {
            const localSLRounded = parseFloat(localSL.toFixed(2));
            needsPushSL = !freshMyOrders.some(o => o.triggerPx && Math.abs(parseFloat(o.triggerPx) - localSLRounded) < 1);
          }
          if (localTP !== undefined && localTP > 0) {
            const localTPRounded = parseFloat(localTP.toFixed(2));
            needsPushTP = !freshMyOrders.some(o => o.triggerPx && Math.abs(parseFloat(o.triggerPx) - localTPRounded) < 1);
          }
          if (needsPushSL || needsPushTP) {
            log.info(`🔧 Pushing corrected SL/TP to HL for ${pos.symbol}: SL=${needsPushSL ? localSL!.toFixed(2) : '-'} TP=${needsPushTP ? localTP!.toFixed(2) : '-'}`);
            try {
              await engine.adjustPosition(pos.symbol, needsPushSL ? localSL : undefined, needsPushTP ? localTP : undefined);
            } catch { /* non-critical */ }
          }
        }
      }
    } catch (err) {
      log.warn(`syncSLTP failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

}
