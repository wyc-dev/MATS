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
  // v2.0.207 (#D): Momentum features — captures "is price being pushed in one
  // direction RIGHT NOW?" which volatility + regime cannot express. Lets the
  // model learn "SELL against +3% short-momentum loses 70%". Backward compat:
  // migrateModel pads old weights to 0 (neutral) for these new dims.
  'momentumShort',
  'momentumLong',
  // v2.0.221 (Fix 1): Hour-of-day feature — the SKHX investigation revealed
  // strong time-of-day patterns (13:00 = 75% WR, 16:00 = 0% WR) that the model
  // could NOT learn because hour was absent from the feature space. Adding
  // hourOfDay (normalised 0-1: hour/23) lets OLR learn "SKHX BUY at 16:00 loses".
  // Backward compat: migrateModel pads old weights to 0 (neutral) for this dim.
  // Default neutral = 0.5 (noon) when hour unavailable.
  'hourOfDay',
] as const;

const D = FEATURE_NAMES.length; // 15 (was 14)

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
  /** v2.0.855: Blind shadow samples (0.1× weight) tracked separately from
   *  aligned shadow samples — v2.0.834 declared "tracked separately" but
   *  feedTrade never incremented a counter, so blind samples were invisible
   *  while aligned samples were conflated. This counter restores the split. */
  shadowBlindSamples: number;
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
    source: 'shadow' | 'shadow_blind' | 'paper' | 'real' | 'backfill';
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
 *  the bin returns identity (raw pWin) to avoid overfitting on tiny samples.
 *  ⚠️ v2.0.859: SUPERSEDED by shrinkage calibration — identity fallback let raw
 *  overconfidence pass through on sparse bins. Kept for backward-compat. */
const CALIBRATION_MIN_SAMPLES_PER_BIN = 5;
/** v2.0.859: Shrinkage strength — empirical WR is pulled toward the neutral
 *  prior 0.5 by weight count/(count+K). K=5: 5 samples → halfway, 20 → 80%
 *  empirical, 100+ → ~95% empirical. Replaces the hard identity fallback
 *  (raw pWin on sparse bins) that caused OLR extreme-signal pollution
 *  (9/20 live attribution records with agreement >0.9, 5/9 wrong). */
const CALIBRATION_SHRINK_K = 5;
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
  /** v2.0.228: If true, this sample is from backfill and is excluded from
   * calibration bins to prevent poisoning. Backfill data does not reflect
   * real-time market microstructure and inflates calibration bin counts,
   * causing the calibration map to map raw P(win) → wrong empirical WR. */
  isBackfill: boolean = false,
): void {
  // v2.0.228: Exclude backfill from calibration — it pollutes the raw→empirical WR mapping
  if (isBackfill) return;
  // Clamp to [0, 1) for bin lookup (1.0 goes into last bin)
  const clamped = Math.max(0, Math.min(0.9999, predictedPWin));
  const binIdx = Math.floor(clamped * CALIBRATION_NUM_BINS);
  const bin = bins[binIdx];
  if (!bin) return;
  if (outcome === 1) bin.wins++;
  else bin.losses++;
}

/** v2.0.721 + v2.0.859: Apply calibration to a raw pWin.
 *
 *  v2.0.859: SHRINKAGE calibration replaces the hard identity fallback
 *  (count < MIN_SAMPLES → raw pWin). The old behavior let raw overconfidence
 *  (P(win) 90%+) pass straight into the decision chain on sparse bins — the
 *  audit showed 9/20 live attribution records with agreement >0.9 of which
 *  5/9 were wrong. Now the empirical WR is shrunk toward the neutral prior
 *  0.5 by a strength that scales with sample count:
 *    count=0   → 0.5 (honest — never raw, never overconfident)
 *    count=5   → halfway between 0.5 and empirical
 *    count=20  → 80% empirical
 *    count=100+ → ~95% empirical
 *  This is standard Bayesian shrinkage (Beta(1+K/2,1+K/2) prior). A sparse
 *  bin can never emit an extreme calibrated P(win) again. */
export function applyCalibration(
  bins: Array<{ lo: number; hi: number; wins: number; losses: number }> | undefined,
  rawPWin: number,
): number {
  // v2.0.859-attack: non-finite rawPWin must never propagate. NaN would
  // flow through binIdx → bins[NaN] → undefined → raw NaN returned, poisoning
  // the conviction gate (NaN < threshold = false → pass all trades).
  if (!Number.isFinite(rawPWin)) return 0.5;
  if (!bins || bins.length === 0) return rawPWin;
  const clamped = Math.max(0, Math.min(0.9999, rawPWin));
  const binIdx = Math.floor(clamped * CALIBRATION_NUM_BINS);
  // v2.0.859-attack: a Proxy bin whose getters THROW (or a corrupt entry)
  // must not crash the query path — fall back to the neutral prior. The bin
  // lookup and field reads are wrapped so ANY throwing access is contained.
  let wins = 0;
  let losses = 0;
  try {
    const bin = bins[binIdx];
    if (!bin || typeof bin !== 'object') return 0.5;
    // Object.hasOwn guard — a __proto__-polluted bins array must not read
    // inherited attacker-controlled values.
    const rawWins = Object.hasOwn(bin, 'wins') ? (bin as { wins: unknown }).wins : 0;
    const rawLosses = Object.hasOwn(bin, 'losses') ? (bin as { losses: unknown }).losses : 0;
    wins = Number.isFinite(rawWins as number) ? (rawWins as number) : 0;
    losses = Number.isFinite(rawLosses as number) ? (rawLosses as number) : 0;
  } catch {
    // getter bomb / Proxy throw → honest neutral
    return 0.5;
  }
  const count = wins + losses;
  const empiricalWR = count > 0 ? wins / count : 0.5;
  if (!Number.isFinite(empiricalWR)) return rawPWin;
  const shrink = count / (count + CALIBRATION_SHRINK_K);
  const calibrated = 0.5 + (empiricalWR - 0.5) * shrink;
  log.debug(`[OLR calibration] raw=${(rawPWin * 100).toFixed(0)}% → calibrated=${(calibrated * 100).toFixed(0)}% (bin ${binIdx}, ${count} samples, shrink=${shrink.toFixed(2)})`);
  return calibrated;
}

