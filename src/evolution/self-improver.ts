// ─── Self-Improver (v2.0.838) ──────────────────────────────────────
//
// System automatically tunes its own hyperparameters based on observed
// performance. Uses bandit-based selection for discrete configs and
// EMA-based gradient for continuous parameters.
//
// Design:
//   1. Discrete config bandit: which exploration strategy performs best?
//   2. Continuous parameter tuning: SL/TP caps, conviction thresholds
//   3. All changes are bounded (never exceed safe limits)
//   4. All changes are gradual (EMA update, not sudden jumps)
//   5. All changes are logged (every adjustment is auditable)
//   6. Fire-and-forget (runs at cycle end, never blocks)
//
// Theory:
//   Bayesian hyperparameter optimization — use Thompson Sampling to
//   select discrete configs, OLS gradient for continuous params.
//   Expected Improvement: EI(x) = E[max(f(x) - f*, 0)]

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'self-improver' });

// ─── Types ───

interface PerformanceWindow {
  cycle: number;
  pnlPct: number;
  winRate: number;
  brier: number;
  ece: number;
  configSnapshot: Record<string, unknown>;
}

interface ConfigArm {
  configKey: string;
  configValue: string;
  trials: number;
  cumulativePnlPct: number;
  alpha: number; // Beta posterior "good" count (pnlPct > 0)
  beta: number;  // Beta posterior "bad" count (pnlPct <= 0)
}

interface ContinuousParam {
  name: string;
  currentValue: number;
  minValue: number;
  maxValue: number;
  stepSize: number;
  gradientEMA: number;
  history: Array<{ value: number; pnlPct: number; cycle: number }>;
}

// ─── Constants ───

const MAX_HISTORY = 200;
const MIN_PERF_WINDOWS = 10;
const MIN_HISTORY_FOR_GRADIENT = 10;
const GRADIENT_EMA_DECAY = 0.9;
const MIN_ARM_TRIALS = 3;

const CONFIG_CHOICES: Record<string, string[]> = {
  'explorationStrategy': ['epsilon-greedy', 'ucb1', 'thompson'],
};

const CONTINUOUS_BOUNDS: Array<{
  name: string;
  min: number;
  max: number;
  step: number;
  initial: number;
}> = [
  { name: 'convictionGateThreshold', min: 0.40, max: 0.60, step: 0.01, initial: 0.50 },
  { name: 'aggressiveSlCap', min: 0.05, max: 0.09, step: 0.005, initial: 0.07 },
  { name: 'conservativeSlCap', min: 0.02, max: 0.04, step: 0.005, initial: 0.03 },
  { name: 'dcsTimeDecayHalfLife', min: 100, max: 400, step: 25, initial: 200 },
];

// ─── Self-Improver ───

export class SelfImprover {
  private performanceHistory: PerformanceWindow[] = [];
  private configArms: Map<string, ConfigArm[]> = new Map();
  private continuousParams: Map<string, ContinuousParam> = new Map();

  constructor() {
    // Initialize config arms
    for (const [key, choices] of Object.entries(CONFIG_CHOICES)) {
      this.configArms.set(key, choices.map(v => ({
        configKey: key,
        configValue: v,
        trials: 0,
        cumulativePnlPct: 0,
        alpha: 1, // Beta(1,1) = uniform prior
        beta: 1,
      })));
    }

    // Initialize continuous params
    for (const bound of CONTINUOUS_BOUNDS) {
      this.continuousParams.set(bound.name, {
        name: bound.name,
        currentValue: bound.initial,
        minValue: bound.min,
        maxValue: bound.max,
        stepSize: bound.step,
        gradientEMA: 0,
        history: [],
      });
    }
  }

