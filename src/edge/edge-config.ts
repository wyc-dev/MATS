// ─── Edge Validation Configuration ─────────────────────────────────────
//
// v2.0.833: Centralised config for the Edge Validation layer (Task 1).
// All thresholds + weights + sample floors live here so they can be tuned
// via env vars without touching the math modules. Every constant is
// documented inline because edge math is easy to get wrong and hard to debug.
//
// Design principle: edge config is SEPARATE from risk config (src/config).
// Risk config controls the backend's own account; edge config controls
// signal quality measurement that feeds the analysis matrix written to
// Supabase for the client. The two never share a knob.

import { z } from 'zod';

const edgeEnvSchema = z.object({
  // ── Sample-size caps lifted to 10000 (Task: lift limits) ───────────────
  // See §1.9 of plan.md. These override the hard-coded caps scattered across
  // evolution modules so the learning systems can see 10k recent trades
  // instead of 20–5000. Memory impact is documented in the plan.
  EDGE_TRADE_HISTORY_MAX: z.coerce.number().int().positive().default(10_000),
  EDGE_REPLAY_BUFFER_CAP: z.coerce.number().int().positive().default(10_000),
  EDGE_PATTERN_TAG_MAX: z.coerce.number().int().positive().default(5_000),
  EDGE_SHADOW_RECENT: z.coerce.number().int().positive().default(200),
  EDGE_OLR_RECENT_DISPLAY: z.coerce.number().int().positive().default(100),
  EDGE_AUDIT_RECENT: z.coerce.number().int().positive().default(100),
  EDGE_EM_INSIGHT_VECTORS: z.coerce.number().int().positive().default(5_000),

  // ── Edge Calculator weights (regime-aware) ────────────────────────────
  // Weights sum to 1.0 per regime. 'unknown' regime falls back to uniform.
  // Rationale: trending markets reward directional conviction; mean-reverting
  // markets reward learned + combo signals; chaotic markets reward only
  // realised outcomes (history is the only trustworthy signal in chaos).
  EDGE_WEIGHT_TRENDING: z.string().default('0.35,0.20,0.20,0.10,0.15'),
  EDGE_WEIGHT_MEANREV: z.string().default('0.20,0.25,0.25,0.15,0.15'),
  EDGE_WEIGHT_CHAOTIC: z.string().default('0.10,0.15,0.15,0.10,0.50'),
  EDGE_WEIGHT_UNKNOWN: z.string().default('0.20,0.20,0.20,0.20,0.20'),

  // ── Recommendation thresholds ─────────────────────────────────────────
  // edgeScore ≥ trade  → enter matrix as-is.
  // caution ≤ edgeScore < trade → enter but conviction × stability factor.
  // edgeScore < skip  → force matrix cell to 'hold' (no client acts).
  EDGE_TRADE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  EDGE_CAUTION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
  EDGE_SKIP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),

  // ── Confidence floors (sample counts) ─────────────────────────────────
  // Below HIGH, edgeScore is multiplied by 0.8; below LOW, pulled toward 0.5.
  // These are PER-COMPONENT floors — every component needs its own sample.
  EDGE_CONF_HIGH_SAMPLES: z.coerce.number().int().positive().default(30),
  EDGE_CONF_MEDIUM_SAMPLES: z.coerce.number().int().positive().default(10),

  // ── Stability Monitor ────────────────────────────────────────────────
  // ±5% feature perturbation is standard in ML robustness literature.
  // crossTime flips counted over the last N cycles.
  EDGE_PERTURB_MAGNITUDE: z.coerce.number().min(0).max(0.5).default(0.05),
  EDGE_PERTURB_LOOKBACK: z.coerce.number().int().positive().default(20),
  EDGE_CROSSTIME_LOOKBACK: z.coerce.number().int().positive().default(10),
  // stability ≥ STABLE → factor 1.0; MID → 0.85; < MID → downgrade rec.
  EDGE_STABILITY_STABLE: z.coerce.number().min(0).max(1).default(0.8),
  EDGE_STABILITY_MID: z.coerce.number().min(0).max(1).default(0.5),
  EDGE_STABILITY_FACTOR_MID: z.coerce.number().min(0).max(1).default(0.85),

  // ── Execution Tracker ─────────────────────────────────────────────────
  // Below MIN samples, do not calibrate OLR labels (cold-start safe).
  EDGE_EXEC_MIN_SAMPLES: z.coerce.number().int().positive().default(20),
  EDGE_EXEC_LOOKBACK: z.coerce.number().int().positive().default(200),

  // ── Risk-Profile Edge Store ──────────────────────────────────────────
  // Vector DB ring buffer cap (matches lifted trade-history cap).
  EDGE_RP_STORE_CAP: z.coerce.number().int().positive().default(10_000),
  // Top-K nearest neighbours by cosine similarity.
  EDGE_RP_TOP_K: z.coerce.number().int().positive().default(50),
  // Minimum cosine similarity to count as a match.
  EDGE_RP_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.65),
  // Below MIN_MATCHES, return neutral 0.5 (cold-start safe).
  EDGE_RP_MIN_MATCHES: z.coerce.number().int().positive().default(5),
  // Time-decay half-life in days for weighted WR.
  EDGE_RP_HALF_LIFE_DAYS: z.coerce.number().positive().default(30),
  // Blend: neutral edge vs profile-specific edge. Cold-start (samples < WARM)
  // weights neutral heavily; warm shifts toward profile-specific.
  EDGE_RP_NEUTRAL_WEIGHT: z.coerce.number().min(0).max(1).default(0.6),
  EDGE_RP_PROFILE_WEIGHT: z.coerce.number().min(0).max(1).default(0.4),
  EDGE_RP_WARM_SAMPLES: z.coerce.number().int().positive().default(30),

  // ── Backtest Validation ──────────────────────────────────────────────
  // Walk-forward split: 0.7 = 70% in-sample, 30% out-of-sample.
  EDGE_BTEST_SPLIT: z.coerce.number().min(0.5).max(0.95).default(0.7),
  // Bootstrap iterations for p-value (10000 is standard, Politis & Romano 1994).
  EDGE_BTEST_BOOTSTRAP_N: z.coerce.number().int().positive().default(10_000),
  // Significance level. Below this p-value, we reject "edge = luck".
  EDGE_BTEST_ALPHA: z.coerce.number().min(0).max(1).default(0.05),
});

