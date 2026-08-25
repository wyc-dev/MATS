// ─── Exit-Price Lock Counterfactual — v2.0.870-exit-price-lock ─────────
//
// 主神調查（2026-08-25）: 最近 40 單大部分「本身賺到錢（MFE 0.5-2%）但全數回吐
// 成蝕」。驗證修復（L1 cold-start fallback + L2 live MFE candle 補正 + L3 trailing
// profit lock + 共識止盈唔俾任何嘢蓋過）喺真實數據上嘅成效。
//
// METHODOLOGY（保守、無 look-ahead）:
//   - 用每單 openedAt→closedAt 窗口內嘅真實 1h candles 重算「真 MFE(price)」
//     （同修復後 live gate 睇到嘅一樣——1h candle 極值係該 interval 真實範圍）
//   - L3 模擬: 逐支 1h candle 前向行——runningPeak MFE ≥0.5% 且 close 由 peak
//     回吐 ≥50%（且仍盈利）→ 喺該 candle close 鎖利。close 價 = candle close
//     （真實執行喺 5min cycle 檢查, 價格只會更早/更好 → script 係保守下限）
//   - 每單取「實際 pnl(margin%)」vs「修復後 pnl(margin%)」
//
// ⚠️ Read-only — never writes system state. 冇 candle 數據嘅單 → skip（唔計入）。
//
// Usage: npx tsx scripts/exit-price-lock-counter-test.ts

import fs from 'node:fs';
import path from 'node:path';

interface RT {
  symbol?: string;
  side?: 'buy' | 'sell';
  entryPrice?: number;
  leverage?: number;
  pnlPct?: number;
  openedAt?: number;
  closedAt?: number;
  closeReason?: string;
  quantity?: number;
}

interface CandleLike { t: number; h: number; l: number; c: number }

const statePath = path.resolve(process.cwd(), 'data/evolution/portfolio-state.json');

function loadRealTrades(): RT[] {
  const raw = fs.readFileSync(statePath, 'utf-8');
  const d = JSON.parse(raw);
  const rt = Array.isArray(d.realTrades) ? d.realTrades : [];
  return rt
    .filter((t: RT) => t && typeof t === 'object' && Number.isFinite(t.closedAt) && (t.closedAt ?? 0) > 0)
    .sort((a: RT, b: RT) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
}

async function fetchCandles(coin: string, startMs: number, endMs: number): Promise<CandleLike[]> {
  const { MarketAgent } = await import('../src/market-agent/index.ts');
  // xyz REST 做主源（HL 原生 candleSnapshot 對股票 symbol 返 500——實測）
  const xyzName = coin.includes(':') ? coin : `xyz:${coin}`;
  try {
    const d = await MarketAgent.hlFetch({
      type: 'candleSnapshot',
      req: { coin: xyzName, interval: '1h', startTime: startMs, endTime: endMs },
    }) as CandleLike[] | null;
    if (Array.isArray(d) && d.length > 0) return d;
  } catch { /* fallthrough */ }
  // HL 原生 fallback
  if (!coin.includes(':')) {
    try {
      const d2 = await MarketAgent.hlFetch({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: startMs, endTime: endMs },
      }) as CandleLike[] | null;
      if (Array.isArray(d2)) return d2;
    } catch { /* fallthrough */ }
  }
  return [];
}

