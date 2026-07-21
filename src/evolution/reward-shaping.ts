// ─── v2.0.219: Reward Shaping ────────────────────────────────────────
//
// Transforms raw pnl into a shaped reward that optimizes for risk-adjusted
// returns, not just win rate. This replaces the binary sign(pnl) signal
// used by AttnRes and other learning systems.
//
// Shaped reward components:
//   1. PnL magnitude (direction + how much) — not just win/loss
//   2. Drawdown penalty — penalize trades that caused large portfolio dips
//   3. Sharpe component — reward trades with good return/risk ratio
//   4. Hold-time penalty — penalize trades that took too long (capital inefficiency)
//   5. Recovery bonus — reward trades that recovered from max adverse excursion
//
// The shaped reward is bounded to [-1, 1] to keep gradient updates stable.
//
// Production-grade:
// - All inputs sanitized with safeNum
// - Configurable component weights
// - Bounded output prevents exploding gradients
// - Cold-start safe: works with 0 history (uses defaults)

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'reward-shaping' });

// ─── Types ───

export interface RewardShapingConfig {
  /** Weight for raw PnL component */
  pnlWeight: number;
  /** Weight for drawdown penalty */
  drawdownWeight: number;
  /** Weight for Sharpe-like risk-adjusted return */
  sharpeWeight: number;
  /** Weight for hold-time penalty (capital efficiency) */
  holdTimeWeight: number;
  /** Weight for recovery bonus (MAE → profit) */
  recoveryWeight: number;
  /** Max hold time in minutes before penalty kicks in */
  maxHoldMin: number;
  /** Risk-free rate for Sharpe (annualized, default 0.04 = 4%) */
  riskFreeRate: number;
  /** Target volatility for Sharpe normalization */
  targetVolatility: number;
  /** Output clamp range */
  outputClamp: number;
}

export interface TradeMetrics {
  pnl: number;
  pnlPct: number;
  holdMin: number;
  maePct: number;  // Max Adverse Excursion
  mfePct: number;  // Max Favorable Excursion
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  portfolioDrawdown?: number;  // Current portfolio drawdown at trade close
}

export interface ShapedReward {
  reward: number;        // Final shaped reward [-1, 1]
  pnlComponent: number;
  drawdownComponent: number;
  sharpeComponent: number;
  holdTimeComponent: number;
  recoveryComponent: number;
}

// ─── RewardShaper ───

export class RewardShaper {
  private config: RewardShapingConfig;
  /** Rolling PnL history for Sharpe computation */
  private pnlHistory: number[] = [];
  private readonly maxHistoryLen = 100;

  constructor(config?: Partial<RewardShapingConfig>) {
    this.config = {
      pnlWeight: 0.4,
      drawdownWeight: 0.2,
      sharpeWeight: 0.15,
      holdTimeWeight: 0.1,
      recoveryWeight: 0.15,
      maxHoldMin: 120,
      riskFreeRate: 0.04,
      targetVolatility: 0.02,
      outputClamp: 1.0,
      ...config,
    };
  }

