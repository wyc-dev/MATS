// ─── First-Passage Probability Calculator ───
//
// Calculates the probability that TP is hit before SL, assuming price
// follows a Geometric Brownian Motion (GBM) with log-drift ν and per-cycle
// volatility σ.
//
// For a LONG position with entry S, SL = S×(1−a) (distance a below),
// TP = S×(1+b) (distance b above), the log-process X = ln S has drift
// ν = μ − σ²/2 and diffusion σ. First-passage probability of hitting
// the upper barrier +b before the lower barrier −a (Cox & Miller 1965,
// via the scale function s(x) = exp(−2νx/σ²)):
//
//   P(TP before SL) = (e^(2νa/σ²) − 1) / (e^(2νa/σ²) − e^(−2νb/σ²))
//
// For a SHORT position the barriers invert: SL is above (distance a'),
// TP is below (distance b'). By symmetry (flip sign of ν, swap barrier
// roles):
//
//   P(TP before SL) = (1 − e^(−2νa'/σ²)) / (e^(2νb'/σ²) − e^(−2νa'/σ²))
//
// Zero-drift limit (ν → 0, L'Hôpital): P = a / (a + b) for both sides
// (the nearer barrier is hit first with probability = opposite distance /
// total). This is the correct symmetric-random-walk limit.
//
// This is an INSTANT signal — no waiting for shadow trades to resolve.
// It gives agents a real-time path-risk assessment based on current
// volatility, log-drift, and S/R-based SL/TP distances.
//
// Reference: Cox & Miller (1965), "The Theory of Stochastic Processes",
// Chapter 3 — First-passage times for diffusion processes.
//
// IMPORTANT (v2 fix): the previous implementation swapped the LONG and
// SHORT formulas (code's longPWin was the SHORT probability and vice
// versa) AND used raw price drift μ instead of log-drift ν. Both inverted
// the signal under directional drift — a critical capital-risk bug. This
// version uses the correct formulas and log-drift.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'first-passage' });

export interface FirstPassageResult {
  /** P(TP before SL) for LONG ∈ [0,1] */
  longPWin: number;
  /** P(TP before SL) for SHORT ∈ [0,1] */
  shortPWin: number;
  /** Log-drift used (per-cycle, already log-process drift ν = μ − σ²/2) */
  drift: number;
  /** Per-cycle volatility σ used (std of log returns) */
  volatility: number;
  /** SL distance as fraction of price (LONG) */
  slDistanceLong: number;
  /** TP distance as fraction of price (LONG) */
  tpDistanceLong: number;
  /** SL distance as fraction of price (SHORT) */
  slDistanceShort: number;
  /** TP distance as fraction of price (SHORT) */
  tpDistanceShort: number;
  /** Symmetric-random-walk breakeven P(TP first) for LONG = a/(a+b).
   *  Agents should compare P(win) against this, NOT against a flat 50%. */
  breakevenPLong: number;
  /** Breakeven P(TP first) for SHORT */
  breakevenPShort: number;
  /** Confidence label: 'low' when vol is too low to trust the diffusion model */
  confidence: 'high' | 'low';
  /** Human-readable explanation */
  explanation: string;
  /** Timestamp (ms) when the volatility was last computed */
  volatilityTimestamp: number;
}

/** Numerical guard: exponents can overflow for large 2νa/σ². Clamp the
 *  argument to avoid Infinity propagating into a NaN ratio. */
const MAX_EXP_ARG = 50;

/** Maximum age of volatility data (in ms) before a freshness recompute is triggered.
 *  Default 2 cycles = 10 minutes (assuming 5-minute cycles). */
const MAX_VOLATILITY_AGE_MS = 10 * 60 * 1000;

function safeExp(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x > MAX_EXP_ARG) return Math.exp(MAX_EXP_ARG);
  if (x < -MAX_EXP_ARG) return Math.exp(-MAX_EXP_ARG);
  return Math.exp(x);
}

/**
 * Calculate first-passage probability for both LONG and SHORT.
 *
 * @param volatility      Per-cycle volatility σ (std of log returns, e.g. 0.02 = 2%/cycle)
 * @param drift           Per-cycle LOG-drift ν = μ − σ²/2 (e.g. 0.001 = 0.1%/cycle). May be negative.
 * @param slDistanceLong  LONG SL distance as fraction of price (a, below entry)
 * @param tpDistanceLong  LONG TP distance as fraction of price (b, above entry)
 * @param slDistanceShort SHORT SL distance as fraction of price (above entry). Defaults to tpDistanceLong
 *                        (SHORT's SL sits at resistance = LONG's TP level).
 * @param tpDistanceShort SHORT TP distance as fraction of price (below entry). Defaults to slDistanceLong
 *                        (SHORT's TP sits at support = LONG's SL level).
 * @param prices          Optional array of recent prices for volatility freshness recompute.
 *                        If provided and the volatility is stale (>MAX_VOLATILITY_AGE_MS old),
 *                        the function recomputes volatility from the latest prices.
 * @param volatilityTimestamp Timestamp (ms) when the volatility was last computed. If 0 or undefined,
 *                        freshness check is skipped (assumes fresh).
 */
