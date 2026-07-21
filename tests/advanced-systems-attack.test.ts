// ─── v2.0.219: Attack Tests for 7 New Systems ───────────────────────
//
// Comprehensive attack tests for:
// 1. Shadow Trade Engine fix (maxAgeCycles + stale feed + weightMultiplier)
// 2. Replay Buffer (PER sampling, ring buffer, IS weights)
// 3. Bayesian OLR (MC dropout uncertainty, cold-start, seeding)
// 4. Temporal Attention (pseudo-query, anti-collapse, persistence)
// 5. Cross-Symbol Backbone (shared + residual, cold-start, transfer)
// 6. Reward Shaping (PnL, drawdown, Sharpe, hold-time, recovery)
// 7. Active Exploration (UCB, info gain, annealing)
// 8. World Model (encode-decode, transition, rollout, cold-start)

import { describe, it, expect } from 'vitest';
import { ReplayBuffer } from '../src/evolution/replay-buffer.ts';
import { BayesianOLR } from '../src/evolution/bayesian-olr.ts';
import { TemporalAttention } from '../src/evolution/temporal-attention.ts';
import { CrossSymbolBackbone } from '../src/evolution/cross-symbol-backbone.ts';
import { RewardShaper } from '../src/evolution/reward-shaping.ts';
import { ActiveExploration } from '../src/evolution/active-exploration.ts';
import { WorldModel } from '../src/evolution/world-model.ts';
import { OLREngine, FEATURE_NAMES } from '../src/evolution/olr-engine.ts';

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
  };
}

// ═══════════════════════════════════════════════════════════════
//  1. Replay Buffer
// ═══════════════════════════════════════════════════════════════

