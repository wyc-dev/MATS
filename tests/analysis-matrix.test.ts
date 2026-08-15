// ─── v2.0.822: Analysis Matrix Builder tests ────────────────────────────
//
// Locks in the 3×3 (risk profile × position state) recommendation matrix
// expansion from a per-symbol consensus. The matrix is what the backend
// writes to Supabase each cycle; the app reads the cell matching the user's
// risk profile + current position.

import { describe, it, expect } from 'vitest';
import { buildAssetAnalysis } from '../src/services/analysis-matrix.ts';
import type { PerSymbolConsensus, AggregatedMarketState } from '../src/types/index.ts';
import type { AggregatedMarketState as MS } from '../src/data/market-state.ts';

function psc(action: 'buy' | 'sell' | 'hold' | 'close', confidence: number, opts: Partial<PerSymbolConsensus> = {}): PerSymbolConsensus {
  return {
    symbol: 'btc', action, confidence, hasPosition: false, closePosition: false,
    positionSizePct: 0.1, leverage: 5, rationale: 'test thesis', ...opts,
  };
}

function ms(price: number, vol = 0.01, regime = 'medium_volatility'): MS {
  return {
    primarySymbol: 'btc', price, change24h: 2.5, volume24h: 1000,
    trend: 'up', volatility: vol, regime, orderBookImbalance: 0, updatedAt: Date.now(),
  };
}

