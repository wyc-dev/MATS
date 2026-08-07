// ─── Causal Reasoner (v2.0.839) ───────────────────────────────────
//
// Distinguishes causation from correlation in trade outcomes.
// Uses paired shadow trades to estimate counterfactual PnL (uplift),
// and permutation-based causal feature importance.
//
// Architecture:
//   1. Paired shadow: for every aligned shadow, also track a "hold" benchmark
//      → compare PnL to estimate uplift = tradedPnl - holdPnl
//   2. Causal feature importance: permute each feature, measure prediction drop
//   3. Confounder detection: high correlation but low causal importance = confounder
//
// Theory:
//   Pearl do-calculus: P(Y|do(X)) ≠ P(Y|X) when confounders exist.
//   Uplift = P(win|traded) - P(win|not traded) = causal effect of trading.
//   Permutation importance: break feature→outcome link, measure accuracy drop.

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'causal-reasoner' });

// ─── Types ───

interface PairedShadow {
  symbol: string;
  side: 'buy' | 'sell';
  entryCycle: number;
  entryPrice: number;
  tradedPnlPct?: number;
  holdPnlPct?: number;
  uplift?: number;
  resolved: boolean;
}

interface FeatureImportanceResult {
  feature: string;
  causalImportance: number;  // [0, 1]
  correlation: number;       // [-1, 1]
  isConfounder: boolean;
}

// ─── Constants ───

const MAX_PAIRED = 300;
const MIN_PAIRED_FOR_OUTPUT = 10;
const MIN_PER_SYMBOL = 5;
const MIN_IMPORTANCE_RECORDS = 30;
const IMPORTANCE_CACHE_INTERVAL = 50;
const PERMUTATION_REPEATS = 10;

// ─── Causal Reasoner ───

export class CausalReasoner {
  private pairedShadows: PairedShadow[] = [];
  private featureImportance: FeatureImportanceResult[] = [];
  private lastImportanceCycle = 0;

  /**
   * Record a paired shadow outcome.
   * Called when BOTH the aligned shadow AND the hold benchmark resolve.
   */
  recordPairedShadow(
    symbol: string,
    side: 'buy' | 'sell',
    entryCycle: number,
    entryPrice: number,
    tradedPnlPct: number,
    holdPnlPct: number,
  ): void {
    if (!Number.isFinite(tradedPnlPct) || !Number.isFinite(holdPnlPct)) return;
    if (typeof symbol !== 'string' || symbol.length === 0) symbol = 'unknown';

    const uplift = tradedPnlPct - holdPnlPct;
    this.pairedShadows.push({
      symbol,
      side,
      entryCycle,
      entryPrice,
      tradedPnlPct,
      holdPnlPct,
      uplift,
      resolved: true,
    });
    if (this.pairedShadows.length > MAX_PAIRED) this.pairedShadows.shift();

    log.debug(
      `[causal] paired shadow: ${symbol} ${side} uplift=${uplift.toFixed(4)} ` +
      `(traded=${tradedPnlPct.toFixed(4)}, hold=${holdPnlPct.toFixed(4)})`
    );
  }

  /**
   * Compute average uplift across all paired shadows.
   * Uplift > 0 = trading has causal effect (good).
   * Uplift ≈ 0 = trading has no causal effect (just following market).
   * Uplift < 0 = trading has negative causal effect (bad).
   */
  getAverageUplift(): { uplift: number; samples: number; positiveRate: number } {
    const resolved = this.pairedShadows.filter(p => p.uplift !== undefined);
    if (resolved.length < MIN_PAIRED_FOR_OUTPUT) return { uplift: 0, samples: 0, positiveRate: 0 };
    const avgUplift = resolved.reduce((s, p) => s + (p.uplift ?? 0), 0) / resolved.length;
    const positiveRate = resolved.filter(p => (p.uplift ?? 0) > 0).length / resolved.length;
    return { uplift: avgUplift, samples: resolved.length, positiveRate };
  }

  /**
   * Get per-symbol uplift breakdown.
   */
  getPerSymbolUplift(): Array<{ symbol: string; uplift: number; samples: number }> {
    const bySymbol = new Map<string, number[]>();
    for (const p of this.pairedShadows) {
      if (p.uplift === undefined) continue;
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push(p.uplift);
      bySymbol.set(p.symbol, arr);
    }
    const out: Array<{ symbol: string; uplift: number; samples: number }> = [];
    for (const [symbol, uplifts] of bySymbol) {
      if (uplifts.length < MIN_PER_SYMBOL) continue;
      const avg = uplifts.reduce((a, b) => a + b, 0) / uplifts.length;
      out.push({ symbol, uplift: avg, samples: uplifts.length });
    }
    return out.sort((a, b) => b.uplift - a.uplift);
  }

