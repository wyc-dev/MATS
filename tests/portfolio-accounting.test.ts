import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// Mock the persistence module so PortfolioTracker starts fresh (no disk load).
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
    id: randomUUID(),
    symbol,
    side,
    type: 'market',
    quantity,
    price: 0,
    status: 'open',
    filledQuantity: quantity,
    filledPrice: 0,
    createdAt: now,
    updatedAt: now,
    agentId,
  };
}

describe('PortfolioTracker paper accounting (Bug #3 fix)', () => {
  let tracker: PortfolioTracker;

  beforeEach(() => {
    tracker = new PortfolioTracker();
  });

  it('balance === initialBalance + totalPnl after a profitable long close', () => {
    const initialBalance = tracker.getPortfolio().balance; // config.paper.initialBalance (1000)
    const entryPrice = 100;
    const quantity = 10;
    const leverage = 1;
    const exitPrice = 110; // +10 per unit → rawPricePnl = +100

    const order = makeOrder('btcusdt', 'buy', quantity);
    tracker.openPosition(order, entryPrice, leverage);

    // entryFee = 0.04% × (100 × 10) = 0.40
    const entryFee = 0.0004 * entryPrice * quantity;
    // After open: balance = initial − margin − entryFee
    const margin = (entryPrice * quantity) / leverage;
    expect(tracker.getPortfolio().balance).toBeCloseTo(initialBalance - margin - entryFee, 1e-9);

    const trade = tracker.closePosition('btcusdt', exitPrice);
    expect(trade).not.toBeNull();

    // exitFee = 0.04% × (110 × 10) = 0.44
    const exitFee = 0.0004 * exitPrice * quantity;
    const rawPricePnl = (exitPrice - entryPrice) * quantity; // +100
    const expectedNetPnl = rawPricePnl - entryFee - exitFee; // 100 - 0.40 - 0.44 = 99.16

    // realizedPnl in the trade record must be TRUE net PnL
    expect(trade!.pnl).toBeCloseTo(expectedNetPnl, 1e-9);

    // totalPnl must equal net PnL
    expect(tracker.getPortfolio().totalPnl).toBeCloseTo(expectedNetPnl, 1e-9);

    // CRITICAL invariant: balance === initialBalance + totalPnl
    expect(tracker.getPortfolio().balance).toBeCloseTo(initialBalance + tracker.getPortfolio().totalPnl, 1e-9);
  });

  it('balance === initialBalance + totalPnl after a losing long close', () => {
    const initialBalance = tracker.getPortfolio().balance;
    const entryPrice = 100;
    const quantity = 10;
    const leverage = 1;
    const exitPrice = 95; // −5 per unit → rawPricePnl = −50

    const order = makeOrder('ethusdt', 'buy', quantity);
    tracker.openPosition(order, entryPrice, leverage);

    const entryFee = 0.0004 * entryPrice * quantity;
    const exitFee = 0.0004 * exitPrice * quantity;
    const rawPricePnl = (exitPrice - entryPrice) * quantity; // −50
    const expectedNetPnl = rawPricePnl - entryFee - exitFee;

    const trade = tracker.closePosition('ethusdt', exitPrice);
    expect(trade).not.toBeNull();

    expect(trade!.pnl).toBeCloseTo(expectedNetPnl, 1e-9);
    expect(tracker.getPortfolio().totalPnl).toBeCloseTo(expectedNetPnl, 1e-9);
    expect(tracker.getPortfolio().balance).toBeCloseTo(initialBalance + tracker.getPortfolio().totalPnl, 1e-9);
  });

  it('balance === initialBalance + totalPnl after a profitable short close', () => {
    const initialBalance = tracker.getPortfolio().balance;
    const entryPrice = 100;
    const quantity = 10;
    const leverage = 1;
    const exitPrice = 90; // short profit: (100−90)×10 = +100

    const order = makeOrder('solusdt', 'sell', quantity);
    tracker.openPosition(order, entryPrice, leverage);

    const entryFee = 0.0004 * entryPrice * quantity;
    const exitFee = 0.0004 * exitPrice * quantity;
    const rawPricePnl = (entryPrice - exitPrice) * quantity; // +100
    const expectedNetPnl = rawPricePnl - entryFee - exitFee;

    const trade = tracker.closePosition('solusdt', exitPrice);
    expect(trade).not.toBeNull();

    expect(trade!.pnl).toBeCloseTo(expectedNetPnl, 1e-9);
    expect(tracker.getPortfolio().totalPnl).toBeCloseTo(expectedNetPnl, 1e-9);
    expect(tracker.getPortfolio().balance).toBeCloseTo(initialBalance + tracker.getPortfolio().totalPnl, 1e-9);
  });

  it('balance === initialBalance + totalPnl with leverage > 1', () => {
    const initialBalance = tracker.getPortfolio().balance;
    const entryPrice = 100;
    const quantity = 10;
    const leverage = 10;
    const exitPrice = 105; // +5 per unit → rawPricePnl = +50

    const order = makeOrder('btcusdt', 'buy', quantity);
    tracker.openPosition(order, entryPrice, leverage);

    const entryFee = 0.0004 * entryPrice * quantity;
    const exitFee = 0.0004 * exitPrice * quantity;
    const rawPricePnl = (exitPrice - entryPrice) * quantity; // +50
    const expectedNetPnl = rawPricePnl - entryFee - exitFee;

    const trade = tracker.closePosition('btcusdt', exitPrice);
    expect(trade).not.toBeNull();

    expect(trade!.pnl).toBeCloseTo(expectedNetPnl, 1e-9);
    expect(tracker.getPortfolio().totalPnl).toBeCloseTo(expectedNetPnl, 1e-9);
    expect(tracker.getPortfolio().balance).toBeCloseTo(initialBalance + tracker.getPortfolio().totalPnl, 1e-9);
  });

  it('invariant holds across multiple sequential trades', () => {
    const initialBalance = tracker.getPortfolio().balance;
    const trades = [
      { symbol: 'btcusdt', side: 'buy' as const, entry: 100, exit: 110, qty: 5, lev: 1 },
      { symbol: 'ethusdt', side: 'buy' as const, entry: 50, exit: 48, qty: 20, lev: 2 },
      { symbol: 'solusdt', side: 'sell' as const, entry: 200, exit: 190, qty: 3, lev: 1 },
      { symbol: 'btcusdt', side: 'buy' as const, entry: 105, exit: 95, qty: 8, lev: 5 },
    ];

    for (const t of trades) {
      const order = makeOrder(t.symbol, t.side, t.qty);
      tracker.openPosition(order, t.entry, t.lev);
      const trade = tracker.closePosition(t.symbol, t.exit);
      expect(trade).not.toBeNull();
    }

    // After all trades: balance must equal initialBalance + totalPnl
    const { balance, totalPnl } = tracker.getPortfolio();
    expect(balance).toBeCloseTo(initialBalance + totalPnl, 1e-9);
  });
});

