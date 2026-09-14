#!/usr/bin/env node
/**
 * P17b-buy-dip-edge-verify（2026-09-14, 主神「買 dip edge 驗證」——PLAN_buy-dip-edge E1-E6）:
 * 用 archive(v1-bak, 舊小數格式 —— 統一 ×100 讀取) 嚴格驗證「BUY 跌勢 WR 71%」:
 * per-symbol / 兩半 / 交互(sell 對照) / 極值剔除 / m4h 分界掃描 / type 分層。
 * ⚠️ Read-only。Usage: npx tsx scripts/p17b-buy-dip-edge-verify.ts
 */
import fs from 'node:fs';

const CYCLE_MS = 3 * 60 * 1000;
const COINS: Array<{ sym: string; hl: string }> = [
  { sym: 'btc', hl: 'BTC' }, { sym: 'bnb', hl: 'BNB' }, { sym: 'xyz:GOLD', hl: 'xyz:GOLD' }, { sym: 'xyz:SP500', hl: 'xyz:SP500' },
  { sym: 'xyz:SKHX', hl: 'xyz:SKHX' }, { sym: 'xyz:SNDK', hl: 'xyz:SNDK' }, { sym: 'xyz:DRAM', hl: 'xyz:DRAM' }, { sym: 'xyz:SILVER', hl: 'xyz:SILVER' },
];

async function candlesDays(hl: string, days: number) {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: hl, interval: '1h', startTime: Date.now() - days * 24 * 3600 * 1000, endTime: Date.now() } }),
  });
  const a = await r.json();
  if (!Array.isArray(a) || a.length < 6) return null;
  return a.map((c: any) => ({ t: Number(c.t), c: Number(c.c) })).sort((x: any, y: any) => x.t - y.t);
}

function m4hAt(candles: Array<{ t: number; c: number }>, timeMs: number): number | null {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) { if (candles[i]!.t + 3600_000 <= timeMs) idx = i; else break; }
  if (idx < 5) return null;
  return (candles[idx]!.c / candles[idx - 4]!.c - 1) * 100;
}

