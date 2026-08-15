import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VolatilityThresholdJudge } from '../src/analysis/volatility-threshold-judge.ts';

describe('v2.0.869-P4 每個 Cycle fetch 刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-cycle-')); });

  it('C1: 每個 Cycle 判斷——多個 Cycle 同時 judgeBatch(10 cycle)——唔 crash + 樣本完整', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    const content = '{"thresholds": [{"symbol": "BTC", "assetType": "crypto", "volLow": 0.0001, "volHigh": 0.0015, "trendThreshold": 0.5, "confidence": 0.7}]}';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [{ symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } }];
    // 模擬 10 個 Cycle 連續判斷
    for (let i = 0; i < 10; i++) {
      const results = await judge.judgeBatch(assets);
      expect(results[0]).not.toBeNull();
    }
    expect(judge.getThreshold('BTC')).not.toBeNull();
  });

  it('C2: judgeSyms 異常(tradingMarkets 含控制字符/空/重複)——唔 crash', () => {
    // 模擬 judgeSyms 構建(同 index.ts 邏輯)
    const judgeSyms = new Set<string>();
    const tradingMarkets = ['btc', 'xyz:GOLD', '', 'BTC\nEVIL', 'xyz:GOLD', '  ', 'xyz:SILVER'];
    for (const sym of tradingMarkets) {
      if (sym && String(sym).trim()) judgeSyms.add(String(sym).trim());
    }
    expect(judgeSyms.size).toBe(4);  // btc/xyz:GOLD/BTC\nEVIL/xyz:SILVER(空/空格/重複 skip)
    expect(judgeSyms.has('')).toBe(false);
  });

  it('C3: 每個 Cycle fetch——LLM 慢(timeout)——fallback 默認(唔 crash + 唔阻塞)', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj3.json'));
    // mock fetch——永遠 timeout(abort)
    const mockFetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    (globalThis as any).fetch = mockFetch;
    const assets = [{ symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } }];
    const results = await judge.judgeBatch(assets);
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]).toBeNull();  // timeout fallback
  });

  it('C4: 併發——多個 Cycle 同時 judgeBatch + getThreshold(100 call)——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj4.json'));
    const content = '{"thresholds": [{"symbol": "BTC", "assetType": "crypto", "volLow": 0.0001, "volHigh": 0.0015, "trendThreshold": 0.5, "confidence": 0.7}]}';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [{ symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } }];
    const results = await Promise.all(Array.from({ length: 100 }, () => judge.judgeBatch(assets)));
    expect(results.length).toBe(100);
    expect(judge.getThreshold('BTC')).not.toBeNull();
  });

  it('C5: 每個 Cycle fetch——threshold 覆蓋(新判斷覆蓋舊)——唔 crash', async () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj5.json'));
    // 第一次判斷(volLow 0.0001)
    const content1 = '{"thresholds": [{"symbol": "BTC", "assetType": "crypto", "volLow": 0.0001, "volHigh": 0.0015, "trendThreshold": 0.5, "confidence": 0.7}]}';
    const mockFetch1 = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: content1 } }) });
    (globalThis as any).fetch = mockFetch1;
    const assets = [{ symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } }];
    await judge.judgeBatch(assets);
    expect(judge.getThreshold('BTC')!.volLow).toBe(0.0001);
    // 第二次判斷(volLow 0.0002——覆蓋)
    const content2 = '{"thresholds": [{"symbol": "BTC", "assetType": "crypto", "volLow": 0.0002, "volHigh": 0.002, "trendThreshold": 0.5, "confidence": 0.8}]}';
    const mockFetch2 = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: content2 } }) });
    (globalThis as any).fetch = mockFetch2;
    await judge.judgeBatch(assets);
    expect(judge.getThreshold('BTC')!.volLow).toBe(0.0002);  // 覆蓋
  });

  it('C6: 每個 Cycle fetch——持久化(多次判斷後 save/load)——唔 crash', async () => {
    const p = path.join(tmpDir, 'vtj6.json');
    const judge = new VolatilityThresholdJudge(p);
    const content = '{"thresholds": [{"symbol": "BTC", "assetType": "crypto", "volLow": 0.0001, "volHigh": 0.0015, "trendThreshold": 0.5, "confidence": 0.7}]}';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const assets = [{ symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 } }];
    for (let i = 0; i < 5; i++) {
      await judge.judgeBatch(assets);
    }
    judge.save();
    const judge2 = new VolatilityThresholdJudge(p);
    judge2.load();
    expect(judge2.getThreshold('BTC')).not.toBeNull();
  });
});
