// ─── Evolution Shared Utilities ───
// Shared helpers extracted from pattern-tag-tracker, trade-pattern-classifier,
// thesis-experience, and experience-digester to eliminate duplication.

import type { RationaleCategory } from '../types/index.ts';
import type { NumericEmbedProvider } from './numeric-autoencoder.ts';

// ─── v2.0.218: NaN-safe number coercion ───
//
// The `??` (nullish coalescing) operator ONLY catches null/undefined — it does
// NOT catch NaN or Infinity. This caused a critical bug where features like
// `fundingRate = getLatestMarkPrice()?.fundingRate ?? 0` resolved to NaN
// (because the WS returned `{ fundingRate: NaN }`), bypassed the `?? 0` fallback,
// and triggered the OLR NaN guard which REJECTED THE ENTIRE SAMPLE. Result:
// 102 real trades → 0 real OLR samples for BTC, 5 for SKHX, 1 for SILVER.
//
// `safeNum()` catches ALL non-finite values (null, undefined, NaN, ±Infinity)
// and returns the provided default. Use this instead of `?? 0` for ALL
// feature computations that feed into learning systems (OLR, NA, CHR, AttnRes).

/** Coerce a value to a finite number, returning `fallback` for any non-finite input. */
export function safeNum(val: number | null | undefined, fallback: number): number {
  return val !== null && val !== undefined && Number.isFinite(val) ? val : fallback;
}

/**
 * Sanitize a features object: replace any non-finite value with its fallback.
 * Returns a new object — does not mutate the input.
 * @param features - Raw feature object (may contain NaN/Infinity/null/undefined)
 * @param defaults - Default values for each feature key
 * @returns Sanitized feature object with all values finite
 */
export function sanitizeFeatures(
  features: Record<string, number>,
  defaults: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const allKeys = new Set([...Object.keys(features), ...Object.keys(defaults)]);
  let sanitized = 0;
  const sanitizedKeys: string[] = [];
  for (const k of allKeys) {
    const raw = features[k];
    const def = defaults[k] ?? 0;
    const safe = raw !== null && raw !== undefined && Number.isFinite(raw) ? raw : def;
    if (safe !== raw) {
      sanitized++;
      sanitizedKeys.push(k);
    }
    out[k] = safe;
  }
  if (sanitized > 0) {
    // Return sanitized info via a property for logging (non-enumerable to avoid serialization)
    Object.defineProperty(out, '_sanitized', { value: sanitizedKeys, enumerable: false });
  }
  return out;
}

// ─── Wilson Score (95% confidence lower bound) ───
// Penalises small sample sizes — 3/5 = 60% becomes ~25%, 30/50 = 60% stays ~47%.
// Prevents overfitting on tiny match counts.

export function wilsonScore(wins: number, total: number): number {
  if (total <= 0) return 0;
  const p = Math.min(1, Math.max(0, wins / total));
  const z = 1.96; // 95% confidence
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  // v2.0.721: Use p (not centre) in the variance term — the standard Wilson
  // formula uses p(1-p)/n. Using centre caused NaN when p=1.0 (centre > 1
  // → centre*(1-centre) < 0 → sqrt of negative). This is the correct formula.
  const variance = (p * (1 - p)) / total + (z * z) / (4 * total * total);
  const margin = z * Math.sqrt(Math.max(0, variance));
  const adjusted = (centre - margin) / denominator;
  return Math.max(0, Math.min(1, adjusted));
}

// ─── JSON extraction (robust against markdown fences) ───
// Strips ```json fences, finds the first balanced {…}, and JSON.parses it.

export function extractJSON(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('unbalanced JSON');
  return JSON.parse(s.slice(start, end + 1));
}

// ─── Heuristic rationale categorisation ───
// Regex-based fallback when LLM categorisation is unavailable.
// The experience-digester version has an expanded news regex (adds
// front-run|accumulation|distribution) — we use the expanded version
// as the canonical one since it's a superset.

export function categoriseRationale(text: string): RationaleCategory {
  const t = text.toLowerCase();
  if (/(resistance|support|breakout|rsi|macd|moving average|ema|sma|trendline|fib|volume|vol |ob |order book|imbalance|bps|retest)/.test(t)) return 'technical';
  if (/(capex|earnings|revenue|ai |secular|tailwind|fundamental|valuation|pe |margin)/.test(t)) return 'fundamental';
  if (/(news|fud|announcement|headline|ceasefire|geopolit|tweet|statement|front-run|accumulation|distribution)/.test(t)) return 'news';
  if (/(fed|rate|interest|inflation|cpi|macro|liquidity|qt|qe|yield|risk-off|risk off)/.test(t)) return 'macro';
  if (/(flow|inflow|outflow|etf|fund flow|whale|onchain|on-chain|funding rate)/.test(t)) return 'flow';
  if (/(sentiment|fear|greed|conviction|social)/.test(t)) return 'sentiment';
  if (/(pattern|flag|triangle|wedge|double top|double bottom|reversal|continuation|mean reversion)/.test(t)) return 'pattern';
  return 'other';
}

