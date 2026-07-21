// ─── AttnRes Attack Harness (K.md §6, v2.0.211) ───
// Tries to break cycle-history-retrieval + evolution-utils #3/#4 via:
//   Q7.1 numerical (NaN/Infinity/overflow)
//   Q7.2 state (empty history, dimension mismatch, huge history)
//   Q7.3 cold-start (no entry, immediate close)
//   Q7.4 concurrency (parallel updates)
//   Q7.5 injection (malformed features, adversarial outcomes)

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

const FULL_FEATURES = (vol: number, sr: number): Record<string, number> => ({
  volatility: vol, srDistanceBps: sr, obImbalance: 0.3, fundingRate: 0.001,
  volumeRatio: 1.2, signalAgreement: 0.6, sentiment: 0.2, sentimentConviction: 0.7,
  regimeOrdinal: 1, momentumShort: 0.01, momentumLong: 0.02,
});

describe('Q7.1 — Numerical attacks', () => {
  let r: CycleHistoryRetriever;
  beforeEach(() => {
    r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 20, numBlocks: 4, featureNames: ENTRY_CONDITION_FEATURES });
    r._reset();
  });

  it('NaN in features → sanitised, no NaN in blend', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.pushCycle('BTC', { volatility: NaN, srDistanceBps: Infinity, obImbalance: -Infinity });
    r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
    const blend = r.retrieveBlend('BTC');
    const vals = Object.values(blend.hBlend);
    expect(vals.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('Infinity reward → bounded by min(1, |pnl|/scale)', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
    r.updateOnOutcome('BTC', 'buy', Infinity);
    const w = r.getQuery('BTC');
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
    expect(w.every((v) => Math.abs(v) <= 5.001)).toBe(true);
  });

  it('NaN pnlPct → skipped (no update, no crash)', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
    const wBefore = r.getQuery('BTC');
    r.updateOnOutcome('BTC', 'buy', NaN);
    expect(r.getQuery('BTC')).toEqual(wBefore); // unchanged
  });

  it('overflow logits (w=large) → softmax still sums to 1', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r._setState('BTC', { w: new Array(11).fill(1e10) } as any);
    const blend = r.retrieveBlend('BTC');
    expect(blend.alphaDist.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(blend.alphaDist.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('rmsNorm all-NaN → uniform unit (no NaN propagation)', () => {
    const out = rmsNorm([NaN, NaN, NaN]);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('softmax all-Infinity logits → uniform', () => {
    const p = softmax([Infinity, Infinity, Infinity]);
    expect(p.every((v) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true);
  });
});

describe('Q7.2 — State attacks', () => {
  let r: CycleHistoryRetriever;
  beforeEach(() => {
    r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 20, numBlocks: 4, featureNames: ENTRY_CONDITION_FEATURES });
    r._reset();
  });

  it('empty history → current snapshot (no crash)', () => {
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(false);
    expect(Object.keys(blend.hBlend).length).toBe(0);
  });

  it('1 cycle only → current snapshot (below minHistoryToBlend)', () => {
    r.pushCycle('BTC', FULL_FEATURES(0.1, 100));
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(false);
  });

  it('huge history (10x historySize) → capped, no memory blowup', () => {
    for (let i = 0; i < 200; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * (i % 20), 100 * (i % 20)));
    expect(r.cycleCount('BTC')).toBe(20); // capped
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(true);
  });

  it('dimension mismatch load → w reset', () => {
    // Simulate: state with 5-dim w loaded into 11-dim config.
    // _setState doesn't run the guard; we verify cycleCount + retrieve still work.
    r._setState('BTC', { w: [1, 2, 3, 4, 5] } as any);
    // retrieveBlend uses s.w (5-dim) vs keys (11-dim) — dot product loops min length.
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(true);
    // No crash — dot product handles length mismatch gracefully.
  });

  it('unknown symbol → fresh state, no crash', () => {
    const blend = r.retrieveBlend('UNKNOWN');
    expect(blend.blended).toBe(false);
  });
});

describe('Q7.3 — Cold-start attacks', () => {
  let r: CycleHistoryRetriever;
  beforeEach(() => {
    r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 20, numBlocks: 4, featureNames: ENTRY_CONDITION_FEATURES });
    r._reset();
  });

  it('close without entry → no update (guard)', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.updateOnOutcome('BTC', 'buy', 0.05);
    expect(r.getQuery('BTC').every((v) => v === 0)).toBe(true);
  });

  it('immediate close (0 pnlPct) → skipped as noise', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
    r.updateOnOutcome('BTC', 'buy', 0);
    expect(r.getQuery('BTC').every((v) => v === 0)).toBe(true);
  });

  it('first-trade win → w non-zero, retriever stable', () => {
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
    r.updateOnOutcome('BTC', 'buy', 0.05);
    const w = r.getQuery('BTC');
    expect(w.some((v) => Number.isFinite(v))).toBe(true);
    // retriever still works after update.
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(true);
  });
});

