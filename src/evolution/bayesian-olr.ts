// ─── v2.0.219: Bayesian OLR Wrapper (MC Dropout Uncertainty) ────────
//
// Wraps the existing OLR engine with Monte Carlo Dropout uncertainty
// estimation. Instead of a single point-estimate pWin, this produces:
//   - pWin_mean: averaged prediction (more robust)
//   - pWin_std: epistemic uncertainty (how confident is the model?)
//   - pWin_low/pWin_high: 90% credible interval
//
// This enables the system to distinguish:
//   - "50% because we genuinely don't know" (high std)
//   - "50% because the model is well-calibrated" (low std)
//
// Technique: Gal & Ghahramani 2016 — MC Dropout as Bayesian approximation.
// We apply Bernoulli dropout to the OLR weight vector during inference,
// run N forward passes, and compute statistics over the predictions.
//
// Key insight: OLR's logistic regression is equivalent to a 1-layer neural
// network with no hidden layers. Applying dropout to the input features
// (feature dropout) is the Bayesian approximation for this architecture.
//
// Production-grade safety:
// - Cold-start safe: if OLR has < minSamples, returns unmodified prediction
// - No modification to OLR internals — pure wrapper
// - Configurable dropout rate and MC passes
// - Deterministic seed for reproducibility (optional)

import { createLogger } from '../observability/logger.ts';
import { OLREngine } from './olr-engine.ts';

const log = createLogger({ phase: 'bayesian-olr' });

export interface BayesianConfig {
  /** Dropout rate for MC sampling (0 = disabled, 0.1 = 10% features dropped) */
  dropoutRate: number;
  /** Number of MC forward passes */
  mcPasses: number;
  /** Confidence interval (0.9 = 90% CI, 0.95 = 95% CI) */
  ciLevel: number;
  /** Minimum OLR samples for uncertainty estimation */
  minSamples: number;
  /** Random seed for reproducibility (0 = use Math.random) */
  seed: number;
}

export interface BayesianResult {
  pWin_mean: number;
  pWin_std: number;
  pWin_low: number;
  pWin_high: number;
  pWin_point: number;
  /** Epistemic uncertainty: 0 = certain, 1 = maximally uncertain */
  uncertainty: number;
  /** Number of MC passes actually used */
  passes: number;
  /** Whether dropout was applied (false if cold-start) */
  applied: boolean;
}

// ─── Seeded RNG for reproducibility ───

class SeededRNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed > 0 ? seed : 1;
  }
  next(): number {
    // xorshift32
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return ((this.state >>> 0) / 0xFFFFFFFF);
  }
}

// ─── BayesianOLR ───

export class BayesianOLR {
  private config: BayesianConfig;
  private olrEngine: OLREngine;

  constructor(olrEngine: OLREngine, config?: Partial<BayesianConfig>) {
    this.olrEngine = olrEngine;
    this.config = {
      dropoutRate: 0.1,
      mcPasses: 30,
      ciLevel: 0.9,
      minSamples: 20,
      seed: 0,
      ...config,
    };
  }

