// ─── Range-Based Clustering (RBC) Engine ───
// Replaces GMM EM + Pattern Data with a simpler, more robust approach.
//
// For each symbol, maintains two growing hyperrectangles in feature space:
//   - winBox:  range of features that led to winning outcomes
//   - lossBox: range of features that led to losing outcomes
//
// Ranges only EXPAND (never contract) — guarantees monotonic convergence.
// When winBox and lossBox overlap on a dimension, the MIDPOINT of the
// overlap region becomes the decision boundary for that dimension.
//
// 「Ranges compress experience into conservative boundaries」
//
// Symbol-aware: each symbol has its own boxes, since BTC's
// volatility/funding profile differs entirely from MU or ETH.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'rbc' });

// ─── Config ───

const CONFIG = {
  /** Minimum price change (abs) to consider meaningful for hypothetical training */
  minMovePct: 0.0005,          // 0.05%
  /** Price change below this → flat market → both sides lose */
  flatThresholdPct: 0.0005,    // 0.05%
  /** Price change above this → directional win */
  directionalThresholdPct: 0.001, // 0.1%
  /** Minimum samples before query returns non-NO_EDGE */
  minSamplesForQuery: 3,
  /** Edge score threshold: above this → FAVORABLE/UNFAVORABLE */
  edgeThreshold: 0.25,          // 3/12 dims discriminative
  /** Base decay rate per feedTrade(): boxes shrink toward centroids by this fraction.
   *  Actual per-dimension rate is scaled by (1 - confidence × 0.7), so
   *  high-confidence (balanced) dimensions decay slowly while low-confidence
   *  (sample-imbalanced) dimensions decay faster. */
  decayRate: 0.10,              // 10% base per cycle
  /** Centroid exponential time-weighting half-life (in samples/cycles).
   *  Each new sample's weight = 0.5^(age/halfLife). With halfLife=50, a sample
   *  from 50 cycles ago has half the weight of the current one — the centroid
   *  naturally tracks recent market regime without forgetting long-term wins. */
  centroidHalfLifeCycles: 50,
  /** Confidence scaling factor: how much statistical confidence reduces decay.
   *  0.7 means a fully-balanced dimension (equal win/loss counts) decays at
   *  30% of base rate, while a maximally-imbalanced one decays at 100% of base. */
  confidenceDecayReduction: 0.70,
  persistPath: 'data/evolution/rbc-state.json',
} as const;

// ─── Feature Dimensions (same as GMM EM) ───

const FEATURE_NAMES = [
  'volatility', 'srDistanceBps', 'obImbalance',
  'sentiment', 'signalAgreement', 'fundingRate',
  'volumeRatio', 'sentimentConviction',
] as const;

const D = FEATURE_NAMES.length; // 8

// ─── Types ───

export interface RBCBox {
  min: number[];
  max: number[];
  count: number;
  /** Time-weighted centroid (exponential, half-life = centroidHalfLifeCycles).
   *  Recent samples dominate; stale extreme values drift toward the recent mean. */
  centroid: number[];
  /** Cycle index of the most recent sample added to this box. */
  lastSampleCycle: number;
  /** Exponentially-decayed sample count (Σ 0.5^(age/halfLife)). Used for
   *  confidence calculation — reflects effective sample size after time weighting. */
  weightedCount: number;
}

export interface RBCState {
  winBox: RBCBox;
  lossBox: RBCBox;
  totalSamples: number;
}

export interface RBCDimDetail {
  name: string;
  value: number;
  inWin: boolean;
  inLoss: boolean;
  overlap: boolean;
  /** Midpoint of overlap region, or null if no overlap */
  boundary: number | null;
  /** Which side of the boundary the value falls on (only when overlap) */
  side: 'win' | 'loss' | null;
}

