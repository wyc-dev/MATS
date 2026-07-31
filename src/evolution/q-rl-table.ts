// ─── Q-RL Alpha Discovery Table (v2.0.835) ───────────────────────────
//
// The first component in MATS that can DISCOVER new alpha — not just
// measure existing edge. Uses a discrete Q-table with ε-greedy exploration
// to try actions the LLM wouldn't, learning from Aligned Shadow rewards.
//
// Architecture:
//   270 cells = 5 regime × 3 vol × 3 momentum × 3 funding × 2 action
//   Each cell stores: Q-value (expected PnL%), visit count, reward history
//   ε-greedy: starts at 1.0 (explore), decays to 0.05 over 500 cycles
//   Discovery: every 5 cycles, scan Q-table for alpha patterns
//     Candidate:  Q > 0.2% + n ≥ 10
//     Probable:   Q > 0.3% + Wilson LB > 50% + n ≥ 20
//     Confirmed:  Q > 0.5% + Wilson LB > 55% + BH-FDR pass + n ≥ 30
//
// Confirmed discoveries → inject into Meta-Agent (conviction +5%) +
// Fractal Momentum Sentinel (strategy recognition block).
//
// Cold-start safe: all Q=0 → follow LLM (identical to current behavior).
// No GPU, no backprop, no neural network — pure TypeScript EWMA + Wilson score.

import { createLogger } from '../observability/logger.ts';
import { safeNum, wilsonScore } from './evolution-utils.ts';

const log = createLogger({ phase: 'q-rl' });

// ─── Types ───

export interface QTableKey {
  regime: string;
  volBin: string;
  momBin: string;
  fundingBin: string;
  action: 'buy' | 'sell';
}

export interface AlphaDiscovery {
  key: QTableKey;
  qValue: number;
  visits: number;
  wilsonLB: number;
  pValue: number;
  level: 'candidate' | 'probable' | 'confirmed';
  description: string;
  /** v2.0.836: cycle number when this discovery was created (for DCS time decay) */
  discoveredAt: number;
}

export interface QRLConfig {
  /** ε-greedy: exploration rate at cycle 0 (1.0 = 100% explore) */
  epsilonStart: number;
  /** ε-greedy: minimum exploration rate after decay */
  epsilonMin: number;
  /** Cycles over which ε decays from start to min */
  epsilonDecayCycles: number;
  /** Minimum visits before a cell is considered for discovery */
  minVisitsCandidate: number;
  /** Minimum visits for probable discovery */
  minVisitsProbable: number;
  /** Minimum visits for confirmed discovery */
  minVisitsConfirmed: number;
  /** Q-value threshold for candidate (must exceed fee + slippage) */
  qThresholdCandidate: number;
  /** Q-value threshold for probable */
  qThresholdProbable: number;
  /** Q-value threshold for confirmed */
  qThresholdConfirmed: number;
  /** Wilson LB threshold for probable */
  wilsonProbable: number;
  /** Wilson LB threshold for confirmed */
  wilsonConfirmed: number;
  /** BH-FDR significance level */
  fdrAlpha: number;
  /** Max rewards stored per cell (for Wilson + bootstrap) */
  maxRewardHistory: number;
  /** How often to scan for discoveries (in cycles) */
  discoveryScanInterval: number;
  /** v2.0.837: Exploration strategy — 'epsilon-greedy' (legacy), 'ucb1', or 'thompson' */
  explorationStrategy: 'epsilon-greedy' | 'ucb1' | 'thompson';
  /** v2.0.837: UCB1 exploration constant c. sqrt(2) ≈ 1.41 */
  ucbExplorationConstant: number;
  /** v2.0.837: Minimum total visits before UCB/Thompson kicks in (cold-start safety) */
  ucbMinTotalVisits: number;
}

