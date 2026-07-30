// ─── Backtest Validation (Task 1 §1.9) ───────────────────────────────
//
// v2.0.833: Industry-standard quantitative-finance metrics for edge
// validation. This is the "lie detector" that answers four questions the
// 23-layer evolution pipeline has never answered:
//
//   1. Is the edge real or luck?           → Bootstrap p-value
//   2. Is it alpha or just beta?          → Information Ratio vs buy-and-hold
//   3. Is the learning overfit?            → Walk-forward out-of-sample test
//   4. Does OLR's PnL label reflect reality? → (handled by ExecutionTracker)
//
// All metrics are pure functions on arrays of returns — no I/O, no LLM,
// milliseconds. The orchestrator runs these on the backtest equity curve
// + the buy-and-hold benchmark curve and writes a ValidationReport.
//
// References:
//   Sharpe 1966; Sortino 1994; Young 1991 (Calmar);
//   Politis & Romano 1994 (stationary bootstrap);
//   Bailey & López de Prado 2014 (Deflated Sharpe Ratio).

import { safeNum } from '../evolution/evolution-utils.ts';
import { edgeConfig } from './edge-config.ts';

/** A closed trade's return + metadata, the atomic input to all metrics. */
export interface TradeReturn {
  pnlPct: number;       // realised, after slippage + funding
  symbol: string;
  side: 'buy' | 'sell';
  regime: string;
  /** ms epoch the trade closed. */
  closeTs: number;
  /** ms epoch the trade opened (for hold-time analysis). */
  openTs: number;
}

export interface ValidationReport {
  /** Per-(symbol, regime) breakdown. */
  breakdown: Array<{
    symbol: string;
    regime: string;
    trades: number;
    winRate: number;
    sharpe: number;
    sortino: number;
    calmar: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdownPct: number;
    /** p-value from stationary bootstrap vs H0: mean return = 0. */
    bootstrapP: number;
    /** Deflated Sharpe Ratio (corrects for multiple testing). */
    dsr: number;
    /** Information Ratio vs buy-and-hold benchmark. */
    infoRatio: number;
    /** Verdict: 'edge' | 'no-edge' | 'insufficient'. */
    verdict: 'edge' | 'no-edge' | 'insufficient';
  }>;
  /** Overall verdict across all (symbol, regime) buckets. */
  overall: {
    trades: number;
    sharpe: number;
    bootstrapP: number;
    dsr: number;
    infoRatio: number;
    verdict: 'edge' | 'no-edge' | 'insufficient';
  };
  /** Walk-forward split result. */
  walkForward: {
    inSampleSharpe: number;
    outOfSampleSharpe: number;
    /** overfit ratio: IS / OOS. >2 = severe overfit. */
    overfitRatio: number;
    verdict: 'no-overfit' | 'overfit' | 'insufficient';
  };
  generatedAt: number;
}

// ─── Per-trade metrics ─────────────────────────────────────────────────

/** Annualisation factor: 5-min cycle ⇒ 288/day ⇒ ~105,120/yr. For per-trade
 *  Sharpe we use √(trades/yr); the caller passes the actual trade count. */
export function sharpeRatio(returns: number[], periodsPerYear = 252): number {
  if (returns.length < 2) return 0;
  const mean = meanOf(returns);
  const std = stdOf(returns, mean);
  if (std < 1e-9) return 0;
  return (mean / std) * Math.sqrt(periodsPerYear);
}

/** Sortino: like Sharpe but only penalises downside deviation. Upside
 *  volatility is good — it should not reduce the score. */
export function sortinoRatio(returns: number[], periodsPerYear = 252): number {
  if (returns.length < 2) return 0;
  const mean = meanOf(returns);
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;
  const ddStd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length);
  if (ddStd < 1e-9) return 0;
  return (mean / ddStd) * Math.sqrt(periodsPerYear);
}

/** Calmar: annualised return / max drawdown. High = good. */
export function calmarRatio(returns: number[], periodsPerYear = 252): number {
  if (returns.length === 0) return 0;
  const cum = cumulative(returns);
  const maxDD = maxDrawdownPct(cum);
  if (maxDD < 1e-9) return 0;
  const annualReturn = meanOf(returns) * periodsPerYear;
  return annualReturn / maxDD;
}

/** Profit Factor: gross profit / gross loss. >1.5 is the industry floor
 *  for "has edge". <1 = net losing. */
export function profitFactor(returns: number[]): number {
  const grossProfit = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  if (grossLoss < 1e-9) return grossProfit > 0 ? Infinity : 0;
  return grossProfit / grossLoss;
}