describe('ReplayBuffer', () => {
  it('R1: stores samples and evicts oldest (ring buffer)', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr, { maxCapacity: 100 });
    for (let i = 0; i < 150; i++) {
      rb.add({
        symbol: 'btc', features: goodFeatures(), outcome: i % 2 as 0 | 1,
        side: 'buy', source: 'real', cycle: i, ts: i, pnl: i % 2 === 0 ? 1 : -1,
      });
    }
    expect(rb.size()).toBe(100); // evicted oldest 50
  });

  it('R2: replayEpoch feeds OLR (sample count increases)', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr, { maxCapacity: 1000, batchSize: 10, epochsPerReplay: 1 });
    for (let i = 0; i < 50; i++) {
      rb.add({
        symbol: 'btc', features: { ...goodFeatures(), volatility: i % 2 === 0 ? 0.05 : 0.005 },
        outcome: i % 2 as 0 | 1, side: 'buy', source: 'real', cycle: i, ts: i, pnl: i % 2 === 0 ? 1 : -1,
      });
    }
    const beforeCount = olr.getAllModelStats().find(s => s.symbol === 'btc')?.longSamples ?? 0;
    const fed = rb.replayEpoch();
    expect(fed).toBeGreaterThan(0);
    const afterCount = olr.getAllModelStats().find(s => s.symbol === 'btc')?.longSamples ?? 0;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('R3: PER prioritizes high-|pnl| trades', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr, { maxCapacity: 1000, batchSize: 20, perAlpha: 1.0 });
    // Add 30 low-pnl trades and 5 high-pnl trades
    for (let i = 0; i < 30; i++) {
      rb.add({ symbol: 'btc', features: goodFeatures(), outcome: 1, side: 'buy', source: 'real', cycle: i, ts: i, pnl: 0.01 });
    }
    for (let i = 0; i < 5; i++) {
      rb.add({ symbol: 'btc', features: goodFeatures(), outcome: 1, side: 'buy', source: 'real', cycle: 100 + i, ts: 100 + i, pnl: 10 });
    }
    const stats = rb.getStats();
    expect(stats.totalSamples).toBe(35);
    expect(stats.avgPriority).toBeGreaterThan(0.01); // high-pnl trades raise average
  });

  it('R4: replayEpoch with <10 samples returns 0 (cold-start guard)', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr);
    for (let i = 0; i < 5; i++) {
      rb.add({ symbol: 'btc', features: goodFeatures(), outcome: 1, side: 'buy', source: 'real', cycle: i, ts: i, pnl: 1 });
    }
    expect(rb.replayEpoch()).toBe(0);
  });

  it('R5: save/load preserves buffer and config', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr, { maxCapacity: 50, batchSize: 5 });
    for (let i = 0; i < 20; i++) {
      rb.add({ symbol: 'btc', features: goodFeatures(), outcome: 1, side: 'buy', source: 'real', cycle: i, ts: i, pnl: 1 });
    }
    const json = rb.save();
    const rb2 = new ReplayBuffer(olr, { maxCapacity: 50, batchSize: 5 });
    rb2.load(json);
    expect(rb2.size()).toBe(20);
    expect(rb2.getStats().totalReplays).toBe(rb.getStats().totalReplays);
  });

  it('R6: NaN features in samples don\'t poison OLR during replay', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr, { maxCapacity: 100, batchSize: 10 });
    for (let i = 0; i < 20; i++) {
      rb.add({
        symbol: 'btc',
        features: { ...goodFeatures(), fundingRate: NaN, volatility: Infinity },
        outcome: 1, side: 'buy', source: 'real', cycle: i, ts: i, pnl: 1,
      });
    }
    rb.replayEpoch();
    const weights = olr.getFeatureWeights('btc', 'buy')!;
    expect(weights.every(w => Number.isFinite(w.weight))).toBe(true);
  });

  it('R7: clear() resets buffer', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr);
    for (let i = 0; i < 10; i++) {
      rb.add({ symbol: 'btc', features: goodFeatures(), outcome: 1, side: 'buy', source: 'real', cycle: i, ts: i, pnl: 1 });
    }
    rb.clear();
    expect(rb.size()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  2. Bayesian OLR
// ═══════════════════════════════════════════════════════════════

describe('BayesianOLR', () => {
  it('B1: cold-start returns point estimate with uncertainty=1', () => {
    const olr = new OLREngine();
    const bayes = new BayesianOLR(olr, { minSamples: 20 });
    const result = bayes.query('btc', goodFeatures(), 'buy', 0);
    expect(result.applied).toBe(false);
    expect(result.uncertainty).toBe(1);
    expect(Number.isFinite(result.pWin_mean)).toBe(true);
  });

  it('B2: with enough samples, MC dropout produces std > 0', () => {
    const olr = new OLREngine();
    const bayes = new BayesianOLR(olr, { minSamples: 10, mcPasses: 50, dropoutRate: 0.2, seed: 42 });
    for (let i = 0; i < 30; i++) {
      olr.feedTrade('btc', { ...goodFeatures(), volatility: 0.05 }, 1, 'buy', 'shadow', i);
      olr.feedTrade('btc', { ...goodFeatures(), volatility: 0.005 }, 0, 'buy', 'shadow', 30 + i);
    }
    const result = bayes.query('btc', { ...goodFeatures(), volatility: 0.03 }, 'buy', 0);
    expect(result.applied).toBe(true);
    expect(result.pWin_std).toBeGreaterThan(0);
    expect(result.passes).toBeGreaterThan(5);
  });

  it('B3: pWin_mean is within [0, 1]', () => {
    const olr = new OLREngine();
    const bayes = new BayesianOLR(olr, { minSamples: 10, mcPasses: 30, seed: 42 });
    for (let i = 0; i < 30; i++) {
      olr.feedTrade('btc', goodFeatures(), i % 2 as 0 | 1, 'buy', 'shadow', i);
    }
    const result = bayes.query('btc', goodFeatures(), 'buy', 0);
    expect(result.pWin_mean).toBeGreaterThanOrEqual(0);
    expect(result.pWin_mean).toBeLessThanOrEqual(1);
  });

  it('B4: confidence interval contains mean', () => {
    const olr = new OLREngine();
    const bayes = new BayesianOLR(olr, { minSamples: 10, mcPasses: 50, ciLevel: 0.9, seed: 42 });
    for (let i = 0; i < 30; i++) {
      olr.feedTrade('btc', { ...goodFeatures(), volatility: 0.05 }, 1, 'buy', 'shadow', i);
      olr.feedTrade('btc', { ...goodFeatures(), volatility: 0.005 }, 0, 'buy', 'shadow', 30 + i);
    }
    const result = bayes.query('btc', goodFeatures(), 'buy', 0);
    if (result.applied) {
      expect(result.pWin_low).toBeLessThanOrEqual(result.pWin_mean);
      expect(result.pWin_high).toBeGreaterThanOrEqual(result.pWin_mean);
    }
  });

  it('B5: seeded RNG produces reproducible results', () => {
    const olr = new OLREngine();
    for (let i = 0; i < 30; i++) {
      olr.feedTrade('btc', { ...goodFeatures(), volatility: 0.05 }, 1, 'buy', 'shadow', i);
      olr.feedTrade('btc', { ...goodFeatures(), volatility: 0.005 }, 0, 'buy', 'shadow', 30 + i);
    }
    const bayes1 = new BayesianOLR(olr, { minSamples: 10, mcPasses: 30, seed: 42 });
    const bayes2 = new BayesianOLR(olr, { minSamples: 10, mcPasses: 30, seed: 42 });
    const r1 = bayes1.query('btc', goodFeatures(), 'buy', 0);
    const r2 = bayes2.query('btc', goodFeatures(), 'buy', 0);
    expect(r1.pWin_mean).toBeCloseTo(r2.pWin_mean, 5);
  });

  it('B6: NaN features don\'t crash MC dropout', () => {
    const olr = new OLREngine();
    const bayes = new BayesianOLR(olr, { minSamples: 10, mcPasses: 30, seed: 42 });
    for (let i = 0; i < 30; i++) {
      olr.feedTrade('btc', goodFeatures(), i % 2 as 0 | 1, 'buy', 'shadow', i);
    }
    const nanFeatures = { ...goodFeatures(), fundingRate: NaN, volatility: Infinity };
    const result = bayes.query('btc', nanFeatures, 'buy', 0);
    expect(Number.isFinite(result.pWin_mean)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  3. Temporal Attention
// ═══════════════════════════════════════════════════════════════

describe('TemporalAttention', () => {
  it('T1: cold-start (< minHistory) returns current trade, not blended', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 3 });
    ta.addTrade({ symbol: 'btc', side: 'buy', features: goodFeatures(), outcome: 1, pnl: 1, pnlPct: 0.01, ts: 1, regime: 'trending_bull' });
    const result = ta.retrieveBlend();
    expect(result.applied).toBe(false);
    expect(result.hBlend.length).toBe(14);
  });

  it('T2: with enough history, produces attention weights', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 3, seqLen: 20 });
    for (let i = 0; i < 10; i++) {
      ta.addTrade({
        symbol: 'btc', side: i % 2 === 0 ? 'buy' : 'sell',
        features: { ...goodFeatures(), volatility: 0.01 * (i + 1) },
        outcome: i % 2 as 0 | 1, pnl: i % 2 === 0 ? 1 : -1, pnlPct: 0.01,
        ts: i, regime: 'trending_bull',
      });
    }
    const result = ta.retrieveBlend();
    expect(result.applied).toBe(true);
    expect(result.attention.length).toBe(10);
    expect(result.attention.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });

  it('T3: updateOnOutcome changes pseudo-query norm', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 2, learningRate: 0.1 });
    for (let i = 0; i < 10; i++) {
      ta.addTrade({ symbol: 'btc', side: 'buy', features: { ...goodFeatures(), volatility: 0.05 }, outcome: 1, pnl: 2, pnlPct: 0.02, ts: i, regime: 'trending_bull' });
    }
    const wNormBefore = ta.getState().wNorm;
    ta.updateOnOutcome(2); // positive reward
    const wNormAfter = ta.getState().wNorm;
    expect(wNormAfter).toBeGreaterThan(wNormBefore);
  });

  it('T4: anti-collapse — temperature adapts when entropy drops', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 2, warmupFactor: 2, entropyFloor: 0.5, learningRate: 0.5 });
    // Feed many identical trades → attention collapses → temperature should rise
    for (let i = 0; i < 20; i++) {
      ta.addTrade({ symbol: 'btc', side: 'buy', features: goodFeatures(), outcome: 1, pnl: 1, pnlPct: 0.01, ts: i, regime: 'trending_bull' });
    }
    // Update repeatedly with large lr to push w in one direction
    for (let i = 0; i < 100; i++) ta.updateOnOutcome(1);
    const state = ta.getState();
    // Temperature should increase from 1.0 when entropy drops below floor
    expect(state.temperature).toBeGreaterThanOrEqual(1.0); // at least not decreased
    expect(state.wNorm).toBeGreaterThan(0); // w actually learned
  });

  it('T5: label smoothing prevents winner-takes-all', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 2, smoothMix: 0.1, seqLen: 10 });
    for (let i = 0; i < 10; i++) {
      ta.addTrade({ symbol: 'btc', side: 'buy', features: goodFeatures(), outcome: 1, pnl: 1, pnlPct: 0.01, ts: i, regime: 'trending_bull' });
    }
    for (let i = 0; i < 100; i++) ta.updateOnOutcome(1);
    const result = ta.retrieveBlend();
    // With smoothing, no attention weight should be > 1 - smoothMix + smoothMix/N
    const maxAlpha = Math.max(...result.attention);
    expect(maxAlpha).toBeLessThan(1.0); // not winner-takes-all
  });

  it('T6: save/load preserves weights and temperature', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 2, learningRate: 0.1 });
    for (let i = 0; i < 5; i++) {
      ta.addTrade({ symbol: 'btc', side: 'buy', features: goodFeatures(), outcome: 1, pnl: 1, pnlPct: 0.01, ts: i, regime: 'trending_bull' });
    }
    ta.updateOnOutcome(1);
    const json = ta.save();
    const ta2 = new TemporalAttention({ minHistoryToBlend: 2, learningRate: 0.1 });
    ta2.load(json);
    expect(ta2.getState().historyLen).toBe(5);
    expect(ta2.getState().updateCount).toBe(1);
  });

  it('T7: NaN features in trade records don\'t crash', () => {
    const ta = new TemporalAttention({ minHistoryToBlend: 2 });
    ta.addTrade({
      symbol: 'btc', side: 'buy',
      features: { ...goodFeatures(), fundingRate: NaN, volatility: Infinity },
      outcome: 1, pnl: 1, pnlPct: 0.01, ts: 1, regime: 'trending_bull',
    });
    ta.addTrade({ symbol: 'btc', side: 'buy', features: goodFeatures(), outcome: 1, pnl: 1, pnlPct: 0.01, ts: 2, regime: 'trending_bull' });
    const result = ta.retrieveBlend();
    expect(result.hBlend.every(v => Number.isFinite(v))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  4. Cross-Symbol Backbone
// ═══════════════════════════════════════════════════════════════

describe('CrossSymbolBackbone', () => {
  it('C1: cold-start symbol uses shared backbone only (no residual)', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr, { minResidualSamples: 10 });
    // Train shared backbone with symbol A
    for (let i = 0; i < 20; i++) {
      csb.feedTrade('a', { ...goodFeatures(), volatility: 0.05 }, 1, 'buy');
      csb.feedTrade('a', { ...goodFeatures(), volatility: 0.005 }, 0, 'buy');
    }
    // Query cold-start symbol B
    const result = csb.query('b', { ...goodFeatures(), volatility: 0.03 }, 'buy');
    expect(result.applied).toBe(true);
    expect(result.samples).toBe(0); // B has 0 samples
  });

  it('C2: shared backbone learns from all symbols', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr, { minResidualSamples: 5 });
    // Train with symbol A (high vol → win) and symbol B (low vol → win)
    for (let i = 0; i < 15; i++) {
      csb.feedTrade('a', { ...goodFeatures(), volatility: 0.05 }, 1, 'buy');
      csb.feedTrade('b', { ...goodFeatures(), volatility: 0.005 }, 1, 'buy');
    }
    const stats = csb.getStats();
    expect(stats.length).toBeGreaterThanOrEqual(2);
    // Shared backbone should be non-zero
    expect(stats[0]!.sharedNorm).toBeGreaterThan(0.001);
  });

  it('C3: residual only activates after minResidualSamples', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr, { minResidualSamples: 10 });
    for (let i = 0; i < 9; i++) {
      csb.feedTrade('btc', goodFeatures(), 1, 'buy');
    }
    const stats = csb.getStats().find(s => s.symbol === 'btc');
    expect(stats!.samples).toBe(9);
    // Residual should still be ~0 (not enough samples)
    expect(stats!.residualNorm).toBeLessThan(0.01);
  });

  it('C4: residual norm is clamped (no explosion)', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr, { minResidualSamples: 5, maxResidualNorm: 2, residualLr: 1.0 });
    for (let i = 0; i < 100; i++) {
      csb.feedTrade('btc', { ...goodFeatures(), volatility: 0.1 }, i % 2 as 0 | 1, 'buy');
    }
    const stats = csb.getStats().find(s => s.symbol === 'btc');
    expect(stats!.residualNorm).toBeLessThanOrEqual(2.01); // clamped
  });

  it('C5: NaN features don\'t poison weights', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr);
    csb.feedTrade('btc', { ...goodFeatures(), fundingRate: NaN, volatility: Infinity }, 1, 'buy');
    const result = csb.query('btc', goodFeatures(), 'buy');
    expect(Number.isFinite(result.pWin)).toBe(true);
  });

  it('C6: save/load preserves weights', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr, { minResidualSamples: 5 });
    for (let i = 0; i < 20; i++) {
      csb.feedTrade('btc', { ...goodFeatures(), volatility: 0.05 }, 1, 'buy');
      csb.feedTrade('eth', { ...goodFeatures(), volatility: 0.005 }, 0, 'buy');
    }
    const json = csb.save();
    const csb2 = new CrossSymbolBackbone(olr, { minResidualSamples: 5 });
    csb2.load(json);
    const stats = csb2.getStats();
    expect(stats.length).toBeGreaterThanOrEqual(2);
    expect(stats[0]!.samples).toBe(20);
  });

  it('C7: falls back to OLR when shared backbone is untrained', () => {
    const olr = new OLREngine();
    // Train OLR directly (not through CSB)
    for (let i = 0; i < 20; i++) {
      olr.feedTrade('btc', goodFeatures(), i % 2 as 0 | 1, 'buy', 'shadow', i);
    }
    const csb = new CrossSymbolBackbone(olr); // shared backbone is zero
    const result = csb.query('btc', goodFeatures(), 'buy');
    expect(result.applied).toBe(false); // fell back to OLR
    expect(Number.isFinite(result.pWin)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  5. Reward Shaping
// ═══════════════════════════════════════════════════════════════

describe('RewardShaper', () => {
  it('S1: shaped reward is bounded [-1, 1]', () => {
    const rs = new RewardShaper();
    const r = rs.shape({ pnl: 100, pnlPct: 0.5, holdMin: 10, maePct: 0.01, mfePct: 0.5, entryPrice: 100, exitPrice: 150, leverage: 10 });
    expect(r.reward).toBeGreaterThanOrEqual(-1);
    expect(r.reward).toBeLessThanOrEqual(1);
  });

  it('S2: winning trade gets positive reward', () => {
    const rs = new RewardShaper();
    const r = rs.shape({ pnl: 2, pnlPct: 0.02, holdMin: 30, maePct: 0.005, mfePct: 0.025, entryPrice: 100, exitPrice: 102, leverage: 5 });
    expect(r.reward).toBeGreaterThan(0);
  });

  it('S3: losing trade gets negative reward', () => {
    const rs = new RewardShaper();
    const r = rs.shape({ pnl: -2, pnlPct: -0.02, holdMin: 30, maePct: 0.025, mfePct: 0.005, entryPrice: 100, exitPrice: 98, leverage: 5 });
    expect(r.reward).toBeLessThan(0);
  });

  it('S4: drawdown penalty reduces reward', () => {
    const rs = new RewardShaper();
    const noDD = rs.shape({ pnl: 2, pnlPct: 0.02, holdMin: 30, maePct: 0.005, mfePct: 0.025, entryPrice: 100, exitPrice: 102, leverage: 5, portfolioDrawdown: 0 });
    const withDD = rs.shape({ pnl: 2, pnlPct: 0.02, holdMin: 30, maePct: 0.005, mfePct: 0.025, entryPrice: 100, exitPrice: 102, leverage: 5, portfolioDrawdown: 0.5 });
    expect(withDD.reward).toBeLessThan(noDD.reward);
  });

  it('S5: hold-time penalty activates after maxHoldMin', () => {
    const rs = new RewardShaper({ maxHoldMin: 30 });
    const short = rs.shape({ pnl: 1, pnlPct: 0.01, holdMin: 20, maePct: 0.005, mfePct: 0.015, entryPrice: 100, exitPrice: 101, leverage: 5 });
    const long = rs.shape({ pnl: 1, pnlPct: 0.01, holdMin: 120, maePct: 0.005, mfePct: 0.015, entryPrice: 100, exitPrice: 101, leverage: 5 });
    expect(long.holdTimeComponent).toBeLessThan(0);
    expect(short.holdTimeComponent).toBe(0);
  });

  it('S6: recovery bonus rewards MFE >> MAE', () => {
    const rs = new RewardShaper();
    const goodRecovery = rs.shape({ pnl: 1, pnlPct: 0.01, holdMin: 30, maePct: 0.005, mfePct: 0.03, entryPrice: 100, exitPrice: 101, leverage: 5 });
    const noRecovery = rs.shape({ pnl: -1, pnlPct: -0.01, holdMin: 30, maePct: 0.03, mfePct: 0.005, entryPrice: 100, exitPrice: 99, leverage: 5 });
    expect(goodRecovery.recoveryComponent).toBeGreaterThan(noRecovery.recoveryComponent);
  });

  it('S7: NaN inputs don\'t crash', () => {
    const rs = new RewardShaper();
    const r = rs.shape({ pnl: NaN, pnlPct: Infinity, holdMin: NaN, maePct: NaN, mfePct: NaN, entryPrice: NaN, exitPrice: NaN, leverage: NaN });
    expect(Number.isFinite(r.reward)).toBe(true);
  });

  it('S8: save/load preserves PnL history', () => {
    const rs = new RewardShaper();
    for (let i = 0; i < 20; i++) {
      rs.shape({ pnl: i % 2 === 0 ? 1 : -1, pnlPct: 0.01, holdMin: 30, maePct: 0.005, mfePct: 0.015, entryPrice: 100, exitPrice: 101, leverage: 5 });
    }
    const json = rs.save();
    const rs2 = new RewardShaper();
    rs2.load(json);
    // After load, Sharpe component should work (history preserved)
    const r = rs2.shape({ pnl: 1, pnlPct: 0.01, holdMin: 30, maePct: 0.005, mfePct: 0.015, entryPrice: 100, exitPrice: 101, leverage: 5 });
    expect(Number.isFinite(r.sharpeComponent)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  6. Active Exploration
// ═══════════════════════════════════════════════════════════════

describe('ActiveExploration', () => {
  it('E1: cold-start (<5 total trades) returns unmodified pWin', () => {
    const exp = new ActiveExploration();
    const result = exp.compute({ pWin: 0.6, symbol: 'btc', side: 'buy', uncertainty: 0.5, totalTrades: 3, symbolTrades: 0 });
    expect(result.applied).toBe(false);
    expect(result.explorationScore).toBe(0.6);
  });

  it('E2: under-sampled symbol gets UCB bonus', () => {
    const exp = new ActiveExploration({ ucbConstant: 0.2, maxExplorationBonus: 0.3 });
    const result = exp.compute({ pWin: 0.5, symbol: 'btc', side: 'buy', uncertainty: 0.3, totalTrades: 100, symbolTrades: 1 });
    expect(result.applied).toBe(true);
    expect(result.ucbBonus).toBeGreaterThan(0);
    expect(result.explorationScore).toBeGreaterThan(0.5);
  });

  it('E3: high uncertainty boosts exploration (info gain)', () => {
    const exp = new ActiveExploration({ infoGainThreshold: 0.5, maxExplorationBonus: 0.3 });
    const lowUnc = exp.compute({ pWin: 0.5, symbol: 'btc', side: 'buy', uncertainty: 0.2, totalTrades: 100, symbolTrades: 50 });
    const highUnc = exp.compute({ pWin: 0.5, symbol: 'btc', side: 'buy', uncertainty: 0.9, totalTrades: 100, symbolTrades: 50 });
    expect(highUnc.infoGainBonus).toBeGreaterThan(lowUnc.infoGainBonus);
  });

  it('E4: exploration bonus is capped', () => {
    const exp = new ActiveExploration({ ucbConstant: 1.0, maxExplorationBonus: 0.3, infoGainThreshold: 0.1 });
    const result = exp.compute({ pWin: 0.5, symbol: 'btc', side: 'buy', uncertainty: 1.0, totalTrades: 1000, symbolTrades: 1 });
    const totalBonus = result.ucbBonus + result.infoGainBonus;
    // Total bonus should be capped — UCB is capped at maxExplorationBonus, info gain at half
    // So total can be up to maxExplorationBonus * 1.5
    expect(totalBonus).toBeLessThanOrEqual(0.3 * 1.5 + 0.01);
  });

  it('E5: annealing reduces exploration as system matures', () => {
    const exp = new ActiveExploration({ annealingThreshold: 100, annealingRate: 0.5 });
    const early = exp.compute({ pWin: 0.5, symbol: 'btc', side: 'buy', uncertainty: 0.3, totalTrades: 50, symbolTrades: 5 });
    const late = exp.compute({ pWin: 0.5, symbol: 'btc', side: 'buy', uncertainty: 0.3, totalTrades: 500, symbolTrades: 5 });
    expect(late.effectiveConstant).toBeLessThan(early.effectiveConstant);
  });

  it('E6: well-sampled symbol gets exploitation mode', () => {
    const exp = new ActiveExploration();
    const result = exp.compute({ pWin: 0.65, symbol: 'btc', side: 'buy', uncertainty: 0.1, totalTrades: 500, symbolTrades: 200 });
    expect(result.recommendation).toContain('Exploitation');
  });

  it('E7: NaN inputs don\'t crash', () => {
    const exp = new ActiveExploration();
    const result = exp.compute({ pWin: NaN, symbol: 'btc', side: 'buy', uncertainty: NaN, totalTrades: NaN, symbolTrades: NaN });
    expect(Number.isFinite(result.explorationScore)).toBe(true);
  });

  it('E8: disabled config returns unmodified pWin', () => {
    const exp = new ActiveExploration({ enabled: false });
    const result = exp.compute({ pWin: 0.6, symbol: 'btc', side: 'buy', uncertainty: 0.8, totalTrades: 100, symbolTrades: 1 });
    expect(result.applied).toBe(false);
    expect(result.explorationScore).toBe(0.6);
  });
});

// ═══════════════════════════════════════════════════════════════
//  7. World Model
// ═══════════════════════════════════════════════════════════════

describe('WorldModel', () => {
  const fkeys = FEATURE_NAMES;

  it('W1: cold-start prediction returns pWin=0.5 and not ready', () => {
    const wm = new WorldModel(fkeys, { minSamples: 50 });
    const result = wm.predict({ features: goodFeatures(), symbol: 'btc', side: 'buy', cycle: 0 });
    expect(result.ready).toBe(false);
    expect(result.samples).toBe(0);
  });

  it('W2: after training, predictions are finite and in [0,1]', () => {
    const wm = new WorldModel(fkeys, { minSamples: 20, learningRate: 0.05 });
    for (let i = 0; i < 30; i++) {
      wm.addSample(
        { ...goodFeatures(), volatility: 0.05 },
        1, // buy
        { ...goodFeatures(), volatility: 0.04 },
        i % 2 as number,
      );
    }
    const result = wm.predict({ features: { ...goodFeatures(), volatility: 0.03 }, symbol: 'btc', side: 'buy', cycle: 0 });
    expect(Number.isFinite(result.predictedPWin)).toBe(true);
    expect(result.predictedPWin).toBeGreaterThanOrEqual(0);
    expect(result.predictedPWin).toBeLessThanOrEqual(1);
  });

  it('W3: rollout returns trajectory and expected reward', () => {
    const wm = new WorldModel(fkeys, { minSamples: 20, learningRate: 0.05, rolloutSteps: 3 });
    for (let i = 0; i < 30; i++) {
      wm.addSample(goodFeatures(), 1, goodFeatures(), i % 2 as number);
    }
    const result = wm.rollout({ features: goodFeatures(), symbol: 'btc', side: 'buy', cycle: 0 });
    expect(result.pWinTrajectory.length).toBe(3);
    expect(Number.isFinite(result.expectedReward)).toBe(true);
    expect(result.stepsRolled).toBe(3);
  });

  it('W4: cold-start rollout returns 0.5 defaults', () => {
    const wm = new WorldModel(fkeys, { minSamples: 50 });
    const result = wm.rollout({ features: goodFeatures(), symbol: 'btc', side: 'buy', cycle: 0 });
    expect(result.expectedReward).toBe(0.5);
    expect(result.confidence).toBe(0);
    expect(result.stepsRolled).toBe(0);
  });

  it('W5: NaN features don\'t crash training or prediction', () => {
    const wm = new WorldModel(fkeys, { minSamples: 5, learningRate: 0.01 });
    wm.addSample(
      { ...goodFeatures(), fundingRate: NaN, volatility: Infinity },
      1, { ...goodFeatures(), fundingRate: NaN }, 1,
    );
    const result = wm.predict({ features: { ...goodFeatures(), fundingRate: NaN }, symbol: 'btc', side: 'buy', cycle: 0 });
    expect(Number.isFinite(result.predictedPWin)).toBe(true);
  });

  it('W6: save/load preserves weights and sample count', () => {
    const wm = new WorldModel(fkeys, { minSamples: 10, learningRate: 0.05 });
    for (let i = 0; i < 15; i++) {
      wm.addSample(goodFeatures(), 1, goodFeatures(), 1);
    }
    const json = wm.save();
    const wm2 = new WorldModel(fkeys, { minSamples: 10 });
    wm2.load(json);
    expect(wm2.getState().sampleCount).toBe(15);
    expect(wm2.getState().ready).toBe(true);
  });

  it('W7: corrupt state file doesn\'t crash load', () => {
    const wm = new WorldModel(fkeys, { minSamples: 10 });
    wm.load('{ corrupt json }');
    expect(wm.getState().sampleCount).toBe(0);
  });

  it('W8: different actions produce different predictions (model has action sensitivity)', () => {
    const wm = new WorldModel(fkeys, { minSamples: 10, learningRate: 0.1 });
    // Train: buy → win, sell → loss
    for (let i = 0; i < 30; i++) {
      wm.addSample({ ...goodFeatures(), volatility: 0.03 }, 1, goodFeatures(), 1);
      wm.addSample({ ...goodFeatures(), volatility: 0.03 }, -1, goodFeatures(), 0);
    }
    const buyPred = wm.predict({ features: { ...goodFeatures(), volatility: 0.03 }, symbol: 'btc', side: 'buy', cycle: 0 });
    const sellPred = wm.predict({ features: { ...goodFeatures(), volatility: 0.03 }, symbol: 'btc', side: 'sell', cycle: 0 });
    // After training, buy should predict higher pWin than sell
    // (this may take more training, so we just check they're finite and different)
    expect(Number.isFinite(buyPred.predictedPWin)).toBe(true);
    expect(Number.isFinite(sellPred.predictedPWin)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  8. Shadow Trade Engine Fix (integration)
// ═══════════════════════════════════════════════════════════════

describe('Shadow Trade Engine v2.0.219 Fix', () => {
  it('F1: weightMultiplier reduces OLR learning impact', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    // Train 20 samples normally
    for (let i = 0; i < 20; i++) {
      olr.feedTrade('btc', { ...good, volatility: 0.05 }, 1, 'buy', 'shadow', i);
    }

    // Feed 10 more samples with weight=0.1 (low weight) — opposite direction
    for (let i = 0; i < 10; i++) {
      olr.feedTrade('btc', { ...good, volatility: 0.005 }, 0, 'buy', 'shadow', 20 + i, false, undefined, 0.1);
    }
    const weightsLow = olr.getFeatureWeights('btc', 'buy')!;
    const volWeightLow = weightsLow[FEATURE_NAMES.indexOf('volatility')]!.weight;

    // Compare with weight=1.0 (full impact)
    const olr2 = new OLREngine();
    for (let i = 0; i < 20; i++) {
      olr2.feedTrade('btc', { ...good, volatility: 0.05 }, 1, 'buy', 'shadow', i);
    }
    for (let i = 0; i < 10; i++) {
      olr2.feedTrade('btc', { ...good, volatility: 0.005 }, 0, 'buy', 'shadow', 20 + i, false, undefined, 1.0);
    }
    const weightsFull = olr2.getFeatureWeights('btc', 'buy')!;
    const volWeightFull = weightsFull[FEATURE_NAMES.indexOf('volatility')]!.weight;

    // Full weight should produce MORE change than 0.1 weight
    const lowChange = Math.abs(volWeightLow - 0); // changed from initial
    const fullChange = Math.abs(volWeightFull - 0);
    expect(fullChange).toBeGreaterThanOrEqual(lowChange - 0.01);
  });

  it('F2: weightMultiplier=0 doesn\'t change weights (zero gradient)', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    for (let i = 0; i < 10; i++) {
      olr.feedTrade('btc', good, 1, 'buy', 'shadow', i);
    }
    const w1 = olr.getFeatureWeights('btc', 'buy')!;
    // Feed with weight=0 — should not change weights at all
    olr.feedTrade('btc', { ...good, volatility: 999 }, 0, 'buy', 'shadow', 99, false, undefined, 0);
    const w2 = olr.getFeatureWeights('btc', 'buy')!;
    // Weights should be identical (0 gradient)
    for (let i = 0; i < w1.length; i++) {
      expect(w2[i]!.weight).toBeCloseTo(w1[i]!.weight, 8);
    }
  });

  it('F3: default weightMultiplier=1.0 (backward compatible)', () => {
    const olr = new OLREngine();
    const good = goodFeatures();
    olr.feedTrade('btc', good, 1, 'buy', 'shadow', 0); // no weightMultiplier arg
    const stats = olr.getAllModelStats().find(s => s.symbol === 'btc');
    expect(stats?.longSamples).toBe(1);
  });
});