export interface RBCQueryResult {
  verdict: 'favorable' | 'unfavorable' | 'no_edge';
  edgeScore: number;
  discriminativeDims: number;
  totalDims: number;
  winDims: number;
  lossDims: number;
  dimDetails: RBCDimDetail[];
  /** Statistical confidence 0-1: how balanced are the (time-weighted) win/loss
   *  sample counts. High confidence (≈1) = both sides well-sampled → verdict
   *  is reliable. Low confidence (<0.3) = one side sparse → verdict is noisy,
   *  agents should weight it less. */
  confidence: number;
  /** Effective (time-decayed) sample count backing this verdict. */
  effectiveSamples: number;
  explanation: string;
}

export interface RBCSymbolStats {
  symbol: string;
  winCount: number;
  lossCount: number;
  totalSamples: number;
  discriminativeDims: number;
  totalDims: number;
}

// ─── Helpers ───

function makeEmptyBox(): RBCBox {
  return {
    min: new Array(D).fill(Infinity),
    max: new Array(D).fill(-Infinity),
    count: 0,
    centroid: new Array(D).fill(0),
    lastSampleCycle: 0,
    weightedCount: 0,
  };
}

function makeEmptyState(): RBCState {
  return { winBox: makeEmptyBox(), lossBox: makeEmptyBox(), totalSamples: 0 };
}

/**
 * Expand a box to include a new sample.
 * Ranges only expand — never contract.
 * Centroid uses exponential time-weighting: recent samples dominate, so the
 * centroid naturally tracks the current market regime. Each new sample's
 * weight = 0.5^((currentCycle - lastSampleCycle) / halfLife), applied by
 * decaying the existing centroid toward the new sample.
 *
 * @param currentCycle  monotonic cycle counter (engine-wide)
 * @param halfLife       centroid time-weighting half-life in cycles
 */
function expandBox(box: RBCBox, vec: number[], currentCycle: number, halfLife: number): void {
  if (box.count === 0) {
    // First sample: initialise
    for (let i = 0; i < D; i++) {
      box.min[i] = vec[i]!;
      box.max[i] = vec[i]!;
      box.centroid[i] = vec[i]!;
    }
    box.count = 1;
    box.lastSampleCycle = currentCycle;
    box.weightedCount = 1;
  } else {
    // Time-weighted update: decay existing centroid by the elapsed cycles,
    // then blend with the new sample. This is equivalent to:
    //   centroid_new = (centroid_old × decayFactor × weightedCount_old + vec) / (decayFactor × weightedCount_old + 1)
    // where decayFactor = 0.5^(Δcycles / halfLife).
    const elapsed = Math.max(0, currentCycle - box.lastSampleCycle);
    const decayFactor = Math.pow(0.5, elapsed / halfLife);
    const prevWeight = box.weightedCount * decayFactor;
    const newWeight = prevWeight + 1;
    box.count++;
    for (let i = 0; i < D; i++) {
      if (vec[i]! < box.min[i]!) box.min[i] = vec[i]!;
      if (vec[i]! > box.max[i]!) box.max[i] = vec[i]!;
      // Time-weighted centroid: blend decayed old centroid with new sample
      box.centroid[i]! = (box.centroid[i]! * prevWeight + vec[i]!) / newWeight;
    }
    box.lastSampleCycle = currentCycle;
    box.weightedCount = newWeight;
  }
}

// ─── RBC Engine ───

export class RBCEngine {
  /** Per-symbol RBC states — key is lowercase symbol */
  private symbols = new Map<string, RBCState>();

  /** Monotonic cycle counter — incremented on every feedTrade() call.
   *  Drives time-weighted centroid updates and per-dimension decay rates. */
  private currentCycle = 0;

