// ─── Trade History ───
// Persistent record of every cycle's trade decision and outcome.
// Accumulates over time so the evolution engine can compute
// meaningful fitness metrics from real track records.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import type { TradingDecision, MarketRegime } from '../types/index.ts';

const log = createLogger({ phase: 'trade-history' });

export interface TradeHistoryEntry {
  id: string;
  cycleNumber: number;
  timestamp: number;
  decision: TradingDecision;
  /** Actual price at decision time */
  entryPrice: number;
  /** Price at next cycle for computing simulated outcome */
  exitPrice?: number;
  /** Realised PnL if a real trade was executed */
  realisedPnl?: number;
  /** Simulated PnL if this was a HOLD/exploration */
  simulatedPnl?: number;
  /** Market context */
  regime: MarketRegime;
  trend: string;
  volatility: number;
  /** Whether this was a real trade or simulated */
  type: 'real' | 'simulated' | 'exploration';
  /** Confidence from consensus */
  confidence: number;
}

/**
 * Append-only trade history ledger.
 * Every cycle writes one entry. The evolution engine reads
 * the full history to compute cumulative performance metrics.
 */
export class TradeHistory {
  private entries: TradeHistoryEntry[] = [];
  private readonly maxEntries = 5000;

  /** Load entries from saved state (restore after restart) */
  load(entries: TradeHistoryEntry[]): void {
    this.entries = entries.slice(-this.maxEntries);
    log.info(`Trade history loaded: ${this.entries.length} entries`);
  }

  /** Clear all entries */
  clear(): void {
    this.entries = [];
    log.info('Trade history cleared');
  }

  /** Get raw entries for serialization */
  getAllEntries(): TradeHistoryEntry[] {
    return [...this.entries];
  }

  /** Record one cycle's outcome */
  record(entry: Omit<TradeHistoryEntry, 'id' | 'timestamp'>): TradeHistoryEntry {
    const record: TradeHistoryEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: Date.now(),
    };
    this.entries.push(record);

