// ─── Meta-Cognitive Calibrator (v2.0.837) ─────────────────────────────
//
// The system's SELF-AWARENESS layer. Tracks how well the system's P(win)
// predictions and conviction match actual outcomes, then feeds that
// calibration data back into the HACP decision context so Meta-Agent
// can self-correct.
//
// Architecture:
//   1. recordTrade(predictedPWin, conviction, regime, outcome)
//      → called on every trade close
//   2. Brier score (overall + per-regime) — lower = better
//   3. ECE (Expected Calibration Error) — 0 = perfect, >0.15 = significant
//   4. 10-bin reliability diagram (predicted → actual win rate)
//   5. getCalibrationBlock() → injected into HACP prompt
//   6. getConfidenceAdjustment(regime) → Meta-Agent can dampen conviction
//
// Cold-start safe: < 20 trades → returns neutral (no adjustment).
// Fail-open: all methods non-throwing, safe on NaN/Infinity inputs.
//
// Theory:
//   Brier = (1/N) Σ (fᵢ - oᵢ)² — standard probabilistic prediction metric
//   ECE = Σ (nᵦ/N) |acc(b) - conf(b)| — calibration gap weighted by bin size
//
// References:
//   Brier, G.W. (1950). "Verification of forecasts expressed in terms of
//     probability." Monthly Weather Review.
//   Guo, C. et al. (2017). "On Calibration of Modern Neural Networks."
//     ICML — introduced ECE as a practical calibration metric.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'meta-calibrator' });

// ─── Types ───

interface CalibrationSample {
  predictedPWin: number;     // HACP consensus P(win) at entry (from entryOlrPWin)
  conviction: number;         // Meta-Agent conviction at entry (consensus.confidence)
  regime: string;             // entry-time regime
  outcome: 0 | 1;             // actual win(1) / loss(0)
  ts: number;
}

export interface CalibrationStats {
  totalSamples: number;
  brier: number;
  ece: number;
  regimeBrier: Array<{ regime: string; brier: number; samples: number }>;
  bins: Array<{ lo: number; hi: number; wins: number; losses: number; actualWR: number }>;
}

interface Bin {
  lo: number;
  hi: number;
  wins: number;
  losses: number;
}

// ─── Constants ───

const NUM_BINS = 10;
const MIN_SAMPLES_FOR_OUTPUT = 20;
const MIN_SAMPLES_PER_BIN = 5;
const MIN_SAMPLES_PER_REGIME = 20;
const MAX_SAMPLES = 500;
const BRIER_RANDOM = 0.25;   // Brier for always predicting 0.5
const ECE_WARNING_THRESHOLD = 0.15;

// ─── Meta-Cognitive Calibrator ───

export class MetaCalibrator {
  private samples: CalibrationSample[] = [];

  // Per-regime Brier score (EMA update)
  private regimeBrier: Map<string, number> = new Map();
  private regimeSampleCount: Map<string, number> = new Map();

  // 10-bin reliability diagram
  private bins: Bin[] = [];

  constructor() {
    for (let i = 0; i < NUM_BINS; i++) {
      this.bins.push({
        lo: i / NUM_BINS,
        hi: (i + 1) / NUM_BINS,
        wins: 0,
        losses: 0,
      });
    }
  }

  /**
   * Record a completed trade outcome.
   * Called from onPositionClosedLearning in index.ts.
   *
   * @param predictedPWin  OLR P(win) at entry time (trade.entryOlrPWin)
   * @param conviction     HACP consensus confidence at entry time
   * @param regime         Market regime at entry time (trade.regime)
   * @param outcome        1 = win, 0 = loss
   */
  recordTrade(
    predictedPWin: number,
    conviction: number,
    regime: string,
    outcome: 0 | 1,
  ): void {
    // Guard against invalid inputs — never crash the cycle
    if (!Number.isFinite(predictedPWin) || !Number.isFinite(conviction)) return;
    if (outcome !== 0 && outcome !== 1) return;
    if (typeof regime !== 'string' || regime.length === 0) regime = 'unknown';

    const sample: CalibrationSample = {
      predictedPWin: Math.max(0, Math.min(1, predictedPWin)),
      conviction: Math.max(0, Math.min(1, conviction)),
      regime,
      outcome,
      ts: Date.now(),
    };

    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    // ── Update 10-bin reliability diagram (using predictedPWin) ──
    const binIdx = Math.min(NUM_BINS - 1, Math.floor(sample.predictedPWin * NUM_BINS));
    const bin = this.bins[binIdx];
    if (bin) {
      if (outcome === 1) bin.wins++;
      else bin.losses++;
    }

    // ── Update per-regime Brier score (diminishing EMA) ──
    const brierContribution = Math.pow(sample.predictedPWin - outcome, 2);
    const prevBrier = this.regimeBrier.get(regime) ?? BRIER_RANDOM;
    const count = this.regimeSampleCount.get(regime) ?? 0;
    const alpha = 1 / (1 + count); // diminishing learning rate
    const newBrier = (1 - alpha) * prevBrier + alpha * brierContribution;
    this.regimeBrier.set(regime, newBrier);
    this.regimeSampleCount.set(regime, count + 1);

    log.debug(
      `[meta-cal] recordTrade: pwin=${sample.predictedPWin.toFixed(2)}, ` +
      `conv=${sample.conviction.toFixed(2)}, regime=${regime}, ` +
      `outcome=${outcome}, brierContrib=${brierContribution.toFixed(4)}, ` +
      `regimeBrier=${newBrier.toFixed(4)} (n=${count + 1})`
    );
  }

