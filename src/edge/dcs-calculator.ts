// ─── DCS v2 — Discovery Confidence Score Calculator (v2.0.836) ────────
//
// Continuous scoring system that replaces the discrete Q-RL discovery tiers
// (Candidate/Probable/Confirmed) with a [0, 1] continuous score.
//
// Five evidence dimensions + five v2 enhancements:
//   1. Q-value magnitude (qNorm) — how strong is the alpha signal?
//   2. Wilson LB (wilsonNorm) — win rate lower bound confidence
//   3. Visits (visitsNorm) — statistical power (sample size)
//   4. Significance (sigNorm) — bootstrap p-value significance
//   5. Downside consistency (consistencyNorm) — Sortino-style, only downside
//   6. Time decay — 200-cycle half-life (≈16.7h), stale discoveries fade
//   7. Edge Report cross-validation — penalise Q-RL/Edge disagreement
//   8. Recent performance — last 5 rewards vs historical Q (pattern decay)
//   9. Negative Q gate — Q < 0 → DCS = 0 (no alpha = no score)
//
// Used by buildProfileCell() to continuously scale conviction / SL/TP / size
// per risk profile. Moderate is never affected (standard baseline).
// Aggressive gets continuous boost. Conservative gets continuous tightening.

import type { AlphaDiscovery } from '../evolution/q-rl-table.ts';

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

/** Clamp to [min, max]. */
function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(x) ? x : min));
}

/**
 * Compute the Discovery Confidence Score (DCS) v2 — a continuous [0, 1] score
 * that replaces the discrete Q-RL tier system.
 *
 * @param discovery     Q-RL AlphaDiscovery (or null if no discovery matches)
 * @param edgeScore     Edge Report's edgeScore [0, 1] for cross-validation
 * @param rewardHistory Reward history array from the Q-table cell (cap 30)
 * @param ageCycles     Cycles since the discovery was created (for time decay)
 * @returns DCS [0, 1] — 0 = no/weak discovery, 1 = strong fresh confirmed
 */