  /**
   * Record a performance window (called every N cycles, e.g. every 20).
   * This is the reward signal for the self-improvement loop.
   */
  recordPerformance(perf: PerformanceWindow): void {
    if (!Number.isFinite(perf.pnlPct) || !Number.isFinite(perf.winRate)) return;
    this.performanceHistory.push(perf);
    if (this.performanceHistory.length > MAX_HISTORY) this.performanceHistory.shift();

    // Update config bandit arms
    const config = perf.configSnapshot;
    for (const [key, arms] of this.configArms) {
      const currentChoice = String(config[key] ?? '');
      const arm = arms.find(a => a.configValue === currentChoice);
      if (arm) {
        arm.trials++;
        arm.cumulativePnlPct += perf.pnlPct;
        if (perf.pnlPct > 0) arm.alpha++;
        else arm.beta++;
      }
    }

    // Update continuous parameter gradients
    for (const [, param] of this.continuousParams) {
      param.history.push({
        value: param.currentValue,
        pnlPct: perf.pnlPct,
        cycle: perf.cycle,
      });
      if (param.history.length > 50) param.history.shift();

      if (param.history.length >= MIN_HISTORY_FOR_GRADIENT) {
        const gradient = this.estimateGradient(param.history);
        param.gradientEMA = GRADIENT_EMA_DECAY * param.gradientEMA + (1 - GRADIENT_EMA_DECAY) * gradient;
      }
    }

    log.debug(
      `[self-improve] recorded perf: cycle=${perf.cycle}, pnl=${perf.pnlPct.toFixed(4)}, ` +
      `winRate=${perf.winRate.toFixed(2)}, brier=${perf.brier.toFixed(4)}`
    );
  }

  /**
   * Estimate gradient: does increasing this parameter improve PnL?
   * Simple OLS slope: cov(x, y) / var(x).
   * Returns slope (positive = increasing parameter improves PnL).
   */
  private estimateGradient(
    history: Array<{ value: number; pnlPct: number }>,
  ): number {
    const n = history.length;
    if (n < 5) return 0;
    const meanX = history.reduce((s, h) => s + h.value, 0) / n;
    const meanY = history.reduce((s, h) => s + h.pnlPct, 0) / n;
    let covXY = 0, varX = 0;
    for (const h of history) {
      covXY += (h.value - meanX) * (h.pnlPct - meanY);
      varX += (h.value - meanX) ** 2;
    }
    if (varX === 0) return 0;
    return covXY / varX;
  }

  /**
   * Get the best config choice for a given key (Thompson Sampling).
   * Samples from each arm's Beta posterior, returns the highest sample.
   */
  getConfigRecommendation(key: string): string | null {
    const arms = this.configArms.get(key);
    if (!arms || arms.length === 0) return null;
    // Skip if all arms have too few trials
    const totalTrials = arms.reduce((s, a) => s + a.trials, 0);
    if (totalTrials < MIN_ARM_TRIALS) return null;

    let bestSample = -Infinity;
    let bestValue: string | null = null;
    for (const arm of arms) {
      const sample = this.sampleBeta(arm.alpha, arm.beta);
      if (sample > bestSample) {
        bestSample = sample;
        bestValue = arm.configValue;
      }
    }
    return bestValue;
  }

  /**
   * Get the recommended continuous parameter value (gradient step).
   * Moves currentValue in the direction of positive gradient.
   */
  getParamRecommendation(name: string): number {
    const param = this.continuousParams.get(name);
    if (!param) return 0;
    const newValue = param.currentValue + Math.sign(param.gradientEMA) * param.stepSize;
    return Math.max(param.minValue, Math.min(param.maxValue, newValue));
  }

  /**
   * Apply a recommended parameter value (actually update the current value).
   * Logs the change for auditability.
   */
  applyParamUpdate(name: string, newValue: number): void {
    const param = this.continuousParams.get(name);
    if (!param) return;
    const clamped = Math.max(param.minValue, Math.min(param.maxValue, newValue));
    if (Math.abs(clamped - param.currentValue) > 1e-9) {
      log.info(
        `[self-improve] ${name}: ${param.currentValue.toFixed(4)} → ${clamped.toFixed(4)} ` +
        `(gradient=${param.gradientEMA.toFixed(6)}, step=${param.stepSize})`
      );
      param.currentValue = clamped;
    }
  }

  /**
   * Run a full tuning cycle: apply all recommendations.
   * Called every N cycles (e.g. every 20).
   */
  runTuningCycle(): void {
    if (this.performanceHistory.length < MIN_PERF_WINDOWS) return;

    // Apply continuous param updates
    for (const [name] of this.continuousParams) {
      const recommended = this.getParamRecommendation(name);
      this.applyParamUpdate(name, recommended);
    }
  }

