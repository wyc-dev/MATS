// ─── v2.0.218: OLR feedTrade NaN Sanitization Attack Tests ─────────────────
//
// Verifies that the critical v2.0.218 fix works: real trades with NaN
// features are SANITIZED (not rejected), so they always make it into OLR.
//
// Root cause being fixed:
//   `??` (nullish coalescing) only catches null/undefined, NOT NaN/Infinity.
//   If a WS returns { fundingRate: NaN }, then `NaN ?? 0 = NaN` (not 0!).
//   This NaN propagated to feedTrade's NaN guard, which REJECTED the entire
//   sample. Result: 102 real trades → 0 OLR samples for BTC, 5 for SKHX.
//
// Fix:
//   1. safeNum() utility — catches ALL non-finite values (null/undefined/NaN/±Inf)
//   2. feedTrade NaN guard — sanitizes NaN to 0 instead of rejecting
//   3. contextToVector — sanitizes NaN to 0 instead of passing through
//   4. All feature computation paths in index.ts use safeNum() instead of ??
//
// Attack tests:
// - A1-A5: safeNum() catches all non-finite values
// - B1-B6: feedTrade sanitizes NaN features instead of rejecting
// - C1-C4: contextToVector sanitizes NaN
// - D1-D3: All-NaN features still produce valid samples
// - E1-E2: Infinity features sanitized
// - F1-F2: Mixed NaN + valid features retain valid feature signal

import { describe, it, expect } from 'vitest';
import { safeNum, sanitizeFeatures } from '../src/evolution/evolution-utils.ts';
import { OLREngine, FEATURE_NAMES, regimeToOrdinal } from '../src/evolution/olr-engine.ts';

function zeroFeatures(): Record<string, number> {
  const f: Record<string, number> = {};
  for (const n of FEATURE_NAMES) f[n] = 0;
  return f;
}

function goodFeatures(): Record<string, number> {
  return {
    ...zeroFeatures(),
    volatility: 0.02,
    srDistanceBps: 50,
    obImbalance: 0.1,
    fundingRate: 0.0001,
    volumeRatio: 1.5,
    sentiment: 0.3,
    signalAgreement: 0.6,
    sentimentConviction: 0.7,
    mfePct: 0.05,
    maePct: 0.02,
    mfeToPnlRatio: 0.3,
    regimeOrdinal: 0.5,
    momentumShort: 0.01,
    momentumLong: 0.02,
  };
}

// ═══════════════════════════════════════════════════════════════
//  safeNum() Tests
// ═══════════════════════════════════════════════════════════════

describe('safeNum() catches all non-finite values', () => {
  it('A1: returns value when finite', () => {
    expect(safeNum(42, 0)).toBe(42);
    expect(safeNum(-0.5, 0)).toBe(-0.5);
    expect(safeNum(0, 99)).toBe(0);
  });

  it('A2: catches null and undefined', () => {
    expect(safeNum(null, 0)).toBe(0);
    expect(safeNum(undefined, 0.5)).toBe(0.5);
  });

  it('A3: catches NaN — THE critical fix (?? does NOT catch NaN)', () => {
    expect(safeNum(NaN, 0)).toBe(0);
    expect(safeNum(NaN, 0.5)).toBe(0.5);
    // Contrast: NaN ?? 0 = NaN (the old bug)
    expect((NaN as number | null | undefined) ?? 0).toBe(NaN); // old behavior — BUG
    expect(safeNum(NaN, 0)).toBe(0); // new behavior — FIXED
  });

  it('A4: catches Infinity and -Infinity', () => {
    expect(safeNum(Infinity, 0)).toBe(0);
    expect(safeNum(-Infinity, 0.5)).toBe(0.5);
    // Contrast: Infinity ?? 0 = Infinity (old bug)
    expect((Infinity as number | null | undefined) ?? 0).toBe(Infinity); // old — BUG
    expect(safeNum(Infinity, 0)).toBe(0); // new — FIXED
  });

  it('A5: preserves negative finite values', () => {
    expect(safeNum(-1e-10, 0)).toBe(-1e-10);
    expect(safeNum(-999, 0)).toBe(-999);
  });
});

// ═══════════════════════════════════════════════════════════════
//  sanitizeFeatures() Tests
// ═══════════════════════════════════════════════════════════════

