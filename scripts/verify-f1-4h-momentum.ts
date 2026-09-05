/**
 * verify-f1-4h-momentum.ts
 * 目的: 驗證候選 C——「4h 動量 + persistence 分類」嘅組合成效（三關）。
 * 紀律: 零 look-ahead——只用 entryMarketFeatures.momentumLong（開倉時存檔）。
 * 注意: persistence 分類係 runtime 動態計算（唔存檔），呢度用 CHANGELOG 嘅
 *       靜態分類（08-25）做 proxy: persistent_bear = SNDK/SKHX/DRAM,
 *       range = BTC/BNB/GOLD。動態分類可能唔同——proxy 係近似。
 */
import * as fs from 'fs';
import * as path from 'path';

interface Trade {
  symbol?: string;
  side?: string;
  pnlPct?: number;
  entryMarketFeatures?: { momentumLong?: number; momentumShort?: number };
  openedAt?: number;
  closedAt?: number;
}

// CHANGELOG 靜態 persistence 分類（08-25 proxy）
const PERSISTENT_BEAR = new Set(['xyz:sndk', 'xyz:skhx', 'xyz:dram']);
const RANGE = new Set(['btc', 'bnb', 'xyz:gold']);

function persistenceOf(symbol: string): 'persistent_bear' | 'range' | 'unknown' {
  const s = (symbol ?? '').toLowerCase();
  if (PERSISTENT_BEAR.has(s)) return 'persistent_bear';
  if (RANGE.has(s)) return 'range';
  return 'unknown';
}

function loadTrades(): Trade[] {
  const p = path.resolve(process.cwd(), 'data/evolution/portfolio-state.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  // V3+V8 硬化（attack-round6 + audit-round2）: object guard + pnl **必須係 finite number**——
  // 舊條件「!== 'number' || isFinite」會放行垃圾 string/undefined（邏輯反）→ 淨改善 NaN。
  // object guard / 非 number pnl 全部被隔離。
  const all = (s.realTrades ?? [])
    .filter((t: any) => t && typeof t === 'object' && (t.status === undefined || t.status === 'closed'));
  const isolated = all.length - all.filter((t: any) => typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct)).length;
  if (isolated > 0) console.log(`⚠️ [data-quality] 隔離 ${isolated} 單非 finite pnlPct（persisted 污染——唔入計算）`);
  return all.filter((t: any) => typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct));
}

function main() {
  const trades = loadTrades();
  const fmt = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ');

  // 逆勢 BUY（m4h < -0.5%）
  const counterBuy = trades.filter(
    (t) => t.side === 'buy' && t.entryMarketFeatures && typeof t.entryMarketFeatures.momentumLong === 'number' && t.entryMarketFeatures.momentumLong < -0.005,
  );

  console.log(`=== 候選 C: 「persistent_bear + m4h < -0.5% → block BUY」驗證 ===\n`);
  console.log(`逆勢 BUY (m4h < -0.5%) n=${counterBuy.length}\n`);

  let blockedSum = 0; // Σ pnl（所有被 block 嘅單）
  let blockedN = 0;
  let falsePositiveSum = 0; // 誤傷（block 咗但係贏單——錯過盈利，純資訊）
  let falsePositiveN = 0;

  for (const t of counterBuy) {
    const pers = persistenceOf(t.symbol ?? '');
    const m4h = (t.entryMarketFeatures!.momentumLong! * 100).toFixed(2);
    const pnl = (t.pnlPct! * 100).toFixed(2);
    const wouldBlock = pers === 'persistent_bear';
    const isWin = t.pnlPct! > 0;

    if (wouldBlock) {
      blockedSum += t.pnlPct! * 100;
      blockedN++;
      if (isWin) {
        falsePositiveSum += t.pnlPct! * 100;
        falsePositiveN++;
      }
    }

    console.log(
      `${fmt(t.openedAt!)} ${(t.symbol ?? '?').padEnd(10)} pnl=${pnl.padEnd(8)} m4h=${m4h.padEnd(8)} pers=${pers.padEnd(16)} ${wouldBlock ? (isWin ? '❌ 誤傷' : '✅ block 啱') : '— 唔 block'}`,
    );
  }

  console.log(`\n=== 三關裁決 ===`);
  // 2026-09-05 修正（PLAN_tool-integrity-fix）: block 帶嚟嘅「改善」= −Σpnl——
  // block 蝕單（pnl<0）慳返正數 / block 贏單（pnl>0）誤傷負數。
  // 原 bug: blockedSum 直接當改善（符號反）+ 誤傷喺 blockedSum 之後再減一次（雙重計）。
  const improvement = -blockedSum; // = 挽回虧損 + 錯過盈利（已含誤傷）
  console.log(`關1 (Δ): block 挽回虧損 ${blockedSum < 0 ? `+${(-blockedSum).toFixed(2)}` : blockedSum.toFixed(2)}%（${blockedN} 單）`);
  console.log(`  誤傷: ${falsePositiveN} 單贏單，錯過盈利 ${falsePositiveSum.toFixed(2)}%（已含喺 Δ 內——單次計）`);
  const net = improvement;
  console.log(`  淨 Δ = ${net.toFixed(2)}%`);

  // 關2: 被 block 嘅單，兩半
  const blocked = counterBuy.filter((t) => persistenceOf(t.symbol ?? '') === 'persistent_bear');
  const h1 = blocked.slice(0, Math.ceil(blocked.length / 2));
  const h2 = blocked.slice(Math.ceil(blocked.length / 2));
  const s1 = h1.reduce((a, t) => a + t.pnlPct! * 100, 0);
  const s2 = h2.reduce((a, t) => a + t.pnlPct! * 100, 0);
  console.log(`關2 (兩半): 前一半 ${s1.toFixed(2)}% / 後一半 ${s2.toFixed(2)}%`);

  // 關3: within-symbol
  const bySym: Record<string, { n: number; sum: number; win: number }> = {};
  for (const t of blocked) {
    const k = t.symbol ?? '?';
    if (!bySym[k]) bySym[k] = { n: 0, sum: 0, win: 0 };
    bySym[k].n++;
    bySym[k].sum += t.pnlPct! * 100;
    if (t.pnlPct! > 0) bySym[k].win++;
  }
  console.log(`關3 (within-symbol):`);
  for (const [k, v] of Object.entries(bySym)) {
    console.log(`  ${k.padEnd(12)} n=${v.n} WR=${((v.win / v.n) * 100).toFixed(0)}% Σ=${v.sum.toFixed(2)}%`);
  }

  console.log(`\n=== 裁決 ===`);
  if (falsePositiveN > 0) {
    console.log(`❌ 否決——有 ${falsePositiveN} 單誤傷（贏單被 block），信號唔乾淨（SNDK 贏單係 counterexample）`);
  } else if (net > 0) {
    console.log(`✅ 過——淨 Δ ${net.toFixed(2)}%，零誤傷`);
  } else {
    console.log(`❌ 否決——淨 Δ ${net.toFixed(2)}% 唔正`);
  }
}

main();