// ─── Normalise a category string to a valid RationaleCategory ───

const VALID_CATEGORIES: RationaleCategory[] = ['technical', 'fundamental', 'news', 'macro', 'flow', 'sentiment', 'pattern', 'other'];

export function normaliseCategory(c?: string): RationaleCategory {
  const lower = (c ?? 'other').toLowerCase().trim() as RationaleCategory;
  return VALID_CATEGORIES.includes(lower) ? lower : 'other';
}

// ─── Win/Loss statistics ───
// Shared pattern for computing win rate + avg PnL from a set of records.
// Used across pattern-tag-tracker, trade-pattern-classifier, trade-history,
// shadow-trade-engine, reason-analytics.

export interface WinLossStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;       // raw win rate (0-1)
  wilsonWinRate: number; // Wilson score lower bound (0-1)
  avgPnl: number;
}

export function computeWinLossStats(
  records: Array<{ pnl?: number }>,
  isWinFn: (r: { pnl?: number }) => boolean = (r) => (r.pnl ?? 0) >= 0,
): WinLossStats {
  const total = records.length;
  if (total === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, wilsonWinRate: 0, avgPnl: 0 };
  }
  const wins = records.filter(isWinFn).length;
  const losses = total - wins;
  const pnlSum = records.reduce((s, r) => s + (r.pnl ?? 0), 0);
  return {
    total,
    wins,
    losses,
    winRate: wins / total,
    wilsonWinRate: wilsonScore(wins, total),
    avgPnl: pnlSum / total,
  };
}

// ─── Vector-Conditional Win Rate (v2.0.203) ───────────────────────────
//
// Computes win rate CONDITIONED on marketFeatures vector similarity,
// NOT raw per-symbol / per-direction win rate.
//
// PROBLEM: A symbol's raw BUY win rate of 0% (0W/1L) is meaningless when
// current market conditions differ entirely from that single losing
// trade. Trade-audit and experience-digester used raw per-symbol WR to
// accuse the system of "ignoring learning data" — but the learning data
// was collected under completely different market conditions.
//
// SOLUTION: Retrieve historically similar MARKET-CONDITION trades
// (cosine similarity on normalised entry features, cross-symbol by
// default so a thin single-symbol sample is backed by the broader
// feature-space population) and compute their win rate. This is the
// true conditional edge P(win | similar market state), not P(win | symbol).
//
// Design:
//   - 9 canonical entry-condition features (aligned with TradePatternContext):
//     volatility, srDistanceBps, obImbalance, fundingRate, volumeRatio,
//     signalAgreement, sentiment, sentimentConviction, regimeOrdinal.
//   - Z-score normalisation using the records' own running mean/std
//     (candidate is normalised against the SAME stats, never included).
//   - Missing feature → that dimension is SKIPPED (contributes nothing),
//     NOT zero-filled. This is more robust than forcing a false neutral.
//   - Cosine similarity on the shared-dimension sub-vector.
//   - Wilson score lower bound penalises small similar-sample sizes.
//   - minSamples guard: insufficient similar trades → return neutral 0.5
//     with confidence='none' so agents are NOT misled.
//   - Side filter: a BUY candidate only matches historical BUY trades
//     (v2.0.176 proved mixing directions inflates win rate).
//   - Bounded: O(records × features), no allocation explosion.
//
// Used by: direction-audit.ts, experience-digester.ts, pattern-tag-tracker.ts.

/** Canonical entry-condition feature set for vector-conditional matching.
 *  Aligned with TradePatternContext (trade-pattern-classifier.ts) and the
 *  first 8 OLR features + regimeOrdinal. Excludes outcome-only features
 *  (mfePct/maePct/mfeToPnlRatio) which are not known at entry time. */
export const ENTRY_CONDITION_FEATURES = [
  'volatility',
  'srDistanceBps',
  'obImbalance',
  'fundingRate',
  'volumeRatio',
  'signalAgreement',
  'sentiment',
  'sentimentConviction',
  'regimeOrdinal',
  'momentumShort',
  'momentumLong',
] as const;

