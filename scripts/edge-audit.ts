// ─── Component Edge Audit (v2.0.856) ─────────────────────────────────
//
// 階段 2:「組件 edge 審計」——用正確嘅 attribution 數據睇邊啲組件真正加 edge。
//
// 背景:
//   v2.0.856 修復咗 attribution signal contract bug(causal-uplift 對 SELL
//   信號被錯誤反轉)。本工具讀取 `data/evolution/component-attribution.json`,
//   分開 backfill(cycleId=0)vs live(cycleId>0)統計,並用 Wilson score
//   95% CI 判斷每個組件嘅 contribution 係咪統計上顯著 >0。
//
// 用法:
//   npx tsx scripts/edge-audit.ts [--live-only] [--min-samples 10]
//
// 輸出:
//   per-component: n / contribution / Wilson CI / 判定(加 edge / 減 edge / 樣本不足)
//   per-regime:   邊個 regime 邊個組件有 edge
//   signal 契約檢查: 驗證 causal signal 有冇再犯 v2.0.855-audit 嘅 sell 反轉錯
//
// ⚠️ 呢個係唯讀工具——唔改任何系統狀態。

import fs from 'node:fs';
import path from 'node:path';

interface AttributionRecord {
  componentId: string;
  tradeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  cycleId: number;
  signal: number;
  agreement: number;
  pnlPct: number;
  contribution: number;
  labelCleanliness: number;
  regime: string;
  riskProfile: string;
  timestamp: number;
}

interface CompAgg {
  n: number;
  contribSum: number;
  contribSumSq: number;
  positive: number;
  byRegime: Map<string, { n: number; contribSum: number; positive: number }>;
  bySide: Map<string, { n: number; contribSum: number }>;
}

function wilsonLower(positive: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const phat = positive / n;
  const denom = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / denom;
  const half = z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / denom;
  return Math.max(0, center - half);
}

