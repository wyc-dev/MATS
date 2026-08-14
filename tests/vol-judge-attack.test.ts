import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { VolatilityThresholdJudge } from '../src/analysis/volatility-threshold-judge.ts';

describe('v2.0.869 Volatility Threshold Judge 刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-attack-')); });

  // ── LLM 輸出解析攻擊 ──
  it('A1: LLM 輸出 thresholds 唔係 array(物件/string/null)——judgeBatch 唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    // mock fetch——LLM 返回 thresholds 係物件
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: JSON.stringify({ thresholds: { SILVER: { volLow: 0.0002 } } }) } }) });
    (judge as any).baseUrl = 'http://mock';
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(Array.isArray(results)).toBe(true);
  });

  it('A2: LLM 輸出 thresholds 內 t 係 null/string——judgeBatch 唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj2.json'));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: JSON.stringify({ thresholds: [null, 'evil', { symbol: 'SILVER', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8 }] }) } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]).not.toBeNull();
  });

  it('A3: LLM 輸出唔係 JSON(純文字/亂碼)——judgeBatch 唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj3.json'));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: 'SILVER 嘅 threshold 係 0.0002 同 0.002——好簡單' } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(Array.isArray(results)).toBe(true);
  });

  it('A4: LLM 輸出 JSON 包喺 ```json ... ``` 內——judgeBatch 解析成功', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj4.json'));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: '```json\n{"thresholds": [{"symbol": "SILVER", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8, "rationale": "test"} ]}\n```' } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.volLow).toBe(0.0002);
  });

  // ── 併發攻擊 ──
  it('A5: 併發 judgeBatch(多個 call 同時)——唔 crash + 樣本完整', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj5.json'));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: JSON.stringify({ thresholds: [{ symbol: 'SILVER', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8 }] }) } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }];
    const results = await Promise.all([
      judge.judgeBatch(assets),
      judge.judgeBatch(assets),
      judge.judgeBatch(assets),
    ]);
    expect(results.length).toBe(3);
    expect(judge.getThreshold('SILVER')).not.toBeNull();
  });

  // ── 持久化污染 ──
  it('A6: load 污染——thresholds 內 judgedAt NaN/Infinity/負值——唔 crash', () => {
    const p = path.join(tmpDir, 'vtj6.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0,
      thresholds: {
        'SILVER': { symbol: 'SILVER', assetType: 'precious_metal', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8, rationale: 'test', judgedAt: NaN },
        'GOLD': { symbol: 'GOLD', assetType: 'precious_metal', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8, rationale: 'test', judgedAt: Infinity },
        'BTC': { symbol: 'BTC', assetType: 'crypto', volLow: 0.003, volHigh: 0.03, trendThreshold: 0.5, confidence: 0.8, rationale: 'test', judgedAt: -1000 },
      },
    }), 'utf-8');
    const judge = new VolatilityThresholdJudge(p);
    judge.load();
    expect(judge.getThreshold('SILVER')).not.toBeNull();
    expect(judge.getThreshold('GOLD')).not.toBeNull();
    expect(judge.getThreshold('BTC')).not.toBeNull();
  });

  it('A7: formatCandles 攻擊——candle 內 t/o/h/l/c/v 極端值(NaN/Infinity/負值/0)——唔 crash', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj7.json'));
    const candles = [
      { t: NaN, o: NaN, h: NaN, l: NaN, c: NaN, v: NaN },
      { t: Infinity, o: Infinity, h: Infinity, l: Infinity, c: Infinity, v: Infinity },
      { t: -1, o: -1, h: -1, l: -1, c: -1, v: -1 },
      { t: 0, o: 0, h: 0, l: 0, c: 0, v: 0 },
      { t: Date.now(), o: 100, h: 100, l: 100, c: 100, v: 100 },
    ];
    expect(() => judge.formatCandles(candles)).not.toThrow();
  });

  it('A8: calibrate 攻擊——LLM 輸出 volLow/volHigh 極端組合(1e308/1e-308/負零)——唔 crash', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj8.json'));
    expect((judge as any).calibrate('SILVER', { volLow: 1e308, volHigh: 1e308 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
    expect((judge as any).calibrate('SILVER', { volLow: 1e-308, volHigh: 1e-308 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
    expect((judge as any).calibrate('SILVER', { volLow: -0, volHigh: 0.01 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
    expect((judge as any).calibrate('SILVER', { volLow: 0.0001, volHigh: 0.01, trendThreshold: 'abc' }, { p25: 0, median: 0, p75: 0, max: 0 })).not.toBeNull();
  });

  it('A9: judgeBatch 空 assets——返回空 array(唔 crash)', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj9.json'));
    const results = await judge.judgeBatch([]);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it('A10: judgeBatch assets 內 symbol 異常(空/控制字符/__proto__)——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj10.json'));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: JSON.stringify({ thresholds: [] }) } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([
      { symbol: '', assetType: 'crypto', histVol: { p25: 0, median: 0, p75: 0, max: 0 }, currentState: { regime: 'x', trend: 'y', volatility: 0 } },
      { symbol: '__proto__', assetType: 'crypto', histVol: { p25: 0, median: 0, p75: 0, max: 0 }, currentState: { regime: 'x', trend: 'y', volatility: 0 } },
      { symbol: 'SILVER\nEVIL', assetType: 'crypto', histVol: { p25: 0, median: 0, p75: 0, max: 0 }, currentState: { regime: 'x', trend: 'y', volatility: 0 } },
    ]);
    expect(Array.isArray(results)).toBe(true);
    expect(({} as Record<string, unknown>)['volLow']).toBeUndefined();
  });
});
