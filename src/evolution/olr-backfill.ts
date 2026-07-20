// ─── OLR Cold-Start Backfill ───
//
// On startup the OLR engine has zero samples, so P(win) returns the
// uninformative 0.5 for every side and the agent cannot use the learned
// edge for ~hours until live shadow trades resolve.
//
// This module backfills the OLR prior from historical candles: for each
// trading market it fetches N 5m candles from Hyperliquid and replays them
// as shadow LONG+SHORT positions, resolving each against the real candle
// high/low path (multi-candle hold, #4 fix). Outcomes are fed to OLR with
// source='backfill' (weighted 0.3, excluded from the SGD decay counter so
// the prior does not freeze the model against live adaptation).
//
// Production hardening (v2):
//  #1 — Welford mask: backfill updates Welford ONLY for features it has real
//       data for (volatility / srDistanceBps / volumeRatio). The 0-filled
//       missing features (obImbalance / sentiment / fundingRate /
//       sentimentConviction) keep a live-only Welford distribution, so the
//       first live value does not normalize to an explosive z-score.
//  #2 — Freshness: a persisted prior older than `maxBackfillAgeMs` is treated
//       as STALE — the symbol is reset and re-backfilled so the prior reflects
//       current market regime (not a state from days ago).
//  #4 — Multi-candle hold: each shadow is tracked forward up to
//       `maxHoldCandles` and resolved on the FIRST candle whose H/L touches
//       SL/TP. Unresolved shadows are skipped (no fabricated label).
//  #5 — S/R-aligned SL/TP: SL/TP come from nearest pivot support/resistance
//       (same geometry as live S/R-based shadow trades), falling back to
//       ATR multiples only when no pivots are found. `srDistanceBps` is the
//       real distance to nearest support, matching the live feature semantics.

import { createLogger } from '../observability/logger.ts';
import { OLREngine, FEATURE_NAMES } from './olr-engine.ts';

const log = createLogger({ phase: 'olr-backfill' });

// ─── Types ───

export interface HLCandle {
  t: number;   // open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface BackfillOptions {
  /** Number of candles to fetch + replay per symbol (default 200 = ~16h of 5m). */
  candlesPerSymbol?: number;
  /** Candle interval (default '5m' — matches the live decision cycle). */
  interval?: string;
  /** ATR window (default 14). */
  atrWindow?: number;
  /** SL distance as a multiple of ATR when no S/R pivots are found (default 1.5). */
  slAtrMultiple?: number;
  /** TP distance as a multiple of ATR when no S/R pivots are found (default 2.5). */
  tpAtrMultiple?: number;
  /** Max candles to hold a backfill shadow before giving up (default 20 = ~100min). */
  maxHoldCandles?: number;
  /** Pivot detection window (candles left/right, default 3). */
  pivotWindow?: number;
  /** Only backfill a symbol if its total samples are below this (default 20). */
  coldStartThreshold?: number;
  /** Re-backfill (after reset) if the newest sample is older than this (default 6h). */
  maxBackfillAgeMs?: number;
  /** Max concurrent candle fetches (HL rate-limit safety, default 3). */
  maxConcurrent?: number;
}

export type ColdState = 'cold' | 'stale' | 'warm';

export interface BackfillResult {
  symbol: string;
  candlesReplayed: number;
  longSamples: number;
  shortSamples: number;
  skipped: boolean;
  /** Why the symbol was skipped (when skipped=true). */
  reason?: string;
  /** Whether the symbol was reset before backfill (stale refresh). */
  reset?: boolean;
}

export interface BackfillSummary {
  symbolsBackfilled: number;
  symbolsSkipped: number;
  totalSamples: number;
  results: BackfillResult[];
}

export type CandleFetcher = (coin: string, interval: string, startTime: number, endTime: number) => Promise<HLCandle[]>;

// ─── Indicators ───

