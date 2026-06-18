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
  /** Decay rate per feedTrade(): overlap regions shrink toward centroids by this fraction */
  decayRate: 0.10,              // 10% per cycle — prevents box saturation
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
  centroid: number[];
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
  };
}

function makeEmptyState(): RBCState {
  return { winBox: makeEmptyBox(), lossBox: makeEmptyBox(), totalSamples: 0 };
}

/**
 * Expand a box to include a new sample.
 * Ranges only expand — never contract.
 * Centroid is running average.
 */
function expandBox(box: RBCBox, vec: number[]): void {
  if (box.count === 0) {
    // First sample: initialise
    for (let i = 0; i < D; i++) {
      box.min[i] = vec[i]!;
      box.max[i] = vec[i]!;
      box.centroid[i] = vec[i]!;
    }
    box.count = 1;
  } else {
    box.count++;
    for (let i = 0; i < D; i++) {
      if (vec[i]! < box.min[i]!) box.min[i] = vec[i]!;
      if (vec[i]! > box.max[i]!) box.max[i] = vec[i]!;
      // Running average for centroid
      box.centroid[i]! += (vec[i]! - box.centroid[i]!) / box.count;
    }
  }
}

// ─── RBC Engine ───

export class RBCEngine {
  /** Per-symbol RBC states — key is lowercase symbol */
  private symbols = new Map<string, RBCState>();

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
            winBox,
            lossBox,
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
   * Feed a trade outcome into the per-symbol RBC state.
   * Expands winBox or lossBox ranges (never contracts).
   */
  /**
   * Feed a trade outcome into the per-symbol RBC state.
   * Applies decay (shrink overlap toward centroids) BEFORE expanding,
   * so boxes gradually tighten around their true clusters.
   */
  feedTrade(symbol: string, features: Record<string, number>, outcome: 1 | 0): void {
    const state = this.getOrCreateState(symbol);
    const vec = this.contextToVector(features);
    state.totalSamples++;

    // Apply decay before expansion — shrink overlap regions toward centroids
    this.applyDecay(symbol);

    if (outcome === 1) {
      expandBox(state.winBox, vec);
    } else {
      expandBox(state.lossBox, vec);
    }
  }

  /**
   * Shrink overlap regions toward each box's centroid.
   * When winBox and lossBox overlap on a dimension, both boxes contract
   * toward their respective centroids by decayRate fraction.
   * Non-overlapping dimensions are untouched — they retain full discriminative range.
   * This prevents box saturation (all dimensions overlapping → permanent NO_EDGE).
   */
  applyDecay(symbol: string): void {
    const state = this.getOrCreateState(symbol);
    if (state.totalSamples < CONFIG.minSamplesForQuery) return;

    const wb = state.winBox;
    const lb = state.lossBox;
    if (wb.count === 0 || lb.count === 0) return;

    const rate = CONFIG.decayRate;
    for (let i = 0; i < D; i++) {
      const overlapMin = Math.max(wb.min[i]!, lb.min[i]!);
      const overlapMax = Math.min(wb.max[i]!, lb.max[i]!);

      if (overlapMin < overlapMax) {
        // Overlap exists — shrink both boxes toward their centroids
        wb.min[i]! += (wb.centroid[i]! - wb.min[i]!) * rate;
        wb.max[i]! -= (wb.max[i]! - wb.centroid[i]!) * rate;
        lb.min[i]! += (lb.centroid[i]! - lb.min[i]!) * rate;
        lb.max[i]! -= (lb.max[i]! - lb.centroid[i]!) * rate;
      }
      // Non-overlapping dimensions: untouched — retain full discriminative range
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

    return { verdict, edgeScore, discriminativeDims, totalDims: D, winDims, lossDims, dimDetails, explanation };
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

    parts.push(`Samples: ${state.winBox.count}W / ${state.lossBox.count}L`);

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
    const parts: string[] = ['=== RBC ASSESSMENT ==='];
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
      parts.push(`${sym}: ${state.winBox.count}W/${state.lossBox.count}L samples, ${discriminativeDims}/${D} dims discriminative (${edgePct}% edge)`);
    }
    if (parts.length === 1) parts.push('  (no RBC data yet)');
    return parts.join('\n');
  }
}
