// ─── v2.0.820: MarketStateAggregator volatility scaling + feed pipeline ──
//
// Tests the three production fixes for the "calm symbols permanently blocked"
// defect:
//   A1 — calcVolatility uses the ACTUAL tick time span (timestamps), not a
//        hardcoded 0.1s/tick assumption. The old scaling understated σ ~30×
//        for REST-polled non-active markets (1 tick/4min), permanently
//        classifying every calm symbol as low_volatility + tripping vol-gate.
//   B  — marketState.update accepts and stores timestamps so calcVolatility
//        can scale correctly.

import { describe, it, expect } from 'vitest';
import { MarketStateAggregator } from '../src/data/market-state.ts';

function makeTick(symbol: string, price: number, ts: number) {
  return { symbol, price, volume: 0, quoteVolume: 0, priceChange: 0, priceChangePercent: 0, high24h: 0, low24h: 0, timestamp: ts };
}

describe('MarketStateAggregator — v2.0.820 volatility scaling (Fix A1)', () => {
  it('produces a non-zero, finite volatility from a normal WS tick stream', () => {
    const agg = new MarketStateAggregator();
    const base = 100;
    for (let i = 0; i < 50; i++) {
      const price = base * (1 + (Math.random() - 0.5) * 0.006);
      agg.update(makeTick('btc', price, Date.now() + i * 100));
    }
    const vol = agg.getState('btc').volatility;
    expect(Number.isFinite(vol)).toBe(true);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThanOrEqual(1.0);
  });

  it('scales σ by ACTUAL history duration — fast WS stream yields higher cycle σ than slow REST stream at same tick σ', () => {
    const fast = new MarketStateAggregator();
    const slow = new MarketStateAggregator();
    const prices: number[] = [100];
    for (let i = 0; i < 20; i++) prices.push(prices[i]! * (i % 2 === 0 ? 1.002 : 0.998));
    const t0 = Date.now();
    for (let i = 0; i < prices.length; i++) fast.update(makeTick('btc', prices[i]!, t0 + i * 500));
    for (let i = 0; i < prices.length; i++) slow.update(makeTick('btc', prices[i]!, t0 + i * 200_000));
    const fastVol = fast.getState('btc').volatility;
    const slowVol = slow.getState('btc').volatility;
    // Same tick σ. Fast stream (10s history) scales UP to a 5-min cycle by
    // √(300/10)=5.5; slow stream (4000s history) scales by √(300/4000)=0.27.
    // Fast > slow — and both non-zero (the old code reported ~30× too low
    // for the slow stream, often effectively 0).
    expect(fastVol).toBeGreaterThan(slowVol);
    expect(fastVol).toBeGreaterThan(0);
    expect(slowVol).toBeGreaterThan(0);
  });

  it('returns 0 volatility when fewer than 3 prices (cold-start safe)', () => {
    const agg = new MarketStateAggregator();
    agg.update(makeTick('btc', 100, Date.now()));
    agg.update(makeTick('btc', 101, Date.now()));
    expect(agg.getState('btc').volatility).toBe(0);
  });

  it('returns 0 price for an unknown symbol (cold-start safe, feeds the vol-gate hard-block path)', () => {
    const agg = new MarketStateAggregator();
    const s = agg.getState('unknown');
    expect(s.price).toBe(0);
    expect(s.volatility).toBe(0);
    expect(s.regime).toBe('low_volatility');
  });

  it('deduplicates out-of-order timestamps (REST backfill can return stale ts)', () => {
    const agg = new MarketStateAggregator();
    const t = Date.now();
    agg.update(makeTick('btc', 100, t));
    agg.update(makeTick('btc', 101, t - 5000));
    agg.update(makeTick('btc', 102, t + 1000));
    const vol = agg.getState('btc').volatility;
    expect(Number.isFinite(vol)).toBe(true);
  });

  it('per-symbol isolation: oscillating BTC has higher σ than barely-moving SILVER', () => {
    const agg = new MarketStateAggregator();
    for (let i = 0; i < 10; i++) {
      agg.update(makeTick('btc', 100 * (i % 2 === 0 ? 1.02 : 0.98), Date.now() + i * 1000));
      agg.update(makeTick('xyz:SILVER', 58 + (i % 3) * 0.0001, Date.now() + i * 1000));
    }
    const btc = agg.getState('btc');
    const silver = agg.getState('xyz:SILVER');
    expect(btc.price).toBeCloseTo(100 * (9 % 2 === 0 ? 1.02 : 0.98), 6);
    expect(btc.volatility).toBeGreaterThan(silver.volatility);
    expect(btc.volatility).toBeGreaterThan(0.001);
  });

  it('getPriceHistory returns a copy (mutation does not corrupt internal state)', () => {
    const agg = new MarketStateAggregator();
    agg.update(makeTick('btc', 100, Date.now()));
    const h = agg.getPriceHistory('btc');
    h.push(999);
    expect(agg.getPriceHistory('btc')).not.toContain(999);
  });
});
describe('MarketStateAggregator — v2.0.820 ABSOLUTE scaling correctness (regression guard)', () => {
  // The 10× understate bug (using historyDuration instead of tickInterval)
  // slipped past the ordering-only tests above. This test pins the ABSOLUTE
  // σ_cycle value to the hand-computed diffusion formula:
  //   σ_cycle = σ_tick × √(cycleDuration / tickInterval)
  // Alternating ±0.2% prices → σ_tick = ln(1.002), mean = 0 (even count).
  const SIGMA_TICK = Math.log(1.002);          // 0.001998
  const CYCLE = 300;                            // seconds (5-min anchor)

  function alternatingPrices(n: number): number[] {
    const out: number[] = [100];
    for (let i = 0; i < n - 1; i++) out.push(out[i]! * (i % 2 === 0 ? 1.002 : 0.998));
    return out; // length n
  }

  it('fast WS stream (0.5s/tick): σ_cycle ≈ σ_tick × √(300/0.5) ≈ 0.0489', () => {
    const agg = new MarketStateAggregator();
    const prices = alternatingPrices(21);       // 20 log-returns (even → mean 0)
    const t0 = Date.now();
    for (let i = 0; i < prices.length; i++) agg.update(makeTick('btc', prices[i]!, t0 + i * 500));
    const tickInterval = (20 * 500) / 1000 / 20; // 0.5s
    const expected = SIGMA_TICK * Math.sqrt(CYCLE / tickInterval);
    const vol = agg.getState('btc').volatility;
    expect(vol).toBeGreaterThan(0);
    // Allow ±3% tolerance for discrete-pattern edge effects.
    expect(Math.abs(vol - expected) / expected).toBeLessThan(0.03);
    // And the absolute floor: must be > 0.01 (the 10× bug gave ~0.005).
    expect(vol).toBeGreaterThan(0.01);
  });

  it('slow REST stream (200s/tick): σ_cycle ≈ σ_tick × √(300/200) ≈ 0.0024', () => {
    const agg = new MarketStateAggregator();
    const prices = alternatingPrices(21);
    const t0 = Date.now();
    for (let i = 0; i < prices.length; i++) agg.update(makeTick('xyz:SILVER', prices[i]!, t0 + i * 200_000));
    const tickInterval = (20 * 200_000) / 1000 / 20; // 200s
    const expected = SIGMA_TICK * Math.sqrt(CYCLE / tickInterval);
    const vol = agg.getState('xyz:SILVER').volatility;
    expect(vol).toBeGreaterThan(0);
    expect(Math.abs(vol - expected) / expected).toBeLessThan(0.03);
    // Key: a slow stream with 0.2% per-tick moves is NOT near-zero — it's ~0.24%.
    // The old historyDuration bug gave ~0.00024 (10× too low).
    expect(vol).toBeGreaterThan(0.001);
  });

  it('fast and slow streams with identical per-tick σ differ by √(tickInterval_ratio)', () => {
    // fast tickInterval=0.5s, slow=200s. ratio=400. √400=20.
    // fast σ / slow σ = √(200/0.5) = 20.
    const fast = new MarketStateAggregator();
    const slow = new MarketStateAggregator();
    const prices = alternatingPrices(21);
    const t0 = Date.now();
    for (let i = 0; i < prices.length; i++) fast.update(makeTick('btc', prices[i]!, t0 + i * 500));
    for (let i = 0; i < prices.length; i++) slow.update(makeTick('btc', prices[i]!, t0 + i * 200_000));
    const ratio = fast.getState('btc').volatility / slow.getState('btc').volatility;
    expect(Math.abs(ratio - 20) / 20).toBeLessThan(0.03);
  });
});

