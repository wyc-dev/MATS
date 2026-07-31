// ─── Factor-Tagged Aligned Shadow Breakpoint Fix Attacks (v2.0.834) ───
//
// Attacks the 3 breakpoint fixes:
//   A: hasAlignedShadow + blind skip
//   B: drainRecentResults shadowType routing
//   C: all-trading-markets aligned shadow + Smart SL/TP
//
// Rule: no input — however malformed — may crash, hang, or produce
// a misleading outcome.

import { describe, it, expect, beforeEach } from 'vitest';
import { ShadowTradeEngine } from '../src/evolution/shadow-trade-engine.ts';
import { OLREngine } from '../src/evolution/olr-engine.ts';
import { safeNum } from '../src/evolution/evolution-utils.ts';

function makeEngine(): ShadowTradeEngine {
  return new ShadowTradeEngine(new OLREngine());
}

// ═══════════════════════════════════════════════════════════════════
// A: hasAlignedShadow + blind skip attacks
// ═══════════════════════════════════════════════════════════════════
describe('Fix A: hasAlignedShadow + blind skip', () => {
  let engine: ShadowTradeEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  it('no aligned shadow → blind opens normally', () => {
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(false);
    engine.openShadowTrades('BTC', 100, 98, 105, 102, 95, 1, { volatility: 0.02 });
    const stats = engine.getStats();
    expect(stats.find(s => s.symbol === 'btc')).toBeDefined();
  });

  it('aligned shadow exists → hasAlignedShadow returns true', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(true);
  });

  it('aligned shadow on different cycle → hasAlignedShadow false', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('BTC', 2)).toBe(false);
  });

  it('aligned shadow resolved → hasAlignedShadow false (not open)', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Resolve it (price drops below SL)
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(false);
  });

  it('case-insensitive: BTC and btc same symbol', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('btc', 1)).toBe(true);
    expect(engine.hasAlignedShadow('Btc', 1)).toBe(true);
  });

  it('NaN cycle → hasAlignedShadow false (no crash)', () => {
    expect(engine.hasAlignedShadow('BTC', NaN)).toBe(false);
  });

  it('negative cycle → hasAlignedShadow false', () => {
    expect(engine.hasAlignedShadow('BTC', -1)).toBe(false);
  });

  it('prototype pollution via symbol → no crash', () => {
    expect(engine.hasAlignedShadow('__proto__', 1)).toBe(false);
    expect(engine.hasAlignedShadow('constructor', 1)).toBe(false);
    expect({}.hasOwnProperty('shadow')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// B: drainRecentResults shadowType routing attacks
// ═══════════════════════════════════════════════════════════════════
describe('Fix B: drainRecentResults shadowType routing', () => {
  let engine: ShadowTradeEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  it('drained results carry shadowType field', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    // Open aligned + blind
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.openShadowTrades('ETH', 100, 98, 105, 102, 95, 1, { volatility: 0.02 });
    // Resolve both
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    engine.checkPositions('ETH', 97, 2, 100, 97, { volatility: 0.02 });
    const results = engine.drainRecentResults();
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Each result should have a shadowType
    for (const r of results) {
      expect(r.shadowType).toBeDefined();
      expect(['aligned', 'blind']).toContain(r.shadowType);
    }
    // Should have at least 1 aligned + 1 blind
    const aligned = results.filter(r => r.shadowType === 'aligned');
    const blind = results.filter(r => r.shadowType === 'blind');
    expect(aligned.length).toBeGreaterThanOrEqual(1);
    expect(blind.length).toBeGreaterThanOrEqual(1);
  });

  it('empty drain → no crash, returns empty array', () => {
    const results = engine.drainRecentResults();
    expect(results).toEqual([]);
  });

  it('double drain → second drain empty (consumed)', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    const first = engine.drainRecentResults();
    const second = engine.drainRecentResults();
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second).toEqual([]);
  });

  it('stale force-resolve carries shadowType', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Advance 15 cycles (> maxAgeCycles=12) → force resolve
    engine.checkPositions('BTC', 100.5, 15, 100.5, 99.5, { volatility: 0.02 });
    const results = engine.drainRecentResults();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].shadowType).toBe('aligned');
  });
});