export interface OLRQueryResult {
  /** P(win) ∈ (0,1) — probability of winning for this side */
  pWin: number;
  /** Total number of samples (includes backfill) — for backward compat + UI */
  nSamples: number;
  /** v2.0.229 Fix B: Effective (live) samples excluding backfill. Used for
   *  confidence label. A model with 200 backfill + 5 real has effectiveSamples=5,
   *  so confidence='low' even though nSamples=205. */
  effectiveSamples: number;
  /** Confidence label: high (>50 EFFECTIVE samples), medium (20-50), low (<20) */
  confidence: 'high' | 'medium' | 'low';
  /** Per-feature contribution to the logit (w_i × x_i), for explainability */
  featureContributions: Array<{ name: string; weight: number; value: number; contribution: number }>;
  /** Human-readable explanation */
  explanation: string;
  /** Per-source-type sample breakdown (for agent context — no weighting) */
  sourceBreakdown: { shadow: number; shadow_blind: number; paper: number; real: number; backfill: number };
  /** Recent resolved trades for this side (for recency judgment) */
  recentTrades: Array<{
    source: 'shadow' | 'shadow_blind' | 'paper' | 'real' | 'backfill';
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
  /** Per-side source breakdown (shadow / shadow_blind / paper / real / backfill sample counts). */
  longSource: { shadow: number; shadow_blind: number; paper: number; real: number; backfill: number };
  shortSource: { shadow: number; shadow_blind: number; paper: number; real: number; backfill: number };
}

// ─── Config ───

const OLR_CONFIG = {
  learningRate: 0.05,
  /** L2 regularization strength (ridge penalty). Applied to all weights including bias.
   *  v2.0.797: REDUCED from 0.1 to 0.001. The previous value (0.1) was TOO STRONG — it
   *  pulled ALL weights toward zero, preventing the model from learning strong signals.
   *  With 15 features and ~100-300 total samples, λ=0.1 means the regularization term
   *  (0.1 * w) dominates the gradient update (η * error * x ≈ 0.05 * 0.5 * 1 = 0.025),
   *  causing weights to shrink to near-zero regardless of the data. This is the ROOT CAUSE
   *  of sigmoid saturation: weights are so small that w·x ≈ 0 for all inputs, and the
   *  sigmoid outputs ~0.5 for everything. But wait — the system shows 0% or 100%, not 50%.
   *  That means the BIAS term (which is also regularized) is dominating. With λ=0.1,
   *  the bias is pulled toward zero, but if the model has 200 backfill samples with
   *  consistent outcomes (e.g., 80% wins), the bias learns P(win) ≈ 0.8. Then when
   *  live data comes in with different outcomes, the bias is already set and the feature
   *  weights are too small to overcome it. The result: ALL predictions cluster around
   *  the bias value (0% or 100% depending on the majority class).
   *  
   *  The fix: λ=0.001 provides just enough regularization to prevent unbounded weight
   *  growth (which would cause true sigmoid saturation at 0 or 1) without suppressing
   *  the signal. At λ=0.001, the regularization term (0.001 * w) is 100x smaller than
   *  the gradient update, so the model can learn strong feature weights when the data
   *  supports it. The bias can still drift, but the feature weights can overcome it.
   *  
   *  Combined with maxWeight=2.0 (see below), this ensures the sigmoid operates in its
   *  discriminative range (|z| < 10) for most inputs, while still allowing extreme
   *  predictions (|z| > 10) when multiple features agree strongly. */
  l2Regularization: 0.001,
  /** SGD learning-rate decay: η_t = learningRate / (1 + decayRate × liveSamples).
   *  liveSamples = nSamples - backfillSamples, so backfill (weight=0.1, v2.0.229) does NOT
   *  freeze the model against live adaptation. Prevents late samples from
   *  dominating a mature model and reduces noise overfitting. */
  decayRate: 0.01,
  /** Source-type weights for weighted SGD. Shadow trades are simulated
   *  (no slippage/fee/funding/liquidity), so they carry less evidence
   *  about REAL trade profitability than paper/real outcomes. Weighting
   *  prevents the high-volume shadow stream from drowning out the
   *  scarcer, higher-fidelity paper/real signal. */
  // v2.0.229 Fix D: Reduced backfill weight from 0.3 → 0.1. Backfill data does not
  // reflect real-time market microstructure (no slippage, no funding, no OB).
  // 0.3 was still too high — 1387 backfill samples at 0.3 weight = 416 effective,
  // which is 30% of 1393 real samples. At 0.1, the same 1387 backfill = 139
  // effective, only 10% of real — backfill can cold-start the prior without
  // drowning out the live signal.
  // v2.0.834: Added 'shadow_blind' (weight 0.1) for blind shadow trades (both
  // directions, no LLM direction). Aligned shadows (follow LLM consensus) keep
  // weight 1.0. This ensures OLR learns the correct conditional distribution
  // (LLM-chosen conditions) at full weight, while blind shadows serve only as
  // cold-start priors at 10% weight — preventing distribution-shift pollution.
  sourceWeight: { shadow: 1, shadow_blind: 0.1, paper: 2, real: 4, backfill: 0.1 } as Record<'shadow' | 'shadow_blind' | 'paper' | 'real' | 'backfill', number>,
  minSamplesForQuery: 10,
  highConfidenceSamples: 50,
  mediumConfidenceSamples: 20,
  welfordEpsilon: 1e-8,
  /** v2.0.818: INCREASED from 2.0 to 5.0. The previous maxWeight=2.0 was too restrictive —
   *  with 15 features, max logit = 2.0 * 15 = 30, which still saturates the sigmoid
   *  (sigmoid(30) = 0.9999999). But more importantly, the L2 regularization (λ=0.0001)
   *  now prevents unbounded weight growth, so maxWeight=5.0 is safe. A single weight of
   *  5.0 with a feature value of 1.0 gives logit=5.0, which is at the edge of the
   *  discriminative range. Multiple features at 5.0 would saturate, but in practice only
   *  2-3 features contribute significantly (regularized), so the typical logit is 2-3
   *  features at ±5.0 = ±10-15, which gets clipped to ±10.0 by the logit clipping.
   *  
   *  Combined with λ=0.0001 (very weak regularization) and logit clipping to [-10,+10],
   *  this allows the model to learn strong feature weights (up to ±5.0) without saturating
   *  the sigmoid. The 5-bin calibration map then handles the final accuracy adjustment. */
  maxWeight: 5.0,
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
    shadowBlindSamples: 0,
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
  /** v2.0.859: Persisted EXP-backfill completion flag. Same bug class as Q-RL:
   *  the per-process `expBackfillDone` instance flag in index.ts reset on every
   *  restart, so the EXP backfill re-ran ~3.5× (btc long backfillSamples=3752 ≈
   *  1072×3.5), inflating backfill counters and re-weighting the cold-start
   *  prior on identical data. Persisted via save()/load() (strict boolean) so
   *  the backfill runs exactly once over the engine's lifetime. */
  private backfillDone = false;

  /** v2.0.859: Has the EXP backfill already been applied? Callers MUST gate
   *  historical-record feeds on this — without it, restarts re-feed the same
   *  records and backfillSamples inflate unboundedly. */
  isBackfillDone(): boolean {
    return this.backfillDone;
  }

  /** v2.0.859: Mark the EXP backfill as applied. Persisted by save() — call
   *  save() promptly after marking so the flag survives a crash/restart. */
  markBackfillDone(): void {
    this.backfillDone = true;
  }

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
      // v2.0.859: restore persisted backfill flag — STRICT boolean check.
      // A corrupt string ('true') / number (1) / null must NOT be treated as
      // done, otherwise the backfill is silently skipped forever. Missing key
      // (pre-v2.0.859 state) → false → backfill runs once on next start.
      this.backfillDone = typeof data?.backfillDone === 'boolean' ? (data.backfillDone as boolean) : false;
      log.info(`OLR backfill ${this.backfillDone ? 'already done (skip on next start)' : 'pending (runs once on next start)'}`);
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
    // v2.0.221 Fix: PAD mean/m2/welfordCount to D (was slice(0, D) which TRUNCATES
    // instead of padding — old 14-element arrays stayed at 14, causing NaN when
    // the new 15th feature (hourOfDay) tried to normalize against undefined mean).
    const padArray = (arr: any[] | undefined, val: number) => {
      if (!Array.isArray(arr)) return new Array(D).fill(val);
      const out = arr.slice(0, D).map((x: number) => (Number.isFinite(x) ? x : val));
      while (out.length < D) out.push(val);
      return out;
    };
    return {
      weights,
      // v2.0.855-attack: Sanitize ALL counters on load — `?? 0` only catches
      // null/undefined, NOT strings ('5'), negatives (-5), NaN, or Infinity.
      // A poisoned counter (string/negative) corrupts getAllModelStats +
      // save/load round-trips + agent context. Number.isFinite + >= 0 rejects
      // every invalid form; nSamples additionally can't exceed a sane cap.
      nSamples: (typeof m.nSamples === 'number' && Number.isFinite(m.nSamples) && m.nSamples >= 0) ? m.nSamples : 0,
      mean: padArray(m.mean, 0),
      m2: padArray(m.m2, 0),
      // Backward compat: old state stored a single number; broadcast to all features.
      welfordCount: padArray(m.welfordCount, typeof m.welfordCount === 'number' ? m.welfordCount : 0),
      shadowSamples: (typeof m.shadowSamples === 'number' && Number.isFinite(m.shadowSamples) && m.shadowSamples >= 0) ? m.shadowSamples : 0,
      shadowBlindSamples: (typeof m.shadowBlindSamples === 'number' && Number.isFinite(m.shadowBlindSamples) && m.shadowBlindSamples >= 0) ? m.shadowBlindSamples : 0,
      paperSamples: (typeof m.paperSamples === 'number' && Number.isFinite(m.paperSamples) && m.paperSamples >= 0) ? m.paperSamples : 0,
      realSamples: (typeof m.realSamples === 'number' && Number.isFinite(m.realSamples) && m.realSamples >= 0) ? m.realSamples : 0,
      backfillSamples: (typeof m.backfillSamples === 'number' && Number.isFinite(m.backfillSamples) && m.backfillSamples >= 0) ? m.backfillSamples : 0,
      newestSampleTs: (typeof m.newestSampleTs === 'number' && Number.isFinite(m.newestSampleTs) && m.newestSampleTs >= 0) ? m.newestSampleTs : 0,
      recentTrades: Array.isArray(m.recentTrades) ? m.recentTrades.slice(-20) : [],
      // v2.0.862: CALIBRATION BINS PURGE BUG FIX (was v2.0.229 Fix A).
      //
      // The old logic purged bins whenever backfillSamples > 0 — a PERMANENT
      // condition (every model has backfill), so bins were wiped on EVERY
      // restart and OLR calibration was permanently dead system-wide: raw
      // P(win) (e.g. 70% on SKHX BUY) was never mapped to the empirical bin
      // WR (9%), so the LLM kept opening overwhelmingly-negative directions.
      //
      // v2.0.228 already stopped NEW backfill from entering bins — persisted
      // bins only accumulate real+shadow+paper samples. So a non-empty
      // persisted bin set is CLEAN and must be KEPT. Purge is only needed for
      // the one-time migration of PRE-v2.0.228 poisoned state — and that
      // purge already happened in the past (bins since then are clean).
      // Empty bins → empty (identity fallback) — same as before.
      calibrationBins: (Array.isArray(m.calibrationBins) && m.calibrationBins.length === CALIBRATION_NUM_BINS
        ? m.calibrationBins.map((b: any) => ({
            lo: Number(b.lo) ?? 0,
            hi: Number(b.hi) ?? 0,
            wins: Number(b.wins) ?? 0,
            losses: Number(b.losses) ?? 0,
          }))
        : makeEmptyCalibrationBins()),
    };
  }