(async () => {
  // archive = v1-bak(小數, ×100) + 新(%, 直接)——用 v1-bak 做主(樣本多)
  const path = 'data/evolution/shadow-resolve-archive.v1-bak.jsonl';
  const lines = fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x): x is any => x !== null);
  const days = 5;
  const candleMap = new Map<string, Array<{ t: number; c: number }> | null>();
  for (const c of COINS) candleMap.set(c.sym, await candlesDays(c.hl, days));

  // 統一: 全部轉「%數值」語義
  const recs = lines.map((r: any) => ({ ...r, pnlPct: Math.abs(r.pnlPct ?? 0) > 5 ? r.pnlPct : r.pnlPct * (r.pnlPct !== null && Math.abs(r.pnlPct) < 1 ? 100 : 1) }))
    .filter((r: any) => typeof r.pnlPct === 'number' && Number.isFinite(r.pnlPct));

  // 重建 m4hAtOpen + 標記買跌勢樣本
  const buy: Array<{ sym: string; pnl: number; wr: boolean; m4h: number; t: number; type: string }> = [];
  const sell = { drop: [] as number[] };
  for (const r of recs) {
    if (r.side !== 'buy' && r.side !== 'sell') continue;
    const openedAt = typeof r.openedAt === 'number' ? r.openedAt : (r.resolvedAt - (r.holdCycles ?? 1) * CYCLE_MS);
    const candles = candleMap.get(r.symbol);
    if (!candles) continue;
    const m4h = m4hAt(candles, openedAt);
    if (m4h === null) continue;
    const e = { sym: (r.symbol.split(':').pop() ?? r.symbol).toUpperCase(), pnl: Number(r.pnlPct), wr: r.outcome === 'win', m4h, t: openedAt, type: r.shadowType ?? '?' };
    if (r.side === 'buy') buy.push(e);
    else if (m4h <= -0.5) sell.drop.push(Number(r.pnlPct));
  }

  const drop = buy.filter((b) => b.m4h <= -0.5);
  const stat = (arr: Array<{ pnl: number; wr: boolean }>) => ({
    n: arr.length,
    wr: arr.length ? Math.round((arr.filter((x) => x.wr).length / arr.length) * 100) : 0,
    avg: arr.length ? (arr.reduce((s, x) => s + x.pnl, 0) / arr.length).toFixed(2) : 'NaN',
  });

  console.log('═══ P17b 買 dip edge 驗證 (v1-bak 樣本, pnlPct=%數值) ═══');
  console.log(`\n[T1/T6] BUY 跌勢 桶 per-symbol (n≥3 先顯示):`);
  const bySym = new Map<string, Array<{ pnl: number; wr: boolean }>>();
  for (const d of drop) { const a = bySym.get(d.sym) ?? []; a.push(d); bySym.set(d.sym, a); }
  for (const [s, a] of [...bySym.entries()].sort((x, y) => y[1].length - x[1].length)) {
    const st = stat(a);
    console.log(`  ${s.padEnd(8)} n=${String(st.n).padEnd(4)} WR=${st.wr}%  avg=${st.avg}%`);
  }
  const maxShare = Math.max(...[...bySym.values()].map((a) => a.length / Math.max(drop.length, 1)));
  console.log(`  → 總 n=${drop.length}, 最大 symbol 佔比 ${(maxShare * 100).toFixed(0)}%`, maxShare > 0.5 ? '❌ F1' : '✅');

  console.log(`\n[T2] 兩半 (by openedAt):`);
  const sorted = [...drop].sort((a, b) => a.t - b.t);
  const half = Math.floor(sorted.length / 2);
  const h1 = stat(sorted.slice(0, half)), h2 = stat(sorted.slice(half));
  console.log(`  前半 n=${h1.n} WR=${h1.wr}% | 後半 n=${h2.n} WR=${h2.wr}% →`, h1.wr >= 55 && h2.wr >= 55 ? '✅' : '❌ F2');

  console.log(`\n[T3] 交互 (同跌勢桶 buy vs sell):`);
  const sellDrop = stat(sell.drop.map((p) => ({ pnl: p, wr: p > 0 })));
  console.log(`  BUY  n=${drop.length} WR=${stat(drop).wr}% avg=${stat(drop).avg}%`);
  console.log(`  SELL n=${sell.drop.length} WR=${sellDrop.wr}% avg=${sellDrop.avg}% → 方向×時機交互`, drop.length >= 10 && stat(drop).wr - sellDrop.wr >= 20 ? '✅' : '❌ F3');

  console.log(`\n[T4] 剔除極值 (|pnl|≥2):`);
  const clean = drop.filter((d) => Math.abs(d.pnl) < 2);
  const stClean = stat(clean);
  console.log(`  n=${stClean.n} WR=${stClean.wr}% avg=${stClean.avg}% →`, stClean.wr >= 55 ? '✅' : '❌ F4');

  console.log(`\n[T5] m4h 分界掃描 (BUY):`);
  for (const th of [0.2, 0.3, 0.5, 0.8]) {
    const sub = buy.filter((b) => b.m4h <= -th);
    const st = stat(sub);
    console.log(`  m4h≤−${th}%: n=${st.n} WR=${st.wr}% avg=${st.avg}%`);
  }

  console.log(`\n[T-type] BUY 跌勢 type 分層:`);
  const byType = new Map<string, Array<{ pnl: number; wr: boolean }>>();
  for (const d of drop) { const a = byType.get(d.type) ?? []; a.push(d); byType.set(d.type, a); }
  for (const [t, a] of byType) { const st = stat(a); console.log(`  ${t.padEnd(12)} n=${String(st.n).padEnd(4)} WR=${st.wr}% avg=${st.avg}%`); }
})();