export interface VectorConditionalOptions {
  /** Cosine similarity threshold for "similar" (default 0.80).
   *  Higher = stricter matching (fewer but more similar trades). */
  threshold?: number;
  /** Minimum similar trades to return a non-neutral result (default 3).
   *  Below this → return 0.5 + confidence='none' to avoid misleading. */
  minSamples?: number;
  /** Filter by side — v2.0.176: direction must match (BUY ↔ BUY). */
  side?: 'buy' | 'sell';
  /** Filter by symbol (optional). Default: cross-symbol, because a thin
   *  per-symbol sample is exactly the failure mode this utility fixes. */
  symbol?: string;
  /** Max similar trades to keep for display (default 20). */
  topN?: number;
  /** Feature names to use (default: ENTRY_CONDITION_FEATURES). */
  featureNames?: readonly string[];
  /** Welford epsilon to avoid division by zero (default 1e-8). */
  epsilon?: number;
  /** v2.0.204: Optional learned numeric embedding provider (NumericAutoencoder).
   *  When provided AND `isReady()`, similarity is computed on the learned
   *  8-d embedding (captures non-linear feature interactions + outcome-aware
   *  metric) instead of min-max + cosine. Falls back to min-max when the
   *  provider is not ready (cold-start / validation failed). */
  embeddingProvider?: NumericEmbedProvider;
  /** v2.0.211 (K.md #3): RMSNorm retrieval keys before cosine — competition
   *  on direction not magnitude (high-volatility periods no longer dominate
   *  similarity). Default false (preserve min-max behavior for cold-start).
   *  When true, records + candidate are RMSNorm'd instead of min-max'd. */
  rmsNormKeys?: boolean;
  /** v2.0.211 (K.md #4): Softmax-weighted win rate instead of equal-weight.
   *  winRate = Σ softmax(sim_i/τ) · [win_i]. High-similarity records weight
   *  more (competitive normalization, K3 ablation: softmax > sigmoid).
   *  Default false (equal-weight, current behavior). */
  softmaxWeightedWR?: boolean;
  /** v2.0.211 (K.md #4): Temperature for softmax-weighted WR (default 0.1).
   *  Lower = sharper (top match dominates), higher = more uniform. */
  softmaxTemperature?: number;
  /** v2.0.211: Exclude records whose exitType is in this set BEFORE computing
   *  the conditional WR. Use to remove system-decision closes (e.g.
   *  ['thesis_invalidation']) so the market-conditional WR only reflects clean
   *  market-risk closes (SL/TP), not system force-closes whose PnL is partial/
   *  noisy information. Consistent with the conviction-gate exclusion at
   *  index.ts (~'closeReason !== thesis_invalidation'). Default: no exclusion. */
  excludeExitTypes?: string[];
}

/** v2.0.211: Exit types that are SYSTEM decisions, not clean market SL/TP
 *  outcomes. Records closed via these mechanisms carry partial/noisy PnL info
 *  (a system force-close was not taken to SL/TP by the market), so they pollute
 *  the market-conditional edge signal in either direction. All entry-decision
 *  callers of `computeVectorConditionalWinRate` should exclude these via
 *  `entryDecisionCondWROptions` (below) so the contract is enforced in one
 *  place. Consistent with the conviction-gate exclusion at index.ts
 *  (~'closeReason !== thesis_invalidation'). */
export const SYSTEM_DECISION_EXIT_TYPES = ['thesis_invalidation'] as const;

/** v2.0.211: Build the standard conditional-WR options for ENTRY-DECISION
 *  contexts (the entry soft gate, Skeptics 1.8b block, Meta-Agent conviction
 *  calibration block, audit per-trade summary, digester per-symbol report).
 *  Encapsulates the shared defaults + the system-close exclusion so every
 *  entry-decision caller reflects only clean market-risk outcomes — and so
 *  future callers cannot forget the exclusion. Callers pass `overrides` for
 *  context-specific tuning (minSamples, threshold, rmsNormKeys, softmax).
 *
 *  NOTE: only callers whose records carry an `exitType` field benefit from the
 *  exclusion (ThesisExperienceRecord does; PatternTagRecord, outcomeTracker
 *  records, and cluster `memberMarketData` currently do NOT — adding exitType
 *  to those schemas is a follow-up if their conditional WR should be
 *  market-clean). */
export function entryDecisionCondWROptions(
  side: 'buy' | 'sell',
  embeddingProvider: NumericEmbedProvider | undefined,
  overrides: Partial<VectorConditionalOptions> = {},
): VectorConditionalOptions {
  return {
    side,
    minSamples: 3,
    threshold: 0.75,
    topN: 20,
    embeddingProvider,
    excludeExitTypes: [...SYSTEM_DECISION_EXIT_TYPES],
    ...overrides,
  };
}

export interface VectorConditionalMatch {
  similarity: number;
  outcome: 'win' | 'loss';
  symbol: string;
  side: 'buy' | 'sell';
  pnl: number;
}

export interface VectorConditionalWinRateResult {
  /** Conditional win rate ∈ [0,1]. 0.5 when insufficient similar trades. */
  conditionalWinRate: number;
  /** Wilson score 95% lower bound — penalises small similar-sample sizes. */
  wilsonWinRate: number;
  /** Number of similar trades found above threshold. */
  sampleSize: number;
  wins: number;
  losses: number;
  /** Average cosine similarity of matched trades (0..1). */
  avgSimilarity: number;
  /** Confidence based on sample size: high(≥30) / medium(≥10) / low(≥minSamples) / none. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Matched trades (top-N by similarity), for display/debugging. */
  matched: VectorConditionalMatch[];
  /** Features actually used (some may be skipped if all-missing on one side). */
  usedFeatures: string[];
  /** Human-readable explanation. */
  explanation: string;
}

