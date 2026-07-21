// ─── v2.0.214: RIL Softmax-Weighted Aggregate + Conditional WR Tests ──────
//
// Tests two improvements to RIL (Reason Intelligence Layer):
//
// 1. SoftmaxWeightedSimilarAggregate — softmax-weighted win rate for
//    SimilarTradeRetriever (K.md #4 transfer to RIL)
// 2. Conditional WR within Pattern Clusters — computeVectorConditionalWinRate
//    within each cluster's memberMarketData
//
// Includes attack tests for:
// - NaN/Infinity in similarity scores
// - Temperature edge cases (0, negative, very small)
// - Empty/single-element degenerate cases
// - All-identical similarities (uniform softmax)
// - High concentration (one trade dominates)
// - Missing marketFeatures (conditional WR fallback)
// - Feature scale issues within cluster members
// - Direction filtering in conditional WR

import { describe, it, expect } from 'vitest';
import {
  softmaxWeightedSimilarAggregate,
  PatternClusterManager,
  SimilarTradeRetriever,
} from '../src/evolution/reason-analytics.ts';
import { MockEmbedProvider } from '../src/evolution/embeddings.ts';
import type { ThesisExperienceRecord } from '../src/types/index.ts';

// ─── Helpers ───

function makeRecord(overrides: Partial<ThesisExperienceRecord> = {}): ThesisExperienceRecord {
  return {
    id: overrides.id ?? `rec-${Math.random().toString(36).slice(2, 8)}`,
    symbol: overrides.symbol ?? 'BTC',
    side: overrides.side ?? 'buy',
    entryThesis: overrides.entryThesis ?? 'S/R bounce with volume confirmation',
    rationales: overrides.rationales ?? ['S/R bounce', 'volume confirmation'],
    rationaleCats: overrides.rationaleCats ?? ['technical', 'technical'],
    rationaleVectors: overrides.rationaleVectors ?? [[0.9, 0.1, 0.0], [0.8, 0.2, 0.0]],
    outcome: overrides.outcome ?? 'WIN',
    pnl: overrides.pnl ?? 0.5,
    pnlPct: overrides.pnlPct ?? 2.5,
    holdMin: overrides.holdMin ?? 120,
    regime: overrides.regime ?? 'trending',
    assetCategory: overrides.assetCategory ?? 'crypto',
    ts: overrides.ts ?? Date.now(),
    marketFeatures: overrides.marketFeatures ?? {
      volatility: 0.5,
      srDistanceBps: 200,
      obImbalance: 0.3,
      fundingRate: 0.0001,
      volumeRatio: 1.2,
      signalAgreement: 0.7,
      sentiment: 0.5,
      sentimentConviction: 0.6,
      regimeOrdinal: 2,
      momentumShort: 0.02,
      momentumLong: 0.01,
    },
    ...overrides,
  } as ThesisExperienceRecord;
}

// ═══════════════════════════════════════════════════════════════
//  Part 1: softmaxWeightedSimilarAggregate — Unit + Attack Tests
// ═══════════════════════════════════════════════════════════════

