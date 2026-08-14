// v2.0.868: Profitability Analyzer — 功能 + 攻擊測試
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProfitabilityAnalyzer } from '../src/analysis/profitability-analyzer.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Profitability Analyzer (v2.0.868)', () => {
  let tmpDir: string;
  let pa: ProfitabilityAnalyzer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-'));
    pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa.json'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── 功能 ──
  it('hold-time bucket 正確(<15m/15m-1h/1-4h/>4h)——每 bucket 10 樣本', () => {
    for (let i = 0; i < 10; i++) pa.recordTrade('btc', 'buy', 10, 0.01);     // <15m
    for (let i = 0; i < 10; i++) pa.recordTrade('btc', 'buy', 30, 0.02);     // 15m-1h
    for (let i = 0; i < 10; i++) pa.recordTrade('btc', 'buy', 120, 0.03);    // 1-4h
    for (let i = 0; i < 10; i++) pa.recordTrade('btc', 'buy', 300, 0.04);    // >4h
    const evs = pa.getHoldTimeEV('btc', 'buy');
    expect(evs.length).toBe(4);
    expect(evs.map(e => e.bucket)).toEqual(['>4h', '1-4h', '15m-1h', '<15m']); // EV 排序
  });

  it('hold-time EV:最佳區間 = 最高 EV(量化判斷層核心)', () => {
    for (let i = 0; i < 30; i++) pa.recordTrade('gold', 'buy', 30, 0.005);   // 15m-1h 正
    for (let i = 0; i < 30; i++) pa.recordTrade('gold', 'buy', 5, -0.005);   // <15m 負
    const evs = pa.getHoldTimeEV('gold', 'buy');
    expect(evs[0]!.bucket).toBe('15m-1h'); // 最佳 = 正 EV 區間
    expect(evs[0]!.ev).toBeGreaterThan(0);
  });

  it('direction bias:極端負 EV 標記(實証:MU|buy -51.7%)', () => {
    for (let i = 0; i < 30; i++) pa.recordTrade('mu', 'buy', 30, -0.017);
    const bias = pa.getDirectionBias('mu', 'buy');
    expect(bias).not.toBeNull();
    expect(bias!.biasPct).toBeLessThan(0); // 負 EV——做 buy 不利
    const advice = pa.getContextAdvice('mu', 'buy');
    expect(advice).toContain('極端偏差');
  });

  it('冷啟動:少樣本唔出 advice(唔干擾早期)', () => {
    pa.recordTrade('btc', 'buy', 30, 0.01);
    expect(pa.getContextAdvice('btc', 'buy')).toBe('');
    expect(pa.getDirectionBias('btc', 'buy')).toBeNull();
  });

  it('fee impact 報告', () => {
    pa.recordTrade('btc', 'buy', 30, 0.01, 0.05);
    pa.recordTrade('btc', 'buy', 30, -0.01, 0.03);
    const fee = pa.getFeeImpact();
    expect(fee.totalFees).toBeCloseTo(0.08);
    expect(fee.trades).toBe(2);
    expect(fee.avgFeePerTrade).toBeCloseTo(0.04);
  });

  it('persist:flushSave + load 保留', () => {
    for (let i = 0; i < 30; i++) pa.recordTrade('silver', 'sell', 30, 0.01);
    pa.flushSave();
    const pa2 = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa.json'));
    pa2.load();
    const bias = pa2.getDirectionBias('silver', 'sell');
    expect(bias).not.toBeNull();
    expect(bias!.n).toBe(30);
  });

  // ── 攻擊 ──
  it('K1: NaN/undefined/巨型值——唔 crash + 唔污染', () => {
    pa.recordTrade('btc', 'buy', NaN, NaN);
    pa.recordTrade('', 'buy', 30, 0.01);                    // 空 symbol skip
    pa.recordTrade('btc', 'side' as 'buy', 30, 0.01);       // 非法 side skip
    pa.recordTrade('btc', 'buy', -5, -1e308);               // 負 hold/巨型 pnl
    pa.recordTrade('btc', 'buy', 1e15, 1e308);              // 超巨型
    expect(() => pa.getContextAdvice('btc', 'buy')).not.toThrow();
    expect(() => pa.getHoldTimeEV('btc', 'buy')).not.toThrow();
  });

  it('K2: 10k flood——memory cap 500 per cell + 唔慢', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10_000; i++) {
      pa.recordTrade(`s${i % 30}`, i % 2 === 0 ? 'buy' : 'sell', i % 100, (i % 100) / 10000);
    }
    expect(Date.now() - t0).toBeLessThan(3000);
    pa.flushSave();
    expect(() => pa.load()).not.toThrow();
  });

  it('K3: __proto__/constructor 污染 load——唔污染', () => {
    const evil = JSON.parse('{"__proto__": {"polluted": 1}, "holdTime": {"__proto__": {"x": [1]}}, "bias": {}, "fees": {}, "backfillDone": false}');
    fs.writeFileSync(path.join(tmpDir, 'pa.json'), JSON.stringify(evil), 'utf-8');
    pa.load();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(() => pa.getContextAdvice('btc', 'buy')).not.toThrow();
  });

  it('K4: load 毒數據(NaN string/負數/缺字段)——sanitize', () => {
    fs.writeFileSync(path.join(tmpDir, 'pa.json'), JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      holdTime: { 'btc|buy': { '<15m': [0.01, 'NaN', 1e308, -0.5] } },
      bias: { 'btc|buy': ['garbage', 0.02, null] },
      fees: { totalFees: -5, trades: '10' },
    }), 'utf-8');
    pa.load();
    const evs = pa.getHoldTimeEV('btc', 'buy');
    for (const e of evs) {
      expect(Number.isFinite(e.ev)).toBe(true);
      expect(Number.isFinite(e.median)).toBe(true);
    }
    const bias = pa.getDirectionBias('btc', 'buy');
    if (bias) expect(Number.isFinite(bias.biasPct)).toBe(true);
  });

  it('K5: save 目錄唔存在——唔 crash', () => {
    const bad = new ProfitabilityAnalyzer(path.join(tmpDir, 'no-dir', 'pa.json'));
    expect(() => bad.recordTrade('btc', 'buy', 30, 0.01)).not.toThrow();
    expect(() => bad.flushSave()).not.toThrow();
  });
});