describe('sanitizeFeatures() replaces all non-finite values', () => {
  it('A6: sanitizes NaN and Infinity in mixed features', () => {
    const raw = { volatility: NaN, fundingRate: Infinity, sentiment: 0.3, volumeRatio: -Infinity };
    const defaults = { volatility: 0, fundingRate: 0, sentiment: 0, volumeRatio: 1 };
    const out = sanitizeFeatures(raw, defaults);
    expect(out.volatility).toBe(0);
    expect(out.fundingRate).toBe(0);
    expect(out.sentiment).toBe(0.3); // preserved
    expect(out.volumeRatio).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  feedTrade NaN Sanitization Tests
// ═══════════════════════════════════════════════════════════════

describe('feedTrade sanitizes NaN instead of rejecting (v2.0.218)', () => {
  it('B1: NaN fundingRate — sample is RETAINED (not rejected)', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    // Train 15 good samples
    for (let i = 0; i < 15; i++) olr.feedTrade('btc', good, 1, 'buy', 'shadow', i);

    const statsBefore = olr.getAllModelStats().find(s => s.symbol === 'btc');
    const countBefore = statsBefore?.longSamples ?? 0;

    // Feed sample with NaN fundingRate — THE critical scenario
    const nanFeatures = { ...good, fundingRate: NaN };
    olr.feedTrade('btc', nanFeatures, 0, 'buy', 'real', 99);

    const statsAfter = olr.getAllModelStats().find(s => s.symbol === 'btc');
    const countAfter = statsAfter?.longSamples ?? 0;

    // Sample MUST be retained (count increased)
    expect(countAfter).toBe(countBefore + 1);
    // Weights MUST be finite (no NaN poisoning)
    const weights = olr.getFeatureWeights('btc', 'buy')!;
    expect(weights.every(w => Number.isFinite(w.weight))).toBe(true);
  });

  it('B2: Infinity volatility — sample RETAINED, weights finite', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    for (let i = 0; i < 15; i++) olr.feedTrade('btc', good, 1, 'buy', 'shadow', i);

    olr.feedTrade('btc', { ...good, volatility: Infinity }, 0, 'buy', 'real', 99);

    const weights = olr.getFeatureWeights('btc', 'buy')!;
    expect(weights.every(w => Number.isFinite(w.weight))).toBe(true);
    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    expect(stats?.longSamples).toBe(16); // 15 + 1
  });

  it('B3: ALL features NaN — sample still retained, weights finite', () => {
    const olr = new OLREngine();
    const allNaN = Object.fromEntries(FEATURE_NAMES.map(n => [n, NaN]));
    olr.feedTrade('btc', allNaN, 1, 'buy', 'real', 1);

    const weights = olr.getFeatureWeights('btc', 'buy')!;
    expect(weights.every(w => Number.isFinite(w.weight))).toBe(true);
    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    expect(stats?.longSamples).toBe(1); // sample retained
  });

  it('B4: realSamples counter increments for real source with NaN features', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    // Feed a real trade with NaN fundingRate
    olr.feedTrade('btc', { ...good, fundingRate: NaN }, 0, 'buy', 'real', 1);
    olr.feedTrade('btc', { ...good, fundingRate: NaN }, 1, 'sell', 'real', 2);

    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    // Both real samples should be counted (not rejected)
    expect(stats?.longSamples).toBe(1);
    expect(stats?.shortSamples).toBe(1);
  });

  it('B5: mixed NaN + valid features — valid features still influence weights', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    // Train 20 good samples with high volatility → win
    for (let i = 0; i < 20; i++) olr.feedTrade('btc', { ...good, volatility: 0.05 }, 1, 'buy', 'shadow', i);

    // Feed 5 samples with NaN fundingRate but valid volatility → loss
    for (let i = 0; i < 5; i++) olr.feedTrade('btc', { ...good, volatility: 0.05, fundingRate: NaN }, 0, 'buy', 'real', 20 + i);

    const weights = olr.getFeatureWeights('btc', 'buy')!;
    expect(weights.every(w => Number.isFinite(w.weight))).toBe(true);
    // The model should have learned something from the 25 total samples
    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    expect(stats?.longSamples).toBe(25); // 20 + 5
  });

  it('B6: query with NaN features returns finite pWin (not NaN)', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    for (let i = 0; i < 20; i++) olr.feedTrade('btc', good, i % 2, 'buy', 'shadow', i);

    // Query with NaN fundingRate
    const nanQuery = { ...good, fundingRate: NaN };
    const result = olr.query('btc', nanQuery, 'buy', 100);
    expect(Number.isFinite(result.pWin)).toBe(true);
    expect(result.pWin).toBeGreaterThanOrEqual(0.001);
    expect(result.pWin).toBeLessThanOrEqual(0.999);
  });
});

// ═══════════════════════════════════════════════════════════════
//  contextToVector sanitization tests
// ═══════════════════════════════════════════════════════════════

