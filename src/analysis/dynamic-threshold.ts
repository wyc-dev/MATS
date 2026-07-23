// ═══════════════════════════════════════════════════════════════════════════
// v2.0.227: Dynamic Threshold Calculator — Plan G
// Replaces the additive penalty-on-threshold model with a unified multiplicative
// system. The entry threshold dynamically adjusts within [45%, 55%] based on 5
// objective performance factors with hysteresis. Penalties (loss-streak, conditional
// WR, combo WR) move from additive threshold raises to a multiplicative
// penaltyFactor with automatic decay — breaking the death spiral where penalties
// compound with P(win) discount to make trading mathematically impossible.
//
// ══ 公正計算 6 重保障 (6 Fairness Guarantees) ═════════════════════════════
//
// 1. Multi-factor balance: 5 independent factors, each ±2 points (±1%).
//    No single factor can dominate — to reach 55% ALL factors must be +2.
// 2. Symmetric design: good and bad performance have equal influence (±2).
// 3. Sample-size requirement: WR and Sharpe need ≥10 trades to score.
//    Insufficient samples → 0 points (neutral, no penalty).
// 4. Hysteresis: each factor has a buffer zone to prevent oscillation
//    at boundaries (e.g., WR=49.9% vs 50.1% won't flip the score).
// 5. Hard cap: totalScore clamped to [-10, +10] → threshold [45%, 55%].
//    Mathematical guarantee — can never exceed the range.
// 6. Fact-driven: all inputs are measured, settled outcomes — not predictions.
//
// ══ Complete Formula ═════════════════════════════════════════════════════
//
//   effectiveConfidence = consensus × pwinBlendFactor × penaltyFactor
//   dynamicThreshold     = 50% + (totalScore × 0.5%)  →  [45%, 55%]
//
//   if effectiveConfidence ≥ dynamicThreshold → TRADE
//   if effectiveConfidence < dynamicThreshold → HOLD
//
//   pwinBlendFactor = 0.3 + 0.7 × P(win)         (v2.0.224, preserved)
//   penaltyFactor   = 1.0 - min(decayedPenalty, 0.30)
//   decayedPenalty  = netPenalty × decayMultiplier
//   decayMultiplier = max(0, 1 - cyclesIdle / 30)  (full decay in 30 cycles)
//
// ═══════════════════════════════════════════════════════════════════════════

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'dynamic-threshold' });

// ─── Constants ─────────────────────────────────────────────────────────────

/** Base threshold — the neutral center point. */
const BASE_THRESHOLD = 0.50;
/** Minimum dynamic threshold. */
const THRESHOLD_FLOOR = 0.45;
/** Maximum dynamic threshold. */
const THRESHOLD_CEILING = 0.55;
/** Points-to-percentage multiplier: each score point = 0.5%. */
const POINT_WEIGHT = 0.005;
/** Maximum absolute score (10 points = 5%). */
const MAX_SCORE = 10;
/** Minimum samples for WR and Sharpe to be scored (else neutral). */
const MIN_SAMPLES = 10;
/** Penalty cap: penaltyFactor floor = 1.0 - 0.30 = 0.70. */
const PENALTY_CAP = 0.30;
/** Cycles for penalty to fully decay (linear). */
const PENALTY_DECAY_CYCLES = 30;
/** P(win) floor: blendFactor never drops below this. */
const PWIN_FLOOR = 0.3;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ThresholdFactorScore {
  factor: string;
  score: number; // [-2, +2]
  rawValue: number | string;
  reason: string;
}

export interface DynamicThresholdResult {
  /** Final threshold in [0.45, 0.55]. Compare effectiveConfidence against this. */
  threshold: number;
  /** Base threshold (always 0.50). */
  baseThreshold: number;
  /** Total score after capping [-10, +10]. */
  totalScore: number;
  /** Adjustment from base: totalScore × 0.5% → [-5%, +5%]. */
  adjustment: number;
  /** Multiplicative penalty factor [0.70, 1.0]. */
  penaltyFactor: number;
  /** Raw net penalty from 3 gates before decay. */
  netPenalty: number;
  /** Penalty after idle-based decay. */
  decayedPenalty: number;
  /** Decay multiplier [0, 1] based on idle cycles. */
  decayMultiplier: number;
  /** Per-factor breakdown for logging/UI. */
  factors: ThresholdFactorScore[];
}