export function calculateFirstPassage(
  volatility: number,
  drift: number,
  slDistanceLong: number,
  tpDistanceLong: number,
  slDistanceShort?: number,
  tpDistanceShort?: number,
  prices?: number[],
  volatilityTimestamp?: number,
): FirstPassageResult {
  const aLong = Math.max(slDistanceLong, 1e-6);
  const bLong = Math.max(tpDistanceLong, 1e-6);
  // SHORT barriers: SL above (distance a'), TP below (distance b').
  // Default mirrors LONG's S/R levels — SHORT SL at resistance (LONG TP),
  // SHORT TP at support (LONG SL).
  const aShort = Math.max(slDistanceShort ?? tpDistanceLong, 1e-6);
  const bShort = Math.max(tpDistanceShort ?? slDistanceLong, 1e-6);
  const nu = Number.isFinite(drift) ? drift : 0;

  const breakevenPLong = aLong / (aLong + bLong);
  const breakevenPShort = aShort / (aShort + bShort);

  // ── Volatility freshness check ──
  // If the provided volatility is stale (>MAX_VOLATILITY_AGE_MS old) and we have
  // price data to recompute, do so. This prevents OLR from using a volatility
  // snapshot from shadow-open time (5-15 minutes stale) when computing the
  // first-passage probability at real trade entry.
  let effectiveVol = volatility;
  let effectiveVolTimestamp = volatilityTimestamp ?? Date.now();
  if (
    prices !== undefined &&
    prices.length >= 3 &&
    volatilityTimestamp !== undefined &&
    Date.now() - volatilityTimestamp > MAX_VOLATILITY_AGE_MS
  ) {
    const recomputedVol = estimateVolatility(prices, 20);
    if (recomputedVol > 0 && Number.isFinite(recomputedVol)) {
      effectiveVol = recomputedVol;
      effectiveVolTimestamp = Date.now();
      log.warn(
        `Volatility freshness recompute: stale vol ${(volatility * 100).toFixed(4)}% (age ${((Date.now() - volatilityTimestamp) / 1000).toFixed(0)}s) → recomputed ${(recomputedVol * 100).toFixed(4)}%`
      );
    }
  }

  // Volatility too low (< 0.1%/cycle): the diffusion model is not
  // meaningful — returns are dominated by quantisation/measurement noise.
  // Return the zero-drift breakeven a/(a+b) (NOT a flat 50%, which is
  // wrong whenever SL ≠ TP distance) and flag low confidence so agents
  // weight the signal less.
  if (!Number.isFinite(effectiveVol) || effectiveVol < 0.001) {
    return {
      longPWin: breakevenPLong,
      shortPWin: breakevenPShort,
      drift: nu,
      volatility: effectiveVol,
      slDistanceLong: aLong,
      tpDistanceLong: bLong,
      slDistanceShort: aShort,
      tpDistanceShort: bShort,
      breakevenPLong,
      breakevenPShort,
      confidence: 'low',
      volatilityTimestamp: effectiveVolTimestamp,
      explanation: `First-Passage P(TP before SL): vol too low (${(effectiveVol * 100).toFixed(4)}%) — using zero-drift breakeven a/(a+b) (LONG=${(breakevenPLong * 100).toFixed(0)}%, SHORT=${(breakevenPShort * 100).toFixed(0)}%). Low confidence — weight path-risk signal less.`,
    };
  }

  const vol = effectiveVol;
  const volSq = vol * vol;

  // LONG: P(hit +b before −a) = (e^(2νa/σ²) − 1) / (e^(2νa/σ²) − e^(−2νb/σ²))
  const expPos2nuA_long = safeExp((2 * nu * aLong) / volSq);
  const expNeg2nuB_long = safeExp((-2 * nu * bLong) / volSq);
  const denomLong = expPos2nuA_long - expNeg2nuB_long;
  let longPWin: number;
  if (Math.abs(denomLong) < 1e-12) {
    // ν ≈ 0 → symmetric random walk → a/(a+b) (nearer barrier hit first)
    longPWin = breakevenPLong;
  } else {
    longPWin = (expPos2nuA_long - 1) / denomLong;
  }
  longPWin = Math.max(0, Math.min(1, longPWin));

  // SHORT: P(hit −b' before +a') = (1 − e^(−2νa'/σ²)) / (e^(2νb'/σ²) − e^(−2νa'/σ²))
  const expNeg2nuA_short = safeExp((-2 * nu * aShort) / volSq);
  const expPos2nuB_short = safeExp((2 * nu * bShort) / volSq);
  const denomShort = expPos2nuB_short - expNeg2nuA_short;
  let shortPWin: number;
  if (Math.abs(denomShort) < 1e-12) {
    shortPWin = breakevenPShort;
  } else {
    shortPWin = (1 - expNeg2nuA_short) / denomShort;
  }
  shortPWin = Math.max(0, Math.min(1, shortPWin));

  const explanation = buildExplanation(longPWin, shortPWin, nu, vol, aLong, bLong, aShort, bShort, breakevenPLong, breakevenPShort);

  return {
    longPWin,
    shortPWin,
    drift: nu,
    volatility: vol,
    slDistanceLong: aLong,
    tpDistanceLong: bLong,
    slDistanceShort: aShort,
    tpDistanceShort: bShort,
    breakevenPLong,
    breakevenPShort,
    confidence: 'high',
    volatilityTimestamp: effectiveVolTimestamp,
    explanation,
  };
}