/** True-range ATR over the last `window` candles ending at index `end` (inclusive). */
function atr(candles: HLCandle[], end: number, window: number): number {
  if (end < 1 || candles.length < 2) return 0;
  const start = Math.max(1, end - window + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    if (c.h <= 0 || c.l <= 0 || prev.c <= 0) continue;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    sum += tr;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** Per-cycle volatility = std of log returns over last `window` closes. */
function volFromCandles(candles: HLCandle[], end: number, window: number): number {
  const start = Math.max(1, end - window + 1);
  const rets: number[] = [];
  for (let i = start; i <= end; i++) {
    const prev = candles[i - 1]!.c;
    const curr = candles[i]!.c;
    if (prev > 0 && curr > 0) rets.push(Math.log(curr / prev));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function volumeRatio(candles: HLCandle[], end: number, window: number): number {
  const start = Math.max(0, end - window + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end; i++) {
    if (candles[i]!.v > 0) { sum += candles[i]!.v; n++; }
  }
  if (n === 0 || sum === 0) return 1;
  const avg = sum / n;
  return avg > 0 ? candles[end]!.v / avg : 1;
}

// ─── Pivot-based S/R (#5) ───

export interface SRLevels {
  support: number | null;     // nearest below entry
  resistance: number | null;  // nearest above entry
}

/** Detect pivot highs/lows over candles[0..endIdx] (inclusive) and return
 *  the nearest support below + nearest resistance above `entry`. Uses a
 *  standard pivot definition: a candle whose high/low is strictly greater/
 *  less than `window` candles on each side. Self-contained (does not depend
 *  on the private detectPivots in support-resistance.ts) so backfill stays
 *  decoupled from the live S/R module's caching/state. */
/** Detect pivot highs/lows over candles[0..endIdx] (inclusive) and return
 *  the nearest support below + nearest resistance above `entry`. Exported
 *  for unit testing of the S/R alignment (#5 fix). */
export function nearestSR(candles: HLCandle[], endIdx: number, entry: number, window: number): SRLevels {
  let support: number | null = null;
  let resistance: number | null = null;
  let supportGap = Infinity;
  let resistanceGap = Infinity;
  // Only consider pivots fully formed before endIdx (need `window` candles
  // after the pivot to confirm it — no look-ahead into the entry candle).
  const lastPivotIdx = endIdx - window;
  for (let i = window; i <= lastPivotIdx; i++) {
    const c = candles[i]!;
    // Pivot high?
    let isHigh = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j]!.h >= c.h) { isHigh = false; break; }
    }
    if (isHigh && c.h > entry) {
      const gap = c.h - entry;
      if (gap < resistanceGap) { resistanceGap = gap; resistance = c.h; }
    }
    // Pivot low?
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j]!.l <= c.l) { isLow = false; break; }
    }
    if (isLow && c.l < entry) {
      const gap = entry - c.l;
      if (gap < supportGap) { supportGap = gap; support = c.l; }
    }
  }
  return { support, resistance };
}

// ─── Feature construction ───

/** Indices of features backfill can compute from candles. The Welford mask
 *  is restricted to these so 0-filled missing features don't contaminate the
 *  live Welford distribution (#1 fix). */
const BACKFILL_FEATURE_INDICES: number[] = FEATURE_NAMES
  .map((name, i) => (name === 'volatility' || name === 'srDistanceBps' || name === 'volumeRatio' ? i : -1))
  .filter(i => i >= 0);

function featuresFromCandle(
  candles: HLCandle[],
  end: number,
  atrWindow: number,
  entryPrice: number,
  sr: SRLevels,
  atrValue: number,
): Record<string, number> {
  const vol = volFromCandles(candles, end, 20);
  // srDistanceBps = distance to nearest support (matches live feature semantics).
  // When no pivot support is found, fall back to the ATR-based SL distance so
  // the feature is a meaningful "distance to nearest S/R (ATR proxy)" rather
  // than 0 — feeding 0 would contaminate the Welford distribution for this
  // feature with non-representative zeros (#1 hygiene).
  let srDistanceBps: number;
  if (sr.support && sr.support > 0 && entryPrice > 0) {
    srDistanceBps = ((entryPrice - sr.support) / entryPrice) * 10000;
  } else if (atrValue > 0 && entryPrice > 0) {
    srDistanceBps = (atrValue / entryPrice) * 10000;
  } else {
    srDistanceBps = 0;
  }
  const features: Record<string, number> = {};
  for (const name of FEATURE_NAMES) features[name] = 0;
  features['volatility'] = vol;
  features['srDistanceBps'] = srDistanceBps;
  features['volumeRatio'] = volumeRatio(candles, end, atrWindow);
  // obImbalance / sentiment / fundingRate / signalAgreement / sentimentConviction
  // unavailable historically → left at 0; Welford NOT updated for them (#1).
  features['signalAgreement'] = 0.5;
  features['sentimentConviction'] = 0.5;
  // v2.0.721: regimeOrdinal — unknown for historical candles, use neutral 0.5
  features['regimeOrdinal'] = 0.5;
  return features;
}

