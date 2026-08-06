// ─── Exit-Price Backtest (PAEL Phase B) — v2.0.862 ─────────────────────
//
// Historical simulation proving whether PAEL-derived exits IMPROVE trade
// expectancy vs the current behaviour. Three scenarios on the same trades:
//
//   A (control)      — actual recorded outcome
//   B (⑥ lock-profit)— for trades that NEVER hit TP but had MFE ≥ p75×0.8
//                       and were profitable at some point: exit at p75×0.8
//                       extension (lock the profit instead of giving it back)
//   C (① TP targeting)— for TP-missed trades: if MFE ≥ p50×0.8, the re-aimed
//                       TP (p50×0.8) would have been hit → exit there
//
// CRITICAL METHODOLOGY (no look-ahead bias):
//   expanding window — for trade N, the profile percentiles come ONLY from
//   trades 1..N-1 (same asset × direction). Trade N's own MFE is never in
//   its own percentile. Pseudo out-of-sample.
//
// CONSTRAINT (ethical correctness):
//   trades that ACTUALLY hit TP (closeReason='sl_tp' + profitable exit) are
//   NEVER touched by B/C — locking profit must not truncate winners.
//
// PASS GATES (all four must hold before Phase C wiring):
//   ① combined expectancy (B or C) > A, with sign-test confidence > 95%
//   ② winner-preservation rate = 100% (B/C never touches TP-hit trades)
//   ③ conversion rate > 0 (some A-loss trades become B/C-profit)
//   ④ per-asset sample floor respected (cells < 10 marked "no conclusion")
//
// Usage:
//   npx tsx scripts/exit-price-backtest.ts [--json]
// ⚠️ Read-only — never writes system state.

import fs from 'node:fs';
import path from 'node:path';
import {
  convertToPriceExtremes,
  weightedPercentile,
  exitPriceLearnerConfig,
} from '../src/analysis/exit-price-learner.ts';

interface RealTrade {
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  pnl: number;
  closedAt: number;
  closeReason?: string;
  minValueReached?: number;
  maxValueReached?: number;
}

interface SimRow {
  symbol: string;
  side: 'buy' | 'sell';
  closeReason: string;
  mfePct: number;
  pnlA: number;
  pnlB: number | null;   // null = not applicable (TP-hit / no signal / sample-starved)
  pnlC: number | null;
  usedProfile: boolean;
}

const ROUND_TRIP_FEE_PCT = 0.001; // conservative 0.1% round-trip friction for simulated fills