function buildExplanation(
  longPWin: number,
  shortPWin: number,
  drift: number,
  vol: number,
  aLong: number,
  bLong: number,
  aShort: number,
  bShort: number,
  breakevenPLong: number,
  breakevenPShort: number,
): string {
  const driftLabel = drift > 0.0005 ? '↑ upward' : drift < -0.0005 ? '↓ downward' : '→ flat';
  const volLabel = vol > 0.03 ? 'high' : vol > 0.01 ? 'moderate' : 'low';
  const longLabel = longPWin > breakevenPLong + 0.1 ? '🟢' : longPWin < breakevenPLong - 0.1 ? '🔴' : '🟡';
  const shortLabel = shortPWin > breakevenPShort + 0.1 ? '🟢' : shortPWin < breakevenPShort - 0.1 ? '🔴' : '🟡';

  return [
    `First-Passage P(TP before SL):`,
    `  ${longLabel} LONG  P=${(longPWin * 100).toFixed(0)}% (SL=${(aLong * 100).toFixed(1)}%, TP=${(bLong * 100).toFixed(1)}%, breakeven=${(breakevenPLong * 100).toFixed(0)}%)`,
    `  ${shortLabel} SHORT P=${(shortPWin * 100).toFixed(0)}% (SL=${(aShort * 100).toFixed(1)}%, TP=${(bShort * 100).toFixed(1)}%, breakeven=${(breakevenPShort * 100).toFixed(0)}%)`,
    `  Drift: ${driftLabel} (${(drift * 100).toFixed(2)}%/cycle, log) | Vol: ${volLabel} (${(vol * 100).toFixed(2)}%/cycle, σ)`,
    `  Compare P(win) to breakeven, not 50%: P > breakeven+10% → path favors TP; P < breakeven−10% → path favors SL.`,
  ].join('\n');
}

/**
 * Estimate per-cycle volatility σ as the standard deviation of log returns.
 *
 * The previous global `calcVolatility` (mean of |arithmetic returns|) is NOT
 * σ — it underestimates diffusion by ~20% under normality and conflates
 * mean absolute displacement with standard deviation. First-passage requires
 * the true diffusion coefficient σ of the log process.
 *
 * @param prices  Array of historical prices (oldest first)
 * @param n       Number of recent prices to use (default 20)
 * @returns Per-cycle σ (std of log returns). 0 if insufficient data.
 */
export function estimateVolatility(prices: number[], n: number = 20): number {
  const recent = prices.slice(-Math.min(n, prices.length));
  if (recent.length < 3) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1]!;
    const curr = recent[i]!;
    if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      logReturns.push(Math.log(curr / prev));
    }
  }
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const sigma = Math.sqrt(Math.max(variance, 0));
  if (!Number.isFinite(sigma)) return 0;
  return sigma;
}

/**
 * Estimate per-cycle LOG-drift ν = μ − σ²/2 from recent price history.
 *
 * Uses an exponentially-weighted moving average (EWMA) of log returns with a
 * 20-cycle window. EWMA weights recent observations more heavily (adapts to
 * regime shifts faster) while dampening the noise that broke the previous
 * 10-cycle simple MA (whose standard error ≈ σ/√10 dominated the signal).
 *
 * The returned value is the log-process drift ν directly — pass it to
 * `calculateFirstPassage` as `drift`; do NOT subtract σ²/2 again.
 *
 * @param prices  Array of historical prices (oldest first)
 * @param n       Window length (default 20)
 * @returns Per-cycle log-drift ν (fraction, e.g. 0.001 = 0.1%). 0 if insufficient data.
 */
export function estimateDrift(prices: number[], n: number = 20): number {
  if (prices.length < 2) return 0;
  const recent = prices.slice(-Math.min(n, prices.length));
  if (recent.length < 2) return 0;

  const logReturns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1]!;
    const curr = recent[i]!;
    if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      logReturns.push(Math.log(curr / prev));
    }
  }
  if (logReturns.length === 0) return 0;

  // EWMA with halving weight ≈ every n/2 samples (α = 2/(n+1) classic EWMA)
  const alpha = 2 / (logReturns.length + 1);
  let ewma = logReturns[0]!;
  for (let i = 1; i < logReturns.length; i++) {
    ewma = alpha * logReturns[i]! + (1 - alpha) * ewma;
  }
  if (!Number.isFinite(ewma)) return 0;
  return ewma;
}