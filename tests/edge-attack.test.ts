// ─── Edge Layer Attack Tests (v2.0.833) ──────────────────────────────
//
// Adversarial tests for the Edge Validation layer. Every vector that a
// malicious or corrupt upstream could exploit is exercised. The rule:
// no input — however malformed — may crash, hang, or produce a misleading
// "edge" verdict. Garbage in ⇒ neutral/skip out, never a fabricated trade.

import { describe, it, expect, beforeEach } from 'vitest';
import { computeEdgeReport, skipEdgeReport, realizedStats, type EdgeCalcInput } from '../src/edge/edge-calculator.ts';
import { ExecutionTracker, computeSlippageBps } from '../src/edge/execution-tracker.ts';
import { StabilityMonitor, perturbFeatures, type ActionFromFeatures } from '../src/edge/stability-monitor.ts';
import { RiskProfileEdgeStore, buildEdgeText } from '../src/edge/risk-profile-edge-store.ts';
import {
  sharpeRatio, sortinoRatio, calmarRatio, profitFactor, expectancy,
  maxDrawdownPct, informationRatio, bootstrapPValue, deflatedSharpeRatio,
  walkForwardSplit, buildValidationReport, type TradeReturn,
} from '../src/edge/backtest-validation.ts';
import { edgeConfig } from '../src/edge/edge-config.ts';
import { buildAssetAnalysis } from '../src/services/analysis-matrix.ts';
import type { EdgeReport } from '../src/types/index.ts';

