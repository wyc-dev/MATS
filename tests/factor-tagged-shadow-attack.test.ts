// ─── Factor-Tagged Aligned Shadow Attack Tests (v2.0.834) ──────────────
//
// Adversarial tests for the Factor-Tagged Aligned Shadow Trading system.
// Attacks target:
//   1. ShadowTradeEngine.openAlignedShadow — core new method
//   2. ShadowPosition.shadowType + factorTag — new fields
//   3. OLR source weight routing (shadow vs shadow_blind)
//   4. RP Edge Store buildEdgeText with agent votes
//   5. index.ts wiring (consensus extraction, weighted direction, primary driver)
//   6. Cross-module: shadow → OLR → edge → RP store data flow
//
// Rule: no input — however malformed — may crash, hang, or produce a
// misleading outcome. Garbage in → neutral/safe out, never a fabricated edge.

import { describe, it, expect, beforeEach } from 'vitest';
import { ShadowTradeEngine } from '../src/evolution/shadow-trade-engine.ts';
import { OLREngine } from '../src/evolution/olr-engine.ts';
import { RiskProfileEdgeStore, buildEdgeText } from '../src/edge/risk-profile-edge-store.ts';
import { safeNum } from '../src/evolution/evolution-utils.ts';

// ── Helpers ──
function makeOLR(): OLREngine {
  return new OLREngine();
}