/** Internal: extract a numeric feature vector, keeping track of which
 *  dimensions are present (non-undefined, finite). Returns the vector
 *  plus a mask of present-dimension indices. */
function extractFeatureVector(
  features: Record<string, number> | undefined,
  names: readonly string[],
): { vec: number[]; present: boolean[] } {
  const vec = new Array<number>(names.length);
  const present = new Array<boolean>(names.length);
  for (let i = 0; i < names.length; i++) {
    const v = features?.[names[i]!];
    if (v !== undefined && v !== null && Number.isFinite(v)) {
      vec[i] = v;
      present[i] = true;
    } else {
      vec[i] = 0;
      present[i] = false;
    }
  }
  return { vec, present };
}

/** Internal: compute min/max per dimension over a set of records,
 *  only over PRESENT dimensions (missing dimensions keep count=0 and are
 *  skipped during similarity — they do not collapse the range).
 *
 *  Min-max is used instead of z-score because cosine similarity on
 *  z-scored vectors degenerates when the candidate equals the mean (the
 *  z-score vector becomes all-zero, and cosine of a zero vector is
 *  undefined / 0). Min-max normalisation keeps every non-degenerate
 *  dimension in [0,1], giving cosine a well-defined value. */
function computeMinMax(
  records: Array<{ marketFeatures?: Record<string, number> }>,
  names: readonly string[],
): { min: number[]; max: number[]; count: number[] } {
  const D = names.length;
  const min = new Array<number>(D).fill(Infinity);
  const max = new Array<number>(D).fill(-Infinity);
  const count = new Array<number>(D).fill(0);
  for (const rec of records) {
    const { vec, present } = extractFeatureVector(rec.marketFeatures, names);
    for (let i = 0; i < D; i++) {
      if (!present[i]) continue;
      count[i]!++;
      if (vec[i]! < min[i]!) min[i] = vec[i]!;
      if (vec[i]! > max[i]!) max[i] = vec[i]!;
    }
  }
  return { min, max, count };
}

/** Internal: min-max normalise a candidate vector against the records' range.
 *  - Missing candidate value or insufficient samples (count < 2) → NaN (skip).
 *  - Zero range (max == min, i.e. all historical values identical) → 0.5
 *    (neutral midpoint). This is critical: when a candidate equals the
 *    historical values on a dimension, that dimension should signal
 *    *similarity*, not be dropped. Mapping to 0.5 (rather than NaN) keeps
 *    the dimension in the cosine computation so identical records yield
 *    cosine = 1.0, while still letting other dimensions discriminate.
 *  - Otherwise maps to [0,1] where 0 = historical min, 1 = historical max. */
function normaliseCandidate(
  vec: number[],
  present: boolean[],
  min: number[],
  max: number[],
  count: number[],
  _epsilon: number,
): number[] {
  const D = vec.length;
  const out = new Array<number>(D);
  for (let i = 0; i < D; i++) {
    if (!present[i] || count[i]! < 2) {
      out[i] = NaN; // skip — insufficient data or candidate missing
      continue;
    }
    const range = max[i]! - min[i]!;
    if (range <= 1e-12) {
      out[i] = 0.5; // zero range — neutral midpoint (no discriminative power,
      // but contributes a non-zero component so identical records match)
      continue;
    }
    out[i] = (vec[i]! - min[i]!) / range;
  }
  return out;
}

/** Internal: cosine similarity on the SHARED present dimensions (where both
 *  candidate and historical record have finite normalised values).
 *  When BOTH vectors are the zero vector on the shared dims (identical
 *  post-normalisation, e.g. both equal the min), similarity is defined as
 *  1.0 — they are maximally similar. A single zero vector vs a non-zero
 *  vector yields 0 (perpendicular in the degenerate sense). */
function sharedCosine(a: number[], b: number[]): { sim: number; sharedDims: number } {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let shared = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (Number.isNaN(ai) || Number.isNaN(bi)) continue;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
    shared++;
  }
  if (shared === 0) return { sim: 0, sharedDims: 0 };
  // Both zero vectors on shared dims → identical (maximally similar).
  if (normA === 0 && normB === 0) return { sim: 1.0, sharedDims: shared };
  if (normA === 0 || normB === 0) return { sim: 0, sharedDims: shared };
  return { sim: dot / (Math.sqrt(normA) * Math.sqrt(normB)), sharedDims: shared };
}

/** Normalise an outcome string case-insensitively to win/loss. */
function normaliseOutcome(o: string): 'win' | 'loss' | null {
  const s = String(o ?? '').toLowerCase();
  if (s === 'win' || s === 'w') return 'win';
  if (s === 'loss' || s === 'lose' || s === 'l') return 'loss';
  return null;
}