export interface DynamicThresholdInput {
  /** Rolling win rate from last N trades [0, 1]. */
  rollingWR: number;
  /** Number of trades in the rolling window. */
  wrSampleCount: number;
  /** Cycles without a real trade (idle counter). */
  idleCycles: number;
  /** Current portfolio drawdown as a fraction [0, 1]. */
  drawdownPct: number;
  /** Rolling Sharpe ratio from last N trades. */
  rollingSharpe: number;
  /** Number of trades in the Sharpe window. */
  sharpeSampleCount: number;
  /** Current market regime string. */
  regime: string;
  /** Net penalty from loss-streak + conditional WR + combo WR gates [0, 1+]. */
  netPenalty: number;
}

// ─── Hysteresis Scoring ────────────────────────────────────────────────────
//
// Each factor uses a state machine: the current score determines the thresholds
// for raising or lowering. This creates a buffer zone where small fluctuations
// don't cause score flips.
//
// General hysteresis pattern for a [-2, +2] factor with thresholds T_-2, T_-1,
// T_0, T_+1, T_+2:
//
//   current=0:  raise to +1 when value < T_0_to_+1, lower to -1 when value > T_0_to_-1
//   current=+1: raise to +2 when value < T_+1_to_+2, lower to 0 when value > T_+1_to_0
//   current=+2: lower to +1 when value > T_+2_to_+1
//   current=-1: lower to -2 when value > T_-1_to_-2, raise to 0 when value < T_-1_to_0
//   current=-2: raise to -1 when value < T_-2_to_-1
//
// The raise thresholds are STRICTER than the lower thresholds, creating
// a dead-zone that prevents oscillation.

/**
 * Score the Rolling WR factor with hysteresis.
 * WR ≥ 55% → -2 (great, relax), 40-55% → 0 (neutral), < 35% → +2 (terrible, tighten).
 */
function scoreRollingWR(
  wr: number,
  sampleCount: number,
  current: number,
): { score: number; reason: string } {
  if (sampleCount < MIN_SAMPLES) return { score: 0, reason: `neutral (samples ${sampleCount} < ${MIN_SAMPLES})` };
  const pct = (wr * 100).toFixed(1);

  switch (current) {
    case 0:
      if (wr < 0.42) return { score: 1, reason: `WR ${pct}% < 42% → tighten` };
      if (wr > 0.55) return { score: -1, reason: `WR ${pct}% > 55% → relax` };
      return { score: 0, reason: `WR ${pct}% in neutral band` };
    case 1:
      if (wr < 0.35) return { score: 2, reason: `WR ${pct}% < 35% → tighten hard` };
      if (wr > 0.48) return { score: 0, reason: `WR ${pct}% recovered > 48% → neutral` };
      return { score: 1, reason: `WR ${pct}% still below 48%` };
    case 2:
      if (wr > 0.45) return { score: 1, reason: `WR ${pct}% recovering > 45% → less tight` };
      return { score: 2, reason: `WR ${pct}% still < 45% → max tight` };
    case -1:
      if (wr < 0.45) return { score: 0, reason: `WR ${pct}% dropped < 45% → neutral` };
      if (wr > 0.60) return { score: -2, reason: `WR ${pct}% > 60% → max relax` };
      return { score: -1, reason: `WR ${pct}% still > 45%` };
    case -2:
      if (wr < 0.50) return { score: -1, reason: `WR ${pct}% dropped < 50% → less relax` };
      return { score: -2, reason: `WR ${pct}% still > 50% → max relax` };
    default:
      return { score: 0, reason: `WR ${pct}% (unknown state)` };
  }
}

/**
 * Score the Idle Cycles factor with hysteresis.
 * ≥ 20 cycles idle → -2 (relax, self-recovery), 5-20 → 0 (neutral), < 2 → +2 (overtrading risk).
 */
