// ─── 邏輯實驗 E1: 「跌市 sell 訊號」有無 edge？──────────────────────
// 用真實 1h candles 掃: mom24h<0 嘅時刻 → 後續 4h/24h 價格變化。
// 若 median 負（續跌）→ sell 有 edge（100% BUY 係漏判）
// 若 median 正（反彈）→ sell 無 edge（「唔開 BUY」先啱, 開 sell 會輸）
// Read-only.

import { MarketAgent } from '../src/market-agent/index.ts';

interface C { t:number; c:number; h:number; l:number }

async function candles(coin: string, n: number): Promise<C[]> {
  const end = Date.now();
  const start = end - n * 3600_000;
  for (const name of [coin.includes(':')?coin:`xyz:${coin}`, coin]) {
    try {
      const d = await MarketAgent.hlFetch({ type:'candleSnapshot', req:{ coin:name, interval:'1h', startTime:start, endTime:end } }) as C[] | null;
      if (Array.isArray(d) && d.length>10) return d.map(x=>({ t:Number(x.t), c:Number(x.c), h:Number(x.h), l:Number(x.l) })).filter(x=>Number.isFinite(x.t)&&x.c>0).sort((a,b)=>a.t-b.t);
    } catch { /* next */ }
  }
  return [];
}

function median(a: number[]): number { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2? s[m]! : (s[m-1]!+s[m]!)/2; }

async function main() {
  const syms = ['BTC','BNB','xyz:GOLD','xyz:SILVER','xyz:SNDK','xyz:SKHX','xyz:DRAM'];
  console.log(`\n=== E1: 「mom24<0 → 開 sell」有無 edge？（1h candles 最近 200 支）===\n`);
  console.log(`${'symbol'.padEnd(10)} ${'n<0'.padStart(5)} ${'後4h中位%'.padStart(9)} ${'WR跌'.padStart(5)} ${'後24h中位%'.padStart(10)} ${'WR跌'.padStart(5)} | ${'n>0'.padStart(5)} ${'後4h中位%'.padStart(9)} ${'WR升'.padStart(5)}`);
  console.log('-'.repeat(92));
  for (const sym of syms) {
    const cs = await candles(sym, 200);
    if (cs.length < 60) { console.log(`${sym.padEnd(14)} 數據不足 (${cs.length})`); continue; }
    const sell4: number[] = [], sell24: number[] = [], buy4: number[] = [];
    let sw4=0, sw24=0, bw4=0;
    for (let i = 24; i < cs.length - 24; i++) {
      const m = (cs[i]!.c - cs[i-24]!.c)/cs[i-24]!.c*100;
      const f4 = (cs[i+4]!.c - cs[i]!.c)/cs[i]!.c*100;
      const f24 = (cs[i+24]!.c - cs[i]!.c)/cs[i]!.c*100;
      if (m < 0) { sell4.push(f4); sell24.push(f24); if (f4<0) sw4++; if (f24<0) sw24++; }
      else { buy4.push(f4); if (f4>0) bw4++; }
    }
    const s4=median(sell4), s24=median(sell24), b4=median(buy4);
    console.log(`${sym.padEnd(14)} ${String(sell4.length).padStart(5)} ${s4.toFixed(2).padStart(9)} ${(sw4/Math.max(1,sell4.length)*100).toFixed(0).padStart(5)} ${s24.toFixed(2).padStart(10)} ${(sw24/Math.max(1,sell24.length)*100).toFixed(0).padStart(5)} | ${String(buy4.length).padStart(5)} ${b4.toFixed(2).padStart(9)} ${(bw4/Math.max(1,buy4.length)*100).toFixed(0).padStart(5)}`);
  }
}
main();
