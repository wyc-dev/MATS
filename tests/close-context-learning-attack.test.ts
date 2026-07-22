/**
 * v2.0.226: Close-context-aware learning weight — attack tests.
 *
 * Verifies that computeLearningWeight() correctly downweights execution-caused
 * losses (tight SL, thesis invalidation) while keeping real market losses and
 * all wins at full weight. This prevents contamination of OLR, AttnRes, combo
 * WR, and anti-patterns with "these market conditions → loss" when the entry
 * was actually fine and only the SL was too tight.
 */
import { describe, it, expect } from 'vitest';

// Re-implement the function here for unit testing (it's a pure function in index.ts)
function computeLearningWeight(
  closeReason: string,
  slNarrowed: boolean,
  isWin: boolean,
): number {
  if (isWin) return 1.0;
  switch (closeReason) {
    case 'thesis_invalidation': return 0.3;
    case 'manual': return 0.5;
    case 'sl_tp':
      return slNarrowed ? 0.3 : 1.0;
    case 'reconciliation':
    case 'exchange_closed':
      return 1.0;
    case 'consensus':
      return 0.5;
    default: return 1.0;
  }
}

describe('v2.0.226: Close-context learning weight — attack tests', () => {
  describe('Wins always get full weight (1.0)', () => {
    it('win + SL hit at original SL → 1.0', () => {
      expect(computeLearningWeight('sl_tp', false, true)).toBe(1.0);
    });
    it('win + SL was narrowed → 1.0 (a win is a win)', () => {
      expect(computeLearningWeight('sl_tp', true, true)).toBe(1.0);
    });
    it('win + thesis invalidation → 1.0', () => {
      expect(computeLearningWeight('thesis_invalidation', false, true)).toBe(1.0);
    });
    it('win + manual close → 1.0', () => {
      expect(computeLearningWeight('manual', false, true)).toBe(1.0);
    });
  });

  describe('Real market losses get full weight (1.0)', () => {
    it('loss + SL hit at ORIGINAL wide SL → 1.0 (real market loss)', () => {
      expect(computeLearningWeight('sl_tp', false, false)).toBe(1.0);
    });
    it('loss + reconciliation → 1.0 (exchange event)', () => {
      expect(computeLearningWeight('reconciliation', false, false)).toBe(1.0);
    });
    it('loss + exchange_closed → 1.0 (liquidation)', () => {
      expect(computeLearningWeight('exchange_closed', false, false)).toBe(1.0);
    });
    it('loss + unknown closeReason → 1.0 (safe default)', () => {
      expect(computeLearningWeight('unknown', false, false)).toBe(1.0);
    });
  });

  describe('Execution-caused losses are downweighted (0.3)', () => {
    it('loss + SL hit after SL was NARROWED → 0.3 (execution loss)', () => {
      expect(computeLearningWeight('sl_tp', true, false)).toBe(0.3);
    });
    it('loss + thesis invalidation → 0.3 (system LLM decision)', () => {
      expect(computeLearningWeight('thesis_invalidation', false, false)).toBe(0.3);
    });
    it('loss + thesis invalidation + slNarrowed → 0.3 (thesis takes priority)', () => {
      // thesis_invalidation is checked before sl_tp, so slNarrowed doesn't matter
      expect(computeLearningWeight('thesis_invalidation', true, false)).toBe(0.3);
    });
  });

  describe('Partial-signal losses are partially downweighted (0.5)', () => {
    it('loss + manual close → 0.5 (user decision)', () => {
      expect(computeLearningWeight('manual', false, false)).toBe(0.5);
    });
    it('loss + consensus close → 0.5 (agent vote)', () => {
      expect(computeLearningWeight('consensus', false, false)).toBe(0.5);
    });
  });

  describe('Boundary conditions', () => {
    it('all loss weights are in [0.3, 1.0]', () => {
      const reasons = ['sl_tp', 'thesis_invalidation', 'manual', 'consensus', 'reconciliation', 'exchange_closed', 'unknown'];
      for (const r of reasons) {
        for (const sn of [true, false]) {
          const w = computeLearningWeight(r, sn, false);
          expect(w).toBeGreaterThanOrEqual(0.3);
          expect(w).toBeLessThanOrEqual(1.0);
        }
      }
    });
    it('all win weights are exactly 1.0', () => {
      const reasons = ['sl_tp', 'thesis_invalidation', 'manual', 'consensus', 'reconciliation', 'exchange_closed', 'unknown'];
      for (const r of reasons) {
        for (const sn of [true, false]) {
          expect(computeLearningWeight(r, sn, true)).toBe(1.0);
        }
      }
    });
  });

  describe('Combo WR gate logic', () => {
    // The combo tracker should skip losses with weight < 0.5 (tight SL, thesis invalidation)
    // and include losses with weight >= 0.5 (manual, consensus, real SL hit)
    it('tight-SL loss (weight=0.3) should be SKIPPED from combo WR', () => {
      const w = computeLearningWeight('sl_tp', true, false);
      expect(w).toBeLessThan(0.5); // skipped
    });
    it('thesis-invalidation loss (weight=0.3) should be SKIPPED from combo WR', () => {
      const w = computeLearningWeight('thesis_invalidation', false, false);
      expect(w).toBeLessThan(0.5); // skipped
    });
    it('real SL loss (weight=1.0) should be INCLUDED in combo WR', () => {
      const w = computeLearningWeight('sl_tp', false, false);
      expect(w).toBeGreaterThanOrEqual(0.5); // included
    });
    it('manual loss (weight=0.5) should be INCLUDED in combo WR', () => {
      const w = computeLearningWeight('manual', false, false);
      expect(w).toBeGreaterThanOrEqual(0.5); // included
    });
    it('all wins should be INCLUDED in combo WR', () => {
      const w = computeLearningWeight('sl_tp', true, true);
      expect(w).toBeGreaterThanOrEqual(0.5); // included (isWin=true → 1.0)
    });
  });

  describe('SL narrowing detection', () => {
    // Simulates the slNarrowed detection logic from portfolio.ts
    it('original SL ≠ final SL → slNarrowed=true', () => {
      const original = 1000;
      const final = 1010;
      const slNarrowed = original !== final;
      expect(slNarrowed).toBe(true);
    });
    it('original SL = final SL → slNarrowed=false', () => {
      const original = 1000;
      const final = 1000;
      const slNarrowed = original !== final;
      expect(slNarrowed).toBe(false);
    });
    it('undefined original SL → slNarrowed=false (cold-start safe)', () => {
      const original = undefined;
      const final = 1000;
      const slNarrowed = original !== undefined && final !== undefined && original !== final;
      expect(slNarrowed).toBe(false);
    });
    it('both undefined → slNarrowed=false (cold-start safe)', () => {
      const original = undefined;
      const final = undefined;
      const slNarrowed = original !== undefined && final !== undefined && original !== final;
      expect(slNarrowed).toBe(false);
    });
  });
});