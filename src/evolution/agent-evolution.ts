// ─── Agent Evolution Engine (v2.0.15) ───
// Dynamically adjusts each agent's voting weight based on its per-regime
// win rate, so agents that perform well in the CURRENT market regime get
// more influence in HACP consensus, and underperforming agents get less.
//
// Previously, agent weights were hardcoded (0.20-0.35) and never changed —
// a Fractal Momentum agent that was wrong 80% of the time in high-volatility
// regimes still voted with full weight. This engine closes that loop:
// AgentOutcomeTracker records outcomes → AgentEvolutionEngine reads them →
// HACP consensus uses the dynamic weight.
//
// Design:
//  - Base weight = the agent's hardcoded identity weight (never goes to 0).
//  - Dynamic weight = baseWeight × regimePerformanceMultiplier.
//  - regimePerformanceMultiplier = clamp(0.5 + (winRate - 0.5) × 2, 0.5, 1.5)
//    → winRate 0.5 = neutral (×1.0), 0.8 = ×1.6 (capped 1.5), 0.2 = ×0.7 (floored 0.5).
//  - EMA smoothing (alpha=0.3) prevents single-trade weight swings.
//  - Requires ≥ minSamples (5) outcomes in the regime before adjusting;
//    below that, returns the base weight (no penalty for small samples).

import { createLogger } from '../observability/logger.ts';
import type { AgentRole, MarketRegime } from '../types/index.ts';
import type { AgentOutcomeTracker } from './agent-outcomes.ts';
import type { NumericEmbedProvider } from './numeric-autoencoder.ts';
import { computeVectorConditionalWinRate } from './evolution-utils.ts';

const log = createLogger({ phase: 'agent-evolution' });

/** Minimum outcome samples in a regime before dynamic weighting kicks in. */
const MIN_SAMPLES_FOR_ADJUSTMENT = 5;
/** EMA smoothing factor for weight updates (higher = faster adaptation). */
const WEIGHT_EMA_ALPHA = 0.3;
/** Multiplier floor/ceiling around the base weight. */
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 1.5;

export class AgentEvolutionEngine {
  /** v2.0.206 (#8): NA provider — when ready + currentFeatures provided,
   *  updateMultiplier uses conditional WR (agent perf in similar market conditions)
   *  instead of raw win rate. Falls back to raw WR during cold-start. */
  private naEmbeddingProvider: NumericEmbedProvider | null = null;
  setNaEmbeddingProvider(p: NumericEmbedProvider | null): void { this.naEmbeddingProvider = p; }
  /** EMA-smoothed multiplier per (role, regime) — persists across cycles. */
  private multipliers = new Map<string, number>();
  private readonly outcomeTracker: AgentOutcomeTracker;
  /** Base weights per role (from agent identities, set at init). */
  private baseWeights = new Map<AgentRole, number>();

  constructor(outcomeTracker: AgentOutcomeTracker) {
    this.outcomeTracker = outcomeTracker;
  }

  /** Register an agent's hardcoded base weight (called once at startup). */
  registerBaseWeight(role: AgentRole, weight: number): void {
    this.baseWeights.set(role, weight);
  }

  /**
   * Get the dynamic voting weight for an agent in the current regime.
   * Falls back to the base weight when there's insufficient outcome data.
   */
  getDynamicWeight(role: AgentRole, regime: MarketRegime): number {
    const base = this.baseWeights.get(role);
    if (base === undefined) return 0.25; // unknown agent — neutral fallback

    const key = this.key(role, regime);
    const smoothed = this.multipliers.get(key);
    if (smoothed === undefined) return base; // no adjustment yet

    return base * smoothed;
  }

