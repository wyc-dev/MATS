import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../src/evolution/persistence.ts', () => ({
  loadPortfolio: () => null,
  savePortfolio: () => {},
  saveEvolutionState: () => {},
  loadEvolutionState: () => null,
}));

import { PortfolioTracker } from '../src/trading/portfolio.ts';
import type { Order } from '../src/types/index.ts';

function makeOrder(symbol: string, side: 'buy' | 'sell', quantity: number, agentId = 'test-agent'): Order {
  const now = Date.now();
  return {
    id: randomUUID(), symbol, side, type: 'market', quantity, price: 0,
    status: 'open', filledQuantity: quantity, filledPrice: 0, createdAt: now, updatedAt: now, agentId,
  };
}

describe('v2.0.869 HL pnl 攻擊(併發/狀態注入/持久化污染)', () => {
  let tracker: PortfolioTracker;
  beforeEach(() => { tracker = new PortfolioTracker(); });

  it('A1: HL pnl 超大(1e308)——posValue 跳出 sanity range——pos.unrealizedPnl 唔應該被污染', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    tracker.softUpdatePosition('btcusdt', 100, 1e308);
    const pos = tracker.getPosition('btcusdt');
    // 超大 pnl 令 posValue 跳出 range——trackMAEMFE 拒絕——但係 pos.unrealizedPnl 唔應該被污染
    expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
    expect(Math.abs(pos.unrealizedPnl)).toBeLessThan(1e6);
  });

  it('A2: HL pnl 超細(-1e308)——同上', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    tracker.softUpdatePosition('btcusdt', 100, -1e308);
    const pos = tracker.getPosition('btcusdt');
    expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
    expect(Math.abs(pos.unrealizedPnl)).toBeLessThan(1e6);
  });

  it('A3: HL pnl 令 posValue 負(清算線以下)——pos.unrealizedPnl 唔應該被污染', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    // margin = 10——pnl = -20 → posValue = -10 < 0——trackMAEMFE 拒絕
    tracker.softUpdatePosition('btcusdt', 100, -20);
    const pos = tracker.getPosition('btcusdt');
    expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
    expect(pos.unrealizedPnl).toBeGreaterThan(-20); // 唔應該係 -20(污染)
  });

  it('A4: HL pnl string/object/null——sanitize fallback 本地', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    tracker.softUpdatePosition('btcusdt', 95, 'abc' as unknown as number);
    tracker.softUpdatePosition('btcusdt', 95, {} as unknown as number);
    tracker.softUpdatePosition('btcusdt', 95, null as unknown as number);
    const pos = tracker.getPosition('btcusdt');
    expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
    // fallback 本地 recomputePnL——pnl = (95-100)×1 - fee = -5.04
    expect(pos.unrealizedPnl).toBeCloseTo(-5.04, 1);
  });

  it('A5: 併發 softUpdatePosition(交錯 HL pnl + 本地)——min/max 唔會倒退', () => {
    tracker.openPosition(makeOrder('skhx', 'sell', 0.1), 1186.6, 5);
    const pos = tracker.getPosition('skhx');
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    // 模擬交錯:HL pnl 蝕 → 本地 price 跌(賺)→ HL pnl 再蝕
    tracker.softUpdatePosition('skhx', 1188.8, -0.12);
    tracker.softUpdatePosition('skhx', 1150); // 本地——price 跌——SELL 賺
    tracker.softUpdatePosition('skhx', 1190, -0.2);
    const pos2 = tracker.getPosition('skhx');
    // min 應該係最蝕嗰陣(-0.2)
    expect(pos2.minValueReached).toBeLessThan(margin);
    // max 應該係最賺嗰陣(1150)
    expect(pos2.maxValueReached).toBeGreaterThan(margin);
  });

  it('A6: HL pnl 令 posValue 剛好喺 range 邊緣(3×margin)——邊界', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    // margin = 10——posValue = 10 + 20 = 30 = 3×margin——trackMAEMFE 接受(唔 < 0 唔 > 30)
    tracker.softUpdatePosition('btcusdt', 100, 20);
    const pos = tracker.getPosition('btcusdt');
    expect(pos.unrealizedPnl).toBe(20);
    expect(pos.maxValueReached).toBe(30);
  });

  it('A7: 持久化污染——load 時 minValueReached 負值/NaN——sanitize 唔 crash', () => {
    // 模擬 state file 污染——直接設定 pos 再 softUpdate
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    const pos = tracker.getPosition('btcusdt');
    (pos as any).minValueReached = -5; // 污染(負值)
    (pos as any).maxValueReached = NaN; // 污染(NaN)
    expect(() => tracker.softUpdatePosition('btcusdt', 95, -1)).not.toThrow();
    const pos2 = tracker.getPosition('btcusdt');
    expect(Number.isFinite(pos2.minValueReached)).toBe(true);
    expect(Number.isFinite(pos2.maxValueReached)).toBe(true);
  });

  it('A8: HL pnl 0——posValue = margin——min/max 唔變', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    tracker.softUpdatePosition('btcusdt', 100, 0);
    const pos = tracker.getPosition('btcusdt');
    expect(pos.unrealizedPnl).toBe(0);
    // min = 開倉值(margin - entryFee)——max = margin(HL pnl 0 更新 posValue = margin)
    // 兩者差 entryFee——正常(唔係漏洞)
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    expect(pos.minValueReached).toBeLessThanOrEqual(margin);
    expect(pos.maxValueReached).toBeLessThanOrEqual(margin);
  });
});
