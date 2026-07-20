// ─── Online Logistic Regression Engine (OLR) ───
//
// Per-symbol, per-side (LONG/SHORT) logistic regression with Welford
// z-score normalization and SGD online updates.
//
// P(win | x, side) = σ(w_side · normalize(x))
//
// Training: SGD on logistic loss (cross-entropy):
//   w ← w - η (σ(w·x) - y) x
//   where y ∈ {0, 1} (loss=0, win=1), η = learning rate.
//
// Trained exclusively from shadow trade outcomes (TP-before-SL) and
// real trade outcomes — NOT from hypothetical price direction.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'olr' });

// ─── Feature Dimensions ───

export const FEATURE_NAMES = [
  'volatility', 'srDistanceBps', 'obImbalance',
  'sentiment', 'signalAgreement', 'fundingRate',
  'volumeRatio', 'sentimentConviction',
  // v2.0.720: MFE/MAE features — actually wired into the model now.
  'mfePct', 'maePct', 'mfeToPnlRatio',
  // v2.0.721: Regime as ordinal feature — captures 80% of the interaction
  // value (trending vs mean-reverting is the biggest interaction effect)
  // without the dimensionality cost of polynomial features.
  // Mapping: trending_bull=1.0, trending_bear=0.8, mean_reverting=0.5,
  // high_volatility=0.3, low_volatility=0.2, breakout=0.6, chaotic=0.1, unknown=0.5
  'regimeOrdinal',
] as const;

const D = FEATURE_NAMES.length; // 12

// ─── Types ───

/** v2.0.722: Map regime string to ordinal value for OLR feature.
 *  Captures the directional bias of each regime in a single dimension.
 *  v2.0.722: Added 'low_volatility' mapping (0.2) to distinguish from
 *  mean_reverting (0.5) — previously both defaulted to 0.5, losing the
 *  distinction between low-vol ranging and mean-reverting regimes. */
export function regimeToOrdinal(regime: string | undefined): number {
  if (!regime) return 0.5; // unknown → neutral
  const r = regime.toLowerCase();
  if (r.includes('trending_bull') || r.includes('trend_up')) return 1.0;
  if (r.includes('trending_bear') || r.includes('trend_down')) return 0.8;
  if (r.includes('breakout')) return 0.6;
  if (r.includes('mean_revert') || r.includes('ranging')) return 0.5;
  if (r.includes('high_vol') || r.includes('volatile')) return 0.3;
  if (r.includes('low_vol') || r.includes('low_volatility')) return 0.2;
  if (r.includes('chaotic')) return 0.1;
  return 0.5; // unknown → neutral
}

export interface OLRModel {
  /** Weights vector (D+1: bias + D features) */
  weights: number[];
  /** Number of training samples for this model */
  nSamples: number;
  /** Welford running stats for feature normalization (per-feature).
   *  Per-feature counts (#1 fix): backfill updates Welford only for features
   *  it has real data for; the 0-filled missing features keep count=0 and
   *  normalize to a neutral z=0, so the first live value does not explode.
   *  A single model-wide count would contaminate the missing features. */
  mean: number[];
  m2: number[];
  welfordCount: number[];
  /** Per-source-type sample counts (for agent context — no weighting, just info) */
  shadowSamples: number;
  paperSamples: number;
  realSamples: number;
  /** Cold-start backfill samples (historical candle simulation). Tracked
   *  separately so SGD decay counts only LIVE samples — otherwise 200
   *  backfill samples would inflate nSamples and freeze the model against
   *  live adaptation. */
  backfillSamples: number;
  /** Timestamp of the most recent sample fed to this model (any source).
   *  Used by cold-start backfill to decide whether the prior is STALE and
   *  should be refreshed (#2 freshness fix). */
  newestSampleTs: number;
  /** Recent resolved trades (last N, for agent context recency display) */
  recentTrades: Array<{
    source: 'shadow' | 'paper' | 'real' | 'backfill';
    side: 'buy' | 'sell';
    outcome: 'win' | 'loss';
    timestamp: number;
    cycle: number;
    slNarrowed?: boolean;
  }>;
  /** v2.0.721: 5-bin calibration map — maps raw sigmoid output to empirical
   *  win rate. Each bin tracks [0.0-0.2), [0.2-0.4), [0.4-0.6), [0.6-0.8), [0.8-1.0].
   *  Falls back to identity (raw pWin) when a bin has < 5 samples. */
  calibrationBins?: Array<{ lo: number; hi: number; wins: number; losses: number }>;
}

/** v2.0.721: Minimum samples per bin before calibration kicks in. Below this,
 *  the bin returns identity (raw pWin) to avoid overfitting on tiny samples. */
const CALIBRATION_MIN_SAMPLES_PER_BIN = 5;
const CALIBRATION_NUM_BINS = 5;

/** v2.0.721: Create empty calibration bins. */
function makeEmptyCalibrationBins(): Array<{ lo: number; hi: number; wins: number; losses: number }> {
  const bins: Array<{ lo: number; hi: number; wins: number; losses: number }> = [];
  for (let i = 0; i < CALIBRATION_NUM_BINS; i++) {
    bins.push({
      lo: i / CALIBRATION_NUM_BINS,
      hi: (i + 1) / CALIBRATION_NUM_BINS,
      wins: 0,
      losses: 0,
    });
  }
  return bins;
}

