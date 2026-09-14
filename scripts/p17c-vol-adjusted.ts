#!/usr/bin/env node
/**
 * P17c-vol-adjusted（2026-09-14, 主神「symbol 效應解除?」——PLAN_vol-adjusted-timing E0-E4）:
 * 驗證「跌勢定義」由 raw m4h 改做 vol-standardized z-score（m4h / rolling24h σ）→
 * symbol 集中度會唔會下降 → pool 統計可合法。
 * ⚠️ Read-only（v1-bak 樣本 + HL candle）。Usage: npx tsx scripts/p17c-vol-adjusted.ts
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

/** rolling rolling σ(24 支 1h log-return std) @ idx */
function rollingSigma(candles: Array<{ t: number; c: number }>, idx: number, win = 24): number {
  const rets: number[] = [];
  for (let i = Math.max(1, idx - win + 1); i <= idx; i++) rets.push(Math.log(candles[i]!.c / candles[i - 1]!.c));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}

function m4hAt(candles: Array<{ t: number; c: number }>, timeMs: number): { m4h: number | null; z: number | null; sigma: number | null } {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) { if (candles[i]!.t + 3600_000 <= timeMs) idx = i; else break; }
  if (idx < 5) return { m4h: null, z: null, sigma: null };
  const m4h = (candles[idx]!.c / candles[idx - 4]!.c - 1) * 100;
  const sigma = rollingSigma(candles, idx);
  return { m4h, z: sigma > 0 ? m4h / sigma : null, sigma: sigma * 100 };
}

(async () => {
  const lines = fs.readFileSync('data/evolution/shadow-resolve-archive.v1-bak.jsonl', 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x): x is any => x !== null);
  const candleMap = new Map<string, Array<{ t: number; c: number }> | null>();
  for (const c of COINS) candleMap.set(c.sym, await candlesDays(c.hl, 8));

  // 統一 %數值 語義(pnlPct |x|<1 → ×100)
  const recs = lines.map((r: any) => ({ ...r, pnlPct: (r.pnlPct ?? 0) * (Math.abs(r.pnlPct ?? 0) < 1 ? 100 : 1) }));

  // 重建: buy + 跌勢(raw / z 兩種定義) + σ 對照
  interface E { sym: string; pnl: number; wr: boolean; t: number; m4h: number; z: number; type: string }
  const buy: E[] = [];
  const SIG: Record<string, number[]> = {};
  for (const r of recs) {
    if (r.side !== 'buy') continue;
    const openedAt = typeof r.openedAt === 'number' ? r.openedAt : (r.resolvedAt - (r.holdCycles ?? 1) * CYCLE_MS);
    const candles = candleMap.get(r.symbol);
    if (!candles) continue;
    const { m4h, z, sigma } = m4hAt(candles, openedAt);
    if (m4h === null || z === null) continue;
    (SIG[r.symbol.split(':').pop() ?? r.symbol] = SIG[r.symbol.split(':').pop() ?? r.symbol] ?? []).push(sigma as number);
    buy.push({ sym: (r.symbol.split(':').pop() ?? r.symbol).toUpperCase(), pnl: r.pnlPct, wr: r.outcome === 'win', t: openedAt, m4h, z, type: r.shadowType ?? '?' });
  }

  const stat = (arr: Array<{ pnl: number; wr: boolean }>) => ({
    n: arr.length, wr: arr.length ? Math.round((arr.filter((x) => x.wr).length / arr.length) * 100) : 0,
    avg: arr.length ? (arr.reduce((s, x) => s + x.pnl, 0) / arr.length).toFixed(2) : 'NaN',
  });

  console.log('═══ P17c vol-adjusted 時機驗證 ═══');
  console.log('\n[E0/T6] σ 可比性 (每 symbol 平均 hourly σ%):');
  for (const [s, arr] of Object.entries(SIG)) {
    const avgS = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`  ${s.padEnd(8)} σ=${avgS.toFixed(3)}%`);
  }
  const sVals = Object.values(SIG).map((a) => a.reduce((x, y) => x + y, 0) / a.length);
  console.log(`  → max/min = ${(Math.max(...sVals) / Math.min(...sVals)).toFixed(0)}×`, Math.max(...sVals) / Math.min(...sVals) >= 5 ? '✅ T6(σ 幾倍差異,唔 standardize 真係唔可比)' : '⚠️ σ 差異細');

  console.log('\n[E1/T1+T5] BUY 跌勢桶 symbol 集中度 — raw(m4h≤−0.5%) vs z(z≤−1.5):');
  const bySym = (arr: E[]) => { const m = new Map<string, number>(); for (const e of arr) m.set(e.sym, (m.get(e.sym) ?? 0) + 1); return m; };
  const rawDrop = buy.filter((b) => b.m4h <= -0.5);
  const zDrop = buy.filter((b) => b.z <= -1.5);
  for (const [label, arr] of [['raw(m4h≤−0.5%)', rawDrop], ['z(z≤−1.5σ)', zDrop]] as const) {
    const m = bySym(arr);
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const maxShare = (sorted[0]?.[1] ?? 0) / Math.max(arr.length, 1);
    const share = sorted.map(([s, n]) => `${s}:${n}`).join(' ');
    console.log(`  ${label.padEnd(16)} n=${String(arr.length).padEnd(4)} 集中度=${(maxShare * 100).toFixed(0)}%  [${share}]`);
    console.log(`     → max share ${(maxShare * 100).toFixed(0)}%`, maxShare < 0.65 ? '✅ T1' : '❌ 仍集中');
  }

  console.log('\n[E2/T2+T3] z-跌勢 BUY pool WR + 兩半:');
  const zs = stat(zDrop);
  const zsSorted = [...zDrop].sort((a, b) => a.t - b.t);
  const half = Math.floor(zsSorted.length / 2);
  const h1 = stat(zsSorted.slice(0, half)), h2 = stat(zsSorted.slice(half));
  console.log(`  z-跌勢 n=${zs.n} WR=${zs.wr}% avg=${zs.avg}% | 前半 n=${h1.n} WR=${h1.wr}% / 後半 n=${h2.n} WR=${h2.wr}%`);

  console.log('\n[E3/T4] z threshold 掃描 (BUY):');
  for (const th of [1.0, 1.5, 2.0, 2.5]) {
    const sub = buy.filter((b) => b.z <= -th);
    const st = stat(sub);
    console.log(`  z≤−${th.toFixed(1)}σ: n=${st.n} WR=${st.wr}% avg=${st.avg}%`);
  }

  console.log('\n[E4] z-跌勢 type 分層:');
  const byType = new Map<string, Array<{ pnl: number; wr: boolean }>>();
  for (const d of zDrop) { const a = byType.get(d.type) ?? []; a.push(d); byType.set(d.type, a); }
  for (const [t, a] of byType) { const st = stat(a); console.log(`  ${t.padEnd(12)} n=${String(st.n).padEnd(4)} WR=${st.wr}% avg=${st.avg}%`); }
})();