describe('setEntryThesis freeze (v2.0.137 Root Cause B fix)', () => {
  let tracker: PortfolioTracker;

  beforeEach(() => {
    tracker = new PortfolioTracker();
  });

  it('openPosition freezes the original entry thesis', () => {
    const order = makeOrder('btc', 'buy', 1);
    tracker.openPosition(order, 60000, 1, '[1h: break 61k] [1d: trend up]');
    const pos = tracker.getPosition('btc');
    expect(pos?.entryThesis).toBe('[1h: break 61k] [1d: trend up]');
  });

  it('setEntryThesis does NOT overwrite an already-frozen thesis', () => {
    const order = makeOrder('btc', 'buy', 1);
    const original = '[1h: break 61k] [1d: trend up]';
    tracker.openPosition(order, 60000, 1, original);
    tracker.setEntryThesis('btc', '[1h: now needs 62k] [1d: still up]');
    tracker.setEntryThesis('btc', '[1h: reclaim 63k] [1d: momentum]');
    expect(tracker.getPosition('btc')?.entryThesis).toBe(original);
  });

  it('setEntryThesis fills an empty thesis (re-imported position) then freezes it', () => {
    tracker.importExchangePosition('btc', 'buy', 1, 60000, 1, Date.now());
    expect(tracker.getPosition('btc')?.entryThesis).toBeUndefined();
    tracker.setEntryThesis('btc', '[1h: break 61k] [1d: trend up]');
    expect(tracker.getPosition('btc')?.entryThesis).toBe('[1h: break 61k] [1d: trend up]');
    tracker.setEntryThesis('btc', '[1h: now 62k]');
    expect(tracker.getPosition('btc')?.entryThesis).toBe('[1h: break 61k] [1d: trend up]');
  });

  it('setEntryThesis rejects placeholder theses to prevent spurious invalidation', () => {
    tracker.importExchangePosition('btc', 'buy', 1, 60000, 1, Date.now());
    for (const bad of ['', '   ', 'N/A', 'n/a', 'Not applicable', 'none', 'null', '-']) {
      tracker.setEntryThesis('btc', bad);
      expect(tracker.getPosition('btc')?.entryThesis).toBeUndefined();
    }
    tracker.setEntryThesis('btc', '[1h: break 61k] [1d: trend up]');
    expect(tracker.getPosition('btc')?.entryThesis).toBe('[1h: break 61k] [1d: trend up]');
  });

  it('a re-opened position (after close) gets a new frozen thesis', () => {
    const order = makeOrder('btc', 'buy', 1);
    tracker.openPosition(order, 60000, 1, 'first thesis');
    expect(tracker.getPosition('btc')?.entryThesis).toBe('first thesis');
    tracker.closePosition('btc', 61000);
    const order2 = makeOrder('btc', 'buy', 1);
    tracker.openPosition(order2, 61000, 1, 'second thesis');
    expect(tracker.getPosition('btc')?.entryThesis).toBe('second thesis');
  });
});

