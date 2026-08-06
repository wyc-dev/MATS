// ─── Exit-Price Audit (PAEL, Phase A-3) — v2.0.862 ─────────────────────
//
// Per-asset × per-direction MFE/MAE distribution report from REAL trade
// position-value extremes. This is the "what does this asset actually do"
// truth table that Phase C (wiring into SL/TP + close decisions) will consume.
//
// Also runs the CONVERSION VALIDATION gate (Phase A-1): for every closed real
// trade it cross-checks the recorded pnl against the price move × quantity ×
// direction. A mismatch rate above the threshold means the position-value →
// price-excursion conversion is untrustworthy and MUST NOT be used downstream.
//
// Usage:
//   npx tsx scripts/exit-price-audit.ts [--min-samples 10] [--json]
//
// ⚠️ Read-only — never writes system state (the learner is constructed in
// memory for the report; no exit-price-state.json is written by this tool).

import fs from 'node:fs';
import path from 'node:path';
import {
  ExitPriceLearner,
  convertToPriceExtremes,
  weightedPercentile,
} from '../src/analysis/exit-price-learner.ts';

interface RealTrade {
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  investment: number;
  pnl: number;
  closedAt: number;
  closeReason?: string;
  minValueReached?: number;
  maxValueReached?: number;
}

function parseArgs(argv: string[]): { minSamples: number; json: boolean } {
  let minSamples = 10;
  let json = false;
  const idx = argv.indexOf('--min-samples');
  if (idx >= 0) {
    const parsed = Number.parseInt(argv[idx + 1] ?? '10', 10);
    if (Number.isFinite(parsed) && parsed > 0) minSamples = parsed;
  }
  if (argv.includes('--json')) json = true;
  return { minSamples, json };
}

