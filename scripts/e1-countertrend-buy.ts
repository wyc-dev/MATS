/**
 * e1-countertrend-buy.ts — E1 full sample: 逆勢 BUY 接刀結構驗證 + F1 counterfactual
 *
 * 發現（PLAN_recent-losses.md §0）: 近 14 日 33 大蝕單中 25 係 BUY（76%）——
 * thesis 96% 聲稱 bullish，但 subset 明確「4h momentum<0 仍開 BUY」（接刀）:
 *   SKHX「4h -0.74% but mean-reverting expecting bounce」-7.6%
 *   DRAM「4h -0.31% but OLR favors BUY」-14.6%
 *   DRAM「4h -3.47% oversold supports bounce」-4.3%
 *
 * F1（v2.0.870-momentum-direction）現況: 逆勢 ×0.70-0.85 shrink（唔 block）;
 * |24h 動量|≥8% 先 HARD BLOCK。4h 負但 <8% → 只 shrink——接刀單照開。
 *
 * 實驗（831 全樣本零 look-ahead——HL 4h/1h candle 開倉前最後已 close 支）:
 *   E1a: 全樣本 357 單分組「開倉時 4h momentum sign」× side → pnl/WR/大蝕率
 *   E1b: counterfactual——「4h<0 而 BUY」嘅單如果唔開, 系統損益變化（Δ）
 *   E1c: 三關——兩半 / 剔 outlier / 敏感性 threshold
 */
import * as fs from 'fs';

const pf = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const trades = (pf.realTrades || []).slice().sort((a: any, b: any) => (a.openedAt || 0) - (b.openedAt || 0));

const LEV_INFO: Record<string, number> = {};
// 由 trade 記錄攞 leverage（per symbol 取眾數）
for (const t of trades) {
  const k = String(t.symbol).toLowerCase();
  if (Number.isFinite(t.leverage)) LEV_INFO[k] = t.leverage;
}

const cache = new Map<string, any[]>();
async function getCandles(coin: string, iv: string, startTs: number, endTs: number) {
  const key = `${coin}|${iv}|${startTs}|${endTs}`;
  if (cache.has(key)) return cache.get(key)!;
  const raw = coin.includes(':') ? coin : `xyz:${coin}`;
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: raw, interval: iv, startTime: startTs, endTime: endTs } }),
    });
    const j = await r.json();
    const arr = Array.isArray(j) && j.length ? j.sort((a: any, b: any) => a.t - b.t) : null;
    cache.set(key, arr);
    return arr;
  } catch { return null; }
}

/** 開倉時 4h/1h momentum（零 look-ahead——最後一支已 close 嘅 candle） */
async function momentumAtOpen(trade: any) {
  const openTs = trade.openedAt;
  const sym = trade.symbol;
  const out: Record<string, number> = {};
  for (const iv of ['4h', '1h'] as const) {
    const n = iv === '4h' ? 20 : 25; // 4h 攞 20 支（80h）/ 1h 攞 25 支
    const candles = await getCandles(sym, iv, openTs - n * (iv === '4h' ? 4 : 1) * 3600_000, openTs + 300_000);
    if (!candles || candles.length < 4) { out[iv] = 0; continue; }
    // 只可以用「已 close」支（c.t + interval <= openTs）——剔除 in-progress
    const closed = candles.filter((c: any) => c.t + (iv === '4h' ? 4 : 1) * 3600_000 <= openTs + 60_000);
    if (closed.length < 3) { out[iv] = 0; continue; }
    const last = closed[closed.length - 1];
    const prev = closed.find((c: any) => c.t <= last.t - 5 * (iv === '4h' ? 4 : 1) * 3600_000) || closed[0];
    out[iv] = last.c > 0 && prev.c > 0 ? (last.c - prev.c) / prev.c : 0;
  }
  return out;
}

const stat = (arr: any[], label: string) => {
  if (!arr.length) { console.log(`  ${label}: n=0`); return null; }
  const sum = arr.reduce((s, t) => s + (t.pnlPct || 0), 0);
  const wins = arr.filter((t) => (t.pnlPct || 0) > 0).length;
  const big = arr.filter((t) => (t.pnlPct || 0) < -0.04).length;
  console.log(`  ${label}: n=${arr.length} Σ=${(sum * 100).toFixed(1)}% WR=${(wins / arr.length * 100).toFixed(0)}% 大蝕(<-4%)=${big}(${(big / arr.length * 100).toFixed(0)}%) avg=${(sum / arr.length * 100).toFixed(2)}%`);
  return { sum, n: arr.length, wins };
};