// ─── v2.0.819: Entry-features data pipeline (Fix #3) ─────────────────
//
// The close path previously reconstructed the TradeRecord WITHOUT copying
// entryMarketFeatures / entryOlrPWin / entryShadowWinRate / regime from the
// position — root cause of 100% NO_OLR / NO_SHADOW on every real trade. These
// tests verify the fields now flow open → position → closed trade record.

describe('PortfolioTracker — v2.0.819 entry-features pipeline', () => {
  let tracker: PortfolioTracker;
  beforeEach(() => {
    tracker = new PortfolioTracker();
  });

  it('openPosition stores entryData on the position object', () => {
    const order = makeOrder('btc', 'buy', 1);
    const entryData = {
      marketFeatures: { volatility: 0.012, srDistanceBps: 88 },
      olrPWin: 0.62,
      shadowWinRate: 0.71,
      regime: 'mean_reverting',
    };
    tracker.openPosition(order, 60000, 1, 'thesis', entryData);
    const pos = tracker.getPosition('btc');
    expect(pos).not.toBeNull();
    expect(pos!.entryMarketFeatures).toEqual({ volatility: 0.012, srDistanceBps: 88 });
    expect(pos!.entryOlrPWin).toBeCloseTo(0.62, 6);
    expect(pos!.entryShadowWinRate).toBeCloseTo(0.71, 6);
    expect(pos!.regime).toBe('mean_reverting');
  });

  it('closePosition copies entry fields onto the closed TradeRecord', () => {
    const order = makeOrder('btc', 'buy', 1);
    const entryData = {
      marketFeatures: { volatility: 0.012, srDistanceBps: 88, sentiment: -0.4 },
      olrPWin: 0.62,
      shadowWinRate: 0.71,
      regime: 'mean_reverting',
    };
    tracker.openPosition(order, 60000, 1, 'thesis', entryData);
    const trade = tracker.closePosition('btc', 61000);
    expect(trade).not.toBeNull();
    // ROOT FIX: these were silently dropped before v2.0.819.
    expect(trade!.entryMarketFeatures).toEqual({ volatility: 0.012, srDistanceBps: 88, sentiment: -0.4 });
    expect(trade!.entryOlrPWin).toBeCloseTo(0.62, 6);
    expect(trade!.entryShadowWinRate).toBeCloseTo(0.71, 6);
    expect(trade!.regime).toBe('mean_reverting');
  });

  it('importExchangePosition stores entryData on the real position', () => {
    const entryData = {
      marketFeatures: { volatility: 0.009 },
      olrPWin: 0.55,
      shadowWinRate: 0.6,
      regime: 'low_volatility',
    };
    tracker.importExchangePosition('xyz:silver', 'sell', 2, 58.27, 10, Date.now(), entryData);
    const pos = tracker.getRealPositions().find(p => p.symbol === 'xyz:silver');
    expect(pos).not.toBeUndefined();
    expect(pos!.entryMarketFeatures).toEqual({ volatility: 0.009 });
    expect(pos!.entryOlrPWin).toBeCloseTo(0.55, 6);
    expect(pos!.entryShadowWinRate).toBeCloseTo(0.6, 6);
    expect(pos!.regime).toBe('low_volatility');
  });

  it('openPosition without entryData leaves fields undefined (backward compatible)', () => {
    const order = makeOrder('btc', 'buy', 1);
    tracker.openPosition(order, 60000, 1, 'thesis');
    const pos = tracker.getPosition('btc');
    expect(pos!.entryMarketFeatures).toBeUndefined();
    expect(pos!.entryOlrPWin).toBeUndefined();
    expect(pos!.regime).toBeUndefined();
    const trade = tracker.closePosition('btc', 61000);
    expect(trade!.entryMarketFeatures).toBeUndefined();
  });
});
describe('v2.0.869 HL unrealizedPnl 追蹤(主神 SKHX MAE=0 調查)', () => {
  let tracker: any;
  beforeEach(() => {
    tracker = new PortfolioTracker();
  });

  it('H1: 冇 HL pnl——現有邏輯(recomputePnL + trackMAEMFE)', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    tracker.softUpdatePosition('btcusdt', 105); // price 升——max 追蹤
    tracker.softUpdatePosition('btcusdt', 95); // price 跌 5%——BUY 蝕——min 追蹤
    const pos = tracker.getPosition('btcusdt');
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    expect(pos.minValueReached).toBeLessThan(margin);
    expect(pos.maxValueReached).toBeGreaterThan(margin);
  });

  it('H2: 有 HL pnl——用 HL 值追蹤 min/max(短持倉 trade 唔再 MAE=0)', () => {
    tracker.openPosition(makeOrder('skhx', 'sell', 0.1), 1186.6, 5);
    const pos = tracker.getPosition('skhx');
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    // HL 回傳:price 升咗——SELL 蝕——unrealizedPnl 負
    tracker.softUpdatePosition('skhx', 1188.8, -0.12);
    const pos2 = tracker.getPosition('skhx');
    // MAE 應該有真實值(唔再係 0)
    expect(pos2.minValueReached).toBeLessThan(margin);
    expect(pos2.unrealizedPnl).toBe(-0.12);
  });

  it('H3: HL pnl 正(SELL 賺)——maxValueReached 追蹤', () => {
    tracker.openPosition(makeOrder('skhx', 'sell', 0.1), 1167.9, 5);
    const pos = tracker.getPosition('skhx');
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    tracker.softUpdatePosition('skhx', 1150, 0.5); // price 跌——SELL 賺
    const pos2 = tracker.getPosition('skhx');
    expect(pos2.maxValueReached).toBeGreaterThan(margin);
    expect(pos2.unrealizedPnl).toBe(0.5);
  });

  it('H4: HL pnl NaN/Infinity——sanitize(唔用——fallback 本地)', () => {
    tracker.openPosition(makeOrder('btcusdt', 'buy', 1), 100, 10);
    tracker.softUpdatePosition('btcusdt', 95, NaN);
    const pos = tracker.getPosition('btcusdt');
    // NaN 唔應該污染——fallback 本地 recomputePnL
    expect(Number.isFinite(pos.unrealizedPnl)).toBe(true);
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    expect(pos.minValueReached).toBeLessThan(margin);
  });

  it('H5: 連續 HL pnl 更新——min/max 正確追蹤(唔會倒退)', () => {
    tracker.openPosition(makeOrder('skhx', 'sell', 0.1), 1186.6, 5);
    const pos = tracker.getPosition('skhx');
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    // 先蝕(price 升)——再賺(price 跌)
    tracker.softUpdatePosition('skhx', 1188.8, -0.12);
    tracker.softUpdatePosition('skhx', 1180, 0.3);
    const pos2 = tracker.getPosition('skhx');
    // min 應該係蝕嗰陣嘅值(唔會倒退)
    expect(pos2.minValueReached).toBeLessThan(margin);
    // max 應該係賺嗰陣嘅值
    expect(pos2.maxValueReached).toBeGreaterThan(margin);
  });

  it('H6: HL pnl 同步更新 unrealizedPnlPct(主神 SILVER 正負號反轉調查)', () => {
    // SILVER 真實場景:BUY entry $64.888,HL 真實 unrealizedPnl = -0.18(蝕緊)
    // 但 l2Book bid 價 = 65.209(高過 entry)——recomputePnL 會計到 +0.29(錯——正負號反轉)
    tracker.openPosition(makeOrder('silver', 'buy', 0.91), 64.888, 10);
    const pos = tracker.getPosition('silver');
    const margin = (pos.averageEntryPrice * pos.quantity) / pos.leverage;
    // 修復:傳 HL 真實 unrealizedPnl = -0.18——unrealizedPnlPct 用 HL 值(唔用 recomputePnL)
    tracker.softUpdatePosition('silver', 65.209, -0.18);
    const pos2 = tracker.getPosition('silver');
    expect(pos2.unrealizedPnl).toBe(-0.18);
    expect(pos2.unrealizedPnlPct).toBeCloseTo(-0.18 / margin, 5);
    // 正負號正確:蝕緊——唔係賺
    expect(pos2.unrealizedPnlPct).toBeLessThan(0);
  });
});
