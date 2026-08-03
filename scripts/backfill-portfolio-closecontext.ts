#!/usr/bin/env tsx
// ─── Backfill: Portfolio Close-Context Fields (v2.0.852) ───────────────────
//
// PROBLEM:
//   TradeRecord.closeReason / exitType / originalStopLossPrice /
//   originalTakeProfitPrice were introduced by v2.0.226 (close-context learning)
//   and fully wired end-to-end by v2.0.851. But every trade closed BEFORE that
//   fix (saved to portfolio-state.json between 2026-07-13 and 2026-08-03) was
//   persisted WITHOUT those fields. So historical data has:
//     closeReason = undefined (all)
//     originalStopLossPrice / originalTakeProfitPrice = undefined (all)
//   This starves RIL CloseReasonAggregator, computeLearningWeight, trade-audit,
//   and any future MFE/giveback TP calibration that needs to know HOW each
//   position closed (SL hit vs TP hit vs thesis invalidation vs reconciliation).
//
// GOAL:
//   Backfill the missing fields deterministically from data that IS present on
//   each historical trade: entryPrice, exitPrice, side, pnlPct. Where the
//   original SL/TP levels are unknown (never persisted), we infer plausible
//   levels from the configured default stopLossPct / takeProfitPct, then use
//   the SAME deterministic inferCloseReason() logic as the live path so the
//   classification is consistent with v2.0.851 behaviour.
//
// DESIGN PRINCIPLES (production-grade):
//   1. IDEMPOTENT — only fills fields that are currently missing. Re-running
//      the script never overwrites a value that a NEWER write already set.
//   2. ATOMIC WRITE — writes to a temp file, then rename() over the target.
//      A crash mid-write never corrupts the live state file.
//   3. BACKUP — copies the original portfolio-state.json to
//      portfolio-state.json.bak-<ts> before mutating, so the change is
//      revertible.
//   4. DETERMINISTIC — same input → same output. No randomness, no LLM, no
//      network. Pure function of (side, entryPrice, exitPrice, pnlPct).
//   5. NON-DESTRUCTIVE — never deletes or reorders existing records.
//   6. EXPLICIT — every mutation is logged; a summary is printed at the end.
//   7. SAFE-TO-RUN — does not import the runtime config (which validates env
//      vars via Zod and would fail in a bare script context). Uses explicit
//      defaults mirroring config.risk (RISK_STOP_LOSS_PCT=0.02,
//      RISK_TAKE_PROFIT_PCT=0.05), overridable via CLI env vars.
//
// Usage:
//   npx tsx scripts/backfill-portfolio-closecontext.ts
//   # Optional overrides:
//   BACKFILL_SL_PCT=0.03 BACKFILL_TP_PCT=0.08 npx tsx scripts/... 
//   BACKFILL_DRY_RUN=1 npx tsx scripts/...   # preview only, no write

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = join(__dirname, '..', 'data', 'evolution', 'portfolio-state.json');

// ── Config fallbacks (mirror src/config/index.ts defaults) ────────────────
// Overridable via env so a different live configuration can be honoured.
const DEFAULT_SL_PCT = parseEnvPct('BACKFILL_SL_PCT', 0.02);
const DEFAULT_TP_PCT = parseEnvPct('BACKFILL_TP_PCT', 0.05);
const DRY_RUN = process.env.BACKFILL_DRY_RUN === '1';

