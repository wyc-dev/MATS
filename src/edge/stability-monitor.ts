// ─── Stability Monitor (Task 1C) ──────────────────────────────────────
//
// v2.0.833: Measures how fragile a signal is. Two complementary metrics:
//
//   1. Perturbation stability — if we nudge the entry market features by
//      ±5%, does the decision flip? A signal that flips on a 5% nudge is
//      noise-driven, not alpha-driven. This is the SKHX buy→SL→buy→SL loop
//      pattern (v2.0.229): each "buy" looked like an edge but was a coin
//      flip on the feature boundary.
//
//   2. Cross-time consistency — over the last N cycles, how often did the
//      direction flip? A symbol that oscillates buy/sell every cycle is
//      chasing noise, not a trend. High flip rate ⇒ conviction is downweighted
//      and the recommendation is downgraded (trade → caution → skip).
//
// Both metrics are PURE MATH — no LLM, no network, milliseconds. They run
// every cycle and feed the EdgeReport.stability field. They never hard-block
// a trade; they only adjust conviction and downgrade the recommendation.

import { safeNum } from '../evolution/evolution-utils.ts';
import { edgeConfig } from './edge-config.ts';

/** A lightweight decision snapshot used for perturbation + cross-time tests.
 *  We deliberately avoid re-running the LLM (non-deterministic + expensive);
 *  instead we recompute the deterministic feature→action mapping that the
 *  consensus already used. Callers pass the features + the action the
 *  consensus picked, and a pure function that maps features → action. */
export interface DecisionSnapshot {
  symbol: string;
  action: 'buy' | 'sell' | 'hold' | 'close' | 'flip';
  entryMarketFeatures: Record<string, number>;
  /** ms epoch of the cycle this decision was made. */
  ts: number;
}

/** A pure function that maps features → action. Injected by the caller so
 *  this module stays decoupled from HACP. Must be deterministic (no LLM). */
export type ActionFromFeatures = (features: Record<string, number>) => 'buy' | 'sell' | 'hold';

/**
 * Stability Monitor — accumulates recent decisions per symbol and computes
 * perturbation + cross-time stability. Stateless across restarts by design
 * (stability is a short-horizon metric; re-warming from disk adds little).
 */
export class StabilityMonitor {
  private history = new Map<string, DecisionSnapshot[]>();

  /** Record a decision. Called once per cycle per symbol after consensus. */
  recordDecision(snap: DecisionSnapshot): void {
    const sym = snap.symbol.toLowerCase();
    let arr = this.history.get(sym);
    if (!arr) {
      arr = [];
      this.history.set(sym, arr);
    }
    arr.push(snap);
    // keep only the lookback window (max of perturbation + cross-time).
    const maxLookback = Math.max(edgeConfig.perturbLookback, edgeConfig.crossTimeLookback);
    if (arr.length > maxLookback) arr.shift();
  }

  /** Compute the stability factor [0.85, 1.0] for a symbol.
   *  Returns { perturbation, crossTime, factor } where `factor` is what
   *  multiplies conviction; below stabilityMid the recommendation should be
   *  downgraded (handled by EdgeCalculator, not here). */
  computeStability(
    symbol: string,
    actionFromFeatures: ActionFromFeatures,
  ): { perturbation: number; crossTime: number; factor: number } {
    const sym = symbol.toLowerCase();
    const arr = this.history.get(sym) ?? [];

    // ── Perturbation test ────────────────────────────────────────────────
    // For each of the last `perturbLookback` decisions, nudge every numeric
    // feature by ±perturbMagnitude and recompute the action. A flip = the
    // decision is sensitive to noise at that magnitude.
    const perturbN = Math.min(arr.length, edgeConfig.perturbLookback);
    let perturbFlips = 0;
    for (let i = arr.length - perturbN; i < arr.length; i++) {
      if (i < 0) continue;
      const snap = arr[i];
      if (!snap || !snap.entryMarketFeatures) continue;
      const perturbed = perturbFeatures(snap.entryMarketFeatures, edgeConfig.perturbMagnitude);
      try {
        const rerun = actionFromFeatures(perturbed);
        if (rerun !== snap.action) perturbFlips++;
      } catch {
        // a crash in the recompute = treat as a flip (signal is fragile).
        perturbFlips++;
      }
    }
    const perturbation = perturbN > 0 ? 1 - (perturbFlips / perturbN) : 1;

    // ── Cross-time consistency ──────────────────────────────────────────
    // Count direction flips over the last `crossTimeLookback` snapshots.
    // 'hold' and 'close' are not direction flips (they are absence of signal).
    const crossN = Math.min(arr.length, edgeConfig.crossTimeLookback);
    let crossFlips = 0;
    let lastDir: 'buy' | 'sell' | null = null;
    for (let i = arr.length - crossN; i < arr.length; i++) {
      if (i < 0) continue;
      const a = arr[i]?.action;
      if (a === 'buy' || a === 'sell') {
        if (lastDir !== null && a !== lastDir) crossFlips++;
        lastDir = a;
      }
    }
    const maxFlips = Math.max(0, crossN - 1);
    const crossTime = maxFlips > 0 ? 1 - (crossFlips / maxFlips) : 1;

    // ── Factor ──────────────────────────────────────────────────────────
    // Use the WORSE of the two metrics — a signal that is perturbation-stable
    // but oscillates direction is still fragile, and vice versa.
    const worst = Math.min(perturbation, crossTime);
    let factor: number;
    if (worst >= edgeConfig.stabilityStable) {
      factor = 1.0;
    } else if (worst >= edgeConfig.stabilityMid) {
      factor = edgeConfig.stabilityFactorMid;
    } else {
      // below mid — aggressive downgrade. The EdgeCalculator will translate
      // this into a recommendation downgrade (trade → caution → skip).
      factor = Math.max(0.5, worst);
    }
    return { perturbation, crossTime, factor };
  }

  /** Reset — used by tests. */
  reset(): void {
    this.history.clear();
  }
}

/** Nudge every numeric feature by ±magnitude uniformly at random.
 *  Pure function, no mutation of input. */
export function perturbFeatures(
  features: Record<string, number>,
  magnitude: number,
): Record<string, number> {
  // v2.0.835 security: guard against null/undefined features
  if (!features || typeof features !== 'object') return {};
  const out: Record<string, number> = {};
  // v2.0.835 security: Object.entries can trigger getters that throw.
  // Wrap in try-catch so a malicious feature object can't crash the cycle.
  let entries: [string, unknown][];
  try {
    entries = Object.entries(features);
  } catch {
    return {};
  }
  for (const [k, v] of entries) {
    // v2.0.835 security: getter could throw on property access — guard each access
    let val: number;
    try {
      val = typeof v === 'number' ? v : Number(v);
    } catch {
      val = 0;
    }
    const safe = Number.isFinite(val) ? val : 0;
    // symmetric ±nudge around the current value. Avoid sign flip when the
    // feature is near zero (a tiny feature nudged past zero is a different
    // regime, not noise) by using multiplicative perturbation for |v|>1e-6.
    const nudge = Math.abs(safe) > 1e-6
      ? safe * (1 + (Math.random() * 2 - 1) * magnitude)
      : safe + (Math.random() * 2 - 1) * magnitude * 0.01;
    out[k] = nudge;
  }
  return out;
}