// ─── Execution Tracker ───
// Tracks decision → fill quality for every trade.
// Measures: slippage (expected vs actual price), taker fees paid, latency.
// Provides: per-symbol stats, running averages, total cost reporting.
//
// In paper mode: expectedPrice = market price at decision time
//                  actualPrice    = market price at fill time (paper = instant, 0 slippage)
// In real mode:   expectedPrice = market price at decision time
//                  actualPrice    = exchange fill price from order result
//
// Even in paper mode, slippage CAN be estimated from order book depth
// for a realistic simulation (optional).

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { calculateTakerFee } from './cost-model.ts';

const log = createLogger({ phase: 'execution-tracker' });

// ─── Types ───

export interface ExecutionRecord {
  id: string;
  cycleNumber: number;
  symbol: string;
  side: 'buy' | 'sell';
  /** Expected price at decision time (from market data) */
  expectedPrice: number;
  /** Actual fill price */
  actualPrice: number;
  /** Slippage in basis points (1 bp = 0.01%) */
  slippageBps: number;
  /** Trade notional in USD (price × quantity × leverage) */
  notional: number;
  /** Taker fee paid in USD */
  takerFeeUsd: number;
  /** Estimated funding cost for holding period in USD (0 for new positions) */
  fundingCostUsd: number;
  /** Decision timestamp */
  decisionAt: number;
  /** Fill timestamp */
  filledAt: number;
  /** Was this a real exchange fill or paper simulated? */
  mode: 'paper' | 'real';
}

export interface ExecutionStats {
  totalTrades: number;
  totalNotional: number;
  avgSlippageBps: number;
  maxSlippageBps: number;
  totalFees: number;
  tradeCount: number;
}

// ─── Execution Tracker ───

export class ExecutionTracker {
  private records: ExecutionRecord[] = [];
  private readonly maxRecords = 1_000;
  private readonly logger = log;

  /** Record a single execution (decision → fill) */
  record(params: {
    cycleNumber: number;
    symbol: string;
    side: 'buy' | 'sell';
    expectedPrice: number;
    actualPrice: number;
    notional: number;
    decisionAt: number;
    filledAt: number;
    mode: 'paper' | 'real';
    /** Pre-calculated funding cost (0 for new positions) */
    fundingCostUsd?: number;
  }): void {
    try {
      const slippageBps = this.calcSlippageBps(params.expectedPrice, params.actualPrice, params.side);
      const takerFeeUsd = calculateTakerFee(params.notional);
      const record: ExecutionRecord = {
        id: uuidv4(),
        cycleNumber: params.cycleNumber,
        symbol: params.symbol,
        side: params.side,
        expectedPrice: params.expectedPrice,
        actualPrice: params.actualPrice,
        slippageBps,
        notional: params.notional,
        takerFeeUsd,
        fundingCostUsd: params.fundingCostUsd ?? 0,
        decisionAt: params.decisionAt,
        filledAt: params.filledAt,
        mode: params.mode,
      };
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
      }
      this.logger.info(`Exec[${params.symbol}]: ${params.side.toUpperCase()} @$${params.actualPrice.toFixed(2)} (exp: $${params.expectedPrice.toFixed(2)}, slip: ${slippageBps.toFixed(1)}bp, fee: $${takerFeeUsd.toFixed(2)})`);
    } catch (err) {
      this.logger.error(`[execution-tracker.record] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Estimate slippage from order book depth without actually trading.
   *  Used in paper mode to simulate realistic slippage.
   *  @returns slippage in basis points
   */
  estimateSlippageFromDepth(
    side: 'buy' | 'sell',
    notionalUsd: number,
    orderBookLevels: Array<{ price: number; size: number }>,
  ): number {
    try {
      if (!orderBookLevels || orderBookLevels.length === 0 || notionalUsd <= 0) return 0;

      let remaining = notionalUsd;
      let weightedPrice = 0;
      let totalFilled = 0;

      for (const level of orderBookLevels) {
        const levelNotional = level.price * level.size;
        if (remaining <= 0) break;
        const fill = Math.min(remaining, levelNotional);
        weightedPrice += level.price * (fill / levelNotional);
        totalFilled += fill / level.price;
        remaining -= fill;
      }

      if (totalFilled <= 0) return 0;

      const avgFillPrice = weightedPrice / (totalFilled > 0 ? 1 : 1);
      // Find mid price (average of first bid and ask)
      // For simplicity, use first level price as reference
      const refPrice = orderBookLevels[0]?.price ?? 0;
      if (refPrice <= 0) return 0;

      // Slippage = distance from mid to avg fill
      const slippagePct = Math.abs(avgFillPrice - refPrice) / refPrice;
      return slippagePct * 10_000; // Convert to bps
    } catch (err) {
      this.logger.error(`[estimateSlippageFromDepth] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Get stats for a specific symbol (or all) */
  getStats(symbol?: string): ExecutionStats {
    try {
      let filtered = this.records;
      if (symbol) filtered = filtered.filter(r => r.symbol === symbol);

      if (filtered.length === 0) {
        return { totalTrades: 0, totalNotional: 0, avgSlippageBps: 0, maxSlippageBps: 0, totalFees: 0, tradeCount: 0 };
      }

      const avgSlippage = filtered.reduce((s, r) => s + r.slippageBps, 0) / filtered.length;

      return {
        totalTrades: filtered.length,
        totalNotional: filtered.reduce((s, r) => s + r.notional, 0),
        avgSlippageBps: avgSlippage,
        maxSlippageBps: Math.max(...filtered.map(r => r.slippageBps)),
        totalFees: filtered.reduce((s, r) => s + r.takerFeeUsd, 0),
        tradeCount: filtered.length,
      };
    } catch (err) {
      this.logger.error(`[execution-tracker.getStats] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { totalTrades: 0, totalNotional: 0, avgSlippageBps: 0, maxSlippageBps: 0, totalFees: 0, tradeCount: 0 };
    }
  }

  /** Get all records (for persistence/serialization) */
  getAllRecords(): ExecutionRecord[] {
    return [...this.records];
  }

  /** Calculate slippage in basis points between expected and actual price.
   *  Buy: positive slippage = actual > expected (bad for buyer)
   *  Sell: positive slippage = actual < expected (bad for seller)
   */
  private calcSlippageBps(expected: number, actual: number, side: 'buy' | 'sell'): number {
    try {
      if (expected <= 0 || actual <= 0) return 0;
      const pctChange = (actual - expected) / expected;
      // For buys: positive pctChange = worse price = positive slippage
      // For sells: negative pctChange = worse price = positive slippage  
      const signed = side === 'buy' ? pctChange : -pctChange;
      return Math.max(0, signed * 10_000); // bps, never negative
    } catch {
      return 0;
    }
  }

  /** Get a summary string for injection into agent context */
  getSummary(): string {
    try {
      const all = this.getStats();
      if (all.totalTrades === 0) return '=== Execution Quality ===\nNo trades executed yet.\n';
      return [
        '=== Execution Quality ===',
        `Trades: ${all.totalTrades}`,
        `Avg Slippage: ${all.avgSlippageBps.toFixed(1)} bps`,
        `Max Slippage: ${all.maxSlippageBps.toFixed(1)} bps`,
        `Total Fees Paid: $${all.totalFees.toFixed(2)}`,
        '==========================',
      ].join('\n');
    } catch {
      return 'Execution quality data unavailable.';
    }
  }
}