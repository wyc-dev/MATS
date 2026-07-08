import { describe, it, expect } from 'vitest';
import { normalizeDecision } from '../src/trading/decision-utils.ts';
import type { TradingDecision } from '../src/types/index.ts';

// v2.0.136 regression tests: the "BTC SELL shown on dashboard but never
// executes" bug had three compounding root causes, all fixed in v2.0.136:
//
//   1. normalizeDecision() silently dropped `entryThesis` -> the Phase 4.8
//      thesis gate in hacp.ts saw decision.entryThesis === undefined, fell
//      back to a perSymbolConsensus lookup that also failed (symbol mismatch),
//      and overrode every BUY/SELL -> HOLD.
//
//   2. buildConsensus() hardcoded `symbol: 'BTCUSDT'` -> the thesis gate's
//      perSymbolConsensus fallback lookup (decision.symbol 'btcusdt' vs
//      psc.symbol 'btc') never matched, so even the fallback thesis was
//      unreachable. (Covered indirectly by the symbol-preservation tests
//      below; the hacp.ts fix is exercised in integration.)
//
//   3. index.ts main consensus execution path did not set `entryPrice` ->
//      realTradingManager.executeDecision() received price=0 and silently
//      returned "No price available for real trade" -> execution:FAILED
//      even after every gate (thesis, conviction, direction, frequency)
//      passed. (Code-level fix in index.ts; verified by tsc + the
//      execution path now forwarding combinedState.price.)

describe('normalizeDecision (v2.0.136 thesis-preservation fix)', () => {
  it('preserves entryThesis when provided (Bug #1 root cause)', () => {
    const thesis = '[1h: OLR SELL edge +23pp with 71% P(win)] [1d: Iran ceasefire collapse drives risk-off]';
    const decision = normalizeDecision({
      action: 'sell',
      symbol: 'btc',
      positionSizePct: 0.05,
      leverage: 3,
      rationale: 'Meta-Agent SELL',
      urgency: 'soon',
      entryThesis: thesis,
    });
    expect(decision.action).toBe('sell');
    expect(decision.entryThesis).toBe(thesis);
  });

  it('omits entryThesis when not provided (no spurious undefined)', () => {
    const decision = normalizeDecision({
      action: 'hold',
      symbol: 'btc',
      positionSizePct: 0,
      leverage: 1,
      rationale: 'no edge',
      urgency: 'patient',
    });
    expect(decision.entryThesis).toBeUndefined();
  });

  it('drops empty/whitespace entryThesis (treats as absent)', () => {
    const decision = normalizeDecision({
      action: 'buy',
      symbol: 'btc',
      positionSizePct: 0.1,
      leverage: 2,
      rationale: 'x',
      urgency: 'soon',
      entryThesis: '   ',
    });
    expect(decision.entryThesis).toBeUndefined();
  });

  it('preserves srSupport / srResistance (TradingDecision fields previously lost)', () => {
    const decision = normalizeDecision({
      action: 'buy',
      symbol: 'btc',
      positionSizePct: 0.1,
      leverage: 2,
      rationale: 'x',
      urgency: 'soon',
      srSupport: 60000,
      srResistance: 62000,
    });
    expect(decision.srSupport).toBe(60000);
    expect(decision.srResistance).toBe(62000);
  });

  it('does not regress: clamps size, normalizes symbol, defaults urgency', () => {
    const decision = normalizeDecision({
      action: 'buy',
      symbol: 'BTC',
      positionSizePct: 5, // > 1.0 sanity clamp
      leverage: 99, // > 10 clamp
      rationale: '',
    });
    expect(decision.positionSizePct).toBe(1.0);
    expect(decision.leverage).toBe(10);
    expect(decision.symbol).toBe('btc');
    expect(decision.urgency).toBe('patient');
    expect(decision.rationale).toBe('No rationale provided.');
  });

  it('colon-prefixed symbols preserve case (xyz:MU stays xyz:MU)', () => {
    const decision = normalizeDecision({
      action: 'sell',
      symbol: 'xyz:SILVER',
      positionSizePct: 0.05,
      leverage: 3,
      rationale: 'x',
      urgency: 'soon',
    });
    expect(decision.symbol).toBe('xyz:SILVER');
  });
});

describe('TradingDecision type surface', () => {
  it('entryThesis is an optional field on TradingDecision', () => {
    const d: TradingDecision = {
      action: 'sell',
      symbol: 'btc',
      positionSizePct: 0.05,
      leverage: 3,
      rationale: 'x',
      urgency: 'soon',
      entryThesis: '[1h: y] [1d: z]',
    };
    expect(d.entryThesis).toBe('[1h: y] [1d: z]');
  });
});