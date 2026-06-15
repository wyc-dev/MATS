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
    // Capture open trades
    this.portfolio.setOnPositionOpened((trade) => {
      this.trades.push(trade);
      log.info(`Trade captured from open: ${trade.side.toUpperCase()} ${trade.symbol} @ $${trade.entryPrice.toFixed(2)}`);
    });
    log.info('Paper trading engine initialized.', {
      initialBalance: portfolio.getPortfolio().initialBalance,
    });
  }

  /** Restore previously persisted trades on startup */
  restoreTrades(trades: TradeRecord[]): void {
    if (trades.length > 0) {
      this.trades.push(...trades);
      log.info(`📋 ${trades.length} trades restored from disk`);
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

    // ── Cumulative position value check ──
    // Total position value (all open positions × current price × leverage)
    // must not exceed 10% of balance. This prevents over-leveraging.
    const portfolio = this.portfolio.getPortfolio();
    let totalExposure = 0;
    for (const [, pos] of portfolio.positions) {
      totalExposure += pos.quantity * pos.currentPrice * (pos.leverage ?? 1);
    }
    const newExposure = quantity * price * (decision.leverage ?? 1);
    const totalAfter = totalExposure + newExposure;
    const maxExposure = portfolio.balance * 0.10; // 10% of balance

    if (totalAfter > maxExposure) {
      // Try to scale down the new position to fit within limit
      const allowedNewExposure = Math.max(0, maxExposure - totalExposure);
      if (allowedNewExposure > 0) {
        const scaledQuantity = allowedNewExposure / (price * (decision.leverage ?? 1));
        log.info(`Position scaled down: ${quantity.toFixed(6)} → ${scaledQuantity.toFixed(6)} (cumulative exposure ${((totalAfter / portfolio.balance) * 100).toFixed(1)}% > 10%)`);
        return [await this.executeOrder(decision, scaledQuantity, price)];
      } else {
        const err = `Cumulative position value $${totalAfter.toFixed(2)} exceeds 10% of balance $${portfolio.balance.toFixed(2)}. Cannot open new position.`;
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