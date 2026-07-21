import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ─── AntiPatternTracker getStats() ─────────────────────────────────
import { AntiPatternTracker } from '../src/evolution/anti-pattern-tracker.ts';

describe('AntiPatternTracker.getStats()', () => {
  it('returns zero counts on empty tracker', () => {
    const t = new AntiPatternTracker();
    const stats = t.getStats();
    expect(stats.clusterCount).toBe(0);
    expect(stats.ingestedCount).toBe(0);
    expect(stats.totalMembers).toBe(0);
  });

  it('getClusterCount() matches getStats().clusterCount', () => {
    const t = new AntiPatternTracker();
    expect(t.getClusterCount()).toBe(t.getStats().clusterCount);
  });

  it('getIngestedCount() matches getStats().ingestedCount', () => {
    const t = new AntiPatternTracker();
    expect(t.getIngestedCount()).toBe(t.getStats().ingestedCount);
  });
});

// ─── ShadowTradeEngine.drainRecentResults() ────────────────────────
import { ShadowTradeEngine } from '../src/evolution/shadow-trade-engine.ts';
import { OLREngine } from '../src/evolution/olr-engine.ts';

describe('ShadowTradeEngine.drainRecentResults()', () => {
  let engine: ShadowTradeEngine;
  let olr: OLREngine;

  beforeEach(() => {
    olr = new OLREngine();
    engine = new ShadowTradeEngine(olr);
  });

  it('returns empty array when no trades resolved', () => {
    expect(engine.drainRecentResults()).toEqual([]);
  });

  it('returns resolved trades and clears buffer (each resolution fed exactly once)', () => {
    // Open a shadow trade (long: SL=49000, TP=51000)
    engine.openShadowTrades('btc', 50000, 49000, 51000, null, null, 0, { volatility: 0.02 }, 'buy');
    // Resolve it (price hits TP — only the long trade should win)
    const resolved = engine.checkPositions('btc', 51000, 1, 51000, 50000, { volatility: 0.02 });
    expect(resolved).toBeGreaterThanOrEqual(1);

    // Drain should return resolved trades
    const drained = engine.drainRecentResults();
    expect(drained.length).toBeGreaterThanOrEqual(1);
    expect(drained[0].symbol).toBe('btc');
    // At least one should be a winning buy
    const winBuy = drained.find(d => d.side === 'buy' && d.outcome === 'win');
    expect(winBuy).toBeDefined();

    // Second drain should be empty (buffer cleared)
    const drained2 = engine.drainRecentResults();
    expect(drained2).toEqual([]);
  });

  it('includes MFE/MAE in drained results', () => {
    engine.openShadowTrades('btc', 50000, 49000, 51000, null, null, 0, { volatility: 0.02 }, 'buy');
    engine.checkPositions('btc', 51000, 1, 51000, 50000, { volatility: 0.02 });
    const drained = engine.drainRecentResults();
    expect(drained[0]).toHaveProperty('mfePct');
    expect(drained[0]).toHaveProperty('maePct');
  });
});

// ─── ReplayBuffer pipeline integration ────────────────────────────
import { ReplayBuffer } from '../src/evolution/replay-buffer.ts';

describe('ReplayBuffer pipeline', () => {
  it('add() increases totalSamples', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr);
    expect(rb.getStats().totalSamples).toBe(0);

    rb.add({
      symbol: 'btc',
      features: { volatility: 0.02 },
      outcome: 1,
      side: 'buy',
      source: 'real',
      cycle: 1,
      ts: Date.now(),
      pnl: 0.01,
    });

    expect(rb.getStats().totalSamples).toBe(1);
  });

  it('replayEpoch() is no-op when buffer < 10 samples', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr);
    rb.add({
      symbol: 'btc', features: { volatility: 0.02 }, outcome: 1,
      side: 'buy', source: 'real', cycle: 1, ts: Date.now(), pnl: 0.01,
    });
    expect(rb.replayEpoch()).toBe(0);
  });

  it('replayEpoch() feeds OLR when buffer >= 10 samples', () => {
    const olr = new OLREngine();
    const rb = new ReplayBuffer(olr);
    for (let i = 0; i < 15; i++) {
      rb.add({
        symbol: 'btc', features: { volatility: 0.02 }, outcome: i % 2,
        side: 'buy', source: 'real', cycle: i, ts: Date.now(), pnl: 0.01 * (i - 7),
      });
    }
    const fed = rb.replayEpoch();
    expect(fed).toBeGreaterThan(0);
    expect(rb.getStats().totalReplays).toBe(1);
  });
});