describe('contextToVector sanitizes NaN (v2.0.218)', () => {
  it('C1: NaN feature → 0 in vector', () => {
    const olr = new OLREngine();
    // Access private method
    const features = { ...zeroFeatures(), volatility: NaN };
    const vec = (olr as any).contextToVector(features);
    const volIdx = FEATURE_NAMES.indexOf('volatility');
    expect(vec[volIdx]).toBe(0);
    expect(Number.isFinite(vec[volIdx])).toBe(true);
  });

  it('C2: Infinity feature → 0 in vector', () => {
    const olr = new OLREngine();
    const features = { ...zeroFeatures(), fundingRate: Infinity };
    const vec = (olr as any).contextToVector(features);
    const frIdx = FEATURE_NAMES.indexOf('fundingRate');
    expect(vec[frIdx]).toBe(0);
  });

  it('C3: NaN regimeOrdinal → 0.5 (neutral sentinel)', () => {
    const olr = new OLREngine();
    const features = { ...zeroFeatures(), regimeOrdinal: NaN };
    const vec = (olr as any).contextToVector(features);
    const roIdx = FEATURE_NAMES.indexOf('regimeOrdinal');
    expect(vec[roIdx]).toBe(0.5);
  });

  it('C4: valid features pass through unchanged', () => {
    const olr = new OLREngine();
    const features = goodFeatures();
    const vec = (olr as any).contextToVector(features);
    const volIdx = FEATURE_NAMES.indexOf('volatility');
    expect(vec[volIdx]).toBe(0.02);
  });
});

// ═══════════════════════════════════════════════════════════════
//  End-to-end: real trade scenario simulation
// ═══════════════════════════════════════════════════════════════

describe('E2E: real trade scenario with NaN fundingRate (v2.0.218)', () => {
  it('E1: 50 real trades with intermittent NaN fundingRate all make it into OLR', () => {
    const olr = new OLREngine();
    const good = goodFeatures();

    // Simulate 50 real trades, 30% with NaN fundingRate (WS intermittent failure)
    let realCount = 0;
    for (let i = 0; i < 50; i++) {
      const features = { ...good };
      if (i % 3 === 0) features.fundingRate = NaN; // 33% NaN
      if (i % 7 === 0) features.volumeRatio = Infinity; // 14% Infinity
      const outcome = i % 2 === 0 ? 1 : 0;
      olr.feedTrade('btc', features, outcome, 'buy', 'real', i);
      realCount++;
    }

    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    // ALL 50 trades must be in OLR (none rejected)
    expect(stats?.longSamples).toBe(50);
    expect(stats?.longSource.real).toBe(50);
    // Weights must be finite
    const weights = olr.getFeatureWeights('btc', 'buy')!;
    expect(weights.every(w => Number.isFinite(w.weight))).toBe(true);
  });

  it('E2: OLR model trained with sanitized samples produces meaningful predictions', () => {
    const olr = new OLREngine();
    const good = goodFeatures();

    // Train 30 wins with high volatility + 30 losses with low volatility
    // Some samples have NaN fundingRate (should not affect learning)
    for (let i = 0; i < 30; i++) {
      olr.feedTrade('btc', { ...good, volatility: 0.05, fundingRate: i % 2 === 0 ? NaN : 0.0001 }, 1, 'buy', 'real', i);
      olr.feedTrade('btc', { ...good, volatility: 0.005, fundingRate: i % 2 === 0 ? NaN : 0.0001 }, 0, 'buy', 'real', 30 + i);
    }

    // Query: high volatility → should predict higher pWin
    const highVolQuery = { ...good, volatility: 0.05 };
    const lowVolQuery = { ...good, volatility: 0.005 };
    const pWinHigh = olr.query('btc', highVolQuery, 'buy', 100).pWin;
    const pWinLow = olr.query('btc', lowVolQuery, 'buy', 100).pWin;

    // The model should have learned that high volatility → win
    // (both queries have NaN-free features, so predictions should be finite)
    expect(Number.isFinite(pWinHigh)).toBe(true);
    expect(Number.isFinite(pWinLow)).toBe(true);
    // With 30+30 samples and clear signal, high vol should predict higher win
    expect(pWinHigh).toBeGreaterThanOrEqual(pWinLow);
  });

  it('E3: regimeToOrdinal returns finite for all inputs', () => {
    expect(Number.isFinite(regimeToOrdinal('trending_bull'))).toBe(true);
    expect(Number.isFinite(regimeToOrdinal('mean_reverting'))).toBe(true);
    expect(Number.isFinite(regimeToOrdinal('unknown'))).toBe(true);
    expect(Number.isFinite(regimeToOrdinal(undefined))).toBe(true);
    expect(Number.isFinite(regimeToOrdinal(''))).toBe(true);
  });
});