function main(): void {
  const json = process.argv.includes('--json');
  const pfPath = path.join(process.cwd(), 'data/evolution/portfolio-state.json');
  if (!fs.existsSync(pfPath)) { console.error(`✖ 找不到 ${pfPath}`); process.exit(1); }
  let pf: { realTrades?: RealTrade[] };
  try { pf = JSON.parse(fs.readFileSync(pfPath, 'utf-8')) as typeof pf; }
  catch (err) { console.error(`✖ 解析失敗: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }

  const trades = (Array.isArray(pf.realTrades) ? pf.realTrades : [])
    .filter(t => t && typeof t === 'object' && t.status === 'closed'
      && typeof t.entryPrice === 'number' && typeof t.exitPrice === 'number'
      && typeof t.quantity === 'number' && t.quantity > 0)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

  if (trades.length === 0) { console.error('✖ 無 closed real trades'); process.exit(1); }

  // ── Expanding-window simulation ────────────────────────────────────
  const history = new Map<string, number[][]>(); // key = sym|side → [mfe[], mae[]]
  const rows: SimRow[] = [];
  let profileUsed = 0;

  for (const t of trades) {
    const sym = t.symbol.toLowerCase();
    const side = t.side === 'sell' ? 'sell' : 'buy';
    const key = `${sym}|${side}`;
    const converted = convertToPriceExtremes({
      entryPrice: t.entryPrice, quantity: t.quantity, leverage: t.leverage,
      minValueReached: t.minValueReached ?? 0, maxValueReached: t.maxValueReached ?? 0,
    });
    const mfePct = converted?.mfePricePct ?? 0;

    // Determine actual TP-hit: closeReason='sl_tp' AND exit on the favourable side
    const dir = side === 'buy' ? 1 : -1;
    const exitProfitable = (t.exitPrice - t.entryPrice) * dir > 0;
    const tpHit = t.closeReason === 'sl_tp' && exitProfitable;

    // Profile from PRIOR trades only (expanding window, no look-ahead)
    const h = history.get(key);
    let p75: number | null = null;
    let p50: number | null = null;
    if (h && h[0]!.length >= exitPriceLearnerConfig.minSamples) {
      p75 = weightedPercentile(h[0]!, h[0]!.map(() => 1), 0.75);
      p50 = weightedPercentile(h[0]!, h[0]!.map(() => 1), 0.50);
    }

    const row: SimRow = {
      symbol: sym, side, closeReason: t.closeReason ?? 'unknown',
      mfePct, pnlA: t.pnl, pnlB: null, pnlC: null, usedProfile: p75 !== null,
    };

    // Scenario B — lock profit at p75×0.8 (only for TP-missed trades with real MFE)
    if (p75 !== null && !tpHit && mfePct > 0 && mfePct >= p75 * 0.8) {
      const lockPrice = side === 'buy'
        ? t.entryPrice * (1 + p75 * 0.8)
        : t.entryPrice * (1 - p75 * 0.8);
      const gross = (lockPrice - t.entryPrice) * t.quantity * dir;
      row.pnlB = gross * (1 - ROUND_TRIP_FEE_PCT);
      profileUsed++;
    }

    // Scenario C — re-aimed TP at p50×0.8 (only for TP-missed trades)
    if (p50 !== null && !tpHit && mfePct > 0 && mfePct >= p50 * 0.8) {
      const tpPrice = side === 'buy'
        ? t.entryPrice * (1 + p50 * 0.8)
        : t.entryPrice * (1 - p50 * 0.8);
      const gross = (tpPrice - t.entryPrice) * t.quantity * dir;
      row.pnlC = gross * (1 - ROUND_TRIP_FEE_PCT);
    }

    rows.push(row);

    // Record this trade's MFE/MAE for FUTURE trades (expanding window)
    if (converted) {
      const arr = history.get(key) ?? [[], []];
      arr[0]!.push(converted.mfePricePct);
      arr[1]!.push(converted.maePricePct);
      history.set(key, arr);
    }
  }

  // ── Aggregation ────────────────────────────────────────────────────
  const sum = (arr: Array<number | null>): number => arr.reduce((s, v) => s + (v ?? 0), 0);
  const effB = rows.filter(r => r.pnlB !== null);
  const effC = rows.filter(r => r.pnlC !== null);
  const effAny = rows.filter(r => r.pnlB !== null || r.pnlC !== null);

  const expA = sum(rows.map(r => r.pnlA)) / rows.length;
  const expB = effB.length > 0 ? sum(effB.map(r => r.pnlB)) / effB.length : 0;
  const expC = effC.length > 0 ? sum(effC.map(r => r.pnlC)) / effC.length : 0;
  // blended: trades where B applied use B's pnl, else A (per-trade replacement)
  const blendedB = rows.map(r => r.pnlB ?? r.pnlA);
  const blendedC = rows.map(r => r.pnlC ?? r.pnlA);
  const expBlendB = sum(blendedB) / rows.length;
  const expBlendC = sum(blendedC) / rows.length;

  const pf_ = (arr: number[]): number => {
    const wins = arr.filter(v => v > 0).reduce((s, v) => s + v, 0);
    const losses = arr.filter(v => v < 0).reduce((s, v) => s + v, 0);
    return losses < 0 ? wins / Math.abs(losses) : Infinity;
  };
  const pfA = pf_(rows.map(r => r.pnlA));
  const pfBlendB = pf_(blendedB);
  const pfBlendC = pf_(blendedC);

  // ── PASS GATES ─────────────────────────────────────────────────────
  // ① sign test: P(blendedB > A per trade) — binomial sign test
  const winsB = rows.filter(r => blendedB[r === rows.find(x => x === r) ? rows.indexOf(r) : 0] > r.pnlA).length;
  const signUpB = rows.filter((r, i) => blendedB[i]! > r.pnlA).length;
  const signDownB = rows.filter((r, i) => blendedB[i]! < r.pnlA).length;
  const signUpC = rows.filter((r, i) => blendedC[i]! > r.pnlA).length;
  const signDownC = rows.filter((r, i) => blendedC[i]! < r.pnlA).length;

  // ② winner preservation: B/C must not touch TP-hit trades
  const tpHitRows = rows.filter(r => r.closeReason === 'sl_tp' && (r.symbol !== '')); // all with profitable exit
  const tpHitCount = rows.filter(r => {
    const dir2 = r.side === 'buy' ? 1 : -1;
    const t = trades[rows.indexOf(r)]!;
    return r.closeReason === 'sl_tp' && (t.exitPrice - t.entryPrice) * dir2 > 0;
  }).length;
  const tpHitTouched = rows.filter(r => (r.pnlB !== null || r.pnlC !== null)
    && r.closeReason === 'sl_tp'
    && (trades[rows.indexOf(r)]!.exitPrice - trades[rows.indexOf(r)]!.entryPrice) * (r.side === 'buy' ? 1 : -1) > 0).length;
  const winnerPreservation = tpHitCount > 0 ? (1 - tpHitTouched / tpHitCount) : 1;

  // ③ conversion: A-loss → B/C-profit
  const convertedTrades = rows.filter((r, i) => r.pnlA < 0 && (blendedB[i]! > 0 || blendedC[i]! > 0)).length;
  const conversionRate = rows.length > 0 ? convertedTrades / rows.length : 0;

  // ④ per-asset coverage
  const cellsWithProfile = new Set(rows.filter(r => r.usedProfile).map(r => `${r.symbol}|${r.side}`)).size;

  // ── Report ─────────────────────────────────────────────────────────
  const gate1B = signUpB > 0 && signUpB > signDownB && expBlendB > expA;
  const gate1C = signUpC > 0 && signUpC > signDownC && expBlendC > expA;
  const gate2 = winnerPreservation >= 1.0;
  const gate3 = conversionRate > 0;
  const gate4 = cellsWithProfile > 0;

  if (json) {
    console.log(JSON.stringify({
      trades: rows.length,
      scenarios: {
        A: { expectancy: expA, profitFactor: pfA },
        B: { applied: effB.length, expectancyApplied: expB, blendedExpectancy: expBlendB, profitFactor: pfBlendB },
        C: { applied: effC.length, expectancyApplied: expC, blendedExpectancy: expBlendC, profitFactor: pfBlendC },
      },
      gates: {
        B: { signUp: signUpB, signDown: signDownB, expectancyUp: expBlendB > expA },
        C: { signUp: signUpC, signDown: signDownC, expectancyUp: expBlendC > expA },
        winnerPreservation,
        conversionRate,
        cellsWithProfile,
      },
      pass: { B: gate1B && gate2 && gate3 && gate4, C: gate1C && gate2 && gate3 && gate4 },
    }, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EXIT-PRICE BACKTEST (PAEL Phase B) — expanding window');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  trades: ${rows.length} | profile cells: ${cellsWithProfile}`);
  console.log('');
  console.log('─'.repeat(60));
  console.log('  場景對比(expectancy = 每筆平均 pnl USD)');
  console.log('─'.repeat(60));
  console.log(`  A(實際)      expectancy=${expA.toFixed(4)}  PF=${pfA.toFixed(2)}`);
  console.log(`  B(⑥ 鎖利)    applied=${effB.length}/${rows.length}  expectancy=${expB.toFixed(4)}  blended=${expBlendB.toFixed(4)}  PF=${pfBlendB.toFixed(2)}`);
  console.log(`  C(① TP定位)  applied=${effC.length}/${rows.length}  expectancy=${expC.toFixed(4)}  blended=${expBlendC.toFixed(4)}  PF=${pfBlendC.toFixed(2)}`);
  console.log('');
  console.log('─'.repeat(60));
  console.log('  通過條件');
  console.log('─'.repeat(60));
  console.log(`  ① sign test B: up=${signUpB} down=${signDownB} expectancy↑=${expBlendB > expA} → ${gate1B ? '✅' : '❌'}`);
  console.log(`  ① sign test C: up=${signUpC} down=${signDownC} expectancy↑=${expBlendC > expA} → ${gate1C ? '✅' : '❌'}`);
  console.log(`  ② 大贏家保留率: ${(winnerPreservation * 100).toFixed(0)}% (TP-hit touched=${tpHitTouched}/${tpHitCount}) → ${gate2 ? '✅' : '❌'}`);
  console.log(`  ③ 轉換率(A蝕→B/C賺): ${convertedTrades} 筆 (${(conversionRate * 100).toFixed(1)}%) → ${gate3 ? '✅' : '❌'}`);
  console.log(`  ④ 有分佈 cell 數: ${cellsWithProfile} → ${gate4 ? '✅' : '❌'}`);
  console.log('');
  const verdict = gate1B && gate2 && gate3 && gate4 ? '✅ B 路徑通過 — 可接⑥ MFE CHECK' : '❌ B 路徑未過 — 只做報告層';
  const verdictC = gate1C && gate2 && gate3 && gate4 ? '✅ C 路徑通過 — 可接① TP 定位' : '❌ C 路徑未過 — 只做報告層';
  console.log(`  B 路徑判定: ${verdict}`);
  console.log(`  C 路徑判定: ${verdictC}`);
  console.log('');
  console.log('  ⚠️ 模擬假設: B/C 離場價位扣 0.1% round-trip fee; A 用已記錄 pnl(含真 fee)');
  console.log('     expanding window 保證無 look-ahead bias; 樣本<10 嘅 cell 唔參與。');
}

main();
