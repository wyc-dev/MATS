// ─── 謹慎驗證 v3 — 真實模型重放（主神要求 2026-08-25）──────────────────
// 真實執行: L2 用 1h window high 做 peak（liveMfe）+ 每 5min cycle 檢查當下價。
// 兩個界: close悲觀（等 5m bar 完先鎖）vs cross樂觀（穿越 0.5×peak 嗰刻鎖）。
// Read-only。

import fs from 'node:fs';
import path from 'node:path';

interface RT { symbol?: string; side?: 'buy'|'sell'; entryPrice?: number; leverage?: number; pnlPct?: number; openedAt?: number; closedAt?: number; closeReason?: string }
interface Candle { t:number; h:number; l:number; c:number }

const statePath = path.resolve(process.cwd(), 'data/evolution/portfolio-state.json');

async function fetchCandles(coin: string, interval: '1h'|'5m', startMs: number, endMs: number): Promise<Candle[]> {
  const { MarketAgent } = await import('../src/market-agent/index.ts');
  const xyzName = coin.includes(':') ? coin : `xyz:${coin}`;
  for (const name of [xyzName, coin]) {
    try {
      const d = await MarketAgent.hlFetch({ type: 'candleSnapshot', req: { coin: name, interval, startTime: startMs, endTime: endMs } }) as Candle[] | null;
      if (Array.isArray(d) && d.length > 0) return d
        .map(c => ({ t:Number(c.t), h:Number(c.h), l:Number(c.l), c:Number(c.c) }))
        .filter(x => Number.isFinite(x.t) && x.h>0 && x.l>0 && x.c>0);
    } catch { /* next */ }
  }
  return [];
}

function simulate(side: 'buy'|'sell', entry: number, lev: number, c5: Candle[], c1: Candle[], opened: number) {
  const win5 = c5.filter(c => c.t + 300_000 > opened).sort((a,b)=>a.t-b.t);
  const win1 = c1.filter(c => c.t + 3_600_000 > opened).sort((a,b)=>a.t-b.t);
  if (win5.length === 0 && win1.length === 0) return { ok: false as const };

  let runningPeak = entry;
  const bars = win5.length > 0 ? win5 : win1;
  for (const c of bars) {
    const c1b = win1.find(x => x.t <= c.t && c.t < x.t + 3_600_000);
    if (side === 'sell') {
      if (c1b && c1b.l < runningPeak) runningPeak = c1b.l;
      if (c.l < runningPeak) runningPeak = c.l;
    } else {
      if (c1b && c1b.h > runningPeak) runningPeak = c1b.h;
      if (c.h > runningPeak) runningPeak = c.h;
    }
    const peakPct = ((side==='buy'? runningPeak-entry : entry-runningPeak)/entry)*100;
    const pnlPrice = ((side==='buy'? c.c-entry : entry-c.c)/entry)*100;
    if (peakPct >= 0.5 && pnlPrice <= 0.5*peakPct && pnlPrice > 0) {
      return { ok: true as const, peakPct, lockClose: pnlPrice*lev, lockCross: 0.5*peakPct*lev };
    }
  }
  const peakPct = ((side==='buy'? runningPeak-entry : entry-runningPeak)/entry)*100;
  return { ok: true as const, peakPct, lockClose: 0, lockCross: 0 };
}

async function main() {
  const d = JSON.parse(fs.readFileSync(statePath,'utf-8'));
  const rt: RT[] = (Array.isArray(d.realTrades)? d.realTrades : []).filter((t:RT)=>t && Number.isFinite(t.closedAt) && (t.closedAt??0)>0).sort((a:RT,b:RT)=>(a.closedAt??0)-(b.closedAt??0));
  const recent = rt.slice(-40);
  console.log(`\n=== 謹慎驗證 v3 — 1h peak + 5m cycle 重放 · 最近 ${recent.length} 單 ===\n`);
  console.log(`${'symbol'.padEnd(13)} ${'實際%'.padStart(9)} ${'close悲觀'.padStart(9)} ${'cross樂觀'.padStart(9)} ${'peak%'.padStart(7)} 狀態`);
  console.log('-'.repeat(74));

  let sumA=0, sumP=0, sumO=0, lockedN=0, toPosO=0, origWinN=0, stillN=0, skipN=0;
  for (const t of recent) {
    const sym=t.symbol??'?'; const side=t.side==='sell'?'sell':'buy'; const entry=t.entryPrice??0;
    const lev=Number.isFinite(t.leverage)&&(t.leverage??0)>0?(t.leverage??1):1;
    const opened=t.openedAt??0; const closed=t.closedAt??0; const actual=(t.pnlPct??0)*100;
    if (!(entry>0)||opened<=0||closed<=opened){ console.log(`${sym.padEnd(12)} ${actual.toFixed(2).padStart(9)} ${actual.toFixed(2).padStart(9)} ${actual.toFixed(2).padStart(9)} ${'--'.padStart(7)}  skip`); skipN++; continue; }
    const base = sym.includes(':')?sym:sym.toUpperCase();
    const c5 = await fetchCandles(base,'5m',opened-300_000,closed+60_000);
    const c1 = await fetchCandles(base,'1h',opened-3_600_000,closed+60_000);
    const s = simulate(side,entry,lev,c5,c1,opened);
    if (!s.ok){ console.log(`${sym.padEnd(12)} ${actual.toFixed(2).padStart(9)} ${actual.toFixed(2).padStart(9)} ${actual.toFixed(2).padStart(9)} ${'--'.padStart(7)}  無數據`); skipN++; continue; }
    const p = s.lockClose>0 ? s.lockClose : actual;
    const o = s.lockCross>0 ? s.lockCross : actual;
    sumA+=actual; sumP+=p; sumO+=o;
    let status='原贏';
    if (s.lockCross>0){ lockedN++; if(actual<=0&&o>0){status='蝕→正';toPosO++;} else if(actual<=0){status='蝕→改善';} else {status='贏→鎖';} }
    else if (actual>0){ status='原贏'; origWinN++; } else { status='蝕→未鎖'; stillN++; }
    console.log(`${sym.padEnd(12)} ${actual.toFixed(2).padStart(9)} ${p.toFixed(2).padStart(9)} ${o.toFixed(2).padStart(9)} ${s.peakPct.toFixed(2).padStart(7)} ${status}`);
  }
  console.log('-'.repeat(74));
  console.log(`合計: 實際 ${sumA.toFixed(2)}% → close悲觀 ${sumP.toFixed(2)}% / cross樂觀 ${sumO.toFixed(2)}%`);
  console.log(`鎖利 ${lockedN}/${recent.length-skipN} · 蝕→正(cross) ${toPosO} · 原贏 ${origWinN} · 蝕→未鎖 ${stillN} · skip ${skipN}`);
}

main();
