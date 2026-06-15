// ─── Correlation Budget ───
// Computes a correlation-adjusted effective exposure across ALL open positions.
// Prevents hidden concentration risk: long BTC + long ETH + long SOL ≠ 3 independent positions.
//
// Data source: HL candleSnapshot API (daily candles, 90-day window).
// Correlation computed from daily log returns over rolling 90-day window.
// Falls back to hardcoded default correlation matrix if API fails.
//
// Integration: called each cycle in runDecisionCycle().
// If effective exposure > budget limit → flag positions for reduction.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'correlation-budget' });

// ─── Default Correlation Matrix ───
// Hardcoded fallback based on historical HL perp data.
// Used when candleSnapshot API fails or data is insufficient.
const DEFAULT_CORRELATIONS: Record<string, Record<string, number>> = {
  'BTC':  { 'BTC': 1.00, 'ETH': 0.80, 'SOL': 0.70, 'ARB': 0.65, 'OP': 0.60, 'DOGE': 0.55, 'PEPE': 0.40, 'AAVE': 0.60, 'LINK': 0.65, 'AVAX': 0.70, 'SUI': 0.60, 'APT': 0.55 },
  'ETH':  { 'BTC': 0.80, 'ETH': 1.00, 'SOL': 0.65, 'ARB': 0.75, 'OP': 0.70, 'DOGE': 0.50, 'PEPE': 0.35, 'AAVE': 0.65, 'LINK': 0.60, 'AVAX': 0.65, 'SUI': 0.55, 'APT': 0.50 },
  'SOL':  { 'BTC': 0.70, 'ETH': 0.65, 'SOL': 1.00, 'ARB': 0.55, 'OP': 0.50, 'DOGE': 0.45, 'PEPE': 0.30, 'AAVE': 0.50, 'LINK': 0.55, 'AVAX': 0.65, 'SUI': 0.60, 'APT': 0.55 },
};

const DEFAULT_CORR_FOR_UNKNOWN = 0.50; // Default correlation for unknown pairs
/** Maximum effective single-direction exposure as fraction of balance */
const MAX_EFFECTIVE_EXPOSURE = 0.15; // 15% (correlation-adjusted)
const CACHE_TTL_MS = 86_400_000; // 24h

// ─── Types ───

export interface PositionExposure {
  symbol: string;
  /** Absolute notional value of the position (price × quantity × leverage) */
  notional: number;
  /** Side: +1 for long, -1 for short */
  direction: number;
}

export interface CorrelationBudgetReport {
  /** Total notional sum across all positions */
  grossExposure: number;
  /** Correlation-adjusted effective exposure (accounts for diversification) */
  effectiveExposure: number;
  /** Budget limit (max effective exposure allowed) */
  budgetLimit: number;
  /** If true, effective exposure exceeds budget */
  exceeded: boolean;
  /** Per-symbol contribution to effective exposure */
  contributions: Array<{ symbol: string; notional: number; contribution: number }>;
  /** Recommended action */
  recommendation: string;
}

// ─── Correlation Budget ───

export class CorrelationBudget {
  private correlationMatrix: Record<string, Record<string, number>> = { ...DEFAULT_CORRELATIONS };
  private lastUpdateTime = 0;
  private updateInProgress = false;
  private readonly logger = log;