/**
 * Compute win rate conditioned on marketFeatures vector similarity.
 *
 * @param candidateFeatures  Current market conditions (entry-time features)
 * @param records             Historical trades with marketFeatures + outcome
 * @param options             threshold / minSamples / side / symbol / topN
 * @returns Conditional win rate + sample size + confidence + matched trades
 */
/** v2.0.204: Score records using a learned numeric embedding (NumericAutoencoder).
 *  Returns null when no trades match the threshold (so the caller can fall
 *  through to min-max + cosine). Embeddings are L2-normalised by the provider,
 *  so cosine = dot product. */
function scoreWithLearnedEmbedding(
  candidateFeatures: Record<string, number>,
  filtered: Array<{ marketFeatures?: Record<string, number>; outcome: string; symbol: string; side: 'buy' | 'sell'; pnl?: number }>,
  provider: NumericEmbedProvider,
  threshold: number,
  minSamples: number,
  topN: number,
): VectorConditionalWinRateResult | null {
  // Embed the candidate + every filtered record. The provider handles
  // missing features by substituting the running mean (neutral).
  const candVec = provider.embed([candidateFeatures])[0]!;
  const recVecs = provider.embed(filtered.map((r) => r.marketFeatures ?? {}));
  const scored: Array<{ rec: typeof filtered[number]; sim: number }> = [];
  for (let i = 0; i < filtered.length; i++) {
    const rv = recVecs[i]!;
    let dot = 0;
    let nA = 0;
    let nB = 0;
    for (let k = 0; k < candVec.length; k++) {
      dot += candVec[k]! * rv[k]!;
      nA += candVec[k]! * candVec[k]!;
      nB += rv[k]! * rv[k]!;
    }
    const sim = nA > 0 && nB > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
    if (sim >= threshold) scored.push({ rec: filtered[i]!, sim });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.sim - a.sim);
  const matched = scored.slice(0, topN);
  let wins = 0;
  let losses = 0;
  let simSum = 0;
  const matches: VectorConditionalMatch[] = [];
  for (const m of matched) {
    const o = normaliseOutcome(m.rec.outcome)!;
    if (o === 'win') wins++; else losses++;
    simSum += m.sim;
    matches.push({ similarity: m.sim, outcome: o, symbol: m.rec.symbol, side: m.rec.side, pnl: m.rec.pnl ?? 0 });
  }
  const sampleSize = matched.length;
  const conditionalWinRate = sampleSize > 0 ? wins / sampleSize : 0.5;
  const wilsonWinRate = wilsonScore(wins, sampleSize);
  const avgSimilarity = sampleSize > 0 ? simSum / sampleSize : 0;
  const confidence: VectorConditionalWinRateResult['confidence'] =
    sampleSize >= 30 ? 'high' : sampleSize >= 10 ? 'medium' : sampleSize >= minSamples ? 'low' : 'none';
  if (sampleSize < minSamples) {
    return {
      conditionalWinRate: 0.5, wilsonWinRate: 0.5, sampleSize, wins, losses,
      avgSimilarity, confidence: 'none', matched: matches, usedFeatures: [],
      explanation: `Learned-embed: only ${sampleSize} similar (need ≥${minSamples}). Neutral 0.5.`,
    };
  }
  return {
    conditionalWinRate, wilsonWinRate, sampleSize, wins, losses, avgSimilarity,
    confidence, matched: matches, usedFeatures: [],
    explanation: `Learned-embed: ${wins}/${sampleSize} won (${(conditionalWinRate * 100).toFixed(0)}%, wilson ${(wilsonWinRate * 100).toFixed(0)}%, sim ${(avgSimilarity * 100).toFixed(0)}%, ${confidence}).`,
  };
}

