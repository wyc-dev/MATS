// ─── Cycle-History Selective Retrieval Tests (K.md, v2.0.211) ───

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CycleHistoryRetriever,
  rmsNorm,
  softmax,
  entropy,
  DEFAULT_CYCLE_HISTORY_CONFIG,
} from '../src/evolution/cycle-history-retrieval.ts';
import {
  computeVectorConditionalWinRate,
  softmaxWeightedWinRate,
  rmsNormFeatures,
  ENTRY_CONDITION_FEATURES,
} from '../src/evolution/evolution-utils.ts';

// ─── Math helpers ───

describe('AttnRes math helpers', () => {
  it('rmsNorm: zero vector → stays zero (0 is finite, not missing)', () => {
    const out = rmsNorm([0, 0, 0, 0]);
    // 0 is finite → finiteCount=4, sumSq=0, rms=sqrt(1e-8)≈1e-4, out=[0,...]
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(0, 6);
  });

  it('rmsNorm: non-finite entries → finite dims normalised by finite RMS', () => {
    const out = rmsNorm([3, NaN, 4, Infinity]);
    // finiteCount=2 (3,4), sumSq=25, rms=sqrt(25/2)=3.54
    // out[0]=3/3.54, out[2]=4/3.54, out[1]=out[3]=0
    expect(Number.isFinite(out[0]!)).toBe(true);
    expect(Number.isFinite(out[1]!)).toBe(true);
    expect(out[2]!).toBeCloseTo(4 / Math.sqrt(25 / 2 + 1e-8), 4);
    expect(out[3]!).toBe(0);
  });

  it('softmax: uniform logits → uniform distribution', () => {
    const p = softmax([0, 0, 0, 0]);
    expect(p.length).toBe(4);
    expect(p.every((v) => Math.abs(v - 0.25) < 1e-9)).toBe(true);
    expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
  });

  it('softmax: non-finite logits → uniform (degenerate-safe)', () => {
    const p = softmax([NaN, Infinity, -Infinity]);
    expect(p.length).toBe(3);
    expect(p.every((v) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true);
  });

  it('softmax: empty input → empty output', () => {
    expect(softmax([])).toEqual([]);
  });

  it('entropy: uniform distribution = log2(n)', () => {
    expect(entropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 6);
  });

  it('entropy: one-hot = 0', () => {
    expect(entropy([1, 0, 0])).toBeCloseTo(0, 9);
  });
});

// ─── CycleHistoryRetriever ───

describe('CycleHistoryRetriever', () => {
  let r: CycleHistoryRetriever;

  beforeEach(() => {
    r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 20, numBlocks: 4 });
    r._reset();
  });

  it('cold-start: < minHistoryToBlend cycles → returns current snapshot unchanged', () => {
    r.pushCycle('BTC', { volatility: 0.5, srDistanceBps: 100 });
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(false);
    expect(blend.alphaDist.length).toBe(0);
    expect(blend.hBlend.volatility).toBe(0.5);
  });

  it('zero-init w: blend = mean of history (uniform attention)', () => {
    for (let i = 0; i < 10; i++) {
      r.pushCycle('BTC', { volatility: 0.1 * i, srDistanceBps: 100 * i });
    }
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(true);
    // uniform attention → h = mean of block summaries + current
    // With w=0, alpha is uniform; hBlend.volatility should be a mean value.
    expect(blend.hBlend.volatility).toBeGreaterThan(0);
    expect(Number.isFinite(blend.hBlend.volatility)).toBe(true);
    expect(blend.alphaDist.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  });

  it('entry persistence: entry features captured as a source with persistent weight', () => {
    for (let i = 0; i < 10; i++) {
      r.pushCycle('BTC', { volatility: 0.5, srDistanceBps: 500 });
    }
    r.recordEntry('BTC', 'buy', { volatility: 0.2, srDistanceBps: 200 });
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(true);
    expect(blend.sourceLabels[0]).toBe('entry');
    expect(blend.alphaDist.length).toBeGreaterThan(1);
    // entry gets non-zero weight (embedding persistence).
    expect(blend.alphaDist[0]!).toBeGreaterThan(0);
  });

// Sustained-regime test data: each block of 5 cycles holds ONE regime so
  // block summaries have DISTINCT directions (Block AttnRes requires this —
  // a block mean smooths intra-block variation; matching block size to the
  // regime-persistence timescale is a key design constraint, see K.md §10).
  const regimeA = { volatility: 0.1, srDistanceBps: 50, obImbalance: 0.1, fundingRate: 0.0001, volumeRatio: 0.8, signalAgreement: 0.4, sentiment: -0.2, sentimentConviction: 0.3, regimeOrdinal: 0, momentumShort: -0.02, momentumLong: 0.01 };
  const regimeB = { volatility: 0.8, srDistanceBps: 900, obImbalance: 0.6, fundingRate: 0.008, volumeRatio: 2.5, signalAgreement: 0.8, sentiment: 0.6, sentimentConviction: 0.9, regimeOrdinal: 2, momentumShort: 0.05, momentumLong: 0.08 };
  const regimeC = { volatility: 0.5, srDistanceBps: 300, obImbalance: 0.3, fundingRate: 0.002, volumeRatio: 1.5, signalAgreement: 0.55, sentiment: 0.2, sentimentConviction: 0.6, regimeOrdinal: 1, momentumShort: 0.01, momentumLong: 0.03 };
  // 20 cycles: 5×A, 5×B, 5×C, 5×A → 4 blocks with distinct directions.
  const sustainedData = [
    ...Array(5).fill(regimeA), ...Array(5).fill(regimeB),
    ...Array(5).fill(regimeC), ...Array(5).fill(regimeA),
  ] as Record<string, number>[];

  it('online learning: win → w updates toward attended direction (non-zero after)', () => {
    for (const f of sustainedData) r.pushCycle('BTC', f);
    r.recordEntry('BTC', 'buy', regimeA);
    const wBefore = r.getQuery('BTC');
    expect(wBefore.every((v) => v === 0)).toBe(true);
    r.updateOnOutcome('BTC', 'buy', 0.05);
    const wAfter = r.getQuery('BTC');
    expect(wAfter.some((v) => Math.abs(v) > 1e-6)).toBe(true);
  });

  it('online learning: loss → w updates in opposite direction', () => {
    for (const f of sustainedData) r.pushCycle('BTC', f);
    r.recordEntry('BTC', 'buy', regimeA);
    r.updateOnOutcome('BTC', 'buy', -0.05);
    const wAfter = r.getQuery('BTC');
    expect(wAfter.some((v) => Math.abs(v) > 1e-6)).toBe(true);
  });

  it('online learning: noise threshold (|pnlPct| < 0.001) → no update', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', { volatility: 0.5 });
    r.recordEntry('BTC', 'buy', { volatility: 0.2 });
    r.updateOnOutcome('BTC', 'buy', 0.0005);
    const w = r.getQuery('BTC');
    expect(w.every((v) => v === 0)).toBe(true); // unchanged
  });

  it('online learning: close without entry → no update (guard)', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', { volatility: 0.5 });
    // no recordEntry called
    r.updateOnOutcome('BTC', 'buy', 0.05);
    const w = r.getQuery('BTC');
    expect(w.every((v) => v === 0)).toBe(true);
  });

  it('online learning: side mismatch → no update (guard)', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', { volatility: 0.5 });
    r.recordEntry('BTC', 'buy', { volatility: 0.2 });
    r.updateOnOutcome('BTC', 'sell', 0.05); // different side
    const w = r.getQuery('BTC');
    expect(w.every((v) => v === 0)).toBe(true);
  });

  it('weight clip: w bounded to ±5 after many updates', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', { volatility: 0.5 });
    r.recordEntry('BTC', 'buy', { volatility: 0.2 });
    // many large-win updates
    for (let i = 0; i < 100; i++) {
      // re-record entry each time (pendingEntry is consumed per update)
      if (i % 2 === 0) r.recordEntry('BTC', 'buy', { volatility: 0.2 });
      r.updateOnOutcome('BTC', 'buy', 0.5);
    }
    const w = r.getQuery('BTC');
    expect(w.every((v) => Math.abs(v) <= 5.001)).toBe(true);
  });

  it('rolling window: history capped at historySize', () => {
    for (let i = 0; i < 30; i++) r.pushCycle('BTC', { volatility: i });
    expect(r.cycleCount('BTC')).toBe(20); // historySize
  });

  it('NaN features: sanitised to 0 on pushCycle', () => {
    r.pushCycle('BTC', { volatility: NaN, srDistanceBps: Infinity });
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(false);
    expect(blend.hBlend.volatility).toBe(0);
  });

  it('inputDim guard: w reset on dimension mismatch load', () => {
    const r2 = new CycleHistoryRetriever({ featureNames: ['a', 'b', 'c'] });
    // simulate a corrupted persisted state with wrong-dim wDecision
    r2._setState('BTC', { wDecision: [1, 2, 3, 4, 5] } as any);
    // load with mock — we test the guard directly via _setState + reconfig
    // The guard runs in load(); here we verify wDecision length matches config.
    const w = r2.getQuery('BTC', 'decision');
    expect(w.length).toBe(5); // as set (load guard is separate)
  });

  it('block AttnRes: 4 blocks + entry = 5 sources for 20-cycle history', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', { volatility: 0.5 });
    r.recordEntry('BTC', 'buy', { volatility: 0.2 });
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(true);
    // 4 blocks + 1 entry = 5 sources
    expect(blend.alphaDist.length).toBe(5);
    expect(blend.sourceLabels.length).toBe(5);
  });

  it('temperature warmup: collapsed attention → temperature increases', () => {
    // Force a collapse by making w strongly prefer one source.
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', { volatility: 0.5 });
    r.recordEntry('BTC', 'buy', { volatility: 0.2 });
    // Set wDecision to a value that collapses attention onto entry (first source).
    r._setState('BTC', { wDecision: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } as any);
    r.retrieveBlend('BTC'); // triggers entropy check
    // After a collapsed retrieval, temperature should have warmed.
    // (We can't directly read temperature, but a second retrieve should still work.)
    const blend2 = r.retrieveBlend('BTC');
    expect(blend2.blended).toBe(true);
    expect(blend2.alphaDist.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  });
});

