// ─── Execution Lens SL/TP Tests (v2.0.213, K.md #7) ───
// Tests that computeATRSLTP uses the execution lens as PRIMARY signal,
// and falls back to the original ATR + momentum logic when the lens
// is unavailable (cold-start, not blended, or wExecution untrained).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeATRSLTP,
  setExecutionLensProvider,
  prepareExecutionLens,
  clearExecutionLens,
} from '../src/analysis/atr.ts';

describe('computeATRSLTP — v2.0.213 Execution Lens integration', () => {
  const ENTRY = 100;
  const ATR = 1.5; // 1.5 price units
  // Baseline: slDist = 1.5×ATR = 2.25. R:R floor: tpDist = max(2×ATR=3, 1.6×2.25=3.6) = 3.6.
  const BASE_SL_DIST = 1.5 * ATR; // 2.25
  const BASE_TP_DIST = Math.max(2 * ATR, BASE_SL_DIST * 1.6); // 3.6

  afterEach(() => {
    clearExecutionLens();
    setExecutionLensProvider(null);
  });

  describe('Fallback: no execution lens (cold-start)', () => {
    it('no provider wired → original ATR logic with R:R floor', () => {
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result).not.toBeNull();
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
      expect(result!.tp).toBeCloseTo(ENTRY + BASE_TP_DIST, 6);
    });

    it('provider wired but symbol not prepared → fallback', () => {
      setExecutionLensProvider(() => ({
        volatility: 0.05, momentumShort: -0.03, momentumLong: -0.02,
        entropy: 0.5, blended: true, updateCount: 10,
      }));
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
    });

    it('lens not blended (cold-start) → fallback', () => {
      setExecutionLensProvider(() => ({
        volatility: 0, momentumShort: 0, momentumLong: 0,
        entropy: 0, blended: false, updateCount: 0,
      }));
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
    });

    it('lens blended but updateCount=0 (wExecution untrained) → fallback', () => {
      setExecutionLensProvider(() => ({
        volatility: 0.05, momentumShort: -0.03, momentumLong: -0.02,
        entropy: 0.5, blended: true, updateCount: 0,
      }));
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
    });

    it('raw adverseMomentum still works in fallback mode (capped at 5%)', () => {
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0, 0.03);
      // slDist = max(2.25, 0.03×100×2.5=7.5) = 7.5, capped at 5% = 5
      expect(result!.sl).toBeCloseTo(ENTRY - 5, 6);
    });
  });

  describe('Primary: execution lens active (wExecution trained)', () => {
    beforeEach(() => {
      setExecutionLensProvider(() => ({
        volatility: 0.05, momentumShort: -0.03, momentumLong: -0.02,
        entropy: 0.5, blended: true, updateCount: 10,
      }));
      prepareExecutionLens('BTC');
    });

    it('execution adverse momentum widens SL (capped at 6% for exec lens)', () => {
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      // BUY: adverse = max(0, -(-0.03)) = 0.03
      // execMomSlDist = 0.03 × 100 × 2.5 = 7.5
      // slDist = max(2.25, 7.5) = 7.5, capped at 6% = 6
      expect(result!.sl).toBeCloseTo(ENTRY - 6, 4);
    });

    it('execution lens caps at 6% SL (wider than raw momentum 5%)', () => {
      // Extreme adverse: 10% → momentumSlDist = 25, but capped at 6%
      setExecutionLensProvider(() => ({
        volatility: 0.01, momentumShort: -0.10, momentumLong: -0.05,
        entropy: 0.5, blended: true, updateCount: 10,
      }));
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - 6, 4); // capped at 6%
    });

    it('execution volatility scaling widens SL (no adverse momentum)', () => {
      setExecutionLensProvider(() => ({
        volatility: 0.05, momentumShort: 0, momentumLong: 0,
        entropy: 0.5, blended: true, updateCount: 10,
      }));
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      const slDist = ENTRY - result!.sl;
      // currentImpliedVol = 1.5/100 = 0.015. execVol=0.05 > 0.0225 → widen.
      // volRatio = min(0.05/0.015, 3.0) = 3.0. widenFactor = 1.4.
      // volSlDist = 2.25 × 1.4 = 3.15. Capped at 6% = 6 → 3.15.
      expect(slDist).toBeGreaterThan(BASE_SL_DIST);
      expect(slDist).toBeCloseTo(3.15, 4);
    });

    it('high entropy dampens execution lens widening', () => {
      setExecutionLensProvider(() => ({
        volatility: 0.05, momentumShort: -0.03, momentumLong: -0.02,
        entropy: 3.0, // high = uncertain → dampen 50%
        blended: true, updateCount: 10,
      }));
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      const slDist = ENTRY - result!.sl;
      // Without dampening: momentum SL = 7.5, capped at 6 → 6
      // With dampening: execWidening = 7.5 - 2.25 = 5.25, damped = 2.25 + 5.25×0.5 = 4.875
      // But then the max with slMult*atr = 2.25 → 4.875. Capped at 6 → 4.875.
      expect(slDist).toBeLessThan(6); // dampened below cap
      expect(slDist).toBeGreaterThan(BASE_SL_DIST); // still wider than baseline
    });

    it('raw adverseMomentum acts as floor (never narrow below raw)', () => {
      // Execution lens has NO adverse momentum, but raw says 3%
      setExecutionLensProvider(() => ({
        volatility: 0.01, momentumShort: 0, momentumLong: 0,
        entropy: 0.5, blended: true, updateCount: 10,
      }));
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0, 0.03);
      const slDist = ENTRY - result!.sl;
      // Raw floor: 0.03 × 100 × 2.5 = 7.5, but exec lens cap = 6% → 6
      expect(slDist).toBeCloseTo(6, 4);
    });

    it('TP maintains R:R ≥ 1.6:1 with execution-lens-widened SL', () => {
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      const slDist = ENTRY - result!.sl;
      const tpDist = result!.tp - ENTRY;
      expect(tpDist).toBeGreaterThanOrEqual(slDist * 1.6 - 0.01);
    });

    it('SELL with favorable momentum (falling price) → no adverse widening', () => {
      // momentumShort = -0.03 (falling). SELL: adverse = max(0, -0.03) = 0.
      // But vol scaling: 0.05 > 0.0225 → widen.
      const result = computeATRSLTP(ENTRY, ATR, 'sell', 1.5, 2.0);
      const slDist = result!.sl - ENTRY; // SELL: SL above entry
      // volSlDist = 3.15 (from vol scaling). No momentum widening.
      expect(slDist).toBeGreaterThan(BASE_SL_DIST);
      expect(slDist).toBeCloseTo(3.15, 4);
    });
  });

  describe('Clear / cleanup', () => {
    it('clearExecutionLens removes pending lens → fallback', () => {
      setExecutionLensProvider(() => ({
        volatility: 0.05, momentumShort: -0.03, momentumLong: -0.02,
        entropy: 0.5, blended: true, updateCount: 10,
      }));
      prepareExecutionLens('BTC');
      clearExecutionLens();
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
    });

    it('provider returns null → fallback', () => {
      setExecutionLensProvider(() => null);
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
    });

    it('provider throws → fallback (no crash)', () => {
      setExecutionLensProvider(() => { throw new Error('test'); });
      prepareExecutionLens('BTC');
      const result = computeATRSLTP(ENTRY, ATR, 'buy', 1.5, 2.0);
      expect(result!.sl).toBeCloseTo(ENTRY - BASE_SL_DIST, 6);
    });
  });
});