function main(): void {
  const args = process.argv.slice(2);
  const liveOnly = args.includes('--live-only');
  const minSamplesIdx = args.indexOf('--min-samples');
  // v2.0.856-attack5 (I1): malformed --min-samples value ("abc") → parseInt
  // NaN → `n < NaN` is false → the sample floor silently DISABLED → every
  // component judged "enough samples" → misleading verdicts. Validate + warn.
  let minSamples = 10;
  if (minSamplesIdx >= 0) {
    const parsed = Number.parseInt(args[minSamplesIdx + 1] ?? '10', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      minSamples = parsed;
    } else {
      console.warn(`⚠️ 忽略無效 --min-samples 值 "${args[minSamplesIdx + 1] ?? '(missing)'}" — 使用預設 10`);
    }
  }

  const dataPath = path.join(process.cwd(), 'data/evolution/component-attribution.json');
  if (!fs.existsSync(dataPath)) {
    console.error(`✖ 找不到 ${dataPath} — 系統未運行過 attribution`);
    process.exit(1);
  }

  // v2.0.856-attack4 (F1): JSON.parse 冇 try/catch → truncated/corrupt file
  // (partial write, interrupted persist) throws SyntaxError → tool crashes
  // with an unhelpful stack trace. Wrap + report the specific file error.
  let raw: { records?: AttributionRecord[] };
  try {
    raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as { records?: AttributionRecord[] };
  } catch (err) {
    console.error(`✖ ${dataPath} 無法解析（可能係 interrupted write 導致 partial JSON）: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  請檢查檔案完整性，或等系統下次 atomic save 覆寫。');
    process.exit(1);
  }
  // v2.0.856-attack: defensive — malformed/corrupt file must not crash the
  // tool. records may be missing, non-array, or contain non-object entries.
  const rawRecords = raw.records;
  const all = Array.isArray(rawRecords) ? rawRecords.filter((r): r is AttributionRecord => !!r && typeof r === 'object') : [];
  const records = liveOnly ? all.filter(r => r.cycleId > 0) : all;
  const backfill = all.filter(r => r.cycleId === 0);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  COMPONENT EDGE AUDIT (v2.0.856)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  總記錄: ${all.length} (backfill=${backfill.length}, live=${all.length - backfill.length})`);
  console.log(`  審計範圍: ${liveOnly ? 'LIVE 只(cycleId>0)' : '全部'}`);
  console.log(`  樣本下限: ${minSamples} 筆先有統計判定`);
  console.log('');

  // ── Aggregation ──
  // v2.0.856-attack5 (I6): `contribSum += c` overflows to Infinity for
  // extreme contributions (1e308 + 1e308 = Infinity) → mean Infinity → bad
  // verdict. Use Welford-style online mean (sum/n via running mean) to stay
  // finite for any bounded input, and clamp per-record contribution (it is
  // [-1,1] by design — clamp defensively so corrupted data can't inflate).
  const clampContrib = (c: number): number => Math.max(-1, Math.min(1, c));
  const comps = new Map<string, CompAgg>();
  for (const r of records) {
    if (typeof r.contribution !== 'number' || !Number.isFinite(r.contribution)) continue;
    const c = clampContrib(r.contribution);
    let agg = comps.get(r.componentId);
    if (!agg) {
      agg = {
        n: 0, contribSum: 0, contribSumSq: 0, positive: 0,
        byRegime: new Map(), bySide: new Map(),
      };
      comps.set(r.componentId, agg);
    }
    agg.n++;
    agg.contribSum += c;
    agg.contribSumSq += c * c;
    if (c > 0) agg.positive++;

    const regime = r.regime || 'unknown';
    let rg = agg.byRegime.get(regime);
    if (!rg) { rg = { n: 0, contribSum: 0, positive: 0 }; agg.byRegime.set(regime, rg); }
    rg.n++; rg.contribSum += c; if (c > 0) rg.positive++;

    const side = typeof r.side === 'string' && (r.side === 'buy' || r.side === 'sell')
      ? r.side
      : (r.side || '?');
    let sd = agg.bySide.get(side);
    if (!sd) { sd = { n: 0, contribSum: 0 }; agg.bySide.set(side, sd); }
    sd.n++; sd.contribSum += c;
  }

  // ── Per-component report ──
  console.log('─'.repeat(60));
  console.log('  每個組件嘅 edge(contribution > 0 = 加 edge)');
  console.log('─'.repeat(60));
  const sorted = [...comps.entries()].sort((a, b) => b[1].contribSum / b[1].n - a[1].contribSum / a[1].n);
  for (const [comp, agg] of sorted) {
    const avg = agg.contribSum / agg.n;
    const wilsonLB = wilsonLower(agg.positive, agg.n);
    const verdict = agg.n < minSamples
      ? '⚠️ 樣本不足'
      : wilsonLB > 0.5
        ? '✅ 加 edge'
        : agg.contribSum < 0
          ? '❌ 減 edge'
          : '➖ 中性';
    const sd = Math.sqrt(Math.max(0, agg.contribSumSq / agg.n - avg * avg));
    console.log(`\n  ${comp}`);
    console.log(`    n=${agg.n} | avg contribution=${avg.toFixed(4)}±${sd.toFixed(4)} | positive rate=${(agg.positive / agg.n * 100).toFixed(0)}% | Wilson LB=${wilsonLB.toFixed(3)}`);
    console.log(`    判定: ${verdict}`);
    if (agg.bySide.size > 0) {
      const sides = [...agg.bySide.entries()].map(([s, v]) => `${s}:${(v.contribSum / v.n).toFixed(3)} (n=${v.n})`).join(' | ');
      console.log(`    bySide: ${sides}`);
    }
  }

  // ── Per-regime report ──
  console.log('');
  console.log('─'.repeat(60));
  console.log('  Per-regime edge(所有組件合併)');
  console.log('─'.repeat(60));
  const regimes = new Map<string, { n: number; contribSum: number; positive: number }>();
  for (const [comp, agg] of comps) {
    for (const [regime, rg] of agg.byRegime) {
      let r = regimes.get(regime);
      if (!r) { r = { n: 0, contribSum: 0, positive: 0 }; regimes.set(regime, r); }
      r.n += rg.n; r.contribSum += rg.contribSum; r.positive += rg.positive;
    }
  }
  for (const [regime, r] of [...regimes.entries()].sort((a, b) => b[1].contribSum / b[1].n - a[1].contribSum / a[1].n)) {
    const avg = r.contribSum / r.n;
    const verdict = r.n < minSamples
      ? '⚠️ 樣本不足'
      : avg > 0.05 ? '✅' : avg < -0.05 ? '❌' : '➖';
    console.log(`  ${regime.padEnd(20)} n=${String(r.n).padStart(4)} avg=${avg.toFixed(4)} ${verdict}`);
  }

  // ── Per-regime × side direction expectancy (tradeHistory ground truth) ──
  // Phase 0.2 (v2.0.861): 從 evolution-state.json 嘅 tradeHistory 讀取每筆
  // real/simulated 交易嘅 (regime, side, pnl),聚合 per-regime direction
  // expectancy — 呢個係系統應該適應嘅「地面真相」。若某 (regime, side)
  // 實際期望值係負而系統仍交易 → 確認 regime-adaptation gap。
  console.log('');
  console.log('─'.repeat(60));
  console.log('  Per-regime × side direction expectancy(tradeHistory ground truth)');
  console.log('─'.repeat(60));
  const evoPath = path.join(process.cwd(), 'data/evolution/evolution-state.json');
  if (fs.existsSync(evoPath)) {
    let evo: { tradeHistory?: Array<Record<string, unknown>> } = {};
    try {
      evo = JSON.parse(fs.readFileSync(evoPath, 'utf-8')) as { tradeHistory?: Array<Record<string, unknown>> };
    } catch (err) {
      console.log(`  ⚠️ evolution-state.json 無法解析: ${err instanceof Error ? err.message : String(err)}`);
    }
    const history = Array.isArray(evo.tradeHistory) ? evo.tradeHistory : [];
    const cellKey = (regime: string, side: string): string => `${regime}|${side}`;
    const cells = new Map<string, { n: number; wins: number; pnl: number; pnlSumSq: number }>();
    for (const h of history) {
      const dec = (h['decision'] as { action?: string } | undefined);
      const action = (dec?.action ?? '').toLowerCase();
      if (action !== 'buy' && action !== 'sell') continue;
      const regime = typeof h['regime'] === 'string' && h['regime'].length > 0 ? h['regime'] : 'unknown';
      const pnlRaw = h['realisedPnl'] ?? h['simulatedPnl'];
      const pnl = typeof pnlRaw === 'number' && Number.isFinite(pnlRaw) ? pnlRaw : NaN;
      if (!Number.isFinite(pnl)) continue;
      const key = cellKey(regime, action);
      let c = cells.get(key);
      if (!c) { c = { n: 0, wins: 0, pnl: 0, pnlSumSq: 0 }; cells.set(key, c); }
      c.n++; if (pnl > 0) c.wins++; c.pnl += pnl; c.pnlSumSq += pnl * pnl;
    }
    if (cells.size === 0) {
      console.log('  (tradeHistory 無 buy/sell 交易記錄)');
    } else {
      const sorted = [...cells.entries()].sort((a, b) => b[1].n - a[1].n);
      console.log(`  regime`.padEnd(18) + `side`.padEnd(6) + `n`.padStart(5) + `winRate`.padStart(8) + `avgPnl`.padStart(9) + `totalPnl`.padStart(9) + ` 判定`);
      for (const [key, c] of sorted) {
        const [regime, side] = key.split('|');
        const winRate = c.wins / c.n;
        const avg = c.pnl / c.n;
        const variance = Math.max(0, c.pnlSumSq / c.n - avg * avg);
        const std = Math.sqrt(variance);
        const tStat = std > 1e-12 ? avg / (std / Math.sqrt(c.n)) : 0;
        const verdict = c.n < 10
          ? '⚠️ 樣本不足'
          : Math.abs(tStat) >= 2
            ? (avg > 0 ? '✅ 正期望' : '❌ 負期望')
            : (avg > 0 ? '➖ 正(未顯著)' : '➖ 負(未顯著)');
        console.log(`  ${(regime || '?').padEnd(18)} ${side.padEnd(6)} ${String(c.n).padStart(5)} ${(winRate * 100).toFixed(0).padStart(6)}% ${avg.toFixed(4).padStart(9)} ${c.pnl.toFixed(3).padStart(9)} ${verdict}`);
      }
    }
  } else {
    console.log('  (evolution-state.json 不存在 — 跳過 tradeHistory expectancy)');
  }

  // ── Per-regime × side signal contribution (attribution) ────────────────
  // 每個 (regime, side) 嘅組件訊號平均 contribution:邊個 regime 邊個方向
  // 嘅統計訊號(OLR/causal 等)真正加 edge。
  console.log('');
  console.log('─'.repeat(60));
  console.log('  Per-regime × side signal contribution(attribution records)');
  console.log('─'.repeat(60));
  const rsCells = new Map<string, { n: number; contribSum: number; positive: number }>();
  for (const r of records) {
    if (typeof r.contribution !== 'number' || !Number.isFinite(r.contribution)) continue;
    const side = typeof r.side === 'string' && (r.side === 'buy' || r.side === 'sell') ? r.side : '?';
    const regime = r.regime || 'unknown';
    const key = `${regime}|${side}`;
    let c = rsCells.get(key);
    if (!c) { c = { n: 0, contribSum: 0, positive: 0 }; rsCells.set(key, c); }
    c.n++; c.contribSum += clampContrib(r.contribution); if (clampContrib(r.contribution) > 0) c.positive++;
  }
  if (rsCells.size === 0) {
    console.log('  (無 attribution 記錄)');
  } else {
    const sorted = [...rsCells.entries()].sort((a, b) => b[1].n - a[1].n);
    console.log(`  regime`.padEnd(18) + `side`.padEnd(6) + `n`.padStart(5) + `avgContrib`.padStart(11) + `posRate`.padStart(8) + ` 判定`);
    for (const [key, c] of sorted) {
      const [regime, side] = key.split('|');
      const avg = c.contribSum / c.n;
      const posRate = c.positive / c.n;
      const verdict = c.n < minSamples
        ? '⚠️ 樣本不足'
        : avg > 0.05 ? '✅ 加 edge' : avg < -0.05 ? '❌ 減 edge' : '➖ 中性';
      console.log(`  ${(regime || '?').padEnd(18)} ${side.padEnd(6)} ${String(c.n).padStart(5)} ${avg.toFixed(4).padStart(11)} ${(posRate * 100).toFixed(0).padStart(6)}% ${verdict}`);
    }
  }

  // ── Signal contract check (v2.0.855-audit regression) ──
  console.log('');
  console.log('─'.repeat(60));
  console.log('  Signal contract 檢查(v2.0.855-audit regression)');
  console.log('─'.repeat(60));
  // causal-uplift: signal 應該同 side 一致 —— SELL 記錄嘅 signal 應該偏向 <0.5(如果 alpha 正)
  // 檢查: SELL 記錄中 signal>0.5 嘅比例(舊 bug 會令佢偏高)
  const causal = records.filter(r => r.componentId === 'causal-uplift');
  if (causal.length > 0) {
    const sellCausal = causal.filter(r => r.side === 'sell');
    const highSignalSell = sellCausal.filter(r => r.signal > 0.5).length;
    console.log(`  causal-uplift: ${causal.length} 筆 (SELL=${sellCausal.length})`);
    console.log(`  SELL 記錄 signal>0.5 比例: ${sellCausal.length > 0 ? (highSignalSell / sellCausal.length * 100).toFixed(0) : 0}%`);
    if (sellCausal.length > 0 && highSignalSell / sellCausal.length > 0.6) {
      console.log('  ⚠️ 高比例 SELL signal>0.5 — 可能仍受舊 bug 影響(v2.0.856 後新記錄應修正)');
    } else {
      console.log('  ✓ SELL signal 分佈合理');
    }
  } else {
    console.log('  (無 causal-uplift live 記錄)');
  }

  console.log('');
  console.log('  ⚠️ v2.0.856 前嘅記錄(尤其 causal SELL)可能受 signal bug 污染 —');
  console.log('     判讀 edge 應以 v2.0.856 後新累積嘅記錄為準。');
}

main();
