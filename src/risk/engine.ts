// ─── Risk Engine ───
// Core risk management — position sizing, stop-loss, drawdown limits, correlation checks

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import type { Portfolio, Position, RiskAssessment, RiskConcern, RiskLimits } from '../types/index.ts';

const log = createLogger({ phase: 'risk' });

export class RiskEngine {
  private readonly limits: RiskLimits;

  constructor(overrides?: Partial<RiskLimits>) {
    this.limits = {
      maxPositionSizePct: config.paper.maxPositionSizePct,
      maxDrawdownPct: config.paper.maxDrawdownPct,
      dailyLossLimitPct: config.paper.dailyLossLimitPct,
      maxLeverage: config.risk.maxLeverage,
      stopLossPct: config.risk.stopLossPct,
      takeProfitPct: config.risk.takeProfitPct,
      trailingStopPct: config.risk.trailingStopPct,
      maxCorrelatedExposure: 0.30,
      minRiskRewardRatio: 2.0,
      ...overrides,
    };
  }

  assessTrade(
    portfolio: Portfolio,
    action: 'buy' | 'sell',
    positionSizePct: number,
    entryPrice: number,
    volatility: number
  ): RiskAssessment {
    const concerns: RiskConcern[] = [];

    // 1. Check drawdown
    if (portfolio.maxDrawdownPct >= this.limits.maxDrawdownPct) {
      concerns.push({
        type: 'drawdown_exceeded',
        severity: 'critical',
        description: `Max drawdown ${(portfolio.maxDrawdownPct * 100).toFixed(1)}% exceeds limit ${(this.limits.maxDrawdownPct * 100).toFixed(1)}%`,
        mitigation: 'Close all positions. Stay in cash until drawdown recovers.',
      });
    }

    // 2. Check daily loss (v2.0.23: only on actual loss, not accumulated profit)
    const dailyLossPct = portfolio.dailyPnl < 0 ? Math.abs(portfolio.dailyPnl) / portfolio.totalEquity : 0;
    if (dailyLossPct >= this.limits.dailyLossLimitPct) {
      concerns.push({
        type: 'daily_loss_exceeded',
        severity: 'critical',
        description: `Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds limit ${(this.limits.dailyLossLimitPct * 100).toFixed(1)}%`,
        mitigation: 'No new trades today. Reassess tomorrow.',
      });
    }

    // 3. Check position size
    if (positionSizePct > this.limits.maxPositionSizePct) {
      concerns.push({
        type: 'position_size_too_large',
        severity: 'high',
        description: `Position size ${(positionSizePct * 100).toFixed(1)}% exceeds max ${(this.limits.maxPositionSizePct * 100).toFixed(1)}%`,
        mitigation: `Reduce position size to ${(this.limits.maxPositionSizePct * 100).toFixed(1)}%`,
      });
    }

    // 4. Check volatility
    if (volatility > 0.03) {
      concerns.push({
        type: 'volatility_risk',
        severity: 'high',
        description: `Volatility ${(volatility * 100).toFixed(2)}% is elevated (>3%)`,
        mitigation: 'Reduce position size by 50%. Widen stop-loss.',
      });
    }

    // 5. Check correlation / concentration
    const currentPositions = Array.from(portfolio.positions.values());
    const directionalExposure = currentPositions.reduce(
      (sum, pos) => sum + pos.quantity * pos.currentPrice * (pos.side === 'buy' ? 1 : -1),
      0
    );
    const exposurePct = Math.abs(directionalExposure) / portfolio.totalEquity;
    if (exposurePct > this.limits.maxCorrelatedExposure) {
      concerns.push({
        type: 'correlation_risk',
        severity: 'medium',
        description: `Directional exposure ${(exposurePct * 100).toFixed(1)}% exceeds ${(this.limits.maxCorrelatedExposure * 100).toFixed(1)}%`,
        mitigation: 'Hedge or reduce existing positions before adding new ones.',
      });
    }

    // Calculate risk score
    const score = this.calculateRiskScore(concerns, portfolio);

    // Determine if trade is allowed
    const criticalConcerns = concerns.filter((c) => c.severity === 'critical');
    const highConcerns = concerns.filter((c) => c.severity === 'high');
    const allowed = criticalConcerns.length === 0 && highConcerns.length <= 1;

    // Adjust position size based on concerns
    let adjustedSize = positionSizePct;
    if (concerns.some((c) => c.type === 'volatility_risk')) {
      adjustedSize *= 0.5;
    }
    if (concerns.some((c) => c.type === 'position_size_too_large')) {
      adjustedSize = this.limits.maxPositionSizePct;
    }
    if (adjustedSize !== positionSizePct) {
      log.info(`Position size adjusted: ${(positionSizePct * 100).toFixed(1)}% → ${(adjustedSize * 100).toFixed(1)}%`);
    }

    return {
      allowed,
      vetoed: !allowed,
      score,
      concerns,
      adjustedPositionSize: adjustedSize !== positionSizePct ? adjustedSize : undefined,
      adjustedStopLoss: volatility > 0.03
        ? this.limits.stopLossPct * 1.5
        : undefined,
    };
  }