export function computeVectorConditionalWinRate(
  candidateFeatures: Record<string, number>,
  records: Array<{
    marketFeatures?: Record<string, number>;
    outcome: string;
    symbol: string;
    side: 'buy' | 'sell';
    pnl?: number;
    exitType?: string;
  }>,
  options?: VectorConditionalOptions,
): VectorConditionalWinRateResult {
  const names = options?.featureNames ?? ENTRY_CONDITION_FEATURES;
  const threshold = options?.threshold ?? 0.80;
  const minSamples = options?.minSamples ?? 3;
  const topN = options?.topN ?? 20;
  const epsilon = options?.epsilon ?? 1e-8;

  const neutral: VectorConditionalWinRateResult = {
    conditionalWinRate: 0.5,
    wilsonWinRate: 0.5,
    sampleSize: 0,
    wins: 0,
    losses: 0,
    avgSimilarity: 0,
    confidence: 'none',
    matched: [],
    usedFeatures: [...names],
    explanation: 'No similar market-condition trades found (insufficient data).',
  };

  // Filter records: side + symbol + has marketFeatures + resolvable outcome.
  // v2.0.211: Also exclude system-decision closes (e.g. thesis_invalidation)
  // when excludeExitTypes is set — these are not clean market-risk outcomes
  // and their PnL (positive OR negative) is partial/noisy information that
  // pollutes the market-conditional WR. See options.excludeExitTypes.
  const excludeExit = options?.excludeExitTypes;
  const filtered = records.filter((r) => {
    if (!r.marketFeatures) return false;
    if (options?.side && r.side !== options.side) return false;
    if (options?.symbol && r.symbol.toLowerCase() !== options.symbol.toLowerCase()) return false;
    if (excludeExit && r.exitType && excludeExit.includes(r.exitType)) return false;
    return normaliseOutcome(r.outcome) !== null;
  });
  if (filtered.length === 0) return neutral;

  // v2.0.204: Learned-embedding path. When a NumericAutoencoder is provided
  // AND has passed validation, compute similarity on the learned 8-d embedding
  // (captures non-linear feature interactions + outcome-aware metric). This
  // supersedes min-max + cosine for ready models. Falls back to min-max when
  // the provider is absent or not yet ready (cold-start / validation failed).
  const provider = options?.embeddingProvider;
  if (provider && provider.isReady()) {
    const learnedResult = scoreWithLearnedEmbedding(candidateFeatures, filtered, provider, threshold, minSamples, topN);
    if (learnedResult !== null) return learnedResult;
    // If learned scoring yielded no matches, fall through to min-max so the
    // caller still gets a neutral result with a meaningful explanation.
  }

  // v2.0.211 (K.md #3): RMSNorm-keys path — when rmsNormKeys is set, both
  // candidate and records are RMSNorm'd (competition on direction not
  // magnitude). This is the AttnRes key normalisation, applied to the
  // min-max fallback path. The NA-learned path is unaffected (embeddings are
  // already L2-normalised). When false (default), the original min-max path
  // runs unchanged (cold-start safe).
  if (options?.rmsNormKeys) {
    return computeVectorConditionalWinRateRMSNorm(candidateFeatures, filtered, names, threshold, minSamples, topN, options);
  }

  // Min-max stats over filtered records (for normalisation).
  const stats = computeMinMax(filtered, names);

  // Normalise candidate against those stats.
  const cand = extractFeatureVector(candidateFeatures, names);
  const candNorm = normaliseCandidate(cand.vec, cand.present, stats.min, stats.max, stats.count, epsilon);

  // Determine which dimensions are usable (candidate present + stats have ≥2 samples).
  const usableDims: number[] = [];
  for (let i = 0; i < names.length; i++) {
    if (cand.present[i] && stats.count[i]! >= 2) usableDims.push(i);
  }
  const usedFeatures = usableDims.map((i) => names[i]!);
  if (usableDims.length === 0) {
    return { ...neutral, usedFeatures: [], explanation: 'No usable feature dimensions (candidate has no matching features with ≥2 historical samples).' };
  }

  // Score every filtered record.
  const scored: Array<{ rec: typeof filtered[number]; sim: number; shared: number }> = [];
  for (const rec of filtered) {
    const rv = extractFeatureVector(rec.marketFeatures, names);
    const rNorm = normaliseCandidate(rv.vec, rv.present, stats.min, stats.max, stats.count, epsilon);
    const { sim, sharedDims } = sharedCosine(candNorm, rNorm);
    // Require a minimum overlap of shared dimensions to trust the similarity.
    if (sharedDims >= Math.max(2, Math.ceil(usableDims.length / 2)) && sim >= threshold) {
      scored.push({ rec, sim, shared: sharedDims });
    }
  }

  if (scored.length === 0) {
    return {
      ...neutral,
      usedFeatures,
      explanation: `No trades matched (threshold=${threshold}, ${usableDims.length}/${names.length} usable dims).`,
    };
  }

  scored.sort((a, b) => b.sim - a.sim);
  const matched = scored.slice(0, topN);

  let wins = 0;
  let losses = 0;
  let simSum = 0;
  const matches: VectorConditionalMatch[] = [];
  for (const m of matched) {
    const o = normaliseOutcome(m.rec.outcome)!;
    if (o === 'win') wins++;
    else losses++;
    simSum += m.sim;
    matches.push({
      similarity: m.sim,
      outcome: o,
      symbol: m.rec.symbol,
      side: m.rec.side,
      pnl: m.rec.pnl ?? 0,
    });
  }

  const sampleSize = matched.length;
  // v2.0.211 (K.md #4): Softmax-weighted win rate option.
  let conditionalWinRate: number;
  if (options?.softmaxWeightedWR && sampleSize > 0) {
    conditionalWinRate = softmaxWeightedWinRate(matches, options.softmaxTemperature ?? 0.1);
    // Wilson still uses raw wins/total for the lower bound (penalises small n).
  } else {
    conditionalWinRate = sampleSize > 0 ? wins / sampleSize : 0.5;
  }
  const wilsonWinRate = wilsonScore(wins, sampleSize);
  const avgSimilarity = sampleSize > 0 ? simSum / sampleSize : 0;

  const confidence: VectorConditionalWinRateResult['confidence'] =
    sampleSize >= 30 ? 'high' : sampleSize >= 10 ? 'medium' : sampleSize >= minSamples ? 'low' : 'none';

  if (sampleSize < minSamples) {
    return {
      conditionalWinRate: 0.5,
      wilsonWinRate: 0.5,
      sampleSize,
      wins,
      losses,
      avgSimilarity,
      confidence: 'none',
      matched: matches,
      usedFeatures,
      explanation: `Only ${sampleSize} similar trades (need ≥${minSamples}). Insufficient — returning neutral 0.5 to avoid misleading.`,
    };
  }

  const wrLabel = options?.softmaxWeightedWR ? 'softmax-WR' : 'WR';
  const explanation = `Vector-conditional (${wrLabel}): ${wins}/${sampleSize} won (${(conditionalWinRate * 100).toFixed(0)}%, wilson ${(wilsonWinRate * 100).toFixed(0)}%, avg sim ${(avgSimilarity * 100).toFixed(0)}%, ${confidence} conf, ${usableDims.length}/${names.length} features).`;

  return {
    conditionalWinRate,
    wilsonWinRate,
    sampleSize,
    wins,
    losses,
    avgSimilarity,
    confidence,
    matched: matches,
    usedFeatures,
    explanation,
  };
}

