// ─── Paper Trading Engine ───
// Pure simulation layer — tracks orders, fills, and trade lifecycle

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { PortfolioTracker } from './portfolio.ts';
import { RiskEngine } from '../risk/engine.ts';
import type { Order, OrderSide, OrderStatus, Ticker, TradingDecision, TradeRecord } from '../types/index.ts';

const log = createLogger({ phase: 'trading' });

/** Hyperliquid minimum order notional in USD. Orders below this are rejected
 *  by the exchange. Used as a floor so that Risk Auditor size reductions (e.g.
 *  choppy-market 50% cut) never produce an untradeable tiny order. */
const HL_MIN_NOTIONAL_USD = 10;

export interface ExecutionReport {
  order: Order;
  trade?: TradeRecord;
  error?: string;
}

export class PaperTradingEngine {
  private readonly portfolio: PortfolioTracker;
  private readonly riskEngine: RiskEngine;
  private readonly orders: Map<string, Order> = new Map();
  private readonly trades: TradeRecord[] = [];
  private lastPrices: Map<string, number> = new Map();
  /** v2.0.XX: Max portion of balance for all positions combined. Set by
   *  index.ts from MarketAgent config. Default 0.20 (20%) — the old hardcoded value. */
  private maxPortionPct = 0.20;
  /** v2.0.25: Learning callback invoked after EVERY position close (SL/TP,
   *  reconciliation, agent-vote close). The caller (index.ts) uses this to
   *  feed the loss/win into RBC, Pattern Classifier, Agent Outcomes, Trade
   *  History, and Evolution — so the system learns from SL/TP closes that
   *  happen outside the decision cycle. */
  private onClosedLearningCb: ((trade: TradeRecord) => void) | null = null;

  /** Register a learning callback invoked after every position close. */
  setOnClosedLearning(cb: (trade: TradeRecord) => void): void {
    this.onClosedLearningCb = cb;
  }