  /**
   * Recompute multipliers from the outcome tracker and EMA-smooth them.
   * Call this once per HACP cycle (after outcomes are backfilled).
   *
   * @param currentRegime the active market regime (for logging context)
   */
  updateWeights(currentRegime: MarketRegime, /** v2.0.206 (#8): current cycle
   *  market features — when provided + NA ready, agent multipliers use conditional
   *  WR (performance in similar market conditions) instead of raw win rate. */
    currentFeatures?: Record<string, number>,
  ): void {
    try {
      // Collect all roles that have base weights registered
      for (const role of this.baseWeights.keys()) {
        // Update the multiplier for the current regime (most relevant).
        // Other regimes keep their last-smoothed value (they'll update when
        // the market shifts back to them).
        this.updateMultiplier(role, currentRegime, currentFeatures);
      }
    } catch (err) {
      log.error(`[updateWeights] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private updateMultiplier(role: AgentRole, regime: MarketRegime, currentFeatures?: Record<string, number>): void {
    const perf = this.outcomeTracker.getAgentPerformance(role, undefined, regime);
    // Need enough samples to trust the win rate; otherwise leave the base weight.
    if (perf.totalDecisions < MIN_SAMPLES_FOR_ADJUSTMENT) return;

    // v2.0.206 (#8): Use conditional WR (agent performance in similar MARKET
    // CONDITIONS) instead of raw win rate. Raw WR conflates regimes — an agent
    // that wins 80% in trending_bull but 20% in high_volatility looks "50%" raw.
    // Conditional WR isolates "how does this agent do WHEN the market looks like
    // RIGHT NOW?". Falls back to raw WR when NA not ready or no features / no
    // records with marketFeatures.
    let effectiveWinRate = perf.winRate;
    let wrSource = 'raw';
    if (this.naEmbeddingProvider && currentFeatures && Object.keys(currentFeatures).length > 0) {
      try {
        const allRecords = this.outcomeTracker.getAllRecords();
        const recs = allRecords
          .filter(r => r.agentRole === role && r.regime === regime && r.outcome && r.outcome !== 'pending'
            && (r.recommendedAction === 'buy' || r.recommendedAction === 'sell')
            && r.marketFeatures && Object.keys(r.marketFeatures).length > 0)
          .map(r => ({
            marketFeatures: r.marketFeatures!,
            outcome: r.outcome === 'win' ? 'WIN' : 'LOSS',
            symbol: r.symbol,
            side: r.recommendedAction as 'buy' | 'sell',
            pnl: r.pnlPct ?? (r.outcome === 'win' ? 1 : -1),
          }));
        if (recs.length >= MIN_SAMPLES_FOR_ADJUSTMENT) {
          const cond = computeVectorConditionalWinRate(
            currentFeatures,
            recs,
            { minSamples: MIN_SAMPLES_FOR_ADJUSTMENT, threshold: 0.75, topN: 20, embeddingProvider: this.naEmbeddingProvider ?? undefined },
          );
          if (cond.confidence !== 'none' && cond.sampleSize >= MIN_SAMPLES_FOR_ADJUSTMENT) {
            effectiveWinRate = cond.conditionalWinRate;
            wrSource = 'conditional';
          }
        }
      } catch (err) {
        log.warn(`[agent-evolution] conditional WR failed for ${role}@${regime}: ${err instanceof Error ? err.message : String(err)} — using raw WR`);
      }
    }

    // Map win rate to a multiplier around 1.0.
    // winRate 0.5 → ×1.0 (neutral), 0.8 → ×1.6 (capped 1.5), 0.2 → ×0.7 (floored 0.5).
    const rawMultiplier = Math.max(
      MIN_MULTIPLIER,
      Math.min(MAX_MULTIPLIER, 0.5 + (effectiveWinRate - 0.5) * 2),
    );

    const key = this.key(role, regime);
    const prev = this.multipliers.get(key);
    // EMA smoothing: new = alpha*raw + (1-alpha)*prev
    const smoothed = prev === undefined
      ? rawMultiplier
      : WEIGHT_EMA_ALPHA * rawMultiplier + (1 - WEIGHT_EMA_ALPHA) * prev;
    this.multipliers.set(key, smoothed);

    // Log only when the multiplier meaningfully changes (>5% delta from prev)
    if (prev === undefined || Math.abs(smoothed - prev) > 0.05) {
      log.info(
        `🧬 agent weight: ${role} @ ${regime} ${wrSource}WR=${(effectiveWinRate * 100).toFixed(0)}% (n=${perf.totalDecisions}) → ×${smoothed.toFixed(2)} (base ${(this.baseWeights.get(role) ?? 0).toFixed(2)} → dyn ${(this.baseWeights.get(role)! * smoothed).toFixed(2)})`,
      );
    }
  }

  /** Get a human-readable summary of current dynamic weights (for API/UI). */
  getWeightSummary(regime: MarketRegime): Array<{ role: AgentRole; baseWeight: number; dynamicWeight: number; multiplier: number; winRate: number; samples: number }> {
    const result: Array<{ role: AgentRole; baseWeight: number; dynamicWeight: number; multiplier: number; winRate: number; samples: number }> = [];
    for (const role of this.baseWeights.keys()) {
      const base = this.baseWeights.get(role) ?? 0.25;
      const key = this.key(role, regime);
      const multiplier = this.multipliers.get(key) ?? 1.0;
      const perf = this.outcomeTracker.getAgentPerformance(role, undefined, regime);
      result.push({
        role,
        baseWeight: base,
        dynamicWeight: base * multiplier,
        multiplier,
        winRate: perf.winRate,
        samples: perf.totalDecisions,
      });
    }
    return result;
  }

  /** Serialize for persistence (restore across restarts). */
  serialize(): Record<string, number> {
    const obj: Record<string, number> = {};
    for (const [k, v] of this.multipliers) obj[k] = v;
    return obj;
  }

  /** Restore from persisted state. */
  deserialize(data: Record<string, number>): void {
    this.multipliers.clear();
    for (const [k, v] of Object.entries(data)) this.multipliers.set(k, v);
    log.info(`AgentEvolutionEngine restored: ${this.multipliers.size} multipliers`);
  }

  private key(role: AgentRole, regime: MarketRegime): string {
    return `${role}|${regime}`;
  }
}