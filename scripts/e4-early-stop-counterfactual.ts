/**
 * e4-early-stop-counterfactual.ts — E4: consensus close 早止血驗證
 *
 * 假設: 大蝕 consensus close 平均持倉 195m 先被 Meta override 止血（太遲）。
 * 候選機制（主神指定）: 持倉中「unrealized ≤ -3% margin」+「5m/15m 續跌結構」
 *   → 下 cycle 即止血（唔等 consensus/Meta override）。
 *
 * 全樣本重放（零 look-ahead）:
 *   每單由開倉逐 5m cycle 行——用 5m candle close 計 unrealized margin%
 *   觸發條件: unrealized ≤ -3% 且 5m close < 前支 close（續跌結構）
 *   → 觸發當下離場（下 cycle open，approximate）
 *   對比: 實際離場 pnl vs 早止血 pnl
 *
 * 三關（831 §10）: 全樣本 Δ / 兩半穩健 / 剔 outlier
 * 誤傷評估: 早止血觸發但之後價格反彈（錯過回彈）嘅單
 */
import * as fs from 'fs';

const pf = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const trades = (pf.realTrades || []).filter((t: any) => t.openedAt >= Date.now() - 30 * 86_400_000 && Number.isFinite(t.pnlPct));

const cache = new Map<string, any[]>();
async function getCandles(coin: string, startTs: number, endTs: number) {
  const key = `${coin}|${startTs}|${endTs}`;
  if (cache.has(key)) return cache.get(key)!;
  const raw = coin.includes(':') ? coin : `xyz:${coin}`;
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: raw, interval: '5m', startTime: startTs, endTime: endTs } }),
    });
    const j = await r.json();
    const arr = Array.isArray(j) && j.length ? j.sort((a: any, b: any) => a.t - b.t) : null;
    cache.set(key, arr);
    return arr;
  } catch { return null; }
}

/** leverage: per-symbol 眾數（fallback 10） */
const levMode: Record<string, number> = {};
for (const t of trades) {
  const k = String(t.symbol).toLowerCase();
  const l = t.leverage;
  if (Number.isFinite(l) && l > 0) {
    levMode[k] = levMode[k] === undefined ? l : { [levMode[k]]: (levMode[k] || 0), [l]: ((levMode[k] ?? 0) + 1) }[l] !== undefined ? l : levMode[k];
  }
}
// 簡單眾數
const levCount: Record<string, Record<number, number>> = {};
for (const t of trades) {
  const k = String(t.symbol).toLowerCase();
  const l = Number(t.leverage) || 10;
  (levCount[k] = levCount[k] || {})[l] = ((levCount[k] || {})[l] || 0) + 1;
}
const levOf = (sym: string) => {
  const c = levCount[String(sym).toLowerCase()] || {};
  const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return best ? parseFloat(best[0]) : 10;
};

const fmtT = (ts: number) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