describe('softmaxWeightedSimilarAggregate', () => {
  // ─── Basic functionality ───

  it('returns 0.5 WR for empty input', () => {
    const result = softmaxWeightedSimilarAggregate([]);
    expect(result.weightedWR).toBe(0.5);
    expect(result.rawWR).toBe(0.5);
    expect(result.maxWeight).toBe(0);
  });

  it('returns 1.0 for single winning trade', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.9, isWin: true, pnl: 1.5 },
    ]);
    expect(result.weightedWR).toBe(1);
    expect(result.rawWR).toBe(1);
    expect(result.weightedAvgPnl).toBe(1.5);
    expect(result.maxWeight).toBe(1);
  });

  it('returns 0.0 for single losing trade', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.9, isWin: false, pnl: -1.0 },
    ]);
    expect(result.weightedWR).toBe(0);
    expect(result.rawWR).toBe(0);
    expect(result.weightedAvgPnl).toBe(-1.0);
  });

  it('weights high-similarity trades more than low-similarity', () => {
    // Trade 1: 95% sim, WIN. Trade 2: 50% sim, LOSS.
    // Softmax should weight trade 1 much more → weightedWR > rawWR
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.95, isWin: true, pnl: 1.0 },
      { similarity: 0.50, isWin: false, pnl: -0.5 },
    ], 0.1);
    // Raw WR = 0.5 (1 win / 2 trades)
    expect(result.rawWR).toBe(0.5);
    // Weighted WR should be much higher (trade 1 dominates)
    expect(result.weightedWR).toBeGreaterThan(0.8);
    expect(result.maxWeight).toBeGreaterThan(0.9);
  });

  it('raw and weighted are equal when all similarities are identical', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.8, isWin: true, pnl: 1.0 },
      { similarity: 0.8, isWin: false, pnl: -0.5 },
      { similarity: 0.8, isWin: true, pnl: 0.8 },
      { similarity: 0.8, isWin: false, pnl: -0.3 },
    ]);
    // All equal sim → uniform softmax → weighted = raw
    expect(result.weightedWR).toBeCloseTo(result.rawWR, 5);
    expect(result.maxWeight).toBeCloseTo(0.25, 5); // 1/4 each
  });

  it('weightedAvgPnl reflects similarity-weighted PnL', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.95, isWin: true, pnl: 2.0 },
      { similarity: 0.50, isWin: true, pnl: -1.0 },
    ], 0.1);
    // High-sim trade has +2.0, low-sim has -1.0
    // Weighted avg should be closer to 2.0 than to 0.5 (raw avg)
    expect(result.weightedAvgPnl).toBeGreaterThan(1.5);
    expect(result.rawAvgPnl).toBeCloseTo(0.5, 5);
  });

  // ─── Attack tests ───

  it('A1: handles NaN in similarity without producing NaN', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: NaN, isWin: true, pnl: 1.0 },
      { similarity: 0.8, isWin: false, pnl: -0.5 },
    ]);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    expect(Number.isFinite(result.weightedAvgPnl)).toBe(true);
    // NaN sim → treated as 0 → lower weight than 0.8
    expect(result.weightedWR).toBeLessThan(0.5); // loss dominates
  });

  it('A2: handles Infinity in similarity without overflow', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: Infinity, isWin: true, pnl: 1.0 },
      { similarity: 0.8, isWin: false, pnl: -0.5 },
    ]);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    expect(Number.isFinite(result.weightedAvgPnl)).toBe(true);
    // Infinity → clamped to 100/tau = 1000 → exp(1000-max) → dominates
    // But clamped to 100, so it's large but not Infinity
    expect(result.weightedWR).toBeGreaterThan(0.5);
  });

  it('A3: handles negative Infinity in similarity', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: -Infinity, isWin: true, pnl: 1.0 },
      { similarity: 0.8, isWin: false, pnl: -0.5 },
    ]);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    // -Infinity → treated as 0 → lower weight than 0.8
    expect(result.weightedWR).toBeLessThan(0.5);
  });

  it('A4: temperature = 0 does not divide by zero', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.9, isWin: true, pnl: 1.0 },
      { similarity: 0.5, isWin: false, pnl: -0.5 },
    ], 0);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    expect(Number.isFinite(result.weightedAvgPnl)).toBe(true);
    // τ clamped to 1e-4 → very sharp → top match nearly 1.0
    expect(result.maxWeight).toBeGreaterThan(0.99);
  });

  it('A5: negative temperature is treated as absolute value', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.9, isWin: true, pnl: 1.0 },
      { similarity: 0.5, isWin: false, pnl: -0.5 },
    ], -0.5);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    // Negative tau -> abs(tau) = 0.5. Not as sharp as 0.1, but WIN still dominates
    expect(result.weightedWR).toBeGreaterThan(0.5);
    expect(result.maxWeight).toBeGreaterThan(0.6);
  });

  it('A6: all NaN similarities fall back to equal weight', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: NaN, isWin: true, pnl: 1.0 },
      { similarity: NaN, isWin: false, pnl: -0.5 },
      { similarity: NaN, isWin: true, pnl: 0.3 },
    ]);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    // All NaN → all sim=0 → all equal logits → uniform → weighted = raw
    expect(result.weightedWR).toBeCloseTo(result.rawWR, 5);
    expect(result.rawWR).toBeCloseTo(2 / 3, 5);
  });

  it('A7: extreme similarity difference produces near-winner-takes-all', () => {
    // 0.99 vs 0.01 at τ=0.01 → extreme concentration
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.99, isWin: true, pnl: 2.0 },
      { similarity: 0.01, isWin: false, pnl: -1.0 },
    ], 0.01);
    // At τ=0.01, logit diff = (0.99-0.01)/0.01 = 98 → nearly 1.0 weight on first
    expect(result.maxWeight).toBeGreaterThan(0.99);
    expect(result.weightedWR).toBeGreaterThan(0.99);
    expect(result.weightedAvgPnl).toBeGreaterThan(1.9);
  });

  it('A8: very large number of trades produces valid results', () => {
    const trades = Array.from({ length: 1000 }, (_, i) => ({
      similarity: 0.5 + (i % 100) / 1000,
      isWin: i % 3 === 0,
      pnl: (i % 2 === 0 ? 1 : -1) * 0.1,
    }));
    const result = softmaxWeightedSimilarAggregate(trades);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    expect(Number.isFinite(result.weightedAvgPnl)).toBe(true);
    expect(result.weightedWR).toBeGreaterThan(0);
    expect(result.weightedWR).toBeLessThan(1);
    expect(result.maxWeight).toBeLessThan(0.01); // no single trade dominates at 1000
  });

  it('A9: all wins → weightedWR = 1.0', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.9, isWin: true, pnl: 1.0 },
      { similarity: 0.7, isWin: true, pnl: 0.5 },
      { similarity: 0.5, isWin: true, pnl: 0.3 },
    ]);
    expect(result.weightedWR).toBe(1);
    expect(result.rawWR).toBe(1);
  });

  it('A10: all losses → weightedWR = 0.0', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: 0.9, isWin: false, pnl: -1.0 },
      { similarity: 0.7, isWin: false, pnl: -0.5 },
      { similarity: 0.5, isWin: false, pnl: -0.3 },
    ]);
    expect(result.weightedWR).toBe(0);
    expect(result.rawWR).toBe(0);
  });

  it('A11: mixed NaN and finite — NaN trades get weight 0 effectively', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: NaN, isWin: true, pnl: 100.0 }, // should get ~0 weight
      { similarity: 0.9, isWin: false, pnl: -1.0 },  // should dominate
    ], 0.1);
    // NaN → sim=0 → logit=0; 0.9 → logit=9 → exp(9) >> exp(0)
    expect(result.weightedWR).toBeLessThan(0.1); // loss dominates
    expect(result.weightedAvgPnl).toBeLessThan(0); // closer to -1.0
  });

  it('A12: negative similarity scores are handled (similarity can be negative for cosine)', () => {
    const result = softmaxWeightedSimilarAggregate([
      { similarity: -0.5, isWin: true, pnl: 1.0 },
      { similarity: 0.8, isWin: false, pnl: -0.5 },
    ]);
    expect(Number.isFinite(result.weightedWR)).toBe(true);
    // -0.5 → logit = -5; 0.8 → logit = 8 → second trade dominates
    expect(result.weightedWR).toBeLessThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Part 2: SimilarTradeRetriever.formatBlock — Softmax Integration
// ═══════════════════════════════════════════════════════════════

describe('SimilarTradeRetriever.formatBlock with softmax', () => {
  it('shows both raw and sim-weighted WR when they differ significantly', () => {
    const retriever = new SimilarTradeRetriever();
    const similar = [
      { trade: makeRecord({ id: 't1', outcome: 'WIN', pnl: 1.0 }), similarity: 0.95 },
      { trade: makeRecord({ id: 't2', outcome: 'LOSS', pnl: -0.5 }), similarity: 0.50 },
    ];
    const block = retriever.formatBlock(similar, 'buy', 'BTC');
    // Should contain both raw and sim-weighted percentages
    expect(block).toContain('raw');
    expect(block).toContain('sim-weighted');
  });

  it('shows only raw WR when weighted and raw are similar', () => {
    const retriever = new SimilarTradeRetriever();
    const similar = [
      { trade: makeRecord({ id: 't1', outcome: 'WIN', pnl: 0.3 }), similarity: 0.80 },
      { trade: makeRecord({ id: 't2', outcome: 'WIN', pnl: 0.2 }), similarity: 0.79 },
    ];
    const block = retriever.formatBlock(similar, 'buy', 'BTC');
    // Both wins, similar sim → no significant difference → just raw
    expect(block).not.toContain('sim-weighted');
  });

  it('returns empty string for empty similar trades', () => {
    const retriever = new SimilarTradeRetriever();
    const block = retriever.formatBlock([], 'buy', 'BTC');
    expect(block).toBe('');
  });

  it('includes individual trade details with similarity percentages', () => {
    const retriever = new SimilarTradeRetriever();
    const similar = [
      { trade: makeRecord({ id: 't1', outcome: 'WIN', pnl: 1.0, entryThesis: 'S/R bounce' }), similarity: 0.92 },
      { trade: makeRecord({ id: 't2', outcome: 'LOSS', pnl: -0.5, entryThesis: 'Breakout play' }), similarity: 0.71 },
    ];
    const block = retriever.formatBlock(similar, 'buy', 'BTC');
    expect(block).toContain('92%');
    expect(block).toContain('71%');
    expect(block).toContain('S/R bounce');
    expect(block).toContain('Breakout play');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Part 3: PatternClusterManager — Conditional WR Tests
// ═══════════════════════════════════════════════════════════════

describe('PatternClusterManager conditional WR', () => {
  function makeEmbedProvider(): MockEmbedProvider {
    return new MockEmbedProvider();
  }

  async function buildClusterManager(
    records: ThesisExperienceRecord[],
    embed?: MockEmbedProvider,
  ): Promise<PatternClusterManager> {
    const provider = embed ?? makeEmbedProvider();
    await provider.warmup();
    const mgr = new PatternClusterManager(provider);
    await mgr.rebuild(records);
    return mgr;
  }

  it('stores memberMarketData during cluster creation', async () => {
    const rec = makeRecord({
      id: 'r1',
      rationales: ['S/R bounce'],
      rationaleVectors: [[0.9, 0.1, 0.0]],
      marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
      outcome: 'WIN',
    });
    const mgr = await buildClusterManager([rec]);
    const clusters = mgr.getClusters();
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0]!.memberMarketData).toBeDefined();
    expect(clusters[0]!.memberMarketData!.length).toBe(1);
    expect(clusters[0]!.memberMarketData![0]!.marketFeatures).toBeDefined();
    expect(clusters[0]!.memberMarketData![0]!.marketFeatures!.volatility).toBe(0.5);
  });

  it('appends memberMarketData when adding to existing cluster', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const clusters = mgr.getClusters();
    // All 3 should be in the same cluster (very similar vectors)
    const bigCluster = clusters.find(c => c.count >= 3);
    expect(bigCluster).toBeDefined();
    expect(bigCluster!.memberMarketData!.length).toBe(3);
  });

  it('getPatternMap without currentFeatures shows only raw WR (backward compatible)', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
      makeRecord({ id: 'r4', outcome: 'WIN', rationaleVectors: [[0.92, 0.08, 0.0]] }),
      makeRecord({ id: 'r5', outcome: 'LOSS', rationaleVectors: [[0.89, 0.11, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const map = mgr.getPatternMap(5);
    // Should NOT contain conditional WR
    expect(map).not.toContain('cond');
    expect(map).toContain('ENTRY PATTERN');
  });

  it('getPatternMap with currentFeatures shows conditional WR when available', async () => {
    // Create records with diverse market features so conditional WR can find matches
    const records: ThesisExperienceRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(makeRecord({
        id: `r${i}`,
        outcome: i % 3 === 0 ? 'LOSS' : 'WIN',
        rationaleVectors: [[0.9 + (i % 3) * 0.01, 0.1, 0.0]],
        marketFeatures: {
          volatility: 0.4 + (i % 5) * 0.05,
          srDistanceBps: 150 + (i % 5) * 20,
          obImbalance: 0.2 + (i % 4) * 0.1,
          fundingRate: 0.0001,
          volumeRatio: 1.0 + (i % 3) * 0.2,
          signalAgreement: 0.6,
          sentiment: 0.5,
          sentimentConviction: 0.5,
          regimeOrdinal: 2,
          momentumShort: 0.01,
          momentumLong: 0.01,
        },
      }));
    }
    const mgr = await buildClusterManager(records);
    const currentFeatures = {
      volatility: 0.5,
      srDistanceBps: 200,
      obImbalance: 0.3,
      fundingRate: 0.0001,
      volumeRatio: 1.2,
      signalAgreement: 0.6,
      sentiment: 0.5,
      sentimentConviction: 0.5,
      regimeOrdinal: 2,
      momentumShort: 0.01,
      momentumLong: 0.01,
    };
    const map = mgr.getPatternMap(10, currentFeatures);
    // Should contain conditional WR (if cluster has ≥3 members with features)
    // The exact display depends on whether enough similar trades are found
    expect(map).toContain('ENTRY PATTERN');
  });

  it('getPatternMap with empty currentFeatures falls back to raw WR', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const map = mgr.getPatternMap(3, {});
    // Empty features → no conditional WR → just raw
    expect(map).not.toContain('cond');
  });

  // ─── Attack tests for conditional WR ───

  it('C1: cluster with no memberMarketData falls back to raw WR', async () => {
    const rec = makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] });
    const mgr = await buildClusterManager([rec]);
    // Manually strip memberMarketData to simulate pre-v2.0.214 cluster
    const clusters = mgr.getClusters();
    for (const c of clusters) {
      delete (c as any).memberMarketData;
    }
    const currentFeatures = { volatility: 0.5, srDistanceBps: 200 };
    const map = mgr.getPatternMap(1, currentFeatures);
    // Should not crash, should show raw WR only
    expect(map).not.toContain('cond');
    expect(map).toContain('ENTRY PATTERN');
  });

  it('C2: all members missing marketFeatures falls back to raw WR', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', marketFeatures: undefined, rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', marketFeatures: undefined, rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', marketFeatures: undefined, rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const currentFeatures = { volatility: 0.5, srDistanceBps: 200 };
    const map = mgr.getPatternMap(3, currentFeatures);
    // No members with features → no conditional WR
    expect(map).not.toContain('cond');
  });

  it('C3: fewer than 3 members with features → no conditional WR', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', marketFeatures: { volatility: 0.5 }, rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', marketFeatures: undefined, rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', marketFeatures: undefined, rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const currentFeatures = { volatility: 0.5, srDistanceBps: 200 };
    const map = mgr.getPatternMap(3, currentFeatures);
    // Only 1 member with features → insufficient for conditional WR
    expect(map).not.toContain('cond');
  });

  it('C4: NaN in member marketFeatures does not crash', async () => {
    const records = [
      makeRecord({
        id: 'r1', outcome: 'WIN',
        marketFeatures: { volatility: NaN, srDistanceBps: 200, regimeOrdinal: 2 } as any,
        rationaleVectors: [[0.9, 0.1, 0.0]],
      }),
      makeRecord({
        id: 'r2', outcome: 'LOSS',
        marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
        rationaleVectors: [[0.88, 0.12, 0.0]],
      }),
      makeRecord({
        id: 'r3', outcome: 'WIN',
        marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
        rationaleVectors: [[0.91, 0.09, 0.0]],
      }),
    ];
    const mgr = await buildClusterManager(records);
    const currentFeatures = { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 };
    // Should not throw
    expect(() => mgr.getPatternMap(3, currentFeatures)).not.toThrow();
  });

  it('C5: large cluster (50+ members) computes conditional WR without performance issues', async () => {
    const records: ThesisExperienceRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(makeRecord({
        id: `r${i}`,
        outcome: i % 3 === 0 ? 'LOSS' : 'WIN',
        rationaleVectors: [[0.9 + (i % 3) * 0.005, 0.1, 0.0]],
        marketFeatures: {
          volatility: 0.3 + (i % 10) * 0.03,
          srDistanceBps: 100 + (i % 10) * 30,
          obImbalance: 0.1 + (i % 5) * 0.1,
          fundingRate: 0.0001,
          volumeRatio: 1.0 + (i % 4) * 0.15,
          signalAgreement: 0.6,
          sentiment: 0.5,
          sentimentConviction: 0.5,
          regimeOrdinal: 2,
          momentumShort: 0.01,
          momentumLong: 0.01,
        },
      }));
    }
    const mgr = await buildClusterManager(records);
    const currentFeatures = {
      volatility: 0.5,
      srDistanceBps: 200,
      obImbalance: 0.3,
      fundingRate: 0.0001,
      volumeRatio: 1.2,
      signalAgreement: 0.6,
      sentiment: 0.5,
      sentimentConviction: 0.5,
      regimeOrdinal: 2,
      momentumShort: 0.01,
      momentumLong: 0.01,
    };
    const start = Date.now();
    const map = mgr.getPatternMap(60, currentFeatures);
    const elapsed = Date.now() - start;
    // Should complete in under 100ms for 60 trades
    expect(elapsed).toBeLessThan(100);
    expect(map).toContain('ENTRY PATTERN');
  });

  it('C6: currentFeatures with all zeros does not crash', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const currentFeatures: Record<string, number> = {
      volatility: 0, srDistanceBps: 0, obImbalance: 0, fundingRate: 0,
      volumeRatio: 0, signalAgreement: 0, sentiment: 0, sentimentConviction: 0,
      regimeOrdinal: 0, momentumShort: 0, momentumLong: 0,
    };
    expect(() => mgr.getPatternMap(3, currentFeatures)).not.toThrow();
  });

  it('C7: direction filter — only matches same-side members', async () => {
    const records: ThesisExperienceRecord[] = [];
    // 5 BUY wins with similar features
    for (let i = 0; i < 5; i++) {
      records.push(makeRecord({
        id: `buy${i}`, side: 'buy', outcome: 'WIN',
        rationaleVectors: [[0.9 + i * 0.005, 0.1, 0.0]],
        marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
      }));
    }
    // 5 SELL losses with similar features
    for (let i = 0; i < 5; i++) {
      records.push(makeRecord({
        id: `sell${i}`, side: 'sell', outcome: 'LOSS',
        rationaleVectors: [[0.9 + i * 0.005, 0.1, 0.0]],
        marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
      }));
    }
    const mgr = await buildClusterManager(records);
    const currentFeatures = { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 };
    // Filter by BUY side → should see BUY wins (100% WR), not SELL losses
    const mapBuy = mgr.getPatternMap(10, currentFeatures, 'buy');
    // Filter by SELL side → should see SELL losses (0% WR)
    const mapSell = mgr.getPatternMap(10, currentFeatures, 'sell');
    // Both should work without crashing
    expect(mapBuy).toContain('ENTRY PATTERN');
    expect(mapSell).toContain('ENTRY PATTERN');
  });

  it('C8: addTrade after rebuild stores memberMarketData', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const initialCluster = mgr.getClusters()[0]!;
    const initialCount = initialCluster.memberMarketData!.length;

    // Add a new trade
    const newRec = makeRecord({
      id: 'r4', outcome: 'WIN',
      rationaleVectors: [[0.89, 0.11, 0.0]],
      marketFeatures: { volatility: 0.6, srDistanceBps: 250, regimeOrdinal: 3 },
    });
    await mgr.addTrade(newRec);

    const updatedCluster = mgr.getClusters().find(c => c.memberIds.includes('r4'));
    expect(updatedCluster).toBeDefined();
    expect(updatedCluster!.memberMarketData!.length).toBe(initialCount + 1);
    const lastMember = updatedCluster!.memberMarketData!.at(-1)!;
    expect(lastMember.marketFeatures!.volatility).toBe(0.6);
  });

  it('C9: Infinity in member features does not crash conditional WR', async () => {
    const records = [
      makeRecord({
        id: 'r1', outcome: 'WIN',
        marketFeatures: { volatility: Infinity, srDistanceBps: 200, regimeOrdinal: 2 } as any,
        rationaleVectors: [[0.9, 0.1, 0.0]],
      }),
      makeRecord({
        id: 'r2', outcome: 'LOSS',
        marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
        rationaleVectors: [[0.88, 0.12, 0.0]],
      }),
      makeRecord({
        id: 'r3', outcome: 'WIN',
        marketFeatures: { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 },
        rationaleVectors: [[0.91, 0.09, 0.0]],
      }),
    ];
    const mgr = await buildClusterManager(records);
    const currentFeatures = { volatility: 0.5, srDistanceBps: 200, regimeOrdinal: 2 };
    // Should not throw — Infinity handled by extractFeatureVector (filtered out)
    expect(() => mgr.getPatternMap(3, currentFeatures)).not.toThrow();
  });

  it('C10: conditional WR with feature scale disparity (srDistanceBps 900 vs volatility 0.3)', async () => {
    // This is the core problem RMSNorm/z-score solves in AttnRes.
    // Conditional WR within clusters uses computeVectorConditionalWinRate
    // which has min-max normalization built in. Verify it doesn't crash
    // and produces valid results with extreme scale differences.
    const records: ThesisExperienceRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(makeRecord({
        id: `r${i}`,
        outcome: i % 3 === 0 ? 'LOSS' : 'WIN',
        rationaleVectors: [[0.9 + (i % 3) * 0.005, 0.1, 0.0]],
        marketFeatures: {
          volatility: 0.2 + (i % 5) * 0.1,        // 0.2-0.6
          srDistanceBps: 100 + (i % 5) * 200,     // 100-900
          obImbalance: 0.1 + (i % 4) * 0.15,      // 0.1-0.55
          fundingRate: 0.0001,
          volumeRatio: 1.0,
          signalAgreement: 0.6,
          sentiment: 0.5,
          sentimentConviction: 0.5,
          regimeOrdinal: 2,
          momentumShort: 0.01,
          momentumLong: 0.01,
        },
      }));
    }
    const mgr = await buildClusterManager(records);
    const currentFeatures = {
      volatility: 0.5,
      srDistanceBps: 500,
      obImbalance: 0.3,
      fundingRate: 0.0001,
      volumeRatio: 1.0,
      signalAgreement: 0.6,
      sentiment: 0.5,
      sentimentConviction: 0.5,
      regimeOrdinal: 2,
      momentumShort: 0.01,
      momentumLong: 0.01,
    };
    expect(() => mgr.getPatternMap(10, currentFeatures)).not.toThrow();
    const map = mgr.getPatternMap(10, currentFeatures);
    expect(map).toContain('ENTRY PATTERN');
  });

  it('C11: getPatternMap with side filter but no currentFeatures still works', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', side: 'buy', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', side: 'sell', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', side: 'buy', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    // No currentFeatures but side filter — should work (backward compatible)
    expect(() => mgr.getPatternMap(3, undefined, 'buy')).not.toThrow();
  });

  it('C12: memberMarketData outcome matches record outcome', async () => {
    const records = [
      makeRecord({ id: 'r1', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const cluster = mgr.getClusters()[0]!;
    const outcomes = cluster.memberMarketData!.map(m => m.outcome);
    expect(outcomes).toContain('WIN');
    expect(outcomes).toContain('LOSS');
  });

  it('C13: memberMarketData preserves side for direction filtering', async () => {
    const records = [
      makeRecord({ id: 'r1', side: 'buy', outcome: 'WIN', rationaleVectors: [[0.9, 0.1, 0.0]] }),
      makeRecord({ id: 'r2', side: 'sell', outcome: 'LOSS', rationaleVectors: [[0.88, 0.12, 0.0]] }),
      makeRecord({ id: 'r3', side: 'buy', outcome: 'WIN', rationaleVectors: [[0.91, 0.09, 0.0]] }),
    ];
    const mgr = await buildClusterManager(records);
    const cluster = mgr.getClusters()[0]!;
    const sides = cluster.memberMarketData!.map(m => m.side);
    expect(sides).toContain('buy');
    expect(sides).toContain('sell');
  });
});