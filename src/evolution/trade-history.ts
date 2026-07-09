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
  /** Trading symbol (e.g. BTC-USDT) — used to detect symbol switches for PnL invalidation */
  symbol: string;
  decision: TradingDecision;
  /** Actual price at decision time */
  entryPrice: number;
  /** Price at next cycle for computing simulated outcome */
  exitPrice?: number;
  /** Realised PnL if a real trade was executed (portfolio return contribution, e.g. 0.005 = 0.5%) */
  realisedPnl?: number;
  /** Simulated PnL if this was a HOLD/exploration (portfolio return contribution) */
  simulatedPnl?: number;
  /** Market context */
  regime: MarketRegime;
  trend: string;
  volatility: number;
  /** Whether this was a real trade or simulated */
  type: 'real' | 'simulated' | 'exploration';
  /** Confidence from consensus */
  confidence: number;
  /** v2.0.139: How the position was closed — thesis_invalidation losses are
   *  excluded from the conviction-gate winRate so the gate only tightens on
   *  real market-risk losses (SL hit), not thesis-system force-closes. */
  closeReason?: 'sl_tp' | 'consensus' | 'manual' | 'reconciliation' | 'exchange_closed' | 'thesis_invalidation';
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

  /**
   * Update the previous cycle entry's exit price (called on next cycle).
   *
   * Production-grade safety: if the symbol changed between cycles,
   * the entry/exit prices are incomparable — skip PnL calculation.
   * This prevents the 214% outlier we saw when Market Agent switched
   * from a low-priced asset (~$598) to BTC (~$64,920).
   */
  updateLastExit(exitPrice: number, currentSymbol: string): void {
    if (this.entries.length < 2) return;
    // The last entry is the current cycle we just recorded.
    // The SECOND-TO-LAST entry is the PREVIOUS cycle whose outcome we can now compute.
    const prev = this.entries[this.entries.length - 2]!;
    if (prev.exitPrice !== undefined) return; // already set (real trade)

    // ─── Symbol switch guard ───
    // If the market agent switched symbols between cycles, prices are incomparable.
    // Example: prev.symbol='HONEY-USDT' @ $598 → current symbol='BTC-USDT' @ $64,920
    // Computing PnL across different assets produces garbage (e.g. +214% "return").
    if (prev.symbol !== currentSymbol) {
      log.info(`Symbol switch detected: ${prev.symbol} → ${currentSymbol} — skipping simulated PnL for cycle #${prev.cycleNumber}`);
      prev.exitPrice = exitPrice; // still record the price for reference
      // Don't compute simulatedPnl — leave as undefined (will be treated as 0 by computePerformance)
      return;
    }

    prev.exitPrice = exitPrice;

    // Compute simulated PnL based on decision direction.
    // Use the actual positionSizePct from the decision (not hardcoded 0.02).
    // This reflects what WOULD have happened if the system had taken the position.
    const positionSize = prev.decision.positionSizePct || 0.05;
    const priceChange = (exitPrice - prev.entryPrice) / prev.entryPrice;

    if (prev.decision.action === 'buy') {
      prev.simulatedPnl = priceChange * positionSize;
    } else if (prev.decision.action === 'sell') {
      prev.simulatedPnl = -priceChange * positionSize;
    } else {
      // HOLD: simulate what would have happened with the planned position size
      prev.simulatedPnl = priceChange * positionSize;
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

  /**
   * v2.0.27: Build a detailed loss-review context for the Risk Auditor LLM.
   * Lists the most recent losing trades with per-trade details so the LLM
   * can analyze WHY each loss happened and decide whether to resume trading.
   *
   * Includes: direction, entry/exit price, PnL, regime, trend, volatility,
   * hold duration, and the decision rationale — everything the LLM needs
   * to do a meaningful post-loss review instead of guessing from aggregates.
   *
   * @param maxLosses maximum number of recent losses to include (default 5)
   * @returns human-readable string for LLM context injection
   */
  getLossReviewContext(maxLosses: number = 5): string {
    try {
      // Get recent entries that have a realised or simulated PnL
      const recent = this.entries.slice(-20); // last 20 entries
      const losses = recent.filter(e => {
        const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
        return pnl < 0;
      }).slice(-maxLosses); // most recent N losses

      if (losses.length === 0) {
        return '=== LOSS REVIEW ===\nNo recent losses to review.';
      }

      const lines: string[] = ['=== LOSS REVIEW (recent losing trades) ==='];
      for (const e of losses) {
        const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
        const action = e.decision.action.toUpperCase();
        const entryStr = e.entryPrice > 0 ? `$${e.entryPrice.toFixed(2)}` : 'N/A';
        const exitStr = e.exitPrice && e.exitPrice > 0 ? `$${e.exitPrice.toFixed(2)}` : 'N/A';
        const holdCycles = e.exitPrice ? Math.max(1, Math.round((Date.now() - e.timestamp) / 300_000)) : 1;
        const rationale = e.decision.rationale?.slice(0, 120) ?? 'N/A';

        lines.push(
          `  #${e.cycleNumber} ${action} ${e.symbol} | Entry ${entryStr} → Exit ${exitStr} | PnL ${(pnl * 100).toFixed(2)}% | ${e.regime}/${e.trend} | vol ${(e.volatility * 100).toFixed(1)}% | held ~${holdCycles} cycle(s)`,
          `    Reason: ${rationale}`,
        );
      }

      // Add current regime for comparison
      const lastEntry = this.entries[this.entries.length - 1];
      if (lastEntry) {
        lines.push(`\nCurrent regime: ${lastEntry.regime}/${lastEntry.trend} | vol ${(lastEntry.volatility * 100).toFixed(1)}%`);
      }

      lines.push(`\nReview each loss above: Was the direction wrong? Was the timing bad? Was the market choppy? Were the signals conflicting?`);
      lines.push(`Based on this analysis, decide: Has the market regime changed enough to resume trading? Or should the cooldown continue?`);

      return lines.join('\n');
    } catch {
      return '=== LOSS REVIEW ===\nUnable to build loss review context.';
    }
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

    // ─── Production-grade noise threshold ───
    // Noise = PnL below estimated round-trip trading cost.
    // Crypto perpetuals: taker fee ~0.05% × 2 (open+close) + slippage ~0.02% = ~0.12%
    // We use 0.00001 (0.001%) as a conservative floor.
    // With the new positionSizePct-based HOLD formula, typical PnLs are 0.002-0.01%,
    // well above this threshold. Only sub-basis-point noise is filtered.
    const NOISE_THRESHOLD = 0.00001;

    for (const e of this.entries) {
      const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
      // Skip entries with no PnL data (includes symbol-switch invalidated entries)
      if (pnl === 0 && e.realisedPnl === undefined && e.simulatedPnl === undefined) continue;
      // Skip truly zero-PnL entries (price didn't move)
      if (pnl === 0) continue;

      const isNoise = Math.abs(pnl) < NOISE_THRESHOLD;

      // ALL entries with non-zero PnL count as wins or losses (including simulated/exploration).
      // Rationale: preservation of capital IS a win. Breaking even = win.
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
  /**
   * Analyse the most recent N trades for directional churn + loss patterns.
   *
   * Detects "震盪市 churn": frequent direction reversals (buy→sell→buy) that
   * each lose money — a hallmark of a sideways/whipsaw market where trend-
   * following entries get stopped out repeatedly. The Independent Risk
   * Auditor uses this to decide whether new entries are advisable or whether
   * existing positions need wider TP/SL to survive the chop.
   *
   * Only counts trades with a meaningful PnL (realised or simulated); HOLD
   * entries with no directional action are excluded from the reversal count
   * but included in the sample size.
   */
  getRecentTradeAnalysis(n = 10): {
    sampleSize: number;
    directionalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netPnlPct: number;
    avgWinPct: number;
    avgLossPct: number;
    /** Number of direction reversals between consecutive directional trades. */
    reversals: number;
    /** reversals / directionalTrades — 1.0 = every trade flipped direction. */
    reversalRate: number;
    /** Losing streak length (most recent consecutive losses). */
    currentLossStreak: number;
    /** True if the recent pattern looks like choppy/whipsaw market. */
    isChoppy: boolean;
    /** Human-readable summary for agent context injection. */
    summary: string;
  } {
    const recent = this.getRecent(n);
    const directional = recent.filter(
      e => e.decision.action === 'buy' || e.decision.action === 'sell',
    );

    let wins = 0;
    let losses = 0;
    let netPnl = 0;
    let totalWin = 0;
    let totalLoss = 0;
    let reversals = 0;
    let prevAction: 'buy' | 'sell' | null = null;
    let currentLossStreak = 0;

    for (const e of directional) {
      const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
      netPnl += pnl;
      if (pnl > 0) {
        wins++;
        totalWin += pnl;
        currentLossStreak = 0;
      } else if (pnl < 0) {
        losses++;
        totalLoss += Math.abs(pnl);
        currentLossStreak++;
      }
      // Count direction reversals (buy→sell or sell→buy)
      const action = e.decision.action as 'buy' | 'sell';
      if (prevAction !== null && action !== prevAction) {
        reversals++;
      }
      if (pnl !== 0) prevAction = action; // only advance on real directional trades
    }

    const directionalCount = directional.length;
    const winRate = directionalCount > 0 ? wins / directionalCount : 0;
    const reversalRate = directionalCount > 1 ? reversals / (directionalCount - 1) : 0;
    const avgWinPct = wins > 0 ? totalWin / wins : 0;
    const avgLossPct = losses > 0 ? totalLoss / losses : 0;

    // Choppy market heuristic: high reversal rate + net negative + multiple losses.
    // Thresholds: ≥3 directional trades, ≥50% reversal rate, net loss, ≥2 losses.
    const isChoppy =
      directionalCount >= 3 &&
      reversalRate >= 0.5 &&
      netPnl < 0 &&
      losses >= 2;

    const summary = this.formatRecentTradeAnalysis({
      sampleSize: recent.length,
      directionalTrades: directionalCount,
      wins, losses, winRate, netPnlPct: netPnl, avgWinPct, avgLossPct,
      reversals, reversalRate, currentLossStreak, isChoppy,
    });

    return {
      sampleSize: recent.length,
      directionalTrades: directionalCount,
      wins, losses, winRate,
      netPnlPct: netPnl,
      avgWinPct, avgLossPct,
      reversals, reversalRate,
      currentLossStreak,
      isChoppy,
      summary,
    };
  }

  private formatRecentTradeAnalysis(a: {
    sampleSize: number;
    directionalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netPnlPct: number;
    avgWinPct: number;
    avgLossPct: number;
    reversals: number;
    reversalRate: number;
    currentLossStreak: number;
    isChoppy: boolean;
  }): string {
    const lines: string[] = ['=== RECENT TRADE PATTERN (last 10) ==='];
    lines.push(`Directional trades: ${a.directionalTrades} | Wins: ${a.wins} | Losses: ${a.losses} | Win rate: ${(a.winRate * 100).toFixed(0)}%`);
    lines.push(`Net PnL: ${(a.netPnlPct * 100).toFixed(2)}% | Avg win: +${(a.avgWinPct * 100).toFixed(2)}% | Avg loss: -${(a.avgLossPct * 100).toFixed(2)}%`);
    lines.push(`Direction reversals: ${a.reversals} (${(a.reversalRate * 100).toFixed(0)}% reversal rate) | Current loss streak: ${a.currentLossStreak}`);

    if (a.isChoppy) {
      lines.push(`⚠️ CHOPPY/WHIPSAW MARKET DETECTED: frequent buy→sell→buy reversals with net losses.`);
      lines.push(`  → Trend-following entries are getting stopped out repeatedly. Consider:`);
      lines.push(`  1. AVOIDING new entries until direction stabilises (HOLD)`);
      lines.push(`  2. WIDENING TP/SL on existing positions to survive the chop`);
      lines.push(`  3. REDUCING position size if entry is unavoidable`);
    } else if (a.directionalTrades >= 3 && a.winRate >= 0.6) {
      lines.push(`✅ Recent trades profitable — market conditions favour current strategy.`);
    } else if (a.directionalTrades < 3) {
      lines.push(`ℹ️ Insufficient directional trades for pattern analysis.`);
    } else {
      lines.push(`🟡 Mixed recent results — no strong choppy signal, exercise normal caution.`);
    }

    return lines.join('\n');
  }

  // v2.0.139: Aggregate portfolio metrics (winRate/Sharpe/totalReturn/profitFactor)
  // removed from agent context — they are global (not per-asset) and made agents
  // overly conservative when the all-time aggregate was poor, contributing to
  // "reluctant to trade" behaviour. Only recent INDIVIDUAL decisions remain
  // (per-trade context is signal, not a discouraging global score).
  getSummary(limit = 5): string {
    const recent = this.getRecent(limit);
    if (recent.length === 0) return '';
    let s = `=== Recent Trade Decisions ===\n`;
    for (const e of recent) {
      const pnl = e.realisedPnl ?? e.simulatedPnl ?? 0;
      s += `  #${e.cycleNumber} ${e.decision.action.toUpperCase()} (${(e.confidence * 100).toFixed(0)}%) → ${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(3)}%\n`;
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