// ─── TemporalAttention pipeline ───────────────────────────────────
import { TemporalAttention } from '../src/evolution/temporal-attention.ts';

describe('TemporalAttention pipeline', () => {
  it('addTrade + updateOnOutcome increases updateCount', () => {
    const ta = new TemporalAttention();
    expect(ta.getState().updateCount).toBe(0);
    expect(ta.getState().historyLen).toBe(0);

    for (let i = 0; i < 5; i++) {
      ta.addTrade({
        symbol: 'btc', side: 'buy', features: { volatility: 0.02 },
        outcome: 1, pnl: 0.01, pnlPct: 0.01, ts: Date.now(), regime: 'trending_bull',
      });
    }
    expect(ta.getState().historyLen).toBe(5);

    ta.updateOnOutcome(0.01);
    expect(ta.getState().updateCount).toBe(1);
  });

  it('updateOnOutcome with zero reward does nothing', () => {
    const ta = new TemporalAttention();
    ta.addTrade({
      symbol: 'btc', side: 'buy', features: { volatility: 0.02 },
      outcome: 1, pnl: 0, pnlPct: 0, ts: Date.now(), regime: 'unknown',
    });
    ta.addTrade({
      symbol: 'btc', side: 'sell', features: { volatility: 0.03 },
      outcome: 0, pnl: 0, pnlPct: 0, ts: Date.now(), regime: 'unknown',
    });
    ta.updateOnOutcome(0);
    expect(ta.getState().updateCount).toBe(0);
  });
});

// ─── CrossSymbolBackbone pipeline ────────────────────────────────
import { CrossSymbolBackbone } from '../src/evolution/cross-symbol-backbone.ts';

describe('CrossSymbolBackbone pipeline', () => {
  it('feedTrade increases per-symbol sample count', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr);
    expect(csb.getStats()).toHaveLength(0);

    csb.feedTrade('btc', { volatility: 0.02 }, 1, 'buy');
    csb.feedTrade('btc', { volatility: 0.03 }, 0, 'sell');

    const stats = csb.getStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].symbol).toBe('btc');
    expect(stats[0].samples).toBe(2);
  });

  it('multiple symbols tracked independently', () => {
    const olr = new OLREngine();
    const csb = new CrossSymbolBackbone(olr);
    csb.feedTrade('btc', { volatility: 0.02 }, 1, 'buy');
    csb.feedTrade('eth', { volatility: 0.03 }, 0, 'sell');
    csb.feedTrade('sol', { volatility: 0.04 }, 1, 'buy');

    expect(csb.getStats()).toHaveLength(3);
  });
});

// ─── WorldModel pipeline ──────────────────────────────────────────
import { WorldModel } from '../src/evolution/world-model.ts';
import { FEATURE_NAMES } from '../src/evolution/olr-engine.ts';

describe('WorldModel pipeline', () => {
  it('addSample increases sampleCount', () => {
    const wm = new WorldModel([...FEATURE_NAMES]);
    expect(wm.getState().sampleCount).toBe(0);
    expect(wm.getState().ready).toBe(false);

    const features: Record<string, number> = {};
    for (const k of FEATURE_NAMES) features[k] = 0.02;
    wm.addSample(features, 1, features, 1);

    expect(wm.getState().sampleCount).toBe(1);
  });

  it('ready becomes true after minSamples (50)', () => {
    const wm = new WorldModel([...FEATURE_NAMES]);
    const features: Record<string, number> = {};
    for (const k of FEATURE_NAMES) features[k] = 0.02;
    for (let i = 0; i < 50; i++) {
      wm.addSample(features, 1, features, i % 2);
    }
    expect(wm.getState().ready).toBe(true);
  });
});