describe('v2.0.869 時間加權蝕錢率(主神 SKHX MAE=0 調查)', () => {
  let pa: ProfitabilityAnalyzer;
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-macro-'));
    pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa.json'));
  });

  it('G1: 冇數據 → 1.0(唔干擾)', () => {
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('G2: 樣本太少(<3)→ 1.0', () => {
    pa.recordTrade('skhx', 'sell', 20, -0.1, 0, Date.now());
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, Date.now());
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('G3: 最近全部蝕(weight 高)→ ×0.45', () => {
    const now = Date.now();
    pa.recordTrade('skhx', 'sell', 20, -0.1, 0, now - 1000);
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, now - 2000);
    pa.recordTrade('skhx', 'sell', 20, -0.3, 0, now - 3000);
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(0.45);
  });

  it('G4: 賺錢主導(2 賺 1 蝕)→ 唔抑制', () => {
    const now = Date.now();
    pa.recordTrade('skhx', 'sell', 20, 0.5, 0, now - 1000);
    pa.recordTrade('skhx', 'sell', 20, 0.3, 0, now - 2000);
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, now - 3000);
    // 加權蝕錢率 = 1/3 ≈ 0.33 < 0.6 → 1.0
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('G5: 時間衰減——舊蝕錢(6h 前)權重低——唔誤傷', () => {
    const now = Date.now();
    const TAU = 6 * 3600 * 1000;
    pa.recordTrade('skhx', 'sell', 20, -0.1, 0, now - TAU * 3); // 18h 前——weight ≈ 0.05
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, now - TAU * 2); // 12h 前——weight ≈ 0.14
    pa.recordTrade('skhx', 'sell', 20, 0.5, 0, now - 1000);     // 最近賺——weight ≈ 1
    // 加權蝕錢率 = (0.05+0.14) / (0.05+0.14+1) ≈ 0.16 < 0.6 → 1.0
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('G6: side 分開——sell 蝕唔影響 buy', () => {
    const now = Date.now();
    pa.recordTrade('skhx', 'sell', 20, -0.1, 0, now - 1000);
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, now - 2000);
    pa.recordTrade('skhx', 'sell', 20, -0.3, 0, now - 3000);
    expect(pa.getLosingMultiplier('skhx', 'buy')).toBe(1.0);
    expect(pa.getLosingMultiplier('skhx', 'sell')).toBe(0.45);
  });

  it('G7: 攻擊——NaN/Infinity/非規範 side——唔 crash', () => {
    pa.recordTrade('skhx', 'sell', 20, NaN, 0, Date.now());
    pa.recordTrade('skhx', 'sell', 20, Infinity, 0, Date.now());
    pa.recordTrade('skhx', 'sell', 20, -0.3, 0, Date.now());
    expect(() => pa.getLosingMultiplier('skhx', 'x' as 'buy')).not.toThrow();
    expect(() => pa.getLosingMultiplier('', 'buy')).not.toThrow();
    expect(Number.isFinite(pa.getLosingMultiplier('skhx', 'sell'))).toBe(true);
  });
});