  constructor(portfolio: PortfolioTracker, riskEngine: RiskEngine) {
    this.portfolio = portfolio;
    this.riskEngine = riskEngine;
    // Capture trades from SL/TP auto-closes and reconciliations
    this.portfolio.setOnPositionClosed((trade) => {
      this.trades.push(trade);
      log.info(`Trade captured from SL/TP/reconciliation: ${trade.side.toUpperCase()} ${trade.symbol} PnL: $${trade.pnl.toFixed(2)}`);
      // v2.0.25: trigger learning hooks so SL/TP closes are fed to RBC,
      // Pattern Classifier, Agent Outcomes, Trade History, and Evolution.
      if (this.onClosedLearningCb) {
        try {
          this.onClosedLearningCb(trade);
        } catch (err) {
          log.warn(`[onClosedLearning] Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    // NOTE: open trades are NOT recorded here — they are tracked via portfolio.positions.
    // Only closed/SL-TP/reconciliation trades are captured above.
    // This avoids duplicate 'ghost open' records (status=open + status=closed for the same trade).
    log.info('Paper trading engine initialized.', {
      initialBalance: portfolio.getPortfolio().initialBalance,
    });
  }

  /** v2.0.XX: Set max portion of balance for all positions combined.
   *  Called by index.ts when Market Agent config changes. */
  setMaxPortionPct(pct: number): void {
    this.maxPortionPct = Math.max(0.10, Math.min(0.50, pct));
  }

  /** Restore previously persisted trades on startup */
  restoreTrades(trades: TradeRecord[]): void {
    if (trades.length > 0) {
      // Filter out ghost open records (status=open but no corresponding position).
      // These are historical artifacts from the old bug where openPosition() created
      // a TradeRecord with status='open' but the position was later overwritten by
      // a symbol overlap (Map.set overwrite). Ghost records can never be closed
      // because the position no longer exists — they just pollute the trade history.
      const openSymbols = new Set(
        Array.from(this.portfolio.getPortfolio().positions.values()).map(p => p.symbol)
      );
      const validTrades = trades.filter(t => {
        if (t.status === 'open' && !openSymbols.has(t.symbol)) {
          log.warn(`🧹 Ghost open record removed: ${t.side.toUpperCase()} ${t.symbol} @ ${t.entryPrice} (no matching position)`);
          return false;
        }
        return true;
      });
      const ghostCount = trades.length - validTrades.length;
      this.trades.push(...validTrades);
      log.info(`📋 ${validTrades.length} trades restored from disk${ghostCount > 0 ? ` (${ghostCount} ghosts removed)` : ''}`);
    }
  }

  getPortfolio(): Readonly<ReturnType<PortfolioTracker['getPortfolio']>> {
    return this.portfolio.getPortfolio();
  }

  getTrades(): readonly TradeRecord[] {
    return this.trades;
  }

  /** v2.0.79: Reset all paper trade records (for UI reset button) */
  resetTrades(): void {
    this.trades.length = 0;
    log.info('🗑️ Paper trades reset — all trade records cleared');
  }

  /**
   * v2.0.42: Get win/loss stats for the most recent N trades.
   * Used by UI + heartbeat to show a RECENT win rate that reflects
   * current performance, not the all-time cumulative rate.
   *
   * ⚠️ MAINTENANCE NOTE: If you change the win/loss definition (e.g. what
   * counts as a "win"), update this method AND onPositionClosedLearning
   * in index.ts which also classifies wins/losses.
   */
  getRecentWinLoss(n = 20): { wins: number; losses: number; total: number; winRate: number } {
    const recent = this.trades.slice(-n);
    const wins = recent.filter(t => t.pnl >= 0).length;
    const losses = recent.filter(t => t.pnl < 0).length;
    const total = wins + losses;
    return { wins, losses, total, winRate: total > 0 ? wins / total : 0 };
  }

  getOrders(): readonly Order[] {
    return Array.from(this.orders.values());
  }

  updatePrice(symbol: string, price: number): void {
    // v2.0.31: Use case-preserving normalization for colon-prefixed symbols
    const sym = symbol.includes(':') ? symbol : symbol.toLowerCase();
    this.lastPrices.set(sym, price);

    // Update all positions with new price
    if (this.portfolio.hasPosition(sym)) {
      this.portfolio.updatePosition(sym, price);
    }
  }

  async executeDecision(decision: TradingDecision): Promise<ExecutionReport[]> {
    const reports: ExecutionReport[] = [];

    if (decision.action === 'hold') {
      log.info('HOLD — no action taken.', { rationale: (decision.rationale ?? '').slice(0, 100) });
      return reports;
    }

    // Check if trading is allowed
    const tradeCheck = this.portfolio.canTrade();
    if (!tradeCheck.allowed) {
      log.warn(`Trade blocked: ${tradeCheck.reason}`);
      return [{
        order: this.createRejectedOrder(decision, tradeCheck.reason ?? 'Unknown reason'),
        error: tradeCheck.reason,
      }];
    }

    // Risk assessment — decision.symbol is guaranteed by normalizeDecision()
    const sym = decision.symbol.toLowerCase();
    // 🐛 FIX: Use decision.entryPrice as PRIMARY source (price at decision time).
    // lastPrices is a fallback only — it gets updated by WS ticks during HACP
    // (~30-60s), so by execution time it reflects the LATEST tick, not the
    // price at which the agents made their decision. Using the wrong price
    // causes position entry at a different level than what was decided.
    const price = decision.entryPrice && decision.entryPrice > 0
      ? decision.entryPrice
      : (this.lastPrices.get(sym) ?? 0);
    if (price <= 0) {
      const err = `No price available for ${decision.symbol}. Cannot execute.`;
      log.error(err);
      return [{
        order: this.createRejectedOrder(decision, err),
        error: err,
      }];
    }

    const equity = this.portfolio.getEquity();
    const positionSize = decision.positionSizePct * equity;
    const quantity = positionSize / price;

    if (quantity <= 0) {
      log.info('Position size too small. Skipping.');
      return reports;
    }

    // ── Hyperliquid minimum notional floor ──
    // If the position size (after any Risk Auditor choppy-market reduction)
    // falls below HL's minimum order notional, bump it up to the floor so the
    // trade remains executable. This only applies to BUY/SELL — HOLD/close
    // paths don't reach here. We floor the notional, not skip, because the
    // agents already decided to trade; being below min is a sizing artefact,
    // not a signal to abandon the trade.
    const notional = quantity * price;
    let effectiveQuantity = quantity;
    if (notional < HL_MIN_NOTIONAL_USD && (decision.action === 'buy' || decision.action === 'sell')) {
      effectiveQuantity = HL_MIN_NOTIONAL_USD / price;
      log.info(`Position notional $${notional.toFixed(2)} below HL min $${HL_MIN_NOTIONAL_USD} — floored to ${effectiveQuantity.toFixed(6)} ($${HL_MIN_NOTIONAL_USD} notional)`);
    }

    // ── Symbol Overlap Guard (defence-in-depth) ──
    // If this symbol already has an open position, do NOT open a new trade.
    // The existing position is already managed by per-symbol consensus + SL/TP.
    // Opening a second trade would silently overwrite the existing position
    // (portfolio.positions is a Map — .set(key) replaces), creating ghost PnL.
    if (this.portfolio.hasPosition(sym)) {
      const existing = this.portfolio.getPosition(sym)!;
      log.warn(`🚫 Paper engine symbol-guard: ${sym.toUpperCase()} already has ${existing.side.toUpperCase()} position. Blocking new ${decision.action.toUpperCase()} trade.`);
      return [{
        order: this.createRejectedOrder(decision, `Symbol overlap: ${sym} already positioned (${existing.side}).`),
        error: `Symbol overlap: ${sym} already positioned.`,
      }];
    }

    // ── Cumulative position value check ──
    // Only check UNLEVERAGED position value (margin at risk) against balance.
    // Leveraged notional can legitimately exceed balance — that's the point of
    // leverage. E.g., 10% position at 10x = 100% notional, which is fine.
    // This check prevents total MARGIN across all positions from exceeding
    // a reasonable % of balance (not the leveraged notional).
    const portfolio = this.portfolio.getPortfolio();
    let totalMarginExposure = 0;
    for (const [, pos] of portfolio.positions) {
      totalMarginExposure += pos.quantity * pos.averageEntryPrice; // margin, not notional
    }
    const newMargin = effectiveQuantity * price; // margin for the new position
    const totalMarginAfter = totalMarginExposure + newMargin;
    // v2.0.XX: Use configurable maxPortionPct instead of hardcoded 0.20
    const maxMargin = portfolio.balance * this.maxPortionPct;

    if (totalMarginAfter > maxMargin) {
      // Try to scale down the new position to fit within limit
      const allowedNewMargin = Math.max(0, maxMargin - totalMarginExposure);
      if (allowedNewMargin > 0) {
        const scaledQuantity = allowedNewMargin / price;
        // Re-apply the HL min notional floor after scaling down — if the
        // scaled-down order is below min, floor it back up (the 20% margin
        // cap is a soft guard; HL min notional is a hard exchange requirement).
        const scaledNotional = scaledQuantity * price;
        const finalScaled = scaledNotional < HL_MIN_NOTIONAL_USD && (decision.action === 'buy' || decision.action === 'sell')
          ? HL_MIN_NOTIONAL_USD / price
          : scaledQuantity;
        log.info(`Position scaled down: ${effectiveQuantity.toFixed(6)} → ${finalScaled.toFixed(6)} (cumulative margin ${((totalMarginAfter / portfolio.balance) * 100).toFixed(1)}% > 20%)`);
        return [await this.executeOrder(decision, finalScaled, price)];
      } else {
        const err = `Cumulative margin $${totalMarginAfter.toFixed(2)} exceeds ${(this.maxPortionPct * 100).toFixed(0)}% of balance $${portfolio.balance.toFixed(2)}. Cannot open new position.`;
        log.warn(err);
        return [{ order: this.createRejectedOrder(decision, err), error: err }];
      }
    }

    // Validate against risk limits
    const riskAssessment = this.riskEngine.assessTrade(
      this.portfolio.getPortfolio() as any,
      decision.action,
      decision.positionSizePct,
      price,
      0.02 // default volatility
    );

    if (!riskAssessment.allowed) {
      const err = `Risk assessment failed: ${riskAssessment.concerns.map((c) => c.description).join('; ')}`;
      log.warn(err);

      // If adjusted position size is available, try with reduced size
      if (riskAssessment.adjustedPositionSize) {
        const adjustedQuantity = (riskAssessment.adjustedPositionSize * equity) / price;
        if (adjustedQuantity > 0) {
          log.info(`Retrying with adjusted size: ${(riskAssessment.adjustedPositionSize! * 100).toFixed(1)}%`);
          return [await this.executeOrder(decision, adjustedQuantity, price)];
        }
      }

      return [{
        order: this.createRejectedOrder(decision, err),
        error: err,
      }];
    }

    // Execute the order (use effectiveQuantity which honours the HL min notional floor)
    const report = await this.executeOrder(decision, effectiveQuantity, price);

    // Log execution summary
    if (report.trade) {
      log.info(`Trade executed: ${decision.action.toUpperCase()} ${report.trade.quantity.toFixed(6)} ${decision.symbol} @ ${price}`, {
        pnl: report.trade.pnl.toFixed(2),
        balance: this.portfolio.getPortfolio().balance.toFixed(2),
      });
    }

    reports.push(report);
    return reports;
  }

  private async executeOrder(
    decision: TradingDecision,
    quantity: number,
    price: number
  ): Promise<ExecutionReport> {
    const safeSymbol = decision.symbol.includes(':') ? decision.symbol : decision.symbol.toLowerCase();
    const order: Order = {
      id: uuidv4(),
      symbol: safeSymbol,
      side: decision.action as OrderSide,
      type: 'market',
      quantity,
      price,
      status: 'filled',
      filledQuantity: quantity,
      filledPrice: price,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentId: '' as any, // Will be set by consensus
    };

    this.orders.set(order.id, order);

    // Open or close position — TradeRecord capture happens via the callback
    // registered in constructor (portfolio.setOnPositionClosed)
    if (decision.action === 'buy') {
      // Close any existing short position first
      if (this.portfolio.hasPosition(safeSymbol)) {
        const existing = this.portfolio.getPosition(safeSymbol)!;
        if (existing.side === 'sell') {
          this.portfolio.closePosition(safeSymbol, price);
        }
      }
      this.portfolio.openPosition(order, price, decision.leverage ?? 1, decision.entryThesis);
    } else if (decision.action === 'sell') {
      // Close long position
      if (this.portfolio.hasPosition(safeSymbol)) {
        this.portfolio.closePosition(safeSymbol, price);
      } else {
        // Open short position (paper)
        this.portfolio.openPosition(order, price, decision.leverage ?? 1, decision.entryThesis);
      }
    }

    // Look up the last closed trade from this execution (the callback pushed it)
    const lastTrade = this.trades.length > 0 ? this.trades[this.trades.length - 1] : undefined;

    return { order, trade: lastTrade };
  }

  private createRejectedOrder(decision: TradingDecision, reason: string): Order {
    return {
      id: uuidv4(),
      symbol: decision.symbol.includes(':') ? decision.symbol : decision.symbol.toLowerCase(),
      side: decision.action as OrderSide,
      type: 'market',
      quantity: 0,
      price: 0,
      status: 'rejected',
      filledQuantity: 0,
      filledPrice: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentId: '' as any,
      metadata: { rejectionReason: reason },
    };
  }

  getPortfolioSummary(): string {
    const p = this.portfolio.getPortfolio();
    return [
      `=== Portfolio Summary ===`,
      `Balance: $${p.balance.toFixed(2)}`,
      `Equity: $${p.totalEquity.toFixed(2)}`,
      `P&L: $${p.totalPnl.toFixed(2)} (${(p.totalPnlPct * 100).toFixed(2)}%)`,
      `Drawdown: ${(p.maxDrawdownPct * 100).toFixed(2)}%`,
      `Positions: ${p.positions.size}`,
      `Trades: ${p.tradeCount} (W:${p.winCount} L:${p.lossCount})`,
      `Daily P&L: $${p.dailyPnl.toFixed(2)}`,
      `---`,
    ].join('\n');
  }
}