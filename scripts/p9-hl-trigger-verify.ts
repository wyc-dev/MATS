// ─── 驗證: HL trigger 對 xyz 資產真實放設狀態（只讀, 唔下單）───
// PLAN_5b-hl-trigger-verify.md Q1/Q2
// call HL openOrders（主 DEX + xyz DEX）→ 對比本地 mirror SL/TP。
// 零 mutation——純查詢。

import 'dotenv/config';
import fs from 'node:fs';

const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const wallet = process.env['HYPERLIQUID_WALLET_ADDRESS'];
if (!wallet) { console.log('❌ No HYPERLIQUID_WALLET_ADDRESS in .env'); process.exit(0); }
console.log('Wallet:', wallet.slice(0, 6) + '...' + wallet.slice(-4));

async function info(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info ${body['type']}: HTTP ${res.status}`);
  return res.json();
}

async function main(): Promise<void> {
  // 1. Live positions（clearinghouseState — 主 DEX）
  let chs: any = null;
  try { chs = await info({ type: 'clearinghouseState', user: wallet }); } catch (e: any) { console.log('⚠️ clearinghouseState fail:', e.message); }

  // 2. Open orders —— 主 DEX
  let mainOrders: any[] = [];
  try { mainOrders = await info({ type: 'openOrders', user: wallet }); } catch (e: any) { console.log('⚠️ openOrders(main) fail:', e.message); }

  // 3. Open orders —— xyz DEX
  let xyzOrders: any[] = [];
  try { xyzOrders = await info({ type: 'openOrders', user: wallet, dex: 'xyz' }); } catch (e: any) { console.log('⚠️ openOrders(xyz) fail:', e.message); }

  // 4. Meta（coin 名稱格式對比）
  let metaMain: any = null, metaXyz: any = null;
  try {
    const m0 = await info({ type: 'meta' });
    metaMain = m0.universe?.map((u: any) => u.name) ?? [];
  } catch {}
  try {
    const mx = await info({ type: 'meta', dex: 'xyz' });
    metaXyz = mx.universe?.map((u: any) => u.name) ?? [];
  } catch {}

  console.log('\n=== LIVE POSITIONS（clearinghouseState）===\n');
  if (chs?.assetPositions) {
    for (const ap of chs.assetPositions) {
      const p = ap.position;
      console.log(`  ${p.coin}: side=${p.side} size=${p.size} entry=${p.entryPx} liq=${p.liquidationPx} unrealized=${p.unrealizedPnl}`);
    }
  } else {
    console.log('  (none / empty)');
  }

  console.log('\n=== OPEN ORDERS — 主 DEX ===\n');
  if (mainOrders.length === 0) console.log('  (no open orders)');
  for (const o of mainOrders) {
    const trigger = o.orderType?.trigger;
    console.log(`  ${o.coin} side=${o.side} sz=${o.sz} oid=${o.oid} reduceOnly=${o.reduceOnly} limitPx=${o.limitPx}` + (trigger ? ` TRIGGER=${trigger.tpsl} triggerPx=${trigger.triggerPx} isMarket=${trigger.isMarket}` : ''));
  }

  console.log('\n=== OPEN ORDERS — xyz DEX ===\n');
  if (xyzOrders.length === 0) console.log('  (no open orders)');
  for (const o of xyzOrders) {
    const trigger = o.orderType?.trigger;
    console.log(`  ${o.coin} side=${o.side} sz=${o.sz} oid=${o.oid} reduceOnly=${o.reduceOnly} limitPx=${o.limitPx}` + (trigger ? ` TRIGGER=${trigger.tpsl} triggerPx=${trigger.triggerPx} isMarket=${trigger.isMarket}` : ''));
  }

  console.log('\n=== META COIN NAME 對比 ===\n');
  // 搵 live positions 嘅 coin 喺邊個 meta
  const liveCoins = new Set<string>();
  if (chs?.assetPositions) for (const ap of chs.assetPositions) liveCoins.add(String(ap.position.coin));
  for (const c of liveCoins) {
    const inMain = metaMain?.includes(c);
    const inXyz = metaXyz?.includes(c);
    console.log(`  ${c}: inMainMeta=${inMain === true}, inXyzMeta=${inXyz === true}`);
  }

  console.log('\n=== 本地 mirror 對比（portfolio-state.json）===\n');
  const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
  const realPos = state.realPositions ?? [];
  for (const p of realPos) {
    console.log(`  LOCAL ${p.symbol}: SL=${p.stopLossPrice} TP=${p.takeProfitPrice} entry=${p.entryPrice} lev=${p.leverage} current=${p.currentPrice}`);
  }
}

main().catch((e) => { console.log('FATAL:', e); process.exit(1); });
