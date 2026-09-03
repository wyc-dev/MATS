/**
 * e3-atr-analysis.ts — SL 距離 vs ATR: 「窄 SL 過早掃走」有冇預測力？
 *
 * 主神方向: SL 應該同即時波動率（ATR）動態對齊。驗證前提:
 *   若「SL 距離 < k×ATR」嘅 sl_tp 單, 被掃後價格反彈率高（掃走=假信號）
 *   → ATR 對齊有效（加闊 SL 可避免無謂止蝕）
 *   若被掃後續跌（掃走=啱）→ ATR 對齊冇成效（SL 加闊只會蝕更多）
 *
 * 方法（零 look-ahead）:
 *   開倉時 1h ATR（開倉前已 close 支，robust σ = MAD×1.4826 同系統一致）
 *   SL 距離（% price from entry, 用 finalStopLossPrice 實際離場）
 *   被掃後 4h/24h 價格方向（續跌 vs 反彈）
 */
import * as fs from 'fs';

const pf = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const sltps = (pf.realTrades || []).filter((t: any) => t.closeReason === 'sl_tp' && t.closedAt && t.openedAt >= Date.now() - 30 * 86_400_000);

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

function robustSigma(closes: number[]): number {
  const med = closes.slice().sort((a, b) => a - b)[Math.floor(closes.length / 2)];
  const devs = closes.map(c => Math.abs(c - med)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)];
  const σ = 1.4826 * mad;
  // 轉 % per 1h（closes 係價, 用 return 分佈更標準）
  return med > 0 ? σ / med : 0;
}

(async () => {
  interface Row {
    symbol: string; side: string; pnlPct: number; holdMin: number;
    slPct: number; atr1hPct: number; ratio: number;
    bounce4hPct: number; bounce24hPct: number; continuedDrop: 'rebound' | 'drop';
  }
  const rows: Row[] = [];
  for (let i = 0; i < sltps.length; i++) {
    const t = sltps[i];
    const entry = t.entryPrice;
    const exitSl = t.finalStopLossPrice || t.exitPrice || 0;
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exitSl) || exitSl <= 0) continue;
    // SL 距離（% price，按 entry 計，同系統距離語義一致）
    const slPct = Math.abs(exitSl - entry) / entry;
    // 開倉時 1h ATR（前 25 支已 close 1h candle）
    const c1 = await getCandles(t.symbol, '1h', t.openedAt - 30 * 3600_000, t.openedAt + 120_000);
    if (!c1 || c1.length < 6) continue;
    const closed1h = c1.filter((c: any) => c.t + 3600_000 <= t.openedAt + 60_000);
    if (closed1h.length < 6) continue;
    const closes = closed1h.slice(-25).map((c: any) => c.c);
    const atr1hPct = robustSigma(closes);
    const ratio = atr1hPct > 0 ? slPct / atr1hPct : 0;
    // 被掃後走勢: close 後 4h/24h（用 5m candle）
    const c5 = await getCandles(t.symbol, '5m', t.closedAt, t.closedAt + 24 * 3600_000);
    if (!c5 || c5.length < 2) continue;
    const dir = t.side === 'sell' ? -1 : 1;
    const exPrice = t.exitPrice || exitSl;
    let low4h = exPrice, high4h = exPrice, px24h = exPrice;
    const end4h = c5.findIndex((c: any) => c.t >= t.closedAt + 4 * 3600_000);
    const end24 = c5.findIndex((c: any) => c.t >= t.closedAt + 24 * 3600_000);
    const idx4h = end4h > 0 ? end4h : c5.length;
    const idx24 = end24 > 0 ? end24 : c5.length;
    for (let k = 1; k < idx24; k++) {
      const c = c5[k];
      if (k < idx4h) { low4h = Math.min(low4h, c.l); high4h = Math.max(high4h, c.h); }
      px24h = c.c;
    }
    // 續跌 = 冇反彈超過 SL 距離; 反彈 = 4h 內 price 反方向走 > SL 距離
    const bounce4hPct = dir === 1 ? (high4h - exPrice) / entry : (exPrice - low4h) / entry;
    const postMove24Pct = dir === 1 ? (px24h - exPrice) / entry : (exPrice - px24h) / entry;
    const continuedDrop = postMove24Pct > 0 ? 'drop' : 'rebound'; // 正 = 離場啱（續跌）
    rows.push({
      symbol: t.symbol, side: t.side, pnlPct: (t.pnlPct || 0), holdMin: Math.round((t.closedAt - t.openedAt) / 60000),
      slPct, atr1hPct, ratio, bounce4hPct: bounce4hPct * 100, bounce24hPct: postMove24Pct * 100, continuedDrop,
    });
    if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${sltps.length}`);
  }

  console.log(`\n分析 sl_tp 單: ${rows.length} 單（有 ATR + 被掃後走勢）\n`);
  console.log(`${'symbol'.padEnd(10)} ${'side'.padEnd(4)} ${'pnl%'.padEnd(7)} ${'SL%'.padEnd(7)} ${'ATR1h%'.padEnd(8)} ${'ratio'.padEnd(6)} ${'4h彈'.padEnd(6)} ${'24h後'.padEnd(8)} 續跌/反彈`);
  for (const r of rows.sort((a, b) => a.ratio - b.ratio)) {
    console.log(`${r.symbol.padEnd(10)} ${r.side.padEnd(4)} ${(r.pnlPct * 100).toFixed(1).padEnd(7)} ${(r.slPct * 100).toFixed(2).padEnd(7)} ${(r.atr1hPct * 100).toFixed(3).padEnd(8)} ${r.ratio.toFixed(2).padEnd(6)} ${r.bounce4hPct.toFixed(1).padEnd(6)} ${r.bounce24hPct.toFixed(1).padEnd(8)} ${r.continuedDrop}`);
  }

  console.log('\n═'.repeat(70));
  console.log('分組: SL 距離 / ATR 倍數 → 被掃後 24h「續跌（離場啱）」比例');
  console.log('═'.repeat(70));
  for (const [label, lo, hi] of [['<1×ATR', 0, 1], ['1-1.5×ATR', 1, 1.5], ['1.5-2×ATR', 1.5, 2], ['2-3×ATR', 2, 3], ['>3×ATR', 3, 99]] as const) {
    const grp = rows.filter(r => r.ratio >= lo && r.ratio < hi);
    if (!grp.length) { console.log(`  ${label}: n=0`); continue; }
    const drop = grp.filter(r => r.continuedDrop === 'drop').length;
    const avgPnl = grp.reduce((s, r) => s + r.pnlPct, 0) / grp.length;
    console.log(`  ${label}: n=${grp.length} | 續跌率=${(drop / grp.length * 100).toFixed(0)}% | 平均pnl=${(avgPnl * 100).toFixed(1)}%`);
  }
  const narrow = rows.filter(r => r.ratio < 1.5);
  const wide = rows.filter(r => r.ratio >= 1.5);
  const nDrop = narrow.filter(r => r.continuedDrop === 'drop').length;
  const wDrop = wide.filter(r => r.continuedDrop === 'drop').length;
  console.log(`\n  SL<1.5×ATR (n=${narrow.length}): 續跌率=${(nDrop / narrow.length * 100).toFixed(0)}% — ${nDrop / narrow.length < 0.5 ? '被掃後多數反彈 → ATR 對齊有效' : '被掃後續跌 → 掃走啱'}`);
  console.log(`  SL≥1.5×ATR (n=${wide.length}): 續跌率=${(wDrop / wide.length * 100).toFixed(0)}%`);
  fs.writeFileSync('/tmp/e3-atr-rows.json', JSON.stringify(rows));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