/** Format a VectorConditionalWinRateResult as a compact agent-context line. */
export function formatVectorConditional(
  result: VectorConditionalWinRateResult,
  label: string,
): string {
  if (result.confidence === 'none') return `${label}: ${result.explanation}`;
  return `${label}: ${result.wins}/${result.sampleSize} won (${(result.conditionalWinRate * 100).toFixed(0)}%, wilson ${(result.wilsonWinRate * 100).toFixed(0)}%, sim ${(result.avgSimilarity * 100).toFixed(0)}%, ${result.confidence})`;
}

// ─── v2.0.211 (K.md #3): RMSNorm-keys conditional WR path ──────────────────
//
// AttnRes key normalisation applied to the min-max fallback: records +
// candidate are RMSNorm'd (direction competition, not magnitude). This
// prevents high-volatility periods (large feature magnitudes) from dominating
// cosine similarity. Gated by `rmsNormKeys: true` in options — default is the
// original min-max path (cold-start safe).

/** RMSNorm a feature vector: x / sqrt(mean(x²) + eps). Zero / all-missing →
 *  uniform unit vector (well-defined cosine, no degenerate zero-vector). */
export function rmsNormFeatures(
  features: Record<string, number>,
  names: readonly string[],
): { vec: number[]; present: boolean[] } {
  const vec = new Array<number>(names.length);
  const present = new Array<boolean>(names.length);
  let sumSq = 0;
  let finiteCount = 0;
  for (let i = 0; i < names.length; i++) {
    const v = features?.[names[i]!];
    if (v !== undefined && v !== null && Number.isFinite(v)) {
      vec[i] = v;
      present[i] = true;
      sumSq += v * v;
      finiteCount++;
    } else {
      vec[i] = 0;
      present[i] = false;
    }
  }
  if (finiteCount === 0) {
    // All-missing → uniform unit vector (neutral contribution, well-defined cosine).
    const u = 1 / Math.sqrt(names.length);
    return { vec: vec.map(() => u), present };
  }
  const rms = Math.sqrt(sumSq / finiteCount + 1e-8);
  for (let i = 0; i < names.length; i++) {
    if (present[i]) vec[i] = vec[i]! / rms;
  }
  return { vec, present };
}

/** Internal: RMSNorm-keys conditional WR computation (the #3 path).
 *  Shares the scoring/explanation structure with the min-max path but
 *  normalises via RMSNorm instead of min-max. */