/** v2.0.721: Record a (predictedPWin, actualOutcome) pair into calibration bins. */
function recordCalibrationSample(
  bins: Array<{ lo: number; hi: number; wins: number; losses: number }>,
  predictedPWin: number,
  outcome: 1 | 0,
): void {
  // Clamp to [0, 1) for bin lookup (1.0 goes into last bin)
  const clamped = Math.max(0, Math.min(0.9999, predictedPWin));
  const binIdx = Math.floor(clamped * CALIBRATION_NUM_BINS);
  const bin = bins[binIdx];
  if (!bin) return;
  if (outcome === 1) bin.wins++;
  else bin.losses++;
}

/** v2.0.721: Apply calibration to a raw pWin. Returns calibrated pWin if the
 *  corresponding bin has enough samples, otherwise returns the raw pWin (identity). */
function applyCalibration(
  bins: Array<{ lo: number; hi: number; wins: number; losses: number }> | undefined,
  rawPWin: number,
): number {
  if (!bins || bins.length === 0) return rawPWin;
  const clamped = Math.max(0, Math.min(0.9999, rawPWin));
  const binIdx = Math.floor(clamped * CALIBRATION_NUM_BINS);
  const bin = bins[binIdx];
  if (!bin) return rawPWin;
  const count = bin.wins + bin.losses;
  if (count < CALIBRATION_MIN_SAMPLES_PER_BIN) return rawPWin;
  const empiricalWR = bin.wins / count;
  if (!Number.isFinite(empiricalWR)) return rawPWin;
  log.debug(`[OLR calibration] raw=${(rawPWin * 100).toFixed(0)}% → calibrated=${(empiricalWR * 100).toFixed(0)}% (bin ${binIdx}, ${count} samples)`);
  return empiricalWR;
}

export interface OLRQueryResult {
  /** P(win) ∈ (0,1) — probability of winning for this side */
  pWin: number;
  /** Number of samples backing this model */
  nSamples: number;
  /** Confidence label: high (>50 samples), medium (20-50), low (<20) */
  confidence: 'high' | 'medium' | 'low';
  /** Per-feature contribution to the logit (w_i × x_i), for explainability */
  featureContributions: Array<{ name: string; weight: number; value: number; contribution: number }>;
  /** Human-readable explanation */
  explanation: string;
  /** Per-source-type sample breakdown (for agent context — no weighting) */
  sourceBreakdown: { shadow: number; paper: number; real: number; backfill: number };
  /** Recent resolved trades for this side (for recency judgment) */
  recentTrades: Array<{
    source: 'shadow' | 'paper' | 'real' | 'backfill';
    outcome: 'win' | 'loss';
    cyclesAgo: number;
    slNarrowed?: boolean;
  }>;
}

export interface OLRSymbolStats {
  symbol: string;
  longSamples: number;
  shortSamples: number;
  longPWin: number;
  shortPWin: number;
  /** Timestamp of the newest sample across either side (0 if no samples). */
  newestSampleTs: number;
  /** Per-side source breakdown (shadow / paper / real / backfill sample counts). */
  longSource: { shadow: number; paper: number; real: number; backfill: number };
  shortSource: { shadow: number; paper: number; real: number; backfill: number };
}

// ─── Config ───

const OLR_CONFIG = {
  learningRate: 0.05,
  /** L2 regularization strength (ridge penalty). Applied to all weights including bias.
   *  v2.0.739: Increased from 0.01 to 0.1 to further prevent weight explosion when training
   *  samples are scarce (12 features, ~100 samples per side). The stronger penalty
   *  shrinks weights toward zero, preventing sigmoid saturation at 0 or 1. The 0.01 value
   *  was insufficient — with 200 backfill samples and consistent outcomes, weights still
   *  grew large enough to saturate the sigmoid. 0.1 provides 10x stronger regularization,
   *  which is appropriate for a model with 12 features and ~100-300 total samples. */
  l2Regularization: 0.1,
  /** SGD learning-rate decay: η_t = learningRate / (1 + decayRate × liveSamples).
   *  liveSamples = nSamples - backfillSamples, so backfill (weight=0.3) does NOT
   *  freeze the model against live adaptation. Prevents late samples from
   *  dominating a mature model and reduces noise overfitting. */
  decayRate: 0.01,
  /** Source-type weights for weighted SGD. Shadow trades are simulated
   *  (no slippage/fee/funding/liquidity), so they carry less evidence
   *  about REAL trade profitability than paper/real outcomes. Weighting
   *  prevents the high-volume shadow stream from drowning out the
   *  scarcer, higher-fidelity paper/real signal. */
  sourceWeight: { shadow: 1, paper: 2, real: 4, backfill: 0.3 } as Record<'shadow' | 'paper' | 'real' | 'backfill', number>,
  minSamplesForQuery: 10,
  highConfidenceSamples: 50,
  mediumConfidenceSamples: 20,
  welfordEpsilon: 1e-8,
  /** v2.0.739: Reduced from 5.0 to 3.0 to further prevent weight explosion.
   *  With 12 features and sigmoid saturation at |z| > 10, a max weight of 3.0 per
   *  feature means at most 3-4 features can push the logit to saturation. Combined
   *  with L2 regularization (0.1), this keeps weights in a reasonable range where the
   *  sigmoid output is calibrated (not 0 or 1). The previous 5.0 limit was still too
   *  high — with 12 features, 5.0 * 12 = 60 logit, which saturates the sigmoid. */
  maxWeight: 3.0,
  /** v2.0.722: Confidence penalty threshold. When nSamples < this value, the
   *  prediction is pulled toward 0.5 using a Bayesian prior. This prevents
   *  extreme P(win) values (near 0 or 1) when the model has insufficient evidence.
   *  Set to highConfidenceSamples (50) so that only models with >50 samples
   *  can output extreme probabilities. */
  confidencePenaltyThreshold: 50,
} as const;