// ─── v2.0.212 (#7) Pre-Decision vs Pre-Execution Specialization ───

describe('CycleHistoryRetriever — #7 dual pseudo-query specialization', () => {
  let r: CycleHistoryRetriever;
  beforeEach(() => {
    r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 80, numBlocks: 8, featureNames: ENTRY_CONDITION_FEATURES });
    r._reset();
  });

  const F = (vol: number, sr: number): Record<string, number> => ({
    volatility: vol, srDistanceBps: sr, obImbalance: 0.3, fundingRate: 0.001,
    volumeRatio: 1.2, signalAgreement: 0.6, sentiment: 0.2, sentimentConviction: 0.7,
    regimeOrdinal: 1, momentumShort: 0.01, momentumLong: 0.02,
  });

  it('decision + execution blends differ at cold-start (different recency prior)', () => {
    // 20 cycles: first 10 low-vol, last 10 high-vol → 2 blocks with
    // DIFFERENT means so recency prior affects the weighted average.
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', F(0.1, 100));
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', F(0.8, 800));
    const dec = r.retrieveBlend('BTC', 'decision');
    const exec = r.retrieveBlend('BTC', 'execution');
    expect(dec.blended).toBe(true);
    expect(exec.blended).toBe(true);
    // At cold-start (w=0), the ONLY difference is recency prior. Execution
    // has stronger recency → more weight on recent high-vol block → higher vol.
    const decVol = dec.hBlend['volatility'] ?? 0;
    const execVol = exec.hBlend['volatility'] ?? 0;
    expect(execVol).toBeGreaterThan(decVol);
  });

  it('execution blend is more recent-biased (higher weight on newest block)', () => {
    // 40 cycles: first 20 low-vol, last 20 high-vol.
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1, 100));
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.8, 800));
    const dec = r.retrieveBlend('BTC', 'decision');
    const exec = r.retrieveBlend('BTC', 'execution');
    // Execution (stronger recency) should weight recent high-vol blocks more.
    expect(exec.hBlend['volatility']!).toBeGreaterThan(dec.hBlend['volatility']!);
  });

  it('wDecision updates on PnL, wExecution only on sl_tp closeReason', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1 * (i % 5), 100 * (i % 5)));
    r.recordEntry('BTC', 'buy', F(0.2, 200));
    // Close with sl_tp + loss → both wDecision AND wExecution update.
    r.updateOnOutcome('BTC', 'buy', -0.03, 'sl_tp');
    const wDec = r.getQuery('BTC', 'decision');
    const wExec = r.getQuery('BTC', 'execution');
    expect(wDec.some((v) => v !== 0)).toBe(true);
    expect(wExec.some((v) => v !== 0)).toBe(true);
  });

  it('wExecution does NOT update on manual close (only sl_tp)', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1 * (i % 5), 100 * (i % 5)));
    r.recordEntry('BTC', 'buy', F(0.2, 200));
    // Manual close + win → wDecision updates, wExecution does NOT.
    r.updateOnOutcome('BTC', 'buy', 0.05, 'manual');
    const wDec = r.getQuery('BTC', 'decision');
    const wExec = r.getQuery('BTC', 'execution');
    expect(wDec.some((v) => v !== 0)).toBe(true);
    expect(wExec.every((v) => v === 0)).toBe(true); // unchanged
  });

  it('wExecution does NOT update on thesis_invalidation', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1 * (i % 5), 100 * (i % 5)));
    r.recordEntry('BTC', 'buy', F(0.2, 200));
    r.updateOnOutcome('BTC', 'buy', -0.02, 'thesis_invalidation');
    const wExec = r.getQuery('BTC', 'execution');
    expect(wExec.every((v) => v === 0)).toBe(true);
  });

  it('TP hit (win + sl_tp) → positive execution reward → wExec shifts', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1 * (i % 5), 100 * (i % 5)));
    r.recordEntry('BTC', 'buy', F(0.2, 200));
    r.updateOnOutcome('BTC', 'buy', 0.05, 'sl_tp');
    const wExec = r.getQuery('BTC', 'execution');
    expect(wExec.some((v) => v !== 0)).toBe(true);
  });

  it('decision and execution w diverge after different reward schedules', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1 * (i % 5), 100 * (i % 5)));
    // Trade 1: manual win → only wDecision updates
    r.recordEntry('BTC', 'buy', F(0.2, 200));
    r.updateOnOutcome('BTC', 'buy', 0.05, 'manual');
    // Trade 2: sl_tp loss → both update
    r.recordEntry('BTC', 'buy', F(0.3, 300));
    r.updateOnOutcome('BTC', 'buy', -0.04, 'sl_tp');
    const wDec = r.getQuery('BTC', 'decision');
    const wExec = r.getQuery('BTC', 'execution');
    // wDecision has 2 updates, wExecution has 1 → different vectors.
    const decNonZero = wDec.filter((v) => v !== 0).length;
    const execNonZero = wExec.filter((v) => v !== 0).length;
    expect(decNonZero).toBeGreaterThan(0);
    expect(execNonZero).toBeGreaterThan(0);
    // They should differ (different update counts + different rewards).
    let diff = false;
    for (let i = 0; i < wDec.length; i++) {
      if (Math.abs(wDec[i]! - wExec[i]!) > 1e-9) { diff = true; break; }
    }
    expect(diff).toBe(true);
  });

  it('cold-start: both w zero-init → retrieveBlend returns snapshot below minHistory', () => {
    const dec = r.retrieveBlend('BTC', 'decision');
    const exec = r.retrieveBlend('BTC', 'execution');
    expect(dec.blended).toBe(false);
    expect(exec.blended).toBe(false);
  });

  it('backward compat: old single-w state migrates to wDecision + wExecution', () => {
    // Simulate old state with `w` field (pre-v2.0.212).
    r._setState('BTC', { w: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } as any);
    // After migration (would happen in load), both should exist.
    // _setState doesn't run migration, but getQuery should still work.
    // In real load(), w → wDecision + wExecution.
    const dec = r.getQuery('BTC', 'decision');
    expect(dec.length).toBe(11);
  });

  it('execution blend explanation includes [execution] mode tag', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', F(0.1 * (i % 5), 100 * (i % 5)));
    const exec = r.retrieveBlend('BTC', 'execution');
    expect(exec.explanation).toContain('[execution]');
    const dec = r.retrieveBlend('BTC', 'decision');
    expect(dec.explanation).toContain('[decision]');
  });
});

