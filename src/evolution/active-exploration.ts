// ─── v2.0.219: Active Exploration (UCB + Information Gain) ──────────
//
// Implements Upper Confidence Bound (UCB) exploration to balance
// exploitation (take known-good trades) vs exploration (try uncertain
// trades for information value).
//
// UCB formula for trading:
//   score = pWin + c * sqrt(ln(N_total) / N_symbol)
//
// Where:
//   pWin       = OLR's predicted win probability (exploitation)
//   c          = exploration constant (tunable)
//   N_total    = total trades across all symbols
//   N_symbol   = trades for this specific symbol
//
// High uncertainty (low N_symbol, or high Bayesian std) → exploration bonus
// Low uncertainty (high N_symbol, low std) → pure exploitation
//
// Additionally, information-gain-driven exploration:
//   If Bayesian OLR uncertainty > threshold, boost exploration score
//   This tells the system "this trade is worth taking for information,
//   even if pWin is low."
//
// Production-grade:
// - Soft gating (never hard-blocks a trade — preserves user operation space)
// - Configurable exploration constant
// - Decays exploration as total samples grow (annealing)
// - Integrates with Bayesian OLR for epistemic uncertainty
// - All values sanitized

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'exploration' });

// ─── Types ───

export interface ExplorationConfig {
  /** Exploration constant c for UCB */
  ucbConstant: number;
  /** Information gain threshold — if uncertainty > this, boost exploration */
  infoGainThreshold: number;
  /** Exploration bonus cap (never exceed this) */
  maxExplorationBonus: number;
  /** Annealing: reduce exploration after N total trades */
  annealingThreshold: number;
  /** Annealing rate — how fast exploration decays */
  annealingRate: number;
  /** Min exploration constant (floor after annealing) */
  minUcbConstant: number;
  /** Enable/disable exploration (soft switch) */
  enabled: boolean;
}

export interface ExplorationInput {
  pWin: number;
  symbol: string;
  side: 'buy' | 'sell';
  /** Bayesian uncertainty [0, 1] (from BayesianOLR) */
  uncertainty: number;
  /** Total trades across all symbols */
  totalTrades: number;
  /** Trades for this symbol */
  symbolTrades: number;
}

export interface ExplorationResult {
  /** Final exploration-adjusted score */
  explorationScore: number;
  /** UCB exploration bonus */
  ucbBonus: number;
  /** Information-gain-driven bonus */
  infoGainBonus: number;
  /** Effective exploration constant (after annealing) */
  effectiveConstant: number;
  /** Whether exploration was applied */
  applied: boolean;
  /** Recommendation for agent context */
  recommendation: string;
}

// ─── ActiveExploration ───

export class ActiveExploration {
  private config: ExplorationConfig;

  constructor(config?: Partial<ExplorationConfig>) {
    this.config = {
      ucbConstant: 0.15,
      infoGainThreshold: 0.5,
      maxExplorationBonus: 0.2,
      annealingThreshold: 500,
      annealingRate: 0.5,
      minUcbConstant: 0.02,
      enabled: true,
      ...config,
    };
  }

