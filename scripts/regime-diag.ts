// 診斷:MarketStateAggregator 嘅 regime 判斷——唔同 volatility/trend 組合
import { MarketStateAggregator } from '/Users/y.c./Downloads/mats_backend/src/data/binance-websocket.ts';

const agg = new MarketStateAggregator();

function feed(symbol: string, price: number, changePct: number, prices: number[], ts: number[]): void {
  // 逐個 tick update(用 ticker.timestamp 做時間)
  for (let i = 0; i < prices.length; i++) {
    agg.update({
      symbol, price: prices[i]!, priceChangePercent: changePct, volume: 1000, timestamp: ts[i]!,
    } as any);
  }
}

const now = Date.now();

// 測試 1:高波動(±5%——1s/tick)
const highVolPrices: number[] = [];
const highVolTs: number[] = [];
for (let i = 0; i < 100; i++) {
  highVolPrices.push(100 + Math.sin(i / 5) * 5);
  highVolTs.push(now - (100 - i) * 1000);
}
feed('btc', 100, 5, highVolPrices, highVolTs);

// 測試 2:低波動(±0.05%——1s/tick)
const lowVolPrices: number[] = [];
const lowVolTs: number[] = [];
for (let i = 0; i < 100; i++) {
  lowVolPrices.push(100 + Math.sin(i / 5) * 0.05);
  lowVolTs.push(now - (100 - i) * 1000);
}
feed('eth', 100, 0.1, lowVolPrices, lowVolTs);

// 測試 3:trending(單向升——1s/tick)
const trendPrices: number[] = [];
const trendTs: number[] = [];
for (let i = 0; i < 100; i++) {
  trendPrices.push(100 + i * 0.5);
  trendTs.push(now - (100 - i) * 1000);
}
feed('sol', 100, 10, trendPrices, trendTs);

// 測試 4:慢 tick(±2%——4min/tick——REST-polled)
const slowPrices: number[] = [];
const slowTs: number[] = [];
for (let i = 0; i < 100; i++) {
  slowPrices.push(100 + Math.sin(i / 5) * 2);
  slowTs.push(now - (100 - i) * 240000);
}
feed('skhx', 100, 2, slowPrices, slowTs);

// 輸出
for (const sym of ['btc', 'eth', 'sol', 'skhx']) {
  const s = agg.getState(sym);
  console.log(`${sym}: regime=${s.regime} vol=${(s.volatility * 100).toFixed(4)}% trend=${s.trend}`);
}
console.log('calibrationSummary:', JSON.stringify((agg.getState('btc') as any).calibrationSummary ?? 'none'));
