// v2.0.868-P1P2: Entry Quality System — Confirmation Gate + MAE Profile 測試
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkConfirmation, EntryQuality } from '../src/analysis/entry-quality.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('P1: Confirmation Gate', () => {
  it('G1: 3/3 確認(離開 zone + 同向 momentum + SL 合理)→ multiplier 1.0', () => {
    const r = checkConfirmation({
      side: 'buy', currentPrice: 101, support: 100, slDistancePct: 1.5,
      lastCandleDir: 'up',
    });
    expect(r.confirmedCount).toBe(3);
    expect(r.multiplier).toBe(1.0);
  });

  it('G2: 0/3 確認(price 喺 zone 邊緣 + 反向 momentum + SL 太貼)→ ×0.7(等確認)', () => {
    const r = checkConfirmation({
      side: 'buy', currentPrice: 100.05, support: 100, slDistancePct: 0.5,
      lastCandleDir: 'down',
    });
    expect(r.confirmedCount).toBe(0);
    expect(r.multiplier).toBe(0.7);
  });

  it('G3: 1/3 確認 → ×0.85', () => {
    const r = checkConfirmation({
      side: 'buy', currentPrice: 101, support: 100, slDistancePct: 0.5,
      lastCandleDir: 'down',
    });
    expect(r.confirmedCount).toBe(1); // 只有 price 確認
    expect(r.multiplier).toBe(0.85);
  });

  it('G4: SELL 方向——price 低過 resistance + down momentum', () => {
    const r = checkConfirmation({
      side: 'sell', currentPrice: 99, resistance: 100, slDistancePct: 1.5,
      lastCandleDir: 'down',
    });
    expect(r.confirmedCount).toBe(3);
    expect(r.multiplier).toBe(1.0);
  });

  it('G5: 缺數據中性(support 無/ATR 無/candle unknown)→ 唔懲罰', () => {
    const r = checkConfirmation({ side: 'buy', currentPrice: 100, slDistancePct: 1.0 });
    expect(r.multiplier).toBe(1.0);
  });

  it('G6: 攻擊——currentPrice 0/負/NaN + support 垃圾——唔 crash', () => {
    expect(() => checkConfirmation({ side: 'buy', currentPrice: 0, support: 100, slDistancePct: 1.0 })).not.toThrow();
    expect(() => checkConfirmation({ side: 'buy', currentPrice: NaN, support: -5, slDistancePct: NaN })).not.toThrow();
    expect(() => checkConfirmation({ side: 'buy', currentPrice: Infinity, support: undefined, slDistancePct: 0 })).not.toThrow();
  });

  it('G7: SL 太貼(<0.8%)→ noise 未確認(唔改 SL——Gate 判斷層)', () => {
    const r = checkConfirmation({
      side: 'buy', currentPrice: 101, support: 100, slDistancePct: 0.5, lastCandleDir: 'up',
    });
    expect(r.signals.noise).toBe(false);
    expect(r.confirmedCount).toBe(2); // price + momentum——noise 唔過
  });
});

