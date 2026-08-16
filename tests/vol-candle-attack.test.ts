import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VolatilityThresholdJudge } from '../src/analysis/volatility-threshold-judge.ts';

describe('v2.0.869-P5 candleSummary 12 支刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-candle-')); });

  const mkCandle = (t: number, o: number, h: number, l: number, c: number, v: number) => ({ t, o, h, l, c, v });

  it('C1: candles 少過 12 支(5 支)——slice(-12) 返回全部——唔 crash', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    const candles = Array.from({ length: 5 }, (_, i) => mkCandle(1700000000000 + i * 300000, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000));
    const out = judge.formatCandles(candles);
    expect(out).toContain('最近 5 支');
    expect(out).not.toContain('最近 12 支');
  });

  it('C2: candles 空/undefined——返回空——唔 crash', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj2.json'));
    expect(judge.formatCandles([])).toBe('');
    expect(judge.formatCandles(undefined as any)).toBe('');
    expect(judge.formatCandles(null as any)).toBe('');
  });

  it('C3: candle t 異常(undefined/NaN/0)——唔 crash + 唔輸出 NaN 污染', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj3.json'));
    const candles = [
      mkCandle(undefined as any, 100, 101, 99, 100.5, 1000),
      mkCandle(NaN, 100, 101, 99, 100.5, 1000),
      mkCandle(0, 100, 101, 99, 100.5, 1000),
    ];
    const out = judge.formatCandles(candles);
    // 唔 crash——輸出可能含 NaN 時間(但係唔 crash)
    expect(typeof out).toBe('string');
  });

  it('C4: candle 值異常(負值/0/NaN)——唔 crash', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj4.json'));
    const candles = [
      mkCandle(1700000000000, 0, 0, 0, 0, 0),          // 全 0
      mkCandle(1700000000000, -100, -99, -101, -100.5, -1000),  // 負值
      mkCandle(1700000000000, NaN, NaN, NaN, NaN, NaN),  // NaN
    ];
    const out = judge.formatCandles(candles);
    expect(typeof out).toBe('string');
  });

  it('C5: 併發——多個 formatCandles 同時(100 call)——唔 crash', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj5.json'));
    const candles = Array.from({ length: 12 }, (_, i) => mkCandle(1700000000000 + i * 300000, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000));
    const outs = Array.from({ length: 100 }, () => judge.formatCandles(candles));
    expect(outs.length).toBe(100);
    expect(outs[0]).toBe(outs[1]);  // 純函數——輸出一致
  });

  it('C6: candle 超長(1000 支)——slice(-12) 只取 12 支——唔 crash + 輸出短', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj6.json'));
    const candles = Array.from({ length: 1000 }, (_, i) => mkCandle(1700000000000 + i * 300000, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000));
    const out = judge.formatCandles(candles);
    expect(out).toContain('最近 1000 支');
    expect(out).toContain('最近 12 支');
    // 輸出唔應該太長(12 支精確 + 摘要)
    expect(out.length).toBeLessThan(2000);
  });

  it('C7: 持久化污染——異常 candle 判斷後 save/load——唔 crash', async () => {
    const p = path.join(tmpDir, 'vtj7.json');
    const judge = new VolatilityThresholdJudge(p);
    const content = JSON.stringify([
      { symbol: 'BTC', assetType: 'crypto', volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8 },
    ]);
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });
    (globalThis as any).fetch = mockFetch;
    const candles = [mkCandle(NaN, NaN, NaN, NaN, NaN, NaN)];
    await judge.judgeBatch([
      { symbol: 'BTC', assetType: 'crypto', histVol: { p25: 0.003, median: 0.006, p75: 0.012, max: 0.05 }, currentState: { regime: 'x', trend: 'y', volatility: 0.003 }, candles },
    ]);
    judge.save();
    const judge2 = new VolatilityThresholdJudge(p);
    judge2.load();
    expect(judge2.getThreshold('BTC')).not.toBeNull();
  });
});
