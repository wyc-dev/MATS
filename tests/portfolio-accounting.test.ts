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