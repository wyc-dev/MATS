/** P8 驗證:如果 5m 方向閘 + OLR 閘喺最近 50 喺時已生效,會擋走乜? */
import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const T: any[] = (st.realTrades ?? []).filter((t: any) => t.closedAt).sort((a, b) => a.closedAt - b.closedAt).slice(-50);
const S: string[] = [...new Set(T.map((t: any) => t.symbol))];
const t0 = Math.min(...T.map((t: any) => t.openedAt)) - 7200000;
const { MarketAgent } = await import('../src/market-agent/index.ts');
async function fc(coin: string): Promise<any[]> {
  for (const n of [coin.includes(':') ? coin : `xyz:${coin}`, coin.includes(':') ? coin.replace('xyz:', '') : coin.toUpperCase()]) {
    try {
      const d = await MarketAgent.hlFetch({ type: 'candleSnapshot', req: { coin: n, interval: '15m', startTime: t0, endTime: Date.now() } });
      if (Array.isArray(d) && d.length) return d;
    } catch { /* nx */ }
  }
  return [];
}
const C = new Map<string, any[]>();
let nf = 0;
for (const s of S) { const a = await fc(s); C.set(s, a); nf += a.length; }
console.log(`candles: ${nf} / ${S.length} symbols`);
function rs(r: number[]) { return [...r].sort((a, b) => a - b); }
function sig(r: number[]) { const s = rs(r); const m = s[Math.floor(r.length / 2)]; const d = r.map((x) => Math.abs(x - m)).sort((a, b) => a - b); return d[Math.floor(r.length / 2)] * 1.4826; }
function info(t: any) {
  const c = (C.get(t.symbol) ?? []).filter((x: any) => x.t <= t.openedAt && x.t >= t.openedAt - 3600000);
  if (c.length < 6) return { s: null as number | null, th: 0, bl: false };
  const w = c.slice(-6).map((x: any) => x.c);
  const sl = ((w[5] - w[0]) / w[0]) * 10000;
  if (!Number.isFinite(sl)) return { s: null as number | null, th: 0, bl: false };
  const ret: number[] = [];
  for (let i = 1; i < 6; i++) ret.push(((w[i] - w[i - 1]) / w[i - 1]) * 10000);
  const th = Math.min(500, Math.max(10, 2 * Math.max(sig(ret), 1) * Math.sqrt(5)));
  return { s: sl, th, bl: t.side === 'buy' ? sl <= -th : sl >= th };
}
const base = T.reduce((a, t) => a + t.pnlPct * 100, 0);
console.log(`\n基線(${T.length}單): ${base >= 0 ? '+' : ''}${base.toFixed(1)}pp`);
console.log('\nsymbol       side     slope    thr  A閘   OLR    實際      reason');
let cnt: any = { A: 0, B: 0, AB: 0, P: 0 }, pnl: any = { A: 0, B: 0, AB: 0, P: 0 };
for (const t of T) {
  const i = info(t);
  const ob = typeof t.entryOlrPWin === 'number' && t.entryOlrPWin < 0.35;
  const k = i.bl && ob ? 'AB' : i.bl ? 'A' : ob ? 'B' : 'P';
  cnt[k]++; pnl[k] += t.pnlPct * 100;
  const sl = i.s === null ? '     n/a' : (i.s >= 0 ? '+' : '') + i.s.toFixed(1).padStart(8);
  const ov = typeof t.entryOlrPWin === 'number' ? ((t.entryOlrPWin * 100).toFixed(0) + '%').padStart(5) : '  n/a';
  console.log(`${t.symbol.padEnd(11)} ${t.side.padEnd(4)} ${sl}bps ${String(i.th.toFixed(0)).padStart(5)} ${i.bl ? 'BLK' : ' - '} ${ov} ${(t.pnlPct * 100 >= 0 ? '+' : '') + (t.pnlPct * 100).toFixed(2).padStart(8)}pp ${t.closeReason ?? ''} ${k === 'P' ? '' : k}`);
}
const bn = cnt.A + cnt.B + cnt.AB, bp = pnl.A + pnl.B + pnl.AB;
console.log(`\n擋走 ${bn} 喺(${cnt.A} A / ${cnt.B} B / ${cnt.AB} AB), 合計 PnL ${bp >= 0 ? '+' : ''}${bp.toFixed(1)}pp`);
console.log(`放行 ${T.length - bn} 喺, 合計 ${base - bp >= 0 ? '+' : ''}${(base - bp).toFixed(1)}pp`);
const verdict = verdictText();
console.log(verdict);
function verdictText(): string {
  const kind = bp >= 0 ? '正（擋走贏單—門檻太緊）' : '負（擋走蝕單—閘有效）';
  const delta = Math.abs(Math.round(bp));
  return `\n裁決: 擋走嘅 PnL 係 ${kind}; 反事實 Δ = ${delta}pp（${bp < 0 ? '擋走嘅係蝕單，P8 閘有效' : '擋走嘅係贏單，門檻太緊'}）`;
}
