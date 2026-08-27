/**
 * P8-persist-v2 重放:decayed 雙向 persistence（decay 24h + cutoff 24h）
 * vs 現行（120h 等權 + PB 硬閘）——歷史反事實。
 *
 * 軟權重規則（主神:權重唔決定）:
 *   順勢（persistent_bear+SELL / persistent_bull+BUY）→ ×1.1
 *   逆勢 PB → ×0.5（原 HARD BLOCK 廢除）
 *   neutral/range → ×1.0
 * 對照組:現行硬閘（PB+逆勢 → 唔發生）
 */
import fs from 'node:fs';
import { MarketAgent } from '../src/market-agent/index.ts';

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const T: any[] = (state.realTrades ?? []).filter((t: any) => t.closedAt).sort((a, b) => a.closedAt - b.closedAt);
const syms: string[] = [...new Set(T.map((t: any) => t.symbol))];
const minOpen = Math.min(...T.map((t: any) => t.openedAt)) - 3600000;

async function fc(coin: string): Promise<any[]> {
  for (const n of [coin.includes(':') ? coin : `xyz:${coin}`, coin.includes(':') ? coin.replace('xyz:', '') : coin.toUpperCase()]) {
    try { const r = await MarketAgent.hlFetch({type:"candleSnapshot",req:{coin:n,interval:"1h",startTime:minOpen-120*3600000,endTime:Date.now()}}); if(Array.isArray(r)&&r.length) return r; } catch {}
  }
  return [];
}
const cache = new Map<string, any[]>();
for (const s of syms) { const c = await fc(s); cache.set(s, c); console.log(`${s}: ${c.length}`); }

// ── decayed dual persistence（照抄生產修復將用嘅語義）──
interface Dual { score: number; bullScore: number; n: number }
function dualPersistence(candles: any[], now: number, lookback = 24, forward = 4, decayH = 24, cutoffH = 24): Dual | null {
  const cs = candles.map(c => ({ t: Number(c.t), c: Number(c.c) }))
    .filter(x => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0)
    .sort((a, b) => a.t - b.t);
  if (cs.length < lookback + forward + 1) return null;
  const tau = decayH * 3600000, cut = cutoffH * 3600000;
  let down = 0, dn = 0, up = 0, upn = 0;
  for (let i = lookback; i < cs.length - forward; i++) {
    const mom = ((cs[i].c - cs[i - lookback].c) / cs[i - lookback].c) * 100;
    if (mom >= 0) continue; // 只有跌市時刻
    // v2: decay by 證據年齡(評分時點 cs[i+forward] 距 now)+ hard cutoff
    const tEv = cs[i + forward].t;
    const age = now - tEv;
    if (age > cut) continue; // hard cutoff
    const w = Math.exp(-age / tau);
    const fwd = ((cs[i + forward].c - cs[i].c) / cs[i].c) * 100;
    if (fwd < 0) down += w; dn += w;
  }
  if (dn < 5) return null;
  const score = down / dn;
  // bull mirror:升市時刻續升比例
  for (let i = lookback; i < cs.length - forward; i++) {
    const mom = ((cs[i].c - cs[i - lookback].c) / cs[i - lookback].c) * 100;
    if (mom <= 0) continue;
    const age = now - cs[i + forward].t;
    if (age > cut) continue;
    const w = Math.exp(-(now - cs[i + forward].t) / tau);
    const fwd = ((cs[i + forward].c - cs[i].c) / cs[i].c) * 100;
    if (fwd > 0) up += w; upn += w;
  }
  const bullScore = upn > 0 ? up / upn : 0;
  return { score, bullScore };
}
function classifyV2(d: Dual | null): { cls: string; aligned: (side: string) => boolean } {
  if (!d) return { cls: 'nodata', aligned: () => false };
  if (d.score >= 0.55) return { cls: 'persistent_bear', aligned: (s) => s === 'sell' };
  if (d.bullScore >= 0.55) return { cls: 'persistent_bull', aligned: (s) => s === 'buy' };
  return { cls: 'range/neutral', aligned: () => false };
}

// ── 逐單模擬 ──
const grid: Record<string, { n: number; sum: number; wins: number }> = {};
let baseline = 0, simHard = 0, simSoft = 0;
const now = Date.now();
for (const t of T) {
  const actual = t.pnlPct * 100;
  baseline += actual;
  const before = (cache.get(t.symbol) ?? []).filter((c: any) => c.t <= t.openedAt);
  const d2 = dualPersistence(before, t.openedAt); // 決策時點嘅 now = openedAt
  const { cls, aligned } = classifyV2(d2);
  const k = `${cls}|${t.side}`;
  grid[k] = grid[k] ?? { n: 0, sum: 0, wins: 0 };
  grid[k].n++; grid[k].sum += actual; if (t.pnlPct > 0) grid[k].wins++;
  // 現行硬閘:PB + BUY 逆勢 → 唔發生
  const pbBuyCounter = cls === 'persistent_bear' && t.side === 'buy';
  simHard += pbBuyCounter ? 0 : actual;
  // 軟權重:順勢 ×1.1 / PB 逆勢 ×0.5 / 其他 ×1.0
  if (aligned(t.side)) simSoft += actual * 1.1;
  else if (pbBuyCounter) simSoft += actual * 0.5;
  else simSoft += actual;
}
console.log(`\n=== decayed 雙向分類 × side × PnL(${T.length} 喺)== =`);
console.log('分類                  n    sum(pp)   WR');
for (const [k, v] of Object.entries(grid).sort((a, b) => b[1].sum - a[1].sum)) {
  console.log(`${k.padEnd(26)} ${String(v.n).padStart(3)}  ${v.sum >= 0 ? '+' : ''}${v.sum.toFixed(1).padStart(7)}  ${(v.wins / Math.max(1, v.n) * 100).toFixed(0)}%`);
}
console.log(`\n基線(全部發生): ${baseline >= 0 ? '+' : ''}${baseline.toFixed(1)}pp`);
console.log(`現行硬閘模擬:    ${simHard >= 0 ? '+' : ''}${simHard.toFixed(1)}pp`);
console.log(`軟權重模擬:      ${simSoft >= 0 ? '+' : ''}${simSoft.toFixed(1)}pp (Δ vs 硬閘 ${simSoft - simHard >= 0 ? '+' : ''}${(simSoft - simHard).toFixed(1)}pp)`);