  /**
   * Generate a self-improvement report block for HACP injection.
   */
  getImprovementBlock(): string {
    if (this.performanceHistory.length < MIN_PERF_WINDOWS) {
      return '=== SELF-IMPROVEMENT ===\nInsufficient data for self-tuning.\n---';
    }

    const lines: string[] = [
      '=== SELF-IMPROVEMENT (Auto-Tuning) ===',
      `📊 Performance windows: ${this.performanceHistory.length}`,
    ];

    // Config recommendations
    for (const [key, arms] of this.configArms) {
      const sorted = [...arms].sort((a, b) =>
        (b.alpha / (b.alpha + b.beta)) - (a.alpha / (a.alpha + a.beta))
      );
      const best = sorted[0];
      if (best && best.trials > 0) {
        const wr = (best.alpha - 1) / Math.max(1, best.trials);
        lines.push(`📊 ${key}: best="${best.configValue}" (${(wr * 100).toFixed(0)}% good, n=${best.trials})`);
      }
    }

    // Continuous param recommendations
    for (const [, param] of this.continuousParams) {
      const recommended = this.getParamRecommendation(param.name);
      const direction = param.gradientEMA > 0.001 ? '↑' : param.gradientEMA < -0.001 ? '↓' : '→';
      lines.push(
        `📊 ${param.name}: ${param.currentValue.toFixed(4)} ${direction} ${recommended.toFixed(4)} ` +
        `(gradient=${param.gradientEMA.toFixed(6)}, history=${param.history.length})`
      );
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * Get a snapshot of all current tuned values (for applying to live config).
   */
  getTunedValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, param] of this.continuousParams) {
      out[name] = param.currentValue;
    }
    return out;
  }

  /**
   * Get current config recommendations for all discrete choices.
   */
  getConfigChoices(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key] of this.configArms) {
      const rec = this.getConfigRecommendation(key);
      if (rec) out[key] = rec;
    }
    return out;
  }

  getPerformanceCount(): number {
    return this.performanceHistory.length;
  }

  // ── Beta sampling (same as Q-RL Thompson) ──
  private sampleBeta(alpha: number, beta: number): number {
    if (alpha <= 0 || beta <= 0) return 0.5;
    const x = this.sampleGamma(alpha);
    const y = this.sampleGamma(beta);
    const sum = x + y;
    if (sum === 0 || !Number.isFinite(sum)) return 0.5;
    return Math.max(0, Math.min(1, x / sum));
  }

  private sampleGamma(shape: number): number {
    if (!Number.isFinite(shape) || shape <= 0) return 1;
    if (shape < 1) {
      const u = Math.random();
      if (u === 0) return 0;
      return this.sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 100; i++) {
      let x: number, v: number;
      do {
        x = this.standardNormal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d;
  }

  private standardNormal(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    if (u1 === 0) return 0;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      performanceHistory: this.performanceHistory.slice(-50),
      configArms: Object.fromEntries(
        [...this.configArms.entries()].map(([k, v]) => [k, v.map(a => ({ ...a }))])
      ),
      continuousParams: Object.fromEntries(
        [...this.continuousParams.entries()].map(([k, v]) => [k, { ...v, history: v.history.slice(-20) }])
      ),
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const hist = s['performanceHistory'];
    if (Array.isArray(hist)) this.performanceHistory = hist as PerformanceWindow[];
    const savedArms = s['configArms'] as Record<string, ConfigArm[]> | undefined;
    if (savedArms) {
      for (const [key, arms] of Object.entries(savedArms)) {
        if (Array.isArray(arms)) this.configArms.set(key, arms);
      }
    }
    const savedParams = s['continuousParams'] as Record<string, ContinuousParam> | undefined;
    if (savedParams) {
      for (const [name, param] of Object.entries(savedParams)) {
        if (param && typeof param === 'object') {
          this.continuousParams.set(name, {
            ...param,
            history: Array.isArray(param.history) ? param.history : [],
          });
        }
      }
    }
    log.info(`[self-improve] loaded: ${this.performanceHistory.length} windows, ${this.configArms.size} config arms, ${this.continuousParams.size} params`);
  }

  reset(): void {
    this.performanceHistory = [];
    this.configArms.clear();
    this.continuousParams.clear();
    // Re-initialize
    for (const [key, choices] of Object.entries(CONFIG_CHOICES)) {
      this.configArms.set(key, choices.map(v => ({
        configKey: key, configValue: v, trials: 0, cumulativePnlPct: 0, alpha: 1, beta: 1,
      })));
    }
    for (const bound of CONTINUOUS_BOUNDS) {
      this.continuousParams.set(bound.name, {
        name: bound.name, currentValue: bound.initial, minValue: bound.min,
        maxValue: bound.max, stepSize: bound.step, gradientEMA: 0, history: [],
      });
    }
  }
}