function scoreIdleCycles(
  idle: number,
  current: number,
): { score: number; reason: string } {
  switch (current) {
    case 0:
      if (idle >= 20) return { score: -2, reason: `idle ${idle} ≥ 20 → relax (self-recovery)` };
      if (idle < 2) return { score: 2, reason: `idle ${idle} < 2 → overtrading risk` };
      return { score: 0, reason: `idle ${idle} in neutral band` };
    case -1:
      if (idle >= 20) return { score: -2, reason: `idle ${idle} ≥ 20 → max relax` };
      if (idle < 10) return { score: 0, reason: `idle ${idle} recovered < 10 → neutral` };
      return { score: -1, reason: `idle ${idle} still ≥ 10` };
    case -2:
      if (idle < 10) return { score: 0, reason: `idle ${idle} recovered < 10 → neutral` };
      return { score: -2, reason: `idle ${idle} still ≥ 10 → max relax` };
    case 1:
      if (idle < 2) return { score: 2, reason: `idle ${idle} < 2 → max tighten (overtrading)` };
      if (idle >= 5) return { score: 0, reason: `idle ${idle} recovered ≥ 5 → neutral` };
      return { score: 1, reason: `idle ${idle} still < 5` };
    case 2:
      if (idle >= 5) return { score: 0, reason: `idle ${idle} recovered ≥ 5 → neutral` };
      return { score: 2, reason: `idle ${idle} still < 5 → max tight` };
    default:
      return { score: 0, reason: `idle ${idle} (unknown state)` };
  }
}

/**
 * Score the Drawdown factor with hysteresis.
 * < 3% → -2 (low risk, relax), 3-10% → 0 (neutral), > 15% → +2 (protect capital).
 */
function scoreDrawdown(
  dd: number,
  current: number,
): { score: number; reason: string } {
  const pct = (dd * 100).toFixed(1);
  switch (current) {
    case 0:
      if (dd > 0.10) return { score: 1, reason: `drawdown ${pct}% > 10% → tighten` };
      if (dd < 0.03) return { score: -1, reason: `drawdown ${pct}% < 3% → relax` };
      return { score: 0, reason: `drawdown ${pct}% neutral` };
    case 1:
      if (dd > 0.15) return { score: 2, reason: `drawdown ${pct}% > 15% → max tighten` };
      if (dd < 0.05) return { score: 0, reason: `drawdown ${pct}% recovered < 5% → neutral` };
      return { score: 1, reason: `drawdown ${pct}% still > 5%` };
    case 2:
      if (dd < 0.10) return { score: 1, reason: `drawdown ${pct}% recovering < 10% → less tight` };
      return { score: 2, reason: `drawdown ${pct}% still > 10% → max tight` };
    case -1:
      if (dd > 0.05) return { score: 0, reason: `drawdown ${pct}% rose > 5% → neutral` };
      if (dd < 0.01) return { score: -2, reason: `drawdown ${pct}% < 1% → max relax` };
      return { score: -1, reason: `drawdown ${pct}% still < 5%` };
    case -2:
      if (dd > 0.03) return { score: -1, reason: `drawdown ${pct}% rose > 3% → less relax` };
      return { score: -2, reason: `drawdown ${pct}% still < 3% → max relax` };
    default:
      return { score: 0, reason: `drawdown ${pct}% (unknown state)` };
  }
}

/**
 * Score the Rolling Sharpe factor with hysteresis.
 * > 1.5 → -2 (excellent risk-adjusted return), 0-1.0 → 0 (neutral), < -1.0 → +2 (terrible).
 */