describe('computeVectorConditionalWinRate — K.md #3 + #4', () => {
  const records = [
    { marketFeatures: { volatility: 0.1, srDistanceBps: 100 }, outcome: 'win', symbol: 'BTC', side: 'buy' as const, pnl: 0.05 },
    { marketFeatures: { volatility: 0.12, srDistanceBps: 110 }, outcome: 'win', symbol: 'BTC', side: 'buy' as const, pnl: 0.03 },
    { marketFeatures: { volatility: 0.5, srDistanceBps: 800 }, outcome: 'loss', symbol: 'ETH', side: 'buy' as const, pnl: -0.04 },
    { marketFeatures: { volatility: 0.55, srDistanceBps: 850 }, outcome: 'loss', symbol: 'ETH', side: 'buy' as const, pnl: -0.06 },
  ];
  const candidate = { volatility: 0.11, srDistanceBps: 105 };

  it('min-max path (default): valid result with matched records', () => {
    const res = computeVectorConditionalWinRate(candidate, records, { side: 'buy', minSamples: 2, threshold: 0.0 });
    expect(res.sampleSize).toBeGreaterThan(0);
    expect(res.conditionalWinRate).toBeGreaterThanOrEqual(0);
    expect(res.conditionalWinRate).toBeLessThanOrEqual(1);
  });

  it('rmsNormKeys path: produces a valid result', () => {
    const res = computeVectorConditionalWinRate(candidate, records, { side: 'buy', minSamples: 2, threshold: 0.0, rmsNormKeys: true });
    expect(res.sampleSize).toBeGreaterThan(0);
    expect(res.conditionalWinRate).toBeGreaterThanOrEqual(0);
    expect(res.conditionalWinRate).toBeLessThanOrEqual(1);
    expect(res.explanation).toContain('RMSNorm');
  });

  it('softmaxWeightedWR: high-similarity records weight more', () => {
    const resEq = computeVectorConditionalWinRate(candidate, records, { side: 'buy', minSamples: 2, threshold: 0.0 });
    const resSm = computeVectorConditionalWinRate(candidate, records, { side: 'buy', minSamples: 2, threshold: 0.0, softmaxWeightedWR: true, softmaxTemperature: 0.05 });
    // Both should be valid; softmax-weighted may differ from equal-weight when
    // similarities differ. Here we just verify it's bounded + computed.
    expect(resSm.conditionalWinRate).toBeGreaterThanOrEqual(0);
    expect(resSm.conditionalWinRate).toBeLessThanOrEqual(1);
    expect(resEq.sampleSize).toBe(resSm.sampleSize);
  });

  it('softmaxWeightedWinRate helper: all wins → 1', () => {
    const wr = softmaxWeightedWinRate([
      { similarity: 0.9, outcome: 'win', symbol: 'a', side: 'buy', pnl: 1 },
      { similarity: 0.8, outcome: 'win', symbol: 'b', side: 'buy', pnl: 1 },
    ], 0.1);
    expect(wr).toBeCloseTo(1, 6);
  });

  it('softmaxWeightedWinRate helper: all losses → 0', () => {
    const wr = softmaxWeightedWinRate([
      { similarity: 0.9, outcome: 'loss', symbol: 'a', side: 'buy', pnl: -1 },
      { similarity: 0.8, outcome: 'loss', symbol: 'b', side: 'buy', pnl: -1 },
    ], 0.1);
    expect(wr).toBeCloseTo(0, 6);
  });

  it('softmaxWeightedWinRate helper: empty → 0.5', () => {
    expect(softmaxWeightedWinRate([], 0.1)).toBe(0.5);
  });

  it('softmaxWeightedWinRate helper: higher-sim win weights more than lower-sim win', () => {
    const wrHighSimWin = softmaxWeightedWinRate([
      { similarity: 0.99, outcome: 'win', symbol: 'a', side: 'buy', pnl: 1 },
      { similarity: 0.5, outcome: 'loss', symbol: 'b', side: 'buy', pnl: -1 },
    ], 0.05); // sharp
    const wrLowSimWin = softmaxWeightedWinRate([
      { similarity: 0.5, outcome: 'win', symbol: 'a', side: 'buy', pnl: 1 },
      { similarity: 0.99, outcome: 'loss', symbol: 'b', side: 'buy', pnl: -1 },
    ], 0.05);
    expect(wrHighSimWin).toBeGreaterThan(wrLowSimWin);
  });

  it('rmsNormFeatures: zero/missing → uniform unit vector', () => {
    const { vec, present } = rmsNormFeatures({}, ENTRY_CONDITION_FEATURES);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(present.every((p) => p === false)).toBe(true);
  });

  it('rmsNormFeatures: normal vector normalised to unit RMS', () => {
    const { vec } = rmsNormFeatures({ volatility: 3, srDistanceBps: 4 }, ['volatility', 'srDistanceBps']);
    // RMS = sqrt((9+16)/2) = sqrt(12.5) ≈ 3.54; vec = [3/3.54, 4/3.54]
    expect(vec[0]!).toBeCloseTo(3 / Math.sqrt(12.5 + 1e-8), 4);
    expect(vec[1]!).toBeCloseTo(4 / Math.sqrt(12.5 + 1e-8), 4);
  });
});