  // ─── Lifecycle ───

  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.symbols) {
        for (const [sym, raw] of Object.entries(data.symbols)) {
          const s = raw as any;
          // Validate feature dimension
          const winBox = s.winBox as RBCBox;
          const lossBox = s.lossBox as RBCBox;
          if (!winBox || !lossBox) continue;
          if (winBox.min?.length !== D || lossBox.min?.length !== D) {
            // Backward compat: 9-dim state (with 'direction') → strip index 0
            if (winBox.min?.length === D + 1 && lossBox.min?.length === D + 1) {
              log.info(`[load] ${sym}: migrating 9-dim state → ${D}-dim (dropping 'direction')`);
              const stripDir = (arr: number[]) => arr.slice(1);
              winBox.min = stripDir(winBox.min);
              winBox.max = stripDir(winBox.max);
              winBox.centroid = stripDir(winBox.centroid);
              lossBox.min = stripDir(lossBox.min);
              lossBox.max = stripDir(lossBox.max);
              lossBox.centroid = stripDir(lossBox.centroid);
            } else {
              log.warn(`[load] ${sym}: stale state has wrong dimension (${winBox.min?.length}) — discarding`);
              continue;
            }
          }
          this.symbols.set(sym.toLowerCase(), {
            winBox: this.migrateBox(winBox),
            lossBox: this.migrateBox(lossBox),
            totalSamples: s.totalSamples ?? 0,
          });
        }
        log.info(`RBC states loaded: ${this.symbols.size} symbols`);
        for (const [sym, state] of this.symbols) {
          log.info(`  ${sym}: win=${state.winBox.count} loss=${state.lossBox.count} total=${state.totalSamples}`);
        }
      }
    } catch {
      log.warn('[load] Failed to parse RBC data, starting fresh');
    }
  }

  save(): string {
    const obj: Record<string, any> = {};
    for (const [sym, state] of this.symbols) {
      obj[sym] = {
        winBox: state.winBox,
        lossBox: state.lossBox,
        totalSamples: state.totalSamples,
      };
    }
    return JSON.stringify({ symbols: obj });
  }

  // ─── Training ───

  private getOrCreateState(symbol: string): RBCState {
    const sym = symbol.toLowerCase();
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, makeEmptyState());
    }
    return this.symbols.get(sym)!;
  }

  contextToVector(features: Record<string, number>): number[] {
    return FEATURE_NAMES.map(name => features[name] ?? 0) as number[];
  }

  /**
   * Backward-compat: ensure loaded boxes have the v2.0.11 fields
   * (lastSampleCycle, weightedCount). Old saved states lack these — default
   * them so time-weighted decay starts from a sensible baseline.
   */
  private migrateBox(box: RBCBox): RBCBox {
    if (box.lastSampleCycle === undefined) box.lastSampleCycle = 0;
    if (box.weightedCount === undefined || box.weightedCount === 0) {
      // Seed weightedCount from raw count so confidence calc has a baseline.
      box.weightedCount = box.count;
    }
    return box;
  }

  /**
   * Feed a trade outcome into the per-symbol RBC state.
   * Expands winBox or lossBox ranges (never contracts).
   */
  /**
   * Feed a trade outcome into the per-symbol RBC state.
   * Applies layered decay (shrink ALL dimensions toward centroids, rate scaled
   * by per-dimension statistical confidence) BEFORE expanding, so boxes
   * gradually tighten around their true clusters while stale boundaries fade.
   *
   * Decay strategy (v2.0.11):
   *  - GLOBAL decay: every dimension shrinks toward its centroid (not just
   *    overlap), so stale extreme values from old regimes drift inward.
   *  - CONFIDENCE-scaled rate: dimensions with balanced win/loss sample counts
   *    decay slowly (boundaries are statistically robust); imbalanced dimensions
   *    decay fast (boundaries are fragile/noisy).
   *  - Time-weighted centroid: the shrink target itself tracks recent samples,
   *    so decay pulls boundaries toward the CURRENT regime, not a stale mean.
   */
  feedTrade(symbol: string, features: Record<string, number>, outcome: 1 | 0): void {
    const state = this.getOrCreateState(symbol);
    const vec = this.contextToVector(features);
    state.totalSamples++;
    this.currentCycle++;

    // Apply layered decay before expansion — shrink toward time-weighted centroids
    this.applyDecay(symbol);

    if (outcome === 1) {
      expandBox(state.winBox, vec, this.currentCycle, CONFIG.centroidHalfLifeCycles);
    } else {
      expandBox(state.lossBox, vec, this.currentCycle, CONFIG.centroidHalfLifeCycles);
    }
  }

  /**
   * Layered decay: shrink ALL dimensions of both boxes toward their time-weighted
   * centroids, with the per-dimension rate scaled by statistical confidence.
   *
   * Confidence = min(winCount, lossCount) / max(winCount, lossCount):
   *  - Balanced (80W/80L) → confidence ≈ 1 → rate × (1 - 0.7) = 30% of base
   *    → robust boundaries decay slowly, preserving long-term discriminative power
   *  - Imbalanced (80W/5L) → confidence ≈ 0.06 → rate × (1 - 0.04) ≈ 96% of base
   *    → fragile boundaries decay fast, letting noisy extremes fade quickly
   *
   * This replaces the v2.0.9 overlap-only decay, which (a) left stale non-overlap
   * boundaries frozen forever and (b) shrank win/loss boxes symmetrically even
   * when one side was statistically far more robust than the other.
   */
  applyDecay(symbol: string): void {
    const state = this.getOrCreateState(symbol);
    if (state.totalSamples < CONFIG.minSamplesForQuery) return;

    const wb = state.winBox;
    const lb = state.lossBox;
    if (wb.count === 0 || lb.count === 0) return;

    // Per-box statistical confidence: how balanced are the sample counts?
    // Uses weightedCount (time-decayed) so recent balance matters more than ancient.
    const minW = Math.min(wb.weightedCount, lb.weightedCount);
    const maxW = Math.max(wb.weightedCount, lb.weightedCount);
    const confidence = maxW > 0 ? minW / maxW : 0;
    const reduction = CONFIG.confidenceDecayReduction;
    const rate = CONFIG.decayRate * (1 - confidence * reduction);

    for (let i = 0; i < D; i++) {
      // Global decay: every dimension shrinks toward its time-weighted centroid.
      // This lets stale extreme values (e.g. a win from 200 cycles ago that set
      // winBox.min) drift inward as the centroid tracks the recent regime.
      wb.min[i]! += (wb.centroid[i]! - wb.min[i]!) * rate;
      wb.max[i]! -= (wb.max[i]! - wb.centroid[i]!) * rate;
      lb.min[i]! += (lb.centroid[i]! - lb.min[i]!) * rate;
      lb.max[i]! -= (lb.max[i]! - lb.centroid[i]!) * rate;
    }
  }

  // ─── Query ───

  /**
   * Query: given current feature context, assess whether conditions
   * fall in win territory, loss territory, or overlap (no edge).
   */
  query(symbol: string, features: Record<string, number>): RBCQueryResult {
    const empty = (reason: string): RBCQueryResult => ({
      verdict: 'no_edge',
      edgeScore: 0,
      discriminativeDims: 0,
      totalDims: D,
      winDims: 0,
      lossDims: 0,
      dimDetails: [],
      confidence: 0,
      effectiveSamples: 0,
      explanation: reason,
    });

    const state = this.getOrCreateState(symbol);
    if (state.totalSamples < CONFIG.minSamplesForQuery) {
      return empty(`Only ${state.totalSamples} samples for ${symbol} (need ${CONFIG.minSamplesForQuery})`);
    }

    const vec = this.contextToVector(features);
    const dimDetails: RBCDimDetail[] = [];
    let winDims = 0;
    let lossDims = 0;
    let discriminativeDims = 0;

    for (let i = 0; i < D; i++) {
      const name = FEATURE_NAMES[i]!;
      const value = vec[i]!;
      const wb = state.winBox;
      const lb = state.lossBox;

      const inWin = wb.count > 0 && value >= wb.min[i]! && value <= wb.max[i]!;
      const inLoss = lb.count > 0 && value >= lb.min[i]! && value <= lb.max[i]!;

      let overlap = false;
      let boundary: number | null = null;
      let side: 'win' | 'loss' | null = null;

      if (inWin && inLoss && wb.count > 0 && lb.count > 0) {
        // Both boxes have data and overlap on this dimension
        const overlapMin = Math.max(wb.min[i]!, lb.min[i]!);
        const overlapMax = Math.min(wb.max[i]!, lb.max[i]!);
        if (overlapMin < overlapMax) {
          overlap = true;
          // Midpoint of overlap region = decision boundary
          boundary = (overlapMin + overlapMax) / 2;
          // Which side of the boundary?
          side = value < boundary ? 'win' : 'loss';
          if (side === 'win') winDims++;
          else lossDims++;
        } else if (overlapMin === overlapMax) {
          // Touching at a single point — check if both are singletons with same value
          // (zero discriminative power — all samples have identical value)
          if (wb.min[i] === wb.max[i] && lb.min[i] === lb.max[i] && wb.min[i] === lb.min[i]) {
            overlap = true;
            boundary = wb.min[i]!;
            side = null; // cannot discriminate
          } else {
            // Touching but not overlapping — still discriminative
            discriminativeDims++;
            if (inWin && !inLoss) winDims++;
            else lossDims++;
          }
        } else {
          // No overlap — discriminative
          discriminativeDims++;
          if (inWin && !inLoss) winDims++;
          else lossDims++;
        }
      } else if (inWin && !inLoss) {
        winDims++;
        discriminativeDims++;
      } else if (inLoss && !inWin) {
        lossDims++;
        discriminativeDims++;
      }
      // If in neither, it's outside both boxes — not discriminative

      dimDetails.push({ name, value, inWin, inLoss, overlap, boundary, side });
    }

    const edgeScore = D > 0 ? discriminativeDims / D : 0;
    let verdict: 'favorable' | 'unfavorable' | 'no_edge';

    if (edgeScore >= CONFIG.edgeThreshold) {
      verdict = winDims > lossDims ? 'favorable' : 'unfavorable';
    } else {
      verdict = 'no_edge';
    }

    const explanation = this.formatExplanation(verdict, edgeScore, winDims, lossDims, discriminativeDims, dimDetails, state);

    // Statistical confidence: balance of time-weighted win/loss sample counts.
    const wb = state.winBox;
    const lb = state.lossBox;
    const minW = Math.min(wb.weightedCount, lb.weightedCount);
    const maxW = Math.max(wb.weightedCount, lb.weightedCount);
    const confidence = maxW > 0 ? minW / maxW : 0;
    const effectiveSamples = wb.weightedCount + lb.weightedCount;

    return { verdict, edgeScore, discriminativeDims, totalDims: D, winDims, lossDims, dimDetails, confidence, effectiveSamples, explanation };
  }

  private formatExplanation(
    verdict: 'favorable' | 'unfavorable' | 'no_edge',
    edgeScore: number,
    winDims: number,
    lossDims: number,
    discriminativeDims: number,
    dimDetails: RBCDimDetail[],
    state: RBCState,
  ): string {
    const parts: string[] = [];

    if (verdict === 'favorable') {
      parts.push(`🟢 FAVORABLE (edge=${(edgeScore * 100).toFixed(0)}%, ${winDims}W/${lossDims}L dims)`);
    } else if (verdict === 'unfavorable') {
      parts.push(`🔴 UNFAVORABLE (edge=${(edgeScore * 100).toFixed(0)}%, ${winDims}W/${lossDims}L dims)`);
    } else {
      parts.push(`🟡 NO EDGE (edge=${(edgeScore * 100).toFixed(0)}%, ${discriminativeDims}/${D} dims discriminative)`);
    }

    // Top discriminative features
    const topDims = dimDetails
      .filter(d => d.overlap || d.inWin || d.inLoss)
      .sort((a, b) => {
        const aScore = a.overlap ? 0 : (a.inWin !== a.inLoss ? 1 : 0);
        const bScore = b.overlap ? 0 : (b.inWin !== b.inLoss ? 1 : 0);
        return bScore - aScore;
      })
      .slice(0, 4);

    if (topDims.length > 0) {
      const featStr = topDims.map(d => {
        if (d.overlap && d.boundary !== null) {
          return `${d.name}=${d.value.toFixed(2)} (boundary=${d.boundary.toFixed(2)}, side=${d.side})`;
        }
        if (d.inWin && !d.inLoss) return `${d.name}=${d.value.toFixed(2)} ✅WIN`;
        if (d.inLoss && !d.inWin) return `${d.name}=${d.value.toFixed(2)} ❌LOSS`;
        return `${d.name}=${d.value.toFixed(2)}`;
      }).join(', ');
      parts.push(`Key dims: ${featStr}`);
    }

    // Statistical confidence: balance of time-weighted sample counts.
    // Agents should weight the verdict by this — low confidence means one
    // side is under-sampled and the boundary is noisy.
    const wb = state.winBox;
    const lb = state.lossBox;
    const minW = Math.min(wb.weightedCount, lb.weightedCount);
    const maxW = Math.max(wb.weightedCount, lb.weightedCount);
    const confidence = maxW > 0 ? minW / maxW : 0;
    const confLabel = confidence > 0.6 ? 'high' : confidence > 0.3 ? 'medium' : 'low';
    const effSamples = Math.round(wb.weightedCount + lb.weightedCount);
    parts.push(`Samples: ${wb.count}W/${lb.count}L (eff=${effSamples}, conf=${confLabel})`);

    return parts.join(' | ');
  }

  /** Return all tracked symbol names */
  getAllSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  // ─── Stats (for UI) ───

  getAllModelStats(): RBCSymbolStats[] {
    const result: RBCSymbolStats[] = [];
    for (const [sym, state] of this.symbols) {
      if (state.totalSamples < CONFIG.minSamplesForQuery) continue;
      let discriminativeDims = 0;
      for (let i = 0; i < D; i++) {
        const wb = state.winBox;
        const lb = state.lossBox;
        // Both sides must have data to be discriminative
        if (wb.count === 0 || lb.count === 0) continue;
        const overlapMin = Math.max(wb.min[i]!, lb.min[i]!);
        const overlapMax = Math.min(wb.max[i]!, lb.max[i]!);
        // Discriminative = no overlap (or just touching)
        if (overlapMin >= overlapMax) discriminativeDims++;
      }
      result.push({
        symbol: sym,
        winCount: state.winBox.count,
        lossCount: state.lossBox.count,
        totalSamples: state.totalSamples,
        discriminativeDims,
        totalDims: D,
      });
    }
    return result;
  }

  /** Get per-symbol dim details for UI visualisation (win/loss ranges, centroids, overlap) */
  getDimDetails(symbol: string): Array<{
    name: string;
    winMin: number; winMax: number; winCentroid: number;
    lossMin: number; lossMax: number; lossCentroid: number;
    overlap: boolean; boundary: number | null;
    globalMin: number; globalMax: number;
  }> | null {
    const state = this.getOrCreateState(symbol);
    if (state.totalSamples < CONFIG.minSamplesForQuery) return null;
    const wb = state.winBox;
    const lb = state.lossBox;
    const result: Array<{
      name: string; winMin: number; winMax: number; winCentroid: number;
      lossMin: number; lossMax: number; lossCentroid: number;
      overlap: boolean; boundary: number | null;
      globalMin: number; globalMax: number;
    }> = [];
    for (let i = 0; i < D; i++) {
      const winMin = wb.count > 0 ? wb.min[i]! : 0;
      const winMax = wb.count > 0 ? wb.max[i]! : 0;
      const lossMin = lb.count > 0 ? lb.min[i]! : 0;
      const lossMax = lb.count > 0 ? lb.max[i]! : 0;
      const winCentroid = wb.count > 0 ? wb.centroid[i]! : 0;
      const lossCentroid = lb.count > 0 ? lb.centroid[i]! : 0;
      const allMin = Math.min(winMin, lossMin);
      const allMax = Math.max(winMax, lossMax);
      const overlapMin = Math.max(winMin, lossMin);
      const overlapMax = Math.min(winMax, lossMax);
      const overlap = wb.count > 0 && lb.count > 0 && overlapMin < overlapMax;
      const boundary = overlap ? (overlapMin + overlapMax) / 2 : null;
      result.push({
        name: FEATURE_NAMES[i]!,
        winMin, winMax, winCentroid,
        lossMin, lossMax, lossCentroid,
        overlap, boundary,
        globalMin: allMin,
        globalMax: allMax,
      });
    }
    return result;
  }

  getPendingStats(): Array<{ symbol: string; pending: number; needed: number; pct: number }> {
    const result: Array<{ symbol: string; pending: number; needed: number; pct: number }> = [];
    for (const [sym, state] of this.symbols) {
      if (state.totalSamples === 0) continue;
      result.push({
        symbol: sym,
        pending: state.totalSamples,
        needed: CONFIG.minSamplesForQuery,
        pct: Math.min(100, Math.round((state.totalSamples / CONFIG.minSamplesForQuery) * 100)),
      });
    }
    return result;
  }

  // ─── Agent Context ───

  formatForAgentContext(): string {
    const parts: string[] = [
      '=== RBC ASSESSMENT ===',
      'Range-Based Clustering of historical win/loss feature ranges (per symbol).',
      'Boxes use time-weighted centroids (recent regime dominates) + layered decay',
      '(stale boundaries fade; balanced dimensions decay slowly).',
      'USAGE: FAVORABLE → bias toward entry; UNFAVORABLE → bias against entry;',
      'NO_EDGE → RBC has no opinion, rely on other signals.',
      'Weight verdict by confidence: high (>0.6) = trust it; low (<0.3) = one side',
      'under-sampled, treat verdict as noisy and weight it less.',
    ];
    for (const [sym, state] of this.symbols) {
      if (state.totalSamples < CONFIG.minSamplesForQuery) continue;
      let discriminativeDims = 0;
      for (let i = 0; i < D; i++) {
        const wb = state.winBox;
        const lb = state.lossBox;
        // Both sides must have data to be discriminative
        if (wb.count === 0 || lb.count === 0) continue;
        const overlapMin = Math.max(wb.min[i]!, lb.min[i]!);
        const overlapMax = Math.min(wb.max[i]!, lb.max[i]!);
        if (overlapMin >= overlapMax) discriminativeDims++;
      }
      const edgePct = Math.round((discriminativeDims / D) * 100);
      // Confidence = balance of time-weighted sample counts.
      const minW = Math.min(state.winBox.weightedCount, state.lossBox.weightedCount);
      const maxW = Math.max(state.winBox.weightedCount, state.lossBox.weightedCount);
      const confidence = maxW > 0 ? minW / maxW : 0;
      const confLabel = confidence > 0.6 ? 'high' : confidence > 0.3 ? 'medium' : 'low';
      const effSamples = Math.round(state.winBox.weightedCount + state.lossBox.weightedCount);
      parts.push(`${sym}: ${state.winBox.count}W/${state.lossBox.count}L (eff=${effSamples}, conf=${confLabel}), ${discriminativeDims}/${D} dims (${edgePct}% edge)`);
    }
    if (parts.length === 7) parts.push('  (no RBC data yet)');
    return parts.join('\n');
  }
}
