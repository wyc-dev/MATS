import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VolatilityThresholdJudge } from '../src/analysis/volatility-threshold-judge.ts';

describe('v2.0.869-P4 vol-judge JSON 提取刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-json-')); });

  it('J1: LLM 輸出「{...} 額外文字 }」——穩健提取成功(唔再 JSON.parse 失敗)', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    const content = '{"thresholds": [{"symbol": "SILVER", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8}]} 額外文字 } 再額外';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.volLow).toBe(0.0002);
  });

  it('J2: LLM 輸出冇「{」——fallback 默認(唔 crash)', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj2.json'));
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: 'SILVER 嘅 threshold 好簡單' } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]).toBeNull();
  });

  it('J3: LLM 輸出「{」喺字串內(誤導)——唔 crash + 唔誤 parse', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj3.json'));
    const content = 'SILVER { 嘅 threshold 係 0.0002 同 0.002——好簡單 } 完';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(Array.isArray(results)).toBe(true);
  });

  it('J4: LLM 輸出超長(10000 chars)——穩健提取唔 crash + 效能可接受', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj4.json'));
    const content = 'x'.repeat(5000) + '{"thresholds": [{"symbol": "SILVER", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8}]}' + 'y'.repeat(5000);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const start = Date.now();
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);  // 效能可接受
    expect(results[0]).not.toBeNull();
  });

  it('J5: LLM 輸出多個「{...}」——穩健提取第一個成功嘅', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj5.json'));
    const content = '{"not": "valid"} {"thresholds": [{"symbol": "SILVER", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8}]}';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }]);
    expect(results[0]).not.toBeNull();
  });

  it('J6: 併發——多個 judgeBatch 同時(10 call)——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj6.json'));
    const content = '{"thresholds": [{"symbol": "SILVER", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8}]}';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [{
      symbol: 'SILVER', assetType: 'precious_metal',
      histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 },
      currentState: { regime: 'low_volatility', trend: 'sideways', volatility: 0.00034 },
    }];
    const results = await Promise.all(Array.from({ length: 10 }, () => judge.judgeBatch(assets)));
    expect(results.length).toBe(10);
    expect(judge.getThreshold('SILVER')).not.toBeNull();
  });
});

describe('v2.0.869-P4 LLM 輸出直接 array(主神 batch JSON 解析失敗)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-arr-')); });

  it('K1: LLM 輸出直接 array(唔係 {"thresholds": [...]})——解析成功', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    const content = '[\n  {"symbol": "BTC", "assetType": "crypto", "volLow": 0.0001, "volHigh": 0.0015, "trendThreshold": 0.5, "confidence": 0.7, "rationale": "test"},\n  {"symbol": "GOLD", "assetType": "precious_metal", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8, "rationale": "test"}\n]';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([
      { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
      { symbol: 'GOLD', assetType: 'precious_metal', histVol: { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 }, currentState: { regime: 'x', trend: 'y', volatility: 0.00034 } },
    ]);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.volLow).toBe(0.0001);
    expect(results[1]).not.toBeNull();
    expect(results[1]!.volLow).toBe(0.0002);
  });

  it('K2: LLM 輸出 array 但 symbol 唔 match——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj2.json'));
    const content = '[{"symbol": "ETH", "assetType": "crypto", "volLow": 0.0001, "volHigh": 0.0015, "trendThreshold": 0.5, "confidence": 0.7}]';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const results = await judge.judgeBatch([
      { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } },
    ]);
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]).toBeNull();  // ETH 唔 match BTC——null
  });
});