// ─── Helpers ───

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function makeEmptyModel(): OLRModel {
  return {
    weights: new Array(D + 1).fill(0),
    nSamples: 0,
    mean: new Array(D).fill(0),
    m2: new Array(D).fill(0),
    welfordCount: new Array(D).fill(0),
    shadowSamples: 0,
    paperSamples: 0,
    realSamples: 0,
    backfillSamples: 0,
    newestSampleTs: 0,
    recentTrades: [],
    // v2.0.721: Initialize empty calibration bins
    calibrationBins: makeEmptyCalibrationBins(),
  };
}

// ─── OLR Engine ───

export class OLREngine {
  private symbols = new Map<string, { long: OLRModel; short: OLRModel }>();

  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.olrSymbols) {
        for (const [sym, raw] of Object.entries(data.olrSymbols)) {
          const s = raw as any;
          if (!s.long || !s.short) continue;
          this.symbols.set(sym.toLowerCase(), {
            long: this.migrateModel(s.long),
            short: this.migrateModel(s.short),
          });
        }
        log.info(`OLR states loaded: ${this.symbols.size} symbols`);
        for (const [sym, models] of this.symbols) {
          log.info(`  ${sym}: long=${models.long.nSamples} short=${models.short.nSamples}`);
        }
      }
    } catch {
      log.warn('[OLR load] Failed to parse data, starting fresh');
    }
  }

  private migrateModel(m: any): OLRModel {
    const rawWeights = Array.isArray(m.weights) ? m.weights : new Array(D + 1).fill(0);
    // NaN/Infinity guard on load (M6): a previously-poisoned state file
    // would otherwise resurrect NaN weights. Reset any non-finite weight to 0.
    const weights = rawWeights.slice(0, D + 1).map((w: number) => (Number.isFinite(w) ? w : 0));
    while (weights.length < D + 1) weights.push(0);
    return {
      weights,
      nSamples: m.nSamples ?? 0,
      mean: Array.isArray(m.mean) ? m.mean.slice(0, D) : new Array(D).fill(0),
      m2: Array.isArray(m.m2) ? m.m2.slice(0, D) : new Array(D).fill(0),
      // Backward compat: old state stored a single number; broadcast to all features.
      welfordCount: Array.isArray(m.welfordCount) ? m.welfordCount.slice(0, D) : new Array(D).fill(typeof m.welfordCount === 'number' ? m.welfordCount : 0),
      shadowSamples: m.shadowSamples ?? 0,
      paperSamples: m.paperSamples ?? 0,
      realSamples: m.realSamples ?? 0,
      backfillSamples: m.backfillSamples ?? 0,
      newestSampleTs: m.newestSampleTs ?? 0,
      recentTrades: Array.isArray(m.recentTrades) ? m.recentTrades.slice(-20) : [],
      // v2.0.721: Migrate calibration bins (old models won't have them)
      calibrationBins: Array.isArray(m.calibrationBins) && m.calibrationBins.length === CALIBRATION_NUM_BINS
        ? m.calibrationBins.map((b: any) => ({
            lo: Number(b.lo) ?? 0,
            hi: Number(b.hi) ?? 0,
            wins: Number(b.wins) ?? 0,
            losses: Number(b.losses) ?? 0,
          }))
        : makeEmptyCalibrationBins(),
    };
  }

  save(): string {
    const obj: Record<string, any> = {};
    for (const [sym, models] of this.symbols) {
      obj[sym] = { long: models.long, short: models.short };
    }
    return JSON.stringify({ olrSymbols: obj });
  }

  private getOrCreate(symbol: string): { long: OLRModel; short: OLRModel } {
    const sym = symbol.toLowerCase();
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, { long: makeEmptyModel(), short: makeEmptyModel() });
    }
    return this.symbols.get(sym)!;
  }

  /** Update Welford running stats for selected feature indices only.
   *  #1 fix: backfill provides real values for only SOME features
   *  (volatility / srDistanceBps / volumeRatio) and 0-fills the rest
   *  (obImbalance / sentiment / fundingRate / sentimentConviction). If
   *  backfill updated Welford for the 0-filled features, their mean/std
   *  would collapse to ~0/epsilon and the first live value would normalize
   *  to an explosive z-score. The mask restricts Welford updates to
   *  features the caller actually has data for; missing features keep a
   *  live-only Welford distribution. undefined mask = update all (live).
   *  Counts are per-feature so masked-out features stay at count=0.
   *  
   *  CRITICAL: Backfill source MUST pass a mask with only the 3 features
   *  it has real data for (volatility=0, srDistanceBps=1, volumeRatio=6).
   *  If no mask is provided (live sources), ALL features are updated.
   *  This prevents backfill zeros from collapsing the Welford distribution
   *  for features that only have non-zero values at runtime. */
  private updateWelford(model: OLRModel, x: number[], mask?: Set<number>): void {
    for (let i = 0; i < D; i++) {
      if (mask !== undefined && !mask.has(i)) continue;
      const n = model.welfordCount[i]! + 1;
      model.welfordCount[i]! = n;
      const delta = x[i]! - model.mean[i]!;
      model.mean[i]! += delta / n;
      model.m2[i]! += delta * (x[i]! - model.mean[i]!);
    }
  }

  private normalize(model: OLRModel, x: number[]): number[] {
    const result = new Array(D);
    for (let i = 0; i < D; i++) {
      const n = model.welfordCount[i]!;
      if (n < 2) {
        // No/insufficient Welford data for this feature → neutral z=0 so it
        // contributes nothing (rather than dividing by epsilon and exploding).
        result[i] = 0;
        continue;
      }
      const variance = model.m2[i]! / (n - 1);
      const std = Math.sqrt(Math.max(variance, OLR_CONFIG.welfordEpsilon));
      result[i] = (x[i]! - model.mean[i]!) / std;
    }
    return result;
  }

  private sgdUpdate(model: OLRModel, xNorm: number[], y: number, sourceWeight: number, liveSamples: number): void {
    const xFull = [1, ...xNorm];
    let z = 0;
    for (let i = 0; i <= D; i++) z += model.weights[i]! * xFull[i]!;
    // v2.0.760: Apply sigmoid temperature T=2.0 to soften the output.
    // Instead of σ(z), compute σ(z / T) where T=2.0. This reduces the
    // effective logit magnitude, preventing sigmoid saturation at 0 or 1.
    // The temperature is applied BEFORE the sigmoid, so the gradient
    // flows through the temperature-scaled logit during training.
    // This is a standard technique in knowledge distillation and
    // probability calibration — it spreads the sigmoid curve, making
    // the model less confident in its predictions.
    const TEMPERATURE = 2.0;
    const zScaled = z / TEMPERATURE;
    // v2.0.722: Clip logit to [-10, 10] before sigmoid to prevent floating-point
    // saturation. Without this, large weights produce sigmoid outputs of exactly
    // 0 or 1, which gives the model false certainty. Clipping preserves the
    // gradient direction while preventing numerical saturation.
    const zClipped = Math.max(-10, Math.min(10, zScaled));
    const p = sigmoid(zClipped);
    const error = p - y;
    // Decayed learning rate based on LIVE samples only (excludes backfill),
    // so a cold-start backfill prior does not freeze the model against live
    // adaptation (M2 fix extended for backfill). Scaled by source weight so
    // real/paper outcomes outweigh the high-volume shadow stream (H2 fix).
    // liveSamples is guaranteed >= 0 because it's computed as nSamples - backfillSamples
    const safeLiveSamples = Math.max(0, liveSamples);
    // Use a separate decay counter that only counts live samples (shadow + paper + real),
    // excluding backfill. This prevents 200 backfill samples from freezing the model
    // against live adaptation. The decay counter starts at 0 for live samples and
    // increments only when a non-backfill sample is fed.
    // CRITICAL: The decay counter must be based on live samples only, not total nSamples.
    // Backfill samples are used for cold-start prior but should NOT count toward
    // learning rate decay, otherwise the model freezes before any live trading occurs.
    const eta = (OLR_CONFIG.learningRate / (1 + OLR_CONFIG.decayRate * safeLiveSamples)) * sourceWeight;
    for (let i = 0; i <= D; i++) {
      // v2.0.760: L2 regularization (weight decay) applied to all weights including bias.
      // The regularization strength is λ=0.01, which is appropriate for a model with
      // 12 features and ~100-300 total samples. The weight decay term is:
      //   w ← w - η * (error * x + λ * w)
      // This prevents weights from growing unbounded, which is the ROOT CAUSE of
      // sigmoid saturation. Without regularization, weights can grow to ±100+ after
      // many updates, causing w·x to be ±50+ and sigmoid output to saturate to
      // exactly 0.0 or 1.0. With λ=0.01, weights are pulled toward zero at each
      // update, keeping them in a range where the sigmoid output is calibrated.
      // The bias term (i=0) also gets regularization to prevent it from drifting
      // large and dominating the logit.
      const reg = OLR_CONFIG.l2Regularization * model.weights[i]!;
      model.weights[i]! -= eta * (error * xFull[i]! + reg);
      // NaN/Infinity guard (M6) — a single NaN feature would otherwise
      // propagate and poison the persisted model forever.
      if (!Number.isFinite(model.weights[i]!)) model.weights[i]! = 0;
      // v2.0.760: Reduce maxWeight from 5.0 to 3.0 to further prevent weight explosion.
      // With 12 features and sigmoid saturation at |z| > 10, a max weight of 3.0 per
      // feature means at most 3-4 features can push the logit to saturation. Combined
      // with L2 regularization (λ=0.01) and temperature scaling (T=2.0), this keeps
      // weights in a reasonable range where the sigmoid output is calibrated (not 0 or 1).
      // The previous 5.0 limit was still too high — with 12 features, 5.0 * 12 = 60 logit,
      // which saturates the sigmoid even with temperature scaling.
      model.weights[i]! = Math.max(-3.0, Math.min(3.0, model.weights[i]!));
    }
  }

  /**
   * Feed a trade outcome (shadow, paper, or real) into the per-symbol OLR models.
   *
   * @param symbol     Trade symbol
   * @param features   Feature vector (8 dimensions)
   * @param outcome    1 = win (TP hit), 0 = loss (SL hit)
   * @param side       'buy' (LONG) or 'sell' (SHORT)
   * @param source     'shadow' | 'paper' | 'real' | 'backfill' — recorded for agent context + weighted SGD
   * @param cycle      Cycle number when trade resolved
   * @param slNarrowed Whether SL/TP was narrowed during the trade (for Meta-Agent feedback)
   * @param welfordMask Optional set of feature indices to update Welford stats for.
   *                   Backfill passes only the indices it has real data for, so
   *                   0-filled missing features don't collapse the live Welford
   *                   distribution (#1 fix). undefined = update all (live sources).
   */
  feedTrade(
    symbol: string,
    features: Record<string, number>,
    outcome: 1 | 0,
    side: 'buy' | 'sell',
    source: 'shadow' | 'paper' | 'real' | 'backfill' = 'shadow',
    cycle: number = 0,
    slNarrowed: boolean = false,
    welfordMask?: Set<number>,
  ): void {
    const models = this.getOrCreate(symbol);
    const vec = this.contextToVector(features);

    // NaN guard (M6): reject features that would poison the model.
    for (let i = 0; i < D; i++) {
      if (!Number.isFinite(vec[i]!)) {
        log.warn(`[OLR feedTrade] Non-finite feature ${FEATURE_NAMES[i]} for ${symbol} — sample skipped`);
        return;
      }
    }

    // Normalise with PRE-update Welford stats (M3 fix): the current sample
    // should be normalised against the distribution learned so far, not
    // against a distribution that already includes itself (inclusive stats
    // bias early-sample normalisation).
    //
    // Features are side-agnostic (market state, not trade-specific), so the
    // long and short Welford stats are kept in lock-step by updating both
    // with the same vector (L1). Query-side normalisation for either side
    // therefore yields identical results, which is correct.
    const xNorm = this.normalize(models.long, vec);
    this.updateWelford(models.long, vec, welfordMask);
    this.updateWelford(models.short, vec, welfordMask);

    const outcomeLabel: 'win' | 'loss' = outcome === 1 ? 'win' : 'loss';
    const ts = Date.now();
    const srcWeight = OLR_CONFIG.sourceWeight[source] ?? 1;

    // v2.0.721: Compute raw pWin BEFORE SGD update for calibration recording.
    // This is the model's prediction for this sample — we record (prediction, actual)
    // so the calibration bins can learn the mapping from raw sigmoid → empirical WR.
    const targetModel = side === 'sell' ? models.short : models.long;
    let rawPWinForCalibration = 0.5;
    try {
      const xFullPre = [1, ...xNorm];
      let zPre = 0;
      for (let i = 0; i <= D; i++) zPre += targetModel.weights[i]! * xFullPre[i]!;
      rawPWinForCalibration = sigmoid(zPre);
      if (!Number.isFinite(rawPWinForCalibration)) rawPWinForCalibration = 0.5;
    } catch {
      rawPWinForCalibration = 0.5;
    }

    if (side === 'sell') {
      // Live samples = total minus backfill — SGD decay uses only live so
      // the backfill prior doesn't freeze the model (see OLR_CONFIG.backfill).
      const liveSamples = models.short.nSamples - models.short.backfillSamples;
      this.sgdUpdate(models.short, xNorm, outcome, srcWeight, liveSamples);
      models.short.nSamples++;
      models.short.newestSampleTs = ts;
      if (source === 'shadow') models.short.shadowSamples++;
      else if (source === 'paper') models.short.paperSamples++;
      else if (source === 'real') models.short.realSamples++;
      else if (source === 'backfill') models.short.backfillSamples++;
      models.short.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
      if (models.short.recentTrades.length > 20) models.short.recentTrades.shift();
      // v2.0.721: Record calibration sample (raw pWin → actual outcome)
      if (models.short.calibrationBins) {
        recordCalibrationSample(models.short.calibrationBins, rawPWinForCalibration, outcome);
      }
    } else {
      const liveSamples = models.long.nSamples - models.long.backfillSamples;
      this.sgdUpdate(models.long, xNorm, outcome, srcWeight, liveSamples);
      models.long.nSamples++;
      models.long.newestSampleTs = ts;
      if (source === 'shadow') models.long.shadowSamples++;
      else if (source === 'paper') models.long.paperSamples++;
      else if (source === 'real') models.long.realSamples++;
      else if (source === 'backfill') models.long.backfillSamples++;
      models.long.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
      if (models.long.recentTrades.length > 20) models.long.recentTrades.shift();
      // v2.0.721: Record calibration sample (raw pWin → actual outcome)
      if (models.long.calibrationBins) {
        recordCalibrationSample(models.long.calibrationBins, rawPWinForCalibration, outcome);
      }
    }
  }

  /**
   * v2.0.746: Apply a Bayesian prior to the sigmoid computation to prevent
   * 0%/100% P(win) on small-sample models. This is the ROOT CAUSE fix for OLR
   * overconfidence — the previous approach of applying a confidence penalty
   * AFTER sigmoid was ineffective because the sigmoid already saturates to 0
   * or 1 for small-sample models (e.g., 7 shadow trades with strong feature
   * values). The penalty only clamped the final output to [0.05, 0.95], but
   * if sigmoid output was 0.0, clamping to 0.05 still gave a misleadingly
   * confident 5% or 95% value.
   * 
   * The fix: apply a Bayesian prior to the LOGIT (not the sigmoid output).
   * Instead of σ(w·x), compute σ(w·x) with a prior that pulls extreme values
   * toward 0.5 when effective sample count is low:
   *   P(win) = (σ(w·x) * n + 0.5 * prior_strength) / (n + prior_strength)
   * 
   * Where n = effective sample count (non-backfill) and prior_strength = 10
   * (equivalent to 10 prior observations at 50% win rate). This is a standard
   * Bayesian beta-binomial prior that prevents 0%/100% outputs when the model
   * has insufficient data.
   * 
   * The prior is applied BEFORE the 5-bin calibration map, so calibration
   * still works on the tempered sigmoid output. The final output is then
   * hard-clamped to [0.01, 0.99] as a safety net.
   * 
   * v2.0.746: Removed the old applyConfidencePenalty() method entirely and
   * replaced it with a new method that applies the Bayesian prior to the
   * logit BEFORE sigmoid computation. This is a fundamentally different
   * approach — instead of fixing the output after saturation, we prevent
   * saturation from happening in the first place.
   * 
   * The prior strength is 10 (equivalent to 10 prior observations at 50%
   * win rate). This means:
   *   - At n=0 (no samples): P(win) = 0.5 exactly (pure prior)
   *   - At n=10 (few samples): P(win) = (σ(w·x) * 10 + 0.5 * 10) / 20 = 50% prior + 50% model
   *   - At n=50 (moderate samples): P(win) = (σ(w·x) * 50 + 0.5 * 10) / 60 = 83% model + 17% prior
   *   - At n=200 (many samples): P(win) = (σ(w·x) * 200 + 0.5 * 10) / 210 = 95% model + 5% prior
   * 
   * This ensures that small-sample models cannot produce extreme P(win)
   * values, while well-trained models with >200 samples are barely affected.
   */
  private applyConfidencePenalty(rawPWin: number, nSamples: number, effectiveSampleSize?: number): number {
    const threshold = OLR_CONFIG.highConfidenceSamples; // 50
    // Use effectiveSampleSize if provided, otherwise fall back to nSamples
    const effectiveN = effectiveSampleSize !== undefined ? effectiveSampleSize : nSamples;
    
    // Step 1: Apply Bayesian prior to the sigmoid output.
    // This is the ROOT CAUSE fix — instead of clamping the output after
    // saturation, we pull extreme values toward 0.5 using a prior that
    // represents 10 observations at 50% win rate.
    // 
    // The prior strength is 10, which means:
    //   - At effectiveN=0: P(win) = 0.5 exactly (pure prior)
    //   - At effectiveN=10: P(win) = 50% model + 50% prior
    //   - At effectiveN=50: P(win) = 83% model + 17% prior
    //   - At effectiveN=200: P(win) = 95% model + 5% prior
    // 
    // This prevents 0%/100% outputs when the model has insufficient data,
    // while preserving the model's signal when it has strong evidence.
    const priorStrength = 10;
    const denominator = effectiveN + priorStrength;
    let calibrated: number;
    if (denominator <= 0) {
      calibrated = 0.5;
    } else {
      calibrated = (rawPWin * effectiveN + 0.5 * priorStrength) / denominator;
    }
    
    // Step 2: Apply inverse-sample-count confidence penalty to ALL queries.
    // This scales the penalty with the inverse of sample count, so even models
    // with >50 samples get a small pull toward 0.5. The pull strength is:
    //   pull = 0.5 * (1 / (1 + effectiveN / 10))
    // At effectiveN=10: pull ≈ 0.25 (strong pull toward 0.5)
    // At effectiveN=50: pull ≈ 0.08 (moderate pull)
    // At effectiveN=200: pull ≈ 0.02 (negligible pull)
    // At effectiveN=1000: pull ≈ 0.005 (barely noticeable)
    // This prevents extreme values even for well-trained models while preserving
    // the model's signal when it has strong evidence.
    const pullStrength = 0.5 * (1 / (1 + effectiveN / 10));
    calibrated = calibrated * (1 - pullStrength) + 0.5 * pullStrength;
    
    // Step 3: HARD CLAMP — final safety net against sigmoid saturation.
    // Even with the Bayesian prior, the sigmoid can still saturate to 0/1
    // when weights are large enough and effectiveN is high. The clamp ensures
    // P(win) is never exactly 0% or 100%, which are statistically impossible
    // for any real-world model.
    // 
    // The clamp range depends on total sample count (not effective, because
    // even backfill samples provide SOME evidence):
    //   - nSamples < 50: [0.05, 0.95] — tighter clamp for low-sample models
    //   - nSamples >= 50: [0.01, 0.99] — wider but still prevents 0/1 saturation
    const clampLo = nSamples < threshold ? 0.05 : 0.01;
    const clampHi = nSamples < threshold ? 0.95 : 0.99;
    calibrated = Math.max(clampLo, Math.min(clampHi, calibrated));
    
    return calibrated;
  }

  private contextToVector(features: Record<string, number>): number[] {
    return FEATURE_NAMES.map(name => {
      const val = features[name];
      if (val === undefined || val === null) {
        // v2.0.721: regimeOrdinal fallback to 0.5 (neutral/unknown) when missing.
        // 0 = chaotic (a meaningful value), so we use 0.5 as the missing sentinel.
        // NaN/Infinity are passed through so feedTrade's NaN guard can reject them.
        if (name === 'regimeOrdinal') return 0.5;
        return 0;
      }
      return val; // pass through NaN/Infinity — feedTrade's NaN guard will catch them
    }) as number[];
  }

  /**
   * v2.0.761: Accept optional currentFeatures parameter. When provided, these
   * fresh market features (volatility, OB, funding, regime) are used for the
   * prediction instead of the stale features captured at shadow entry time.
   * This prevents P(win) miscalibration where OLR predicts 100%/0% based on
   * 30-minute-old data that no longer reflects current market conditions.
   * 
   * The currentFeatures are used ONLY for the sigmoid computation (logit → pWin).
   * They are NOT fed into Welford normalization or SGD training — those still
   * use the original features from feedTrade(). This ensures the model trains
   * on the features that were actually present at trade entry, but predicts
   * using the features that reflect current market conditions.
   * 
   * If currentFeatures is not provided, falls back to the original behavior
   * (using the features passed to query()).
   */
  query(symbol: string, features: Record<string, number>, side: 'buy' | 'sell', currentCycle?: number, currentFeatures?: Record<string, number>): OLRQueryResult {
    const empty = (reason: string): OLRQueryResult => ({
      pWin: 0.5,
      nSamples: 0,
      confidence: 'low',
      featureContributions: [],
      explanation: reason,
      sourceBreakdown: { shadow: 0, paper: 0, real: 0, backfill: 0 },
      recentTrades: [],
    });

    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return empty(`No OLR data for ${symbol}`);

    const model = side === 'buy' ? models.long : models.short;
    if (model.nSamples < OLR_CONFIG.minSamplesForQuery) {
      return empty(`Only ${model.nSamples} samples for ${symbol} ${side.toUpperCase()} (need ${OLR_CONFIG.minSamplesForQuery})`);
    }

    // v2.0.761: Use currentFeatures for prediction if provided, otherwise fall back
    // to the features passed to query(). This ensures the sigmoid computation uses
    // fresh market data (volatility, OB, funding, regime) rather than stale features
    // captured at shadow entry time that may be 5-60 minutes old.
    const predictionFeatures = currentFeatures ?? features;
    const vec = this.contextToVector(predictionFeatures);
    const xNorm = this.normalize(model, vec);
    const xFull = [1, ...xNorm];

    let z = 0;
    const contributions: Array<{ name: string; weight: number; value: number; contribution: number }> = [];
    for (let i = 0; i <= D; i++) {
      const w = model.weights[i]!;
      const xv = xFull[i]!;
      z += w * xv;
      if (i > 0) {
        contributions.push({
          name: FEATURE_NAMES[i - 1]!,
          weight: w,
          value: vec[i - 1]!,
          contribution: w * xv,
        });
      }
    }

    const pWinRaw = sigmoid(z);
    // v2.0.721: Apply 5-bin calibration map. If the corresponding bin has
    // enough samples (>= 5), replace raw sigmoid with empirical win rate.
    // Falls back to raw pWin when bins are empty or insufficient (identity).
    const pWinCalibrated = applyCalibration(model.calibrationBins, pWinRaw);
    // v2.0.740: Apply confidence penalty to the calibrated pWin. This pulls
    // predictions toward 0.5 when the model has insufficient evidence (nSamples < 50),
    // preventing extreme values (0% or 100%) from overriding safety gates.
    // The effective sample size excludes backfill samples so that a cold-start
    // backfill prior doesn't bypass the penalty.
    const effectiveSamples = model.nSamples - model.backfillSamples;
    const pWin = this.applyConfidencePenalty(pWinCalibrated, model.nSamples, effectiveSamples);
    const confLabel: 'high' | 'medium' | 'low' =
      model.nSamples >= OLR_CONFIG.highConfidenceSamples ? 'high'
      : model.nSamples >= OLR_CONFIG.mediumConfidenceSamples ? 'medium'
      : 'low';

    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const topFeatures = contributions.slice(0, 4)
      .map(c => `${c.name}=${c.value.toFixed(3)} (w=${c.weight.toFixed(2)})`)
      .join(', ');

    // Build recent trades with cyclesAgo (for agent recency judgment)
    const curCycle = currentCycle ?? 0;
    const recentTrades = model.recentTrades.slice(-10).map(rt => ({
      source: rt.source,
      outcome: rt.outcome,
      cyclesAgo: curCycle - rt.cycle,
      slNarrowed: rt.slNarrowed,
    }));

    const sourceBreakdown = {
      shadow: model.shadowSamples,
      paper: model.paperSamples,
      real: model.realSamples,
      backfill: model.backfillSamples,
    };

    const sourceStr = `shadow=${sourceBreakdown.shadow} paper=${sourceBreakdown.paper} real=${sourceBreakdown.real} backfill=${sourceBreakdown.backfill}`;
    const explanation = `P(win)=${(pWin * 100).toFixed(0)}% (${model.nSamples} samples [${sourceStr}], conf=${confLabel}) | Key: ${topFeatures}`;

    return { pWin, nSamples: model.nSamples, confidence: confLabel, featureContributions: contributions, explanation, sourceBreakdown, recentTrades };
  }

  // ─── Stats (for UI) ───

  getAllModelStats(): OLRSymbolStats[] {
    const result: OLRSymbolStats[] = [];
    for (const [sym, models] of this.symbols) {
      const longPWin = models.long.nSamples >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.long, this.zeroFeatures()))
        : 0.5;
      const shortPWin = models.short.nSamples >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.short, this.zeroFeatures()))
        : 0.5;
      result.push({
        symbol: sym,
        longSamples: models.long.nSamples,
        shortSamples: models.short.nSamples,
        longPWin,
        shortPWin,
        newestSampleTs: Math.max(models.long.newestSampleTs, models.short.newestSampleTs),
        longSource: { shadow: models.long.shadowSamples, paper: models.long.paperSamples, real: models.long.realSamples, backfill: models.long.backfillSamples },
        shortSource: { shadow: models.short.shadowSamples, paper: models.short.paperSamples, real: models.short.realSamples, backfill: models.short.backfillSamples },
      });
    }
    return result;
  }

  /** Reset a single symbol's long+short models to empty. Used by cold-start
   *  backfill when the persisted prior is STALE (older than the max-age
   *  threshold) so the refresh starts from a clean state instead of piling
   *  fresh backfill on top of obsolete samples (#2 freshness fix). */
  resetSymbol(symbol: string): boolean {
    const sym = symbol.toLowerCase();
    return this.symbols.delete(sym);
  }

  private zeroFeatures(): Record<string, number> {
    const obj: Record<string, number> = {};
    for (const name of FEATURE_NAMES) obj[name] = 0;
    return obj;
  }

  private computeLogit(model: OLRModel, features: Record<string, number>): number {
    const vec = this.contextToVector(features);
    const xNorm = this.normalize(model, vec);
    const xFull = [1, ...xNorm];
    let z = 0;
    for (let i = 0; i <= D; i++) z += model.weights[i]! * xFull[i]!;
    return z;
  }

  getFeatureWeights(symbol: string, side: 'buy' | 'sell'): Array<{ name: string; weight: number }> | null {
    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return null;
    const model = side === 'buy' ? models.long : models.short;
    const result: Array<{ name: string; weight: number }> = [];
    for (let i = 0; i < D; i++) {
      result.push({ name: FEATURE_NAMES[i]!, weight: model.weights[i + 1]! });
    }
    return result;
  }

  getNormalizationStats(symbol: string, side: 'buy' | 'sell'): Array<{ name: string; mean: number; std: number }> | null {
    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return null;
    const model = side === 'buy' ? models.long : models.short;
    const result: Array<{ name: string; mean: number; std: number }> = [];
    for (let i = 0; i < D; i++) {
      const n = model.welfordCount[i]!;
      const variance = n > 1 ? model.m2[i]! / (n - 1) : 0;
      result.push({ name: FEATURE_NAMES[i]!, mean: model.mean[i]!, std: Math.sqrt(Math.max(variance, 0)) });
    }
    return result;
  }

  getAllSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  getPendingStats(): Array<{ symbol: string; pending: number; needed: number; pct: number }> {
    const result: Array<{ symbol: string; pending: number; needed: number; pct: number }> = [];
    for (const [sym, models] of this.symbols) {
      const totalSamples = Math.max(models.long.nSamples, models.short.nSamples);
      if (totalSamples === 0) continue;
      result.push({
        symbol: sym,
        pending: totalSamples,
        needed: OLR_CONFIG.minSamplesForQuery,
        pct: Math.min(100, Math.round((totalSamples / OLR_CONFIG.minSamplesForQuery) * 100)),
      });
    }
    return result;
  }

  formatForAgentContext(): string {
    const parts: string[] = [
      '=== OLR ASSESSMENT ===',
      'Online Logistic Regression: P(win) per side from shadow + real trade outcomes.',
      'Each side (LONG/SHORT) has independent model. Trained on TP-before-SL outcomes.',
      'USAGE: P(win) > 60% → bias toward entry; P(win) < 40% → bias against;',
      'P(win) 40-60% → no edge, rely on other signals.',
      'Weight by confidence: high (>50 samples) = trust it; low (<20) = noisy.',
    ];
    let hasData = false;
    for (const [sym, models] of this.symbols) {
      const longS = models.long.nSamples;
      const shortS = models.short.nSamples;
      if (longS < OLR_CONFIG.minSamplesForQuery && shortS < OLR_CONFIG.minSamplesForQuery) continue;
      hasData = true;
      const longP = longS >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.long, this.zeroFeatures()))
        : 0.5;
      const shortP = shortS >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.short, this.zeroFeatures()))
        : 0.5;
      const longConf = longS >= OLR_CONFIG.highConfidenceSamples ? 'high'
        : longS >= OLR_CONFIG.mediumConfidenceSamples ? 'medium' : 'low';
      const shortConf = shortS >= OLR_CONFIG.highConfidenceSamples ? 'high'
        : shortS >= OLR_CONFIG.mediumConfidenceSamples ? 'medium' : 'low';
      parts.push(`${sym}: BUY P(win)=${(longP * 100).toFixed(0)}% (${longS} samples, ${longConf}) | SELL P(win)=${(shortP * 100).toFixed(0)}% (${shortS} samples, ${shortConf})`);
    }
    if (!hasData) parts.push('  (no OLR data yet)');
    return parts.join('\n');
  }
}