  /**
   * Compute exploration-adjusted score.
   */
  compute(input: ExplorationInput): ExplorationResult {
    const pWin = Math.max(0.001, Math.min(0.999, safeNum(input.pWin, 0.5)));
    const uncertainty = Math.max(0, Math.min(1, safeNum(input.uncertainty, 0)));
    const totalTrades = Math.max(0, safeNum(input.totalTrades, 0));
    const symbolTrades = Math.max(0, safeNum(input.symbolTrades, 0));

    if (!this.config.enabled || totalTrades < 5) {
      return {
        explorationScore: pWin,
        ucbBonus: 0,
        infoGainBonus: 0,
        effectiveConstant: this.config.ucbConstant,
        applied: false,
        recommendation: 'Cold-start: no exploration (insufficient data)',
      };
    }

    // Annealing: reduce exploration constant as system matures
    let effectiveC = this.config.ucbConstant;
    if (totalTrades > this.config.annealingThreshold) {
      const excess = totalTrades - this.config.annealingThreshold;
      const decay = Math.exp(-excess * this.config.annealingRate / this.config.annealingThreshold);
      effectiveC = Math.max(this.config.minUcbConstant, this.config.ucbConstant * decay);
    }

    // UCB bonus: c * sqrt(ln(N_total) / N_symbol)
    // If N_symbol = 0, this is infinite → cap at maxExplorationBonus
    let ucbBonus = 0;
    if (symbolTrades === 0) {
      ucbBonus = this.config.maxExplorationBonus;
    } else {
      ucbBonus = effectiveC * Math.sqrt(Math.log(totalTrades) / symbolTrades);
      ucbBonus = Math.min(ucbBonus, this.config.maxExplorationBonus);
    }

    // Information gain bonus: if Bayesian uncertainty is high, boost exploration
    let infoGainBonus = 0;
    if (uncertainty > this.config.infoGainThreshold) {
      // Linear interpolation: uncertainty 0.5 → 0 bonus, uncertainty 1.0 → max bonus
      const excessUncertainty = uncertainty - this.config.infoGainThreshold;
      const maxExcess = 1 - this.config.infoGainThreshold;
      infoGainBonus = (excessUncertainty / maxExcess) * this.config.maxExplorationBonus * 0.5;
    }

    // Total exploration bonus
    const totalBonus = Math.min(ucbBonus + infoGainBonus, this.config.maxExplorationBonus);

    // Final score: pWin + exploration bonus (clamped to [0, 1])
    const explorationScore = Math.max(0.001, Math.min(0.999, pWin + totalBonus));

    // Recommendation
    let recommendation: string;
    if (symbolTrades < 10) {
      recommendation = `Exploration mode: ${input.symbol} has only ${symbolTrades} trades — exploring for information (UCB bonus +${(ucbBonus * 100).toFixed(1)}%)`;
    } else if (uncertainty > this.config.infoGainThreshold) {
      recommendation = `Information-driven: high uncertainty (${(uncertainty * 100).toFixed(0)}%) — exploring to reduce model uncertainty (+${(infoGainBonus * 100).toFixed(1)}%)`;
    } else if (totalBonus > 0.05) {
      recommendation = `Mild exploration: UCB bonus +${(totalBonus * 100).toFixed(1)}% (symbol ${symbolTrades} trades, total ${totalTrades})`;
    } else {
      recommendation = `Exploitation mode: ${input.symbol} well-sampled (${symbolTrades} trades), low uncertainty (${(uncertainty * 100).toFixed(0)}%)`;
    }

    return {
      explorationScore,
      ucbBonus,
      infoGainBonus,
      effectiveConstant: effectiveC,
      applied: true,
      recommendation,
    };
  }

  /**
   * Format exploration context for agent injection.
   */
  formatContext(result: ExplorationResult): string {
    if (!result.applied) return result.recommendation;
    return [
      `=== EXPLORATION ASSESSMENT ===`,
      `  ${result.recommendation}`,
      `  UCB bonus: +${(result.ucbBonus * 100).toFixed(1)}% | Info gain: +${(result.infoGainBonus * 100).toFixed(1)}%`,
      `  Effective exploration c: ${result.effectiveConstant.toFixed(4)}`,
      `  Adjusted score: ${(result.explorationScore * 100).toFixed(1)}% (base: ${(result.explorationScore - result.ucbBonus - result.infoGainBonus) * 100 | 0}%)`,
    ].join('\n');
  }

  /** Get config */
  getConfig(): ExplorationConfig { return { ...this.config }; }

  /** Save state */
  save(): string { return JSON.stringify({ config: this.config }); }

  /** Load state */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.config) this.config = { ...this.config, ...data.config };
    } catch { /* fresh start */ }
  }
}