describe('MarketStateAggregator — v2.0.820 defensive guards (self-attack survivors)', () => {
  it('burst of same-timestamp ticks does NOT inflate vol to false high_volatility (tickInterval floor)', () => {
    // 100 ticks all at the same ts (simulates a replay burst or REST dedup).
    // Without the 0.05s tickInterval floor, scaleFactor = √(300/0.001) = 547x
    // → vol ~3.5% (false high_volatility). With the floor, vol is bounded.
    const agg = new MarketStateAggregator();
    const t = Date.now();
    for (let i = 0; i < 100; i++) {
      agg.update(makeTick('btc', 100 + (i % 2 === 0 ? 0.01 : -0.01), t));
    }
    const vol = agg.getState('btc').volatility;
    // Must stay below the high_volatility threshold (0.03) — a burst artifact
    // must not be misclassified as a volatile market.
    expect(vol).toBeLessThan(0.03);
    expect(vol).toBeGreaterThan(0); // still non-zero (there IS tick dispersion)
  });

  it('a hung/empty backfill symbol reports vol=0 (feeds the vol-gate hard-block path)', () => {
    const agg = new MarketStateAggregator();
    // No updates at all — simulates a backfill that never fired / hung.
    expect(agg.getState('xyz:NEVERFED').volatility).toBe(0);
    expect(agg.getState('xyz:NEVERFED').price).toBe(0);
  });
});
