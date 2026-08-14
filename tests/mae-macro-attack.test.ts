import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../src/evolution/persistence.ts', () => ({
  loadPortfolio: () => null,
  savePortfolio: () => {},
  saveEvolutionState: () => {},
  loadEvolutionState: () => null,
}));

import { EntryQuality } from '../src/analysis/entry-quality.ts';
import { ProfitabilityAnalyzer } from '../src/analysis/profitability-analyzer.ts';
import { CloseDecisionCalibrator } from '../src/analysis/close-decision-calibrator.ts';

describe('v2.0.869 Part 3/4/5/6 刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-attack-')); });

  // ── Part 5:entry-quality getMaePattern/getMaePatternMultiplier ──
  describe('Part 5:entry-quality MAE 模式', () => {
    it('A1: 持久化污染——profile 非陣列/null/物件——load 唔 crash', () => {
      const p = path.join(tmpDir, 'eq.json');
      fs.writeFileSync(p, JSON.stringify({
        version: 1, savedAt: 0, backfillDone: false,
        profile: {
          'skhx|sell': null,
          'btc|buy': 'evil',
          'silver|buy': { not: 'array' },
          'gold|sell': [null, undefined, { maePct: NaN }, { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() }],
        },
      }), 'utf-8');
      const eq = new EntryQuality(p);
      eq.load();
      expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
      expect(() => eq.getMaePattern('btc', 'buy')).not.toThrow();
      expect(() => eq.getMaePattern('silver', 'buy')).not.toThrow();
      expect(() => eq.getMaePattern('gold', 'sell')).not.toThrow();
      expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
    });

    it('A2: 樣本 maePct/mfePct 極端值(NaN/Infinity/1e308)——唔 crash + 唔誤判', () => {
      const eq = new EntryQuality(path.join(tmpDir, 'eq2.json'));
      const now = Date.now();
      eq.record('skhx', 'sell', NaN, 0.1, -0.2, now);
      eq.record('skhx', 'sell', -Infinity, 0.1, -0.2, now);
      eq.record('skhx', 'sell', -1e308, 1e308, -0.2, now);
      eq.record('skhx', 'sell', -0.5, 0.1, -0.2, now);
      const pat = eq.getMaePattern('skhx', 'sell');
      expect(pat).not.toBeNull();
      expect(Number.isFinite(pat!.ratio)).toBe(true);
      expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
    });

    it('A3: 併發 record(多個 call 交錯)——唔 crash + 樣本完整', () => {
      const eq = new EntryQuality(path.join(tmpDir, 'eq3.json'));
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        eq.record('skhx', 'sell', -0.1 - i * 0.01, 0.1, i % 2 === 0 ? 0.5 : -0.2, now - i * 1000);
      }
      const pat = eq.getMaePattern('skhx', 'sell');
      expect(pat).not.toBeNull();
      expect(pat!.n).toBeGreaterThanOrEqual(3);
    });

    it('A4: closedAt 極端值(0/負值/1e308)——rolling window 唔 crash', () => {
      const eq = new EntryQuality(path.join(tmpDir, 'eq4.json'));
      eq.record('skhx', 'sell', -0.5, 0.1, -0.2, 0);
      eq.record('skhx', 'sell', -0.5, 0.1, -0.2, -1000);
      eq.record('skhx', 'sell', -0.5, 0.1, -0.2, 1e308);
      expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
      expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
    });
  });

  // ── Part 4:profitability-analyzer getLosingMultiplier ──
  describe('Part 4:profitability-analyzer 宏觀 gate', () => {
    it('B1: 持久化污染——recentPnl 非陣列/null/物件——load 唔 crash', () => {
      const p = path.join(tmpDir, 'pa.json');
      fs.writeFileSync(p, JSON.stringify({
        version: 1, savedAt: 0, backfillDone: false,
        holdTime: {}, bias: {},
        recentPnl: {
          'skhx|sell': null,
          'btc|buy': 'evil',
          'silver|buy': { not: 'array' },
          'gold|sell': [{ pnl: NaN, ts: Date.now() }, null, { pnl: -0.1, ts: NaN }, { pnl: -0.2, ts: Infinity }],
        },
        fees: { totalFees: 0, trades: 0 },
      }), 'utf-8');
      const pa = new ProfitabilityAnalyzer(p);
      pa.load();
      expect(() => pa.getLosingMultiplier('skhx', 'sell')).not.toThrow();
      expect(() => pa.getLosingMultiplier('btc', 'buy')).not.toThrow();
      expect(() => pa.getLosingMultiplier('silver', 'buy')).not.toThrow();
      expect(() => pa.getLosingMultiplier('gold', 'sell')).not.toThrow();
    });

    it('B2: pnl/ts 極端值(NaN/Infinity/1e308)——唔 crash + 唔誤判', () => {
      const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa2.json'));
      const now = Date.now();
      pa.recordTrade('skhx', 'sell', 20, NaN, 0, now);
      pa.recordTrade('skhx', 'sell', 20, Infinity, 0, now);
      pa.recordTrade('skhx', 'sell', 20, -1e308, 0, now);
      pa.recordTrade('skhx', 'sell', 20, -0.1, 0, now);
      const mult = pa.getLosingMultiplier('skhx', 'sell');
      expect(Number.isFinite(mult)).toBe(true);
      expect(mult).toBeGreaterThanOrEqual(0.45);
    });

    it('B3: 併發 recordTrade(多個 call)——唔 crash + 樣本完整', () => {
      const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa3.json'));
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        pa.recordTrade('skhx', 'sell', 20, i % 2 === 0 ? 0.5 : -0.2, 0, now - i * 1000);
      }
      const mult = pa.getLosingMultiplier('skhx', 'sell');
      expect(Number.isFinite(mult)).toBe(true);
    });

    it('B4: ts 極端值(0/負值/1e308)——時間加權唔 crash', () => {
      const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa4.json'));
      pa.recordTrade('skhx', 'sell', 20, -0.1, 0, 0);
      pa.recordTrade('skhx', 'sell', 20, -0.2, 0, -1000);
      pa.recordTrade('skhx', 'sell', 20, -0.3, 0, 1e308);
      const mult = pa.getLosingMultiplier('skhx', 'sell');
      expect(Number.isFinite(mult)).toBe(true);
    });
  });

  // ── Part 3:close-calibrator getMfeLockAdvice ──
  describe('Part 3:close-calibrator MFE 鎖利', () => {
    it('C1: mfePct/atrPct 極端值(1e308/1e-308/負零)——唔 crash', () => {
      const cc = new CloseDecisionCalibrator(path.join(tmpDir, 'cc.json'));
      expect(() => cc.getMfeLockAdvice('skhx', 'sell', 1e308, 1e308, 0.5)).not.toThrow();
      expect(() => cc.getMfeLockAdvice('skhx', 'sell', 1e-308, 1e-308, 0.5)).not.toThrow();
      expect(() => cc.getMfeLockAdvice('skhx', 'sell', -0, 0.01, 0.5)).not.toThrow();
      expect(() => cc.getMfeLockAdvice('skhx', 'sell', 0.02, 1e-308, 0.5)).not.toThrow();
      const r = cc.getMfeLockAdvice('skhx', 'sell', 1e308, 1e308, 0.5);
      expect(r.shouldLock).toBe(false); // 1e308 >= 2×1e308 = false
    });

    it('C2: retracedPct 極端值(1e308/-1e308)——clamp 唔 crash', () => {
      const cc = new CloseDecisionCalibrator(path.join(tmpDir, 'cc2.json'));
      expect(() => cc.getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, 1e308)).not.toThrow();
      expect(() => cc.getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, -1e308)).not.toThrow();
      const r = cc.getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, 1e308);
      expect(r.shouldLock).toBe(true); // clamp 到 1——鎖利
    });
  });
});