function computeVectorConditionalWinRateRMSNorm(
  candidateFeatures: Record<string, number>,
  filtered: Array<{ marketFeatures?: Record<string, number>; outcome: string; symbol: string; side: 'buy' | 'sell'; pnl?: number }>,
  names: readonly string[],
  threshold: number,
  minSamples: number,
  topN: number,
  options: VectorConditionalOptions,
): VectorConditionalWinRateResult {
  const neutral: VectorConditionalWinRateResult = {
    conditionalWinRate: 0.5, wilsonWinRate: 0.5, sampleSize: 0, wins: 0, losses: 0,
    avgSimilarity: 0, confidence: 'none', matched: [], usedFeatures: [...names],
    explanation: 'No similar market-condition trades found (RMSNorm path, insufficient data).',
  };

  // RMSNorm candidate + every record.
  const cand = rmsNormFeatures(candidateFeatures, names);
  const usableDims: number[] = [];
  for (let i = 0; i < names.length; i++) if (cand.present[i]) usableDims.push(i);
  const usedFeatures = usableDims.map((i) => names[i]!);
  if (usableDims.length === 0) return { ...neutral, explanation: 'No usable feature dimensions (candidate has no present features).' };

  const scored: Array<{ rec: typeof filtered[number]; sim: number; shared: number }> = [];
  for (const rec of filtered) {
    const r = rmsNormFeatures(rec.marketFeatures ?? {}, names);
    const { sim, sharedDims } = sharedCosine(cand.vec, r.vec);
    if (sharedDims >= Math.max(2, Math.ceil(usableDims.length / 2)) && sim >= threshold) {
      scored.push({ rec, sim, shared: sharedDims });
    }
  }
  if (scored.length === 0) {
    return { ...neutral, usedFeatures, explanation: `No trades matched (RMSNorm, threshold=${threshold}, ${usableDims.length}/${names.length} usable dims).` };
  }
  scored.sort((a, b) => b.sim - a.sim);
  const matched = scored.slice(0, topN);

  let wins = 0;
  let losses = 0;
  let simSum = 0;
  const matches: VectorConditionalMatch[] = [];
  for (const m of matched) {
    const o = normaliseOutcome(m.rec.outcome)!;
    if (o === 'win') wins++; else losses++;
    simSum += m.sim;
    matches.push({ similarity: m.sim, outcome: o, symbol: m.rec.symbol, side: m.rec.side, pnl: m.rec.pnl ?? 0 });
  }
  const sampleSize = matched.length;
  let conditionalWinRate: number;
  if (options.softmaxWeightedWR && sampleSize > 0) {
    conditionalWinRate = softmaxWeightedWinRate(matches, options.softmaxTemperature ?? 0.1);
  } else {
    conditionalWinRate = sampleSize > 0 ? wins / sampleSize : 0.5;
  }
  const wilsonWinRate = wilsonScore(wins, sampleSize);
  const avgSimilarity = sampleSize > 0 ? simSum / sampleSize : 0;
  const confidence: VectorConditionalWinRateResult['confidence'] =
    sampleSize >= 30 ? 'high' : sampleSize >= 10 ? 'medium' : sampleSize >= minSamples ? 'low' : 'none';
  if (sampleSize < minSamples) {
    return { conditionalWinRate: 0.5, wilsonWinRate: 0.5, sampleSize, wins, losses, avgSimilarity, confidence: 'none', matched: matches, usedFeatures, explanation: `Only ${sampleSize} similar (RMSNorm, need ≥${minSamples}). Neutral 0.5.` };
  }
  const wrLabel = options.softmaxWeightedWR ? 'softmax-WR' : 'WR';
  return {
    conditionalWinRate, wilsonWinRate, sampleSize, wins, losses, avgSimilarity, confidence, matched: matches, usedFeatures,
    explanation: `Vector-conditional (RMSNorm, ${wrLabel}): ${wins}/${sampleSize} won (${(conditionalWinRate * 100).toFixed(0)}%, wilson ${(wilsonWinRate * 100).toFixed(0)}%, sim ${(avgSimilarity * 100).toFixed(0)}%, ${confidence}, ${usableDims.length}/${names.length} features).`,
  };
}

// ─── v2.0.211 (K.md #4): Softmax-weighted win rate ──────────────────────────
//
// K3 ablation: softmax > sigmoid (competitive normalization forces sharper
// selection). Instead of equal-weight win rate (wins/sampleSize), weight each
// matched record by softmax(similarity/temperature) so high-similarity records
// contribute more. Temperature controls sharpness (low = top match dominates).

/** Compute softmax-weighted win rate over matched trades.
 *  winRate = Σ softmax(sim_i / τ) · [outcome_i == win]
 *  Numerically stable (max-subtraction). Returns 0.5 for empty matches. */
export function softmaxWeightedWinRate(
  matches: VectorConditionalMatch[],
  temperature: number = 0.1,
): number {
  if (matches.length === 0) return 0.5;
  const logits = matches.map((m) => m.similarity / temperature);
  let max = -Infinity;
  for (const l of logits) if (Number.isFinite(l) && l > max) max = l;
  if (!Number.isFinite(max)) max = 0;
  let sumExp = 0;
  const exps = logits.map((l) => {
    if (!Number.isFinite(l)) return 0;
    const e = Math.exp(l - max);
    sumExp += e;
    return e;
  });
  if (sumExp <= 0) return matches.filter((m) => m.outcome === 'win').length / matches.length;
  let wr = 0;
  for (let i = 0; i < matches.length; i++) {
    const w = exps[i]! / sumExp;
    if (matches[i]!.outcome === 'win') wr += w;
  }
  return Math.max(0, Math.min(1, wr));
}