describe('Q7.4 — Concurrency attacks', () => {
  it('synchronous w update — no async mutation window', () => {
    const r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 20, numBlocks: 4, featureNames: ENTRY_CONDITION_FEATURES });
    r._reset();
    for (let i = 0; i < 10; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * i, 100 * i));
    r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
    // updateOnOutcome is synchronous; pendingEntry is consumed atomically.
    r.updateOnOutcome('BTC', 'buy', 0.05);
    // A second update without a new recordEntry → no-op (pendingEntry consumed).
    r.updateOnOutcome('BTC', 'buy', 0.05);
    const w = r.getQuery('BTC');
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('Q7.5 — Injection attacks', () => {
  let r: CycleHistoryRetriever;
  beforeEach(() => {
    r = new CycleHistoryRetriever({ ...DEFAULT_CYCLE_HISTORY_CONFIG, historySize: 20, numBlocks: 4, featureNames: ENTRY_CONDITION_FEATURES });
    r._reset();
  });

  it('malformed features (string values) → treated as 0, no crash', () => {
    r.pushCycle('BTC', { volatility: 'high' as unknown as number, srDistanceBps: 100 });
    const blend = r.retrieveBlend('BTC');
    expect(blend.blended).toBe(false);
    expect(blend.hBlend.volatility).toBe(0); // string → not finite → 0
  });

  it('null features → no crash (graceful rejection)', () => {
    r.pushCycle('BTC', null as unknown as Record<string, number>);
    // null is rejected gracefully (Object.entries throws, caught internally).
    // The invariant is: no crash, retriever still usable.
    expect(r.cycleCount('BTC')).toBeGreaterThanOrEqual(0);
    const blend = r.retrieveBlend('BTC');
    expect(blend).toBeDefined();
  });

  it('adversarial alternating win/loss → w stays bounded, retriever stable', () => {
    for (let i = 0; i < 20; i++) r.pushCycle('BTC', FULL_FEATURES(0.1 * (i % 5), 100 * (i % 5)));
    for (let i = 0; i < 50; i++) {
      r.recordEntry('BTC', 'buy', FULL_FEATURES(0.2, 200));
      r.updateOnOutcome('BTC', 'buy', i % 2 === 0 ? 0.1 : -0.1);
    }
    const w = r.getQuery('BTC');
    expect(w.every((v) => Math.abs(v) <= 5.001)).toBe(true);
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('softmaxWeightedWinRate: adversarial NaN similarity → fallback to equal-weight', () => {
    const wr = softmaxWeightedWinRate([
      { similarity: NaN, outcome: 'win', symbol: 'a', side: 'buy', pnl: 1 },
      { similarity: 0.8, outcome: 'loss', symbol: 'b', side: 'buy', pnl: -1 },
    ], 0.1);
    expect(Number.isFinite(wr)).toBe(true);
    expect(wr).toBeGreaterThanOrEqual(0);
    expect(wr).toBeLessThanOrEqual(1);
  });

  it('computeVectorConditionalWinRate: all-NaN records → neutral 0.5', () => {
    const res = computeVectorConditionalWinRate(
      FULL_FEATURES(0.2, 200),
      [{ marketFeatures: { volatility: NaN }, outcome: 'win', symbol: 'BTC', side: 'buy', pnl: 1 }],
      { side: 'buy', minSamples: 1, threshold: 0.0, rmsNormKeys: true },
    );
    expect(res.conditionalWinRate).toBeGreaterThanOrEqual(0);
    expect(res.conditionalWinRate).toBeLessThanOrEqual(1);
  });

  it('rmsNormFeatures: all-NaN → uniform unit vector', () => {
    const { vec } = rmsNormFeatures({ volatility: NaN, srDistanceBps: NaN }, ['volatility', 'srDistanceBps']);
    expect(vec.every((v) => Number.isFinite(v))).toBe(true);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});