export function computeDCS(
  discovery: AlphaDiscovery | null,
  edgeScore: number,
  rewardHistory: number[],
  ageCycles: number,
): number {
  // No discovery → DCS = 0
  if (!discovery) return 0;

  // v2.0.836 security: guard against getter bombs / Proxy throws on discovery.
  // Wrap all property access in try-catch — a malicious or misconfigured
  // discovery object (Proxy, getter that throws) must NOT crash the cycle.
  let rawQValue: number;
  let rawWilsonLB: number;
  let rawVisits: number;
  let rawPValue: number;
  try {
    rawQValue = discovery.qValue;
    rawWilsonLB = discovery.wilsonLB;
    rawVisits = discovery.visits;
    rawPValue = discovery.pValue;
  } catch {
    return 0; // any property access throws → treat as no discovery
  }

  // 0. Negative Q hard gate — negative PnL = no alpha
  if (!Number.isFinite(rawQValue) || rawQValue < 0) return 0;

  // Guard: finite inputs
  const safeEdgeScore = Number.isFinite(edgeScore) ? edgeScore : 0.5;
  const safeAge = Math.max(0, Number.isFinite(ageCycles) ? ageCycles : 0);
  const safeRewards = Array.isArray(rewardHistory)
    ? rewardHistory.filter((r) => typeof r === 'number' && Number.isFinite(r))
    : [];

  // ── 1. Five evidence dimensions (each [0, 1]) ──────────────────────
  const qNorm = clamp01((rawQValue - 0.002) / 0.018); // Q magnitude: 0.2% → 2%
  const wilsonNorm = clamp01((rawWilsonLB - 0.40) / 0.45); // Wilson LB: 40% → 85%
  const visitsNorm = clamp01((rawVisits - 10) / 90); // Visits: 10 → 100
  const sigNorm = clamp01((0.05 - rawPValue) / 0.049); // p-value: 0.05 → 0.001

  // v2 NEW: downside consistency (Sortino-style — only penalise downside)
  // Measures how much rewards deviate BELOW the Q-value (downside only).
  // A cell with consistent small wins scores higher than a cell with big wins
  // and big losses (same average Q but different risk).
  const absQ = Math.abs(rawQValue) + 0.001; // avoid div-by-zero
  const downsideValues = safeRewards.filter((r) => r < rawQValue);
  const downsideDev = downsideValues.length > 0
    ? Math.sqrt(
        downsideValues.reduce((s, r) => s + (r - rawQValue) ** 2, 0)
        / Math.max(1, safeRewards.length),
      )
    : 0;
  const consistencyNorm = clamp01(1 - downsideDev / absQ);

  // ── 2. Base DCS: weighted blend (5 dimensions → 1 score) ──────────
  const dcsBase =
      0.22 * qNorm
    + 0.22 * wilsonNorm
    + 0.18 * visitsNorm
    + 0.18 * sigNorm
    + 0.20 * consistencyNorm;

  // ── 3. v2 NEW: Time decay (200-cycle half-life ≈ 16.7h) ────────────
  // Stale discoveries lose influence. A discovery from 500 cycles ago
  // has timeDecay = e^(-500/200) ≈ 0.082 → DCS drops to ~8% of base.
  const timeDecay = Math.exp(-safeAge / 200);
  const dcsTime = dcsBase * timeDecay;

  // ── 4. v2 NEW: Edge Report cross-validation ────────────────────────
  // If Q-RL says DCS=0.8 but Edge Report says edgeScore=0.2, they disagree.
  // agreementFactor penalises this: full agreement → 1.0, full disagreement → 0.7
  const agreement = 1 - Math.abs(dcsTime - safeEdgeScore);
  const agreementFactor = 0.7 + 0.3 * clamp01(agreement); // [0.7, 1.0]

  // ── 5. v2 NEW: Recent cell performance (last 5 rewards) ────────────
  // If Q is high but the last 5 trades were all losses, the pattern may
  // have decayed. recentFactor scales DCS down when recent performance
  // diverges negatively from the historical Q.
  const last5 = safeRewards.slice(-5);
  const recentMean = last5.length > 0
    ? last5.reduce((a, b) => a + b, 0) / last5.length
    : 0;
  const recentFactor = clamp(
    0.5 + 0.5 * (recentMean / absQ),
    0.3, // floor: never below 30% (don't fully zero a historical discovery)
    1.0,
  );

  // ── 6. Final DCS ───────────────────────────────────────────────────
  return clamp01(dcsTime * agreementFactor * recentFactor);
}

/**
 * Compute the profile-specific conviction factor from DCS.
 *
 * Aggressive: `1.0 + 0.15 × DCS²` [1.0, 1.15] — quadratic so weak discoveries
 *   barely boost. DCS=0 → no boost, DCS=1 → +15%.
 * Moderate: always 1.0 (standard, never changes).
 * Conservative: DCS ≥ 0.55 → 1.0 (honest, no dampen — protection comes from
 *   the DCS gate + threshold ×1.15 + Edge Report, not from dampening conviction).
 *   DCS 0.3–0.55 → linear ramp [0, 0.3] — extremely low conviction,
 *   threshold ×1.15 will block most trades but it's not a hard HOLD
 *   (extremely strong consensus might squeeze through).
 *   DCS < 0.3 → return -1 to signal hard HOLD.
 *
 * @returns conviction factor [0, 1.15], or -1 for hard HOLD
 */
export function dcsConvictionFactor(
  dcs: number,
  profile: 'aggressive' | 'moderate' | 'conservative',
): number {
  // v2.0.836 security: clamp DCS to [0, 1] — negative DCS must NOT boost,
  // DCS > 1 must NOT exceed the designed range.
  const safeDcs = Number.isFinite(dcs) ? Math.max(0, Math.min(1, dcs)) : 0;

  if (profile === 'moderate') return 1.0; // never changes

  if (profile === 'aggressive') {
    // Quadratic boost: weak DCS barely affects, strong DCS full boost
    return 1.0 + 0.15 * safeDcs * safeDcs; // [1.0, 1.15]
  }

  // Conservative
  if (safeDcs >= 0.55) return 1.0; // honest conviction — triple protection sufficient
  if (safeDcs < 0.3) return -1; // hard HOLD signal
  // DCS 0.3–0.55: linear ramp from 0 to 0.3
  return 0.3 * (safeDcs - 0.3) / 0.25; // [0, 0.3]
}

