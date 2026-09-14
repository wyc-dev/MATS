#!/usr/bin/env node
/**
 * P17-shadow-entry-timing（2026-09-13, 主神「深挖 sell/buy shadow 時機——追跌尾 root cause」）:
 * 重建每筆 shadow 開倉時刻嘅 4h 動量(m4hAtOpen),分桶對照結果——
 * 驗證「sell 追跌尾 = 負 EV」「buy 買 dip vs 追升」時機分野。
 *
 * ⚠️ Read-only(recentResults + HL candle)。Usage: npx tsx scripts/p17-shadow-entry-timing.ts
 * 單位: recentResults.pnlPct = 百分比數值(2.0 = +2%)。
 */
import fs from 'node:fs';

const CYCLE_MS = 3 * 60 * 1000; // cyclePeriodMinutes = 3
const COINS: Array<{ sym: string; hl: string }> = [
  { sym: 'btc', hl: 'BTC' }, { sym: 'bnb', hl: 'BNB' },
  { sym: 'xyz:GOLD', hl: 'xyz:GOLD' }, { sym: 'xyz:SP500', hl: 'xyz:SP500' },
  { sym: 'xyz:SKHX', hl: 'xyz:SKHX' }, { sym: 'xyz:SNDK', hl: 'xyz:SNDK' },
  { sym: 'xyz:DRAM', hl: 'xyz:DRAM' }, { sym: 'xyz:SILVER', hl: 'xyz:SILVER' },
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

/** m4h @ timeMs = 嗰個時刻前最後一支 completed 1h 嘅 close vs 5 支前 close */
function m4hAt(candles: Array<{ t: number; c: number }>, timeMs: number): number | null {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) { if (candles[i]!.t + 3600_000 <= timeMs) idx = i; else break; }
  if (idx < 5) return null;
  return (candles[idx]!.c / candles[idx - 4]!.c - 1) * 100;
}

(async () => {
  const s = JSON.parse(fs.readFileSync('data/evolution/shadow-state.json', 'utf-8'));
  const rr: Array<any> = s.recentResults ?? [];
  // v2.0.885: archive 優先（精確 openedAt）——fallback recentResults（holdCycles×180s 估算）
  const archivePath = 'data/evolution/shadow-resolve-archive.jsonl';
  let recs: Array<any> = rr;
  try {
    if (fs.existsSync(archivePath)) {
      const parsed = fs.readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x): x is any => x !== null && typeof x.openedAt === 'number');
      if (parsed.length >= 10) recs = parsed; // archive 未有料→fallback
    }
  } catch { /* fallback */ }
  // E0b: 樣本覆蓋時長
  const ts = recs.filter((r) => typeof r.resolvedAt === 'number').map((r) => r.resolvedAt);
  const min = Math.min(...ts), max = Math.max(...ts);
  const spanH = (max - min) / 3600_000;
  console.log(`═══ P17 shadow-entry-timing ═══\n[n=${recs.length} 樣本跨時 ${spanH.toFixed(1)}h (${new Date(min).toISOString().slice(0, 16)} ~ ${new Date(max).toISOString().slice(0, 16)})]`);

  // fetch candles(樣本跨時決定 fetch 長度)
  const days = Math.max(4, Math.ceil(spanH / 24) + 1);
  const candleMap = new Map<string, Array<{ t: number; c: number }> | null>();
  for (const c of COINS) candleMap.set(c.sym, await candlesDays(c.hl, days));

  // 重建 m4hAtOpen + 分桶
  type Bucket = { n: number; sum: number; w: number; byType: Record<string, { n: number; sum: number }> };
  const mk = (): Bucket => ({ n: 0, sum: 0, w: 0, byType: {} });
  const buckets: Record<string, Record<string, Bucket>> = { sell: { drop: mk(), flat: mk(), rise: mk() }, buy: { drop: mk(), flat: mk(), rise: mk() } };

  let rebuilt = 0;
  for (const r of recs) {
    if (r.side !== 'sell' && r.side !== 'buy') continue;
    if (typeof r.resolvedAt !== 'number') continue;
    if (typeof r.pnlPct !== 'number' || !Number.isFinite(r.pnlPct)) continue;
    // v2.0.885: openedAt 精確（archive）優先;fallback 估算(resolvedAt − holdCycles×180s)
    const openedAt = typeof r.openedAt === 'number' ? r.openedAt : (typeof r.holdCycles === 'number' ? r.resolvedAt - r.holdCycles * CYCLE_MS : NaN);
    if (!Number.isFinite(openedAt)) continue;
    const candles = candleMap.get(r.symbol);
    if (!candles) continue;
    const m4h = m4hAt(candles, openedAt);
    if (m4h === null) continue;
    rebuilt++;
    const bucket = m4h <= -0.5 ? 'drop' : m4h >= 0.5 ? 'rise' : 'flat';
    const B = buckets[r.side]![bucket]!;
    B.n++; B.sum += r.pnlPct; if (r.outcome === 'win') B.w++;
    B.byType[r.shadowType ?? '?'] = B.byType[r.shadowType ?? '?'] ?? { n: 0, sum: 0 };
    B.byType[r.shadowType ?? '?']!.n++; B.byType[r.shadowType ?? '?']!.sum += r.pnlPct;
  }

  console.log(`\n[重建開倉時刻 m4h]: ${rebuilt}/${recs.length} 筆\n`);
  const fmt = (side: string) => {
    console.log(`── ${side.toUpperCase()} ──`);
    for (const [b, label] of [['drop', '跌勢 m4h≤−0.5%'], ['flat', '橫行 ±0.5%'], ['rise', '升勢 m4h≥+0.5%']] as const) {
      const B = buckets[side]![b]!;
      if (B.n === 0) { console.log(`  ${label.padEnd(18)} n=0`); continue; }
      const typeStr = Object.entries(B.byType).map(([t, v]) => `${t}:${v.n}(avg${(v.sum / v.n).toFixed(2)}%)`).join(' ');
      console.log(`  ${label.padEnd(18)} n=${String(B.n).padEnd(4)} avg=${(B.sum / B.n).toFixed(2).padStart(7)}%  WR=${Math.round((B.w / B.n) * 100)}%  [${typeStr}]`);
    }
  };
  fmt('sell');
  fmt('buy');

  console.log(`\n[判定] 每桶 n≥10 先算數;跌勢 vs 升勢 avg 差 ≥0.5pp + WR 差 ≥10pp 先算 PASS`);
})();
