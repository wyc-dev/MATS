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

describe('v2.0.869 MAE 模式超刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-ultra-')); });

  // ── 持久化污染:null 樣本 ──
  it('U1: profile 內 null 樣本——getMaePattern 唔 crash', () => {
    const p = path.join(tmpDir, 'eq.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [null, null, { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() }],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
  });

  it('U2: recentPnl 內 null 樣本——getLosingMultiplier 唔 crash', () => {
    const p = path.join(tmpDir, 'pa.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      holdTime: {}, bias: {},
      recentPnl: {
        'skhx|sell': [null, null, { pnl: -0.1, ts: Date.now() }],
      },
      fees: { totalFees: 0, trades: 0 },
    }), 'utf-8');
    const pa = new ProfitabilityAnalyzer(p);
    pa.load();
    expect(() => pa.getLosingMultiplier('skhx', 'sell')).not.toThrow();
  });

  // ── 持久化污染:樣本缺字段 ──
  it('U3: profile 內樣本缺字段(冇 maePct/mfePct/closedAt)——唔 crash', () => {
    const p = path.join(tmpDir, 'eq2.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [{}, { pnlPct: 1 }, { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() }],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
  });

  it('U4: recentPnl 內樣本缺字段(冇 pnl/ts)——唔 crash', () => {
    const p = path.join(tmpDir, 'pa2.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      holdTime: {}, bias: {},
      recentPnl: {
        'skhx|sell': [{}, { pnl: -0.1 }, { ts: Date.now() }],
      },
      fees: { totalFees: 0, trades: 0 },
    }), 'utf-8');
    const pa = new ProfitabilityAnalyzer(p);
    pa.load();
    expect(() => pa.getLosingMultiplier('skhx', 'sell')).not.toThrow();
  });

  // ── 狀態注入:極端值 ──
  it('U5: getMaePattern windowDays 極端值(NaN/Infinity/0/負值)——唔 crash', () => {
    const eq = new EntryQuality(path.join(tmpDir, 'eq3.json'));
    const now = Date.now();
    eq.record('skhx', 'sell', -5, 1, 1, now);
    eq.record('skhx', 'sell', -5, 1, 1, now - 1000);
    eq.record('skhx', 'sell', -5, 1, 1, now - 2000);
    expect(() => eq.getMaePattern('skhx', 'sell', NaN)).not.toThrow();
    expect(() => eq.getMaePattern('skhx', 'sell', Infinity)).not.toThrow();
    expect(() => eq.getMaePattern('skhx', 'sell', 0)).not.toThrow();
    expect(() => eq.getMaePattern('skhx', 'sell', -1)).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
  });

  it('U6: maePct 正數(數據錯——load 污染)——唔 crash + 唔誤判', () => {
    const p = path.join(tmpDir, 'eq4.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: 5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },  // 正 MAE(錯)——skip
          { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
          { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
          { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    expect(Number.isFinite(pat!.ratio)).toBe(true);
  });

  // ── 併發:record + 查詢交錯 ──
  it('U7: 併發 record + getMaePattern 交錯(1000 call)——唔 crash + 樣本完整', () => {
    const eq = new EntryQuality(path.join(tmpDir, 'eq5.json'));
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      eq.record('skhx', 'sell', -0.1 - (i % 10) * 0.01, 0.1, i % 2 === 0 ? 0.5 : -0.2, now - i * 1000);
      if (i % 100 === 0) {
        expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
      }
    }
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
  });

  it('U8: 併發 recordTrade + getLosingMultiplier 交錯(1000 call)——唔 crash', () => {
    const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa3.json'));
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      pa.recordTrade('skhx', 'sell', 20, i % 2 === 0 ? 0.5 : -0.2, 0, now - i * 1000);
      if (i % 100 === 0) {
        expect(() => pa.getLosingMultiplier('skhx', 'sell')).not.toThrow();
      }
    }
    expect(Number.isFinite(pa.getLosingMultiplier('skhx', 'sell'))).toBe(true);
  });

  // ── 持久化污染:嵌套結構 ──
  it('U9: profile 內樣本係 array/object(嵌套)——唔 crash', () => {
    const p = path.join(tmpDir, 'eq6.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          [1, 2, 3],
          { nested: { maePct: -5 } },
          { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
  });

  it('U10: recentPnl 內樣本係 array/object(嵌套)——唔 crash', () => {
    const p = path.join(tmpDir, 'pa4.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      holdTime: {}, bias: {},
      recentPnl: {
        'skhx|sell': [
          [1, 2, 3],
          { nested: { pnl: -0.1 } },
          { pnl: -0.1, ts: Date.now() },
        ],
      },
      fees: { totalFees: 0, trades: 0 },
    }), 'utf-8');
    const pa = new ProfitabilityAnalyzer(p);
    pa.load();
    expect(() => pa.getLosingMultiplier('skhx', 'sell')).not.toThrow();
  });
});

describe('v2.0.869 誤判防禦(數據完整性——量化金融分析師)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-fix-')); });

  it('V1: maePct 正數(數據錯)——skip——唔誤判差入場', () => {
    const p = path.join(tmpDir, 'eq.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: 5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },   // 正 MAE(錯)——skip
          { maePct: -0.1, mfePct: 1, pnlPct: 1, closedAt: Date.now() }, // 好入場
          { maePct: -0.1, mfePct: 1, pnlPct: 1, closedAt: Date.now() }, // 好入場
          { maePct: -0.1, mfePct: 1, pnlPct: 1, closedAt: Date.now() }, // 好入場
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    // 正 MAE skip 後——3 個好入場——pattern = good(唔係 bad)
    expect(pat!.pattern).toBe('good');
    expect(eq.getMaePatternMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('V2: mfePct 負數(數據錯)——當 0——唔誤判', () => {
    const p = path.join(tmpDir, 'eq2.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: -0.1, mfePct: -1, pnlPct: 1, closedAt: Date.now() }, // 負 MFE(錯)——當 0
          { maePct: -0.1, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
          { maePct: -0.1, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    expect(Number.isFinite(pat!.ratio)).toBe(true);
  });

  it('V3: pnl NaN——當 0(中性)——唔誤判', () => {
    const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa.json'));
    const now = Date.now();
    pa.recordTrade('skhx', 'sell', 20, NaN, 0, now - 1000);
    pa.recordTrade('skhx', 'sell', 20, 0.5, 0, now - 2000);
    pa.recordTrade('skhx', 'sell', 20, 0.3, 0, now - 3000);
    // NaN 當 0(中性)——2 個賺 + 1 個中性——加權蝕錢率 < 0.6 → 1.0
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('V4: 全部 maePct 正數(數據錯)——skip 後樣本太少 → null(中性)', () => {
    const p = path.join(tmpDir, 'eq3.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: 5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
          { maePct: 6, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
          { maePct: 7, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    // 全部 skip——樣本太少 → null(中性——唔干擾)
    expect(eq.getMaePattern('skhx', 'sell')).toBeNull();
    expect(eq.getMaePatternMultiplier('skhx', 'sell')).toBe(1.0);
  });
});
