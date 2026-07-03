// ─── Agent Outcome Tracker (v1.9.3) ───
// Per-agent, per-symbol, per-regime outcome tracking.
// Records what each agent recommended for EACH symbol and whether it was RIGHT.
// Enables learning: "Fractal Momentum is wrong 80% of the time in HIGH_VOL"

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import type { AgentRole, AgentOutcomeRecord, AgentPerformanceSnapshot, MultiSymbolDecision, MarketRegime, PerSymbolDecision } from '../types/index.ts';

const log = createLogger({ phase: 'agent-outcomes' });

export class AgentOutcomeTracker {
  private records: AgentOutcomeRecord[] = [];
  private readonly maxRecords = 10_000;
  /** v2.0.38: Only the most recent N records per agent+symbol+regime are
   *  used to compute winRate. Old records naturally fade out as new trades
   *  come in — the system adapts to the current regime instead of being
   *  anchored to stale data from a completely different market phase. */
  private readonly recentWindowForPerformance = 50;

  /** Load from persisted state */
  load(records: AgentOutcomeRecord[]): void {
    this.records = records.slice(-this.maxRecords);
    log.info(`AgentOutcomeTracker loaded: ${this.records.length} records`);
  }

  /**
   * Get session-level win rates for ALL agents with outcome data.
   * Returns { agentRole: winRate } — winRate = -1 means no trades yet.
   * Used by SystemGuard to detect underperforming agents.
   */
  getAllAgentWinRates(): Record<string, number> {
    try {
      const result: Record<string, number> = {};
      const agentGroups = new Map<string, { wins: number; total: number }>();

      for (const r of this.records) {
        if (!r.outcome || r.outcome === 'pending') continue;
        if (!agentGroups.has(r.agentRole)) {
          agentGroups.set(r.agentRole, { wins: 0, total: 0 });
        }
        const group = agentGroups.get(r.agentRole)!;
        group.total++;
        if (r.outcome === 'win') group.wins++;
      }

      for (const [role, stats] of agentGroups) {
        result[role] = stats.total > 0 ? stats.wins / stats.total : -1;
      }

      return result;
    } catch (err) {
      log.error(`getAllAgentWinRates failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /** Clear all records */
  clear(): void {
    this.records = [];
    log.info('AgentOutcomeTracker cleared');
  }

  getAllRecords(): AgentOutcomeRecord[] {
    return [...this.records];
  }

  /** Record what EACH agent recommended for EACH symbol this cycle */
  recordCycle(
    cycleNumber: number,
    allAgentDecisions: Array<{
      agentRole: AgentRole;
      multiSymbolDecision: MultiSymbolDecision;
      confidence: number;
    }>,
    currentRegime: MarketRegime,
  ): void {
    for (const agent of allAgentDecisions) {
      const { agentRole, multiSymbolDecision, confidence } = agent;

      // Market ticker recommendation
      const mt = multiSymbolDecision.marketTicker;
      this.addRecord({
        cycleNumber,
        agentRole,
        symbol: mt.symbol,
        recommendedAction: mt.action,
        confidence,
        isPositionRecommendation: false,
        regime: currentRegime,
      });

      // Per-position recommendations (includes trading markets without position)
      for (const pos of multiSymbolDecision.positions) {
        this.addRecord({
          cycleNumber,
          agentRole,
          symbol: pos.symbol,
          recommendedAction: pos.closePosition ? 'close' : (pos.action === 'buy' || pos.action === 'sell' ? pos.action : 'hold'),
          confidence,
          isPositionRecommendation: true,
          regime: currentRegime,
        });
      }
    }

    log.info(`Agent outcomes recorded: ${allAgentDecisions.length} agents × decisions for cycle ${cycleNumber}`);
  }

  /** After a position closes, backfill the outcome for all agents that recommended on it */
  backfillOutcome(symbol: string, closePnlPct: number): void {
    const isWin = closePnlPct >= 0;
    for (const r of this.records) {
      if (r.symbol === symbol && !r.outcome) {
        r.outcome = isWin ? 'win' : 'loss';
        r.pnlPct = closePnlPct;
      }
    }
    log.info(`Backfilled outcome for ${symbol}: ${isWin ? 'WIN' : 'LOSS'} (${(closePnlPct * 100).toFixed(2)}%)`);
  }

  /** Get performance snapshot for a specific agent + symbol + regime combo.
   *  v2.0.38: Only uses the most recent `recentWindowForPerformance` records
   *  (default 50) after filtering by agent+symbol+regime. This prevents stale
   *  data from a completely different market phase from permanently anchoring
   *  the winRate. Old records naturally fade as new trades come in. */
  getAgentPerformance(
    agentRole: AgentRole,
    symbol?: string,
    regime?: MarketRegime,
  ): AgentPerformanceSnapshot {
    let filtered = this.records.filter(r => r.agentRole === agentRole && r.outcome && r.outcome !== 'pending');
    if (symbol) filtered = filtered.filter(r => r.symbol === symbol);
    if (regime) filtered = filtered.filter(r => r.regime === regime);

    // v2.0.38: Only use the most recent N records — old records fade out
    const recent = filtered.slice(-this.recentWindowForPerformance);

    const wins = recent.filter(r => r.outcome === 'win').length;
    const total = recent.length;
    const avgConf = total > 0 ? recent.reduce((s, r) => s + r.confidence, 0) / total : 0;
    const skepticismCount = recent.filter(r => r.confidence < 0.3).length;

    return {
      agentRole,
      symbol: symbol ?? 'all',
      regime: regime ?? 'unknown' as MarketRegime,
      totalDecisions: total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? wins / total : 0,
      avgConfidence: avgConf,
      skepticismRate: total > 0 ? skepticismCount / total : 0,
    };
  }

  /** Get a concise summary string for injection into agent context */
  getContextSummary(agentRole: AgentRole, limit = 5): string {
    const recentRecords = this.records
      .filter(r => r.agentRole === agentRole && r.outcome)
      .slice(-limit);

    if (recentRecords.length === 0) {
      return `  [${agentRole}] No outcome history yet.`;
    }

    const wins = recentRecords.filter(r => r.outcome === 'win').length;
    const lines = recentRecords.map(r =>
      `  ${r.symbol} | ${r.recommendedAction} | ${r.outcome === 'win' ? '✅' : '❌'} | conf=${(r.confidence * 100).toFixed(0)}% | ${r.regime}`
    );

    return `  [${agentRole}] ${wins}/${recentRecords.length} wins (${((wins / recentRecords.length) * 100).toFixed(0)}%) last ${limit}:\n${lines.join('\n')}`;
  }

  private addRecord(data: Omit<AgentOutcomeRecord, 'id' | 'timestamp'>): void {
    const record: AgentOutcomeRecord = {
      ...data,
      id: uuidv4(),
      timestamp: Date.now(),
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }
}