  /**
   * Query OLR with MC Dropout uncertainty estimation.
   *
   * @param symbol   Symbol to query
   * @param features Market features
   * @param side     Direction
   * @param cycle    Current cycle
   * @returns BayesianResult with mean, std, CI, uncertainty
   */
  query(
    symbol: string,
    features: Record<string, number>,
    side: 'buy' | 'sell',
    cycle: number,
  ): BayesianResult {
    // Cold-start: return point estimate without uncertainty
    const stats = this.olrEngine.getAllModelStats().find(s => s.symbol === symbol.toLowerCase());
    const samples = side === 'buy' ? (stats?.longSamples ?? 0) : (stats?.shortSamples ?? 0);

    const pointResult = this.olrEngine.query(symbol, features, side, cycle);
    const pWin_point = pointResult.pWin;

    if (samples < this.config.minSamples) {
      return {
        pWin_mean: pWin_point,
        pWin_std: 0,
        pWin_low: pWin_point,
        pWin_high: pWin_point,
        pWin_point,
        uncertainty: 1, // maximally uncertain when cold
        passes: 0,
        applied: false,
      };
    }

    // MC Dropout: apply feature dropout and query N times
    const rng = this.config.seed > 0 ? new SeededRNG(this.config.seed) : null;
    const predictions: number[] = [];
    const featureKeys = Object.keys(features);

    for (let pass = 0; pass < this.config.mcPasses; pass++) {
      // Apply dropout: zero out random features
      const droppedFeatures = { ...features };
      for (const key of featureKeys) {
        const r = rng ? rng.next() : Math.random();
        if (r < this.config.dropoutRate) {
          droppedFeatures[key] = 0;
        }
      }

      try {
        const result = this.olrEngine.query(symbol, droppedFeatures, side, cycle);
        if (Number.isFinite(result.pWin)) {
          predictions.push(result.pWin);
        }
      } catch {
        // non-critical — skip this pass
      }
    }

    if (predictions.length < 5) {
      // Not enough valid passes — fall back to point estimate
      return {
        pWin_mean: pWin_point,
        pWin_std: 0,
        pWin_low: pWin_point,
        pWin_high: pWin_point,
        pWin_point,
        uncertainty: 1,
        passes: predictions.length,
        applied: false,
      };
    }

    // Compute statistics
    const mean = predictions.reduce((a, b) => a + b, 0) / predictions.length;
    const variance = predictions.reduce((a, b) => a + (b - mean) ** 2, 0) / predictions.length;
    const std = Math.sqrt(variance);

    // Confidence interval from sorted predictions
    const sorted = [...predictions].sort((a, b) => a - b);
    const ciAlpha = 1 - this.config.ciLevel;
    const lowIdx = Math.floor(ciAlpha / 2 * sorted.length);
    const highIdx = Math.min(sorted.length - 1, Math.floor((1 - ciAlpha / 2) * sorted.length) - 1);
    const pWin_low = sorted[lowIdx]!;
    const pWin_high = sorted[Math.max(highIdx, lowIdx)]!;

    // Epistemic uncertainty: normalized std (0 = certain, 1 = max uncertain)
    // Max std for Bernoulli is 0.5 (p=0.5, perfectly uncertain)
    const uncertainty = Math.min(1, std / 0.25);

    return {
      pWin_mean: mean,
      pWin_std: std,
      pWin_low,
      pWin_high,
      pWin_point,
      uncertainty,
      passes: predictions.length,
      applied: true,
    };
  }

  /**
   * Format uncertainty context for agent injection.
   * Shows pWin with confidence interval and uncertainty level.
   */
  formatContext(symbol: string, features: Record<string, number>, side: 'buy' | 'sell', cycle: number): string {
    const result = this.query(symbol, features, side, cycle);
    if (!result.applied) {
      return `Bayesian P(win): ${result.pWin_point.toFixed(1)}% (cold-start, no uncertainty data)`;
    }

    const ciPct = this.config.ciLevel * 100;
    const bars = '▁▂▃▄▅▆▇█';
    const uncIdx = Math.floor(result.uncertainty * (bars.length - 1));
    const uncBar = bars[Math.min(uncIdx, bars.length - 1)]!;

    return [
      `Bayesian P(win): ${(result.pWin_mean * 100).toFixed(1)}% ± ${(result.pWin_std * 100).toFixed(1)}%`,
      `  ${ciPct.toFixed(0)}% CI: [${(result.pWin_low * 100).toFixed(1)}%, ${(result.pWin_high * 100).toFixed(1)}%]`,
      `  Uncertainty: ${(result.uncertainty * 100).toFixed(0)}% ${uncBar} (${result.passes} MC passes)`,
    ].join('\n');
  }
}