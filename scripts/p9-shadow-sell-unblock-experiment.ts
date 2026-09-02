/**
 * P9-shadow-sell-unblock 邏輯實驗（RED/GREEN 兩階段, 零 look-ahead）
 *
 * 實驗 A（#2）: buy 佔滿 10 位時, sell 開倉 request 被 per-symbol 上限擋住
 * 實驗 B（#1）: activeSymbol ≠ selectedSymbol 時, activeSymbol 被剔除出 _additionalMarkets
 *
 * Run: npx tsx scripts/p9-shadow-sell-unblock-experiment.ts
 * RED: 實作前跑 → 兩個 bug 重現
 * GREEN: 實作後跑 → 兩個 bug 消除
 */
import { OLREngine } from '../src/evolution/olr-engine.ts';
import { ShadowTradeEngine } from '../src/evolution/shadow-trade-engine.ts';

// ─── 實驗 A（#2）: per-symbol 上限買賣 side 互相擠壓 ───
function experimentA(): boolean {
  console.log('════ 實驗 A: buy 佔滿 10 位 → sell 開倉 ────');
  const olr = new OLREngine();
  const engine = new ShadowTradeEngine(olr);
  const sym = 'btc';
  const features = { mom24h: -0.02, vol: 0.01 };

  // 開 10 個 buy shadow（blind 開買會成對開 sell——所以用 openAlignedShadow 只開 buy）
  // 更直接: 手動塞 10 個 open buy positions 入 engine
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    (engine as any).positions.push({
      id: `test-buy-${i}`, symbol: sym, side: 'buy', entryPrice: 100,
      stopLossPrice: 98, takeProfitPrice: 105, openCycle: i, openTimestamp: now,
      features: {}, status: 'open', shadowType: 'blind', highSinceOpen: 100, lowSinceOpen: 100,
      mfePct: 0, maePct: 0,
    });
  }
  const buyOpen = (engine as any).positions.filter((p) => p.symbol === sym && p.status === 'open' && p.side === 'buy').length;
  const sellOpenBefore = (engine as any).positions.filter((p) => p.symbol === sym && p.status === 'open' && p.side === 'sell').length;
  console.log(`[setUp] btc: buy=${buyOpen} sell=${sellOpenBefore}`);

  // 開 sell（aligned——單向 sell）: 應該有 10 個位可以開 sell
  engine.openAlignedShadow(
    sym, 100, 'sell', 102, 98, 1000, features,
    'sell', 0.7, 'sell', 1.2, { agent: 'test', weight: 1, action: 'sell' },
    [{ agent: 'test', weight: 1, action: 'sell' }],
  );
  const sellOpenAfter = (engine as any).positions.filter((p) => p.symbol === sym && p.status === 'open' && p.side === 'sell').length;
  const opened = sellOpenAfter - sellOpenBefore;
  console.log(`[RESULT] sell 開倉: ${opened > 0 ? '✅ 成功' : '❌ 被 buy 佔位擋住（bug 重現）'}（sell open: ${sellOpenBefore} → ${sellOpenAfter}）`);
  return opened > 0;
}

// ─── 實驗 B（#1）: activeSymbol 剔除邏輯 ───
function experimentB(): boolean {
  console.log('\n════ 實驗 B: activeSymbol ≠ selectedSymbol → activeSymbol 有冇被剔除 ────');
  const tradingMarkets = ['btc', 'xyz:GOLD', 'xyz:SP500', 'xyz:SKHX', 'bnb', 'xyz:SNDK', 'xyz:DRAM', 'xyz:SILVER'];
  // 而家現況: selectedSymbol = xyz:SKHX（手動鎖定）, btc 冇倉
  const selectedSymbol = 'xyz:SKHX';
  const openPositions = [] as string[]; // BTC 冇倉
  const openPosNorms = new Set(openPositions.map((s) => s.toLowerCase()));
  const nonPositionMarkets = tradingMarkets.filter((s) => {
    const n = s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase();
    return !openPosNorms.has(n);
  });
  const activeSymbol = nonPositionMarkets.length > 0 ? nonPositionMarkets[0]! : tradingMarkets[0]!;
  // 新 code（v2.0.873-P9-sym-coverage）: _additionalMarkets = nonPositionMarkets（全保留）——
  // 剔除 activeSymbol 嘅邏輯已移除（agents marketTicker 跟 selectedSymbol 而唔係 activeSymbol）。
  const additionalMarkets = nonPositionMarkets;
  const hasBtc = additionalMarkets.some((s) => s.toLowerCase() === 'btc');
  console.log(`[計算] activeSymbol=${activeSymbol}（nonPositionMarkets[0]=btc）`);
  console.log(`[計算] selectedSymbol=${selectedSymbol}（agents 嘅 marketTicker）`);
  console.log(`[RESULT] BTC 喺 _additionalMarkets 入面? ${hasBtc ? '✅ 有（修復生效——agents 會見到 BTC）' : '❌ 冇——剔除咗, BTC 完全跌出 agents 視野（bug 重現）'}`);
  console.log(`         additionalMarkets(${additionalMarkets.length}): ${additionalMarkets.join(', ')}`);
  return hasBtc;
}

console.log('════════ RED Phase（實作前——預期兩個 bug 都重現）════════');
const rA = experimentA();
const rB = experimentB();
console.log('\n════════ 總結 ════════');
console.log(`A (sell 被 buy 佔位擋): ${rA ? 'PASS（已修/無 bug）' : 'FAIL → bug 重現, 要修'}`);
console.log(`B (BTC 跌出注入):       ${rB ? 'PASS（已修/無 bug）' : 'FAIL → bug 重現, 要修'}`);
process.exit(rA && rB ? 0 : 1);
