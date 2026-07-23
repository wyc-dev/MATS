/**
 * v2.0.226 / v2.0.211: Close-context-aware learning weight — attack tests.
 *
 * Verifies that computeLearningWeight() correctly downweights execution-caused
 * losses (tight SL, thesis invalidation) AND — since v2.0.211 — also downweights
 * system-decision closes even when they happen to be profitable. This prevents
 * contamination of OLR, AttnRes, combo WR, and anti-patterns with "these market
 * conditions → win/loss" when the outcome was actually a system/user decision,
 * not a clean market SL/TP trigger.
 *
 * v2.0.211 fix: the real function now lives in src/evolution/learning-weight.ts
 * (extracted from src/index.ts for testability). This test imports the REAL
 * function — no local re-implementation (the previous version re-implemented the
 * function locally and tautologically asserted the OLD buggy behavior where
 * `win + thesis_invalidation → 1.0`; that was the bug the v2.0.211 fix corrects).
 */
import { describe, it, expect } from 'vitest';
import { computeLearningWeight } from '../src/evolution/learning-weight.ts';

describe('v2.0.226 / v2.0.211: Close-context learning weight — attack tests', () => {
  describe('Clean-market wins get full weight (1.0)', () => {
    it('win + SL hit at original SL → 1.0', () => {
      expect(computeLearningWeight('sl_tp', false, true)).toBe(1.0);
    });
    it('win + SL was narrowed → 1.0 (a clean-market win is a win)', () => {
      expect(computeLearningWeight('sl_tp', true, true)).toBe(1.0);
    });
    it('win + reconciliation → 1.0', () => {
      expect(computeLearningWeight('reconciliation', false, true)).toBe(1.0);
    });
    it('win + exchange_closed → 1.0', () => {
      expect(computeLearningWeight('exchange_closed', false, true)).toBe(1.0);
    });
  });

  // ─── v2.0.211 fix: system-decision closes discounted REGARDLESS of isWin ───
  // Before the fix, `if (isWin) return 1.0` ran first, so a profitable system
  // force-close (e.g. a $1.95 thesis_invalidation close) was learned at full
  // weight 1.0 — as if the market had cleanly confirmed the entry. But a system
  // force-close is NOT a clean market signal; the PnL is partial/noisy.
  describe('v2.0.211: System-decision closes discounted even when profitable', () => {
    it('win + thesis_invalidation → 0.3 (was 1.0 — THE BUG)', () => {
      expect(computeLearningWeight('thesis_invalidation', false, true)).toBe(0.3);
    });
    it('win + thesis_invalidation + slNarrowed → 0.3 (system close takes priority)', () => {
      expect(computeLearningWeight('thesis_invalidation', true, true)).toBe(0.3);
    });
    it('win + manual close → 0.5 (user decision, partial signal)', () => {
      expect(computeLearningWeight('manual', false, true)).toBe(0.5);
    });
    it('win + consensus close → 0.5 (agent vote, not a clean market trigger)', () => {
      expect(computeLearningWeight('consensus', false, true)).toBe(0.5);
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
});