  /**
   * Compute causal feature importance via permutation.
   *
   * For each feature:
   *   1. Compute baseline |correlation| with PnL
   *   2. Permute the feature's values (break the causal link)
   *   3. Re-compute |correlation| → if it drops, the feature is causally important
   *
   * @param records  Array of { features: Record<string, number>, pnlPct: number }
   * @param cycle    Current cycle (for caching)
   */
  computeCausalFeatureImportance(
    records: Array<{ features: Record<string, number>; pnlPct: number }>,
    cycle: number,
  ): FeatureImportanceResult[] {
    if (records.length < MIN_IMPORTANCE_RECORDS) return [];
    if (cycle - this.lastImportanceCycle < IMPORTANCE_CACHE_INTERVAL && this.featureImportance.length > 0) {
      return this.featureImportance;
    }
    this.lastImportanceCycle = cycle;

    // Get all feature names
    const featureNames = new Set<string>();
    for (const r of records) {
      if (!r.features || typeof r.features !== 'object') continue;
      for (const k of Object.keys(r.features)) featureNames.add(k);
    }

    const pnls = records.map(r => safeNum(r.pnlPct, 0));
    const results: FeatureImportanceResult[] = [];

    for (const feature of featureNames) {
      const values = records.map(r => safeNum(r.features?.[feature], 0));
      const correlation = this.pearsonCorrelation(values, pnls);

      // Permutation: average importance over multiple repeats
      let avgPermCorr = 0;
      for (let rep = 0; rep < PERMUTATION_REPEATS; rep++) {
        const shuffled = [...values];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        avgPermCorr += Math.abs(this.pearsonCorrelation(shuffled, pnls));
      }
      avgPermCorr /= PERMUTATION_REPEATS;

      const importance = Math.abs(correlation) - avgPermCorr;
      const causalImportance = Math.max(0, importance);
      // Confounder: high |corr| but low causal importance (permute doesn't reduce →
      // the correlation is not causal, it's a confounded association)
      const isConfounder = Math.abs(correlation) > 0.15 && causalImportance < Math.abs(correlation) * 0.3;

      results.push({
        feature,
        causalImportance,
        correlation,
        isConfounder,
      });
    }

    results.sort((a, b) => b.causalImportance - a.causalImportance);
    this.featureImportance = results;
    return results;
  }

  /**
   * Generate causal reasoning block for HACP injection.
   */
  getCausalBlock(): string {
    const uplift = this.getAverageUplift();
    if (uplift.samples < MIN_PAIRED_FOR_OUTPUT) {
      return '=== CAUSAL REASONING ===\nInsufficient paired shadow data for causal analysis.\n---';
    }

    const lines: string[] = [
      '=== CAUSAL REASONING (Causation ≠ Correlation) ===',
      `📊 Average uplift: ${(uplift.uplift * 100).toFixed(2)}% (n=${uplift.samples})`,
      `📊 Positive uplift rate: ${(uplift.positiveRate * 100).toFixed(0)}% of trades`,
    ];

    if (uplift.uplift < 0.001) {
      lines.push('');
      lines.push('⚠️ UPLIFT ≈ 0: Your trades have NO causal effect on PnL.');
      lines.push('   You are just following the market, not adding alpha.');
      lines.push('   Consider: tighter entry criteria, or avoid trading in these conditions.');
    } else if (uplift.uplift > 0.005) {
      lines.push('');
      lines.push(`✅ UPLIFT POSITIVE: Your trades add ${(uplift.uplift * 100).toFixed(2)}% alpha per trade.`);
      lines.push('   This is genuine causal alpha, not just market direction.');
    }

    // Per-symbol uplift
    const perSymbol = this.getPerSymbolUplift();
    if (perSymbol.length > 0) {
      lines.push('');
      lines.push('Per-symbol causal uplift:');
      for (const { symbol, uplift: u, samples } of perSymbol.slice(0, 5)) {
        const status = u > 0.003 ? '✅' : u < -0.001 ? '❌' : '⚠️';
        lines.push(`  ${status} ${symbol}: ${(u * 100).toFixed(2)}% uplift (n=${samples})`);
      }
    }

    // Feature importance
    if (this.featureImportance.length > 0) {
      lines.push('');
      lines.push('Causal feature importance (top 5):');
      for (const fi of this.featureImportance.slice(0, 5)) {
        const tag = fi.isConfounder ? ' ⚠️ confounder' : '';
        lines.push(
          `  ${fi.feature}: causal=${fi.causalImportance.toFixed(4)}, ` +
          `corr=${fi.correlation.toFixed(4)}${tag}`
        );
      }
    }

    lines.push('---');
    return lines.join('\n');
  }

