// 模擬測試:Shadow trade 升級方案設計驗證(先測試——唔直接改)
import { describe, it, expect } from 'vitest';

// 模擬升級後嘅 recentResults 結構(加 exitReason + pnlPct)
interface ShadowResult {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'win' | 'loss';
  holdCycles: number;
  cycle: number;
  mfePct?: number;
  maePct?: number;
  shadowType?: 'blind' | 'aligned' | 'statistical' | 'qrl';
  exitReason?: 'sl_tp' | 'force_resolve' | 'evicted';
  pnlPct?: number;
}

// 模擬 getRecentPerformance(設計)
function getRecentPerformance(results: ShadowResult[], n = 100) {
  const recent = results.slice(-n);
  const wins = recent.filter(r => r.outcome === 'win').length;
  const totalPnl = recent.reduce((a, r) => a + (r.pnlPct ?? 0), 0);
  const bySide: Record<string, { n: number; winRate: number; avgPnlPct: number }> = { buy: { n: 0, winRate: 0, avgPnlPct: 0 }, sell: { n: 0, winRate: 0, avgPnlPct: 0 } };
  const byExitReason: Record<string, { n: number; winRate: number; avgPnlPct: number }> = {};
  for (const side of ['buy', 'sell'] as const) {
    const arr = recent.filter(r => r.side === side);
    if (arr.length > 0) {
      const sideWins = arr.filter(r => r.outcome === 'win').length;
      bySide[side] = { n: arr.length, winRate: sideWins / arr.length, avgPnlPct: arr.reduce((a, r) => a + (r.pnlPct ?? 0), 0) / arr.length };
    }
  }
  for (const r of recent) {
    const reason = r.exitReason ?? 'unknown';
    byExitReason[reason] ??= { n: 0, winRate: 0, avgPnlPct: 0 };
    byExitReason[reason]!.n++;
    byExitReason[reason]!.avgPnlPct += (r.pnlPct ?? 0);
  }
  for (const k of Object.keys(byExitReason)) {
    byExitReason[k]!.avgPnlPct /= byExitReason[k]!.n;
    byExitReason[k]!.winRate = recent.filter(r => (r.exitReason ?? 'unknown') === k && r.outcome === 'win').length / byExitReason[k]!.n;
  }
  return { n: recent.length, winRate: wins / recent.length, totalPnlPct: totalPnl, avgPnlPct: totalPnl / recent.length, bySide, byExitReason };
}

describe('Shadow 升級方案模擬(先測試——定立修正方案)', () => {
  it('S1: 100 個 shadow trade——getRecentPerformance 統計正確', () => {
    const results: ShadowResult[] = [];
    for (let i = 0; i < 100; i++) {
      const side = i % 2 === 0 ? 'buy' : 'sell';
      const win = i % 3 === 0;
      results.push({
        id: `s${i}`, symbol: 'GOLD', side, outcome: win ? 'win' : 'loss',
        holdCycles: 5, cycle: i, mfePct: win ? 2 : 0.5, maePct: win ? -0.5 : -2,
        shadowType: 'aligned', exitReason: win ? 'sl_tp' : 'force_resolve',
        pnlPct: win ? 2 : -1.5,
      });
    }
    const perf = getRecentPerformance(results, 100);
    expect(perf.n).toBe(100);
    expect(perf.winRate).toBeCloseTo(1 / 3, 1);
    expect(perf.bySide.buy.n).toBe(50);
    expect(perf.bySide.sell.n).toBe(50);
    expect(perf.byExitReason['sl_tp']!.n).toBe(34);  // 100/3 ≈ 33-34 win
    expect(perf.byExitReason['force_resolve']!.n).toBeGreaterThan(0);
  });

  it('S2: buy/sell 分別——學「邊個 side 有 edge」', () => {
    const results: ShadowResult[] = [];
    // buy 全部 win——sell 全部 loss
    for (let i = 0; i < 50; i++) {
      results.push({ id: `b${i}`, symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: i, exitReason: 'sl_tp', pnlPct: 2 });
      results.push({ id: `s${i}`, symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: i, exitReason: 'force_resolve', pnlPct: -1.5 });
    }
    const perf = getRecentPerformance(results, 100);
    expect(perf.bySide.buy.winRate).toBe(1);
    expect(perf.bySide.sell.winRate).toBe(0);
    expect(perf.bySide.buy.avgPnlPct).toBe(2);
    expect(perf.bySide.sell.avgPnlPct).toBe(-1.5);
    // 學到「GOLD buy 有 edge——sell 冇」——real 執行時 buy 優先
  });

  it('S3: 離場原因分別——學「邊個離場原因有 edge」', () => {
    const results: ShadowResult[] = [];
    // sl_tp 全部 win——force_resolve 全部 loss
    for (let i = 0; i < 50; i++) {
      results.push({ id: `a${i}`, symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: i, exitReason: 'sl_tp', pnlPct: 2 });
      results.push({ id: `f${i}`, symbol: 'GOLD', side: 'buy', outcome: 'loss', holdCycles: 12, cycle: i, exitReason: 'force_resolve', pnlPct: -1.5 });
    }
    const perf = getRecentPerformance(results, 100);
    expect(perf.byExitReason['sl_tp']!.winRate).toBe(1);
    expect(perf.byExitReason['force_resolve']!.winRate).toBe(0);
    // 學到「sl_tp 有 edge——force_resolve 冇」——real 執行時避免 force_resolve 情況
  });

  it('S4: cap 100——超過 100 個只計最近 100', () => {
    const results: ShadowResult[] = [];
    for (let i = 0; i < 150; i++) {
      results.push({ id: `s${i}`, symbol: 'GOLD', side: 'buy', outcome: i < 50 ? 'win' : 'loss', holdCycles: 5, cycle: i, exitReason: 'sl_tp', pnlPct: i < 50 ? 2 : -1.5 });
    }
    const perf = getRecentPerformance(results, 100);
    expect(perf.n).toBe(100);
    // 最近 100 個(50-149)——全部 loss——winRate 0
    expect(perf.winRate).toBe(0);
  });

  it('S5: 攻擊——空結果/異常數據——唔 crash', () => {
    expect(() => getRecentPerformance([], 100)).not.toThrow();
    const perf = getRecentPerformance([], 100);
    expect(perf.n).toBe(0);
    // 異常數據
    const bad = [
      { id: 'x', symbol: 'GOLD', side: 'buy', outcome: 'win', holdCycles: 5, cycle: 1, exitReason: 'sl_tp', pnlPct: NaN },
      { id: 'y', symbol: 'GOLD', side: 'sell', outcome: 'loss', holdCycles: 5, cycle: 2, exitReason: 'force_resolve', pnlPct: Infinity },
    ] as ShadowResult[];
    expect(() => getRecentPerformance(bad, 100)).not.toThrow();
  });
});