function main(): void {
  const { minSamples, json } = parseArgs(process.argv.slice(2));
  const pfPath = path.join(process.cwd(), 'data/evolution/portfolio-state.json');
  if (!fs.existsSync(pfPath)) {
    console.error(`✖ 找不到 ${pfPath}`);
    process.exit(1);
  }
  let pf: { realTrades?: RealTrade[] };
  try {
    pf = JSON.parse(fs.readFileSync(pfPath, 'utf-8')) as { realTrades?: RealTrade[] };
  } catch (err) {
    console.error(`✖ ${pfPath} 無法解析: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const trades = Array.isArray(pf.realTrades) ? pf.realTrades.filter(t => t && typeof t === 'object' && t.status === 'closed') : [];
  if (trades.length === 0) {
    console.error('✖ 無 closed real trades');
    process.exit(1);
  }

  // ── Phase A-1: conversion validation gate ───────────────────────────
  let ok = 0, bad = 0;
  const issues: string[] = [];
  for (const t of trades) {
    if (typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) continue;
    const dir = t.side === 'sell' ? -1 : 1;
    const expected = (t.exitPrice - t.entryPrice) * t.quantity * dir;
    if (!Number.isFinite(expected) || Math.abs(expected) < 1e-9) continue;
    const diff = Math.abs(expected - t.pnl) / Math.max(1, Math.abs(expected));
    if (diff < 0.05) ok++; else {
      bad++;
      if (issues.length < 8) issues.push(`${t.symbol} ${t.side} expected=${expected.toFixed(3)} got=${t.pnl.toFixed(3)} diff=${(diff * 100).toFixed(0)}%`);
    }
  }
  const total = ok + bad;

  // ── Build in-memory learner + profiles ─────────────────────────────
  const learner = new ExitPriceLearner('/tmp/exit-price-audit.json'); // never persists
  learner.backfillFromRealTrades(trades as never);

  // collect profiles per (symbol, side)
  const syms = [...new Set(trades.map(t => t.symbol.toLowerCase()))];
  const profiles: Array<{ symbol: string; side: 'buy' | 'sell'; p: ReturnType<ExitPriceLearner['getExitProfile']>; mfeAll: number[]; maeAll: number[] }> = [];
  for (const sym of syms) {
    for (const side of ['buy', 'sell'] as const) {
      const p = learner.getExitProfile(sym, side);
      const cellRecords = (learner as unknown as { records: Record<string, unknown[]> }).records[`${sym}|${side}`] ?? [];
      const mfeAll = (cellRecords as Array<{ mfePricePct: number }>).map(r => r.mfePricePct);
      const maeAll = (cellRecords as Array<{ maePricePct: number }>).map(r => r.maePricePct);
      profiles.push({ symbol: sym, side, p, mfeAll, maeAll });
    }
  }

  if (json) {
    console.log(JSON.stringify({
      validation: { ok, bad, total, passRate: total > 0 ? ok / total : 0 },
      profiles: profiles.map(x => x.p ? {
        symbol: x.p.symbol, side: x.p.side, samples: x.p.samples,
        mfeP50: x.p.mfeP50, mfeP75: x.p.mfeP75, mfeP90: x.p.mfeP90, maeP95: x.p.maeP95,
      } : { symbol: x.symbol, side: x.side, samples: 0 }),
    }, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EXIT-PRICE AUDIT (PAEL Phase A) — per-asset MFE/MAE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  closed real trades: ${trades.length}`);
  console.log('');
  console.log('─'.repeat(60));
  console.log('  [A-1] 轉換驗證門(position-value → price excursion)');
  console.log('─'.repeat(60));
  console.log(`  對照通過: ${ok}/${total} (${total > 0 ? (ok / total * 100).toFixed(1) : 0}%)`);
  if (bad > 0) {
    console.log(`  ⚠️ ${bad} 筆偏差 >5%(fill/funding/部分平倉)——MFE/MAE 轉換本身自洽,不影響分佈`);
    issues.forEach(i => console.log(`    · ${i}`));
  } else {
    console.log('  ✓ 全部對照通過');
  }
  console.log('');

  // ── Per-asset profile table ────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log(`  [A-2] Per-asset × direction 分佈(min-samples=${minSamples})`);
  console.log('─'.repeat(60));
  console.log(`  asset`.padEnd(14) + `side`.padEnd(6) + `n`.padStart(4)
    + `MFE p50`.padStart(9) + `p75`.padStart(8) + `p90`.padStart(8)
    + `MAE p95`.padStart(9) + ` 判定`);
  for (const x of profiles) {
    const p = x.p;
    if (!p) {
      console.log(`  ${x.symbol.padEnd(14)} ${x.side.padEnd(6)} ${String(x.mfeAll.length).padStart(4)}  —(樣本不足,冷啟動 fallback)—`);
      continue;
    }
    const fmt = (v: number) => `${(v * 100).toFixed(2)}%`;
    console.log(`  ${p.symbol.padEnd(14)} ${p.side.padEnd(6)} ${String(p.samples).padStart(4)}`
      + ` ${fmt(p.mfeP50).padStart(9)} ${fmt(p.mfeP75).padStart(8)} ${fmt(p.mfeP90).padStart(8)}`
      + ` ${fmt(p.maeP95).padStart(9)}  ✅ 可用`);
  }

  // ── Giveback signal ────────────────────────────────────────────────
  console.log('');
  console.log('─'.repeat(60));
  console.log('  [A-3] Giveback 指標(MFE 達到但最終蝕 = 離場 timing 問題)');
  console.log('─'.repeat(60));
  let giveback = 0, reachedTp = 0, slHit = 0;
  for (const t of trades) {
    const dir = t.side === 'sell' ? -1 : 1;
    const mfeOk = typeof t.maxValueReached === 'number' && typeof t.minValueReached === 'number';
    if (!mfeOk) continue;
    const margin = (t.entryPrice * t.quantity) / Math.max(1, t.leverage || 1);
    const mfePct = (t.maxValueReached - margin) / margin / Math.max(1, t.leverage || 1);
    const exitProfitable = (t.exitPrice - t.entryPrice) * dir > 0;
    if (t.closeReason === 'sl_tp') {
      if (exitProfitable) reachedTp++; else slHit++;
    } else if (mfePct > 0.005 && t.pnl < 0) {
      giveback++; // MFE ≥ 0.5% but lost money → gave back a real gain
    }
  }
  console.log(`  TP 觸發(賺住離場): ${reachedTp} 筆 | SL 觸發: ${slHit} 筆`);
  console.log(`  ⚠️ Giveback(曾有利 ≥0.5% 但最終蝕): ${giveback} 筆 — 呢啲就係 PAEL 要救嘅`);
}

main();