  getPairedCount(): number {
    return this.pairedShadows.length;
  }

  /**
   * v2.0.842: Record an audit-detected confounder.
   * When the LLM audit finds "low-conditional-win-rate-ignored", it means
   * a feature (e.g. conviction gate) has high correlation with trade entry
   * but low causal importance — the system trades despite low WR = confounder.
   * This injects a synthetic feature importance entry marking the feature
   * as a confounder so the causal block warns the Meta-Agent.
   */
  recordAuditConfounder(featureName: string, detail: string): void {
    if (typeof featureName !== 'string' || featureName.length === 0) return;
    // v2.0.843c: Guard against undefined/null/NaN detail — .slice would throw
    const safeDetail = typeof detail === 'string' && detail.length > 0
      ? detail
      : 'no detail provided';
    // Add as a confounder entry in feature importance
    const existing = this.featureImportance.find(fi => fi.feature === featureName);
    if (existing) {
      existing.isConfounder = true;
      existing.causalImportance = Math.min(existing.causalImportance, 0.01);
    } else {
      this.featureImportance.push({
        feature: featureName,
        causalImportance: 0.01,  // near-zero causal importance
        correlation: 0.5,       // moderate correlation (it correlates with entry)
        isConfounder: true,
      });
      // Keep sorted
      this.featureImportance.sort((a, b) => b.causalImportance - a.causalImportance);
    }
    log.info(`[causal] audit confounder: ${featureName} — ${safeDetail.slice(0, 80)}`);
  }

  /**
   * Pearson correlation coefficient.
   */
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
      pairedShadows: this.pairedShadows.slice(-100),
      featureImportance: this.featureImportance,
      lastImportanceCycle: this.lastImportanceCycle,
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const savedShadows = s['pairedShadows'];
    if (Array.isArray(savedShadows)) {
      // 基本機制審計(v2.0.865-fix3):毒元素(非 finite pnl / 垃圾 shape)會污染
      // uplift 計算——drop 唔 sanitize
      this.pairedShadows = [];
      for (const raw of savedShadows) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (typeof r['tradeId'] !== 'string' && typeof r['symbol'] !== 'string') continue;
        const traded = safeNum(r['tradedPnl'] as number, 0);
        const hold = safeNum(r['holdPnl'] as number, 0);
        this.pairedShadows.push({
          symbol: typeof r['symbol'] === 'string' ? r['symbol'] : '',
          side: r['side'] === 'sell' ? 'sell' : 'buy',
          entryCycle: Number.isFinite(r['entryCycle'] as number) ? (r['entryCycle'] as number) : 0,
          entryPrice: safeNum(r['entryPrice'] as number, 0),
          tradedPnlPct: traded,
          holdPnlPct: hold,
          uplift: safeNum(r['uplift'] as number, traded - hold),
          resolved: r['resolved'] === true,
        } as PairedShadow);
      }
    }
    const savedFI = s['featureImportance'];
    if (Array.isArray(savedFI)) {
      this.featureImportance = [];
      for (const raw of savedFI) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (typeof r['feature'] !== 'string') continue;
        this.featureImportance.push({
          feature: r['feature'] as string,
          causalImportance: Math.max(0, Math.min(1, safeNum(r['causalImportance'] as number, 0))),
          correlation: Math.max(-1, Math.min(1, safeNum(r['correlation'] as number, 0))),
          isConfounder: r['isConfounder'] === true,
        } as FeatureImportanceResult);
      }
    }
    this.lastImportanceCycle = safeNum(s['lastImportanceCycle'] as number, 0);
    log.info(`[causal] loaded: ${this.pairedShadows.length} paired shadows, ${this.featureImportance.length} feature importance`);
  }

  reset(): void {
    this.pairedShadows = [];
    this.featureImportance = [];
    this.lastImportanceCycle = 0;
  }
}