  /**
   * Compute Expected Calibration Error (ECE).
   * ECE = Σ (nᵦ / N) × |acc(b) - conf(b)|
   *
   * acc(b) = actual win rate in bin b
   * conf(b) = midpoint of bin b (average predicted P(win))
   *
   * @returns ECE in [0, 1]. Returns 0 if insufficient data.
   */
  getECE(): number {
    const N = this.samples.length;
    if (N < MIN_SAMPLES_FOR_OUTPUT) return 0;

    let ece = 0;
    for (const bin of this.bins) {
      const total = bin.wins + bin.losses;
      if (total < MIN_SAMPLES_PER_BIN) continue;
      const acc = bin.wins / total;
      const conf = (bin.lo + bin.hi) / 2;
      ece += (total / N) * Math.abs(acc - conf);
    }
    return ece;
  }

  /**
   * Compute overall Brier score.
   * Brier = (1/N) Σ (fᵢ - oᵢ)²
   *
   * @returns Brier in [0, 1]. Returns 0.25 (random) if insufficient data.
   */
  getOverallBrier(): number {
    if (this.samples.length < MIN_SAMPLES_FOR_OUTPUT) return BRIER_RANDOM;
    const sum = this.samples.reduce(
      (s, x) => s + Math.pow(x.predictedPWin - x.outcome, 2),
      0,
    );
    return sum / this.samples.length;
  }

  /**
   * Get per-regime Brier scores, sorted worst-first.
   * @returns Array of { regime, brier, samples }
   */
  getRegimeBrier(): Array<{ regime: string; brier: number; samples: number }> {
    const out: Array<{ regime: string; brier: number; samples: number }> = [];
    for (const [regime, brier] of this.regimeBrier) {
      out.push({
        regime,
        brier,
        samples: this.regimeSampleCount.get(regime) ?? 0,
      });
    }
    return out.sort((a, b) => b.brier - a.brier);
  }

  /**
   * Confidence adjustment factor for a given regime.
   *
   * If the system is poorly calibrated in this regime (Brier > 0.25),
   * returns factor < 1.0 to dampen conviction.
   * If well-calibrated (Brier < 0.20), returns ~1.0 (minimal adjustment).
   * If insufficient data, returns 1.0 (no adjustment).
   *
   * @param regime  Current market regime
   * @returns adjustment factor in [0.5, 1.5]
   */
  getConfidenceAdjustment(regime: string): number {
    const brier = this.regimeBrier.get(regime) ?? BRIER_RANDOM;
    const count = this.regimeSampleCount.get(regime) ?? 0;
    if (count < MIN_SAMPLES_PER_REGIME) return 1.0;

    // Brier = 0.25 → random → 1/brierRatio = 1.0 (no adjustment)
    // Brier > 0.25 → worse than random → dampen (< 1.0)
    // Brier < 0.25 → better than random → slight boost (> 1.0)
    const brierRatio = brier / BRIER_RANDOM;
    const adjustment = 1.0 / brierRatio;
    return Math.max(0.5, Math.min(1.5, adjustment));
  }

  /**
   * Get full calibration stats for API / UI.
   */
  getStats(): CalibrationStats {
    return {
      totalSamples: this.samples.length,
      brier: this.getOverallBrier(),
      ece: this.getECE(),
      regimeBrier: this.getRegimeBrier(),
      bins: this.bins.map(b => ({
        lo: b.lo,
        hi: b.hi,
        wins: b.wins,
        losses: b.losses,
        actualWR: b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : 0,
      })),
    };
  }