describe('v2.0.869 Part 3/4/5/6 進階攻擊(__proto__/constructor 污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-attack2-')); });

  it('D1: __proto__ key——getMaePattern 唔 crash(prototype 污染防禦)', () => {
    const p = path.join(tmpDir, 'eq.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        '__proto__': [{ maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() }],
        'constructor': [{ maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() }],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    expect(() => eq.getMaePattern('__proto__', 'buy')).not.toThrow();
    expect(() => eq.getMaePattern('constructor', 'buy')).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('__proto__', 'buy')).not.toThrow();
    // prototype 唔應該被污染
    expect(({} as Record<string, unknown>)['maePct']).toBeUndefined();
  });

  it('D2: __proto__ key——getLosingMultiplier 唔 crash', () => {
    const p = path.join(tmpDir, 'pa.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      holdTime: {}, bias: {},
      recentPnl: {
        '__proto__': [{ pnl: -0.1, ts: Date.now() }],
        'constructor': [{ pnl: -0.2, ts: Date.now() }],
      },
      fees: { totalFees: 0, trades: 0 },
    }), 'utf-8');
    const pa = new ProfitabilityAnalyzer(p);
    pa.load();
    expect(() => pa.getLosingMultiplier('__proto__', 'buy')).not.toThrow();
    expect(() => pa.getLosingMultiplier('constructor', 'buy')).not.toThrow();
    expect(({} as Record<string, unknown>)['pnl']).toBeUndefined();
  });

  it('D3: record() 用 __proto__ symbol——唔污染 prototype', () => {
    const eq = new EntryQuality(path.join(tmpDir, 'eq2.json'));
    eq.record('__proto__', 'buy', -5, 1, 1, Date.now());
    eq.record('constructor', 'buy', -5, 1, 1, Date.now());
    expect(({} as Record<string, unknown>)['maePct']).toBeUndefined();
    expect(() => eq.getMaePattern('__proto__', 'buy')).not.toThrow();
  });

  it('D4: recordTrade 用 __proto__ symbol——唔污染 prototype', () => {
    const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa2.json'));
    pa.recordTrade('__proto__', 'sell', 20, -0.1, 0, Date.now());
    pa.recordTrade('constructor', 'sell', 20, -0.2, 0, Date.now());
    expect(({} as Record<string, unknown>)['pnl']).toBeUndefined();
    expect(() => pa.getLosingMultiplier('__proto__', 'sell')).not.toThrow();
  });

  it('D5: getMfeLockAdvice __proto__ symbol——唔 crash', () => {
    const cc = new CloseDecisionCalibrator(path.join(tmpDir, 'cc.json'));
    expect(() => cc.getMfeLockAdvice('__proto__', 'sell', 0.02, 0.01, 0.5)).not.toThrow();
    expect(() => cc.getMfeLockAdvice('constructor', 'sell', 0.02, 0.01, 0.5)).not.toThrow();
  });
});