/** Expectancy: average PnL per trade. (winRate × avgWin) − (lossRate × avgLoss). */
export function expectancy(returns: number[]): number {
  if (returns.length === 0) return 0;
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const winRate = wins.length / returns.length;
  const lossRate = 1 - winRate;
  const avgWin = wins.length > 0 ? meanOf(wins) : 0;
  const avgLoss = losses.length > 0 ? Math.abs(meanOf(losses)) : 0;
  return winRate * avgWin - lossRate * avgLoss;
}

/** Maximum drawdown as a percentage of the running peak. */
export function maxDrawdownPct(cumulativeReturns: number[]): number {
  let peak = cumulativeReturns[0] ?? 0;
  let maxDD = 0;
  for (const v of cumulativeReturns) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100; // as %
}

/** Information Ratio: (strategy return − benchmark return) / tracking error.
 *  Positive IR = strategy beats the passive benchmark (it has alpha, not beta). */
export function informationRatio(strategyReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(strategyReturns.length, benchmarkReturns.length);
  if (n < 2) return 0;
  const active = [];
  for (let i = 0; i < n; i++) {
    active.push(safeNum(strategyReturns[i], 0) - safeNum(benchmarkReturns[i], 0));
  }
  const mean = meanOf(active);
  const te = stdOf(active, mean);
  if (te < 1e-9) return 0;
  return mean / te;
}

// ─── Statistical significance ───────────────────────────────────────────

/** Stationary bootstrap p-value for H0: mean return = 0.
 *  Politis & Romano 1994 — block resampling that preserves local dependence
 *  (trades are not i.i.d.). Returns the two-sided p-value. */
export function bootstrapPValue(
  returns: number[],
  iterations = edgeConfig.btestBootstrapN,
): number {
  if (returns.length < 5) return 1.0; // cannot reject H0 with <5 samples
  const observed = meanOf(returns);
  // expected block size: ~√n (Politis rule of thumb)
  const blockSize = Math.max(1, Math.floor(Math.sqrt(returns.length)));
  let count = 0;
  for (let i = 0; i < iterations; i++) {
    const sample = blockBootstrapSample(returns, blockSize);
    if (meanOf(sample) >= observed) count++;
  }
  return count / iterations;
}

/** Deflated Sharpe Ratio: adjusts the observed Sharpe for multiple testing.
 *  If you tested M (symbol × regime) buckets, the best Sharpe is inflated by
 *  √(2·ln(M)). DSR < 0 means the observed Sharpe is below the multiple-testing
 *  threshold ⇒ likely false discovery. Bailey & López de Prado 2014. */
export function deflatedSharpeRatio(
  observedSharpe: number,
  numTrials: number,
  sampleCount: number,
): number {
  if (sampleCount < 2 || numTrials < 1) return 0;
  // expected max Sharpe under H0 over M independent trials:
  const expectedMaxSharpe = Math.sqrt(2 * Math.log(Math.max(1, numTrials)));
  // standard error of the Sharpe estimate (Lo 2002):
  const se = 1 / Math.sqrt(sampleCount - 1);
  // DSR = (observed − expectedMax) / se, then to a standard normal CDF.
  const z = (observedSharpe - expectedMaxSharpe) / se;
  return normalCDF(z);
}

// ─── Walk-forward ──────────────────────────────────────────────────────

/** Split a time-ordered trade list into in-sample / out-of-sample by the
 *  configured split fraction. Returns the two slices preserving order. */
export function walkForwardSplit(returns: TradeReturn[]): {
  inSample: TradeReturn[];
  outOfSample: TradeReturn[];
} {
  const splitIdx = Math.floor(returns.length * edgeConfig.btestSplit);
  return {
    inSample: returns.slice(0, splitIdx),
    outOfSample: returns.slice(splitIdx),
  };
}

/** Run a full walk-forward validation on a trade list (already time-sorted). */
export function walkForwardValidation(returns: TradeReturn[]): ValidationReport['walkForward'] {
  if (returns.length < 20) {
    return { inSampleSharpe: 0, outOfSampleSharpe: 0, overfitRatio: 0, verdict: 'insufficient' };
  }
  const { inSample, outOfSample } = walkForwardSplit(returns);
  const isPnl = inSample.map((t) => t.pnlPct);
  const oosPnl = outOfSample.map((t) => t.pnlPct);
  const isSharpe = sharpeRatio(isPnl);
  const oosSharpe = sharpeRatio(oosPnl);
  const overfit = oosSharpe > 1e-9 ? isSharpe / oosSharpe : Infinity;
  let verdict: 'no-overfit' | 'overfit' | 'insufficient';
  if (inSample.length < 10 || outOfSample.length < 10) verdict = 'insufficient';
  else if (overfit > 2) verdict = 'overfit';
  else verdict = 'no-overfit';
  return { inSampleSharpe: isSharpe, outOfSampleSharpe: oosSharpe, overfitRatio: overfit, verdict };
}

