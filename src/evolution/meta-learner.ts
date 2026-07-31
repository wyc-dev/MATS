// ─── Meta-Learner (v2.0.840) ──────────────────────────────────────
//
// System learns HOW to learn. Adjusts learning rates, feature weights,
// and exploration priorities based on observed learning efficiency.
//
// Architecture:
//   1. Per-cell adaptive learning rate (high variance → low α)
//   2. Feature weight meta-learning (rolling predictive power → weight)
//   3. Regime learning speed tracking (fast-learning regimes → prioritize)
//   4. Curriculum: suggest which regime to explore next
//
// Theory:
//   Meta-RL (learn-to-learn): α_cell = 1/(1+n) × stabilityFactor
//   Feature weight meta-learning: w_i(t) = w_i(t-1)(1-η) + η × predictivePower_i
//   Curriculum learning: prioritize regimes with highest learning speed

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'meta-learner' });

// ─── Types ───

interface CellLearningState {
  cellKey: string;
  visits: number;
  rewardMean: number;
  rewardStd: number;
  qValueChangeRate: number;
  alphaMultiplier: number;  // [0.1, 2.0]
  lastQValue: number;
  lastUpdateCycle: number;
}

interface FeatureMetaState {
  feature: string;
  predictivePower: number;  // [-1, 1]
  weight: number;           // [0.1, 3.0]
  history: Array<{ value: number; pnlPct: number }>;
}

interface RegimeLearningSpeed {
  regime: string;
  avgLearningSpeed: number;
  cellCount: number;
  curriculumPriority: number;  // [0, 1]
}

// ─── Constants ───

const FEATURE_HISTORY_MAX = 100;
const MIN_HISTORY_FOR_CORR = 10;
const MIN_CELLS_FOR_OUTPUT = 10;
const MIN_REGIME_SAMPLES = 3;
const FEATURE_WEIGHT_MIN = 0.1;
const FEATURE_WEIGHT_MAX = 3.0;
const ALPHA_MULT_MIN = 0.1;
const ALPHA_MULT_MAX = 2.0;
const PREDICTIVE_POWER_EMA_DECAY = 0.8;
const FEATURE_WEIGHT_EMA_DECAY = 0.9;

// ─── Meta-Learner ───

export class MetaLearner {
  private cellStates: Map<string, CellLearningState> = new Map();
  private featureStates: Map<string, FeatureMetaState> = new Map();
  private regimeSpeeds: Map<string, RegimeLearningSpeed> = new Map();
  private totalCycles = 0;

  /**
   * Record a Q-value update and compute adaptive learning rate.
   * Called from QRLTable.update() BEFORE the update happens.
   *
   * @returns adaptive alpha multiplier [0.1, 2.0]
   */
  recordCellUpdate(
    cellKey: string,
    oldQ: number,
    newQ: number,
    reward: number,
    cycle: number,
  ): number {
    if (!Number.isFinite(oldQ) || !Number.isFinite(newQ) || !Number.isFinite(reward)) return 1.0;

    let state = this.cellStates.get(cellKey);
    if (!state) {
      state = {
        cellKey,
        visits: 0,
        rewardMean: 0,
        rewardStd: 0,
        qValueChangeRate: 0,
        alphaMultiplier: 1.0,
        lastQValue: oldQ,
        lastUpdateCycle: cycle,
      };
      this.cellStates.set(cellKey, state);
    }

    // Update reward statistics (rolling EMA)
    state.visits++;
    const qChange = Math.abs(newQ - oldQ);
    state.qValueChangeRate = 0.8 * state.qValueChangeRate + 0.2 * qChange;

    // Update reward std (rolling approximation)
    const delta = reward - state.rewardMean;
    state.rewardMean = 0.9 * state.rewardMean + 0.1 * reward;
    state.rewardStd = Math.sqrt(0.81 * state.rewardStd * state.rewardStd + 0.19 * delta * delta);

    // High reward variance → lower learning rate (don't over-react to noise)
    // Low reward variance → higher learning rate (stable signal, learn faster)
    const stability = 1 / (1 + state.rewardStd * 10);
    state.alphaMultiplier = Math.max(ALPHA_MULT_MIN, Math.min(ALPHA_MULT_MAX, 0.5 + stability));

    state.lastQValue = newQ;
    state.lastUpdateCycle = cycle;

    return state.alphaMultiplier;
  }

