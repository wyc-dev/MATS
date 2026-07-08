// ─── First-Passage Probability Calculator ───
//
// Calculates the probability that TP is hit before SL, assuming price
// follows a Geometric Brownian Motion (GBM) with drift μ and volatility σ.
//
// For a LONG position with entry S, SL = S×(1-a), TP = S×(1+b):
//
//   P(TP before SL) = (1 - e^(-2μa/σ²)) / (e^(2μb/σ²) - e^(-2μa/σ²))
//
// For a SHORT position, the formula is inverted (SL above, TP below).
//
// This is an INSTANT signal — no waiting for shadow trades to resolve.
// It gives agents a real-time path-risk assessment based on current
// volatility, drift, and S/R-based SL/TP distances.
//
// Reference: Cox & Miller (1965), "The Theory of Stochastic Processes",
// Chapter 3 — First-passage times for diffusion processes.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'first-passage' });

export interface FirstPassageResult {
  /** P(TP before SL) for LONG ∈ (0,1) */
  longPWin: number;
  /** P(TP before SL) for SHORT ∈ (0,1) */
  shortPWin: number;
  /** Drift used (per-cycle, annualized for context) */
  drift: number;
  /** Volatility used (per-cycle) */
  volatility: number;
  /** SL distance as fraction of price (LONG) */
  slDistanceLong: number;
  /** TP distance as fraction of price (LONG) */
  tpDistanceLong: number;
  /** Human-readable explanation */
  explanation: string;
}

/**
 * Calculate first-passage probability for both LONG and SHORT.
 *
 * @param volatility  Per-cycle volatility (e.g. 0.02 = 2% per cycle)
 * @param drift       Per-cycle drift (e.g. 0.001 = 0.1% per cycle)
 * @param slDistance  SL distance as fraction of price (e.g. 0.008 = 0.8%)
 * @param tpDistance  TP distance as fraction of price (e.g. 0.016 = 1.6%)
 *
 * @returns FirstPassageResult with P(TP before SL) for both sides
 */
export function calculateFirstPassage(
  volatility: number,
  drift: number,
  slDistance: number,
  tpDistance: number,
): FirstPassageResult {
  // Guard against degenerate inputs
  const a = Math.max(slDistance, 1e-6);
  const b = Math.max(tpDistance, 1e-6);
  const mu = drift; // can be negative

  // If volatility is too low (< 0.1%), the formula degenerates into a
  // symmetric random walk that always returns b/(a+b) for both sides.
  // This is misleading — it looks like a strong signal but is actually
  // just the TP/SL ratio. Return 50% (no edge) instead.
  if (volatility < 0.001) {
    return {
      longPWin: 0.5,
      shortPWin: 0.5,
      drift: mu,
      volatility,
      slDistanceLong: a,
      tpDistanceLong: b,
      explanation: `First-Passage P(TP before SL): vol too low (${(volatility * 100).toFixed(4)}%) — no reliable path-risk signal. Returning 50% (no edge).`,
    };
  }

  const vol = Math.max(volatility, 1e-6);

  const volSq = vol * vol;

  // LONG: SL below (distance a), TP above (distance b)
  // P(TP before SL) = (1 - e^(-2μa/σ²)) / (e^(2μb/σ²) - e^(-2μa/σ²))
  const expNeg2muA = Math.exp((-2 * mu * a) / volSq);
  const expPos2muB = Math.exp((2 * mu * b) / volSq);

  let longPWin: number;
  const denomLong = expPos2muB - expNeg2muA;
  if (Math.abs(denomLong) < 1e-12) {
    // μ ≈ 0 → symmetric random walk → P = b / (a + b) (classical result)
    longPWin = b / (a + b);
  } else {
    longPWin = (1 - expNeg2muA) / denomLong;
  }
  longPWin = Math.max(0, Math.min(1, longPWin));

  // SHORT: SL above (distance a), TP below (distance b)
  // Invert drift sign and swap roles: P(TP before SL) for SHORT
  // = P(hit lower barrier b before upper barrier a) with drift -μ
  // = (e^(2μa/σ²) - 1) / (e^(2μa/σ²) - e^(-2μb/σ²))
  const expPos2muA = Math.exp((2 * mu * a) / volSq);
  const expNeg2muB = Math.exp((-2 * mu * b) / volSq);

  let shortPWin: number;
  const denomShort = expPos2muA - expNeg2muB;
  if (Math.abs(denomShort) < 1e-12) {
    shortPWin = b / (a + b);
  } else {
    shortPWin = (expPos2muA - 1) / denomShort;
  }
  shortPWin = Math.max(0, Math.min(1, shortPWin));

  const explanation = buildExplanation(longPWin, shortPWin, mu, vol, a, b);

  return {
    longPWin,
    shortPWin,
    drift: mu,
    volatility: vol,
    slDistanceLong: a,
    tpDistanceLong: b,
    explanation,
  };
}

function buildExplanation(
  longPWin: number,
  shortPWin: number,
  drift: number,
  vol: number,
  a: number,
  b: number,
): string {
  const driftLabel = drift > 0.0005 ? '↑ upward' : drift < -0.0005 ? '↓ downward' : '→ flat';
  const volLabel = vol > 0.03 ? 'high' : vol > 0.01 ? 'moderate' : 'low';
  const longLabel = longPWin > 0.6 ? '🟢' : longPWin < 0.4 ? '🔴' : '🟡';
  const shortLabel = shortPWin > 0.6 ? '🟢' : shortPWin < 0.4 ? '🔴' : '🟡';

  return [
    `First-Passage P(TP before SL):`,
    `  ${longLabel} LONG  P=${(longPWin * 100).toFixed(0)}% (SL=${(a * 100).toFixed(1)}%, TP=${(b * 100).toFixed(1)}%)`,
    `  ${shortLabel} SHORT P=${(shortPWin * 100).toFixed(0)}% (SL=${(a * 100).toFixed(1)}%, TP=${(b * 100).toFixed(1)}%)`,
    `  Drift: ${driftLabel} (${(drift * 100).toFixed(2)}%/cycle) | Vol: ${volLabel} (${(vol * 100).toFixed(2)}%/cycle)`,
  ].join('\n');
}

/**
 * Estimate per-cycle drift from recent price history.
 *
 * Uses the last N cycle entry prices to compute the average per-cycle
 * return. This is a simple moving-average drift estimator — not sophisticated,
 * but sufficient for first-pass probability calculation.
 *
 * @param prices  Array of historical prices (oldest first)
 * @param n       Number of recent cycles to use (default 10)
 * @returns Per-cycle drift (as a fraction, e.g. 0.001 = 0.1%)
 */
export function estimateDrift(prices: number[], n: number = 10): number {
  if (prices.length < 2) return 0;
  const recent = prices.slice(-Math.min(n, prices.length));
  if (recent.length < 2) return 0;

  let sumReturns = 0;
  let count = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1]!;
    const curr = recent[i]!;
    if (prev > 0 && curr > 0) {
      sumReturns += (curr - prev) / prev;
      count++;
    }
  }

  return count > 0 ? sumReturns / count : 0;
}