const DEFAULT_CONFIG: QRLConfig = {
  epsilonStart: 1.0,
  epsilonMin: 0.05,
  epsilonDecayCycles: 500,
  explorationStrategy: 'epsilon-greedy', // v2.0.837: default = backward compatible
  ucbExplorationConstant: 1.41, // sqrt(2)
  ucbMinTotalVisits: 10,
  minVisitsCandidate: 10,
  minVisitsProbable: 20,
  minVisitsConfirmed: 30,
  qThresholdCandidate: 0.002,   // 0.2% — must beat round-trip fees
  qThresholdProbable: 0.003,    // 0.3%
  qThresholdConfirmed: 0.005,   // 0.5%
  wilsonProbable: 0.50,
  wilsonConfirmed: 0.55,
  fdrAlpha: 0.05,
  maxRewardHistory: 30,
  discoveryScanInterval: 5,
};

// ─── Q-RL Table ───

export class QRLTable {
  private config: QRLConfig;
  private values: Record<string, number> = {};
  private visits: Record<string, number> = {};
  private lastUpdate: Record<string, number> = {};
  private rewardHistory: Record<string, number[]> = {};
  private totalCycles = 0;
  private lastDiscoveryCycle = 0;
  private cachedDiscoveries: AlphaDiscovery[] = [];

