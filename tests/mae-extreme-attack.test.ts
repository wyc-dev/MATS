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

describe('v2.0.869 MAE 模式極端攻擊(數值極限/架構級/周邊 modules)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-extreme-')); });

  // ── 數值極限 ──
  it('E1: ratio 計算 overflow(maePct 超大 + mfePct 超細)——唔 crash + 唔誤判', () => {
    const p = path.join(tmpDir, 'eq.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: -1e308, mfePct: 1e-308, pnlPct: 1, closedAt: Date.now() },
          { maePct: -1e308, mfePct: 1e-308, pnlPct: 1, closedAt: Date.now() },
          { maePct: -1e308, mfePct: 1e-308, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    // ratio 可能 Infinity——但係 pattern 判斷唔 crash
    expect(pat!.pattern).toBe('bad');
    expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
  });

  it('E2: mfePct 超大(1e308)——ratio 超細——pattern good——唔 crash', () => {
    const p = path.join(tmpDir, 'eq2.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: -5, mfePct: 1e308, pnlPct: 1, closedAt: Date.now() },
          { maePct: -5, mfePct: 1e308, pnlPct: 1, closedAt: Date.now() },
          { maePct: -5, mfePct: 1e308, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    expect(Number.isFinite(pat!.ratio)).toBe(true);
  });

  it('E3: closedAt 未來(1e308)——rolling window 唔 crash', () => {
    const eq = new EntryQuality(path.join(tmpDir, 'eq3.json'));
    eq.record('skhx', 'sell', -5, 1, 1, 1e308);
    eq.record('skhx', 'sell', -5, 1, 1, 1e308 - 1000);
    eq.record('skhx', 'sell', -5, 1, 1, 1e308 - 2000);
    expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
  });

  it('E4: ts 未來(1e308)——時間加權唔 crash', () => {
    const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa.json'));
    pa.recordTrade('skhx', 'sell', 20, -0.1, 0, 1e308);
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, 1e308 - 1000);
    pa.recordTrade('skhx', 'sell', 20, -0.3, 0, 1e308 - 2000);
    const mult = pa.getLosingMultiplier('skhx', 'sell');
    expect(Number.isFinite(mult)).toBe(true);
  });

  // ── 周邊 modules ──
  it('E5: getReopenMultiplier——recentCloses 污染(price 異常)——唔 crash', () => {
    const p = path.join(tmpDir, 'eq4.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {},
      recentCloses: {
        'skhx|sell': { price: -1, ts: Date.now() },   // 負 price(錯)
        'btc|buy': { price: 1e308, ts: Date.now() },  // 超大 price(錯)
        'silver|buy': { price: NaN, ts: Date.now() }, // NaN price(錯)
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    expect(() => eq.getReopenMultiplier('skhx|sell', 100)).not.toThrow();
    expect(() => eq.getReopenMultiplier('btc|buy', 100)).not.toThrow();
    expect(() => eq.getReopenMultiplier('silver|buy', 100)).not.toThrow();
  });

  it('E6: getProfile——profile 污染(maePct 正數/NaN)——唔 crash', () => {
    const p = path.join(tmpDir, 'eq5.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        'skhx|sell': [
          { maePct: 5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },   // 正 MAE(錯)
          { maePct: NaN, mfePct: 1, pnlPct: 1, closedAt: Date.now() }, // NaN
          { maePct: -5, mfePct: 1, pnlPct: 1, closedAt: Date.now() },
        ],
      },
    }), 'utf-8');
    const eq = new EntryQuality(p);
    eq.load();
    expect(() => eq.getProfile('skhx', 'sell')).not.toThrow();
    expect(() => eq.getAdvice('skhx', 'sell')).not.toThrow();
  });

  // ── 架構級:gate 應用邊界 ──
  it('E7: getMaePatternMultiplier——side 非規範值(hold/undefined)——唔 crash', () => {
    const eq = new EntryQuality(path.join(tmpDir, 'eq6.json'));
    eq.record('skhx', 'sell', -5, 1, 1, Date.now());
    eq.record('skhx', 'sell', -5, 1, 1, Date.now() - 1000);
    eq.record('skhx', 'sell', -5, 1, 1, Date.now() - 2000);
    expect(() => eq.getMaePatternMultiplier('skhx', 'hold' as 'buy')).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('skhx', undefined as unknown as 'buy')).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('', 'buy')).not.toThrow();
  });

  it('E8: getLosingMultiplier——side 非規範值(hold/undefined)——唔 crash', () => {
    const pa = new ProfitabilityAnalyzer(path.join(tmpDir, 'pa2.json'));
    pa.recordTrade('skhx', 'sell', 20, -0.1, 0, Date.now());
    pa.recordTrade('skhx', 'sell', 20, -0.2, 0, Date.now() - 1000);
    pa.recordTrade('skhx', 'sell', 20, -0.3, 0, Date.now() - 2000);
    expect(() => pa.getLosingMultiplier('skhx', 'hold' as 'buy')).not.toThrow();
    expect(() => pa.getLosingMultiplier('skhx', undefined as unknown as 'buy')).not.toThrow();
  });

  it('E9: getMfeLockAdvice——mfePct/atrPct 極端組合(1e308/1e-308)——唔 crash', () => {
    const cc = new CloseDecisionCalibrator(path.join(tmpDir, 'cc.json'));
    expect(() => cc.getMfeLockAdvice('skhx', 'sell', 1e308, 1e-308, 0.5)).not.toThrow();
    expect(() => cc.getMfeLockAdvice('skhx', 'sell', 1e-308, 1e308, 0.5)).not.toThrow();
    expect(() => cc.getMfeLockAdvice('skhx', 'sell', 1e308, 1e308, 1e308)).not.toThrow();
    const r = cc.getMfeLockAdvice('skhx', 'sell', 1e308, 1e-308, 0.5);
    expect(r.shouldLock).toBe(true); // 1e308 >= 2×1e-308 且回吐 50%
  });

  it('E10: 併發——record + getProfile + getMaePattern + getReopenMultiplier 全交錯(500 call)——唔 crash', () => {
    const eq = new EntryQuality(path.join(tmpDir, 'eq7.json'));
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      eq.record('skhx', 'sell', -0.1 - (i % 5) * 0.01, 0.1, i % 2 === 0 ? 0.5 : -0.2, now - i * 1000);
      if (i % 50 === 0) {
        expect(() => eq.getMaePattern('skhx', 'sell')).not.toThrow();
        expect(() => eq.getProfile('skhx', 'sell')).not.toThrow();
        expect(() => eq.getReopenMultiplier('skhx', 100)).not.toThrow();
        expect(() => eq.getMaePatternMultiplier('skhx', 'sell')).not.toThrow();
      }
    }
  });
});
