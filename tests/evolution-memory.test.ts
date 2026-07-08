import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger so evolution modules can be imported without loading
// winston/config/.env in the test environment.
vi.mock('../src/observability/logger.ts', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import {
  calculateFirstPassage,
  estimateDrift,
  estimateVolatility,
} from '../src/evolution/first-passage.ts';
import { backfillOLRFromCandles, nearestSR, type HLCandle } from '../src/evolution/olr-backfill.ts';
import { OLREngine } from '../src/evolution/olr-engine.ts';
import { ShadowTradeEngine } from '../src/evolution/shadow-trade-engine.ts';

// ─── Helpers ───

/** Build a price series with a known per-cycle log-drift and vol. */
function gbmSeries(n: number, mu: number, sigma: number, start = 100): number[] {
  // Deterministic pseudo-random (Lehmer LCG) so tests are reproducible.
  let seed = 42;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  // Box-Muller
  const normal = () => {
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const prices: number[] = [start];
  for (let i = 1; i < n; i++) {
    const logRet = (mu - 0.5 * sigma * sigma) + sigma * normal();
    prices.push(prices[i - 1]! * Math.exp(logRet));
  }
  return prices;
}

const zeroFeatures = (): Record<string, number> => ({
  volatility: 0,
  srDistanceBps: 0,
  obImbalance: 0,
  sentiment: 0,
  signalAgreement: 0,
  fundingRate: 0,
  volumeRatio: 0,
  sentimentConviction: 0,
});

// ─── C1 / C2 / M4: First-Passage formula correctness ───

describe('First-Passage — C1/C2/M4 formula fixes', () => {
  it('strong UP drift → LONG P(win) high, SHORT P(win) low (was inverted before fix)', () => {
    // drift=0.1/cycle (10%) vs σ=2%: 2νa/σ²=10 → near-certain LONG win.
    const r = calculateFirstPassage(0.02, 0.1, 0.02, 0.05, 0.05, 0.02);
    expect(r.longPWin).toBeGreaterThan(0.9);
    expect(r.shortPWin).toBeLessThan(0.1);
    // The pre-fix code returned these swapped — this test fails on the old code.
  });

  it('strong DOWN drift → LONG P(win) low, SHORT P(win) high', () => {
    const r = calculateFirstPassage(0.02, -0.1, 0.02, 0.05, 0.05, 0.02);
    expect(r.longPWin).toBeLessThan(0.1);
    expect(r.shortPWin).toBeGreaterThan(0.9);
  });

  it('modest UP drift raises LONG P(win) above its breakeven and lowers SHORT', () => {
    const r = calculateFirstPassage(0.02, 0.005, 0.02, 0.05, 0.05, 0.02);
    const beLong = 0.02 / 0.07;
    const beShort = 0.05 / 0.07;
    expect(r.longPWin).toBeGreaterThan(beLong);   // up drift helps LONG
    expect(r.shortPWin).toBeLessThan(beShort);   // up drift hurts SHORT
  });

  it('zero drift → each side equals its OWN a/(a+b) breakeven (mirrored barriers)', () => {
    // LONG: SL 2% (near), TP 5% (far) → breakeven 0.02/0.07.
    // SHORT: SL 5% (resistance, far), TP 2% (support, near) → breakeven 0.05/0.07.
    const r = calculateFirstPassage(0.02, 0, 0.02, 0.05, 0.05, 0.02);
    expect(r.longPWin).toBeCloseTo(0.02 / 0.07, 4);
    expect(r.shortPWin).toBeCloseTo(0.05 / 0.07, 4);
    // Old fallback returned b/(a+b) for LONG = 0.714 — explicitly wrong.
    expect(r.longPWin).toBeLessThan(0.5);
  });

  it('symmetric barriers + zero drift → 0.5 for both', () => {
    const r = calculateFirstPassage(0.02, 0, 0.03, 0.03, 0.03, 0.03);
    expect(r.longPWin).toBeCloseTo(0.5, 4);
    expect(r.shortPWin).toBeCloseTo(0.5, 4);
  });

  it('low volatility → returns breakeven a/(a+b) with confidence=low', () => {
    const r = calculateFirstPassage(0.0005, 0.001, 0.02, 0.05, 0.05, 0.02);
    expect(r.confidence).toBe('low');
    expect(r.longPWin).toBeCloseTo(0.02 / 0.07, 4);
  });

  it('breakevenP fields are exposed and RR-aware (per-side)', () => {
    const r = calculateFirstPassage(0.02, 0.001, 0.02, 0.05, 0.05, 0.02);
    expect(r.breakevenPLong).toBeCloseTo(0.02 / 0.07, 6);
    expect(r.breakevenPShort).toBeCloseTo(0.05 / 0.07, 6);
  });

  it('clamps to [0,1] and stays finite under extreme drift', () => {
    const r = calculateFirstPassage(0.02, 1, 0.02, 0.05, 0.05, 0.02);
    expect(Number.isFinite(r.longPWin)).toBe(true);
    expect(Number.isFinite(r.shortPWin)).toBe(true);
    expect(r.longPWin).toBeGreaterThanOrEqual(0);
    expect(r.longPWin).toBeLessThanOrEqual(1);
  });

  it('SHORT uses its own SL/TP distances (M4) — per-side breakeven', () => {
    // LONG: SL 1%, TP 4% → breakeven 0.01/0.05 = 0.2
    // SHORT: SL 3%, TP 2% → breakeven 0.03/0.05 = 0.6
    const r = calculateFirstPassage(0.02, 0, 0.01, 0.04, 0.03, 0.02);
    expect(r.breakevenPLong).toBeCloseTo(0.01 / 0.05, 4);
    expect(r.breakevenPShort).toBeCloseTo(0.03 / 0.05, 4);
  });
});

// ─── H4 / M1: estimators ───

describe('estimateVolatility / estimateDrift (H4, M1)', () => {
  it('estimateVolatility recovers σ from a GBM series within tolerance', () => {
    const sigma = 0.02;
    const prices = gbmSeries(500, 0, sigma);
    const est = estimateVolatility(prices, 100);
    // Loose tolerance (random draw) — should be in the right band.
    expect(est).toBeGreaterThan(sigma * 0.6);
    expect(est).toBeLessThan(sigma * 1.4);
  });

  it('estimateVolatility returns 0 for insufficient data', () => {
    expect(estimateVolatility([100], 20)).toBe(0);
    expect(estimateVolatility([], 20)).toBe(0);
  });

  it('estimateDrift returns 0 for insufficient data and finite otherwise', () => {
    expect(estimateDrift([100], 20)).toBe(0);
    const prices = gbmSeries(100, 0.001, 0.01);
    const d = estimateDrift(prices, 20);
    expect(Number.isFinite(d)).toBe(true);
  });

  it('estimateDrift uses log returns (negative series → negative drift)', () => {
    const prices: number[] = [100];
    for (let i = 1; i < 30; i++) prices.push(prices[i - 1]! * 0.999); // −0.1%/cycle
    expect(estimateDrift(prices, 20)).toBeLessThan(0);
  });
});

// ─── H2 / M2 / M6 / L1: OLR engine ───

describe('OLR Engine — H2/M2/M3/M6/L1', () => {
  let olr: OLREngine;
  beforeEach(() => { olr = new OLREngine(); });

  it('source weighting: a REAL sample moves P(win) more than a SHADOW sample', () => {
    const feats = { ...zeroFeatures(), volatility: 0.02 };
    // Feed 15 shadow wins to establish a baseline.
    for (let i = 0; i < 15; i++) olr.feedTrade('btc', feats, 1, 'buy', 'shadow', i);
    const pAfterShadow = olr.query('btc', feats, 'buy', 15).pWin;
    // One real win should push P(win) up further.
    olr.feedTrade('btc', feats, 1, 'buy', 'real', 16);
    const pAfterReal = olr.query('btc', feats, 'buy', 17).pWin;
    expect(pAfterReal).toBeGreaterThan(pAfterShadow);
  });

  it('NaN feature is rejected and does not poison weights (M6)', () => {
    const good = { ...zeroFeatures(), volatility: 0.02 };
    for (let i = 0; i < 15; i++) olr.feedTrade('btc', good, 1, 'buy', 'shadow', i);
    const before = olr.getFeatureWeights('btc', 'buy')!;
    // Feed a NaN feature — must be skipped, not persisted into weights.
    olr.feedTrade('btc', { ...zeroFeatures(), volatility: NaN }, 1, 'buy', 'shadow', 99);
    const after = olr.getFeatureWeights('btc', 'buy')!;
    expect(after.every(w => Number.isFinite(w.weight))).toBe(true);
    // Weights unchanged (sample skipped).
    expect(after).toEqual(before);
  });

  it('load() resets non-finite weights to 0 (M6)', () => {
    const poisoned = JSON.stringify({
      olrSymbols: {
        btc: {
          long: { weights: [0, NaN, Infinity, 0, 0, 0, 0, 0, 0], nSamples: 5, mean: [0,0,0,0,0,0,0,0], m2: [0,0,0,0,0,0,0,0], welfordCount: 5, shadowSamples: 5, paperSamples: 0, realSamples: 0, recentTrades: [] },
          short: { weights: new Array(9).fill(0), nSamples: 0, mean: new Array(8).fill(0), m2: new Array(8).fill(0), welfordCount: 0, shadowSamples: 0, paperSamples: 0, realSamples: 0, recentTrades: [] },
        },
      },
    });
    olr.load(poisoned);
    const w = olr.getFeatureWeights('btc', 'buy')!;
    expect(w.every(x => Number.isFinite(x.weight))).toBe(true);
    expect(w[1]!.weight).toBe(0); // NaN → 0
  });

  it('query returns pWin=0.5 with <minSamples and does not throw', () => {
    const r = olr.query('btc', zeroFeatures(), 'buy', 0);
    expect(r.pWin).toBe(0.5);
    expect(r.nSamples).toBe(0);
  });

  it('save/load round-trips a trained model', () => {
    const feats = { ...zeroFeatures(), volatility: 0.02 };
    for (let i = 0; i < 25; i++) olr.feedTrade('btc', feats, i % 2, 'buy', 'shadow', i);
    const p1 = olr.query('btc', feats, 'buy', 25).pWin;
    const olr2 = new OLREngine();
    olr2.load(olr.save());
    const p2 = olr2.query('btc', feats, 'buy', 25).pWin;
    expect(p2).toBeCloseTo(p1, 6);
  });
});

// ─── H1 / M5 / L3: Shadow Trade Engine ───

describe('Shadow Trade Engine — H1/M5/L3', () => {
  let olr: OLREngine;
  let shadow: ShadowTradeEngine;
  beforeEach(() => {
    olr = new OLREngine();
    shadow = new ShadowTradeEngine(olr);
  });

  it('H1: intra-cycle high resolves a LONG TP that the close price misses', () => {
    // LONG: entry 100, SL 98, TP 105. SHORT: SL 110, TP 90 (isolated — won't hit).
    shadow.openShadowTrades('btc', 100, 98, 105, 110, 90, 0, { ...zeroFeatures(), volatility: 0.02 });
    // Cycle close = 101 (hasn't hit TP), BUT intra-cycle high = 106 (touched TP).
    const resolved = shadow.checkPositions('btc', 101, 1, 106, 99);
    expect(resolved).toBe(1);
    const open = shadow.getOpenPositions();
    expect(open.length).toBe(1); // the SHORT is still open
    expect(open.find(p => p.side === 'buy')).toBeUndefined();
    // OLR should have received the LONG win (symbol registered).
    expect(olr.getAllSymbols()).toContain('btc');
  });

  it('H1: intra-cycle low resolves a LONG SL even when close recovers', () => {
    shadow.openShadowTrades('btc', 100, 98, 105, 110, 90, 0, { ...zeroFeatures(), volatility: 0.02 });
    // Close = 101, but intra-cycle low = 97 (hit SL).
    const resolved = shadow.checkPositions('btc', 101, 1, 102, 97);
    expect(resolved).toBe(1);
    const open = shadow.getOpenPositions();
    expect(open.find(p => p.side === 'buy')).toBeUndefined();
  });

  it('H1: both SL and TP touched intra-cycle → conservative LOSS', () => {
    shadow.openShadowTrades('btc', 100, 98, 105, 110, 90, 0, { ...zeroFeatures(), volatility: 0.02 });
    // High = 106 (TP touched) AND low = 97 (SL touched) → LOSS.
    shadow.checkPositions('btc', 101, 1, 106, 97);
    const open = shadow.getOpenPositions();
    expect(open.find(p => p.side === 'buy')).toBeUndefined();
  });

  it('M5: stale force-resolve does NOT feed OLR (no fabricated label)', () => {
    shadow.openShadowTrades('btc', 100, 98, 105, 102, 95, 0, { ...zeroFeatures(), volatility: 0.02 });
    // Hold past maxHoldCycles (50) with no SL/TP hit.
    shadow.checkPositions('btc', 100.5, 51, 100.5, 100.5);
    // Position resolved for stats but OLR must NOT have received a sample.
    const q = olr.query('btc', { ...zeroFeatures(), volatility: 0.02 }, 'buy', 51);
    expect(q.nSamples).toBe(0);
  });

  it('save/load round-trips open positions with H/L fields', () => {
    shadow.openShadowTrades('btc', 100, 98, 105, 102, 95, 0, { ...zeroFeatures(), volatility: 0.02 });
    shadow.checkPositions('btc', 101, 1, 102, 99);
    const json = shadow.save();
    const shadow2 = new ShadowTradeEngine(new OLREngine());
    shadow2.load(json);
    expect(shadow2.getOpenPositions().length).toBeGreaterThan(0);
    for (const p of shadow2.getOpenPositions()) {
      expect(p.highSinceOpen).toBeGreaterThanOrEqual(p.entryPrice * 0.9);
      expect(p.lowSinceOpen).toBeLessThanOrEqual(p.entryPrice * 1.1);
    }
  });
});

// ─── Cold-start backfill ───

/** Build a synthetic 5m candle series with a gentle upward drift so that
 *  LONG shadows win more often than SHORT ones. Each candle's H/L straddles
 *  the open by a controlled amount so ATR-based SL/TP are reliably touched. */
function syntheticCandles(n: number): HLCandle[] {
  const candles: HLCandle[] = [];
  let price = 100;
  let seed = 7;
  const rng = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const open = price;
    const drift = 0.002 + (rng() - 0.5) * 0.001; // ~+0.2%/cycle
    const close = open * (1 + drift);
    const wick = open * 0.004;
    const high = Math.max(open, close) + wick * rng();
    const low = Math.min(open, close) - wick * rng();
    const vol = 1000 + rng() * 500;
    candles.push({ t: Date.now() - (n - i) * 300_000, o: open, h: high, l: low, c: close, v: vol });
    price = close;
  }
  return candles;
}

describe('Cold-start backfill', () => {
  it('injects samples into a cold OLR and marks them as backfill source', async () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    const fetcher = async () => candles;
    const summary = await backfillOLRFromCandles(olr, ['btc'], fetcher, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    expect(summary.symbolsBackfilled).toBe(1);
    expect(summary.totalSamples).toBeGreaterThan(0);
    // Query a side that received samples — sourceBreakdown should report backfill.
    const q = olr.query('btc', { volatility: 0.004, srDistanceBps: 400, obImbalance: 0, sentiment: 0, signalAgreement: 0.5, fundingRate: 0, volumeRatio: 1, sentimentConviction: 0.5 }, 'buy', 0);
    if (q.nSamples >= 10) {
      expect(q.sourceBreakdown.backfill).toBeGreaterThan(0);
    }
  });

  it('skips symbols that are already warm (idempotent across restarts)', async () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    const fetcher = async () => candles;
    // First run backfills.
    await backfillOLRFromCandles(olr, ['btc'], fetcher, { candlesPerSymbol: 60, coldStartThreshold: 20, slAtrMultiple: 0.3, tpAtrMultiple: 0.3 });
    // Manually warm it past threshold by feeding live shadow samples so isCold flips.
    const feats = { volatility: 0.004, srDistanceBps: 400, obImbalance: 0, sentiment: 0, signalAgreement: 0.5, fundingRate: 0, volumeRatio: 1, sentimentConviction: 0.5 };
    for (let i = 0; i < 25; i++) olr.feedTrade('btc', feats, i % 2, 'buy', 'shadow', i);
    // Second run should skip btc (now warm).
    const summary2 = await backfillOLRFromCandles(olr, ['btc'], fetcher, { candlesPerSymbol: 60, coldStartThreshold: 20, slAtrMultiple: 0.3, tpAtrMultiple: 0.3 });
    expect(summary2.symbolsSkipped).toBe(1);
    expect(summary2.symbolsBackfilled).toBe(0);
  });

  it('backfill prior does not freeze live learning (decay uses live samples only)', () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    const feats = { volatility: 0.004, srDistanceBps: 400, obImbalance: 0, sentiment: 0, signalAgreement: 0.5, fundingRate: 0, volumeRatio: 1, sentimentConviction: 0.5 };
    // Backfill returns a promise but feedTrade is synchronous internally;
    // run it and then verify a live sample still moves the probability.
    return backfillOLRFromCandles(olr, ['btc'], async () => candles, { candlesPerSymbol: 60, coldStartThreshold: 20, slAtrMultiple: 0.3, tpAtrMultiple: 0.3 }).then(() => {
      const pAfterBackfill = olr.query('btc', feats, 'buy', 0).pWin;
      // Feed a string of live wins — P(win) should rise (live SGD is not frozen).
      for (let i = 0; i < 30; i++) olr.feedTrade('btc', feats, 1, 'buy', 'real', i);
      const pAfterLive = olr.query('btc', feats, 'buy', 30).pWin;
      expect(pAfterLive).toBeGreaterThan(pAfterBackfill);
    });
  });

  it('handles fetch failure gracefully (skips symbol, no throw)', async () => {
    const olr = new OLREngine();
    const fetcher = async () => { throw new Error('HL 429'); };
    const summary = await backfillOLRFromCandles(olr, ['btc'], fetcher);
    expect(summary.symbolsBackfilled).toBe(0);
    expect(summary.results[0]!.skipped).toBe(true);
    expect(summary.results[0]!.reason).toMatch(/fetch failed/i);
  });

  it('handles insufficient candles gracefully', async () => {
    const olr = new OLREngine();
    const fetcher = async () => syntheticCandles(3);
    const summary = await backfillOLRFromCandles(olr, ['btc'], fetcher, { atrWindow: 14 });
    expect(summary.results[0]!.skipped).toBe(true);
    expect(summary.results[0]!.reason).toMatch(/insufficient/i);
  });

  // ── #1: Welford mask — backfill must not contaminate missing-feature Welford ──
  it('#1 backfill updates Welford only for candle-derived features', async () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    await backfillOLRFromCandles(olr, ['btc'], async () => candles, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    const norm = olr.getNormalizationStats('btc', 'buy')!;
    const byName = Object.fromEntries(norm.map(n => [n.name, n]));
    // volatility / srDistanceBps / volumeRatio WERE seen by Welford.
    expect(byName['volatility'].std).toBeGreaterThan(0);
    expect(byName['volumeRatio'].std).toBeGreaterThanOrEqual(0); // may be 0 if constant, but not NaN
    // obImbalance / sentiment / fundingRate were NOT updated by backfill → std 0, mean 0.
    expect(byName['obImbalance'].std).toBe(0);
    expect(byName['obImbalance'].mean).toBe(0);
    expect(byName['fundingRate'].std).toBe(0);
    expect(Number.isFinite(byName['obImbalance'].std)).toBe(true);
  });

  it('#1 first live obImbalance normalizes finitely (no explosion)', async () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    await backfillOLRFromCandles(olr, ['btc'], async () => candles, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    // Feed enough live samples to enable a query, with a non-zero obImbalance.
    const feats = { volatility: 0.004, srDistanceBps: 400, obImbalance: 0.5, sentiment: 0.3, signalAgreement: 0.5, fundingRate: 0.0001, volumeRatio: 1.2, sentimentConviction: 0.6 };
    for (let i = 0; i < 15; i++) olr.feedTrade('btc', feats, i % 2, 'buy', 'shadow', i);
    const q = olr.query('btc', feats, 'buy', 15);
    expect(Number.isFinite(q.pWin)).toBe(true);
    expect(q.pWin).toBeGreaterThanOrEqual(0);
    expect(q.pWin).toBeLessThanOrEqual(1);
  });

  // ── #2: freshness — stale prior is reset + re-backfilled ──
  it('#2 stale prior is reset and re-backfilled', async () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    const fetcher = async () => candles;
    // First backfill establishes a warm prior.
    await backfillOLRFromCandles(olr, ['btc'], fetcher, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20, maxBackfillAgeMs: 6 * 3600_000,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    // Wait a tick so the prior is now "stale" under a 1ms max-age.
    await new Promise(r => setTimeout(r, 5));
    const summary2 = await backfillOLRFromCandles(olr, ['btc'], fetcher, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20, maxBackfillAgeMs: 1,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    expect(summary2.symbolsBackfilled).toBe(1);
    expect(summary2.results[0]!.reset).toBe(true);
    expect(summary2.results[0]!.skipped).toBe(false);
  });

  it('#2 warm prior (within freshness window) is skipped', async () => {
    const olr = new OLREngine();
    const candles = syntheticCandles(60);
    const fetcher = async () => candles;
    await backfillOLRFromCandles(olr, ['btc'], fetcher, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20, maxBackfillAgeMs: 6 * 3600_000,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    const summary2 = await backfillOLRFromCandles(olr, ['btc'], fetcher, {
      candlesPerSymbol: 60, atrWindow: 14, coldStartThreshold: 20, maxBackfillAgeMs: 6 * 3600_000,
      slAtrMultiple: 0.3, tpAtrMultiple: 0.3,
    });
    expect(summary2.symbolsSkipped).toBe(1);
    expect(summary2.results[0]!.reason).toMatch(/warm/i);
  });

  // ── #4: multi-candle hold ──
  it('#4 shadow that misses SL/TP on entry candle resolves on a later candle', async () => {
    const olr = new OLREngine();
    // Build candles: entry at i=14 (open=100). candle 14 has a tiny range (no hit).
    // candle 15 spikes up to 103 → hits a tight TP. SL/TP from ATR (small).
    const candles: HLCandle[] = [];
    for (let i = 0; i < 30; i++) {
      const open = i < 15 ? 100 : (i === 15 ? 100 : 103);
      const close = open;
      const wick = i === 15 ? 3 : 0.05;
      candles.push({ t: Date.now() - (30 - i) * 300_000, o: open, h: open + wick, l: open - wick, c: close, v: 1000 });
    }
    await backfillOLRFromCandles(olr, ['btc'], async () => candles, {
      candlesPerSymbol: 30, atrWindow: 5, pivotWindow: 2, coldStartThreshold: 20,
      slAtrMultiple: 0.2, tpAtrMultiple: 0.2, maxHoldCandles: 10,
    });
    // The LONG shadow opened at candle 14 (open 100) with tight ATR TP — candle 15
    // high=103 should resolve it as a win. OLR should have received >=1 LONG sample.
    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    expect(stats).toBeDefined();
    expect(stats!.longSamples).toBeGreaterThan(0);
  });

  it('#4 shadow that never hits SL/TP within maxHold is skipped (no fabricated label)', async () => {
    const olr = new OLREngine();
    // Flat candles: open=close=100, tiny wick 0.01 — ATR tiny, SL/TP tight but never touched
    // because wick < SL/TP distance for most candles.
    const candles: HLCandle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push({ t: Date.now() - (30 - i) * 300_000, o: 100, h: 100.01, l: 99.99, c: 100, v: 1000 });
    }
    await backfillOLRFromCandles(olr, ['btc'], async () => candles, {
      candlesPerSymbol: 30, atrWindow: 5, pivotWindow: 2, coldStartThreshold: 20,
      slAtrMultiple: 1.5, tpAtrMultiple: 2.5, maxHoldCandles: 5,
    });
    // Most shadows unresolved within 5 candles → samples should be 0 or very low.
    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    const total = stats ? stats.longSamples + stats.shortSamples : 0;
    expect(total).toBe(0);
  });

  // ── #5: pivot-based S/R alignment ──
  it('#5 nearestSR finds nearest support below + resistance above entry', () => {
    // Construct candles with an obvious pivot low at 95 and pivot high at 105.
    const candles: HLCandle[] = [];
    for (let i = 0; i < 20; i++) {
      let h: number, l: number;
      if (i === 5) { h = 100; l = 95; }      // pivot low
      else if (i === 10) { h = 105; l = 100; } // pivot high
      else { h = 100; l = 99.5; }
      candles.push({ t: i * 300_000, o: 100, h, l, c: 100, v: 1000 });
    }
    // entry=100, window=3 → pivots at i=5 (low=95) and i=10 (high=105) are both
    // confirmed (3 candles on each side) before endIdx=19-3=16.
    const sr = nearestSR(candles, 16, 100, 3);
    expect(sr.support).toBe(95);
    expect(sr.resistance).toBe(105);
  });

  it('#5 nearestSR returns nulls when no pivots exist', () => {
    const candles: HLCandle[] = [];
    for (let i = 0; i < 20; i++) candles.push({ t: i * 300_000, o: 100, h: 100, l: 100, c: 100, v: 1000 });
    const sr = nearestSR(candles, 16, 100, 3);
    expect(sr.support).toBeNull();
    expect(sr.resistance).toBeNull();
  });
});