// ─── Paper Trading Engine ───
// Pure simulation layer — tracks orders, fills, and trade lifecycle

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { PortfolioTracker } from './portfolio.ts';
import { RiskEngine } from '../risk/engine.ts';
import type { Order, OrderSide, OrderStatus, Ticker, TradingDecision, TradeRecord } from '../types/index.ts';

const log = createLogger({ phase: 'trading' });

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

  constructor(portfolio: PortfolioTracker, riskEngine: RiskEngine) {
    this.portfolio = portfolio;
    this.riskEngine = riskEngine;
    // Capture trades from SL/TP auto-closes and reconciliations
    this.portfolio.setOnPositionClosed((trade) => {
      this.trades.push(trade);
      log.info(`Trade captured from SL/TP/reconciliation: ${trade.side.toUpperCase()} ${trade.symbol} PnL: $${trade.pnl.toFixed(2)}`);
    });
    // NOTE: open trades are NOT recorded here — they are tracked via portfolio.positions.
    // Only closed/SL-TP/reconciliation trades are captured above.
    // This avoids duplicate 'ghost open' records (status=open + status=closed for the same trade).
    log.info('Paper trading engine initialized.', {
      initialBalance: portfolio.getPortfolio().initialBalance,
    });
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
        Array.from(this.portfolio.getPortfolio().positions.values()).map(p => p.symbol.toLowerCase())
      );
      const validTrades = trades.filter(t => {
        if (t.status === 'open' && !openSymbols.has(t.symbol.toLowerCase())) {
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

  getOrders(): readonly Order[] {
    return Array.from(this.orders.values());
  }

  updatePrice(symbol: string, price: number): void {
    const sym = symbol.toLowerCase();
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
    const price = this.lastPrices.get(sym) ?? decision.entryPrice ?? 0;
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
    const newMargin = quantity * price; // margin for the new position
    const totalMarginAfter = totalMarginExposure + newMargin;
    const maxMargin = portfolio.balance * 0.20; // 20% of balance max total margin

    if (totalMarginAfter > maxMargin) {
      // Try to scale down the new position to fit within limit
      const allowedNewMargin = Math.max(0, maxMargin - totalMarginExposure);
      if (allowedNewMargin > 0) {
        const scaledQuantity = allowedNewMargin / price;
        log.info(`Position scaled down: ${quantity.toFixed(6)} → ${scaledQuantity.toFixed(6)} (cumulative margin ${((totalMarginAfter / portfolio.balance) * 100).toFixed(1)}% > 20%)`);
        return [await this.executeOrder(decision, scaledQuantity, price)];
      } else {
        const err = `Cumulative margin $${totalMarginAfter.toFixed(2)} exceeds 20% of balance $${portfolio.balance.toFixed(2)}. Cannot open new position.`;
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

    // Execute the order
    const report = await this.executeOrder(decision, quantity, price);

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
    const safeSymbol = decision.symbol.toLowerCase();
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
      this.portfolio.openPosition(order, price, decision.leverage ?? 1);
    } else if (decision.action === 'sell') {
      // Close long position
      if (this.portfolio.hasPosition(safeSymbol)) {
        this.portfolio.closePosition(safeSymbol, price);
      } else {
        // Open short position (paper)
        this.portfolio.openPosition(order, price, decision.leverage ?? 1);
      }
    }

    // Look up the last closed trade from this execution (the callback pushed it)
    const lastTrade = this.trades.length > 0 ? this.trades[this.trades.length - 1] : undefined;

    return { order, trade: lastTrade };
  }

  private createRejectedOrder(decision: TradingDecision, reason: string): Order {
    return {
      id: uuidv4(),
      symbol: decision.symbol.toLowerCase(),
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