/** Resolve a shadow against one candle's H/L. */
function resolveShadow(
  side: 'buy' | 'sell',
  sl: number,
  tp: number,
  candle: HLCandle,
): 'win' | 'loss' | null {
  if (candle.h <= 0 || candle.l <= 0) return null;
  if (side === 'buy') {
    const slHit = candle.l <= sl;
    const tpHit = candle.h >= tp;
    if (slHit && tpHit) return 'loss'; // both touched → conservative SL-first
    if (tpHit) return 'win';
    if (slHit) return 'loss';
  } else {
    const slHit = candle.h >= sl;
    const tpHit = candle.l <= tp;
    if (slHit && tpHit) return 'loss';
    if (tpHit) return 'win';
    if (slHit) return 'loss';
  }
  return null;
}

// ─── Cold-state detection (#2 freshness) ───

function checkCold(olr: OLREngine, symbol: string, threshold: number, maxAgeMs: number, now: number): ColdState {
  const stats = olr.getAllModelStats().find(s => s.symbol === symbol.toLowerCase());
  if (!stats) return 'cold';
  const total = stats.longSamples + stats.shortSamples;
  if (total < threshold) return 'cold';
  if (stats.newestSampleTs > 0 && (now - stats.newestSampleTs) > maxAgeMs) return 'stale';
  return 'warm';
}

// ─── Public API ───

export async function backfillOLRFromCandles(
  olr: OLREngine,
  symbols: string[],
  fetchCandles: CandleFetcher,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const {
    candlesPerSymbol = 200,
    interval = '5m',
    atrWindow = 14,
    slAtrMultiple = 1.5,
    tpAtrMultiple = 2.5,
    maxHoldCandles = 20,
    pivotWindow = 3,
    coldStartThreshold = 20,
    maxBackfillAgeMs = 6 * 60 * 60 * 1000,
    maxConcurrent = 3,
  } = options;

  const results: BackfillResult[] = [];
  const now = Date.now();
  const spanMs = Math.ceil(candlesPerSymbol * 5 * 60_000 * 1.1);
  const welfordMask = new Set(BACKFILL_FEATURE_INDICES);

  for (let i = 0; i < symbols.length; i += maxConcurrent) {
    const batch = symbols.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (sym) => {
      const result = await backfillSymbol(olr, sym, fetchCandles, {
        candlesPerSymbol, interval, atrWindow, slAtrMultiple, tpAtrMultiple,
        maxHoldCandles, pivotWindow, coldStartThreshold, maxBackfillAgeMs,
        startTime: now - spanMs, endTime: now, welfordMask, now,
      });
      results.push(result);
    }));
  }

  const symbolsBackfilled = results.filter(r => !r.skipped).length;
  const symbolsSkipped = results.filter(r => r.skipped).length;
  const totalSamples = results.reduce((a, r) => a + r.longSamples + r.shortSamples, 0);
  log.info(`[backfill] Done: ${symbolsBackfilled} backfilled, ${symbolsSkipped} skipped, ${totalSamples} samples injected`);
  return { symbolsBackfilled, symbolsSkipped, totalSamples, results };
}

