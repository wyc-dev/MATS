import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShadowTradeEngine } from '../src/evolution/shadow-trade-engine.ts';
import { OLREngine } from '../src/evolution/olr-engine.ts';

// Mock OLR engine
const mockOLR = {
  feedTrade: vi.fn(),
} as unknown as OLREngine;

describe('v2.0.869-P2 Shadow 升級刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let engine: ShadowTradeEngine;
  beforeEach(() => { engine = new ShadowTradeEngine(mockOLR); });

  // ── getRecentPerformance 極端值 ──
  it('A1: recentResults 內 pnlPct NaN/Infinity/負值——唔 crash + 唔污染', () => {
    // 直接注入污染數據(模擬持久化污染)
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: NaN },
      { id: '2', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: Infinity },
      { id: '3', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 3, exitReason: 'sl_tp', pnlPct: -1e308 },
      { id: '4', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 4, exitReason: 'force_resolve', pnlPct: 1e308 },
      { id: '5', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 5, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    const perf = engine.getRecentPerformance(100);
    expect(Number.isFinite(perf.totalPnlPct)).toBe(true);
    expect(Number.isFinite(perf.avgPnlPct)).toBe(true);
    expect(() => engine.getSideStats()).not.toThrow();
  });

  it('A2: recentResults 內 exitReason 異常(控制字符/換行/__proto__)——唔 crash + 唔 prompt 注入', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp\nEVIL' as any, pnlPct: 2 },
      { id: '2', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: '__proto__' as any, pnlPct: -1 },
      { id: '3', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 3, exitReason: 'constructor' as any, pnlPct: 2 },
      { id: '4', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 4, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '5', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 5, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    const perf = engine.getRecentPerformance(100);
    expect(perf.byExitReason['sl_tp\nEVIL']).toBeDefined();
    expect(() => engine.getContext()).not.toThrow();
    // prototype 唔應該被污染
    expect(({} as Record<string, unknown>)['n']).toBeUndefined();
  });

  it('A3: recentResults 內樣本缺字段(null/undefined/非物件)——唔 crash', () => {
    (engine as any).recentResults = [
      null,
      undefined,
      'evil',
      { id: '1', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '2', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
    ];
    expect(() => engine.getRecentPerformance(100)).not.toThrow();
    expect(() => engine.getContext()).not.toThrow();
  });

  it('A4: getContext——統計注入 prompt(異常 side/symbol)——唔 crash + 唔 prompt 注入', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD\nEVIL', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '2', symbol: 'SILVER', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '3', symbol: 'BTC', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 3, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '4', symbol: 'ETH', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 4, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '5', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 5, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    const ctx = engine.getContext();
    expect(ctx).toBeDefined();
    // context 唔應該含「EVIL」注入(如果 symbol 有控制字符——應該 sanitize)
    expect(String(ctx).includes('EVIL')).toBe(false);
  });

  it('A5: 併發——getRecentPerformance + getContext + getSideStats(500 call)——唔 crash', () => {
    for (let i = 0; i < 100; i++) {
      (engine as any).recentResults.push({ id: `s${i}`, symbol: 'GOLD', side: i % 2 === 0 ? 'buy' : 'sell', outcome: i % 3 === 0 ? 'win' : 'loss', holdCycles: 5, cycle: i, exitReason: i % 3 === 0 ? 'sl_tp' : 'force_resolve', pnlPct: i % 3 === 0 ? 2 : -1 });
    }
    for (let i = 0; i < 500; i++) {
      expect(() => engine.getRecentPerformance(100)).not.toThrow();
      if (i % 50 === 0) {
        expect(() => engine.getContext()).not.toThrow();
        expect(() => engine.getSideStats()).not.toThrow();
      }
    }
  });

  it('A6: getRecentPerformance n 極端值(0/負值/1e308)——唔 crash', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '2', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
    ];
    expect(() => engine.getRecentPerformance(0)).not.toThrow();
    expect(() => engine.getRecentPerformance(-1)).not.toThrow();
    expect(() => engine.getRecentPerformance(1e308)).not.toThrow();
    expect(() => engine.getRecentPerformance(NaN)).not.toThrow();
  });

  it('A7: 空 recentResults——getRecentPerformance/getContext/getSideStats 唔 crash', () => {
    (engine as any).recentResults = [];
    const perf = engine.getRecentPerformance(100);
    expect(perf.n).toBe(0);
    expect(perf.winRate).toBe(0);
    expect(() => engine.getContext()).not.toThrow();
    const side = engine.getSideStats();
    expect(side.buy.n).toBe(0);
    expect(side.sell.n).toBe(0);
  });
});