// ─── Full report ───────────────────────────────────────────────────────

/** Build a complete ValidationReport from closed trades + a buy-and-hold
 *  benchmark return series (aligned by index). The benchmark is optional —
 *  pass an empty array to skip the IR calculation. */
export function buildValidationReport(
  trades: TradeReturn[],
  benchmarkReturns: number[] = [],
): ValidationReport {
  // Group by (symbol, regime).
  const groups = new Map<string, TradeReturn[]>();
  for (const t of trades) {
    const key = `${t.symbol}|${t.regime}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(t);
  }

  const breakdown: ValidationReport['breakdown'] = [];
  for (const [key, arr] of groups) {
    const parts = key.split('|');
    const symbol = parts[0] ?? 'unknown';
    const regime = parts[1] ?? 'unknown';
    const pnl = arr.map((t) => t.pnlPct);
    const sharpe = sharpeRatio(pnl);
    const pVal = bootstrapPValue(pnl);
    const dsr = deflatedSharpeRatio(sharpe, groups.size, arr.length);
    // IR: align benchmark by index (best-effort; full time-alignment is the
    // caller's job — here we just compute over the overlap).
    const ir = benchmarkReturns.length > 0 ? informationRatio(pnl, benchmarkReturns.slice(0, pnl.length)) : 0;
    let verdict: 'edge' | 'no-edge' | 'insufficient';
    if (arr.length < 10) verdict = 'insufficient';
    else if (pVal < edgeConfig.btestAlpha && dsr > 0.5 && sharpe > 0.5 && profitFactor(pnl) > 1.5) verdict = 'edge';
    else verdict = 'no-edge';
    breakdown.push({
      symbol, regime,
      trades: arr.length,
      winRate: arr.filter((t) => t.pnlPct > 0).length / arr.length,
      sharpe, sortino: sortinoRatio(pnl), calmar: calmarRatio(pnl),
      profitFactor: profitFactor(pnl), expectancy: expectancy(pnl),
      maxDrawdownPct: maxDrawdownPct(cumulative(pnl)),
      bootstrapP: pVal, dsr, infoRatio: ir, verdict,
    });
  }

  // Overall.
  const allPnl = trades.map((t) => t.pnlPct);
  const overallSharpe = sharpeRatio(allPnl);
  const overallP = bootstrapPValue(allPnl);
  const overallDSR = deflatedSharpeRatio(overallSharpe, Math.max(1, groups.size), trades.length);
  const benchSlice = benchmarkReturns.slice(0, allPnl.length);
  const overallIR = benchmarkReturns.length > 0
    ? informationRatio(allPnl, benchSlice.length > 0 ? benchSlice : [0])
    : 0;
  let overallVerdict: 'edge' | 'no-edge' | 'insufficient';
  if (trades.length < 30) overallVerdict = 'insufficient';
  else if (overallP < edgeConfig.btestAlpha && overallDSR > 0.5 && overallSharpe > 0.5 && overallIR > 0) overallVerdict = 'edge';
  else overallVerdict = 'no-edge';

  return {
    breakdown,
    overall: {
      trades: trades.length, sharpe: overallSharpe,
      bootstrapP: overallP, dsr: overallDSR, infoRatio: overallIR,
      verdict: overallVerdict,
    },
    walkForward: walkForwardValidation(trades),
    generatedAt: Date.now(),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + safeNum(b, 0), 0) / xs.length;
}
function stdOf(xs: number[], mean: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (safeNum(b, 0) - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, variance));
}
function cumulative(returns: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const r of returns) { acc += safeNum(r, 0); out.push(acc); }
  return out;
}
function blockBootstrapSample(returns: number[], blockSize: number): number[] {
  const n = returns.length;
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(Math.random() * n);
    for (let j = 0; j < blockSize && out.length < n; j++) {
      const v = returns[(start + j) % n];
      out.push(v ?? 0);
    }
  }
  return out;
}
/** Standard normal CDF (Abramowitz & Stegun 26.2.17 approximation). */
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}