  /** Fetch daily candles and compute rolling correlation matrix.
   *  Uses HL candleSnapshot API.
   *  Falls back to hardcoded defaults on any error.
   */
  async update(
    symbols: string[],
    hlFetch: (body: object) => Promise<Response>,
  ): Promise<void> {
    if (this.updateInProgress) return;
    const now = Date.now();
    if (now - this.lastUpdateTime < CACHE_TTL_MS) return; // Cache hit

    this.updateInProgress = true;
    try {
      if (symbols.length < 2) return;

      // Fetch 90 days of daily candles for each symbol
      const endTime = now;
      const startTime = endTime - 90 * 86_400_000;
      const priceSeries = new Map<string, number[]>();

      for (const symbol of symbols) {
        const cleanSymbol = symbol.replace(/^.*:/, ''); // strip DEX prefix (xyz:BTC → BTC)
        try {
          const res = await hlFetch({
            type: 'candleSnapshot',
            req: { coin: cleanSymbol.toUpperCase(), interval: '1d', startTime, endTime },
          });
          if (!res.ok) continue;
          const candles = await res.json() as Array<{ t: number; c: string }>;
          if (!Array.isArray(candles) || candles.length < 10) continue;
          // Extract daily close prices in chronological order
          const prices = candles
            .sort((a, b) => a.t - b.t)
            .map(c => parseFloat(c.c))
            .filter(p => p > 0);
          if (prices.length >= 10) {
            priceSeries.set(cleanSymbol, prices);
          }
        } catch {
          continue; // Skip symbol on error
        }
      }

      if (priceSeries.size < 2) return; // Not enough data

      // Compute log returns for each symbol
      const returns = new Map<string, number[]>();
      for (const [sym, prices] of priceSeries) {
        const r: number[] = [];
        for (let i = 1; i < prices.length; i++) {
          if (prices[i]! > 0 && prices[i - 1]! > 0) {
            r.push(Math.log(prices[i]! / prices[i - 1]!));
          }
        }
        if (r.length >= 5) returns.set(sym, r);
      }

      // Compute Pearson correlation for each pair
      const symList = [...returns.keys()];
      for (let i = 0; i < symList.length; i++) {
        for (let j = i; j < symList.length; j++) {
          const symI = symList[i]!;
          const symJ = symList[j]!;
          const rI = returns.get(symI)!;
          const rJ = returns.get(symJ)!;
          const minLen = Math.min(rI.length, rJ.length);
          const rrI = rI.slice(-minLen);
          const rrJ = rJ.slice(-minLen);

          const corr = this.pearsonCorrelation(rrI, rrJ);

          if (!this.correlationMatrix[symI]) this.correlationMatrix[symI] = {};
          if (!this.correlationMatrix[symJ]) this.correlationMatrix[symJ] = {};
          this.correlationMatrix[symI]![symJ] = corr;
          this.correlationMatrix[symJ]![symI] = corr;
        }
      }

      this.lastUpdateTime = now;
      this.logger.info(`Correlation matrix updated: ${symList.length} symbols from HL candles`);
    } catch (err) {
      this.logger.error(`[correlation-budget.update] Failed: ${err instanceof Error ? err.message : String(err)}. Using defaults.`);
      // Falls back to default correlation matrix
    } finally {
      this.updateInProgress = false;
    }
  }

  /** Compute effective correlation-adjusted exposure for a set of positions.
   *  Uses portfolio variance formula:
   *    σ²_portfolio = ΣΣ w_i * w_j * σ_i * σ_j * ρ_ij
   *  Simplified: effective_exposure = sqrt(ΣΣ notional_i * notional_j * ρ_ij)
   *
   *  This captures: if you're long BTC ($1000) and long ETH ($1000) with ρ=0.8,
   *  your effective exposure is sqrt(1000² + 1000² + 2*1000*1000*0.8) = $1,897,
   *  NOT $2,000 — because correlation < 1 gives diversification benefit.
   *  BUT also NOT $1,000 — because they're still correlated.
   */
  getEffectiveExposure(positions: PositionExposure[]): number {
    try {
      if (positions.length === 0) return 0;
      if (positions.length === 1) return Math.abs(positions[0]!.notional);

      let sumSq = 0;
      for (let i = 0; i < positions.length; i++) {
        for (let j = 0; j < positions.length; j++) {
          const symI = positions[i]!.symbol.replace(/^.*:/, '');
          const symJ = positions[j]!.symbol.replace(/^.*:/, '');
          const corr = this.getCorrelation(symI, symJ);
          // Direction matters: opposite directions reduce exposure
          const dirI = positions[i]!.direction;
          const dirJ = positions[j]!.direction;
          sumSq += positions[i]!.notional * positions[j]!.notional * corr * dirI * dirJ;
        }
      }
      // Effective exposure = sqrt(portfolio variance proxy)
      // Clamp to prevent NaN from negative variance (opposite positions)
      return Math.sqrt(Math.max(0, sumSq));
    } catch (err) {
      this.logger.error(`[getEffectiveExposure] Failed: ${err instanceof Error ? err.message : String(err)}`);
      // Fallback: sum of absolute notionals (worst case)
      return positions.reduce((s, p) => s + Math.abs(p.notional), 0);
    }
  }