describe('AnalysisMatrixBuilder — v2.0.822', () => {
  it('builds a 3×3 matrix for a BUY consensus', () => {
    const a = buildAssetAnalysis('btc', psc('buy', 0.8), ms(50000), 100, 0.6, 9, 11)!;
    expect(a).not.toBeNull();
    expect(a.symbol).toBe('btc');
    expect(a.cycleId).toBe(100);
    // moderate (calibrated) for flat → buy
    expect(a.matrix.moderate.flat.action).toBe('buy');
    expect(a.matrix.moderate.flat.conviction).toBeCloseTo(0.8);
    expect(a.matrix.moderate.flat.calibrated).toBe(true);
    // moderate for long → hold (already long)
    expect(a.matrix.moderate.long.action).toBe('hold');
    // moderate for short → flip (close short + open long)
    expect(a.matrix.moderate.short.action).toBe('flip');
  });

  it('builds a SELL consensus: flat→sell, long→flip, short→hold', () => {
    const a = buildAssetAnalysis('btc', psc('sell', 0.7), ms(50000), 101, 0.5, 7, 11)!;
    expect(a.matrix.moderate.flat.action).toBe('sell');
    expect(a.matrix.moderate.long.action).toBe('flip');
    expect(a.matrix.moderate.short.action).toBe('hold');
  });

  it('builds a HOLD consensus: all position states → hold', () => {
    const a = buildAssetAnalysis('btc', psc('hold', 0.3), ms(50000), 102, 0.5, 3, 11)!;
    for (const state of ['long', 'short', 'flat'] as const) {
      expect(a.matrix.moderate[state].action).toBe('hold');
    }
  });

  it('closePosition=true → long/short → close, flat → hold (cannot close nothing)', () => {
    const a = buildAssetAnalysis('btc', psc('hold', 0.5, { closePosition: true }), ms(50000), 103, 0.5, 5, 11)!;
    expect(a.matrix.moderate.long.action).toBe('close');
    expect(a.matrix.moderate.short.action).toBe('close');
    expect(a.matrix.moderate.flat.action).toBe('hold'); // flat + closePosition → hold
  });

  it('v2.0.857: moderate-only — aggressive/conservative removed, matrix has only moderate', () => {
    // v2.0.857: risk profiles removed. buildAssetAnalysis returns a moderate-only
    // matrix; aggressive/conservative keys no longer exist.
    const a = buildAssetAnalysis('btc', psc('buy', 0.6), ms(50000), 104, 0.6, 9, 11)!;
    expect(a.matrix.moderate.flat.action).toBe('buy');
    expect(a.matrix.moderate.flat.conviction).toBeCloseTo(0.6); // moderate baseline, DCS never affects
    expect(a.matrix.moderate.flat.calibrated).toBe(true); // moderate always calibrated
    // aggressive/conservative keys removed
    expect((a.matrix as any).aggressive).toBeUndefined();
    expect((a.matrix as any).conservative).toBeUndefined();
  });

  it('v2.0.857: DCS argument tolerated but never affects moderate conviction', () => {
    // v2.0.836 backward-compat: DCS passed (1.0) but moderate ignores it.
    const a = buildAssetAnalysis('btc', psc('buy', 0.6), ms(50000), 104, 0.6, 9, 11, undefined, undefined, 1.0)!;
    expect(a.matrix.moderate.flat.action).toBe('buy');
    expect(a.matrix.moderate.flat.conviction).toBeCloseTo(0.6); // no DCS boost
    expect(a.matrix.moderate.flat.calibrated).toBe(true);
  });

  it('v2.0.857: conviction never exceeds 1.0 (moderate baseline)', () => {
    const a = buildAssetAnalysis('btc', psc('buy', 0.9), ms(50000), 105, 0.6, 9, 11, undefined, undefined, 1.0)!;
    expect(a.matrix.moderate.flat.conviction).toBe(0.9); // unchanged, no cap logic needed
  });

  it('embeds market data + consensus snapshot in the row', () => {
    const a = buildAssetAnalysis('xyz:SILVER', psc('buy', 0.75), ms(58.5, 0.005, 'low_volatility'), 107, 0.62, 8, 10)!;
    expect(a.marketData.price).toBe(58.5);
    expect(a.marketData.regime).toBe('low_volatility');
    expect(a.consensus.action).toBe('buy');
    expect(a.consensus.confidence).toBeCloseTo(0.75);
    expect(a.consensus.pwin).toBeCloseTo(0.62);
    expect(a.consensus.agentsAligned).toBe(8);
    expect(a.consensus.agentsTotal).toBe(10);
  });

  it('returns a neutral all-hold matrix when no consensus (psc undefined)', () => {
    const a = buildAssetAnalysis('btc', undefined, ms(50000), 108, 0.5, 0, 0)!;
    expect(a.consensus.action).toBe('hold');
    expect(a.consensus.confidence).toBe(0);
    for (const state of ['long', 'short', 'flat'] as const) {
      expect(a.matrix.moderate[state].action).toBe('hold');
    }
  });

  it('all 3 cells exist (moderate only) and have valid action enums (v2.0.857)', () => {
    const a = buildAssetAnalysis('btc', psc('buy', 0.8), ms(50000), 109, 0.6, 9, 11)!;
    const validActions = new Set(['buy', 'sell', 'hold', 'close', 'flip']);
    for (const state of ['long', 'short', 'flat'] as const) {
      const cell = a.matrix.moderate[state];
      expect(validActions.has(cell.action)).toBe(true);
      expect(cell.conviction).toBeGreaterThanOrEqual(0);
      expect(cell.conviction).toBeLessThanOrEqual(1);
      expect(typeof cell.rationale).toBe('string');
    }
    // v2.0.857: only the moderate profile exists
    expect(Object.keys(a.matrix).sort()).toEqual(['moderate']);
  });

  it('ODP-6 fix: action=close + closePosition=false → long/short → close (not hold)', () => {
    // Bug: previously, action='close' without closePosition=true returned
    // 'hold' for long/short — but 'close' is an explicit close signal.
    const a = buildAssetAnalysis('btc', psc('close', 0.5), ms(50000), 200, 0.5, 6, 11)!;
    expect(a.matrix.moderate.long.action).toBe('close');
    expect(a.matrix.moderate.short.action).toBe('close');
    expect(a.matrix.moderate.flat.action).toBe('hold'); // flat + close → hold
  });

  it('ODP-6 fix: NaN/negative confidence clamped to 0, >1 clamped to 1', () => {
    const a1 = buildAssetAnalysis('btc', psc('buy', NaN), ms(50000), 201, 0.5, 9, 11)!;
    expect(a1.matrix.moderate.flat.conviction).toBe(0);
    const a2 = buildAssetAnalysis('btc', psc('buy', -0.5), ms(50000), 202, 0.5, 9, 11)!;
    expect(a2.matrix.moderate.flat.conviction).toBe(0);
    const a3 = buildAssetAnalysis('btc', psc('buy', 1.5), ms(50000), 203, 0.5, 9, 11)!;
    expect(a3.matrix.moderate.flat.conviction).toBe(1);
  });
});
