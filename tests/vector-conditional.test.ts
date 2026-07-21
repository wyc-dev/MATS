import { describe, it, expect } from 'vitest';
import {
  computeVectorConditionalWinRate,
  formatVectorConditional,
  wilsonScore,
  ENTRY_CONDITION_FEATURES,
} from '../src/evolution/evolution-utils.ts';

// ─── Test fixtures ───
// Records use the same shape the production callers pass:
//   ThesisExperienceRecord (outcome: 'WIN' | 'LOSS')
//   PatternTagRecord        (outcome: 'win' | 'loss')
// The utility normalises outcome case-insensitively, so both work.

interface Rec {
  marketFeatures?: Record<string, number>;
  outcome: string;
  symbol: string;
  side: 'buy' | 'sell';
  pnl?: number;
}

const baseFeatures = (over: Partial<Record<string, number>> = {}): Record<string, number> => ({
  volatility: 0.02,
  srDistanceBps: 100,
  obImbalance: 0.3,
  fundingRate: 0.0001,
  volumeRatio: 1.2,
  signalAgreement: 0.6,
  sentiment: 0.1,
  sentimentConviction: 0.5,
  regimeOrdinal: 0.5,
  ...over,
});

describe('computeVectorConditionalWinRate', () => {
  it('returns neutral 0.5 + confidence=none when no records have marketFeatures', () => {
    const recs: Rec[] = [
      { outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
      { outcome: 'LOSS', symbol: 'ETH', side: 'sell', pnl: -1 },
    ];
    const r = computeVectorConditionalWinRate(baseFeatures(), recs, { side: 'buy' });
    expect(r.conditionalWinRate).toBe(0.5);
    expect(r.confidence).toBe('none');
    expect(r.sampleSize).toBe(0);
  });

  it('returns neutral when filtered set is empty (side mismatch)', () => {
    const recs: Rec[] = [
      { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
    ];
    const r = computeVectorConditionalWinRate(baseFeatures(), recs, { side: 'sell' });
    expect(r.conditionalWinRate).toBe(0.5);
    expect(r.confidence).toBe('none');
  });

  it('matches similar trades and computes conditional win rate (cross-symbol)', () => {
    // Candidate: vol=0.02, ob=0.3, regime=neutral. Two similar historical trades
    // on DIFFERENT symbols (BTC, ETH) — cross-symbol matching is the whole point.
    const recs: Rec[] = [
      { marketFeatures: baseFeatures({ volatility: 0.021 }), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1.2 },
      { marketFeatures: baseFeatures({ volatility: 0.019 }), outcome: 'WIN', symbol: 'ETH', side: 'buy', pnl: 0.8 },
      { marketFeatures: baseFeatures({ volatility: 0.020 }), outcome: 'LOSS', symbol: 'SOL', side: 'buy', pnl: -0.5 },
      // Dissimilar: very different volatility + regime
      { marketFeatures: baseFeatures({ volatility: 0.08, regimeOrdinal: 0.1 }), outcome: 'WIN', symbol: 'DOGE', side: 'buy', pnl: 2 },
    ];
    const r = computeVectorConditionalWinRate(baseFeatures(), recs, { side: 'buy', threshold: 0.80, minSamples: 3 });
    // 3 similar trades (2W/1L) should be matched; the dissimilar DOGE trade excluded.
    expect(r.sampleSize).toBeGreaterThanOrEqual(3);
    expect(r.wins).toBeGreaterThanOrEqual(2);
    expect(r.conditionalWinRate).toBeGreaterThan(0.5);
  });

  it('returns confidence=none when similar trades < minSamples', () => {
    const recs: Rec[] = [
      { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
    ];
    const r = computeVectorConditionalWinRate(baseFeatures(), recs, { side: 'buy', minSamples: 3 });
    expect(r.confidence).toBe('none');
    expect(r.conditionalWinRate).toBe(0.5);
  });

  it('filters by symbol when symbol option is provided', () => {
    const recs: Rec[] = [
      { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
      { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
      { marketFeatures: baseFeatures(), outcome: 'LOSS', symbol: 'ETH', side: 'buy', pnl: -1 },
    ];
    const r = computeVectorConditionalWinRate(baseFeatures(), recs, { side: 'buy', symbol: 'BTC', minSamples: 2 });
    expect(r.sampleSize).toBe(2);
    expect(r.wins).toBe(2);
  });

  it('skips missing feature dimensions (does not zero-fill)', () => {
    // Candidate has only volatility + obImbalance. Records have those + others.
    // Similarity should still work on the shared dimensions. The point is it
    // doesn't crash on missing features and only uses the shared dims.
    const recs: Rec[] = [
      { marketFeatures: { volatility: 0.02, obImbalance: 0.3 }, outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
      { marketFeatures: { volatility: 0.021, obImbalance: 0.31 }, outcome: 'WIN', symbol: 'ETH', side: 'buy', pnl: 1 },
      { marketFeatures: { volatility: 0.019, obImbalance: 0.29 }, outcome: 'LOSS', symbol: 'SOL', side: 'buy', pnl: -1 },
    ];
    const r = computeVectorConditionalWinRate(
      { volatility: 0.02, obImbalance: 0.3 },
      recs,
      { side: 'buy', minSamples: 3, threshold: 0.0 },
    );
    // With 2 usable dims (volatility + obImbalance), sharedDims >= 2 satisfies the guard.
    expect(r.usedFeatures).toContain('volatility');
    expect(r.usedFeatures).toContain('obImbalance');
    expect(r.sampleSize).toBeGreaterThan(0);
  });

  it('normalises outcome case-insensitively (WIN/win/LOSE/loss)', () => {
    const recs: Rec[] = [
      { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
      { marketFeatures: baseFeatures(), outcome: 'win', symbol: 'ETH', side: 'buy', pnl: 1 },
      { marketFeatures: baseFeatures(), outcome: 'LOSS', symbol: 'SOL', side: 'buy', pnl: -1 },
    ];
    const r = computeVectorConditionalWinRate(baseFeatures(), recs, { side: 'buy', minSamples: 3, threshold: 0.0 });
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
  });

  it('wilsonWinRate penalises small samples', () => {
    // 2 identical WIN trades → raw 100% but wilson must be < 1.0.
    const r = computeVectorConditionalWinRate(
      baseFeatures(),
      [
        { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
        { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'ETH', side: 'buy', pnl: 1 },
      ],
      { side: 'buy', minSamples: 2, threshold: 0.0 },
    );
    expect(r.conditionalWinRate).toBe(1.0);
    expect(r.wilsonWinRate).toBeLessThan(1.0);
    expect(r.wilsonWinRate).toBe(wilsonScore(2, 2));
  });

  it('confidence escalates with sample size', () => {
    const makeRecs = (n: number): Rec[] =>
      Array.from({ length: n }, (_, i) => ({
        marketFeatures: baseFeatures({ volatility: 0.02 + (i % 3) * 0.0001 }),
        outcome: i % 2 === 0 ? 'WIN' : 'LOSS',
        symbol: `SYM${i % 5}`,
        side: 'buy' as const,
        pnl: i % 2 === 0 ? 1 : -1,
      }));
    const low = computeVectorConditionalWinRate(baseFeatures(), makeRecs(4), { side: 'buy', minSamples: 3, threshold: 0.0 });
    const med = computeVectorConditionalWinRate(baseFeatures(), makeRecs(15), { side: 'buy', minSamples: 3, threshold: 0.0 });
    const high = computeVectorConditionalWinRate(baseFeatures(), makeRecs(35), { side: 'buy', minSamples: 3, threshold: 0.0, topN: 40 });
    expect(low.confidence).toBe('low');
    expect(med.confidence).toBe('medium');
    expect(high.confidence).toBe('high');
  });
});

describe('formatVectorConditional', () => {
  it('renders explanation when confidence is none', () => {
    const r = computeVectorConditionalWinRate({}, [], { side: 'buy' });
    const s = formatVectorConditional(r, 'BTC BUY');
    expect(s).toContain('BTC BUY');
  });

  it('renders compact stats when confidence is present', () => {
    const r = computeVectorConditionalWinRate(
      baseFeatures(),
      [
        { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'BTC', side: 'buy', pnl: 1 },
        { marketFeatures: baseFeatures(), outcome: 'WIN', symbol: 'ETH', side: 'buy', pnl: 1 },
        { marketFeatures: baseFeatures(), outcome: 'LOSS', symbol: 'SOL', side: 'buy', pnl: -1 },
      ],
      { side: 'buy', minSamples: 3, threshold: 0.0 },
    );
    const s = formatVectorConditional(r, 'BTC BUY');
    expect(s).toContain('BTC BUY');
    expect(s).toContain('%');
  });
});

describe('ENTRY_CONDITION_FEATURES', () => {
  it('has 9 canonical entry-condition features', () => {
    expect(ENTRY_CONDITION_FEATURES.length).toBe(9);
    expect(ENTRY_CONDITION_FEATURES).toContain('volatility');
    expect(ENTRY_CONDITION_FEATURES).toContain('regimeOrdinal');
    // Must NOT contain outcome-only features
    expect(ENTRY_CONDITION_FEATURES).not.toContain('mfePct');
    expect(ENTRY_CONDITION_FEATURES).not.toContain('maePct');
  });
});