  calculatePositionSize(
    equity: number,
    entryPrice: number,
    stopLossPrice: number,
    volatility: number,
    confidence: number
  ): { quantity: number; riskAmount: number; riskPct: number } {
    // Volatility-adjusted fixed fraction position sizing.
    // Confidence is applied ONCE via a smooth mapping (0.3→0.65, 0.5→0.75,
    // 0.9→0.95) to avoid the previous double-penalty where confidence
    // multiplied baseRiskPct AND confAdjustment simultaneously.
    const baseRiskPct = this.limits.maxPositionSizePct;

    // Reduce size in high volatility
    const volAdjustment = volatility > 0.03 ? 0.5 : volatility > 0.02 ? 0.75 : 1.0;

    // Single confidence adjustment: maps [0,1] → [0.5,1.0] linearly.
    const confAdjustment = 0.5 + (confidence * 0.5);

    const riskPct = baseRiskPct * volAdjustment * confAdjustment;
    const riskAmount = equity * riskPct;
    const priceRisk = Math.abs(entryPrice - stopLossPrice) / entryPrice;
    const quantity = priceRisk > 0 ? riskAmount / (entryPrice * priceRisk) : 0;

    return {
      quantity: Math.max(0, quantity),
      riskAmount,
      riskPct,
    };
  }

  validateStopLoss(
    entryPrice: number,
    currentPrice: number,
    stopLossPrice: number,
    side: 'buy' | 'sell'
  ): { valid: boolean; reason?: string } {
    if (side === 'buy' && stopLossPrice >= entryPrice) {
      return { valid: false, reason: 'Stop-loss must be below entry for long positions.' };
    }
    if (side === 'sell' && stopLossPrice <= entryPrice) {
      return { valid: false, reason: 'Stop-loss must be above entry for short positions.' };
    }

    const lossPct = Math.abs(currentPrice - stopLossPrice) / currentPrice;
    if (lossPct > this.limits.stopLossPct * 2) {
      return { valid: false, reason: `Stop-loss too wide: ${(lossPct * 100).toFixed(2)}%` };
    }

    return { valid: true };
  }

  getRiskLimits(): Readonly<RiskLimits> {
    return { ...this.limits };
  }

  private calculateRiskScore(
    concerns: RiskConcern[],
    portfolio: Portfolio
  ): number {
    if (concerns.length === 0) return 1.0;

    let deduction = 0;
    for (const c of concerns) {
      switch (c.severity) {
        case 'critical': deduction += 0.40; break;
        case 'high': deduction += 0.20; break;
        case 'medium': deduction += 0.10; break;
        case 'low': deduction += 0.05; break;
      }
    }

    // Also factor in drawdown
    if (portfolio.maxDrawdownPct > 0) {
      deduction += portfolio.maxDrawdownPct * 0.5;
    }

    return Math.max(0, Math.min(1, 1 - deduction));
  }
}