  constructor(config?: Partial<QRLConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Action selection (v2.0.837: ε-greedy / UCB1 / Thompson Sampling) ───

  /**
   * Select an action. Strategy determined by config.explorationStrategy.
   *
   * - 'epsilon-greedy': random explore with probability ε (legacy behavior)
   * - 'ucb1':           pick action with highest Q(a) + c√(ln N / n_a)
   * - 'thompson':       sample from Beta(wins+1, losses+1) per action, pick highest
   *
   * All strategies are cold-start safe: if both actions have 0 visits,
   * follow LLM (identical to current behavior).
   * v2.0.835 security: null/undefined features → safe fallback (follows LLM).
   */
  selectAction(
    llmAction: 'buy' | 'sell',
    features: Record<string, number>,
  ): 'buy' | 'sell' {
    this.totalCycles++;

    // Guard against null/undefined features
    if (!features || typeof features !== 'object') return llmAction;

    const buyKey = this.makeKey(features, 'buy');
    const sellKey = this.makeKey(features, 'sell');
    const qBuy = this.values[buyKey] ?? 0;
    const qSell = this.values[sellKey] ?? 0;
    const visitsBuy = this.visits[buyKey] ?? 0;
    const visitsSell = this.visits[sellKey] ?? 0;

    // Cold-start: both visits=0 → follow LLM
    if (visitsBuy === 0 && visitsSell === 0) return llmAction;

    const strategy = this.config.explorationStrategy;

    if (strategy === 'ucb1') {
      return this.selectUCB1(llmAction, qBuy, qSell, visitsBuy, visitsSell);
    }
    if (strategy === 'thompson') {
      return this.selectThompson(llmAction, buyKey, sellKey);
    }

    // Default: epsilon-greedy (legacy behavior)
    const epsilon = this.currentEpsilon();
    if (Math.random() < epsilon) {
      const rlAction = qBuy > qSell ? 'buy' : 'sell';
      log.debug(`[q-rl] EXPLORE (ε=${epsilon.toFixed(3)}): LLM=${llmAction}, RL=${rlAction} (Q_buy=${qBuy.toFixed(4)}, Q_sell=${qSell.toFixed(4)})`);
      return rlAction;
    }
    return llmAction;
  }

  /**
   * UCB1 action selection.
   * UCB1(a) = Q(a) + c × √(ln(N) / n_a)
   * If n_a = 0, the exploration term is Infinity → always pick unvisited first.
   */
  private selectUCB1(
    llmAction: 'buy' | 'sell',
    qBuy: number,
    qSell: number,
    visitsBuy: number,
    visitsSell: number,
  ): 'buy' | 'sell' {
    const N = visitsBuy + visitsSell;
    if (N < this.config.ucbMinTotalVisits) {
      // Not enough total visits → follow LLM (cold-start safety)
      return llmAction;
    }

    const c = this.config.ucbExplorationConstant;
    const lnN = Math.log(N + 1);

    const ucbBuy = visitsBuy === 0
      ? Infinity  // unvisited → always explore first
      : qBuy + c * Math.sqrt(lnN / visitsBuy);

    const ucbSell = visitsSell === 0
      ? Infinity
      : qSell + c * Math.sqrt(lnN / visitsSell);

    const selected = ucbBuy >= ucbSell ? 'buy' : 'sell';

    log.debug(
      `[q-rl] UCB1: Q_buy=${qBuy.toFixed(4)} (n=${visitsBuy}, ` +
      `UCB=${ucbBuy === Infinity ? '∞' : ucbBuy.toFixed(4)}), ` +
      `Q_sell=${qSell.toFixed(4)} (n=${visitsSell}, ` +
      `UCB=${ucbSell === Infinity ? '∞' : ucbSell.toFixed(4)}) → ${selected}`
    );

    return selected;
  }

  /**
   * Thompson Sampling action selection.
   * For each action, maintain Beta(wins+1, losses+1) posterior.
   * Sample from each posterior, pick the higher sample.
   *
   * Beta(α, β) where α = wins + 1, β = losses + 1 (prior = Beta(1,1) = uniform).
   * Cold-start (0 wins 0 losses) → Beta(1,1) = uniform [0,1] → 50/50.
   */
  private selectThompson(
    llmAction: 'buy' | 'sell',
    buyKey: string,
    sellKey: string,
  ): 'buy' | 'sell' {
    const buyRewards = this.rewardHistory[buyKey] ?? [];
    const sellRewards = this.rewardHistory[sellKey] ?? [];

    const buyWins = buyRewards.filter(r => r > 0).length;
    const buyLosses = buyRewards.length - buyWins;
    const sellWins = sellRewards.filter(r => r > 0).length;
    const sellLosses = sellRewards.length - sellWins;

    const sampleBuy = this.sampleBeta(buyWins + 1, buyLosses + 1);
    const sampleSell = this.sampleBeta(sellWins + 1, sellLosses + 1);

    const selected = sampleBuy >= sampleSell ? 'buy' : 'sell';

    log.debug(
      `[q-rl] Thompson: buy=Beta(${buyWins + 1},${buyLosses + 1})→${sampleBuy.toFixed(4)}, ` +
      `sell=Beta(${sellWins + 1},${sellLosses + 1})→${sampleSell.toFixed(4)} → ${selected}`
    );

    return selected;
  }

  /**
   * Sample from Beta(α, β) distribution via gamma ratio.
   * Beta(α, β) = Gamma(α) / (Gamma(α) + Gamma(β))
   */
  private sampleBeta(alpha: number, beta: number): number {
    if (alpha <= 0 || beta <= 0) return 0.5; // safety
    const x = this.sampleGamma(alpha);
    const y = this.sampleGamma(beta);
    const sum = x + y;
    if (sum === 0 || !Number.isFinite(sum)) return 0.5;
    return Math.max(0, Math.min(1, x / sum));
  }

  /**
   * Marsaglia-Tsang gamma sampling for shape parameter α ≥ 1.
   * For α < 1, uses the boost trick: Gamma(α) = Gamma(α+1) × U^(1/α).
   * Returns a finite, positive number. Never throws.
   */
  private sampleGamma(shape: number): number {
    if (!Number.isFinite(shape) || shape <= 0) return 1; // safety
    if (shape < 1) {
      // Boost: Gamma(α) = Gamma(α+1) × U^(1/α)
      const u = Math.random();
      if (u === 0) return 0;
      return this.sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 100; i++) {
      let x: number;
      let v: number;
      do {
        x = this.standardNormal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d; // fallback (should rarely reach here)
  }

  /** Box-Muller standard normal sample. */
  private standardNormal(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    if (u1 === 0) return 0;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Current ε value: linear decay from epsilonStart to epsilonMin.
   *  v2.0.835 security: epsilonDecayCycles <= 0 → return epsilonMin (no NaN). */
  currentEpsilon(): number {
    const { epsilonStart, epsilonMin, epsilonDecayCycles } = this.config;
    if (epsilonDecayCycles <= 0 || !Number.isFinite(epsilonDecayCycles)) return Math.max(epsilonMin, epsilonStart);
    const raw = epsilonStart - (epsilonStart - epsilonMin) * (this.totalCycles / epsilonDecayCycles);
    const clamped = Math.max(epsilonMin, Math.min(epsilonStart, raw));
    return Number.isFinite(clamped) ? clamped : epsilonMin;
  }

  // ─── Q-value update ───

  /** Update Q-value from an Aligned Shadow resolution.
   *  @param features  Market features at entry time
   *  @param action    The action taken (buy/sell)
   *  @param reward    Realized PnL% AFTER slippage + funding deduction
   *  v2.0.835 security: null/undefined features → safe default binning. */
  update(
    features: Record<string, number>,
    action: 'buy' | 'sell',
    reward: number,
  ): void {
    // Guard against null/undefined features
    const safeFeatures = (features && typeof features === 'object') ? features : {};
    const key = this.makeKey(safeFeatures, action);
    const visits = this.visits[key] ?? 0;
    const alpha = 1 / (1 + visits); // diminishing learning rate
    const oldQ = this.values[key] ?? 0;
    const safeReward = Number.isFinite(reward) ? reward : 0;
    const newQ = (1 - alpha) * oldQ + alpha * safeReward;

    this.values[key] = newQ;
    this.visits[key] = visits + 1;
    this.lastUpdate[key] = Date.now();

    // Keep last N rewards for Wilson score + bootstrap
    // v2.0.835 security: sanitize loaded non-array rewardHistory entries
    const raw = this.rewardHistory[key];
    const history = Array.isArray(raw) ? raw : [];
    history.push(safeReward);
    if (history.length > this.config.maxRewardHistory) history.shift();
    this.rewardHistory[key] = history;

    log.debug(`[q-rl] UPDATE ${key}: Q=${newQ.toFixed(4)} (α=${alpha.toFixed(3)}, reward=${safeReward.toFixed(4)}, n=${visits + 1})`);
  }

  // ─── Discovery scanning ───

  /** Scan Q-table for discovered alpha patterns. Called every `discoveryScanInterval` cycles.
   *  Returns top 5 discoveries sorted by Q-value, with BH-FDR correction. */
  discoverPatterns(cycle: number): AlphaDiscovery[] {
    if (cycle - this.lastDiscoveryCycle < this.config.discoveryScanInterval) {
      return this.cachedDiscoveries;
    }
    this.lastDiscoveryCycle = cycle;

    const rawDiscoveries: AlphaDiscovery[] = [];

    for (const [keyStr, qValue] of Object.entries(this.values)) {
      const visits = this.visits[keyStr] ?? 0;
      const rewards = this.rewardHistory[keyStr] ?? [];
      if (visits < this.config.minVisitsCandidate || rewards.length < this.config.minVisitsCandidate) continue;

      // Wilson score lower bound on win rate (reward > 0 = win)
      const wins = rewards.filter(r => r > 0).length;
      const wilsonLB = wilsonScore(wins, rewards.length);

      // Bootstrap p-value: H0: mean reward = 0
      const pValue = this.bootstrapPValue(rewards);

      // Determine discovery level
      let level: 'candidate' | 'probable' | 'confirmed' = 'candidate';
      if (qValue > this.config.qThresholdCandidate && visits >= this.config.minVisitsCandidate) {
        level = 'candidate';
      }
      if (qValue > this.config.qThresholdProbable && wilsonLB > this.config.wilsonProbable && visits >= this.config.minVisitsProbable) {
        level = 'probable';
      }
      if (qValue > this.config.qThresholdConfirmed && wilsonLB > this.config.wilsonConfirmed && visits >= this.config.minVisitsConfirmed && pValue < this.config.fdrAlpha) {
        level = 'confirmed';
      }

      if (level === 'candidate' && qValue <= this.config.qThresholdCandidate) continue;

      const key = this.parseKey(keyStr);
      rawDiscoveries.push({
        key,
        qValue,
        visits,
        wilsonLB,
        pValue,
        level,
        description: this.formatDescription(key, qValue, visits, wilsonLB, level),
        discoveredAt: cycle, // v2.0.836: record creation cycle for DCS time decay
      });
    }

    // BH-FDR correction across all discoveries
    const corrected = this.benjaminiHochberg(rawDiscoveries);

    // Sort by Q-value descending, take top 5
    this.cachedDiscoveries = corrected.sort((a, b) => b.qValue - a.qValue).slice(0, 5);

    if (this.cachedDiscoveries.length > 0) {
      const confirmed = this.cachedDiscoveries.filter(d => d.level === 'confirmed');
      const probable = this.cachedDiscoveries.filter(d => d.level === 'probable');
      log.info(`[q-rl] Discovery scan cycle ${cycle}: ${this.cachedDiscoveries.length} patterns (${confirmed.length} confirmed, ${probable.length} probable), ε=${this.currentEpsilon().toFixed(3)}`);
      for (const d of this.cachedDiscoveries) {
        log.info(`[q-rl] ${d.level.toUpperCase()}: ${d.description}`);
      }
    }

    return this.cachedDiscoveries;
  }

  /** Get the best confirmed discovery for the current market state (for LLM injection). */
  getBestDiscovery(features: Record<string, number>): AlphaDiscovery | null {
    const discoveries = this.cachedDiscoveries;
    if (discoveries.length === 0) return null;

    // Find discoveries matching the current regime + vol + mom + funding
    const currentRegime = this.binRegime(this.safeFeature(features, 'regimeOrdinal', 0.5));
    const currentVol = this.binVol(this.safeFeature(features, 'volatility', 0.01));
    const currentMom = this.binMom(this.safeFeature(features, 'momentumShort', 0));
    const currentFunding = this.binFunding(this.safeFeature(features, 'fundingRate', 0));

    // Prefer confirmed > probable > candidate, matching current state
    for (const level of ['confirmed', 'probable', 'candidate'] as const) {
      const match = discoveries.find(d =>
        d.level === level &&
        d.key.regime === currentRegime &&
        d.key.volBin === currentVol &&
        d.key.momBin === currentMom &&
        d.key.fundingBin === currentFunding
      );
      if (match) return match;
    }

    // Fallback: best confirmed regardless of state match
    return discoveries.find(d => d.level === 'confirmed') ?? discoveries[0] ?? null;
  }

  /** v2.0.836: Get the reward history for a Q-table key (for DCS calculator).
   *  Returns a copy of the internal reward history array. */
  getRewardHistory(key: QTableKey): number[] {
    const keyStr = `${key.regime}|${key.volBin}|${key.momBin}|${key.fundingBin}|${key.action.toLowerCase() as 'buy' | 'sell'}`;
    const raw = this.rewardHistory[keyStr];
    return Array.isArray(raw) ? [...raw] : [];
  }

  // ─── Persistence ───

  save(): Record<string, unknown> {
    // v2.0.835 security: deep copy to prevent external mutation of internal state
    const cloneRecord = (r: Record<string, number>): Record<string, number> =>
      Object.assign(Object.create(null), r);
    const cloneArrRecord = (r: Record<string, number[]>): Record<string, number[]> => {
      const out: Record<string, number[]> = Object.create(null);
      for (const [k, v] of Object.entries(r)) out[k] = Array.isArray(v) ? [...v] : [];
      return out;
    };
    return {
      values: cloneRecord(this.values),
      visits: cloneRecord(this.visits),
      lastUpdate: cloneRecord(this.lastUpdate),
      rewardHistory: cloneArrRecord(this.rewardHistory),
      totalCycles: this.totalCycles,
      config: this.config,
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    this.values = (s['values'] as Record<string, number>) ?? {};
    this.visits = (s['visits'] as Record<string, number>) ?? {};
    this.lastUpdate = (s['lastUpdate'] as Record<string, number>) ?? {};
    // v2.0.835 security: sanitize rewardHistory — each entry must be array of finite numbers
    const rawRH = s['rewardHistory'] as Record<string, unknown>;
    if (rawRH && typeof rawRH === 'object') {
      const clean: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(rawRH)) {
        clean[k] = Array.isArray(v)
          ? v.filter((x) => typeof x === 'number' && Number.isFinite(x)) as number[]
          : [];
      }
      this.rewardHistory = clean;
    } else {
      this.rewardHistory = {};
    }
    // v2.0.835 security: clear stale cached discoveries on load (avoid ghost discoveries)
    this.cachedDiscoveries = [];
    this.lastDiscoveryCycle = 0;
    this.totalCycles = safeNum(s['totalCycles'] as number, 0);
    // v2.0.835 fix: restore config from saved state (save/load symmetry)
    const savedConfig = s['config'] as Partial<QRLConfig> | undefined;
    if (savedConfig && typeof savedConfig === 'object') {
      this.config = { ...DEFAULT_CONFIG, ...savedConfig };
    }
    log.info(`[q-rl] loaded: ${Object.keys(this.values).length} cells, ${this.totalCycles} total cycles, ε=${this.currentEpsilon().toFixed(3)}`);
  }

  /** Reset — used by tests. */
  reset(): void {
    this.values = {};
    this.visits = {};
    this.lastUpdate = {};
    this.rewardHistory = {};
    this.totalCycles = 0;
    this.lastDiscoveryCycle = 0;
    this.cachedDiscoveries = [];
  }

  /** Get stats for UI / API. */
  getStats(): { totalCells: number; activeCells: number; confirmedPatterns: number; epsilon: number; totalCycles: number } {
    const activeCells = Object.values(this.visits).filter(v => v > 0).length;
    const confirmedPatterns = this.cachedDiscoveries.filter(d => d.level === 'confirmed').length;
    return {
      totalCells: 270,
      activeCells,
      confirmedPatterns,
      epsilon: this.currentEpsilon(),
      totalCycles: this.totalCycles,
    };
  }

  // ─── Private helpers ───

  private makeKey(features: Record<string, number>, action: 'buy' | 'sell'): string {
    const regime = this.binRegime(this.safeFeature(features, 'regimeOrdinal', 0.5));
    const volBin = this.binVol(this.safeFeature(features, 'volatility', 0.01));
    const momBin = this.binMom(this.safeFeature(features, 'momentumShort', 0));
    const fundingBin = this.binFunding(this.safeFeature(features, 'fundingRate', 0));
    // v2.0.835 security: normalize action to lowercase to prevent case-sensitivity bugs
    const act = action.toLowerCase() as 'buy' | 'sell';
    return `${regime}|${volBin}|${momBin}|${fundingBin}|${act}`;
  }

  /** v2.0.835 security: safe feature access — getter bombs / Proxy objects can
   *  throw on property access. This helper catches the throw and returns
   *  a fallback, preventing a crash in the decision cycle. */
  private safeFeature(features: Record<string, number>, key: string, fallback: number): number {
    try {
      const v = features[key];
      return typeof v === 'number' ? v : fallback;
    } catch {
      return fallback;
    }
  }

  private parseKey(keyStr: string): QTableKey {
    const parts = keyStr.split('|');
    const regime = parts[0] ?? 'unknown';
    const volBin = parts[1] ?? 'normal';
    const momBin = parts[2] ?? 'flat';
    const fundingBin = parts[3] ?? 'neutral';
    const action = (parts[4] ?? 'buy') as 'buy' | 'sell';
    return { regime, volBin, momBin, fundingBin, action };
  }

  private binRegime(regimeOrdinal: number): string {
    if (!Number.isFinite(regimeOrdinal)) return 'low_vol';
    if (regimeOrdinal <= 0.15) return 'chaotic';
    if (regimeOrdinal <= 0.35) return 'mean_reverting';
    if (regimeOrdinal <= 0.55) return 'low_vol';
    if (regimeOrdinal <= 0.8) return 'trending_bull';
    return 'trending_bear';
  }

  private binVol(vol: number): string {
    if (!Number.isFinite(vol) || vol < 0.005) return 'calm';
    if (vol < 0.02) return 'normal';
    return 'volatile';
  }

  private binMom(mom: number): string {
    if (!Number.isFinite(mom) || mom < -0.5) return 'down';
    if (mom < 0.5) return 'flat';
    return 'up';
  }

  private binFunding(funding: number): string {
    if (!Number.isFinite(funding) || funding < 0) return 'negative';
    if (funding < 0.0002) return 'neutral';
    return 'positive';
  }

  private formatDescription(key: QTableKey, qValue: number, visits: number, wilsonLB: number, level: string): string {
    const actionEmoji = key.action === 'buy' ? '🟢' : '🔴';
    return `${actionEmoji} Q-RL ${level.toUpperCase()}: ${key.regime} + vol=${key.volBin} + ` +
      `momentum=${key.momBin} + funding=${key.fundingBin} → ${key.action.toUpperCase()}, ` +
      `Q=${(qValue * 100).toFixed(2)}%, n=${visits}, Wilson LB=${(wilsonLB * 100).toFixed(0)}%`;
  }

  // ─── Statistical tests ───

  /** Bootstrap p-value for H0: mean reward = 0.
   *  Uses stationary block bootstrap (Politis & Romano 1994) with block size √n.
   *  v2.0.835 fix: center data under H0 (subtract observed mean) so that
   *  bootstrap samples reflect the null distribution. Without centering,
   *  identical rewards yield p-value=1.0 instead of ~0.0. */
  private bootstrapPValue(rewards: number[]): number {
    if (rewards.length < 10) return 1.0;
    const observed = rewards.reduce((a, b) => a + b, 0) / rewards.length;
    // Center data under H0: mean = 0
    const centered = rewards.map(r => r - observed);
    const blockSize = Math.max(1, Math.floor(Math.sqrt(rewards.length)));
    let count = 0;
    const N = 2000; // 2000 iterations (fast enough for 30 rewards)
    for (let i = 0; i < N; i++) {
      const sample = this.blockBootstrap(centered, blockSize);
      const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
      if (mean >= observed) count++;
    }
    return count / N;
  }

  private blockBootstrap(rewards: number[], blockSize: number): number[] {
    const n = rewards.length;
    const out: number[] = [];
    while (out.length < n) {
      const start = Math.floor(Math.random() * n);
      for (let j = 0; j < blockSize && out.length < n; j++) {
        const v = rewards[(start + j) % n] ?? 0;
        out.push(Number.isFinite(v) ? v : 0);
      }
    }
    return out;
  }

  /** Benjamini-Hochberg FDR correction.
   *  Sorts discoveries by p-value, applies BH threshold (rank/m) × α.
   *  Discoveries that fail BH are downgraded from 'confirmed' to 'probable'. */
  private benjaminiHochberg(discoveries: AlphaDiscovery[]): AlphaDiscovery[] {
    const sorted = [...discoveries].sort((a, b) => a.pValue - b.pValue);
    const m = sorted.length;
    if (m === 0) return sorted;
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      if (!item) continue;
      const bhThreshold = ((i + 1) / m) * this.config.fdrAlpha;
      if (item.pValue > bhThreshold && item.level === 'confirmed') {
        item.level = 'probable'; // BH-FDR failed → downgrade
      }
    }
    return sorted;
  }
}