    // Prune oldest if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    return record;
  }

  /** Update the previous cycle entry's exit price (called on next cycle) */
  updateLastExit(exitPrice: number): void {
    if (this.entries.length < 2) return;
    // The last entry is the current cycle we just recorded.
    // The SECOND-TO-LAST entry is the PREVIOUS cycle whose outcome we can now compute.
    const prev = this.entries[this.entries.length - 2]!;
    if (prev.exitPrice !== undefined) return; // already set (real trade)
    prev.exitPrice = exitPrice;

    // Compute simulated PnL based on decision direction
    if (prev.decision.action === 'buy') {
      prev.simulatedPnl = ((exitPrice - prev.entryPrice) / prev.entryPrice) * (prev.decision.positionSizePct || 0.05);
    } else if (prev.decision.action === 'sell') {
      prev.simulatedPnl = ((prev.entryPrice - exitPrice) / prev.entryPrice) * (prev.decision.positionSizePct || 0.05);
    } else {
      // HOLD: simulate what would have happened with a small position
      prev.simulatedPnl = ((exitPrice - prev.entryPrice) / prev.entryPrice) * 0.02;
    }
  }

  /** Get all entries */
  getAll(): readonly TradeHistoryEntry[] {
    return this.entries;
  }

  /** Get entries for a specific regime */
  getByRegime(regime: MarketRegime): TradeHistoryEntry[] {
    return this.entries.filter(e => e.regime === regime);
  }

  /** Get recent N entries */
  getRecent(n: number): TradeHistoryEntry[] {
    return this.entries.slice(-n);
  }

  /** Compute cumulative performance metrics from entire history */
  computePerformance(): {
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
    totalReturn: number;
    trades: number;
    avgWin: number;
    avgLoss: number;
    expectancy: number;
    countedTrades: number;
  } {
    const trades = this.entries.length;
    if (trades === 0) {
      return { sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0, winRate: 0, profitFactor: 0, maxDrawdown: 0, totalReturn: 0, trades: 0, avgWin: 0, avgLoss: 0, expectancy: 0, countedTrades: 0 };
    }

    // Use simulatedPnl for HOLD entries, realisedPnl for real trades
    // Both are ratios (e.g. 0.01834 = 1.834%) — unit-consistent
    const pnls: number[] = [];
    let wins = 0, losses = 0;
    let totalWin = 0, totalLoss = 0;
    let peak = 0, maxDrawdown = 0;
    let cumulativeReturn = 0;
    let countedTrades = 0;

    for (const e of this.entries) {
      const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
      // Skip stale zero-PnL entries
      if (pnl === 0) continue;
      // Skip noise-level PnL (< 0.001% portfolio impact) — only for win/loss counting
      const isNoise = Math.abs(pnl) < 0.00001;
      // ALL entries with non-zero PnL count as wins or losses (including simulated/exploration).
      // Rationale: preservation of capital IS a win. Breaking even = win.
      // Exploration trades with tiny PnL still represent a decision outcome.
      if (pnl > 0 || isNoise) { wins++; totalWin += Math.abs(pnl); }
      else { losses++; totalLoss += Math.abs(pnl); }
      if (!isNoise) {
        countedTrades++;
        pnls.push(pnl);
        cumulativeReturn += pnl;
      }
      // Track drawdown
      peak = Math.max(peak, cumulativeReturn);
      const dd = peak - cumulativeReturn;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const totalRealTrades = wins + losses;
    const winRate = totalRealTrades > 0 ? wins / totalRealTrades : 0;
    const avgWin = wins > 0 ? totalWin / wins : 0.001;
    const avgLoss = losses > 0 ? totalLoss / losses : 0.001;
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 999 : 1);
    // totalReturn is now the cumulative sum of percentage-ratio PnLs,
    // which naturally gives the total return as a decimal (e.g. 0.0521 = 5.21%)
    const totalReturn = cumulativeReturn;
    const lossRate = totalRealTrades > 0 ? losses / totalRealTrades : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);

    // Sharpe ratio: mean(pnl) / std(pnl) * sqrt(cycles)
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length;
    const std = Math.sqrt(variance);
    const sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(countedTrades) : 0;

    // Sortino: only downside deviation
    const downsidePnls = pnls.filter(p => p < 0);
    const downVariance = downsidePnls.length > 0
      ? downsidePnls.reduce((sum, p) => sum + p ** 2, 0) / downsidePnls.length
      : 0;
    const downStd = Math.sqrt(downVariance);
    const sortinoRatio = downStd > 0 ? (mean / downStd) * Math.sqrt(countedTrades) : sharpeRatio;

    // Calmar: return / max drawdown
    const calmarRatio = maxDrawdown > 0 ? totalReturn / maxDrawdown : totalReturn > 0 ? 1 : 0;

    return {
      sharpeRatio: parseFloat(sharpeRatio.toFixed(4)),
      sortinoRatio: parseFloat(sortinoRatio.toFixed(4)),
      calmarRatio: parseFloat(calmarRatio.toFixed(4)),
      winRate: parseFloat(winRate.toFixed(4)),
      profitFactor: parseFloat(profitFactor.toFixed(4)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
      totalReturn: parseFloat(totalReturn.toFixed(4)),
      trades: countedTrades,
      avgWin: parseFloat(avgWin.toFixed(4)),
      avgLoss: parseFloat(avgLoss.toFixed(4)),
      expectancy: parseFloat(expectancy.toFixed(4)),
      countedTrades,
    };
  }

  /** Get summary for agent context injection */
  getSummary(limit = 5): string {
    const perf = this.computePerformance();
    const recent = this.getRecent(limit);

    let s = `=== Trade History ===\n`;
    s += `Total Cycles: ${perf.countedTrades} meaningful / ${this.entries.length} total\n`;
    s += `Win Rate: ${(perf.winRate * 100).toFixed(1)}% | Sharpe: ${perf.sharpeRatio.toFixed(2)}\n`;
    s += `Total Return: ${(perf.totalReturn * 100).toFixed(2)}% | Profit Factor: ${perf.profitFactor.toFixed(2)}\n`;

    if (recent.length > 0) {
      s += `\nRecent Decisions:\n`;
      for (const e of recent) {
        const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
        s += `  #${e.cycleNumber} ${e.decision.action.toUpperCase()} (${(e.confidence * 100).toFixed(0)}%) → ${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(3)}%\n`;
      }
    }

    return s;
  }

  getStats(): { totalEntries: number; realTrades: number; simulatedTrades: number } {
    return {
      totalEntries: this.entries.length,
      realTrades: this.entries.filter(e => e.type === 'real' || e.type === 'exploration').length,
      simulatedTrades: this.entries.filter(e => e.type === 'simulated').length,
    };
  }
}
