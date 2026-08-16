import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VolatilityThresholdJudge } from '../src/analysis/volatility-threshold-judge.ts';

describe('v2.0.869-P5 按 symbol 匹配刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-sym-')); });

  it('M1: LLM 輸出順序唔同(亂序)——按 symbol 匹配——每個 asset 攞到正確 threshold', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    // LLM 輸出亂序(gold 喺前——btc 喺後)
    const content = JSON.stringify([
      { symbol: 'GOLD', assetType: 'precious_metal', volLow: 0.0001, volHigh: 0.001, trendThreshold: 0.5, confidence: 0.7 },
      { symbol: 'BTC', assetType: 'crypto', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8 },
    ]);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [
      { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
      { symbol: 'xyz:GOLD', assetType: 'precious_metal', histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 }, currentState: { regime: 'x', trend: 'y', volatility: 0.00034 } },
    ];
    const results = await judge.judgeBatch(assets);
    // 按 symbol 匹配(唔按位置)
    const btc = results.find(r => r && r.symbol === 'BTC');
    const gold = results.find(r => r && r.symbol === 'xyz:GOLD');
    expect(btc).not.toBeNull();
    expect(btc!.volLow).toBe(0.0002);  // BTC 攞到 BTC 嘅 threshold(唔係 GOLD 嘅)
    expect(gold).not.toBeNull();
    expect(gold!.volLow).toBe(0.0001);  // GOLD 攞到 GOLD 嘅 threshold
  });

  it('M2: 多個 asset 同 symbol(重複)——唔 crash + 唔重複 set', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj2.json'));
    const content = JSON.stringify([
      { symbol: 'BTC', assetType: 'crypto', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8 },
    ]);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [
      { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
      { symbol: 'btc', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
    ];
    const results = await judge.judgeBatch(assets);
    expect(results.length).toBe(2);
    // 兩個都攞到(或者 fallback)——唔 crash
  });

  it('M3: t.symbol 異常(undefined/null/控制字符)——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj3.json'));
    const cases = [
      JSON.stringify([{ volLow: 0.0001, volHigh: 0.001, trendThreshold: 0.5, confidence: 0.7 }]),
      JSON.stringify([{ symbol: null, volLow: 0.0001, volHigh: 0.001, trendThreshold: 0.5, confidence: 0.7 }]),
      JSON.stringify([{ symbol: 'BTC\nEVIL', volLow: 0.0001, volHigh: 0.001, trendThreshold: 0.5, confidence: 0.7 }]),
    ];
    for (const content of cases) {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
      (globalThis as any).fetch = mockFetch;
      const results = await judge.judgeBatch([
        { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
      ]);
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('M4: 併發——多個 cycle 同時 judgeBatch(50 call)——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj4.json'));
    const content = JSON.stringify([
      { symbol: 'BTC', assetType: 'crypto', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8 },
    ]);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [{ symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } }];
    const results = await Promise.all(Array.from({ length: 50 }, () => judge.judgeBatch(assets)));
    expect(results.length).toBe(50);
  });

  it('M5: 持久化污染——異常 symbol 寫入 state——save/load 後唔 crash', async () => {
    const p = path.join(tmpDir, 'vtj5.json');
    const judge = new VolatilityThresholdJudge(p);
    const content = JSON.stringify([
      { symbol: 'BTC\nEVIL', assetType: 'crypto', volLow: 0.0001, volHigh: 0.001, trendThreshold: 0.5, confidence: 0.7 },
    ]);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    await judge.judgeBatch([
      { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
    ]);
    judge.save();
    const judge2 = new VolatilityThresholdJudge(p);
    judge2.load();
    expect(judge2.getThreshold('BTC')).not.toBeNull();
  });

  it('M6: 前綴唔敏感匹配(xyz:GOLD vs GOLD)——唔 crash + 正確匹配', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj6.json'));
    const content = JSON.stringify([
      { symbol: 'GOLD', assetType: 'precious_metal', volLow: 0.0001, volHigh: 0.001, trendThreshold: 0.5, confidence: 0.7 },
    ]);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([
      { symbol: 'xyz:GOLD', assetType: 'precious_metal', histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 }, currentState: { regime: 'x', trend: 'y', volatility: 0.00034 } },
    ]);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.volLow).toBe(0.0001);
  });
});