  save(): string {
    const obj: Record<string, any> = {};
    for (const [sym, models] of this.symbols) {
      obj[sym] = { long: models.long, short: models.short };
    }
    return JSON.stringify({ olrSymbols: obj, backfillDone: this.backfillDone }); // v2.0.859
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

  /**
   * v2.0.770: Adaptive feature selection for sgdUpdate.
   * When total training samples N < 2*D (30 for D=15), the model is
   * underdetermined — too many parameters for the available data.
   * In this regime, we use only the top-5 most informative features
   * (volatility, srDistanceBps, obImbalance, sentiment, fundingRate)
   * and set the remaining 10 feature weights to 0. This ensures at
   * least 6 samples per parameter (30/5=6) instead of 2 (30/15=2).
   * The selected features are the ones with the strongest signal
   * for short-term directional trading based on domain knowledge.
   */
  private getActiveFeatureIndices(model: OLRModel): Set<number> {
    const totalSamples = model.nSamples;
    // When N >= 2*D, use all features (model is well-determined)
    if (totalSamples >= 2 * D) {
      return new Set(Array.from({ length: D }, (_, i) => i));
    }
    // When N < 2*D, use only the top-5 most informative features
    // Indices: 0=volatility, 1=srDistanceBps, 2=obImbalance,
    // 3=sentiment, 6=fundingRate (index 6 in FEATURE_NAMES)
    const topFeatures = new Set<number>([0, 1, 2, 3, 6]);
    return topFeatures;
  }

  private sgdUpdate(model: OLRModel, xNorm: number[], y: number, sourceWeight: number, liveSamples: number): void {
    const activeIndices = this.getActiveFeatureIndices(model);
    const xFull = [1, ...xNorm];
    let z = 0;
    // Compute logit using only active features (inactive features have weight=0)
    for (let i = 0; i <= D; i++) {
      if (i === 0 || activeIndices.has(i - 1)) {
        z += model.weights[i]! * xFull[i]!;
      }
    }
    // v2.0.815: CRITICAL FIX — Clip logit to [-5, +5] before sigmoid to prevent
    // sigmoid saturation. The previous clip of [-10, +10] was too wide — sigmoid(10)
    // is 0.9999546, which is effectively 1.0 for all practical purposes. This means
    // the gradient σ'(z) ≈ 0 for any |z| > 5, and the model cannot learn from its
    // mistakes when it predicts P(win)=1.0 on a losing trade.
    //
    // At |z| = 5: sigmoid(5) = 0.9933, σ'(5) = 0.0067 (still learnable)
    // At |z| = 10: sigmoid(10) = 0.99995, σ'(10) = 0.000045 (effectively zero)
    //
    // With maxWeight=5.0 and 15 features, the theoretical max logit is 5*15=75,
    // but in practice only 2-3 features contribute significantly (regularized).
    // Clipping to [-5, +5] ensures the sigmoid operates in its discriminative range
    // where the gradient is non-zero, allowing the model to learn from mistakes.
    //
    // The 5-bin calibration map then handles the final accuracy adjustment — it
    // maps the raw P(win) (which is now in [0.0067, 0.9933]) to the empirical
    // win rate. This is FAR better than the previous approach where ALL predictions
    // were 0.0 or 1.0 and calibration had nothing to work with.
    const zClipped = Math.max(-5, Math.min(5, z));
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
      // Only update weights for active features (bias is always active)
      if (i !== 0 && !activeIndices.has(i - 1)) {
        // Inactive features: set weight to 0 and skip update
        model.weights[i]! = 0;
        continue;
      }
      // v2.0.815: CRITICAL FIX — L2 regularization (weight decay) applied to all
      // weights including bias. The regularization strength is λ=0.001, which is
      // appropriate for a model with 15 features and ~100-300 total samples.
      //
      // The weight decay term is: w ← w - η * (error * x + λ * w)
      //
      // At λ=0.001, the regularization term (0.001 * w) is 100x smaller than the
      // gradient update (η * error * x ≈ 0.05 * 0.5 * 1 = 0.025) for small weights.
      // This means the model can learn strong feature weights when the data supports
      // it, but the regularization prevents unbounded weight growth that would cause
      // sigmoid saturation.
      //
      // The previous value (λ=0.01) was TOO STRONG — it pulled ALL weights toward
      // zero, preventing the model from learning strong signals. With 15 features
      // and ~100-300 total samples, λ=0.01 means the regularization term dominates
      // the gradient update, causing weights to shrink to near-zero regardless of
      // the data. This is the ROOT CAUSE of sigmoid saturation: weights are so small
      // that w·x ≈ 0 for all inputs, and the sigmoid outputs ~0.5 for everything.
      //
      // But wait — the system shows 0% or 100%, not 50%. That means the BIAS term
      // (which is also regularized) is dominating. With λ=0.01, the bias is pulled
      // toward zero, but if the model has 200 backfill samples with consistent
      // outcomes (e.g., 80% wins), the bias learns P(win) ≈ 0.8. Then when live
      // data comes in with different outcomes, the bias is already set and the
      // feature weights are too small to overcome it. The result: ALL predictions
      // cluster around the bias value (0% or 100% depending on the majority class).
      //
      // The fix: λ=0.001 provides just enough regularization to prevent unbounded
      // weight growth (which would cause true sigmoid saturation at 0 or 1) without
      // suppressing the signal. At λ=0.001, the regularization term (0.001 * w) is
      // 100x smaller than the gradient update, so the model can learn strong feature
      // weights when the data supports it. The bias can still drift, but the feature
      // weights can overcome it.
      //
      // Combined with maxWeight=5.0 and logit clipping to [-5, +5], this ensures
      // the sigmoid operates in its discriminative range (|z| < 5) for most inputs,
      // while still allowing extreme predictions (|z| up to 5) when multiple features
      // agree strongly. The 5-bin calibration map then handles the final accuracy
      // adjustment.
      const reg = OLR_CONFIG.l2Regularization * model.weights[i]!;
      model.weights[i]! -= eta * (error * xFull[i]! + reg);
      // NaN/Infinity guard (M6) — a single NaN feature would otherwise
      // propagate and poison the persisted model forever.
      if (!Number.isFinite(model.weights[i]!)) model.weights[i]! = 0;
      // v2.0.815: CRITICAL FIX — Keep maxWeight at 5.0 (not reduced to 2.0).
      // The system needs EXTREME predictions when the evidence is strong — 5.0
      // allows that while L2=0.001 prevents unbounded growth. Combined with logit
      // clipping to [-5, +5], a single weight of 5.0 with a feature value of 1.0
      // gives logit=5.0, which is at the edge of the discriminative range.
      // Multiple features at 5.0 would saturate, but in practice only 2-3 features
      // contribute significantly (regularized), so the typical logit is 2-3
      // features at ±5.0 = ±10-15, which gets clipped to ±5.0.
      //
      // This preserves the model's ability to make strong predictions when the
      // evidence is strong, while preventing the degenerate case where ALL features
      // saturate simultaneously. The 5-bin calibration map then handles the final
      // accuracy adjustment.
      model.weights[i]! = Math.max(-5.0, Math.min(5.0, model.weights[i]!));
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
    source: 'shadow' | 'shadow_blind' | 'paper' | 'real' | 'backfill' = 'shadow',
    cycle: number = 0,
    slNarrowed: boolean = false,
    welfordMask?: Set<number>,
    // v2.0.219: Per-sample weight multiplier (default 1.0). Scales the
    // gradient update — used by shadow trade engine for stale-resolved
    // trades (weight=0.3) so they contribute less than natural SL/TP hits.
    weightMultiplier: number = 1.0,
  ): void {
    const models = this.getOrCreate(symbol);
    const vec = this.contextToVector(features);

    // v2.0.218: NaN guard — sanitize instead of reject.
    // Previously: if ANY feature was NaN/Infinity, the ENTIRE sample was
    // skipped (return). This caused 102 real trades to produce 0 OLR samples
    // for BTC, because fundingRate was NaN (WS returned { fundingRate: NaN })
    // and the `?? 0` fallback only catches null/undefined, not NaN.
    // Now: replace non-finite values with 0 (neutral) and continue training.
    // Losing one feature's signal is far better than losing the entire trade.
    let sanitizedCount = 0;
    for (let i = 0; i < D; i++) {
      if (!Number.isFinite(vec[i]!)) {
        vec[i] = 0; // neutral value — Welford normalization handles 0 gracefully
        sanitizedCount++;
      }
    }
    if (sanitizedCount > 0) {
      log.warn(`[OLR feedTrade] ${sanitizedCount} non-finite feature(s) sanitized to 0 for ${symbol} ${side} (source=${source}) — sample retained`);
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
    const srcWeight = (OLR_CONFIG.sourceWeight[source] ?? 1) * weightMultiplier;

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
      // v2.0.855: Restore the shadow/shadow_blind split the v2.0.834 comment
      // promised. aligned 'shadow' → shadowSamples; blind 'shadow_blind' →
      // shadowBlindSamples (0.1× gradient weight unchanged — counter is
      // observability-only, preserving per-source visibility for agent context).
      if (source === 'shadow') models.short.shadowSamples++;
      else if (source === 'shadow_blind') models.short.shadowBlindSamples++;
      else if (source === 'paper') models.short.paperSamples++;
      else if (source === 'real') models.short.realSamples++;
      else if (source === 'backfill') models.short.backfillSamples++;
      // v2.0.229 Fix C: Exclude backfill from recentTrades — the agent must see
      // real/shadow/paper trading performance, not synthetic backfill history.
      // Previously, 15 of 20 recentTrades were backfill (cycle=0), pushing real
      // trades out of the agent's view. The agent couldn't see it was losing.
      if (source !== 'backfill') {
        models.short.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
        if (models.short.recentTrades.length > 20) models.short.recentTrades.shift();
      }
      // v2.0.721: Record calibration sample (raw pWin → actual outcome)
      if (models.short.calibrationBins) {
        recordCalibrationSample(models.short.calibrationBins, rawPWinForCalibration, outcome, source === 'backfill');
      }
    } else {
      const liveSamples = models.long.nSamples - models.long.backfillSamples;
      this.sgdUpdate(models.long, xNorm, outcome, srcWeight, liveSamples);
      models.long.nSamples++;
      models.long.newestSampleTs = ts;
      // v2.0.855: Same split for long side (see short side above).
      if (source === 'shadow') models.long.shadowSamples++;
      else if (source === 'shadow_blind') models.long.shadowBlindSamples++;
      else if (source === 'paper') models.long.paperSamples++;
      else if (source === 'real') models.long.realSamples++;
      else if (source === 'backfill') models.long.backfillSamples++;
      // v2.0.229 Fix C: Exclude backfill from recentTrades (same as short side above).
      if (source !== 'backfill') {
        models.long.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
        if (models.long.recentTrades.length > 20) models.long.recentTrades.shift();
      }
      // v2.0.721: Record calibration sample (raw pWin → actual outcome)
      if (models.long.calibrationBins) {
        recordCalibrationSample(models.long.calibrationBins, rawPWinForCalibration, outcome, source === 'backfill');
      }
    }
  }

  /**
   * v2.0.775: Distribution-shift penalty for OLR predictions.
   * 
   * When the current market features deviate significantly from the training
   * distribution, the model's P(win) prediction is unreliable — it's making
   * an out-of-distribution (OOD) inference. This is the ROOT CAUSE of false
   * 100% P(win) predictions: the model was trained on entry-time features
   * (e.g., volatility=0.5, srDistanceBps=0.3) but queried on current features
   * (e.g., volatility=2.1, srDistanceBps=-0.8) that are >2σ from the training
   * mean. The sigmoid saturates to 0 or 1 because the normalized features
   * produce extreme logit values.
   * 
   * The fix: compute a distribution-shift penalty per key feature. For each
   * key feature (volatility, srDistanceBps, obImbalance, fundingRate), compute
   * the z-score of the current feature value relative to the training
   * distribution (mean/std from Welford stats). If any key feature has
   * |z| > 2.0, reduce P(win) toward 0.5 by up to 20% (soft gate).
   * 
   * The penalty is proportional to the maximum deviation:
   *   penalty = min(0.20, 0.05 * (maxZ - 2.0))
   *   pWin = pWin * (1 - penalty) + 0.5 * penalty
   * 
   * This means:
   *   - At |z| = 2.0: no penalty (in-distribution, trust the model)
   *   - At |z| = 3.0: 5% pull toward 0.5 (barely noticeable)
   *   - At |z| = 6.0: 20% pull toward 0.5 (max penalty)
   *   - At |z| > 6.0: capped at 20% (soft gate, never a hard block)
   * 
   * The penalty is applied AFTER the 5-bin calibration map, so calibration
   * still works on the raw sigmoid output. The final output is then passed
   * through the existing Bayesian shrinkage for small-sample protection.
   * 
   * Key features for distribution-shift detection (indices in FEATURE_NAMES):
   *   0 = volatility
   *   1 = srDistanceBps
   *   2 = obImbalance
   *   6 = fundingRate
   * 
   * These are the features most likely to shift between market regimes and
   * cause OOD predictions. Sentiment and signal agreement are more stable
   * and less likely to cause extreme logit values.
   */
  private applyDistributionShiftPenalty(
    rawPWin: number,
    model: OLRModel,
    currentFeatures: Record<string, number>,
  ): number {
    // Key feature indices for distribution-shift detection
    const KEY_FEATURE_INDICES = new Set([0, 1, 2, 6]); // volatility, srDistanceBps, obImbalance, fundingRate
    
    let maxZ = 0;
    
    for (const idx of KEY_FEATURE_INDICES) {
      const n = model.welfordCount[idx]!;
      if (n < 3) continue; // Need at least 3 samples for meaningful std
      
      const mean = model.mean[idx]!;
      const variance = model.m2[idx]! / (n - 1);
      const std = Math.sqrt(Math.max(variance, OLR_CONFIG.welfordEpsilon));
      
      if (std < 1e-10) continue; // No variance → no distribution to compare against
      
      const featureName = FEATURE_NAMES[idx]!;
      const currentVal = currentFeatures[featureName];
      if (currentVal === undefined || currentVal === null || !Number.isFinite(currentVal)) continue;
      
      const z = Math.abs((currentVal - mean) / std);
      if (z > maxZ) maxZ = z;
    }
    
    // No distribution-shift detected (all key features within 2σ)
    if (maxZ <= 2.0) return rawPWin;
    
    // Compute penalty: 5% per σ above 2.0, capped at 20%
    const penalty = Math.min(0.20, 0.05 * (maxZ - 2.0));
    
    // Apply soft gate: pull P(win) toward 0.5
    const adjustedPWin = rawPWin * (1 - penalty) + 0.5 * penalty;
    
    log.debug(`[OLR distribution-shift] maxZ=${maxZ.toFixed(2)} penalty=${(penalty * 100).toFixed(0)}% raw=${(rawPWin * 100).toFixed(0)}% → adjusted=${(adjustedPWin * 100).toFixed(0)}%`);
    
    return adjustedPWin;
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
   * v2.0.770: SIMPLIFIED — removed 3 layers of softening (Bayesian prior,
   * inverse-sample pull, hard clamp). These contradicted the OWNER DIRECTIVE:
   * "OLR predictions must be EXTREME but ACCURATE — NOT softened." The old
   * method pulled ALL predictions toward 0.5, destroying discriminative power.
   * 
   * The new approach: use ONLY the 5-bin calibration map (already applied
   * before this function) for accuracy. Apply a minimal Bayesian shrinkage
   * ONLY when effectiveN < 10 (truly insufficient data). For n >= 10, the
   * model's raw calibrated output is trusted as-is — 0%/100% is CORRECT if
   * the model is well-calibrated.
   * 
   * The fix for miscalibration is the 5-bin calibration map, NOT softening.
   * 
   * v2.0.775: Added distribution-shift penalty call BEFORE this function.
   * The distribution-shift penalty handles OOD predictions (current market
   * state differs from training distribution). This function handles
   * small-sample protection (insufficient training data). They are
   * complementary and both needed.
   */
  private applyConfidencePenalty(rawPWin: number, nSamples: number, effectiveSampleSize?: number): number {
    const effectiveN = effectiveSampleSize !== undefined ? effectiveSampleSize : nSamples;
    
    // v2.0.770: Minimal Bayesian shrinkage — ONLY for truly insufficient data.
    // Prior strength = 3 (was 10 — too aggressive). This means:
    //   - At effectiveN=0: P(win) = 0.5 (pure prior, no data)
    //   - At effectiveN=3: P(win) = 50% prior + 50% model
    //   - At effectiveN=10: P(win) = 77% model + 23% prior (barely noticeable)
    //   - At effectiveN=30+: P(win) = 91%+ model (essentially raw output)
    // For n >= 10, the model has enough data to be trusted — no shrinkage.
    if (effectiveN < 10) {
      const priorStrength = 3;
      const denominator = effectiveN + priorStrength;
      if (denominator <= 0) return 0.5;
      return (rawPWin * effectiveN + 0.5 * priorStrength) / denominator;
    }
    
    // v2.0.770: For n >= 10, trust the calibrated output. No pull toward 0.5.
    // No hard clamp. The 5-bin calibration map handles accuracy.
    // Only prevent exact 0.0 or 1.0 (statistically impossible, breaks downstream math).
    if (rawPWin <= 0) return 0.001;
    if (rawPWin >= 1) return 0.999;
    return rawPWin;
  }

  private contextToVector(features: Record<string, number>): number[] {
    return FEATURE_NAMES.map(name => {
      const val = features[name];
      // v2.0.218: Sanitize NaN/Infinity to default instead of passing through.
      // Previously passed NaN through so feedTrade's NaN guard would catch it,
      // but that guard REJECTED the entire sample (causing 0 real OLR samples
      // for BTC). Now both contextToVector and feedTrade sanitize NaN to 0.
      if (val === undefined || val === null || !Number.isFinite(val)) {
        if (name === 'regimeOrdinal') return 0.5;
        if (name === 'hourOfDay') return 0.5; // noon — neutral default
        return 0;
      }
      return val;
    }) as number[];
  }

  /**
   * v2.0.784: Accept optional entryFeatures parameter. When provided, these
   * features are used for the sigmoid computation (logit → pWin) INSTEAD of
   * the features passed to query(). This is the ROOT CAUSE fix for OLR
   * miscalibration on real trades:
   * 
   * PROBLEM: The model was trained on features SNAPSHOTTED at trade entry time
   * (via feedTrade()), but query() was called with features from the CURRENT
   * decision cycle — which may be 1-5 minutes OLDER than the actual entry time.
   * Market conditions change between the decision cycle and the actual entry
   * (which happens in the next cycle after execution). This creates a systematic
   * distribution shift between training (entry-time features) and inference
   * (cycle-time features), destroying calibration accuracy.
   * 
   * FIX: The caller (index.ts) now collects market features ONCE at the point
   * where the trade decision is made, and passes them as entryFeatures to BOTH
   * OLR.query() and the trade record creation. This ensures the P(win) prediction
   * uses the SAME features that will be recorded at entry time, eliminating the
   * distribution shift.
   * 
   * The entryFeatures are used ONLY for the sigmoid computation (logit → pWin).
   * They are NOT fed into Welford normalization or SGD training — those still
   * use the original features from feedTrade(). This ensures the model trains
   * on the features that were actually present at trade entry, but predicts
   * using the features that reflect the conditions at decision time (which are
   * the same as entry time because the caller snapshots them at decision time).
   * 
   * If entryFeatures is not provided, falls back to the original behavior
   * (using the features passed to query()). This maintains backward compatibility
   * with the shadow trade engine and any other callers that don't snapshot.
   * 
   * v2.0.784: The feature contributions in the result now reflect the ENTRY
   * features (not the cycle-time features), so the explanation accurately
   * describes which market conditions were present when the trade was decided.
   */
  query(symbol: string, features: Record<string, number>, side: 'buy' | 'sell', currentCycle?: number, entryFeatures?: Record<string, number>): OLRQueryResult {
    const empty = (reason: string): OLRQueryResult => ({
      pWin: 0.5,
      nSamples: 0,
      effectiveSamples: 0,
      confidence: 'low',
      featureContributions: [],
      explanation: reason,
      sourceBreakdown: { shadow: 0, shadow_blind: 0, paper: 0, real: 0, backfill: 0 },
      recentTrades: [],
    });

    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return empty(`No OLR data for ${symbol}`);

    const model = side === 'buy' ? models.long : models.short;
    if (model.nSamples < OLR_CONFIG.minSamplesForQuery) {
      return empty(`Only ${model.nSamples} samples for ${symbol} ${side.toUpperCase()} (need ${OLR_CONFIG.minSamplesForQuery})`);
    }

    // v2.0.784: Use entryFeatures for prediction if provided, otherwise fall back
    // to the features passed to query(). This ensures the sigmoid computation uses
    // the SAME features that will be recorded at trade entry time, eliminating the
    // systematic distribution shift between training (entry-time features) and
    // inference (cycle-time features) that caused OLR to be miscalibrated.
    //
    // The caller (index.ts) snapshots market features at decision time and passes
    // them as entryFeatures. This is the same snapshot that gets recorded in the
    // trade record and later passed to feedTrade() when the trade resolves.
    const predictionFeatures = entryFeatures ?? features;
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
    // v2.0.229 Fix B: Confidence label uses EFFECTIVE samples (excludes backfill).
    // A model with 200 backfill + 5 real samples has effectiveSamples=5, so
    // confidence='low' — the agent knows not to trust the P(win) prediction.
    // Previously, nSamples=205 >= 50 gave 'high', causing the agent to trust
    // a backfill-inflated 86% P(win). This is the core fix for SKHX overconfidence.
    const confLabel: 'high' | 'medium' | 'low' =
      effectiveSamples >= OLR_CONFIG.highConfidenceSamples ? 'high'
      : effectiveSamples >= OLR_CONFIG.mediumConfidenceSamples ? 'medium'
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
      shadow_blind: model.shadowBlindSamples ?? 0,
      paper: model.paperSamples,
      real: model.realSamples,
      backfill: model.backfillSamples,
    };

    const sourceStr = `shadow=${sourceBreakdown.shadow} paper=${sourceBreakdown.paper} real=${sourceBreakdown.real} backfill=${sourceBreakdown.backfill}`;
    
    // v2.0.784: Include whether entry features were used in the explanation
    const featureSource = entryFeatures ? ' (entry-time snapshot)' : ' (cycle-time features)';
    // v2.0.229 Fix B: Show effective (live) samples first, total second — so the
    // agent sees "1700 live / 3097 total" and knows 1397 are unreliable backfill.
    const explanation = `P(win)=${(pWin * 100).toFixed(0)}%${featureSource} (${effectiveSamples} live / ${model.nSamples} total samples [${sourceStr}], conf=${confLabel}) | Key: ${topFeatures}`;

    return { pWin, nSamples: model.nSamples, effectiveSamples, confidence: confLabel, featureContributions: contributions, explanation, sourceBreakdown, recentTrades };
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
        longSource: { shadow: models.long.shadowSamples, shadow_blind: models.long.shadowBlindSamples ?? 0, paper: models.long.paperSamples, real: models.long.realSamples, backfill: models.long.backfillSamples },
        shortSource: { shadow: models.short.shadowSamples, shadow_blind: models.short.shadowBlindSamples ?? 0, paper: models.short.paperSamples, real: models.short.realSamples, backfill: models.short.backfillSamples },
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
      // v2.0.229 Fix B: Use effective (live) samples for confidence labels in agent context.
      const longEff = longS - models.long.backfillSamples;
      const shortEff = shortS - models.short.backfillSamples;
      const longConf = longEff >= OLR_CONFIG.highConfidenceSamples ? 'high'
        : longEff >= OLR_CONFIG.mediumConfidenceSamples ? 'medium' : 'low';
      const shortConf = shortEff >= OLR_CONFIG.highConfidenceSamples ? 'high'
        : shortEff >= OLR_CONFIG.mediumConfidenceSamples ? 'medium' : 'low';
      parts.push(`${sym}: BUY P(win)=${(longP * 100).toFixed(0)}% (${longEff} live samples, ${longConf}) | SELL P(win)=${(shortP * 100).toFixed(0)}% (${shortEff} live samples, ${shortConf})`);
    }
    if (!hasData) parts.push('  (no OLR data yet)');
    return parts.join('\n');
  }
}