function scoreSharpe(
  sharpe: number,
  sampleCount: number,
  current: number,
): { score: number; reason: string } {
  if (sampleCount < MIN_SAMPLES) return { score: 0, reason: `neutral (samples ${sampleCount} < ${MIN_SAMPLES})` };
  const s = sharpe.toFixed(2);
  switch (current) {
    case 0:
      if (sharpe < 0) return { score: 1, reason: `Sharpe ${s} < 0 → tighten` };
      if (sharpe > 1.0) return { score: -1, reason: `Sharpe ${s} > 1.0 → relax` };
      return { score: 0, reason: `Sharpe ${s} neutral` };
    case 1:
      if (sharpe < -1.0) return { score: 2, reason: `Sharpe ${s} < -1.0 → max tighten` };
      if (sharpe > 0.5) return { score: 0, reason: `Sharpe ${s} recovered > 0.5 → neutral` };
      return { score: 1, reason: `Sharpe ${s} still < 0.5` };
    case 2:
      if (sharpe > -0.5) return { score: 1, reason: `Sharpe ${s} recovering > -0.5 → less tight` };
      return { score: 2, reason: `Sharpe ${s} still < -0.5 → max tight` };
    case -1:
      if (sharpe < 0.5) return { score: 0, reason: `Sharpe ${s} dropped < 0.5 → neutral` };
      if (sharpe > 1.5) return { score: -2, reason: `Sharpe ${s} > 1.5 → max relax` };
      return { score: -1, reason: `Sharpe ${s} still > 0.5` };
    case -2:
      if (sharpe < 1.0) return { score: -1, reason: `Sharpe ${s} dropped < 1.0 → less relax` };
      return { score: -2, reason: `Sharpe ${s} still > 1.0 → max relax` };
    default:
      return { score: 0, reason: `Sharpe ${s} (unknown state)` };
  }
}

/**
 * Score the Regime factor with hysteresis.
 * trending → -2 (clean signals, relax), normal/mean_reverting → 0, chaotic → +2 (tighten).
 */
function scoreRegime(
  regime: string,
  current: number,
): { score: number; reason: string } {
  const r = regime || 'unknown';
  switch (current) {
    case 0:
      if (r === 'trending' || r === 'breakout') return { score: -1, reason: `regime '${r}' → relax` };
      if (r === 'chaotic' || r === 'unknown') return { score: 1, reason: `regime '${r}' → tighten` };
      return { score: 0, reason: `regime '${r}' neutral` };
    case -1:
      if (r === 'trending' || r === 'breakout') return { score: -2, reason: `regime '${r}' → max relax` };
      if (r !== 'bull' && r !== 'bear') return { score: 0, reason: `regime '${r}' → neutral` };
      return { score: -1, reason: `regime '${r}' still favorable` };
    case -2:
      if (r !== 'trending' && r !== 'breakout') return { score: -1, reason: `regime '${r}' → less relax` };
      return { score: -2, reason: `regime '${r}' still trending → max relax` };
    case 1:
      if (r === 'chaotic' || r === 'unknown') return { score: 2, reason: `regime '${r}' → max tighten` };
      if (r !== 'high_volatility') return { score: 0, reason: `regime '${r}' → neutral` };
      return { score: 1, reason: `regime '${r}' still adverse` };
    case 2:
      if (r !== 'chaotic' && r !== 'unknown') return { score: 1, reason: `regime '${r}' → less tight` };
      return { score: 2, reason: `regime '${r}' still chaotic → max tight` };
    default:
      return { score: 0, reason: `regime '${r}' (unknown state)` };
  }
}

// ─── Calculator ────────────────────────────────────────────────────────────

/**
 * v2.0.227: Dynamic Threshold Calculator — Plan G.
 *
 * Maintains hysteresis state across calls. Each call updates the 5 factor
 * scores based on current inputs, computes the total score, maps it to a
 * threshold [45%, 55%], and computes the multiplicative penaltyFactor with
 * idle-based decay.
 *
 * Lifecycle: create one instance, call compute() every cycle with fresh inputs.
 */
export class DynamicThresholdCalculator {
  // Hysteresis state: each factor remembers its current score [-2, +2]
  private wrScore = 0;
  private idleScore = 0;
  private drawdownScore = 0;
  private sharpeScore = 0;
  private regimeScore = 0;

  // Last computed result (for inspection / logging)
  private lastResult: DynamicThresholdResult | null = null;