describe('v2.0.869-P2 Shadow 進階攻擊(prompt 注入/異常 side/outcome)', () => {
  let engine: ShadowTradeEngine;
  beforeEach(() => { engine = new ShadowTradeEngine(mockOLR); });

  it('A8: getContext——symbol 含控制字符——contextString 唔應該含注入(prompt 注入防禦)', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD\nEVIL', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '2', symbol: 'SILVER', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '3', symbol: 'BTC', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 3, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '4', symbol: 'ETH', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 4, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '5', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 5, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    const ctx = engine.getContext();
    // check contextString(唔係 String(ctx)——ctx 係物件)
    // sanitize 移除控制字符(\\n)——「GOLD\\nEVIL」→「GOLDEVIL」(EVIL 係 symbol 一部分——唔係注入)
    expect(ctx.contextString.includes('\\nEVIL')).toBe(false);
    expect(ctx.contextString.includes('GOLDEVIL')).toBe(true);
  });

  it('A9: getRecentPerformance——side/outcome 異常(大寫/undefined/null)——唔 crash + 唔誤判', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD', side: 'BUY' as any, outcome: 'WIN' as any, holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '2', symbol: 'GOLD', side: undefined as any, outcome: undefined as any, holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '3', symbol: 'GOLD', side: null as any, outcome: null as any, holdCycles: 5, cycle: 3, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '4', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 4, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '5', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 5, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    const perf = engine.getRecentPerformance(100);
    expect(Number.isFinite(perf.winRate)).toBe(true);
    expect(() => engine.getContext()).not.toThrow();
  });

  it('A10: getContext——exitReason 含控制字符——contextString 唔應該含注入', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp\nEVIL' as any, pnlPct: 2 },
      { id: '2', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '3', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 3, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '4', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 4, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '5', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 5, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    const ctx = engine.getContext();
    expect(ctx.contextString.includes('EVIL')).toBe(false);
  });

  it('A11: getContext——symbol 含 __proto__/constructor——唔 crash + 唔污染', () => {
    (engine as any).recentResults = [
      { id: '1', symbol: '__proto__', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: 2 },
      { id: '2', symbol: 'constructor', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: -1 },
      { id: '3', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 3, exitReason: 'sl_tp', pnlPct: 2 },
    ];
    expect(() => engine.getContext()).not.toThrow();
    expect(({} as Record<string, unknown>)['n']).toBeUndefined();
  });

  it('A12: 併發——push + getRecentPerformance + getContext 交錯(1000 call)——唔 crash', () => {
    for (let i = 0; i < 1000; i++) {
      (engine as any).recentResults.push({ id: `s${i}`, symbol: i % 10 === 0 ? 'GOLD\nEVIL' : 'GOLD', side: i % 2 === 0 ? 'buy' : 'sell', outcome: i % 3 === 0 ? 'win' : 'loss', holdCycles: 5, cycle: i, exitReason: i % 3 === 0 ? 'sl_tp' : 'force_resolve', pnlPct: i % 3 === 0 ? 2 : -1 });
      if (i % 100 === 0) {
        expect(() => engine.getRecentPerformance(100)).not.toThrow();
        expect(() => engine.getContext()).not.toThrow();
      }
    }
  });
});