/**
 * Compute the profile-specific SL multiplier from DCS.
 *
 * Aggressive: `1.0 + 0.3 × DCS` [1.0, 1.3] — DCS=0 → standard, DCS=1 → 30% wider
 * Moderate: always 1.0
 * Conservative: `0.7 + 0.3 × DCS` [0.7, 1.0] — DCS=0 → 30% tighter, DCS=1 → standard
 */
export function dcsSlMultiplier(
  dcs: number,
  profile: 'aggressive' | 'moderate' | 'conservative',
): number {
  // v2.0.836 security: clamp DCS to [0, 1]
  const safeDcs = Number.isFinite(dcs) ? Math.max(0, Math.min(1, dcs)) : 0;
  if (profile === 'moderate') return 1.0;
  if (profile === 'aggressive') return 1.0 + 0.3 * safeDcs; // [1.0, 1.3]
  return 0.7 + 0.3 * safeDcs; // conservative [0.7, 1.0]
}

/**
 * Compute the profile-specific TP multiplier from DCS.
 *
 * Aggressive: `1.0 + 0.5 × DCS` [1.0, 1.5]
 * Moderate: always 1.0
 * Conservative: `0.8 + 0.2 × DCS` [0.8, 1.0]
 */
export function dcsTpMultiplier(
  dcs: number,
  profile: 'aggressive' | 'moderate' | 'conservative',
): number {
  // v2.0.836 security: clamp DCS to [0, 1]
  const safeDcs = Number.isFinite(dcs) ? Math.max(0, Math.min(1, dcs)) : 0;
  if (profile === 'moderate') return 1.0;
  if (profile === 'aggressive') return 1.0 + 0.5 * safeDcs; // [1.0, 1.5]
  return 0.8 + 0.2 * safeDcs; // conservative [0.8, 1.0]
}

/**
 * Compute the profile-specific position size factor from DCS.
 *
 * Aggressive: `1.0 + 0.3 × DCS` [1.0, 1.3]
 * Moderate: always 1.0
 * Conservative: `0.3 + 0.2 × DCS` [0.3, 0.5]
 */
export function dcsSizeFactor(
  dcs: number,
  profile: 'aggressive' | 'moderate' | 'conservative',
): number {
  // v2.0.836 security: clamp DCS to [0, 1]
  const safeDcs = Number.isFinite(dcs) ? Math.max(0, Math.min(1, dcs)) : 0;
  if (profile === 'moderate') return 1.0;
  if (profile === 'aggressive') return 1.0 + 0.3 * safeDcs; // [1.0, 1.3]
  return 0.3 + 0.2 * safeDcs; // conservative [0.3, 0.5]
}

/**
 * Profile-specific SL cap (max SL %).
 * Aggressive: 7%, Moderate: 5%, Conservative: 3%
 */
export function dcsSlCap(profile: 'aggressive' | 'moderate' | 'conservative'): number {
  if (profile === 'aggressive') return 0.07;
  if (profile === 'conservative') return 0.03;
  return 0.05;
}

/**
 * Profile-specific TP cap (max TP %).
 * Aggressive: 15%, Moderate: 10%, Conservative: 6%
 */
export function dcsTpCap(profile: 'aggressive' | 'moderate' | 'conservative'): number {
  if (profile === 'aggressive') return 0.15;
  if (profile === 'conservative') return 0.06;
  return 0.10;
}

/**
 * Profile-specific TP minimum (min viable TP %).
 * Aggressive: 0.5%, Moderate: 0.3%, Conservative: 0.2%
 */
export function dcsTpMin(profile: 'aggressive' | 'moderate' | 'conservative'): number {
  if (profile === 'aggressive') return 0.005;
  if (profile === 'conservative') return 0.002;
  return 0.003;
}