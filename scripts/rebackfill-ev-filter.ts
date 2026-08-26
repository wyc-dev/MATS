/**
 * v2.0.870-P3-attack: EV Filter 重跑 backfill——修復 bnb|buy 缺數據。
 *
 * 根因: production ev-filter.json 嘅 backfill 喺 EXP records 更新前執行,
 * 令 bnb|buy(84 筆 EXP records)靜默缺失 → EV 硬閘對 bnb 失效(冷啟動放行)。
 *
 * 方法(邏輯實驗):
 *  1. 讀 EXP records(2441 筆)+ live realTrades(portfolio-state.json)。
 *  2. dedup 用 (symbol|side|closedAt 秒)——EXP 同 live 嘅 id 唔同(EXP 有
 *     exp- 前綴 + 唔同 UUID),但 (symbol,side,closedAt) 係同一 trade 嘅穩定 key。
 *  3. 重置 EVFilter → 重新餵入全部 records → markBackfillDone → save。
 *  4. 驗證 bnb|buy 有數據 + EV 硬閘會 block。
 *
 * 執行:npx tsx scripts/rebackfill-ev-filter.ts
 */
import fs from 'node:fs';
import { EVFilter } from '../src/analysis/ev-filter.ts';
import { normalizeSymbol } from '../src/trading/portfolio.ts';

function main(): void {
  const f = new EVFilter('data/evolution/ev-filter.json');

  // 1. 讀 EXP records
  const expLines = fs.readFileSync('data/exp/trades.jsonl', 'utf-8').trim().split('\n');
  const seen = new Set<string>();
  let expFed = 0;
  for (const l of expLines) {
    try {
      const r = JSON.parse(l);
      if (!r.symbol || r.pnlPct === undefined) continue;
      const sym = normalizeSymbol(String(r.symbol));
      const side = r.side === 'sell' ? 'sell' : 'buy';
      const pnlPct = Number(r.pnlPct);
      if (!Number.isFinite(pnlPct)) continue;
      const ts = Number(r.ts);
      const closedAt = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
      // dedup key: symbol|side|closedAt(秒)——EXP 同 live 嘅 id 唔同,但呢個 key 穩定
      const dedupKey = `${sym}|${side}|${Math.round(closedAt / 1000)}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      f.recordTrade(sym, side, pnlPct, closedAt);
      expFed++;
    } catch { /* skip */ }
  }

  // 2. 讀 live realTrades(portfolio-state.json)——補 EXP records 可能缺嘅最新 trade
  const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
  const realTrades = d.realTrades ?? [];
  let liveFed = 0;
  for (const t of realTrades) {
    const sym = normalizeSymbol(String(t.symbol ?? ''));
    const side = t.side === 'sell' ? 'sell' : 'buy';
    const pnlPct = Number(t.pnlPct);
    if (!sym || !Number.isFinite(pnlPct)) continue;
    const closedAt = Number(t.closedAt) || Number(t.openedAt) || Date.now();
    const dedupKey = `${sym}|${side}|${Math.round(closedAt / 1000)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    f.recordTrade(sym, side, pnlPct, closedAt);
    liveFed++;
  }

  f.markBackfillDone();
  f.save();

  console.log(`=== EV Filter 重跑 backfill 完成 ===`);
  console.log(`EXP records 餵入: ${expFed} 筆`);
  console.log(`live realTrades 補餵: ${liveFed} 筆(EXP 缺嘅最新 trade)`);
  console.log(`total keys: ${f.getStats().keys}`);

  // 3. 驗證 bnb|buy
  const bnb = f.getEVStats('bnb', 'buy');
  console.log(`\n=== 驗證 bnb|buy ===`);
  console.log(`bnb|buy: n=${bnb.n} EV=${(bnb.ev * 100).toFixed(2)}% → ${f.shouldBlockNegativeEV('bnb', 'buy').blocked ? 'BLOCK ✅' : 'PASS ❌'}`);

  // 4. 驗證其他關鍵 symbol
  console.log(`\n=== 驗證其他 symbol ===`);
  for (const sym of ['xyz:SILVER', 'xyz:SKHX', 'btc', 'xyz:MU']) {
    const s = f.getEVStats(sym, 'buy');
    if (s.n >= 10) {
      console.log(`  ${sym}|buy: n=${s.n} EV=${(s.ev * 100).toFixed(2)}% → ${f.shouldBlockNegativeEV(sym, 'buy').blocked ? 'BLOCK' : 'PASS'}`);
    } else {
      console.log(`  ${sym}|buy: n=${s.n} (冷啟動)`);
    }
  }
}

main();