  /** Generate a correlation budget report for the portfolio */
  generateReport(positions: PositionExposure[], balance: number): CorrelationBudgetReport {
    try {
      const grossExposure = positions.reduce((s, p) => s + Math.abs(p.notional), 0);
      const effectiveExposure = this.getEffectiveExposure(positions);
      const budgetLimit = balance * MAX_EFFECTIVE_EXPOSURE;
      const exceeded = effectiveExposure > budgetLimit;

      const contributions = positions.map(p => ({
        symbol: p.symbol,
        notional: Math.abs(p.notional),
        contribution: grossExposure > 0 ? Math.abs(p.notional) / grossExposure : 0,
      }));

      let recommendation: string;
      if (positions.length === 0) {
        recommendation = 'No open positions.';
      } else if (exceeded) {
        const excessPct = ((effectiveExposure - budgetLimit) / budgetLimit * 100).toFixed(0);
        recommendation = `⚠️ Effective exposure $${effectiveExposure.toFixed(0)} exceeds budget $${budgetLimit.toFixed(0)} by ${excessPct}%. Consider reducing correlated positions.`;
      } else {
        const utilPct = (effectiveExposure / budgetLimit * 100).toFixed(0);
        recommendation = `✅ Effective exposure $${effectiveExposure.toFixed(0)} is ${utilPct}% of $${budgetLimit.toFixed(0)} budget.`;
      }

      return { grossExposure, effectiveExposure, budgetLimit, exceeded, contributions, recommendation };
    } catch (err) {
      this.logger.error(`[generateReport] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { grossExposure: 0, effectiveExposure: 0, budgetLimit: 0, exceeded: false, contributions: [], recommendation: 'Report unavailable.' };
    }
  }

  /** Get correlation coefficient between two symbols (case-insensitive) */
  private getCorrelation(symA: string, symB: string): number {
    try {
      const a = symA.toUpperCase();
      const b = symB.toUpperCase();
      if (a === b) return 1.0;

      // Check computed matrix first
      if (this.correlationMatrix[a]?.[b] !== undefined) return this.correlationMatrix[a]![b]!;
      if (this.correlationMatrix[b]?.[a] !== undefined) return this.correlationMatrix[b]![a]!;

      // Check default matrix
      if (DEFAULT_CORRELATIONS[a]?.[b] !== undefined) return DEFAULT_CORRELATIONS[a]![b]!;
      if (DEFAULT_CORRELATIONS[b]?.[a] !== undefined) return DEFAULT_CORRELATIONS[b]![a]!;

      return DEFAULT_CORR_FOR_UNKNOWN;
    } catch {
      return DEFAULT_CORR_FOR_UNKNOWN;
    }
  }

  /** Pearson correlation coefficient between two arrays */
  private pearsonCorrelation(x: number[], y: number[]): number {
    try {
      const n = Math.min(x.length, y.length);
      if (n < 3) return DEFAULT_CORR_FOR_UNKNOWN;

      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
      for (let i = 0; i < n; i++) {
        const xi = x[i] ?? 0;
        const yi = y[i] ?? 0;
        sumX += xi; sumY += yi;
        sumXY += xi * yi;
        sumX2 += xi * xi;
        sumY2 += yi * yi;
      }

      const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      if (denom === 0) return DEFAULT_CORR_FOR_UNKNOWN;

      const r = (n * sumXY - sumX * sumY) / denom;
      // Clamp to valid range [-1, 1]
      return Math.max(-1, Math.min(1, r));
    } catch {
      return DEFAULT_CORR_FOR_UNKNOWN;
    }
  }

  /** Get the last update timestamp */
  getLastUpdateTime(): number {
    return this.lastUpdateTime;
  }

  /** Get a human-readable summary of the correlation matrix */
  getSummary(): string {
    try {
      const symbols = Object.keys(this.correlationMatrix);
      if (symbols.length === 0) return 'No correlation data.';
      const lines = ['=== Correlation Budget ==='];
      for (let i = 0; i < Math.min(symbols.length, 6); i++) {
        for (let j = i + 1; j < Math.min(symbols.length, 6); j++) {
          const corr = this.getCorrelation(symbols[i]!, symbols[j]!);
          lines.push(`${symbols[i]!.padEnd(6)} × ${symbols[j]!.padEnd(6)} = ${corr.toFixed(2)}`);
        }
      }
      lines.push('========================');
      return lines.join('\n');
    } catch {
      return 'Correlation data unavailable.';
    }
  }
}