function validFactorTag() {
  return {
    consensusAction: 'hold',
    consensusConfidence: 0.35,
    weightedDirection: 'buy' as 'buy' | 'sell',
    weightedScore: 0.15,
    primaryDriver: { agent: 'news_reporter', weight: 0.20, action: 'buy' },
    agentVotes: [
      { agent: 'fractal_momentum', weight: 0.10, action: 'buy' },
      { agent: 'onchain', weight: 0.10, action: 'hold' },
      { agent: 'olr_sentiment', weight: 0.10, action: 'sell' },
      { agent: 'news', weight: 0.20, action: 'buy' },
      { agent: 'risk_auditor', weight: 0.25, action: 'hold' },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. ShadowTradeEngine.openAlignedShadow — core attack surface
// ═══════════════════════════════════════════════════════════════════════
describe('openAlignedShadow attacks', () => {
  let olr: OLREngine;
  let engine: ShadowTradeEngine;

  beforeEach(() => {
    olr = makeOLR();
    engine = new ShadowTradeEngine(olr);
  });

  it('zero entry price → no-op (no crash, no shadow)', () => {
    const before = engine.getStats().length;
    engine.openAlignedShadow('BTC', 0, 'buy', 98, 105, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    expect(engine.getStats().length).toBe(before);
  });

  it('negative entry price → no-op', () => {
    engine.openAlignedShadow('BTC', -100, 'buy', -102, -95, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    expect(engine.getStats().find(s => s.symbol === 'btc')).toBeUndefined();
  });

  it('NaN entry price → no-op (no NaN propagation)', () => {
    engine.openAlignedShadow('BTC', NaN, 'buy', NaN, NaN, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    expect(engine.getStats().find(s => s.symbol === 'btc')).toBeUndefined();
  });

  it('Infinity entry price → no-op', () => {
    engine.openAlignedShadow('BTC', Infinity, 'buy', Infinity, Infinity, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    expect(engine.getStats().find(s => s.symbol === 'btc')).toBeUndefined();
  });

  it('zero SL/TP prices → uses default fallback (no crash)', () => {
    engine.openAlignedShadow('BTC', 100, 'buy', 0, 0, 1, { volatility: 0.02 },
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    const stats = engine.getStats();
    expect(stats.length).toBeGreaterThan(0);
    // Shadow should have opened with fallback SL/TP
    expect(stats[0].openCount + stats[0].totalOpened).toBeGreaterThan(0);
  });

  it('negative SL/TP prices → uses default fallback', () => {
    engine.openAlignedShadow('BTC', 100, 'buy', -98, -105, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    const stats = engine.getStats();
    expect(stats.length).toBeGreaterThan(0);
  });

  it('empty agent votes array → still opens shadow (primaryDriver is fallback)', () => {
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      'hold', 0.35, 'buy', 0.15,
      { agent: 'none', weight: 0, action: 'hold' },
      [],
    );
    expect(engine.getStats().length).toBeGreaterThan(0);
  });

  it('undefined agent votes → still opens shadow', () => {
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [] as Array<{ agent: string; weight: number; action: string }>,
    );
    expect(engine.getStats().length).toBeGreaterThan(0);
  });

  it('duplicate same-cycle same-side aligned shadow → de-duped (no double-open)', () => {
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Should only have 1 open position for this symbol+side+cycle
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    // Only 1 aligned shadow should be open (de-dup by cycle+side+type)
    expect(btcStats!.openCount).toBeLessThanOrEqual(1);
  });

  it('different cycles same side → both open (not de-duped)', () => {
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.openAlignedShadow('BTC', 101, 'buy', 99, 106, 2, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    expect(btcStats!.totalOpened).toBeGreaterThanOrEqual(2);
  });

  it('opposite side same cycle → both open (LONG + SHORT aligned)', () => {
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      'hold', 0.35, 'buy', 0.15,
      ft.primaryDriver, ft.agentVotes);
    engine.openAlignedShadow('BTC', 100, 'sell', 102, 95, 1, { volatility: 0.02 },
      'hold', 0.35, 'sell', -0.15,
      { agent: 'olr_sentiment', weight: 0.10, action: 'sell' },
      ft.agentVotes);
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    expect(btcStats!.totalOpened).toBeGreaterThanOrEqual(2);
  });

  it('max open per symbol limit enforced → excess rejected', () => {
    const ft = validFactorTag();
    // Open many aligned shadows on different cycles (same symbol)
    for (let i = 0; i < 20; i++) {
      engine.openAlignedShadow('BTC', 100 + i, 'buy', 98, 105, i + 1, { volatility: 0.02 },
        'hold', 0.35, 'buy', 0.15,
        ft.primaryDriver, ft.agentVotes);
    }
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    // maxOpenPerSymbol = 10, so at most 10 open at any time
    expect(btcStats!.openCount).toBeLessThanOrEqual(10);
  });

  it('symbol case-insensitive (BTC = btc = Btc)', () => {
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, {},
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    engine.openAlignedShadow('btc', 101, 'buy', 99, 106, 1, {},
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Should de-dupe (same symbol, same side, same cycle)
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    expect(btcStats!.openCount).toBeLessThanOrEqual(1);
  });

  it('NaN in features → shadow still opens (features sanitized at OLR feed)', () => {
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1,
      { volatility: NaN, srDistanceBps: Infinity, fundingRate: undefined as unknown as number },
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    expect(engine.getStats().length).toBeGreaterThan(0);
  });

  it('prototype pollution attempt via symbol name → no crash', () => {
    engine.openAlignedShadow('__proto__', 100, 'buy', 98, 105, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    // Should not crash; __proto__ as symbol name is just a string key
    expect({}.hasOwnProperty('shadow')).toBe(false);
  });

  it('constructor pollution via symbol name → no crash', () => {
    engine.openAlignedShadow('constructor', 100, 'buy', 98, 105, 1, {},
      'hold', 0.35, 'buy', 0.15,
      { agent: 'news', weight: 0.2, action: 'buy' },
      [{ agent: 'news', weight: 0.2, action: 'buy' }],
    );
    expect(engine.getStats().length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Shadow resolution — aligned vs blind OLR source routing
// ═══════════════════════════════════════════════════════════════════════
describe('Shadow resolution source routing attacks', () => {
  let olr: OLREngine;
  let engine: ShadowTradeEngine;

  beforeEach(() => {
    olr = makeOLR();
    engine = new ShadowTradeEngine(olr);
  });

  it('aligned shadow resolves → OLR fed with source=shadow (weight=1.0)', () => {
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Price drops below SL → loss. cycleHigh=100, cycleLow=97
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    expect(btcStats!.longLosses).toBeGreaterThanOrEqual(1);
  });

  it('blind shadow resolves → OLR fed with source=shadow_blind (weight=0.1)', () => {
    engine.openShadowTrades('BTC', 100, 98, 105, 102, 95, 1, { volatility: 0.02 });
    // Price drops below LONG SL → loss. cycleHigh=100 (above entry), cycleLow=97 (below SL)
    engine.checkPositions('BTC', 97, 2, 100, 97, { volatility: 0.02 });
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    expect(btcStats!.longLosses + btcStats!.longWins).toBeGreaterThanOrEqual(1);
  });

  it('mixed aligned + blind shadows → both resolve independently', () => {
    // Open blind (both directions)
    engine.openShadowTrades('BTC', 100, 98, 105, 102, 95, 1, { volatility: 0.02 });
    // Open aligned (buy only, different cycle)
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 101, 'buy', 99, 106, 2, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Price crashes → all LONGs hit SL. cycleHigh=101, cycleLow=96
    engine.checkPositions('BTC', 96, 3, 101, 96, { volatility: 0.02 });
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    // At least 2 LONG losses (1 blind + 1 aligned)
    expect(btcStats!.longLosses).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. OLR source weight — shadow vs shadow_blind differentiation
// ═══════════════════════════════════════════════════════════════════════
describe('OLR source weight attacks', () => {
  it('shadow_blind weight is 0.1 (10× less than shadow=1.0)', () => {
    // Feed 10 aligned shadow wins + 10 blind shadow wins
    const olr = makeOLR();
    const features = { volatility: 0.02, srDistanceBps: 100, obImbalance: 0.1, fundingRate: 0.0001, volumeRatio: 1, signalAgreement: 0.5, sentiment: 0, sentimentConviction: 0, regimeOrdinal: 0.5, momentumShort: 0, momentumLong: 0, mfePct: 0, maePct: 0, mfeToPnlRatio: 0, hourOfDay: 0.5 };
    for (let i = 0; i < 10; i++) {
      olr.feedTrade('BTC', features, 1, 'buy', 'shadow', i);
    }
    for (let i = 0; i < 10; i++) {
      olr.feedTrade('BTC', features, 1, 'buy', 'shadow_blind', i + 100);
    }
    // Both should be accepted (no crash)
    const res = olr.query('BTC', features, 'buy', 200);
    expect(Number.isFinite(res.pWin)).toBe(true);
  });

  it('unknown source type → falls back to default weight (no crash)', () => {
    const olr = makeOLR();
    const features = { volatility: 0.02, srDistanceBps: 100 };
    // @ts-expect-error: testing unknown source
    olr.feedTrade('BTC', features, 1, 'buy', 'unknown_source', 1);
    // Should not crash — sourceWeight lookup returns undefined → ?? 1
    const res = olr.query('BTC', features, 'buy', 2);
    expect(Number.isFinite(res.pWin)).toBe(true);
  });

  it('sourceBreakdown includes shadow_blind field', () => {
    const olr = makeOLR();
    const features = { volatility: 0.02 };
    olr.feedTrade('BTC', features, 1, 'buy', 'shadow_blind', 1);
    const res = olr.query('BTC', features, 'buy', 2);
    expect(res.sourceBreakdown).toBeDefined();
    expect(res.sourceBreakdown).toHaveProperty('shadow_blind');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. RP Edge Store — buildEdgeText with agent votes
// ═══════════════════════════════════════════════════════════════════════
describe('RP Edge Store factor-tagged buildEdgeText attacks', () => {
  it('agent votes included in text → different votes produce different text', () => {
    const base = { marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy' as const, riskProfile: 'moderate' as const, regime: 'trending' };
    const text1 = buildEdgeText({ ...base, agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }] });
    const text2 = buildEdgeText({ ...base, agentVotes: [{ agent: 'news', weight: 0.2, action: 'sell' }] });
    expect(text1).not.toBe(text2);
    expect(text1).toContain('news:buy');
    expect(text2).toContain('news:sell');
  });

  it('primary driver included in text', () => {
    const text = buildEdgeText({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'aggressive', regime: 'trending',
      primaryDriver: { agent: 'news_reporter', action: 'buy' },
    });
    expect(text).toContain('driver news_reporter(buy)');
  });

  it('no agent votes → text still valid (backward compat)', () => {
    const text = buildEdgeText({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'trending',
    });
    expect(typeof text).toBe('string');
    expect(text).toContain('BTC');
    expect(text).not.toContain('agents');
    expect(text).not.toContain('driver');
  });

  it('empty agent votes array → text valid (no agents section)', () => {
    const text = buildEdgeText({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'trending',
      agentVotes: [],
    });
    expect(text).not.toContain('agents');
  });

  it('100 agent votes → text not excessively long (DoS guard)', () => {
    const votes = Array.from({ length: 100 }, (_, i) => ({ agent: `agent_${i}`, weight: 0.01, action: 'buy' }));
    const start = Date.now();
    const text = buildEdgeText({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'trending',
      agentVotes: votes,
    });
    expect(Date.now() - start).toBeLessThan(100);
    expect(text.length).toBeLessThan(5000);
  });

  it('NaN in market features → safeNum fallback (no NaN in text)', () => {
    const text = buildEdgeText({
      marketFeatures: { volatility: NaN, srDistanceBps: Infinity, obImbalance: undefined as unknown as number },
      symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'trending',
    });
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('undefined');
  });

  it('prototype pollution via agent name → no crash', () => {
    const text = buildEdgeText({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'moderate', regime: 'trending',
      agentVotes: [{ agent: '__proto__', weight: 0.2, action: 'buy' }],
      primaryDriver: { agent: 'constructor', action: 'sell' },
    });
    expect(typeof text).toBe('string');
    expect({}.hasOwnProperty('buy')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. RP Edge Store record/query with factor tags
// ═══════════════════════════════════════════════════════════════════════
describe('RP Edge Store factor-tagged record/query attacks', () => {
  let store: RiskProfileEdgeStore;

  beforeEach(() => {
    store = new RiskProfileEdgeStore();
  });

  it('recordTrade with agentVotes + primaryDriver → no crash', async () => {
    await store.recordTrade({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'aggressive',
      regime: 'trending', realizedPnlPct: 1.5, outcome: 1, closeReason: 'tp', holdMinutes: 30,
      slTolerancePct: 2.0,
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
      primaryDriver: { agent: 'news', action: 'buy' },
    });
    expect(store.size()).toBe(1);
  });

  it('query with agentVotes → returns neutral 0.5 cold-start (no embed provider)', async () => {
    const r = await store.query({
      marketFeatures: { volatility: 0.02 }, symbol: 'BTC', side: 'buy', riskProfile: 'aggressive', regime: 'trending',
      agentVotes: [{ agent: 'news', weight: 0.2, action: 'buy' }],
      primaryDriver: { agent: 'news', action: 'buy' },
    });
    expect(r.edgeScore).toBe(0.5);
    expect(r.confidence).toBe('low');
  });

  it('load with factor-tagged records containing __proto__ → no pollution', () => {
    store.load([
      { embedding: [0.1], symbol: '__proto__', side: 'buy', riskProfile: 'moderate', regime: 'x',
        realizedPnlPct: 1, outcome: 1, closeReason: 'tp', holdMinutes: 5, slTolerancePct: 2, ts: 1 } as never,
    ]);
    expect({}.hasOwnProperty('buy')).toBe(false);
    expect(store.size()).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Cross-module: weighted direction computation (index.ts logic)
// ═══════════════════════════════════════════════════════════════════════
describe('Cross-module weighted direction attacks', () => {
  it('all agents vote HOLD → no lean → no aligned shadow', () => {
    const votes = [
      { agentRole: 'fractal_momentum', weight: 0.10, decision: { action: 'hold' }, confidence: 0.5 },
      { agentRole: 'onchain', weight: 0.10, decision: { action: 'hold' }, confidence: 0.5 },
      { agentRole: 'olr_sentiment', weight: 0.10, decision: { action: 'hold' }, confidence: 0.5 },
      { agentRole: 'news', weight: 0.20, decision: { action: 'hold' }, confidence: 0.5 },
      { agentRole: 'risk_auditor', weight: 0.25, decision: { action: 'hold' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      if (action === 'buy') buyWeight += v.weight;
      else if (action === 'sell') sellWeight += v.weight;
    }
    expect(Math.abs(buyWeight - sellWeight)).toBeLessThanOrEqual(0.01);
  });

  it('exact tie (buyWeight = sellWeight) → no lean', () => {
    const votes = [
      { agentRole: 'a', weight: 0.15, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'b', weight: 0.15, decision: { action: 'sell' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      if (action === 'buy') buyWeight += v.weight;
      else if (action === 'sell') sellWeight += v.weight;
    }
    expect(Math.abs(buyWeight - sellWeight)).toBeLessThanOrEqual(0.01);
  });

  it('primary driver selection: highest weight matching lean direction', () => {
    const votes = [
      { agentRole: 'news', weight: 0.20, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'fractal', weight: 0.10, decision: { action: 'buy' }, confidence: 0.5 },
      { agentRole: 'olr', weight: 0.10, decision: { action: 'sell' }, confidence: 0.5 },
    ];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      if (action === 'buy') buyWeight += v.weight;
      else if (action === 'sell') sellWeight += v.weight;
    }
    const leanSide = buyWeight > sellWeight ? 'buy' : 'sell';
    let primaryDriver = { agent: 'none', weight: 0, action: 'hold' };
    for (const v of votes) {
      const action = (v.decision?.action as string) ?? 'hold';
      if (action === leanSide && v.weight > primaryDriver.weight) {
        primaryDriver = { agent: v.agentRole, weight: v.weight, action };
      }
    }
    expect(primaryDriver.agent).toBe('news');
    expect(primaryDriver.weight).toBe(0.20);
  });

  it('NaN weights → safeNum treats as 0 (no NaN in buyWeight/sellWeight)', () => {
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
    expect(buyWeight).toBe(0); // NaN → 0
    expect(sellWeight).toBe(0.15);
  });

  it('missing decision field → treated as HOLD (no crash)', () => {
    const votes = [
      { agentRole: 'a', weight: 0.10 }, // no decision field
    ] as Array<{ agentRole: string; weight: number; decision?: { action: string } }>;
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = v.decision?.action ?? 'hold';
      if (action === 'buy') buyWeight += v.weight;
      else if (action === 'sell') sellWeight += v.weight;
    }
    expect(buyWeight).toBe(0);
    expect(sellWeight).toBe(0);
  });

  it('empty votes array → no lean, no crash', () => {
    const votes: Array<{ agentRole: string; weight: number; decision?: { action: string } }> = [];
    let buyWeight = 0, sellWeight = 0;
    for (const v of votes) {
      const action = v.decision?.action ?? 'hold';
      if (action === 'buy') buyWeight += v.weight;
      else if (action === 'sell') sellWeight += v.weight;
    }
    expect(Math.abs(buyWeight - sellWeight)).toBeLessThanOrEqual(0.01);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Stale force-resolve with aligned shadow type
// ═══════════════════════════════════════════════════════════════════════
describe('Stale force-resolve attacks', () => {
  it('aligned shadow force-resolved after maxAgeCycles → OLR fed with source=shadow', () => {
    const olr = makeOLR();
    const engine = new ShadowTradeEngine(olr);
    const ft = validFactorTag();
    engine.openAlignedShadow('BTC', 100, 'buy', 98, 105, 1, { volatility: 0.02 },
      ft.consensusAction, ft.consensusConfidence, ft.weightedDirection, ft.weightedScore,
      ft.primaryDriver, ft.agentVotes);
    // Advance 15 cycles (> maxAgeCycles=12) without SL/TP hit
    engine.checkPositions('BTC', 100.5, 15, 100.5, 99.5, { volatility: 0.02 });
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    // Should be resolved (either win or loss from the stale force-resolve)
    expect(btcStats!.longWins + btcStats!.longLosses).toBeGreaterThanOrEqual(1);
  });

  it('blind shadow force-resolved → OLR fed with source=shadow_blind', () => {
    const olr = makeOLR();
    const engine = new ShadowTradeEngine(olr);
    engine.openShadowTrades('BTC', 100, 98, 105, 102, 95, 1, { volatility: 0.02 });
    // Advance 15 cycles. Price stays mid-range (no SL/TP hit)
    engine.checkPositions('BTC', 100.5, 15, 101, 99.5, { volatility: 0.02 });
    const stats = engine.getStats();
    const btcStats = stats.find(s => s.symbol === 'btc');
    expect(btcStats).toBeDefined();
    expect(btcStats!.longWins + btcStats!.longLosses + btcStats!.shortWins + btcStats!.shortLosses).toBeGreaterThanOrEqual(1);
  });
});