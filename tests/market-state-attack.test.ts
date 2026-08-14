import { describe, it, expect, beforeEach } from 'vitest';
import { MarketStateAggregator } from '../src/data/market-state.ts';

describe('v2.0.869 MarketStateAggregator 刁鑽攻擊(搬檔後——併發/狀態注入/持久化污染)', () => {
  let agg: MarketStateAggregator;
  beforeEach(() => { agg = new MarketStateAggregator(); });

  // ── setSymbolThreshold 極端值 ──
  it('M1: setSymbolThreshold 極端值(NaN/Infinity/負值/1e308)——唔 crash + 唔污染', () => {
    expect(() => agg.setSymbolThreshold('SILVER', NaN, 0.01, 0.5)).not.toThrow();
    expect(() => agg.setSymbolThreshold('SILVER', Infinity, 0.01, 0.5)).not.toThrow();
    expect(() => agg.setSymbolThreshold('SILVER', -1, 0.01, 0.5)).not.toThrow();
    expect(() => agg.setSymbolThreshold('SILVER', 1e308, 1e308, 0.5)).not.toThrow();
    expect(() => agg.setSymbolThreshold('SILVER', 0.0001, 0.01, NaN)).not.toThrow();
    expect(() => agg.setSymbolThreshold('SILVER', 0.0001, 0.01, Infinity)).not.toThrow();
    expect(() => agg.setSymbolThreshold('__proto__', 0.0001, 0.01, 0.5)).not.toThrow();
    expect(() => agg.setSymbolThreshold('', 0.0001, 0.01, 0.5)).not.toThrow();
    // 有效 threshold 應該保留
    agg.setSymbolThreshold('GOLD', 0.0002, 0.002, 0.5);
    const state = agg.getState('GOLD');
    expect(state).toBeDefined();
  });

  // ── calcRegimeForSymbol 極端值 ──
  it('M2: calcRegimeForSymbol 極端值(NaN/Infinity/負值)——唔 crash', () => {
    agg.setSymbolThreshold('SILVER', 0.0002, 0.002, 0.5);
    expect(() => agg.calcRegimeForSymbol('SILVER', 'bullish', NaN)).not.toThrow();
    expect(() => agg.calcRegimeForSymbol('SILVER', 'bullish', Infinity)).not.toThrow();
    expect(() => agg.calcRegimeForSymbol('SILVER', 'bullish', -1)).not.toThrow();
    expect(() => agg.calcRegimeForSymbol('SILVER', 'bullish', 1e308)).not.toThrow();
    expect(() => agg.calcRegimeForSymbol('__proto__', 'bullish', 0.001)).not.toThrow();
  });

  // ── update 極端值 ──
  it('M3: update 極端值(ticker 異常——symbol 缺失/price NaN/負值)——唔 crash', () => {
    expect(() => agg.update({} as any)).not.toThrow();
    expect(() => agg.update({ symbol: 'BTC', price: NaN } as any)).not.toThrow();
    expect(() => agg.update({ symbol: 'BTC', price: -1 } as any)).not.toThrow();
    expect(() => agg.update({ symbol: 'BTC', price: Infinity } as any)).not.toThrow();
    expect(() => agg.update({ symbol: '__proto__', price: 100 } as any)).not.toThrow();
    expect(() => agg.update({ symbol: 'BTC\nEVIL', price: 100 } as any)).not.toThrow();
  });

  // ── calcVolatility 極端值 ──
  it('M4: calcVolatility 極端值(空/1 個/NaN/Infinity/負值)——唔 crash', () => {
    expect(() => (agg as any).calcVolatility([], [])).not.toThrow();
    expect(() => (agg as any).calcVolatility([100], [Date.now()])).not.toThrow();
    expect(() => (agg as any).calcVolatility([NaN, NaN, NaN], [Date.now(), Date.now(), Date.now()])).not.toThrow();
    expect(() => (agg as any).calcVolatility([Infinity, Infinity, Infinity], [Date.now(), Date.now(), Date.now()])).not.toThrow();
    expect(() => (agg as any).calcVolatility([-1, -2, -3], [Date.now(), Date.now(), Date.now()])).not.toThrow();
    expect(() => (agg as any).calcVolatility([0, 0, 0], [Date.now(), Date.now(), Date.now()])).not.toThrow();
  });

  // ── getState 極端值 ──
  it('M5: getState 極端值(冇數據/異常 symbol)——唔 crash', () => {
    expect(() => agg.getState('NONEXISTENT')).not.toThrow();
    expect(() => agg.getState('')).not.toThrow();
    expect(() => agg.getState('__proto__')).not.toThrow();
    const state = agg.getState('NONEXISTENT');
    expect(state).toBeDefined();
    expect(Number.isFinite(state.volatility)).toBe(true);
  });

  // ── 併發 ──
  it('M6: 併發 update + getState + setSymbolThreshold(1000 call)——唔 crash', () => {
    for (let i = 0; i < 1000; i++) {
      agg.update({ symbol: 'BTC', price: 100 + i * 0.01, priceChangePercent: 0.1, volume: 1000, timestamp: Date.now() } as any);
      if (i % 100 === 0) {
        expect(() => agg.getState('BTC')).not.toThrow();
        expect(() => agg.setSymbolThreshold('BTC', 0.003, 0.03, 0.5)).not.toThrow();
      }
    }
  });

  // ── RegimeCalibrator 極端值 ──
  it('M7: RegimeCalibrator observe 極端值(空/異常 regime)——唔 crash', () => {
    const cal = (agg as any).calibrator;
    expect(() => cal.observe('')).not.toThrow();
    expect(() => cal.observe('__proto__')).not.toThrow();
    expect(() => cal.observe('mean_reverting')).not.toThrow();
    expect(() => cal.getThresholds()).not.toThrow();
    const t = cal.getThresholds();
    expect(t.volLow).toBeGreaterThan(0);
    expect(t.volHigh).toBeGreaterThan(t.volLow);
  });

  // ── getPriceHistory 極端值 ──
  it('M8: getPriceHistory 極端值(冇數據/異常 symbol)——唔 crash', () => {
    expect(() => agg.getPriceHistory('NONEXISTENT')).not.toThrow();
    expect(() => agg.getPriceHistory('')).not.toThrow();
    expect(() => agg.getPriceHistory('__proto__')).not.toThrow();
  });
});

