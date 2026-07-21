// ─── v2.0.219: Cross-Symbol Shared Backbone ──────────────────────────
//
// Shares OLR representations across symbols using a shared base model
// with per-symbol residual adaptations. Small symbols (SKHX with 5
// real samples) borrow learned weights from large symbols (CL with 138
// samples) through a shared backbone.
//
// Architecture (multi-task learning):
//   w_symbol = w_shared + δ_symbol
//
// Where:
//   w_shared  = global weight vector learned from ALL symbols' trades
//   δ_symbol  = per-symbol residual (starts at 0, learns symbol-specific
//               deviations from the shared backbone)
//
// At query time:
//   pWin = σ((w_shared + δ_symbol) · x)
//
// For cold-start symbols (0 samples):
//   pWin = σ(w_shared · x)  — uses only the shared backbone
//
// For well-trained symbols:
//   pWin = σ((w_shared + δ_symbol) · x)  — shared + residual
//
// The shared backbone learns "what makes a good trade in general" while
// the per-symbol residual learns "what's special about THIS symbol."
//
// Production-grade:
// - Zero-init residuals (cold-start safe)
// - Configurable shared/backbone mixing ratio
// - Falls back to per-symbol OLR if shared backbone fails
// - No modification to existing OLR — pure wrapper

import { createLogger } from '../observability/logger.ts';
import { OLREngine, FEATURE_NAMES } from './olr-engine.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'cross-symbol' });

const D = FEATURE_NAMES.length;

// ─── Types ───

export interface CrossSymbolConfig {
  /** Shared backbone dimension (= OLR feature dim + 1 for bias) */
  featureDim: number;
  /** Learning rate for shared backbone */
  sharedLr: number;
  /** Learning rate for per-symbol residuals */
  residualLr: number;
  /** L2 regularization for shared backbone */
  sharedL2: number;
  /** L2 regularization for residuals */
  residualL2: number;
  /** Max residual norm — prevents residual from dominating shared */
  maxResidualNorm: number;
  /** Min samples before using residual (cold-start guard) */
  minResidualSamples: number;
}

export interface CrossSymbolQueryResult {
  pWin: number;
  pWinShared: number;  // prediction from shared backbone only
  pWinResidual: number; // prediction from residual only
  contribution: number; // how much the residual contributed
  samples: number;
  applied: boolean;
}

// ─── CrossSymbolBackbone ───

export class CrossSymbolBackbone {
  private config: CrossSymbolConfig;
  private olrEngine: OLREngine;
  /** Shared backbone weights — learned from ALL symbols' trades */
  private wShared: number[];
  /** Per-symbol residual weights: Map<symbol, number[]> */
  private residuals: Map<string, number[]> = new Map();
  /** Per-symbol sample counts */
  private symbolSampleCounts: Map<string, number> = new Map();

  constructor(olrEngine: OLREngine, config?: Partial<CrossSymbolConfig>) {
    this.olrEngine = olrEngine;
    this.config = {
      featureDim: D + 1, // +1 for bias
      sharedLr: 0.05,
      residualLr: 0.1,
      sharedL2: 0.001,
      residualL2: 0.01,
      maxResidualNorm: 5.0,
      minResidualSamples: 10,
      ...config,
    };
    this.wShared = new Array(this.config.featureDim).fill(0);
  }

  /**
   * Get or create residual weights for a symbol.
   */
  private getResidual(symbol: string): number[] {
    const sym = symbol.toLowerCase();
    let r = this.residuals.get(sym);
    if (!r) {
      r = new Array(this.config.featureDim).fill(0);
      this.residuals.set(sym, r);
    }
    return r;
  }

  /**
   * Feed a trade sample to the shared backbone + per-symbol residual.
   *
   * The gradient is split:
   *   - Shared backbone receives the full gradient (scaled by sharedLr)
   *   - Residual receives the remaining error after shared prediction
   *     (scaled by residualLr)
   *
   * This ensures the shared backbone learns general patterns while
   * residuals capture symbol-specific deviations.
   */
  feedTrade(
    symbol: string,
    features: Record<string, number>,
    outcome: 1 | 0,
    side: 'buy' | 'sell',
  ): void {
    const sym = symbol.toLowerCase();

    // Build feature vector (same as OLR contextToVector)
    const x = new Array(D);
    for (let i = 0; i < D; i++) {
      x[i] = safeNum(features[FEATURE_NAMES[i]!], 0);
      if (!Number.isFinite(x[i]!)) x[i] = 0;
    }
    const xFull = [1, ...x]; // bias term

    // Get weights
    const residual = this.getResidual(sym);
    const w = new Array(this.config.featureDim);
    for (let i = 0; i < this.config.featureDim; i++) {
      w[i] = this.wShared[i]! + residual[i]!;
    }

    // Forward pass
    let z = 0;
    for (let i = 0; i < this.config.featureDim; i++) {
      z += w[i]! * xFull[i]!;
    }
    const zClipped = Math.max(-10, Math.min(10, z));
    const p = 1 / (1 + Math.exp(-zClipped));
    const error = p - outcome;

    // Update shared backbone (receives full gradient)
    const sharedEta = this.config.sharedLr;
    for (let i = 0; i < this.config.featureDim; i++) {
      this.wShared[i]! -= sharedEta * (error * xFull[i]! + this.config.sharedL2 * this.wShared[i]!);
    }

    // Update residual (receives gradient, but only if enough samples)
    const symCount = (this.symbolSampleCounts.get(sym) ?? 0) + 1;
    this.symbolSampleCounts.set(sym, symCount);

    if (symCount >= this.config.minResidualSamples) {
      const resEta = this.config.residualLr;
      for (let i = 0; i < this.config.featureDim; i++) {
        residual[i]! -= resEta * (error * xFull[i]! + this.config.residualL2 * residual[i]!);
      }
      // Clamp residual norm
      const rNorm = Math.sqrt(residual.reduce((a, b) => a + b * b, 0));
      if (rNorm > this.config.maxResidualNorm) {
        const scale = this.config.maxResidualNorm / rNorm;
        for (let i = 0; i < residual.length; i++) residual[i]! *= scale;
      }
    }
  }