  /**
   * Compute the dynamic threshold and penalty factor.
   * Call once per cycle with fresh inputs.
   */
  compute(input: DynamicThresholdInput): DynamicThresholdResult {
    // 1. Score each factor with hysteresis
    const wrRes = scoreRollingWR(input.rollingWR, input.wrSampleCount, this.wrScore);
    const idleRes = scoreIdleCycles(input.idleCycles, this.idleScore);
    const ddRes = scoreDrawdown(input.drawdownPct, this.drawdownScore);
    const sharpeRes = scoreSharpe(input.rollingSharpe, input.sharpeSampleCount, this.sharpeScore);
    const regimeRes = scoreRegime(input.regime, this.regimeScore);

    // Update hysteresis state
    this.wrScore = wrRes.score;
    this.idleScore = idleRes.score;
    this.drawdownScore = ddRes.score;
    this.sharpeScore = sharpeRes.score;
    this.regimeScore = regimeRes.score;

    // 2. Sum and cap
    const rawScore = this.wrScore + this.idleScore + this.drawdownScore + this.sharpeScore + this.regimeScore;
    const totalScore = Math.max(-MAX_SCORE, Math.min(MAX_SCORE, rawScore));

    // 3. Map to threshold
    const adjustment = totalScore * POINT_WEIGHT;
    const threshold = Math.max(THRESHOLD_FLOOR, Math.min(THRESHOLD_CEILING, BASE_THRESHOLD + adjustment));

    // 4. Penalty decay: linear decay over PENALTY_DECAY_CYCLES
    //    Safe-num all inputs to prevent NaN propagation.
    const safeIdle = Number.isFinite(input.idleCycles) ? input.idleCycles : 0;
    const safePenalty = Number.isFinite(input.netPenalty) ? input.netPenalty : 0;
    const decayMultiplier = Math.max(0, 1 - safeIdle / PENALTY_DECAY_CYCLES);
    const decayedPenalty = safePenalty * decayMultiplier;
    const penaltyFactor = 1.0 - Math.min(decayedPenalty, PENALTY_CAP);

    // 5. Build result
    const result: DynamicThresholdResult = {
      threshold,
      baseThreshold: BASE_THRESHOLD,
      totalScore,
      adjustment,
      penaltyFactor,
      netPenalty: safePenalty,
      decayedPenalty,
      decayMultiplier,
      factors: [
        { factor: 'rollingWR', score: this.wrScore, rawValue: input.rollingWR, reason: wrRes.reason },
        { factor: 'idleCycles', score: this.idleScore, rawValue: input.idleCycles, reason: idleRes.reason },
        { factor: 'drawdown', score: this.drawdownScore, rawValue: input.drawdownPct, reason: ddRes.reason },
        { factor: 'sharpe', score: this.sharpeScore, rawValue: input.rollingSharpe, reason: sharpeRes.reason },
        { factor: 'regime', score: this.regimeScore, rawValue: input.regime, reason: regimeRes.reason },
      ],
    };

    this.lastResult = result;

    log.info(`[Plan-G] threshold=${(threshold * 100).toFixed(1)}% (score=${totalScore > 0 ? '+' : ''}${totalScore}, adj=${(adjustment * 100).toFixed(1)}%), penaltyFactor=${penaltyFactor.toFixed(3)} (net=${(input.netPenalty * 100).toFixed(0)}%, decay=${(decayMultiplier * 100).toFixed(0)}%)`);

    return result;
  }

  /** Get the last computed result (null if compute() hasn't been called). */
  getLastResult(): DynamicThresholdResult | null {
    return this.lastResult;
  }

  /**
   * Compute the P(win) blend factor (v2.0.224, preserved).
   * pwinBlendFactor = pwinFloor + (1 - pwinFloor) × P(win)
   */
  static pwinBlendFactor(pwin: number): number {
    return PWIN_FLOOR + (1 - PWIN_FLOOR) * pwin;
  }

  /**
   * Compute the final effective confidence: consensus × pwinBlend × penaltyFactor.
   * This is the single value compared against the dynamic threshold.
   */
  static effectiveConfidence(
    consensus: number,
    pwin: number,
    penaltyFactor: number,
  ): number {
    const blend = DynamicThresholdCalculator.pwinBlendFactor(pwin);
    return consensus * blend * penaltyFactor;
  }

  /** Reset all hysteresis state (for testing). */
  reset(): void {
    this.wrScore = 0;
    this.idleScore = 0;
    this.drawdownScore = 0;
    this.sharpeScore = 0;
    this.regimeScore = 0;
    this.lastResult = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Safe number: replace NaN/Infinity/null/undefined with fallback. */
export function safeNum(val: unknown, fallback = 0): number {
  const n = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(n) ? n : fallback;
}