(async () => {
  const T0 = Date.parse('2026-08-21T00:00:00+08:00');
  const sample = trades.filter((t: any) => t.openedAt >= T0 && Number.isFinite(t.pnlPct));
  console.log(`全樣本（08-21 起）: ${sample.length} 單\n`);

  // 每單: 開倉時 4h/1h momentum
  const enriched = [];
  for (let i = 0; i < sample.length; i++) {
    const t = sample[i];
    const mom = await momentumAtOpen(t);
    enriched.push({ ...t, mom4h: mom['4h'], mom1h: mom['1h'] });
    if ((i + 1) % 50 === 0) console.log(`  ...enriched ${i + 1}/${sample.length}`);
  }
  fs.writeFileSync('/tmp/e1-enriched.json', JSON.stringify(enriched));

  console.log('\n════════ E1a: 開倉時 4h momentum × side ════════');
  const groups: Record<string, any[]> = {
    'BUY 4h<0': enriched.filter((t: any) => t.side !== 'sell' && t.mom4h < 0),
    'BUY 4h≥0': enriched.filter((t: any) => t.side !== 'sell' && t.mom4h >= 0),
    'SELL 4h>0': enriched.filter((t: any) => t.side === 'sell' && t.mom4h > 0),
    'SELL 4h≤0': enriched.filter((t: any) => t.side === 'sell' && t.mom4h <= 0),
  };
  for (const [k, v] of Object.entries(groups)) stat(v, k);

  console.log('\n════════ E1b: counterfactual——「BUY 4h<0」block ════════');
  const buyDown = enriched.filter((t: any) => t.side !== 'sell' && t.mom4h < 0 && t.mom4h > -0.20); // 4h 負但 reasonable
  stat(buyDown, '被 block 組（BUY 4h<0）counterfactual');
  const delta = buyDown.reduce((s, t) => s - (t.pnlPct || 0), 0); // block = 唔再有呢啲單嘅 pnl
  console.log(`  → 若 block: 系統 Δ = ${(delta * 100).toFixed(1)}% margin（呢啲單原本 Σ=${(-(buyDown.reduce((s, t) => s + (t.pnlPct || 0), 0)) * 100).toFixed(1)}%）`);
  // 誤傷評估: 被 block 組入面有幾多係贏單
  const winsBlocked = buyDown.filter((t: any) => (t.pnlPct || 0) > 0);
  console.log(`  誤傷: 贏單 ${winsBlocked.length}/${buyDown.length} Σ=${(winsBlocked.reduce((s, t) => s + (t.pnlPct || 0), 0) * 100).toFixed(1)}% (誤傷代價)`);
  const netGain = buyDown.reduce((s, t) => s - (t.pnlPct || 0), 0) + winsBlocked.reduce((s, t) => s + (t.pnlPct || 0), 0);
  console.log(`  淨成效（避免損失 − 誤傷代價）= ${(netGain * 100).toFixed(1)}% margin`);

  console.log('\n════════ E1c-三關 ────────────');
  // 兩半
  buyDown.sort((a: any, b: any) => a.openedAt - b.openedAt);
  const half = Math.floor(buyDown.length / 2);
  const h1 = buyDown.slice(0, half), h2 = buyDown.slice(half);
  console.log('兩半（被 block 組自身）:');
  stat(h1.map((t: any) => ({ ...t, pnlPct: -t.pnlPct })), '前半 (block 節省)');
  stat(h2.map((t: any) => ({ ...t, pnlPct: -t.pnlPct })), '後半 (block 節省)');
  // 剔 outlier
  const noOut = buyDown.filter((t: any) => Math.abs(t.pnlPct) < 0.15);
  stat(noOut.map((t: any) => ({ ...t, pnlPct: -t.pnlPct })), '剔 outlier (block 節省)');
  // 敏感性
  console.log('\n敏感性（threshold sweep）:');
  for (const th of [-0.05, -0.02, 0, 0.01, 0.02]) {
    const sub = enriched.filter((t: any) => t.side !== 'sell' && t.mom4h < th);
    const s = sub.reduce((a, t) => a + (t.pnlPct || 0), 0);
    const w = sub.filter((t: any) => (t.pnlPct || 0) > 0).length;
    console.log(`  BUY 4h<${(th * 100).toFixed(0)}%: n=${sub.length} Σ=${(s * 100).toFixed(1)}% WR=${(w / sub.length * 100).toFixed(0)}% → block Δ=${(-s * 100).toFixed(1)}%`);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