  /**
   * Compute shaped reward from trade metrics.
   */
  shape(metrics: TradeMetrics): ShapedReward {
    const pnl = safeNum(metrics.pnl, 0);
    const pnlPct = safeNum(metrics.pnlPct, 0);
    const holdMin = safeNum(metrics.holdMin, 0);
    const maePct = safeNum(metrics.maePct, 0);
    const mfePct = safeNum(metrics.mfePct, 0);
    const leverage = safeNum(metrics.leverage, 1);
    const drawdown = safeNum(metrics.portfolioDrawdown, 0);

    // 1. PnL component: tanh(pnlPct * leverage * scale) → [-1, 1]
    // Scale so that 2% return at 5x leverage → tanh(0.1) ≈ 0.76
    const pnlScale = 50;
    const pnlComponent = Math.tanh(pnlPct * leverage * pnlScale);

    // 2. Drawdown penalty: penalize if portfolio is in drawdown
    // drawdown is a fraction [0, 1] where 1 = max drawdown
    const drawdownComponent = -Math.tanh(drawdown * 3); // -1 at 33% drawdown

    // 3. Sharpe component: reward good return/risk ratio
    // Update PnL history and compute rolling Sharpe
    this.pnlHistory.push(pnlPct);
    if (this.pnlHistory.length > this.maxHistoryLen) this.pnlHistory.shift();

    let sharpeComponent = 0;
    if (this.pnlHistory.length >= 5) {
      const meanPnl = this.pnlHistory.reduce((a, b) => a + b, 0) / this.pnlHistory.length;
      const variance = this.pnlHistory.reduce((a, b) => a + (b - meanPnl) ** 2, 0) / this.pnlHistory.length;
      const std = Math.sqrt(Math.max(variance, 1e-10));
      // Annualized Sharpe ≈ mean / std * sqrt(trades_per_year)
      // Simplified: just mean / std (per-trade Sharpe)
      const perTradeSharpe = (meanPnl - this.config.riskFreeRate / 365 / 24 / 12) / std;
      sharpeComponent = Math.tanh(perTradeSharpe * 2); // scale to [-1, 1]
    }

    // 4. Hold-time penalty: penalize trades that took too long
    // 0 = perfect (instant), -1 = took 4x max hold time
    const holdRatio = holdMin > 0 ? holdMin / this.config.maxHoldMin : 0;
    const holdTimeComponent = holdRatio > 1
      ? -Math.tanh((holdRatio - 1) * 2)  // penalty for exceeding max hold
      : 0;  // no penalty within max hold

    // 5. Recovery bonus: reward trades that recovered from MAE to profit
    // If MAE was 3% but trade ended positive → strong recovery → bonus
    // If MAE was 3% and trade lost → no recovery → penalty
    const recoveryComponent = maePct > 0 && mfePct > 0
      ? Math.tanh((mfePct - maePct) * 20) // reward MFE >> MAE
      : 0;

    // Weighted sum
    const rawReward =
      this.config.pnlWeight * pnlComponent +
      this.config.drawdownWeight * drawdownComponent +
      this.config.sharpeWeight * sharpeComponent +
      this.config.holdTimeWeight * holdTimeComponent +
      this.config.recoveryWeight * recoveryComponent;

    // Clamp to [-1, 1]
    const reward = Math.max(-this.config.outputClamp, Math.min(this.config.outputClamp, rawReward));

    return {
      reward,
      pnlComponent,
      drawdownComponent,
      sharpeComponent,
      holdTimeComponent,
      recoveryComponent,
    };
  }

  /**
   * Format reward breakdown for logging/debugging.
   */
  formatBreakdown(r: ShapedReward): string {
    return [
      `Shaped reward: ${r.reward.toFixed(4)}`,
      `  PnL:      ${r.pnlComponent.toFixed(3)} (weight ${this.config.pnlWeight})`,
      `  Drawdown: ${r.drawdownComponent.toFixed(3)} (weight ${this.config.drawdownWeight})`,
      `  Sharpe:   ${r.sharpeComponent.toFixed(3)} (weight ${this.config.sharpeWeight})`,
      `  HoldTime: ${r.holdTimeComponent.toFixed(3)} (weight ${this.config.holdTimeWeight})`,
      `  Recovery: ${r.recoveryComponent.toFixed(3)} (weight ${this.config.recoveryWeight})`,
    ].join('\n');
  }

  /**
   * Get config for persistence.
   */
  getConfig(): RewardShapingConfig { return { ...this.config }; }

  /**
   * Save state.
   */
  save(): string {
    return JSON.stringify({
      config: this.config,
      pnlHistory: this.pnlHistory.slice(-this.maxHistoryLen),
    });
  }

  /**
   * Load state.
   */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.config) this.config = { ...this.config, ...data.config };
      if (Array.isArray(data.pnlHistory)) this.pnlHistory = data.pnlHistory;
      log.info(`Reward shaper loaded: ${this.pnlHistory.length} PnL history entries`);
    } catch {
      log.warn('[reward-shaping] Failed to load, starting fresh');
    }
  }
}