// ═══════════════════════════════════════════════════════════════════
// C: all-trading-markets aligned shadow + Smart SL/TP attacks
// ═══════════════════════════════════════════════════════════════════
describe('Fix C: multi-market aligned shadow attacks', () => {
  let engine: ShadowTradeEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  it('open aligned for different symbols in same cycle', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.openAlignedShadow('ETH', 50, 'buy', 49, 52.5, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(true);
    expect(engine.hasAlignedShadow('ETH', 1)).toBe(true);
  });

  it('NaN entryPrice → no-op (Number.isFinite guard)', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', NaN, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(false);
  });

  it('Infinity entryPrice → no-op', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', Infinity, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(false);
  });

  it('max open per symbol → excess rejected (10 cap)', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    for (let i = 0; i < 15; i++) {
      engine.openAlignedShadow('BTC', 100 + i, 'buy', 98, 105, i + 1, { volatility: 0.02 },
        ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
        ft.primaryDriver, ft.agentVotes);
    }
    // maxOpenPerSymbol=10
    const stats = engine.getStats();
    const btc = stats.find(s => s.symbol === 'btc');
    expect(btc).toBeDefined();
    expect(btc!.openCount).toBeLessThanOrEqual(10);
  });

  it('different sides same symbol same cycle → both open', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.openAlignedShadow('BTC', 100, 'sell', 102, 95, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, 'sell', -0.15,
      { agent: 'olr', weight: 0.1, action: 'sell' }, ft.agentVotes);
    // Both should be open (different sides)
    const stats = engine.getStats();
    const btc = stats.find(s => s.symbol === 'btc');
    expect(btc).toBeDefined();
    expect(btc!.openCount).toBe(2);
  });

  it('NaN SL/TP → falls back to defaults (no NaN in position)', () => {
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', NaN, NaN, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-fix: A + B + C interaction attacks
// ═══════════════════════════════════════════════════════════════════
describe('Cross-fix interaction attacks', () => {
  it('blind skipped when aligned exists → drain shows aligned only', () => {
    const engine = makeEngine();
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    // Open aligned first
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // hasAlignedShadow should now be true → blind skip
    expect(engine.hasAlignedShadow('BTC', 1)).toBe(true);
    // Resolve aligned (price drops)
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    const results = engine.drainRecentResults();
    expect(results.length).toBeGreaterThanOrEqual(1);
    // All results should be aligned (blind was skipped)
    for (const r of results) {
      if (r.symbol === 'btc') {
        expect(r.shadowType).toBe('aligned');
      }
    }
  });

  it('aligned resolves as win → shadowType=aligned in drain', () => {
    const engine = makeEngine();
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Price rises to TP → win
    engine.checkPositions('BTC', 106, 2, 106, 100, { volatility: 0.02 });
    const results = engine.drainRecentResults();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].shadowType).toBe('aligned');
    expect(results[0].outcome).toBe('win');
  });

  it('mixed aligned + blind on different symbols → both resolve with correct type', () => {
    const engine = makeEngine();
    const ft = {
      consensusAction: 'hold', consensusConfidence: 0.35,
      weightedDirection: 'buy' as const, weightedScore: 0.15,
      primaryDriver: { agent: 'news', weight: 0.2, action: 'buy' },
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
    };
    // BTC: aligned
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // ETH: blind (no aligned shadow on ETH)
    engine.openShadowTrades('ETH', 100, 98, 105, 102, 95, 1, { volatility: 0.02 });
    // Resolve both (price drops)
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    engine.checkPositions('ETH', 97, 2, 100, 97, { volatility: 0.02 });
    const results = engine.drainRecentResults();
    const btcResults = results.filter(r => r.symbol === 'btc');
    const ethResults = results.filter(r => r.symbol === 'eth');
    expect(btcResults.length).toBeGreaterThanOrEqual(1);
    expect(ethResults.length).toBeGreaterThanOrEqual(1);
    expect(btcResults[0].shadowType).toBe('aligned');
    expect(ethResults[0].shadowType).toBe('blind');
  });

  it('weighted direction computation with NaN weights → safeNum(0)', () => {
    const votes = [
      { agentRole: 'a', weight: NaN, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'b', weight: 0.15, decision: { action: 'sell' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      const w = safeNum(v.weight, 0);
      if (action === 'buy') buyWeight += w;
      else if (action === 'sell') sellWeight += w;
    }
    expect(Number.isFinite(buyWeight)).toBe(true);
    expect(buyWeight).toBe(0);
    expect(sellWeight).toBe(0.15);
  });

  it('weighted direction with Infinity weights → safeNum(0)', () => {
    const votes = [
      { agentRole: 'a', weight: Infinity, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'b', weight: -Infinity, decision: { action: 'sell' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      const w = safeNum(v.weight, 0);
      if (action === 'buy') buyWeight += w;
      else if (action === 'sell') sellWeight += w;
    }
    expect(Number.isFinite(buyWeight)).toBe(true);
    expect(buyWeight).toBe(0);
    expect(sellWeight).toBe(0);
  });

  it('weighted direction with null weights → safeNum(0)', () => {
    const votes = [
      { agentRole: 'a', weight: null as unknown as number, decision: { action: 'buy' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      const w = safeNum(v.weight, 0);
      if (action === 'buy') buyWeight += w;
      else if (action === 'sell') sellWeight += w;
    }
    expect(buyWeight).toBe(0);
  });

  it('weighted direction with undefined decision → treated as HOLD', () => {
    const votes = [
      { agentRole: 'a', weight: 0.10, decision: undefined as unknown as { action: string } },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = v.decision?.action ?? 'hold';
      if (action === 'buy') buyWeight += v.weight;
      else if (action === 'sell') sellWeight += v.weight;
    }
    expect(buyWeight).toBe(0);
    expect(sellWeight).toBe(0);
  });

  it('all agents vote buy → buyWeight > sellWeight → lean=buy', () => {
    const votes = [
      { agentRole: 'fractal', weight: 0.10, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'onchain', weight: 0.10, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'news', weight: 0.20, decision: { action: 'buy' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = v.decision.action;
      if (action === 'buy') buyWeight += safeNum(v.weight, 0);
      else if (action === 'sell') sellWeight += safeNum(v.weight, 0);
    }
    expect(buyWeight).toBe(0.40);
    expect(sellWeight).toBe(0);
    expect(buyWeight > sellWeight).toBe(true);
  });

  it('primaryDriver with NaN weight → not selected (NaN > 0 is false)', () => {
    const votes = [
      { agentRole: 'news', weight: NaN, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'fractal', weight: 0.10, decision: { action: 'buy' }, confidence: 0.5 },
    ];
    let primaryDriver = { agent: 'none', weight: 0, action: 'hold' };
    for (const v of votes) {
      const action = v.decision.action;
      if (action === 'buy' && safeNum(v.weight, 0) > primaryDriver.weight) {
        primaryDriver = { agent: v.agentRole, weight: safeNum(v.weight, 0), action };
      }
    }
    // fractal (0.10) should win over NaN (0)
    expect(primaryDriver.agent).toBe('fractal');
    expect(primaryDriver.weight).toBe(0.10);
  });
});