  /**
   * Record a feature-PnL observation and update adaptive feature weight.
   * Called from the learning pipeline when a trade closes.
   */
  recordFeatureOutcome(
    feature: string,
    featureValue: number,
    pnlPct: number,
  ): void {
    if (!Number.isFinite(featureValue) || !Number.isFinite(pnlPct)) return;
    if (typeof feature !== 'string' || feature.length === 0) return;

    let state = this.featureStates.get(feature);
    if (!state) {
      state = {
        feature,
        predictivePower: 0,
        weight: 1.0,
        history: [],
      };
      this.featureStates.set(feature, state);
    }

    state.history.push({ value: featureValue, pnlPct });
    if (state.history.length > FEATURE_HISTORY_MAX) state.history.shift();

    // Compute rolling predictive power (correlation)
    if (state.history.length >= MIN_HISTORY_FOR_CORR) {
      const values = state.history.map(h => h.value);
      const pnls = state.history.map(h => h.pnlPct);
      const corr = this.pearsonCorrelation(values, pnls);
      // EMA update of predictive power
      state.predictivePower = PREDICTIVE_POWER_EMA_DECAY * state.predictivePower +
        (1 - PREDICTIVE_POWER_EMA_DECAY) * corr;
      // Adaptive weight: |predictivePower| high → weight high
      const targetWeight = 0.3 + 2.7 * Math.abs(state.predictivePower);
      state.weight = FEATURE_WEIGHT_EMA_DECAY * state.weight +
        (1 - FEATURE_WEIGHT_EMA_DECAY) * targetWeight;
      state.weight = Math.max(FEATURE_WEIGHT_MIN, Math.min(FEATURE_WEIGHT_MAX, state.weight));
    }
  }

