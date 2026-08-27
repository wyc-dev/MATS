/** P8-persistence 重放:persistence 分類(entry 時點)× side × PnL 交叉審計 */
import fs from 'node:fs';
import { computePersistenceScore, classifyPersistence } from '../src/analysis/momentum-persistence.ts';
import { MarketAgent } from '../src/market-agent/index.ts';

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const T: any[] = (state.realTrades ?? []).filter((t: any) => t.closedAt).sort((a, b) => a.closedAt - b.closedAt);
const syms: string[] = [...new Set(T.map((t: any) => t.symbol))];
const minOpen = Math.min(...T.map((t: any) => t.openedAt)) - 3600000;

async function fetchC(coin: string, interval: string, s: number, e: number): Promise<any[]> {
  for (const n of [coin.includes(':') ? coin : `xyz:${coin}`, coin.includes(':') ? coin.replace('xyz:', '') : coin.toUpperCase()]) {
    try {
      const d = await MarketAgent.hlFetch({ type: 'candleSnapshot', req: { coin: n, interval, startTime: s, endTime: e } });
      if (Array.isArray(d) && d.length) return d;
    } catch { /* next */ }
  }
  return [];
}
const cache = new Map<string, any[]>();
for (const s of syms) {
  const c = await fetchC(s, '1h', minOpen - 96 * 3600000, Date.now());
  cache.set(s, c);
}
console.log(`candles: ${[...cache.values()].reduce((a, c) => a + c.length, 0)} 支`);

function persistenceAt(t: any): { score: number; cls: string } | null {
  const before = (cache.get(t.symbol) ?? []).filter((c: any) => c.t <= t.openedAt).slice(-40);
  if (before.length < 29) return null;
  const closes = before.map((c: any) => Number(c.c)).filter((v) => Number.isFinite(v) && v > 0);
  if (closes.length < 29) return null;
  const pr = computePersistenceScore(closes);
  if (!pr) return null;
  return { score: pr.score, cls: classifyPersistence(pr.score, pr.n) };
}

const grid: Record<string, { n: number; sum: number; wins: number }> = {};
const dbg: string[] = [];
let baseline = 0, simSoft = 0;
for (const t of T) {
  const actual = t.pnlPct * 100;
  baseline += actual;
  const p = persistenceAt(t);
  if (!p) {
    const k = `nodata`;
    grid[k] = grid[k] ?? { n: 0, sum: 0, wins: 0 };
    grid[k].n++; grid[k].sum += actual;
    if (dbg.length < 4) dbg.push(`${t.symbol} cache=${(cache.get(t.symbol) ?? []).length}`);
    simSoft += actual;
    continue;
  }
  const key = `${p.cls}|${t.side}`;
  grid[key] = grid[key] ?? { n: 0, sum: 0, wins: 0 };
  grid[key].n++; grid[key].sum += actual; if (t.pnlPct > 0) grid[key].wins++;
  // 軟權重模擬:PB+BUY 唔 block → ×0.6
  if (p.cls === 'persistent_bear' && t.side === 'buy') simSoft += actual * 0.6;
  else simSoft += actual;
}
console.log(`\n=== persistence × side × PnL(${T.length} 喺)== =`);
console.log('分類                 n    sum(pp)   WR');
for (const [k, v] of Object.entries(grid).sort((a, b) => b[1].sum - a[1].sum)) {
  console.log(`${k.padEnd(22)} ${String(v.n).padStart(3)}  ${v.sum >= 0 ? '+' : ''}${v.sum.toFixed(1).padStart(7)}  ${(v.wins / Math.max(1, v.n) * 100).toFixed(0)}%${k === 'nodata' ? '  [' + dbg.join(' | ') + ']' : ''}`);
}
const pbBuy = T.filter((t: any) => persistenceAt(t)?.cls === 'persistent_bear' && t.side === 'buy');
console.log(`\n=== F1 persistent_bear+BUY 反事實 ===`);
console.log(`歷史 PB+BUY 喺: ${pbBuy.length} 喺, 實際 PnL ${pbBuy.reduce((s, t) => s + t.pnlPct * 100, 0).toFixed(1)}pp`);
console.log(`基線: ${base(T)}pp | 軟權重模擬(×0.6): ${simSoft >= 0 ? '+' : ''}${simSoft.toFixed(1)}pp`);
function base(a: any[]) { return a.reduce((s, t) => s + t.pnlPct * 100, 0); }