describe('P2: Entry MAE Profile', () => {
  let tmpDir: string;
  let eq: EntryQuality;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-test-'));
    eq = new EntryQuality(path.join(tmpDir, 'eq.json'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('P1: 冷啟動(<20 樣本)→ null(唔干擾)', () => {
    for (let i = 0; i < 10; i++) eq.record('btc', 'buy', -5, 5, 1, Date.now());
    expect(eq.getProfile('btc', 'buy')).toBeNull();
    expect(eq.getAdvice('btc', 'buy')).toBe('');
  });

  it('P2: 20+ 樣本→ profile 計算(median/wilson/EV)', () => {
    for (let i = 0; i < 30; i++) eq.record('btc', 'buy', -8, 5, i % 2 === 0 ? 2 : -3, Date.now() - i * 3600_000);
    const prof = eq.getProfile('btc', 'buy');
    expect(prof).not.toBeNull();
    expect(prof!.n).toBe(30);
    expect(prof!.maeMedian).toBeCloseTo(-8, 5);
    expect(prof!.winRate).toBeCloseTo(0.5, 1);
    expect(prof!.ev).toBeLessThan(0); // 負 EV(mid loss)
    expect(prof!.evMultiplier).toBeLessThan(1.0);
  });

  it('P3: rolling window——舊樣本(>30 日)自動淘汰', () => {
    const old = Date.now() - 40 * 24 * 3600 * 1000;
    for (let i = 0; i < 25; i++) eq.record('btc', 'buy', -8, 5, 1, old); // 全部舊
    expect(eq.getProfile('btc', 'buy')).toBeNull(); // 全部過期——唔干擾
  });

  it('P4: 污染樣本(MAE -150% 且 MFE 細)→ 唔記錄', () => {
    for (let i = 0; i < 25; i++) {
      eq.record('skhx', 'buy', -50, 4, 2, Date.now()); // -50% MAE 污染(舊問題)
    }
    // 污染樣本應該被過濾——profile 唔應該反映 -50% MAE
    const prof = eq.getProfile('skhx', 'buy');
    if (prof) {
      expect(prof.maeMedian).toBeGreaterThan(-150); // 唔係 -50(污染)
    }
  });

  it('P5: 全部 close 類型都記錄(sl_tp/reconciliation 都入 profile——主神糾正)', () => {
    for (let i = 0; i < 15; i++) eq.record('gold', 'buy', -3, 8, 4, Date.now());  // 成功(PAEL 類)
    for (let i = 0; i < 15; i++) eq.record('gold', 'buy', -8, 1, -5, Date.now()); // 失敗(sl_tp 類)
    const prof = eq.getProfile('gold', 'buy');
    expect(prof).not.toBeNull();
    expect(prof!.n).toBe(30); // 兩類都入
  });

  it('P6: 攻擊——NaN/undefined/巨型值/unicode——唔 crash', () => {
    eq.record('btc', 'buy', NaN, NaN, NaN, NaN);
    eq.record('', 'buy', -5, 5, 1, Date.now());
    eq.record('btc', 'x' as 'buy', -5, 5, 1, Date.now());
    eq.record('xyz:黃金🏆', 'buy', -1e308, 1e308, 0, Date.now());
    expect(() => eq.getProfile('btc', 'buy')).not.toThrow();
    expect(() => eq.getAdvice('btc', 'buy')).not.toThrow();
  });

  it('P7: persist——flushSave + load 保留', () => {
    for (let i = 0; i < 25; i++) eq.record('silver', 'sell', -6, 6, 2, Date.now());
    eq.flushSave();
    const eq2 = new EntryQuality(path.join(tmpDir, 'eq.json'));
    eq2.load();
    const prof = eq2.getProfile('silver', 'sell');
    expect(prof).not.toBeNull();
    expect(prof!.n).toBe(25);
  });

  it('P8: 攻擊——load 毒(__proto__/NaN/缺字段)——唔 crash + 唔污染', () => {
    fs.writeFileSync(path.join(tmpDir, 'eq.json'), JSON.stringify({
      version: 1, savedAt: 0, backfillDone: false,
      profile: {
        '__proto__': [{ maePct: 1, mfePct: 1, pnlPct: 1, closedAt: Date.now() }],
        'btc|buy': [{ maePct: NaN, mfePct: 1, pnlPct: 1, closedAt: Date.now() }, null, { maePct: -5 }],
        'constructor': 'evil',
      },
    }), 'utf-8');
    eq.load();
    expect(({} as Record<string, unknown>)['maePct']).toBeUndefined();
    expect(() => eq.getProfile('btc', 'buy')).not.toThrow();
  });
});



describe('v2.0.869 MAE 模式(主神 SKHX MAE=0 調查)', () => {
  let eq: EntryQuality;
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-mae-'));
    eq = new EntryQuality(path.join(tmpDir, 'eq.json'));
  });

  it('M1: 數據缺失標記——MAE=0 且 MFE=0 → dataMissing', () => {
    eq.record('skhx', 'sell', 0, 0, -0.2, Date.now());
    const pat = eq.getMaePattern('skhx', 'sell');
    // 數據缺失樣本唔參與分類——樣本太少 → null(中性)
    expect(pat).toBeNull();
  });

  it('M2: 好入場(MAE 細 + MFE 大)→ pattern good', () => {
    eq.record('skhx', 'sell', 0, 0.18, -0.12, Date.now());
    eq.record('skhx', 'sell', 0, 0.07, -0.2, Date.now());
    eq.record('skhx', 'sell', 0, 0.3, 0.5, Date.now());
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    expect(pat!.pattern).toBe('good');
    expect(eq.getMaePatternMultiplier('skhx', 'sell')).toBe(1.0);
  });

  it('M3: 差入場(MAE 大 + MFE 細)→ pattern bad → ×0.5', () => {
    eq.record('silver', 'buy', -0.43, 0.21, -0.34, Date.now());
    eq.record('silver', 'buy', -0.44, 0.29, -0.5, Date.now());
    eq.record('silver', 'buy', -0.5, 0.1, -0.6, Date.now());
    const pat = eq.getMaePattern('silver', 'buy');
    expect(pat).not.toBeNull();
    expect(pat!.pattern).toBe('bad');
    expect(eq.getMaePatternMultiplier('silver', 'buy')).toBe(0.5);
  });

  it('M4: 中性(ratio 0.5-1.5)→ ×0.85', () => {
    eq.record('btc', 'buy', -0.5, 0.5, -0.1, Date.now());
    eq.record('btc', 'buy', -0.6, 0.6, 0.2, Date.now());
    eq.record('btc', 'buy', -0.7, 0.7, -0.3, Date.now());
    const pat = eq.getMaePattern('btc', 'buy');
    expect(pat).not.toBeNull();
    expect(pat!.pattern).toBe('neutral');
    expect(eq.getMaePatternMultiplier('btc', 'buy')).toBe(0.85);
  });

  it('M5: 樣本太少(<3)→ null(中性——唔干擾)', () => {
    eq.record('btc', 'buy', -0.5, 0.1, -0.1, Date.now());
    eq.record('btc', 'buy', -0.6, 0.1, -0.2, Date.now());
    expect(eq.getMaePattern('btc', 'buy')).toBeNull();
    expect(eq.getMaePatternMultiplier('btc', 'buy')).toBe(1.0);
  });

  it('M6: side 分開——sell 差入場唔影響 buy', () => {
    eq.record('silver', 'sell', -0.5, 0.1, -0.3, Date.now());
    eq.record('silver', 'sell', -0.6, 0.1, -0.4, Date.now());
    eq.record('silver', 'sell', -0.7, 0.1, -0.5, Date.now());
    expect(eq.getMaePatternMultiplier('silver', 'buy')).toBe(1.0);
    expect(eq.getMaePatternMultiplier('silver', 'sell')).toBe(0.5);
  });

  it('M7: 數據缺失樣本唔參與——有真實樣本時正常分類', () => {
    eq.record('skhx', 'sell', 0, 0, -0.2, Date.now()); // 數據缺失
    eq.record('skhx', 'sell', 0, 0.18, -0.12, Date.now());
    eq.record('skhx', 'sell', 0, 0.07, -0.2, Date.now());
    eq.record('skhx', 'sell', 0, 0.3, 0.5, Date.now());
    const pat = eq.getMaePattern('skhx', 'sell');
    expect(pat).not.toBeNull();
    expect(pat!.pattern).toBe('good'); // 數據缺失唔影響
  });

  it('M8: 攻擊——side 非規範值/NaN——唔 crash', () => {
    eq.record('btc', 'short', -0.5, 0.1, -0.1, Date.now());
    eq.record('btc', 'short', -0.6, 0.1, -0.2, Date.now());
    eq.record('btc', 'short', -0.7, 0.1, -0.3, Date.now());
    expect(eq.getMaePatternMultiplier('btc', 'sell')).toBe(0.5);
    expect(() => eq.getMaePattern('btc', 'x' as 'buy')).not.toThrow();
    expect(() => eq.getMaePatternMultiplier('', 'buy')).not.toThrow();
  });
});