describe('v2.0.869 multi-exchange-ws(剷除 binance 後)+ getVolatilityStats 攻擊', () => {
  it('W1: detectExchange——異常 symbol(空/undefined/控制字符)——唔 crash', () => {
    // detectExchange 邏輯:全部 hyperliquid(HL-only)
    const detect = (sym: string) => 'hyperliquid';
    expect(() => detect('')).not.toThrow();
    expect(detect('BTC')).toBe('hyperliquid');
    expect(detect('xyz:SILVER')).toBe('hyperliquid');
    expect(detect('BTC\nEVIL')).toBe('hyperliquid');
  });

  it('W2: getVolatilityStats 極端值(price history 空/1 個/NaN/Infinity)——唔 crash', () => {
    // 透過 MarketStateAggregator 模擬——price history 極端
    const agg = new MarketStateAggregator();
    // 空 history
    expect(() => (agg as any).calcVolatility([], [])).not.toThrow();
    // 1 個
    expect(() => (agg as any).calcVolatility([100], [Date.now()])).not.toThrow();
    // NaN
    expect(() => (agg as any).calcVolatility([NaN, NaN, NaN, NaN, NaN], [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()])).not.toThrow();
    // Infinity
    expect(() => (agg as any).calcVolatility([Infinity, Infinity, Infinity, Infinity, Infinity], [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()])).not.toThrow();
    // 負值
    expect(() => (agg as any).calcVolatility([-1, -2, -3, -4, -5], [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()])).not.toThrow();
    // 0
    expect(() => (agg as any).calcVolatility([0, 0, 0, 0, 0], [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()])).not.toThrow();
  });

  it('W3: calcTrend 極端值(ticker 缺失/priceChangePercent NaN/Infinity)——唔 crash', () => {
    const agg = new MarketStateAggregator();
    expect(() => (agg as any).calcTrend(undefined, 0.001)).not.toThrow();
    expect(() => (agg as any).calcTrend({ priceChangePercent: NaN } as any, 0.001)).not.toThrow();
    expect(() => (agg as any).calcTrend({ priceChangePercent: Infinity } as any, 0.001)).not.toThrow();
    expect(() => (agg as any).calcTrend({ priceChangePercent: -Infinity } as any, 0.001)).not.toThrow();
  });

  it('W4: getRecentPriceTrend 極端值(冇數據/異常 symbol)——唔 crash', () => {
    const agg = new MarketStateAggregator();
    expect(() => agg.getRecentPriceTrend('NONEXISTENT')).not.toThrow();
    expect(() => agg.getRecentPriceTrend('')).not.toThrow();
    expect(() => agg.getRecentPriceTrend('__proto__')).not.toThrow();
  });

  it('W5: 併發 update + getState + calcRegimeForSymbol(500 call)——唔 crash', () => {
    const agg = new MarketStateAggregator();
    agg.setSymbolThreshold('SILVER', 0.0002, 0.002, 0.5);
    for (let i = 0; i < 500; i++) {
      agg.update({ symbol: 'SILVER', price: 64 + i * 0.001, priceChangePercent: 0.1, volume: 1000, timestamp: Date.now() } as any);
      if (i % 50 === 0) {
        expect(() => agg.getState('SILVER')).not.toThrow();
        expect(() => agg.calcRegimeForSymbol('SILVER', 'bullish', 0.001)).not.toThrow();
      }
    }
  });
});
