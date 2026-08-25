// ─── 驗證: 「回吐確認」機制（pending N-bar 冇新高先鎖）────────────────
// 目標: 大 winner（>19% tp_hit 單）唔俾 L3 誤鎖；真回吐（蝕單）照樣鎖。
// 方法: 5m bars 逐支——回吐 ≥50% → pending；之後 N bars 冇創新高 → 鎖
//       （鎖利價 = 0.5×peak price × lev —— 樂觀界，真實 cycle 即時）。
//       創新高 → cancel（繼續跑，可能再觸發）。
// 掃 N ∈ {1,2,3,6,12}（=5/10/15/30/60 min）。Read-only。

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

function simulate(side:'buy'|'sell', entry:number, lev:number, c5:Candle[], c1:Candle[], opened:number, N:number) {
  const win5 = c5.filter(c => c.t + 300_000 > opened).sort((a,b)=>a.t-b.t);
  const win1 = c1.filter(c => c.t + 3_600_000 > opened).sort((a,b)=>a.t-b.t);
  if (win5.length===0 && win1.length===0) return { ok:false as const };
  let runningPeak = entry;
  let pending = 0;           // pending lock 時嘅 peak（0 = 冇 pending）
  let pendingPct = 0;        // pending lock 時嘅 peak %
  let pendingCount = 0;
  const bars = win5.length>0? win5 : win1;
  for (const c of bars) {
    const c1b = win1.find(x => x.t <= c.t && c.t < x.t + 3_600_000);
    const prevPeak = runningPeak;
    if (side==='sell'){ if (c1b&&c1b.l<runningPeak) runningPeak=c1b.l; if (c.l<runningPeak) runningPeak=c.l; }
    else { if (c1b&&c1b.h>runningPeak) runningPeak=c1b.h; if (c.h>runningPeak) runningPeak=c.h; }
    const peakPct = ((side==='buy'? runningPeak-entry : entry-runningPeak)/entry)*100;
    const pnlPrice = ((side==='buy'? c.c-entry : entry-c.c)/entry)*100;
    if (pending > 0) {
      // 創新高 → 取消 pending（趨勢有效）
      if (runningPeak > pending) { pending = 0; pendingCount = 0; }
      else if (++pendingCount >= N) {
        // 悲觀界: 鎖當下 close（真實 cycle 檢查價）; 樂觀界: 0.5×pendingPct（穿越嗰刻）
        const lockPctPess = ((side==='buy'? c.c-entry : entry-c.c)/entry)*100;
        return { ok:true as const, locked:true, lockPnlMargin: Math.max(lockPctPess,0)*lev, lockPnlMarginOpt: 0.5*pendingPct*lev, peakPct: pendingPct, cancel:false };
      }
    }
    if (pending === 0 && peakPct >= 0.5 && pnlPrice <= 0.5*peakPct && pnlPrice > 0) {
      pending = runningPeak; pendingPct = peakPct; pendingCount = 0;
    }
  }
  const peakPct = ((side==='buy'? runningPeak-entry : entry-runningPeak)/entry)*100;
  return { ok:true as const, locked:false, lockPnlMargin:0, lockPnlMarginOpt:0, peakPct, cancel:false };
}

async function main() {
  const d = JSON.parse(fs.readFileSync(statePath,'utf-8'));
  const rt: RT[] = (Array.isArray(d.realTrades)? d.realTrades : []).filter((t:RT)=>t && Number.isFinite(t.closedAt) && (t.closedAt??0)>0).sort((a:RT,b:RT)=>(a.closedAt??0)-(b.closedAt??0));
  const recent = rt.slice(-40);
  for (const N of [12]) {
    if (N === 12) console.log(`\n--- N=12 逐單（確認式鎖掛）---`);
    let sumA=0,sumB=0,sumOpt=0,lockN=0,toPos=0,wrongWinLocked=0;
    let bigWinLoss=0;
    for (const t of recent) {
      const sym=t.symbol??'?'; const side=t.side==='sell'?'sell':'buy'; const entry=t.entryPrice??0;
      const lev=Number.isFinite(t.leverage)&&(t.leverage??0)>0?(t.leverage??1):1;
      const opened=t.openedAt??0; const closed=t.closedAt??0; const actual=(t.pnlPct??0)*100;
      if (!(entry>0)||opened<=0||closed<=opened) continue;
      const base=sym.includes(':')?sym:sym.toUpperCase();
      const c5=await fetchCandles(base,'5m',opened-300_000,closed+60_000);
      const c1=await fetchCandles(base,'1h',opened-3_600_000,closed+60_000);
      const s=simulate(side,entry,lev,c5,c1,opened,N);
      if (!s.ok) continue;
      const fixed = s.locked ? s.lockPnlMargin : actual;
      const fixedOpt = s.locked ? (s.lockPnlMarginOpt ?? s.lockPnlMargin) : actual;
      sumA+=actual; sumB+=fixed; sumOpt += fixedOpt;
      if (N === 12) {
        const tag = s.locked ? (actual>10 ? '🔒誤鎖大贏!' : (actual<=0 ? '🔒蝕→正' : '🔒')) : (actual>10 ? '✅保住大贏' : (actual<=0?'—未鎖':'原贏'));
        console.log(`${sym.padEnd(10)} 實際 ${actual.toFixed(1).padStart(6)}% → 鎖後 ${fixedOpt.toFixed(1).padStart(6)}%  ${tag}`);
      }
      if (s.locked){ lockN++; if(actual<=0&&fixed>0)toPos++; }
      if (actual>10 && s.locked){ wrongWinLocked++; bigWinLoss += (actual-fixed); }
    }
    console.log(`N=${String(N).padEnd(2)} (${N*5}min): 實際 ${sumA.toFixed(1)}% → 悲觀 ${sumB.toFixed(1)}% / 樂觀 ${sumOpt.toFixed(1)}%  鎖${lockN} 蝕→正${toPos} 誤鎖大贏${wrongWinLocked} 大贏損失${bigWinLoss.toFixed(1)}pp`);
  }
}

main();
