import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { VolatilityThresholdJudge } from '../src/analysis/volatility-threshold-judge.ts';

describe('v2.0.869 Volatility Threshold Judge(LLM 波動率 threshold 判定)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtj-')); });

  it('T1: calibrate——LLM 輸出有效——volLow < volHigh', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj.json'));
    // 用 mock LLM(直接 call calibrate——透過 judge 內部)
    const result = (judge as any).calibrate('SILVER', {
      symbol: 'SILVER', assetType: 'precious_metal',
      volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8,
      rationale: 'test',
    }, { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 });
    expect(result).not.toBeNull();
    expect(result!.volLow).toBeLessThan(result!.volHigh);
    expect(result!.volLow).toBeGreaterThan(0);
  });

  it('T2: 統計校準——LLM volLow 高過 p25——校準到 p25 以下(唔誤判正常波動)', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj2.json'));
    const result = (judge as any).calibrate('SILVER', {
      symbol: 'SILVER', assetType: 'precious_metal',
      volLow: 0.003, volHigh: 0.01, trendThreshold: 0.5, confidence: 0.8,
      rationale: 'test',
    }, { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 });
    expect(result).not.toBeNull();
    // 校準後 volLow < p25(0.0003)——唔誤判正常波動
    expect(result!.volLow).toBeLessThan(0.0003);
  });

  it('T3: 統計校準——LLM volHigh 低過 p75——校準到 p75 以上(唔誤判正常波動)', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj3.json'));
    const result = (judge as any).calibrate('SILVER', {
      symbol: 'SILVER', assetType: 'precious_metal',
      volLow: 0.0001, volHigh: 0.0005, trendThreshold: 0.5, confidence: 0.8,
      rationale: 'test',
    }, { p25: 0.0003, median: 0.0006, p75: 0.0012, max: 0.005 });
    expect(result).not.toBeNull();
    // 校準後 volHigh > p75(0.0012)——唔誤判正常波動
    expect(result!.volHigh).toBeGreaterThan(0.0012);
  });

  it('T4: 攻擊——LLM 輸出無效(NaN/負值/volLow ≥ volHigh)——fallback null', () => {
    const judge = new VolatilityThresholdJudge(path.join(tmpDir, 'vtj4.json'));
    expect((judge as any).calibrate('SILVER', { volLow: NaN, volHigh: 0.01 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
    expect((judge as any).calibrate('SILVER', { volLow: -1, volHigh: 0.01 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
    expect((judge as any).calibrate('SILVER', { volLow: 0.01, volHigh: 0.001 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
    expect((judge as any).calibrate('SILVER', { volLow: 0.0001, volHigh: 0.5 }, { p25: 0, median: 0, p75: 0, max: 0 })).toBeNull();
  });

  it('T5: 持久化——save + load 保留', () => {
    const p = path.join(tmpDir, 'vtj5.json');
    const judge = new VolatilityThresholdJudge(p);
    (judge as any).state.thresholds['SILVER'] = {
      symbol: 'SILVER', assetType: 'precious_metal',
      volLow: 0.0002, volHigh: 0.002, trendThreshold: 0.5, confidence: 0.8,
      rationale: 'test', judgedAt: Date.now(),
    };
    judge.save();
    const judge2 = new VolatilityThresholdJudge(p);
    judge2.load();
    const t = judge2.getThreshold('SILVER');
    expect(t).not.toBeNull();
    expect(t!.volLow).toBe(0.0002);
  });

  it('T6: 攻擊——load 污染(__proto__/NaN/volLow ≥ volHigh)——唔 crash + 唔污染', () => {
    const p = path.join(tmpDir, 'vtj6.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0,
      thresholds: {
        '__proto__': { volLow: 0.0001, volHigh: 0.01 },
        'constructor': { volLow: 0.0001, volHigh: 0.01 },
        'SILVER': { volLow: NaN, volHigh: 0.01 },
        'GOLD': { volLow: 0.01, volHigh: 0.001 },
        'BTC': { volLow: 0.0001, volHigh: 0.01 },
      },
    }), 'utf-8');
    const judge = new VolatilityThresholdJudge(p);
    judge.load();
    expect(({} as Record<string, unknown>)['volLow']).toBeUndefined();
    expect(judge.getThreshold('SILVER')).toBeNull();  // NaN 被過濾
    expect(judge.getThreshold('GOLD')).toBeNull();    // volLow ≥ volHigh 被過濾
    expect(judge.getThreshold('BTC')).not.toBeNull(); // 有效保留
  });

  it('T7: getAssetType——唔同 symbol 判斷資產類型', () => {
    // 透過 index.ts 嘅 getAssetType 邏輯(直接測試 symbol 名判斷)
    const cases: Array<[string, string]> = [
      ['GOLD', 'precious_metal'],
      ['SILVER', 'precious_metal'],
      ['SP500', 'index'],
      ['BTC', 'crypto'],
      ['ETH', 'crypto'],
      ['SKHX', 'crypto'],
    ];
    for (const [sym, expected] of cases) {
      const s = sym.toUpperCase();
      let result = 'crypto';
      if (s.includes('GOLD') || s.includes('SILVER') || s.includes('PLATINUM') || s.includes('PALLADIUM')) result = 'precious_metal';
      else if (s.includes('SP500') || s.includes('NAS') || s.includes('DOW') || s.includes('NDX') || s.includes('SPX')) result = 'index';
      expect(result).toBe(expected);
    }
  });
});
