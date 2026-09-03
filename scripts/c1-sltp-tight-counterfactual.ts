/**
 * c1-sltp-tight-counterfactual.ts — C1: 「SL 收窄 gap 2.8%」係誤傷定係早離場慳損失？
 *
 * 12 單 sl_tp「gap 2.8% tight」大蝕單——兩假設：
 *   A（壞收窄）: 收窄 SL → 正常波動掃走 → 如果保持寬 SL 可以避開 → 收窄係損失源
 *   B（好收窄）: 入錯方向倉 → 收窄 SL 早離場 → 慳損失（-8.2% vs 假設寬 SL -15%）
 *
 * 方法（零 look-ahead candle 重放）:
 *   對每單: 開倉後價格首次穿「收窄後 SL」（實際離場點）
 *   → 之後 24h 內價格有冇穿「原始寬 SL」（開倉時 SL）？
 *      有 → 收窄啱（遲早都止蝕, 早止蝕慳損失）  [假設 B]
 *      冇 + 反彈 > 收窄損失 → 收窄誤傷（錯過反彈） [假設 A]
 *
 * 數據: realTrades exitThesis fallback 有「SL: -1.0%→-0.8% from entry」——parse 收窄前後距離
 *       HL 5m candle 全路徑
 */
import * as fs from 'fs';

const pf = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const trades = (pf.realTrades || []).filter((t: any) => t.closeReason === 'sl_tp' && t.closedAt);

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

/** parse "SL: -1.0%→-0.8% from entry" → {origPct, tightPct} */
function parseSlPct(exitThesis: string): { origPct: number; tightPct: number } | null {
  const m = exitThesis.match(/SL:\s*([-+]?\d+\.?\d*)%\s*[→>]\s*([-+]?\d+\.?\d*)%\s*from entry/i);
  if (!m) return null;
  return { origPct: parseFloat(m[1]), tightPct: parseFloat(m[2]) };
}

(async () => {
  let nA = 0, nB = 0, nNA = 0;
  const rows: any[] = [];
  for (const t of trades) {
    const ex = t.exitThesis || '';
    const sl = parseSlPct(ex);
    if (!sl || !Number.isFinite(t.entryPrice) || t.entryPrice <= 0) { nNA++; continue; }
    // 搵 candle: 開倉前 1h → 開倉後 24h
    const candles = await getCandles(t.symbol, t.openedAt - 3600_000, t.closedAt + 24 * 3600_000);
    if (!candles) { nNA++; continue; }
    // BUY: SL 喺 entry 下方; SELL: SL 喺 entry 上方
    const dir = t.side === 'sell' ? -1 : 1;
    const tightPx = t.entryPrice + dir * Math.abs(sl.tightPct / 100) * t.entryPrice;
    const origPx = t.entryPrice + dir * Math.abs(sl.origPct / 100) * t.entryPrice;
    // 收窄方向驗證: tight 一定比 orig 貼近 entry（LONG tight>orig / SHORT tight<orig）
    const tightCloser = dir === 1 ? tightPx > origPx : tightPx < origPx;
    if (!tightCloser) { nNA++; continue; }

    const startIdx = candles.findIndex((c: any) => c.t >= t.openedAt - 300_000);
    if (startIdx < 0) { nNA++; continue; }
    // 1) 首穿 tight SL
    let hitTight = -1;
    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i];
      if (dir === 1 && c.l <= tightPx) { hitTight = i; break; }
      if (dir === -1 && c.h >= tightPx) { hitTight = i; break; }
    }
    if (hitTight < 0) { nNA++; continue; }
    // 2) tight 穿咗之後 24h 內有冇穿 orig SL?
    let hitOrig = false; let hitOrigAt = -1;
    const endIdx = Math.min(candles.length, hitTight + 288); // 24h = 288 支 5m
    for (let i = hitTight + 1; i < endIdx; i++) {
      const c = candles[i];
      if (dir === 1 && c.l <= origPx) { hitOrig = true; hitOrigAt = i; break; }
      if (dir === -1 && c.h >= origPx) { hitOrig = true; hitOrigAt = i; break; }
    }
    // 3) 若冇穿 orig——最高反彈（對 BUY）/ 最低下跌（對 SELL）
    let bouncePx = t.entryPrice;
    for (let i = hitTight + 1; i < endIdx; i++) {
      const c = candles[i];
      bouncePx = dir === 1 ? Math.max(bouncePx, c.h) : Math.min(bouncePx, c.l);
    }
    const bouncePct = dir === 1 ? (bouncePx - t.entryPrice) / t.entryPrice : (t.entryPrice - bouncePx) / t.entryPrice;
    const tightLossPct = Math.abs(sl.tightPct);
    const origLossPct = Math.abs(sl.origPct);
    // 判決: 穿 orig → 假設 B（收窄慳損失）; 冇穿 + 反彈>tight 損失 → 假設 A（誤傷）
    let verdict: 'A-誤傷' | 'B-收窄啱' | 'B-中性';
    if (hitOrig) verdict = 'B-收窄啱';
    else if (bouncePct > tightLossPct) verdict = 'A-誤傷';
    else verdict = 'B-中性';
    if (verdict === 'A-誤傷') nA++; else if (verdict.startsWith('B')) nB++;
    rows.push({
      symbol: t.symbol, side: t.side, pnl: (t.pnlPct * 100).toFixed(1), hold: Math.round((t.closedAt - t.openedAt) / 60000),
      origPct: sl.origPct.toFixed(2), tightPct: sl.tightPct.toFixed(2), hitOrig, bouncePct: (bouncePct * 100).toFixed(2),
      verdict,
    });
  }
  console.log('═'.repeat(78));
  console.log('C1: SL 收窄（gap 2.8% tight）——誤傷定係早離場慳損失？');
  console.log('═'.repeat(78));
  for (const r of rows) {
    console.log(`  ${r.symbol} ${r.side} pnl=${r.pnl}% hold=${r.hold}m | SL ${r.origPct}→${r.tightPct}% | 穿原SL=${r.hitOrig} 反彈=${r.bouncePct}% → ${r.verdict}`);
  }
  console.log('─'.repeat(78));
  console.log(`A-誤傷（收窄後反彈>損失——如果唔收窄可以避開）: ${nA} 單`);
  console.log(`B-收窄啱/中性（穿咗原 SL 或反彈不足——收窄早離場慳損失/無害）: ${nB} 單`);
  console.log(`NA（無 SL% 記錄/無 candle）: ${nNA} 單`);
  console.log(`\n${nA > nB ? '→ 假設 A 成立: 收窄係損失源——動態 ATR 對齊值得做' : '→ 假設 B 成立: 收窄早離場慳損失——F3-Dynamic 會放大損失（保持現狀/轉向其他修正）'}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