const raw = edgeEnvSchema.parse(process.env);

/** Parse a comma-separated weight string into a normalised 5-tuple summing to 1. */
function parseWeights(s: string, label: string): [number, number, number, number, number] {
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`[edge-config] invalid ${label} weights: ${s} (expected 5 non-negative numbers)`);
  }
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error(`[edge-config] ${label} weights sum to 0`);
  const norm = parts.map((p) => p / sum) as [number, number, number, number, number];
  return norm;
}

export const edgeConfig = {
  // Lifted sample-size caps (consumed by evolution modules via getters).
  tradeHistoryMax: raw.EDGE_TRADE_HISTORY_MAX,
  replayBufferCap: raw.EDGE_REPLAY_BUFFER_CAP,
  patternTagMax: raw.EDGE_PATTERN_TAG_MAX,
  shadowRecent: raw.EDGE_SHADOW_RECENT,
  olrRecentDisplay: raw.EDGE_OLR_RECENT_DISPLAY,
  auditRecent: raw.EDGE_AUDIT_RECENT,
  emInsightVectors: raw.EDGE_EM_INSIGHT_VECTORS,

  // Edge Calculator
  weights: {
    trending: parseWeights(raw.EDGE_WEIGHT_TRENDING, 'trending'),
    mean_reverting: parseWeights(raw.EDGE_WEIGHT_MEANREV, 'mean_reverting'),
    mean_rev: parseWeights(raw.EDGE_WEIGHT_MEANREV, 'mean_reverting'),
    high_volatility: parseWeights(raw.EDGE_WEIGHT_CHAOTIC, 'chaotic'),
    chaotic: parseWeights(raw.EDGE_WEIGHT_CHAOTIC, 'chaotic'),
    unknown: parseWeights(raw.EDGE_WEIGHT_UNKNOWN, 'unknown'),
  } as Record<string, [number, number, number, number, number]>,
  tradeThreshold: raw.EDGE_TRADE_THRESHOLD,
  cautionThreshold: raw.EDGE_CAUTION_THRESHOLD,
  skipThreshold: raw.EDGE_SKIP_THRESHOLD,
  confHighSamples: raw.EDGE_CONF_HIGH_SAMPLES,
  confMediumSamples: raw.EDGE_CONF_MEDIUM_SAMPLES,

  // Stability Monitor
  perturbMagnitude: raw.EDGE_PERTURB_MAGNITUDE,
  perturbLookback: raw.EDGE_PERTURB_LOOKBACK,
  crossTimeLookback: raw.EDGE_CROSSTIME_LOOKBACK,
  stabilityStable: raw.EDGE_STABILITY_STABLE,
  stabilityMid: raw.EDGE_STABILITY_MID,
  stabilityFactorMid: raw.EDGE_STABILITY_FACTOR_MID,

  // Execution Tracker
  execMinSamples: raw.EDGE_EXEC_MIN_SAMPLES,
  execLookback: raw.EDGE_EXEC_LOOKBACK,

  // Risk-Profile Edge Store
  rpStoreCap: raw.EDGE_RP_STORE_CAP,
  rpTopK: raw.EDGE_RP_TOP_K,
  rpMinSimilarity: raw.EDGE_RP_MIN_SIMILARITY,
  rpMinMatches: raw.EDGE_RP_MIN_MATCHES,
  rpHalfLifeDays: raw.EDGE_RP_HALF_LIFE_DAYS,
  rpNeutralWeight: raw.EDGE_RP_NEUTRAL_WEIGHT,
  rpProfileWeight: raw.EDGE_RP_PROFILE_WEIGHT,
  rpWarmSamples: raw.EDGE_RP_WARM_SAMPLES,

  // Backtest Validation
  btestSplit: raw.EDGE_BTEST_SPLIT,
  btestBootstrapN: raw.EDGE_BTEST_BOOTSTRAP_N,
  btestAlpha: raw.EDGE_BTEST_ALPHA,
} as const;

export type EdgeConfig = typeof edgeConfig;