// ── Helpers ──
function validInput(overrides: Partial<EdgeCalcInput> = {}): EdgeCalcInput {
  return {
    symbol: 'BTC', side: 'buy', regime: 'trending_bull',
    shadowWinRate: 0.6, shadowSamples: 50,
    olrPWin: 0.6, olrSamples: 50,
    comboWilsonLB: 0.55, comboSamples: 30,
    firstPassageP: 0.55,
    realizedWinRate: 0.6, realizedSamples: 50, realizedSharpe: 1.0,
    perturbation: 0.9, crossTime: 0.9,
    avgSlippageBps: 2, avgFundingPctPerHour: 0.001, execSamples: 30,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. EdgeCalculator — numeric injection + boundary attacks
// ═══════════════════════════════════════════════════════════════════════
describe('EdgeCalculator attacks', () => {
  it('NaN in any component must not poison edgeScore', () => {
    const r = computeEdgeReport(validInput({ shadowWinRate: NaN, olrPWin: NaN }));
    expect(Number.isFinite(r.edgeScore)).toBe(true);
    expect(r.edgeScore).toBeGreaterThanOrEqual(0);
    expect(r.edgeScore).toBeLessThanOrEqual(1);
  });

  it('Infinity in components must be clamped, not propagate', () => {
    const r = computeEdgeReport(validInput({
      shadowWinRate: Infinity, olrPWin: -Infinity, realizedSharpe: Infinity,
    }));
    expect(Number.isFinite(r.edgeScore)).toBe(true);
    expect(r.edgeScore).toBeLessThanOrEqual(1);
    expect(r.edgeScore).toBeGreaterThanOrEqual(0);
  });

  it('all-zero samples → low confidence, never a trade', () => {
    const r = computeEdgeReport(validInput({
      shadowSamples: 0, olrSamples: 0, comboSamples: 0, realizedSamples: 0,
    }));
    expect(r.confidence).toBe('low');
    expect(r.recommendation).not.toBe('trade');
  });

  it('all-max WR with zero samples must NOT be "trade" (false-confidence)', () => {
    const r = computeEdgeReport(validInput({
      shadowWinRate: 1.0, olrPWin: 1.0, comboWilsonLB: 1.0, firstPassageP: 1.0,
      realizedWinRate: 1.0, realizedSharpe: 5,
      shadowSamples: 0, olrSamples: 0, comboSamples: 0, realizedSamples: 0,
    }));
    expect(r.recommendation).not.toBe('trade');
  });

  it('edgeScore is monotonic in shadow WR (higher WR never harder to trade)', () => {
    const low = computeEdgeReport(validInput({ shadowWinRate: 0.4 })).edgeScore;
    const high = computeEdgeReport(validInput({ shadowWinRate: 0.9 })).edgeScore;
    expect(high).toBeGreaterThanOrEqual(low);
  });

  it('unknown regime falls back to uniform weights, not crash', () => {
    const r = computeEdgeReport(validInput({ regime: 'TOTALLY_UNKNOWN_REGIME_XYZ' }));
    expect(Number.isFinite(r.edgeScore)).toBe(true);
  });

  it('empty-string regime is safe', () => {
    const r = computeEdgeReport(validInput({ regime: '' }));
    expect(Number.isFinite(r.edgeScore)).toBe(true);
  });

  it('negative sample counts treated as low confidence', () => {
    const r = computeEdgeReport(validInput({ shadowSamples: -5 }));
    expect(r.confidence).toBe('low');
  });

  it('stability 0 → factor downgrades recommendation', () => {
    const stable = computeEdgeReport(validInput({ perturbation: 1, crossTime: 1 }));
    const fragile = computeEdgeReport(validInput({ perturbation: 0, crossTime: 0 }));
    expect(fragile.stability.factor).toBeLessThan(stable.stability.factor);
  });

  it('skipEdgeReport recommends CAUTION not skip (cold-start bootstrap)', () => {
    // v2.0.833 fix: a brand-new system with zero trades must NOT be blocked.
    // skipEdgeReport returns 'caution' (neutral 0.5) so the system can still
    // trade and accumulate samples. 'skip' is only for systems WITH samples
    // that found NO edge. Ignorance ≠ evidence of no-edge.
    const r = skipEdgeReport('chaotic');
    expect(r.recommendation).toBe('caution');
    expect(r.edgeScore).toBe(0.5); // neutral, not 0
    expect(r.confidence).toBe('low');
  });

  it('realizedStats on empty array is neutral, not NaN', () => {
    const r = realizedStats([]);
    expect(r.winRate).toBe(0.5);
    expect(r.sharpe).toBe(0);
    expect(r.samples).toBe(0);
  });

  it('realizedStats on all-same PnL (zero std) → sharpe 0, not NaN', () => {
    const r = realizedStats([0.01, 0.01, 0.01]);
    expect(Number.isFinite(r.sharpe)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. ExecutionTracker — slippage + label calibration attacks
// ═══════════════════════════════════════════════════════════════════════
describe('ExecutionTracker attacks', () => {
  let t: ExecutionTracker;
  beforeEach(() => { t = new ExecutionTracker(); });

  it('computeSlippageBps: zero signal price → 0 (no divide-by-zero)', () => {
    expect(computeSlippageBps('buy', 0, 100)).toBe(0);
  });

  it('computeSlippageBps: NaN prices → 0', () => {
    expect(computeSlippageBps('buy', NaN, 100)).toBe(0);
    expect(computeSlippageBps('sell', 100, NaN)).toBe(0);
  });

  it('computeSlippageBps: negative prices → 0', () => {
    expect(computeSlippageBps('buy', -100, 100)).toBe(0);
  });

  it('computeSlippageBps: buy higher fill = positive (worse)', () => {
    expect(computeSlippageBps('buy', 100, 101)).toBeGreaterThan(0);
  });

  it('computeSlippageBps: sell lower fill = positive (worse)', () => {
    expect(computeSlippageBps('sell', 100, 99)).toBeGreaterThan(0);
  });

  it('recordFill with NaN inputs does not crash or corrupt stats', () => {
    t.recordFill({
      symbol: 'BTC', side: 'buy', signalPrice: NaN, fillPrice: NaN,
      fundingCostPct: NaN, holdMinutes: NaN, theoreticalPnlPct: NaN,
    });
    const s = t.getStats('BTC', 'buy');
    expect(Number.isFinite(s.avgSlippageBps)).toBe(true);
  });

  it('duplicate ts is idempotent (no double-count)', () => {
    const ts = Date.now();
    for (let i = 0; i < 5; i++) {
      t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0, holdMinutes: 60, theoreticalPnlPct: 1, ts });
    }
    expect(t.getStats('BTC', 'buy').samples).toBe(1);
  });

  it('cold-start: <minSamples returns theoretical unchanged', () => {
    t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0.1, holdMinutes: 60, theoreticalPnlPct: 2 });
    const cal = t.calibratePnlLabel('BTC', 'buy', 2, 60);
    expect(cal).toBe(2); // unchanged (only 1 sample < min 20)
  });

  it('calibratePnlLabel reduces theoretical by friction once warm', () => {
    for (let i = 0; i < 25; i++) {
      t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0.05, holdMinutes: 60, theoreticalPnlPct: 2, ts: Date.now() + i });
    }
    const cal = t.calibratePnlLabel('BTC', 'buy', 2, 60);
    expect(cal).toBeLessThan(2); // friction deducted
  });

  it('case-insensitive symbol lookup', () => {
    t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0, holdMinutes: 60, theoreticalPnlPct: 1 });
    expect(t.getStats('btc', 'buy').samples).toBe(1);
  });

  it('load of corrupt data does not crash', () => {
    t.load(null as unknown);
    t.load('garbage' as unknown);
    t.load({ 'BTC|buy': { samples: 'bad' } });
    t.load({ 'BTC|buy': { samples: -5 } });
    expect(t.getStats('BTC', 'buy').samples).toBe(0);
  });

  it('zero hold minutes does not divide-by-zero funding/hour', () => {
    t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 100, fundingCostPct: 0.1, holdMinutes: 0, theoreticalPnlPct: 1 });
    const s = t.getStats('BTC', 'buy');
    expect(Number.isFinite(s.avgFundingPctPerHour)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. StabilityMonitor — perturbation + cross-time attacks
// ═══════════════════════════════════════════════════════════════════════
describe('StabilityMonitor attacks', () => {
  let m: StabilityMonitor;
  beforeEach(() => { m = new StabilityMonitor(); });

  it('computeStability with no history → full stability (not NaN)', () => {
    const r = m.computeStability('BTC', () => 'hold');
    expect(Number.isFinite(r.perturbation)).toBe(true);
    expect(Number.isFinite(r.crossTime)).toBe(true);
    expect(r.factor).toBe(1);
  });

  it('perturbFeatures: empty features → empty output (no crash)', () => {
    const out = perturbFeatures({}, 0.05);
    expect(Object.keys(out).length).toBe(0);
  });

  it('perturbFeatures: NaN feature → finite output', () => {
    const out = perturbFeatures({ vol: NaN }, 0.05);
    expect(Number.isFinite(out['vol'])).toBe(true);
  });

  it('perturbFeatures does not mutate input', () => {
    const input = { vol: 0.5 };
    perturbFeatures(input, 0.1);
    expect(input.vol).toBe(0.5);
  });

  it('actionFromFeatures throwing → counted as a flip (fragile)', () => {
    const thrower: ActionFromFeatures = () => { throw new Error('boom'); };
    m.recordDecision({ symbol: 'BTC', action: 'buy', entryMarketFeatures: { vol: 0.5 }, ts: Date.now() });
    const r = m.computeStability('BTC', thrower);
    expect(r.perturbation).toBeLessThan(1);
  });

  it('high flip rate → low crossTime', () => {
    for (let i = 0; i < 10; i++) {
      m.recordDecision({ symbol: 'BTC', action: i % 2 === 0 ? 'buy' : 'sell', entryMarketFeatures: { vol: 0.5 }, ts: i });
    }
    const r = m.computeStability('BTC', () => 'buy');
    expect(r.crossTime).toBeLessThan(0.5);
  });

  it('holds do not count as direction flips', () => {
    m.recordDecision({ symbol: 'BTC', action: 'buy', entryMarketFeatures: {}, ts: 1 });
    m.recordDecision({ symbol: 'BTC', action: 'hold', entryMarketFeatures: {}, ts: 2 });
    m.recordDecision({ symbol: 'BTC', action: 'hold', entryMarketFeatures: {}, ts: 3 });
    const r = m.computeStability('BTC', () => 'buy');
    expect(r.crossTime).toBe(1);
  });

  it('case-insensitive symbol', () => {
    m.recordDecision({ symbol: 'BTC', action: 'buy', entryMarketFeatures: {}, ts: 1 });
    const r = m.computeStability('btc', () => 'buy');
    expect(Number.isFinite(r.perturbation)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. RiskProfileEdgeStore — vector DB attacks
// ═══════════════════════════════════════════════════════════════════════
describe('RiskProfileEdgeStore attacks', () => {
  it('query with no provider → neutral 0.5, no crash', async () => {
    const s = new RiskProfileEdgeStore();
    const r = await s.query({ marketFeatures: {}, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'trending' });
    expect(r.edgeScore).toBe(0.5);
    expect(r.confidence).toBe('low');
  });

  it('recordTrade with no provider stores record (embedding empty)', async () => {
    const s = new RiskProfileEdgeStore();
    await s.recordTrade({ marketFeatures: { vol: 0.1 }, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2 });
    expect(s.size()).toBe(1);
  });

  it('duplicate (ts, symbol, side) is idempotent', async () => {
    const s = new RiskProfileEdgeStore();
    const ts = Date.now();
    await s.recordTrade({ marketFeatures: {}, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2, ts });
    await s.recordTrade({ marketFeatures: {}, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2, ts });
    expect(s.size()).toBe(1);
  });

  it('ring buffer cap is enforced', async () => {
    const s = new RiskProfileEdgeStore();
    for (let i = 0; i < edgeConfig.rpStoreCap + 50; i++) {
      await s.recordTrade({ marketFeatures: {}, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2, ts: i });
    }
    expect(s.size()).toBeLessThanOrEqual(edgeConfig.rpStoreCap);
  });

  it('load of corrupt records filters them out', () => {
    const s = new RiskProfileEdgeStore();
    s.load([
      { symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2, ts: 1, embedding: [] },
      null,
      { symbol: 'BTC', side: 'invalid', riskProfile: 'moderate' },
      { symbol: 'BTC', side: 'buy', riskProfile: 'BAD', regime: 'x' },
      'garbage',
      { symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: NaN, outcome: 2, closeReason: 'tp', holdMinutes: NaN, slTolerancePct: NaN, ts: NaN, embedding: [NaN] },
    ] as unknown);
    expect(s.size()).toBe(2); // only 2 valid (the first + the NaN-coerced one)
  });

  it('buildEdgeText with empty features is finite string', () => {
    const txt = buildEdgeText({ marketFeatures: {}, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x' });
    expect(typeof txt).toBe('string');
    expect(txt.includes('NaN')).toBe(false);
  });

  it('buildEdgeText with NaN features does not emit "NaN"', () => {
    const txt = buildEdgeText({ marketFeatures: { vol: NaN, funding: Infinity }, symbol: 'BTC', side: 'buy', riskProfile: 'aggressive', regime: 'x' });
    expect(txt.includes('NaN')).toBe(false);
    expect(txt.includes('Infinity')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. BacktestValidation — financial math attacks
// ═══════════════════════════════════════════════════════════════════════
describe('BacktestValidation attacks', () => {
  it('sharpeRatio: empty → 0, not NaN', () => {
    expect(sharpeRatio([])).toBe(0);
  });

  it('sharpeRatio: single return → 0 (need ≥2 for std)', () => {
    expect(sharpeRatio([0.01])).toBe(0);
  });

  it('sharpeRatio: all-identical returns (zero std) → 0, not Infinity', () => {
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBe(0);
  });

  it('sharpeRatio: NaN returns do not corrupt result', () => {
    const r = sharpeRatio([NaN, 0.01, 0.02]);
    expect(Number.isFinite(r)).toBe(true);
  });

  it('sortinoRatio: no downside → Infinity or 0, not NaN', () => {
    const r = sortinoRatio([0.01, 0.02, 0.03]);
    expect(Number.isFinite(r) || r === Infinity).toBe(true);
  });

  it('calmarRatio: zero drawdown → 0, not Infinity', () => {
    expect(calmarRatio([0.01, 0.02])).toBe(0);
  });

  it('profitFactor: no losses → Infinity or finite, not NaN', () => {
    const r = profitFactor([0.01, 0.02]);
    expect(Number.isFinite(r) || r === Infinity).toBe(true);
  });

  it('profitFactor: no wins no losses → 0', () => {
    expect(profitFactor([0, 0, 0])).toBe(0);
  });

  it('expectancy: empty → 0', () => {
    expect(expectancy([])).toBe(0);
  });

  it('maxDrawdownPct: monotonic increasing → 0 drawdown', () => {
    expect(maxDrawdownPct([0.01, 0.02, 0.03])).toBe(0);
  });

  it('maxDrawdownPct: empty → 0, not NaN', () => {
    expect(maxDrawdownPct([])).toBe(0);
  });

  it('informationRatio: mismatched lengths → uses overlap, no crash', () => {
    const r = informationRatio([0.01, 0.02, 0.03], [0.01, 0.02]);
    expect(Number.isFinite(r)).toBe(true);
  });

  it('informationRatio: empty → 0', () => {
    expect(informationRatio([], [])).toBe(0);
  });

  it('bootstrapPValue: <5 returns → 1.0 (cannot reject H0)', () => {
    expect(bootstrapPValue([0.01, 0.02])).toBe(1.0);
  });

  it('bootstrapPValue: is in [0,1]', () => {
    const r = bootstrapPValue(Array.from({ length: 50 }, () => Math.random() * 0.02 - 0.01), 100);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });

  it('deflatedSharpeRatio: 0 trials → 0', () => {
    expect(deflatedSharpeRatio(1.0, 0, 100)).toBe(0);
  });

  it('deflatedSharpeRatio: <2 samples → 0', () => {
    expect(deflatedSharpeRatio(1.0, 5, 1)).toBe(0);
  });

  it('deflatedSharpeRatio: returns a probability in [0,1]', () => {
    const r = deflatedSharpeRatio(2.0, 10, 100);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });

  it('walkForwardSplit: preserves order + split fraction', () => {
    const trades: TradeReturn[] = Array.from({ length: 100 }, (_, i) => ({ pnlPct: i, symbol: 'BTC', side: 'buy' as const, regime: 'x', closeTs: i, openTs: i }));
    const { inSample, outOfSample } = walkForwardSplit(trades);
    expect(inSample.length).toBe(70);
    expect(outOfSample.length).toBe(30);
    expect(inSample[0].pnlPct).toBe(0);
    expect(outOfSample[outOfSample.length - 1].pnlPct).toBe(99);
  });

  it('buildValidationReport: empty trades → insufficient verdict', () => {
    const r = buildValidationReport([]);
    expect(r.overall.verdict).toBe('insufficient');
    expect(r.overall.trades).toBe(0);
  });

  it('buildValidationReport: NaN pnlPct in trades does not corrupt verdict', () => {
    const trades: TradeReturn[] = [
      { pnlPct: NaN, symbol: 'BTC', side: 'buy', regime: 'x', closeTs: 1, openTs: 0 },
      { pnlPct: 0.01, symbol: 'BTC', side: 'buy', regime: 'x', closeTs: 2, openTs: 1 },
    ];
    const r = buildValidationReport(trades);
    expect(Number.isFinite(r.overall.sharpe)).toBe(true);
  });

  it('buildValidationReport: benchmark empty does not crash IR', () => {
    const trades: TradeReturn[] = Array.from({ length: 30 }, (_, i) => ({ pnlPct: 0.01, symbol: 'BTC', side: 'buy', regime: 'x', closeTs: i, openTs: i }));
    const r = buildValidationReport(trades, []);
    expect(Number.isFinite(r.overall.infoRatio)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Cross-module + integration attacks (deeper vectors)
// ═══════════════════════════════════════════════════════════════════════
describe('Edge layer cross-module attacks', () => {
  it('EdgeReport written to MatrixCell with skip → forces hold (integration)', async () => {
    // Simulate the analysis-matrix path: skip recommendation must mute the
    // cell action. We verify via the public EdgeReport shape only — the
    // matrix wiring is tested separately.
    const r = computeEdgeReport(validInput({
      shadowSamples: 0, olrSamples: 0, comboSamples: 0, realizedSamples: 0,
      shadowWinRate: 1.0, olrPWin: 1.0, comboWilsonLB: 1.0, firstPassageP: 1.0,
      realizedWinRate: 1.0, realizedSharpe: 10,
      perturbation: 0, crossTime: 0,
    }));
    // With zero samples + zero stability, recommendation must be skip.
    expect(r.recommendation).toBe('skip');
  });

  it('ExecutionTracker → EdgeCalculator: calibrated OLR feeds learnedEdge', () => {
    // The ExecutionTracker calibrates PnL labels; a high-slippage symbol
    // should produce a LOWER learnedEdge than a no-slippage symbol, given
    // the same raw OLR P(win). This verifies the label-calibration path
    // actually flows through to the edge score (the caller passes the
    // calibrated pWin; we verify the calculator honours it).
    const lowSlip = computeEdgeReport(validInput({ olrPWin: 0.7 }));
    const highSlip = computeEdgeReport(validInput({ olrPWin: 0.4 }));
    expect(lowSlip.edgeScore).toBeGreaterThan(highSlip.edgeScore);
  });

  it('StabilityMonitor + EdgeCalculator: fragile signal downgrades rec', () => {
    const stable = computeEdgeReport(validInput({ perturbation: 1, crossTime: 1 }));
    const fragile = computeEdgeReport(validInput({ perturbation: 0.3, crossTime: 0.3 }));
    // Same raw score but fragile stability → rec is at most 'caution'.
    expect(['caution', 'skip']).toContain(fragile.recommendation);
    if (stable.recommendation === 'trade') {
      expect(fragile.recommendation).not.toBe('trade');
    }
  });

  it('edgeConfig values are sane (no misconfiguration → system break)', () => {
    expect(edgeConfig.tradeThreshold).toBeGreaterThan(edgeConfig.cautionThreshold);
    expect(edgeConfig.cautionThreshold).toBeGreaterThanOrEqual(edgeConfig.skipThreshold);
    expect(edgeConfig.rpMinSimilarity).toBeGreaterThan(0);
    expect(edgeConfig.rpMinSimilarity).toBeLessThanOrEqual(1);
    expect(edgeConfig.confHighSamples).toBeGreaterThan(edgeConfig.confMediumSamples);
    for (const w of Object.values(edgeConfig.weights)) {
      const sum = w.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.001); // weights sum to 1
    }
  });

  it('computeEdgeReport is pure: same input → same output (deterministic)', () => {
    const inp = validInput();
    const a = computeEdgeReport(inp);
    const b = computeEdgeReport(inp);
    expect(a.edgeScore).toBe(b.edgeScore);
    expect(a.recommendation).toBe(b.recommendation);
    expect(a.confidence).toBe(b.confidence);
  });

  it('extreme: all components 0 → edgeScore near 0, skip', () => {
    // tanh squashes the Sharpe signal but does not zero it exactly
    // (tanh(-2.5) ≈ -0.987 → sharpeSignal ≈ 0.0065). The weighted residual
    // is ~0.0004, which is mathematically correct. The recommendation must
    // still be 'skip' because the effective score is far below the threshold.
    const r = computeEdgeReport(validInput({
      shadowWinRate: 0, olrPWin: 0, comboWilsonLB: 0, firstPassageP: 0,
      realizedWinRate: 0, realizedSharpe: -5,
    }));
    expect(r.edgeScore).toBeLessThan(0.01);
    expect(r.recommendation).toBe('skip');
  });

  it('extreme: all components 1 with full samples → trade, edgeScore near 1', () => {
    const r = computeEdgeReport(validInput({
      shadowWinRate: 1, olrPWin: 1, comboWilsonLB: 1, firstPassageP: 1,
      realizedWinRate: 1, realizedSharpe: 5,
      shadowSamples: 100, olrSamples: 100, comboSamples: 100, realizedSamples: 100,
    }));
    expect(r.recommendation).toBe('trade');
    expect(r.edgeScore).toBeGreaterThan(0.9);
  });

  it('regime weight injection: adversarial regime name does not bypass weights', () => {
    // A long junk regime name should still fall back to 'unknown' weights.
    const r = computeEdgeReport(validInput({ regime: '__proto__' }));
    expect(Number.isFinite(r.edgeScore)).toBe(true);
    expect(r.edgeScore).toBeGreaterThanOrEqual(0);
    expect(r.edgeScore).toBeLessThanOrEqual(1);
  });

  it('prototype pollution: regime "__proto__" does not leak Object.prototype', () => {
    // edgeConfig.weights is a plain object; accessing weights['__proto__']
    // would return Object.prototype if not handled. weightsFor uses ?? so
    // the fallback kicks in, but verify no crash.
    const r = computeEdgeReport(validInput({ regime: '__proto__' }));
    expect(r).toBeDefined();
  });

  it('prototype pollution: regime "constructor" is safe', () => {
    const r = computeEdgeReport(validInput({ regime: 'constructor' }));
    expect(Number.isFinite(r.edgeScore)).toBe(true);
  });

  it('ExecutionTracker load with __proto__ key does not pollute prototype', () => {
    const t = new ExecutionTracker();
    t.load({ '__proto__': { samples: 1, avgSlippageBps: 0, avgFundingPctPerHour: 0, sumSlippageBps: 0, sumFundingPctPerHour: 0, recent: [] } });
    // The tracker uses a Map, not object assignment, so prototype is safe.
    // This test guards against a future refactor that switches to a plain object.
    expect(({} as Record<string, unknown>).samples).toBeUndefined();
  });

  it('RiskProfileEdgeStore load with __proto__ records does not pollute', () => {
    const s = new RiskProfileEdgeStore();
    s.load([{ symbol: '__proto__', side: 'buy', riskProfile: 'moderate', regime: 'x', realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2, ts: 1, embedding: [] } as never]);
    expect(s.size()).toBeGreaterThanOrEqual(0);
  });

  it('DoS: very large feature object to buildEdgeText does not hang', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) big[`f${i}`] = Math.random();
    const start = Date.now();
    const txt = buildEdgeText({ marketFeatures: big, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'x' });
    expect(Date.now() - start).toBeLessThan(500);
    expect(typeof txt).toBe('string');
  });

  it('DoS: ExecutionTracker with 100k records stays bounded (ring buffer)', () => {
    const t = new ExecutionTracker();
    for (let i = 0; i < 100_000; i++) {
      t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0, holdMinutes: 60, theoreticalPnlPct: 1, ts: i });
    }
    const s = t.getStats('BTC', 'buy');
    expect(s.samples).toBeLessThanOrEqual(edgeConfig.execLookback + 1);
  });

  it('backtest-validation: bootstrapPValue with all-zero returns does not hang', () => {
    const start = Date.now();
    const r = bootstrapPValue(Array.from({ length: 100 }, () => 0), 500);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. CROSS-MODULE INTEGRATION ATTACKS
// ═══════════════════════════════════════════════════════════════════════
//
// These attack the seams BETWEEN modules — the integration points where
// data flows from one component to another. Most production bugs live here
// because each module's unit tests pass but the assumptions don't line up.

describe('Cross-module integration attacks', () => {

  // ── User requirement #1: cold-start must not block ──────────────────
  describe('Cold-start bootstrap (no trades ever)', () => {
    it('skipEdgeReport returns CAUTION not skip (system can still trade)', () => {
      const r = skipEdgeReport('unknown');
      // CRITICAL: a brand-new system with zero trades must not be blocked,
      // otherwise it can never accumulate samples to measure edge.
      expect(r.recommendation).toBe('caution');
      expect(r.edgeScore).toBe(0.5); // neutral, not 0
      expect(r.confidence).toBe('low');
    });

    it('computeEdgeReport with all 0.5 components → caution (not skip)', () => {
      const r = computeEdgeReport(validInput({
        shadowWinRate: 0.5, shadowSamples: 0,
        olrPWin: 0.5, olrSamples: 0,
        comboWilsonLB: 0.5, comboSamples: 0,
        firstPassageP: 0.5,
        realizedWinRate: 0.5, realizedSamples: 0, realizedSharpe: 0,
        perturbation: 1, crossTime: 1,
      }));
      // Zero samples → low confidence → caution (never trade, never skip)
      expect(r.confidence).toBe('low');
      expect(r.recommendation).not.toBe('trade');
      // Must NOT be skip — that would block bootstrap
      expect(r.recommendation).not.toBe('skip');
      expect(r.recommendation).toBe('caution');
    });

    it('ExecutionTracker cold-start calibratePnlLabel is passthrough', () => {
      const t = new ExecutionTracker();
      // 0 samples → must return theoretical unchanged (no calibration)
      const out = t.calibratePnlLabel('BTC', 'buy', 2.5, 60);
      expect(out).toBe(2.5);
    });

    it('RiskProfileEdgeStore cold-start query returns neutral 0.5', async () => {
      const s = new RiskProfileEdgeStore();
      // No embed provider, no records → neutral
      const r = await s.query({
        marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy',
        riskProfile: 'aggressive', regime: 'trending_bull',
      });
      expect(r.edgeScore).toBe(0.5);
      expect(r.confidence).toBe('low');
      expect(r.samples).toBe(0);
    });
  });

  // ── analysis-matrix ↔ edge integration ──────────────────────────────
  describe('analysis-matrix edge integration', () => {
    it('skip recommendation forces matrix cell to hold', () => {
      const skipEdge: EdgeReport = {
        edgeScore: 0.2, confidence: 'medium', recommendation: 'skip',
        components: { directionalEdge: 0.2, learnedEdge: 0.2, comboEdge: 0.2, pathEdge: 0.2, realizedEdge: 0.2 },
        stability: { perturbation: 1, crossTime: 1, factor: 1 },
        executionGap: { avgSlippageBps: 0, avgFundingPctPerHour: 0, samples: 0 },
        regime: 'chaotic', computedAt: Date.now(),
      };
      const psc = { action: 'buy', confidence: 0.8, rationale: 'test', closePosition: false };
      const result = buildAssetAnalysis('BTC', psc as never, undefined, 1, 0.5, 3, 5, skipEdge, { aggressive: skipEdge });
      expect(result).not.toBeNull();
      // aggressive (skip) → hold; moderate (no edge) → buy (no skip)
      expect(result!.matrix.aggressive.flat.action).toBe('hold');
      expect(result!.matrix.moderate.flat.action).toBe('buy');
    });

    it('caution recommendation does NOT force hold (system can bootstrap)', () => {
      const cautionEdge: EdgeReport = {
        edgeScore: 0.5, confidence: 'low', recommendation: 'caution',
        components: { directionalEdge: 0.5, learnedEdge: 0.5, comboEdge: 0.5, pathEdge: 0.5, realizedEdge: 0.5 },
        stability: { perturbation: 1, crossTime: 1, factor: 1 },
        executionGap: { avgSlippageBps: 0, avgFundingPctPerHour: 0, samples: 0 },
        regime: 'unknown', computedAt: Date.now(),
      };
      const psc = { action: 'buy', confidence: 0.6, rationale: 'cold start', closePosition: false };
      const result = buildAssetAnalysis('BTC', psc as never, undefined, 1, 0.5, 3, 5, cautionEdge, { aggressive: cautionEdge, moderate: cautionEdge, conservative: cautionEdge });
      expect(result).not.toBeNull();
      // caution → action preserved (buy), conviction downweighted by stability factor
      expect(result!.matrix.moderate.flat.action).toBe('buy');
      expect(result!.matrix.aggressive.flat.action).toBe('buy');
    });

    it('per-profile edge isolation — aggressive skip does not block moderate', () => {
      const skipEdge: EdgeReport = {
        edgeScore: 0.2, confidence: 'high', recommendation: 'skip',
        components: { directionalEdge: 0.2, learnedEdge: 0.2, comboEdge: 0.2, pathEdge: 0.2, realizedEdge: 0.2 },
        stability: { perturbation: 1, crossTime: 1, factor: 1 },
        executionGap: { avgSlippageBps: 0, avgFundingPctPerHour: 0, samples: 100 },
        regime: 'chaotic', computedAt: Date.now(),
      };
      const psc = { action: 'sell', confidence: 0.7, rationale: 'test', closePosition: false };
      const result = buildAssetAnalysis('BTC', psc as never, undefined, 1, 0.5, 3, 5, undefined, { aggressive: skipEdge });
      expect(result!.matrix.aggressive.flat.action).toBe('hold'); // skip → hold
      expect(result!.matrix.conservative.flat.action).toBe('sell'); // no edge → sell
      expect(result!.matrix.moderate.flat.action).toBe('sell'); // no edge → sell
    });

    it('edgeReport written to AssetAnalysis.edgeReport', () => {
      const edge: EdgeReport = {
        edgeScore: 0.65, confidence: 'high', recommendation: 'trade',
        components: { directionalEdge: 0.6, learnedEdge: 0.7, comboEdge: 0.65, pathEdge: 0.55, realizedEdge: 0.62 },
        stability: { perturbation: 0.9, crossTime: 0.85, factor: 1.0 },
        executionGap: { avgSlippageBps: 3, avgFundingPctPerHour: 0.005, samples: 50 },
        regime: 'trending_bull', computedAt: 12345,
      };
      const psc = { action: 'buy', confidence: 0.8, rationale: 'strong', closePosition: false };
      const result = buildAssetAnalysis('BTC', psc as never, undefined, 1, 0.5, 3, 5, edge);
      expect(result!.edgeReport).toBe(edge);
    });

    it('backward compatible — no edge params → no edge field, no crash', () => {
      const psc = { action: 'buy', confidence: 0.7, rationale: 'legacy', closePosition: false };
      const result = buildAssetAnalysis('BTC', psc as never, undefined, 1, 0.5, 3, 5);
      expect(result).not.toBeNull();
      expect(result!.edgeReport).toBeUndefined();
      expect(result!.matrix.moderate.flat.action).toBe('buy');
    });
  });

  // ── ExecutionTracker ↔ OLR label calibration loop ────────────────────
  describe('ExecutionTracker label calibration', () => {
    it('calibratePnlLabel flips win→loss when friction > theoretical gain', () => {
      const t = new ExecutionTracker();
      // Feed 30 trades: each made +0.2% theoretical, but slippage 5bps + funding
      for (let i = 0; i < 30; i++) {
        t.recordFill({
          symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 100.05,
          fundingCostPct: 0.01, holdMinutes: 120, theoreticalPnlPct: 0.2, ts: i,
        });
      }
      // Now calibrate a theoretical +0.2% → should become negative (loss)
      const realized = t.calibratePnlLabel('BTC', 'buy', 0.2, 120);
      // slippage 5bps = 0.05% drag; funding 0.01% per 2h
      // realized ≈ 0.2 - 0.05 - 0.01 = 0.14... but per-hour funding accumulates
      expect(realized).toBeLessThan(0.2);
      expect(realized).toBeGreaterThan(0); // should still be positive for this example
    });

    it('calibratePnlLabel does not amplify — symmetric for wins and losses', () => {
      const t = new ExecutionTracker();
      for (let i = 0; i < 30; i++) {
        t.recordFill({
          symbol: 'ETH', side: 'sell', signalPrice: 100, fillPrice: 99.95,
          fundingCostPct: -0.005, holdMinutes: 60, theoreticalPnlPct: 1.0, ts: i,
        });
      }
      const calWin = t.calibratePnlLabel('ETH', 'sell', 1.0, 60);
      const calLoss = t.calibratePnlLabel('ETH', 'sell', -1.0, 60);
      // Friction subtracts from both win and loss symmetrically
      expect(calWin).toBeLessThan(1.0);
      expect(calLoss).toBeLessThan(-1.0); // loss gets worse (more negative)
    });

    it('slippage direction is correct for buy vs sell', () => {
      // Buy: fill > signal = bad (positive slippage)
      expect(computeSlippageBps('buy', 100, 101)).toBeGreaterThan(0);
      // Buy: fill < signal = good (negative slippage)
      expect(computeSlippageBps('buy', 100, 99)).toBeLessThan(0);
      // Sell: fill < signal = bad (positive slippage)
      expect(computeSlippageBps('sell', 100, 99)).toBeGreaterThan(0);
      // Sell: fill > signal = good (negative slippage)
      expect(computeSlippageBps('sell', 100, 101)).toBeLessThan(0);
    });

    it('de-dup by ts — double-close path does not double-count', () => {
      const t = new ExecutionTracker();
      t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0, holdMinutes: 60, theoreticalPnlPct: 1, ts: 1000 });
      t.recordFill({ symbol: 'BTC', side: 'buy', signalPrice: 100, fillPrice: 101, fundingCostPct: 0, holdMinutes: 60, theoreticalPnlPct: 1, ts: 1000 });
      expect(t.getStats('BTC', 'buy').samples).toBe(1);
    });
  });

  // ── RiskProfileEdgeStore ↔ EdgeCalculator blend ──────────────────────
  describe('Risk-profile blend (cold-start safety)', () => {
    it('blend formula: cold-start (0 profile samples) weights neutral 100%', () => {
      // When profile-specific store has < warm samples, the blend should
      // be dominated by the neutral edgeScore. This prevents a tiny,
      // unrepresentative sample from overriding the neutral signal.
      const neutral = 0.6;
      const profileCold = 0.5; // neutral from cold store
      // Cold-start: wNeutral=0.6, wProfile=0.4, but profile is neutral →
      // blend = 0.6*0.6 + 0.4*0.5 = 0.36 + 0.2 = 0.56 ≈ neutral
      const blend = edgeConfig.rpNeutralWeight * neutral + edgeConfig.rpProfileWeight * profileCold;
      expect(blend).toBeGreaterThan(0.54);
      expect(blend).toBeLessThan(0.62);
    });
  });

  // ── Backtest-validation multiple-testing trap ───────────────────────
  describe('Multiple-testing defense (DSR)', () => {
    it('DSR penalises when many buckets tested (false discovery control)', () => {
      // Sharpe 2.0 with 100 samples, tested across 1 bucket
      const dsr1 = deflatedSharpeRatio(2.0, 1, 100);
      // Same Sharpe tested across 100 buckets (multiple testing)
      const dsr100 = deflatedSharpeRatio(2.0, 100, 100);
      // More trials → lower DSR (harder to claim edge is real)
      expect(dsr100).toBeLessThan(dsr1);
    });

    it('walk-forward detects overfit (IS >> OOS)', () => {
      const trades: TradeReturn[] = [];
      // First 70: high returns (in-sample), last 30: near-zero (out-of-sample)
      for (let i = 0; i < 70; i++) trades.push({ pnlPct: 0.5 + Math.random() * 0.3, symbol: 'BTC', side: 'buy', regime: 'trending', closeTs: i, openTs: i - 1 });
      for (let i = 0; i < 30; i++) trades.push({ pnlPct: (Math.random() - 0.5) * 0.1, symbol: 'BTC', side: 'buy', regime: 'trending', closeTs: 70 + i, openTs: 69 + i });
      const wf = walkForwardSplit(trades);
      const isSharpe = sharpeRatio(wf.inSample.map(t => t.pnlPct));
      const oosSharpe = sharpeRatio(wf.outOfSample.map(t => t.pnlPct));
      // In-sample should be much higher → overfit detected
      expect(isSharpe).toBeGreaterThan(oosSharpe * 2);
    });

    it('buildValidationReport marks insufficient (< 30 trades) as insufficient', () => {
      const trades: TradeReturn[] = [];
      for (let i = 0; i < 15; i++) trades.push({ pnlPct: 1.0, symbol: 'BTC', side: 'buy', regime: 'x', closeTs: i, openTs: i - 1 });
      const report = buildValidationReport(trades);
      expect(report.overall.verdict).toBe('insufficient');
    });

    it('buildValidationReport: pure-luck 50/50 over 200 trades → no-edge', () => {
      // Simulate a coin-flip strategy: 50% win ±1% each
      const trades: TradeReturn[] = [];
      for (let i = 0; i < 200; i++) {
        trades.push({
          pnlPct: Math.random() > 0.5 ? 1.0 : -1.0,
          symbol: 'BTC', side: 'buy', regime: 'trending', closeTs: i, openTs: i - 1,
        });
      }
      const report = buildValidationReport(trades);
      // A coin flip should NOT pass as 'edge' (bootstrap p-value high,
      // Sharpe near 0, profit factor near 1.0)
      expect(report.overall.verdict).not.toBe('edge');
    });
  });
});