  /**
   * Get adaptive feature weights (for OLR query weighting).
   */
  getFeatureWeights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [feature, state] of this.featureStates) {
      out[feature] = state.weight;
    }
    return out;
  }

  /**
   * Get adaptive learning rate multiplier for a cell.
   */
  getCellAlphaMultiplier(cellKey: string): number {
    return this.cellStates.get(cellKey)?.alphaMultiplier ?? 1.0;
  }

  /**
   * Update regime learning speeds (called every N cycles).
   */
  updateRegimeSpeeds(cycle: number): void {
    this.totalCycles = cycle;
    const regimeMap = new Map<string, number[]>();

    for (const [cellKey, state] of this.cellStates) {
      const regime = cellKey.split('|')[0] ?? 'unknown';
      const speeds = regimeMap.get(regime) ?? [];
      speeds.push(state.qValueChangeRate);
      regimeMap.set(regime, speeds);
    }

    // Compute per-regime average learning speed
    const speeds: Array<{ regime: string; speed: number; count: number }> = [];
    for (const [regime, changeRates] of regimeMap) {
      if (changeRates.length < MIN_REGIME_SAMPLES) continue;
      const avg = changeRates.reduce((a, b) => a + b, 0) / changeRates.length;
      speeds.push({ regime, speed: avg, count: changeRates.length });
    }

    // Normalize to [0, 1] curriculum priority
    const maxSpeed = Math.max(...speeds.map(s => s.speed), 0.000001);
    for (const s of speeds) {
      this.regimeSpeeds.set(s.regime, {
        regime: s.regime,
        avgLearningSpeed: s.speed,
        cellCount: s.count,
        curriculumPriority: s.speed / maxSpeed,
      });
    }
  }

  /**
   * Get curriculum suggestion: which regime to explore next.
   * Higher learning speed → higher priority (learn fast while you can).
   */
  getCurriculumSuggestion(): string | null {
    let best: RegimeLearningSpeed | null = null;
    for (const [, speed] of this.regimeSpeeds) {
      if (!best || speed.curriculumPriority > best.curriculumPriority) {
        best = speed;
      }
    }
    return best?.regime ?? null;
  }

  /**
   * Generate meta-learning block for HACP injection.
   */
  getMetaLearningBlock(): string {
    if (this.cellStates.size < MIN_CELLS_FOR_OUTPUT) {
      return '=== META-LEARNING ===\nInsufficient data for meta-learning.\n---';
    }

    const lines: string[] = [
      '=== META-LEARNING (Learning to Learn) ===',
      `📊 Tracked cells: ${this.cellStates.size}`,
      `📊 Tracked features: ${this.featureStates.size}`,
    ];

    // Top feature weights
    const features = [...this.featureStates.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 5);
    if (features.length > 0) {
      lines.push('');
      lines.push('Adaptive feature weights (top 5):');
      for (const [name, state] of features) {
        const tag = state.predictivePower > 0.1 ? '✅' : state.predictivePower < -0.1 ? '❌' : '⚪';
        lines.push(
          `  ${tag} ${name}: weight=${state.weight.toFixed(2)}, ` +
          `predictivePower=${state.predictivePower.toFixed(3)}`
        );
      }
    }

    // Curriculum suggestions
    const sortedRegimes = [...this.regimeSpeeds.values()]
      .sort((a, b) => b.curriculumPriority - a.curriculumPriority);
    if (sortedRegimes.length > 0) {
      lines.push('');
      lines.push('Regime learning speeds (curriculum priority):');
      for (const r of sortedRegimes.slice(0, 5)) {
        const tag = r.curriculumPriority > 0.7 ? '🔥' : r.curriculumPriority > 0.4 ? '📈' : '⏸';
        lines.push(
          `  ${tag} ${r.regime}: speed=${r.avgLearningSpeed.toFixed(6)}, ` +
          `priority=${r.curriculumPriority.toFixed(2)}, cells=${r.cellCount}`
        );
      }
    }

    // Curriculum suggestion
    const suggestion = this.getCurriculumSuggestion();
    if (suggestion) {
      lines.push('');
      lines.push(`💡 Curriculum: prioritize exploration in "${suggestion}" regime (fastest learning).`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  getCellCount(): number {
    return this.cellStates.size;
  }

  getFeatureCount(): number {
    return this.featureStates.size;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 5) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denomX = 0, denomY = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i]! - meanX) * (y[i]! - meanY);
      denomX += (x[i]! - meanX) ** 2;
      denomY += (y[i]! - meanY) ** 2;
    }
    const denom = Math.sqrt(denomX * denomY);
    if (denom === 0) return 0;
    return num / denom;
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      cellStates: Object.fromEntries(this.cellStates),
      featureStates: Object.fromEntries(
        [...this.featureStates.entries()].map(([k, v]) => [k, { ...v, history: v.history.slice(-20) }])
      ),
      regimeSpeeds: Object.fromEntries(this.regimeSpeeds),
      totalCycles: this.totalCycles,
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const cells = s['cellStates'];
    if (cells && typeof cells === 'object' && !Array.isArray(cells)) {
      this.cellStates = new Map(Object.entries(cells as Record<string, CellLearningState>));
    }
    const features = s['featureStates'] as Record<string, FeatureMetaState>;
    if (features) {
      for (const [name, fs] of Object.entries(features)) {
        if (fs && typeof fs === 'object') {
          this.featureStates.set(name, {
            ...fs,
            history: Array.isArray(fs.history) ? fs.history : [],
          });
        }
      }
    }
    const regimes = s['regimeSpeeds'];
    if (regimes && typeof regimes === 'object' && !Array.isArray(regimes)) {
      this.regimeSpeeds = new Map(Object.entries(regimes as Record<string, RegimeLearningSpeed>));
    }
    this.totalCycles = safeNum(s['totalCycles'] as number, 0);
    log.info(`[meta-learn] loaded: ${this.cellStates.size} cells, ${this.featureStates.size} features, ${this.regimeSpeeds.size} regimes`);
  }

  reset(): void {
    this.cellStates.clear();
    this.featureStates.clear();
    this.regimeSpeeds.clear();
    this.totalCycles = 0;
  }
}