  /**
   * Format calibration block for HACP prompt injection.
   * Meta-Agent sees this and can self-correct conviction.
   *
   * Design: reference data, not a gate (same philosophy as news sentiment
   * and Q-RL discovery — "give data to reason, not to decide").
   */
  getCalibrationBlock(): string {
    if (this.samples.length < MIN_SAMPLES_FOR_OUTPUT) {
      return '=== META-CALIBRATION ===\nInsufficient data for calibration assessment.\n---';
    }

    const brier = this.getOverallBrier();
    const ece = this.getECE();
    const lines: string[] = [
      '=== META-CALIBRATION (System Self-Awareness) ===',
      `📊 Overall Brier: ${brier.toFixed(4)} (0=perfect, 0.25=random, >0.25=worse-than-random)`,
      `📊 ECE: ${ece.toFixed(4)} (0=perfectly calibrated, >${ECE_WARNING_THRESHOLD}=significant miscalibration)`,
      `📊 Sample size: ${this.samples.length} trades`,
    ];

    // Per-regime breakdown (worst first)
    const regimeBrier = this.getRegimeBrier();
    const significant = regimeBrier.filter(r => r.samples >= MIN_SAMPLES_PER_REGIME);
    if (significant.length > 0) {
      lines.push('');
      lines.push('Per-regime prediction accuracy (Brier, lower=better):');
      for (const { regime, brier: rBrier, samples } of significant.slice(0, 5)) {
        const status = rBrier < 0.20 ? '✅' : rBrier < BRIER_RANDOM ? '⚠️' : '❌';
        lines.push(`  ${status} ${regime}: ${rBrier.toFixed(4)} (${samples} trades)`);
      }
    }

    // Reliability diagram (bins with enough data)
    const activeBins = this.bins.filter(b => b.wins + b.losses >= MIN_SAMPLES_PER_BIN);
    if (activeBins.length > 0) {
      lines.push('');
      lines.push('Reliability map (predicted P(win) → actual win rate):');
      for (const bin of activeBins) {
        const total = bin.wins + bin.losses;
        const actualWR = bin.wins / total;
        const predictedMid = (bin.lo + bin.hi) / 2;
        const gap = actualWR - predictedMid;
        const status = Math.abs(gap) < 0.05
          ? '✅'
          : gap < 0
            ? '📉 over-confident'
            : '📈 under-confident';
        lines.push(
          `  [${(bin.lo * 100).toFixed(0)}-${(bin.hi * 100).toFixed(0)}%] → ` +
          `actual ${(actualWR * 100).toFixed(0)}% (n=${total}) ${status}`
        );
      }
    }

    // Self-correction advice (only when miscalibration is significant)
    if (ece > ECE_WARNING_THRESHOLD) {
      // Use overall Brier to compute a rough adjustment
      const overallAdjustment = this.getConfidenceAdjustment('__overall__');
      // __overall__ won't be in the map → returns 1.0. Use overall Brier instead:
      const brierRatio = brier / BRIER_RANDOM;
      const roughAdjust = Math.max(0.5, Math.min(1.5, 1.0 / brierRatio));
      lines.push('');
      lines.push(`⚠️ MISCALIBRATION DETECTED (ECE=${ece.toFixed(2)}). Your conviction is not reliable.`);
      lines.push(`   If you predict 70% P(win) but actual is 55%, you are OVER-CONFIDENT.`);
      lines.push(`   REDUCE your conviction by ~${((1 - roughAdjust) * 100).toFixed(0)}% this cycle.`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  // ─── Persistence ───

  save(): Record<string, unknown> {
    return {
      samples: this.samples.slice(-100), // keep last 100 for reload
      bins: this.bins.map(b => ({ ...b })),
      regimeBrier: Object.fromEntries(this.regimeBrier),
      regimeSampleCount: Object.fromEntries(this.regimeSampleCount),
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;

    // Load samples
    const savedSamples = s['samples'];
    if (Array.isArray(savedSamples)) {
      this.samples = savedSamples.filter(
        (x): x is CalibrationSample =>
          x !== null && typeof x === 'object' &&
          typeof (x as CalibrationSample).predictedPWin === 'number' &&
          typeof (x as CalibrationSample).conviction === 'number' &&
          typeof (x as CalibrationSample).regime === 'string' &&
          ((x as CalibrationSample).outcome === 0 || (x as CalibrationSample).outcome === 1),
      );
    }

    // Load bins
    const savedBins = s['bins'];
    if (Array.isArray(savedBins) && savedBins.length === NUM_BINS) {
      this.bins = savedBins.map(b => ({
        lo: Number.isFinite((b as Bin).lo) ? (b as Bin).lo : 0,
        hi: Number.isFinite((b as Bin).hi) ? (b as Bin).hi : 0,
        wins: Number.isFinite((b as Bin).wins) ? (b as Bin).wins : 0,
        losses: Number.isFinite((b as Bin).losses) ? (b as Bin).losses : 0,
      }));
    }

    // Load regime Brier
    const savedBrier = s['regimeBrier'];
    if (savedBrier && typeof savedBrier === 'object') {
      this.regimeBrier = new Map(
        Object.entries(savedBrier as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
          .map(([k, v]) => [k, v as number]),
      );
    }

    // Load regime sample counts
    const savedCount = s['regimeSampleCount'];
    if (savedCount && typeof savedCount === 'object') {
      this.regimeSampleCount = new Map(
        Object.entries(savedCount as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
          .map(([k, v]) => [k, v as number]),
      );
    }

    log.info(
      `[meta-cal] loaded: ${this.samples.length} samples, ` +
      `${this.regimeBrier.size} regimes, ` +
      `Brier=${this.getOverallBrier().toFixed(4)}, ECE=${this.getECE().toFixed(4)}`
    );
  }

  /** Reset — used by tests. */
  reset(): void {
    this.samples = [];
    this.regimeBrier.clear();
    this.regimeSampleCount.clear();
    for (const bin of this.bins) {
      bin.wins = 0;
      bin.losses = 0;
    }
  }

  /** Get sample count (for UI / API). */
  getSampleCount(): number {
    return this.samples.length;
  }
}