async function backfillSymbol(
  olr: OLREngine,
  symbol: string,
  fetchCandles: CandleFetcher,
  opts: {
    candlesPerSymbol: number; interval: string; atrWindow: number;
    slAtrMultiple: number; tpAtrMultiple: number; maxHoldCandles: number;
    pivotWindow: number; coldStartThreshold: number; maxBackfillAgeMs: number;
    startTime: number; endTime: number; welfordMask: Set<number>; now: number;
  },
): Promise<BackfillResult> {
  const base: BackfillResult = {
    symbol, candlesReplayed: 0, longSamples: 0, shortSamples: 0, skipped: true,
  };

  const cold = checkCold(olr, symbol, opts.coldStartThreshold, opts.maxBackfillAgeMs, opts.now);
  if (cold === 'warm') {
    base.reason = 'already warm (≥ threshold samples, within freshness window)';
    return base;
  }
  // 'stale' → reset the symbol so the refresh starts clean (no obsolete samples).
  // 'cold' → nothing to reset.
  let reset = false;
  if (cold === 'stale') {
    olr.resetSymbol(symbol);
    reset = true;
    log.info(`[backfill] ${symbol}: prior stale (older than ${(opts.maxBackfillAgeMs / 3600_000).toFixed(1)}h) — reset before refresh`);
  }

  let candles: HLCandle[];
  try {
    candles = await fetchCandles(symbol, opts.interval, opts.startTime, opts.endTime);
  } catch (err) {
    base.reason = `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(`[backfill] ${symbol}: ${base.reason}`);
    return base;
  }
  if (candles.length < opts.atrWindow + opts.pivotWindow + 2) {
    base.reason = `insufficient candles (${candles.length})`;
    log.warn(`[backfill] ${symbol}: ${base.reason}`);
    return base;
  }

  candles.sort((a, b) => a.t - b.t);
  if (candles.length > opts.candlesPerSymbol) {
    candles = candles.slice(-opts.candlesPerSymbol);
  }

  let longSamples = 0;
  let shortSamples = 0;
  let replayed = 0;

  // Replay: open a shadow LONG+SHORT at each candle's OPEN (after warmup),
  // resolve on the FIRST subsequent candle whose H/L touches SL/TP, up to
  // maxHoldCandles. Unresolved → skipped (no fabricated label, #4 fix).
  for (let i = opts.atrWindow; i < candles.length; i++) {
    const entry = candles[i]!.o;
    if (entry <= 0 || !Number.isFinite(entry)) continue;
    const a = atr(candles, i - 1, opts.atrWindow);
    if (a <= 0 || !Number.isFinite(a)) continue;

    // S/R-aligned SL/TP (#5), ATR fallback.
    const sr = nearestSR(candles, i - 1, entry, opts.pivotWindow);
    let longSL: number, longTP: number, shortSL: number, shortTP: number;
    if (sr.support && sr.resistance && sr.support < entry && sr.resistance > entry) {
      longSL = sr.support;
      longTP = sr.resistance;
      shortSL = sr.resistance;
      shortTP = sr.support;
    } else {
      const slDist = opts.slAtrMultiple * a;
      const tpDist = opts.tpAtrMultiple * a;
      longSL = entry - slDist;
      longTP = entry + tpDist;
      shortSL = entry + slDist;
      shortTP = entry - tpDist;
    }

    const features = featuresFromCandle(candles, i - 1, opts.atrWindow, entry, sr, a);

    // Scan forward to resolve.
    const limit = Math.min(candles.length - 1, i + opts.maxHoldCandles);
    let longOutcome: 'win' | 'loss' | null = null;
    let shortOutcome: 'win' | 'loss' | null = null;
    let resolveIdx = -1;
    for (let j = i; j <= limit; j++) {
      const lo = resolveShadow('buy', longSL, longTP, candles[j]!);
      const so = resolveShadow('sell', shortSL, shortTP, candles[j]!);
      if (lo && !longOutcome) { longOutcome = lo; resolveIdx = j; }
      if (so && !shortOutcome) { shortOutcome = so; resolveIdx = j; }
      if (longOutcome && shortOutcome) break;
    }
    if (longOutcome) {
      olr.feedTrade(symbol, features, longOutcome === 'win' ? 1 : 0, 'buy', 'backfill', resolveIdx >= 0 ? resolveIdx : i, false, opts.welfordMask);
      longSamples++;
    }
    if (shortOutcome) {
      olr.feedTrade(symbol, features, shortOutcome === 'win' ? 1 : 0, 'sell', 'backfill', resolveIdx >= 0 ? resolveIdx : i, false, opts.welfordMask);
      shortSamples++;
    }
    replayed++;
  }

  log.info(`[backfill] ${symbol}: replayed ${replayed} candles → ${longSamples} LONG + ${shortSamples} SHORT samples (S/R-aligned SL/TP, maxHold=${opts.maxHoldCandles}${reset ? ', RESET' : ''})`);
  return {
    symbol,
    candlesReplayed: replayed,
    longSamples,
    shortSamples,
    skipped: false,
    reset,
  };
}