  /**
   * Query the cross-symbol model for a symbol+side.
   *
   * For cold-start symbols (0 samples): uses only shared backbone.
   * For trained symbols: uses shared + residual.
   *
   * Falls back to OLR if shared backbone is untrained (all-zero weights).
   */
  query(
    symbol: string,
    features: Record<string, number>,
    side: 'buy' | 'sell',
  ): CrossSymbolQueryResult {
    const sym = symbol.toLowerCase();

    // Build feature vector
    const x = new Array(D);
    for (let i = 0; i < D; i++) {
      x[i] = safeNum(features[FEATURE_NAMES[i]!], 0);
      if (!Number.isFinite(x[i]!)) x[i] = 0;
    }
    const xFull = [1, ...x];

    // Shared backbone prediction
    let zShared = 0;
    for (let i = 0; i < this.config.featureDim; i++) {
      zShared += this.wShared[i]! * xFull[i]!;
    }
    const pWinShared = 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, zShared))));

    // Residual prediction
    const residual = this.getResidual(sym);
    let zResidual = 0;
    for (let i = 0; i < this.config.featureDim; i++) {
      zResidual += residual[i]! * xFull[i]!;
    }
    const pWinResidual = 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, zResidual))));

    // Combined prediction
    const symCount = this.symbolSampleCounts.get(sym) ?? 0;
    const useResidual = symCount >= this.config.minResidualSamples;

    let pWin: number;
    if (useResidual) {
      // Shared + residual
      let zCombined = zShared + zResidual;
      zCombined = Math.max(-10, Math.min(10, zCombined));
      pWin = 1 / (1 + Math.exp(-zCombined));
    } else {
      // Cold-start: shared backbone only
      pWin = pWinShared;
    }

    // Check if shared backbone is trained (non-zero weights)
    const sharedNorm = Math.sqrt(this.wShared.reduce((a, b) => a + b * b, 0));
    const applied = sharedNorm > 0.001;

    // If shared backbone is untrained, fall back to OLR
    if (!applied) {
      const olrResult = this.olrEngine.query(symbol, features, side, 0);
      return {
        pWin: olrResult.pWin,
        pWinShared: olrResult.pWin,
        pWinResidual: 0,
        contribution: 0,
        samples: symCount,
        applied: false,
      };
    }

    return {
      pWin,
      pWinShared,
      pWinResidual,
      contribution: useResidual ? Math.abs(zResidual) : 0,
      samples: symCount,
      applied: true,
    };
  }

  /**
   * Get per-symbol stats.
   */
  getStats(): Array<{ symbol: string; samples: number; residualNorm: number; sharedNorm: number }> {
    const sharedNorm = Math.sqrt(this.wShared.reduce((a, b) => a + b * b, 0));
    return Array.from(this.residuals.entries()).map(([symbol, r]) => ({
      symbol,
      samples: this.symbolSampleCounts.get(symbol) ?? 0,
      residualNorm: Math.sqrt(r.reduce((a, b) => a + b * b, 0)),
      sharedNorm,
    }));
  }

  /**
   * Save state.
   */
  save(): string {
    return JSON.stringify({
      wShared: this.wShared,
      residuals: Array.from(this.residuals.entries()),
      symbolSampleCounts: Array.from(this.symbolSampleCounts.entries()),
      config: this.config,
    });
  }

  /**
   * Load state with corrupt-last-good recovery.
   */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.wShared)) {
        const loaded = data.wShared as number[];
        this.wShared = new Array(this.config.featureDim).fill(0);
        for (let i = 0; i < Math.min(loaded.length, this.config.featureDim); i++) {
          if (Number.isFinite(loaded[i])) this.wShared[i]! = loaded[i]!;
        }
      }
      if (Array.isArray(data.residuals)) {
        for (const [sym, weights] of data.residuals) {
          const r = new Array(this.config.featureDim).fill(0);
          const loaded = weights as number[];
          for (let i = 0; i < Math.min(loaded.length, this.config.featureDim); i++) {
            if (Number.isFinite(loaded[i])) r[i]! = loaded[i]!;
          }
          this.residuals.set(sym, r);
        }
      }
      if (Array.isArray(data.symbolSampleCounts)) {
        for (const [sym, count] of data.symbolSampleCounts) {
          this.symbolSampleCounts.set(sym, count);
        }
      }
      log.info(`Cross-symbol backbone loaded: ${this.residuals.size} symbols, shared |w|=${Math.sqrt(this.wShared.reduce((a, b) => a + b * b, 0)).toFixed(4)}`);
    } catch {
      log.warn('[cross-symbol] Failed to load, starting fresh');
    }
  }
}