(async () => {
  const results: any[] = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const entry = t.entryPrice;
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const dir = t.side === 'sell' ? -1 : 1;
    const lev = levOf(t.symbol);

    // candle: 開倉前 1 支 → 開倉後至實際 close（或 +24h 上限）
    const endTs = Math.min((t.closedAt || Date.now()) + 24 * 3600_000, Date.now());
    const candles = await getCandles(t.symbol, t.openedAt - 5 * 60_000, endTs);
    if (!candles) continue;
    const startIdx = candles.findIndex((c: any) => c.t >= t.openedAt - 120_000);
    if (startIdx < 0 || startIdx >= candles.length - 1) continue;

    // 模擬: 逐 cycle 檢查觸發條件（只到實際離場為止——實際離場後 gate 無意義）
    let earlyStopPx: number | null = null;
    let earlyStopAt: number | null = null;
    const stopCut = Math.min(candles.length, startIdx + 300); // 25h limit
    for (let k = startIdx + 1; k < stopCut; k++) {
      const c = candles[k];
      const prev = candles[k - 1];
      // 實際已離場 → stop scanning
      if (t.closedAt && c.t >= t.closedAt) break;
      const unrealPct = ((c.c - entry) / entry) * dir * lev * 100;
      const continuedDown = dir === 1 ? c.c < prev.c : c.c > prev.c;
      if (unrealPct <= -3 && continuedDown) {
        earlyStopPx = c.c;
        earlyStopAt = c.t;
        break;
      }
    }

    const actualPnl = (t.pnlPct || 0) * 100;
    let earlyPnl: number | null = null;
    if (earlyStopPx !== null) {
      earlyPnl = ((earlyStopPx - entry) / entry) * dir * lev * 100;
    }

    results.push({
      symbol: t.symbol, side: t.side, closeReason: t.closeReason,
      held: Math.round(((t.closedAt || Date.now()) - t.openedAt) / 60000),
      actualPnl, earlyPnl, triggered: earlyPnl !== null,
      opened: fmtT(t.openedAt), closed: fmtT(t.closedAt || Date.now()),
    });
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${trades.length}`);
  }

  // ── 統計 ──
  const withEarly = results.filter(r => r.triggered);
  const stat = (arr: any[], label: string) => {
    if (!arr.length) { console.log(`  ${label}: n=0`); return; }
    const actSum = arr.reduce((s, r) => s + r.actualPnl, 0);
    const earSum = arr.reduce((s, r) => s + (r.earlyPnl ?? r.actualPnl), 0);
    const delta = earSum - actSum;
    const imp = arr.filter(r => (r.earlyPnl ?? r.actualPnl) > r.actualPnl).length;
    console.log(`  ${label}: n=${arr.length} | ACTUAL Σ=${actSum.toFixed(1)}% | EARLY Σ=${earSum.toFixed(1)}% | Δ=${delta.toFixed(1)}pp | 改善單 ${imp}/${arr.length}`);
  };

  console.log(`\n全樣本: ${results.length} 單 | 觸發早止血: ${withEarly.length} 單 (${(withEarly.length / results.length * 100).toFixed(0)}%)\n`);
  console.log('════════ 三關 ════════');
  console.log('關1: 觸發組 vs 全樣本');
  stat(withEarly, '觸發組（原實際）');
  stat(results, '全樣本');

  console.log('\n關2: 兩半穩健（觸發組，按開倉時間）');
  const oe = [...withEarly].sort((a, b) => a.opened.localeCompare(b.opened));
  const half = Math.floor(oe.length / 2);
  stat(oe.slice(0, half), '前一半');
  stat(oe.slice(half), '後一半');

  console.log('\n關2b: 剔 outlier（|actual|>30% 或 |early|>30%）');
  const noOut = withEarly.filter(r => Math.abs(r.actualPnl) <= 30 && Math.abs(r.earlyPnl ?? 0) <= 30);
  stat(noOut, '剔 outlier');

  console.log('\n════════ 誤傷分析 ════════');
  const hurt = withEarly.filter(r => r.earlyPnl! < r.actualPnl);
  const helped = withEarly.filter(r => r.earlyPnl! > r.actualPnl);
  console.log(`誤傷（早止血後實際更差/錯過回彈）: ${hurt.length} 單 Σ受損=${hurt.reduce((s, r) => s + (r.actualPnl - r.earlyPnl!), 0).toFixed(1)}pp`);
  stat(helped, '受惠（早止血慳損失）');
  console.log('\n誤傷單明細（早止血 pnl < 實際 pnl）:');
  hurt.slice(0, 15).forEach(r => console.log(`  ${r.symbol} ${r.side} ${r.opened}→${r.closed} [${r.held}m] ${r.closeReason} actual=${r.actualPnl.toFixed(1)}% early=${r.earlyPnl!.toFixed(1)}%`));
  if (hurt.length <= 15) console.log('  （全部列出）');
  fs.writeFileSync('/tmp/e4-results.json', JSON.stringify({ results, withEarly }));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