function main(): void {
  const trades = loadRealTrades();
  const recent = trades.slice(-40);
  console.log(`\n=== Exit-Price Lock Counterfactual — 最近 ${recent.length} 單 ===\n`);

  const results: Array<{ sym: string; actual: number; fixed: number; mfe: number | null; locked: boolean; reason: string }> = [];

  let sumActual = 0;
  let sumFixed = 0;
  let lockedCount = 0;
  let skipCount = 0;

  (async () => {
    for (const t of recent) {
      const sym = t.symbol ?? '?';
      const side = t.side === 'sell' ? 'sell' : 'buy';
      const entry = t.entryPrice ?? 0;
      const lev = Number.isFinite(t.leverage) && (t.leverage ?? 0) > 0 ? (t.leverage ?? 1) : 1;
      const opened = t.openedAt ?? 0;
      const closed = t.closedAt ?? 0;
      const actualMarginPct = Number.isFinite(t.pnlPct) ? (t.pnlPct ?? 0) * 100 : NaN; // persisted pnlPct 單位 = margin %

      if (!(entry > 0) || opened <= 0 || closed <= opened) { results.push({ sym, actual: actualMarginPct, fixed: actualMarginPct, mfePct: null, locked: false, reason: 'skip(bad ts)' }); skipCount++; continue; }

      const candles = await fetchCandles(sym.includes(':') ? sym : sym.toUpperCase(), opened - 3600_000, closed + 60_000);
      const valid = candles
        .map(c => ({ t: Number(c.t), h: Number(c.h), l: Number(c.l), c: Number(c.c) }))
        .filter(c => Number.isFinite(c.t) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c) && c.h > 0 && c.l > 0 && c.c > 0)
        .sort((a, b) => a.t - b.t);
      const inWindow = valid.filter(c => c.t + 3600_000 > opened); // 同持倉重疊（同 live-mfe.ts）
      if (inWindow.length === 0) { results.push({ sym, actual: actualMarginPct, fixed: actualMarginPct, mfePct: null, locked: false, reason: '冇 candle' }); skipCount++; continue; }

      // 真 MFE(price) — 同 live-mfe.ts 一致
      const extreme = side === 'sell' ? Math.min(...inWindow.map(c => c.l)) : Math.max(...inWindow.map(c => c.h));
      const mfePct = ((side === 'sell' ? entry - extreme : extreme - entry) / entry) * 100;

      // L3 trailing lock 模擬（保守: 用 candle close 做鎖利價）
      let locked = false;
      let lockPrice = 0;
      let runningPeakPrice = entry;
      let peakMfePct = 0;
      let lastClose = 0;
      for (const c of inWindow) {
        if (side === 'sell') {
          if (c.l < runningPeakPrice) runningPeakPrice = c.l;
        } else {
          if (c.h > runningPeakPrice) runningPeakPrice = c.h;
        }
        peakMfePct = ((side === 'buy' ? runningPeakPrice - entry : entry - runningPeakPrice) / entry) * 100;
        lastClose = c.c;
        const pnlPricePct = ((side === 'buy' ? c.c - entry : entry - c.c) / entry) * 100;
        // L3: peak ≥0.5% 且 回吐 ≥50%（pnlPrice ≤ 0.5×peak）且仍正
        if (peakMfePct >= 0.5 && pnlPricePct <= 0.5 * peakMfePct && pnlPricePct > 0) {
          locked = true;
          break;
        }
      }
      const fixedMarginPct = locked ? ((side === 'buy' ? lastClose - entry : entry - lastClose) / entry) * 100 * lev : actualMarginPct;

      results.push({ sym, actual: actualMarginPct, fixed: fixedMarginPct, mfePct, locked, reason: t.closeReason ?? '' });
      sumActual += actualMarginPct;
      sumFixed += fixedMarginPct;
      if (locked) lockedCount++;
    }

    console.log(`${'symbol'.padEnd(12)} ${'實際%(m)'.padStart(9)} ${'修復後%(m)'.padStart(10)} ${'MFE%(p)'.padStart(8)} 鎖利   closeReason`);
    console.log('-'.repeat(70));
    for (const r of results) {
      const flag = r.locked ? '✅' : (r.fixed >= r.actual ? '  ' : '⚠️');
      console.log(`${r.sym.padEnd(12)} ${r.actual.toFixed(2).padStart(9)} ${r.fixed.toFixed(2).padStart(10)} ${(r.mfePct === null ? '--' : r.mfePct.toFixed(2)).padStart(8)} ${flag}   ${r.reason}`);
    }
    console.log('-'.repeat(70));
    console.log(`合計(40 單): 實際 ${sumActual.toFixed(2)}% → 修復後 ${sumFixed.toFixed(2)}%   (Δ ${(sumFixed - sumActual).toFixed(2)}%)`);
    console.log(`鎖利觸發: ${lockedCount}/${recent.length} 單   |  skip(冇數據): ${skipCount}`);
    const wins = results.filter(r => r.fixed > 0).length;
    console.log(`修復後正數單: ${wins}/${results.length}`);
  })();
}

main();