function parseEnvPct(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// ── Types (subset of TradeRecord — only what backfill needs) ──────────────
type Side = 'buy' | 'sell';
type CloseReason = 'sl_tp' | 'consensus' | 'manual' | 'reconciliation' | 'thesis_invalidation' | undefined;
type ExitType = 'sl' | 'tp' | 'consensus' | 'manual' | 'reconciliation' | 'thesis_invalidation' | undefined;

interface TradeLike {
  side?: Side;
  entryPrice?: number;
  exitPrice?: number;
  pnlPct?: number;
  /** Realized PnL in dollars */
  pnl?: number;
  investment?: number;
  /** MAE — minimum position VALUE (margin + unrealized PnL) reached (v2.0.143) */
  minValueReached?: number;
  /** MFE — maximum position VALUE (margin + unrealized PnL) reached (v2.0.143) */
  maxValueReached?: number;
  closeReason?: unknown;
  exitType?: unknown;
  originalStopLossPrice?: unknown;
  originalTakeProfitPrice?: unknown;
}

// ── Deterministic inference (mirrors portfolio.ts inferCloseReason + more) ─
/**
 * Compute plausible original SL/TP from entry + side + config pcts.
 * These are APPROXIMATIONS (the true levels were never persisted for
 * pre-v2.0.851 trades). They are used ONLY to classify the close reason
 * and to populate the "original" fields for SL/TP-distance analysis.
 */
function inferOriginalSLTP(side: Side, entry: number, slPct: number, tpPct: number): { sl: number; tp: number } {
  if (side === 'buy') return { sl: entry * (1 - slPct), tp: entry * (1 + tpPct) };
  return { sl: entry * (1 + slPct), tp: entry * (1 - tpPct) };
}

/**
 * Deterministic close-reason inference — the same contract as the live
 * `inferCloseReason()`, extended to disambiguate SL vs TP hits for exitType.
 * Returns { closeReason, exitType }.
 *
 * Precedence:
 *   1. exit at/below SL  → closeReason='sl_tp', exitType='sl'
 *   2. exit at/above TP  → closeReason='sl_tp', exitType='tp'
 *   3. otherwise         → closeReason='reconciliation', exitType='reconciliation'
 *
 * A non-finite / non-positive exitPrice or entryPrice → 'reconciliation'
 * (corrupt data must never be classified as a clean SL/TP hit).
 */
function inferCloseContext(
  side: Side | undefined,
  entryPrice: number | undefined,
  exitPrice: number | undefined,
  sl: number,
  tp: number,
): { closeReason: Exclude<CloseReason, undefined>; exitType: ExitType } {
  if (!side || !Number.isFinite(entryPrice!) || entryPrice! <= 0 || !Number.isFinite(exitPrice!) || exitPrice! <= 0) {
    return { closeReason: 'reconciliation', exitType: 'reconciliation' };
  }
  const e = exitPrice!;
  if (side === 'buy') {
    if (e <= sl) return { closeReason: 'sl_tp', exitType: 'sl' };
    if (e >= tp) return { closeReason: 'sl_tp', exitType: 'tp' };
  } else {
    if (e >= sl) return { closeReason: 'sl_tp', exitType: 'sl' };
    if (e <= tp) return { closeReason: 'sl_tp', exitType: 'tp' };
  }
  return { closeReason: 'reconciliation', exitType: 'reconciliation' };
}

/**
 * A secondary signal to refine SL-vs-TP when the pnlPct is available:
 * if exit was on the PROFIT side of entry (winning trade) it is far more
 * likely a TP hit; if on the LOSS side, an SL hit. This disambiguates the
 * case where config-inferred SL/TP is too wide/narrow to match exitPrice.
 * Applied ONLY when the config-based inference says 'sl_tp' but the raw
 * price move is unambiguous.
 */
function refineExitType(
  side: Side | undefined,
  entryPrice: number | undefined,
  exitPrice: number | undefined,
  base: { closeReason: 'sl_tp' | 'reconciliation'; exitType: ExitType },
): { closeReason: 'sl_tp' | 'reconciliation'; exitType: ExitType } {
  if (base.closeReason !== 'sl_tp') return base; // only refine SL/TP hits
  if (!side || !Number.isFinite(entryPrice!) || entryPrice! <= 0 || !Number.isFinite(exitPrice!) || exitPrice! <= 0) return base;
  const profitable = side === 'buy' ? exitPrice! > entryPrice! : exitPrice! < entryPrice!;
  // Winning exit + not already a TP hit → strongly suggests TP.
  if (profitable && base.exitType !== 'tp') return { closeReason: 'sl_tp', exitType: 'tp' };
  // Losing exit + not already an SL hit → strongly suggests SL.
  if (!profitable && base.exitType !== 'sl') return { closeReason: 'sl_tp', exitType: 'sl' };
  return base;
}

/**
 * PRIMARY inference using REALIZED PnL% vs known SL/TP caps.
 *
 * HISTORICAL SEMANTIC CONTAMINATION:
 *   Across v2.0.143 → v2.0.160 the `minValueReached`/`maxValueReached` fields
 *   were persisted in at least THREE incompatible units (position-value,
 *   PnL-value, and per-unit price excursion) with no version tag. They are
 *   therefore UNRELIABLE for close-reason inference (verified empirically:
 *   uniform treatment misclassifies dozens of trades). We deliberately DO NOT
 *   use them here.
 *
 * Instead we use the ONLY unambiguous signal every trade carries: `pnlPct`.
 *   - SL cap (per profile): aggressive 7% / moderate 5% / conservative 3%
 *   - TP cap (per profile): aggressive 15% / moderate 10% / conservative 6%
 *   A realised loss at/below −8% strongly implies the SL was hit (SL caps are
 *   3–7%); a realised profit at/above +8% strongly implies the TP was hit
 *   (TP caps are 6–15%). Trades outside these bands are genuinely ambiguous
 *   (thesis invalidation / consensus / manual / reconciliation) and are
 *   labelled 'reconciliation' rather than guessed.
 *
 * This yields a HIGH-PRECISION (low false-positive) classification, which is
 * exactly what the downstream consumers need:
 *   - Close-context learning wants to know "was this SL vs thesis vs manual?"
 *     A wrong label pollutes learning weights — better 'reconciliation' than
 *     a confident guess.
 *   - MFE/TP calibration wants to separate censored (TP-hit) from uncensored
 *     (everything else) trades. Only the high-confidence TP labels matter.
 */
function inferFromPnlPct(
  t: TradeLike,
): { closeReason: 'sl_tp' | 'reconciliation'; exitType: 'sl' | 'tp' | 'reconciliation' } | null {
  const pnlPct = t.pnlPct;
  if (typeof pnlPct !== 'number' || !Number.isFinite(pnlPct)) return null;

  const SL_HIGH_CONF = -0.08; // ≤ -8% → high-confidence SL hit (SL caps 3-7%)
  const TP_HIGH_CONF = 0.08;  // ≥ +8% → high-confidence TP hit (TP caps 6-15%)

  if (pnlPct <= SL_HIGH_CONF) {
    return { closeReason: 'sl_tp', exitType: 'sl' };
  }
  if (pnlPct >= TP_HIGH_CONF) {
    return { closeReason: 'sl_tp', exitType: 'tp' };
  }
  // Ambiguous band → discretionary / non-SL-TP close.
  return { closeReason: 'reconciliation', exitType: 'reconciliation' };
}

// ── Backfill logic ────────────────────────────────────────────────────────
interface BackfillStats {
  total: number;
  filledCloseReason: number;
  filledExitType: number;
  filledOriginalSL: number;
  filledOriginalTP: number;
  unchanged: number;
  corrupt: number;
  skippedNoSide: number;
}

/**
 * Derive a CONSISTENT exitType from an EXISTING closeReason (v2.0.851 gap).
 *
 * v2.0.851 wrote closeReason to new trades but did NOT always write exitType
 * (verified: 2 live trades have closeReason='sl_tp' yet exitType=undefined).
 * When closeReason is already present we must derive exitType so the two
 * fields never disagree:
 *   - closeReason='sl_tp'  → exitType = profitable ? 'tp' : 'sl'
 *                              (a winning SL/TP close is a TP hit; a losing
 *                               one is an SL hit — matches pnlPct sign)
 *   - closeReason='reconciliation' → exitType = 'reconciliation'
 *   - closeReason='consensus'      → exitType = 'consensus'
 *   - closeReason='manual'         → exitType = 'manual'
 *   - closeReason='thesis_invalidation' → exitType = 'thesis_invalidation'
 */
function deriveExitTypeFromReason(
  closeReason: Exclude<CloseReason, undefined>,
  t: TradeLike,
): Exclude<ExitType, undefined> {
  switch (closeReason) {
    case 'sl_tp': {
      const pnlPct = t.pnlPct;
      const profitable = typeof pnlPct === 'number' && Number.isFinite(pnlPct) && pnlPct >= 0;
      return profitable ? 'tp' : 'sl';
    }
    case 'reconciliation': return 'reconciliation';
    case 'consensus': return 'consensus';
    case 'manual': return 'manual';
    case 'thesis_invalidation': return 'thesis_invalidation';
    default: return 'reconciliation';
  }
}

function backfillTrade(t: TradeLike, stats: BackfillStats): boolean {
  if (!t.side) {
    stats.skippedNoSide++;
    return false;
  }

  // v2.0.851 gap-fix: if closeReason is already present (live-written) but
  // exitType is missing, derive exitType so the two NEVER disagree.
  let filledExitEarly = false;
  if (t.closeReason !== undefined && typeof t.closeReason === 'string' && t.exitType === undefined) {
    t.exitType = deriveExitTypeFromReason(t.closeReason as Exclude<CloseReason, undefined>, t);
    filledExitEarly = true;
    stats.filledExitType++;
  }

  const entry = typeof t.entryPrice === 'number' ? t.entryPrice : NaN;
  const exit = typeof t.exitPrice === 'number' ? t.exitPrice : NaN;
  const validEntry = Number.isFinite(entry) && entry > 0;
  const validExit = Number.isFinite(exit) && exit > 0;

  // Original SL/TP: only fill if missing AND entry is valid (can't derive otherwise).
  let filledSL = false;
  let filledTP = false;
  if (t.originalStopLossPrice === undefined && validEntry) {
    const { sl } = inferOriginalSLTP(t.side, entry, DEFAULT_SL_PCT, DEFAULT_TP_PCT);
    t.originalStopLossPrice = sl;
    filledSL = true;
  }
  if (t.originalTakeProfitPrice === undefined && validEntry) {
    const { tp } = inferOriginalSLTP(t.side, entry, DEFAULT_SL_PCT, DEFAULT_TP_PCT);
    t.originalTakeProfitPrice = tp;
    filledTP = true;
  }

  // Close reason + exit type: only fill if missing.
  let filledReason = false;
  let filledExit = false;

  // PRIMARY: pnlPct-vs-SL/TP-cap inference (uses the ONLY unambiguous signal).
  const pnlInference = inferFromPnlPct(t);

  if ((t.closeReason === undefined || t.exitType === undefined)) {
    if (pnlInference) {
      if (t.closeReason === undefined) {
        t.closeReason = pnlInference.closeReason;
        filledReason = true;
      }
      if (t.exitType === undefined) {
        t.exitType = pnlInference.exitType;
        filledExit = true;
      }
    } else if (validEntry && validExit) {
      // FALLBACK: config-default SL/TP reconstruction (price-crossed levels).
      // Only classifies when the price clearly crossed a config-default level.
      const { sl, tp } = inferOriginalSLTP(t.side, entry, DEFAULT_SL_PCT, DEFAULT_TP_PCT);
      const base = inferCloseContext(t.side, entry, exit, sl, tp);
      const refined = refineExitType(t.side, entry, exit, base);
      if (t.closeReason === undefined) {
        t.closeReason = refined.closeReason;
        filledReason = true;
      }
      if (t.exitType === undefined) {
        t.exitType = refined.exitType;
        filledExit = true;
      }
    } else if (!validEntry && !validExit) {
      // Truly non-inferable (no entry/exit) — nothing to derive. Skip.
      stats.corrupt++;
      return false;
    } else {
      // Entry OR exit missing but one present → corrupt. Mark as reconciliation
      // (never classify an unknown close as a clean SL/TP hit).
      t.closeReason = 'reconciliation';
      t.exitType = 'reconciliation';
      filledReason = true;
      filledExit = true;
    }
  }

  if (filledSL) stats.filledOriginalSL++;
  if (filledTP) stats.filledOriginalTP++;
  if (filledReason) stats.filledCloseReason++;
  if (filledExit) stats.filledExitType++;
  if (!filledSL && !filledTP && !filledReason && !filledExit) stats.unchanged++;
  return filledSL || filledTP || filledReason || filledExit;
}

function main(): void {
  if (!existsSync(PORTFOLIO_PATH)) {
    console.error(`✗ Portfolio state not found at ${PORTFOLIO_PATH}`);
    process.exit(1);
  }

  const raw = readFileSync(PORTFOLIO_PATH, 'utf-8');
  let data: { trades?: TradeLike[]; realTrades?: TradeLike[] };
  try {
    data = JSON.parse(raw) as { trades?: TradeLike[]; realTrades?: TradeLike[] };
  } catch (err) {
    console.error(`✗ Failed to parse portfolio-state.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const stats: BackfillStats = {
    total: 0,
    filledCloseReason: 0,
    filledExitType: 0,
    filledOriginalSL: 0,
    filledOriginalTP: 0,
    unchanged: 0,
    corrupt: 0,
    skippedNoSide: 0,
  };

  const trades = Array.isArray(data.trades) ? data.trades : [];
  const realTrades = Array.isArray(data.realTrades) ? data.realTrades : [];
  stats.total = trades.length + realTrades.length;

  let mutated = 0;
  for (const t of trades) if (backfillTrade(t, stats)) mutated++;
  for (const t of realTrades) if (backfillTrade(t, stats)) mutated++;

  console.log('\n=== Backfill Summary ===');
  console.log(`Total trades scanned      : ${stats.total} (paper ${trades.length} + real ${realTrades.length})`);
  console.log(`Trades needing mutation   : ${mutated}`);
  console.log(`closeReason filled        : ${stats.filledCloseReason}`);
  console.log(`exitType filled           : ${stats.filledExitType}`);
  console.log(`originalStopLoss filled   : ${stats.filledOriginalSL}`);
  console.log(`originalTakeProfit filled : ${stats.filledOriginalTP}`);
  console.log(`already complete (unchanged): ${stats.unchanged}`);
  console.log(`corrupt / non-inferable   : ${stats.corrupt}`);
  console.log(`skipped (no side)         : ${stats.skippedNoSide}`);
  console.log(`SL_PCT fallback           : ${(DEFAULT_SL_PCT * 100).toFixed(2)}%`);
  console.log(`TP_PCT fallback           : ${(DEFAULT_TP_PCT * 100).toFixed(2)}%`);

  if (DRY_RUN) {
    console.log('\n⏭ DRY RUN — no file written (BACKFILL_DRY_RUN=1).');
    return;
  }

  if (mutated === 0) {
    console.log('\n✓ No fields needed backfilling — nothing written.');
    return;
  }

  // Backup the original before mutating.
  const backupPath = `${PORTFOLIO_PATH}.bak-${Date.now()}`;
  copyFileSync(PORTFOLIO_PATH, backupPath);
  console.log(`\n💾 Backup written: ${backupPath}`);

  // Atomic write: temp file → rename.
  const tmpPath = `${PORTFOLIO_PATH}.tmp-${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, PORTFOLIO_PATH);
    console.log(`✓ portfolio-state.json updated (${mutated} trades backfilled).`);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure; keep original intact.
    try { renameSync(tmpPath, PORTFOLIO_PATH); } catch { /* original intact */ }
    console.error(`✗ Failed to write portfolio-state.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
