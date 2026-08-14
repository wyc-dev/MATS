// ─── MFE Calibrator (v2.0.852) ──────────────────────────────────────────
// Measures the REAL price-extension distribution from historical candles and
// turns it into a data-driven TP target + cap for `computeSmartSLTP`.
//
// WHY NOT TRADE MFE?
//   Historical TradeRecord.maxValueReached / minValueReached were persisted in
//   at least three incompatible units across v2.0.143→v2.0.160 (position-value,
//   PnL-value, per-unit price excursion) with no version tag. They are
//   UNRELIABLE (verified: dozens of trades misclassified). Candle data, by
//   contrast, is unit-consistent and voluminous (100+ samples per symbol per
//   frame) — it directly answers "if I enter here, how far does price typically
//   extend before reversing?".
//
// DUAL-FRAME DESIGN (fix #D):
//   TP uses the 1h frame (medium-horizon swing extension) so we don't aim too
//   close (leaving profit on the table) nor chase an unreachable 5× MFE.
//   SL uses the 5m frame (short-horizon adverse excursion) so we don't get
//   stopped out by routine noise on a high-leverage position.
//
// EXTENSION MEASUREMENT (rolling forward-window):
//   For each candle's close treated as an entry, scan the next N candles and
//   record the max favourable (MFE) / max adverse (MAE) excursion as a % of
//   entry. Collect all excursions → percentile distribution.
//
//   TP_median  = 50th percentile of favourable 1h extension  → TP target
//   TP_cap     = 90th percentile of favourable 1h extension  → data-driven cap
//   SL_floor   = 95th percentile of adverse 5m extension     → SL noise floor
//
// OUTPUT: a CalibrationResult that computeSmartSLTP consumes. Cold-start safe
// (insufficient samples → null → caller falls back to existing logic).
//
// RATE LIMIT: 100×1h + 100×5m per symbol ≈ 10 requests. Verified against HL
// (scripts/probe-mfe-rate-limit.ts): 0/30 429s, avg 372ms. Cached 15 min per
// symbol so a live cycle never refetches every trade.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'mfe-calibrator' });

export interface MfeCalibrationResult {
  /** LONG TP target (fraction) = 50th-pct UPWARD 1h extension × 0.8.
   *  Aiming at 80% of the typical upswing leaves headroom to realise profit. */
  tpTargetLongPct: number;
  /** LONG TP cap (fraction) = 90th-pct UPWARD 1h extension. */
  tpCapLongPct: number;
  /** SHORT TP target (fraction) = 50th-pct DOWNWARD 1h extension × 0.8. */
  tpTargetShortPct: number;
  /** SHORT TP cap (fraction) = 90th-pct DOWNWARD 1h extension. */
  tpCapShortPct: number;
  /** LONG SL floor (fraction) = 95th-pct DOWNWARD 5m excursion (adverse to a long). */
  slFloorLongPct: number;
  /** SHORT SL floor (fraction) = 95th-pct UPWARD 5m excursion (adverse to a short). */
  slFloorShortPct: number;
  /** Number of candle samples the calibration is based on. */
  samples1h: number;
  samples5m: number;
  symbol: string;
  generatedAt: number;
}

interface Candle {
  t?: number;
  h?: string;
  l?: string;
  c?: string;
  o?: string;
}

// ── Pure percentile / extension math (unit-testable, no I/O) ─────────────

/** Compute the p-th percentile of a sorted ascending array (0-100). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx]!;
}

/**
 * Measure per-entry favourable (MFE) and adverse (MAE) excursions from a
 * forward-looking window of candles, as fractions of the entry close.
 *
 * @param candles        Chronological candles (oldest first).
 * @param forwardCandles How many candles ahead to scan for each entry.
 * @returns { mfePct: number[], maePct: number[] } fractions (>0 for both; MAE
 *          is stored as a positive magnitude).
 */
export function measureExtensions(
  candles: Candle[],
  forwardCandles: number,
): { mfePct: number[]; maePct: number[] } {
  const mfePct: number[] = [];
  const maePct: number[] = [];
  const n = candles.length;
  for (let i = 0; i < n - forwardCandles; i++) {
    const entry = parseFloat(candles[i]?.c ?? '');
    if (!Number.isFinite(entry) || entry <= 0) continue;
    let hi = entry;
    let lo = entry;
    for (let j = i + 1; j <= Math.min(i + forwardCandles, n - 1); j++) {
      const h = parseFloat(candles[j]?.h ?? '');
      const l = parseFloat(candles[j]?.l ?? '');
      if (Number.isFinite(h) && h > hi) hi = h;
      if (Number.isFinite(l) && l > 0 && l < lo) lo = l;
    }
    mfePct.push((hi - entry) / entry); // favourable (≥0)
    maePct.push((entry - lo) / entry); // adverse magnitude (≥0)
  }
  return { mfePct, maePct };
}

/**
 * Build a CalibrationResult from measured extensions.
 * Cold-start safe: needs >= MIN_SAMPLES of each extension type.
 *
 * DIRECTION-AWARE (fix: BUY ≠ SELL):
 *   mfe1h carries UPWARD extensions, mae1h DOWNWARD. A LONG's TP rides up
 *   (use upward), a SHORT's TP rides down (use downward). Conversely a LONG's
 *   SL is pierced by a down-move (use downward), a SHORT's SL by an up-move.
 */
export function buildCalibration(
  symbol: string,
  up1h: number[],
  down1h: number[],
  up5m: number[],
  down5m: number[],
): MfeCalibrationResult | null {
  const MIN_SAMPLES = 20;
  const up1hSorted = up1h.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const down1hSorted = down1h.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const up5mSorted = up5m.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const down5mSorted = down5m.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (up1hSorted.length < MIN_SAMPLES || down1hSorted.length < MIN_SAMPLES ||
      up5mSorted.length < MIN_SAMPLES || down5mSorted.length < MIN_SAMPLES) return null;

  // LONG TP rides the upswing (×0.8 target); SHORT TP rides the downswing.
  const tpTargetLongPct = percentile(up1hSorted, 50) * 0.8;
  const tpCapLongPct = percentile(up1hSorted, 90);
  const tpTargetShortPct = percentile(down1hSorted, 50) * 0.8;
  const tpCapShortPct = percentile(down1hSorted, 90);
  // LONG SL pierced by down-move; SHORT SL pierced by up-move.
  const slFloorLongPct = percentile(down5mSorted, 95);
  const slFloorShortPct = percentile(up5mSorted, 95);

  const result: MfeCalibrationResult = {
    tpTargetLongPct: Math.max(0.003, Math.min(0.20, tpTargetLongPct)),
    tpCapLongPct: Math.max(0.005, Math.min(0.30, tpCapLongPct)),
    tpTargetShortPct: Math.max(0.003, Math.min(0.20, tpTargetShortPct)),
    tpCapShortPct: Math.max(0.005, Math.min(0.30, tpCapShortPct)),
    slFloorLongPct: Math.max(0.005, Math.min(0.15, slFloorLongPct)),
    slFloorShortPct: Math.max(0.005, Math.min(0.15, slFloorShortPct)),
    samples1h: up1hSorted.length,
    samples5m: up5mSorted.length,
    symbol,
    generatedAt: Date.now(),
  };
  return result;
}

// ── Fetch + cache layer ─────────────────────────────────────────────────

/** Cache: normalized symbol → { result, ts }. TTL 15 min. */
const cache = new Map<string, { result: MfeCalibrationResult | null; ts: number }>();
const CACHE_TTL_MS = 15 * 60_000;
/** In-flight promise dedup: prevents duplicate concurrent fetches for the same symbol. */
const inflight = new Map<string, Promise<MfeCalibrationResult | null>>();
/**
 * Timeout for the whole calibration fetch (both frames). The calibrator runs
 * inside the trade-open path (executeTrade → computeSmartSLTP). If HL candles
 * are slow, we must FAIL OPEN (return null → default SL/TP) rather than block
 * the order. `hlRateLimitedFetch` has a 15s per-attempt timeout; this bounds
 * the combined 1h+5m fetch so a stuck symbol cannot stall a live trade.
 */
const FETCH_TIMEOUT_MS = 8_000;

/** Race a promise against a timeout. Resolves undefined on timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fetch a single candle range via MarketAgent.hlFetch. */
async function fetchCandles(symbol: string, interval: string, count: number): Promise<Candle[]> {
  const { MarketAgent } = await import('../market-agent/index.ts');
  const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
  const endTime = Date.now();
  const startTime = endTime - count * (interval === '1h' ? 3_600_000 : 300_000);
  // v2.0.869(主神 並行 candle 調查):HL DEX 資產(貴金屬/指數——SILVER/GOLD/SP500)
  // 需要 xyz: 前綴——冇前綴 HL API 500(throw)。catch 後再試 xyz: 前綴。
  let data: Candle[] | null = null;
  try {
    data = await MarketAgent.hlFetch({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    }) as Candle[] | null;
  } catch {
    if (!symbol.includes(':')) {
      data = await MarketAgent.hlFetch({
        type: 'candleSnapshot',
        req: { coin: `xyz:${coin}`, interval, startTime, endTime },
      }) as Candle[] | null;
    }
  }
  if (!Array.isArray(data)) return [];
  // Sort chronologically (oldest first) for forward-window measurement.
  // HL returns `t` as a number (epoch ms); guard against string / NaN so the
  // sort is stable regardless of payload shape (attack fix #3).
  return [...data].sort((a, b) => {
    const ta = typeof a.t === 'number' ? a.t : (typeof a.t === 'string' ? parseInt(a.t, 10) : 0);
    const tb = typeof b.t === 'number' ? b.t : (typeof b.t === 'string' ? parseInt(b.t, 10) : 0);
    const va = Number.isFinite(ta) ? ta : 0;
    const vb = Number.isFinite(tb) ? tb : 0;
    return va - vb;
  });
}

/**
 * Get the MFE calibration for a symbol, cached 15 min.
 * Thread-safe (in-flight dedup). Returns null on cold-start / fetch failure /
 * timeout (always fail-open — never blocks the trade-open path).
 */
export async function getMfeCalibration(symbol: string): Promise<MfeCalibrationResult | null> {
  const norm = symbol.includes(':') ? symbol : symbol.toLowerCase();
  const cached = cache.get(norm);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.result;

  // Dedup concurrent fetches for the same symbol.
  const existing = inflight.get(norm);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const fetched = await withTimeout(Promise.all([
        fetchCandles(symbol, '1h', 100),
        fetchCandles(symbol, '5m', 100),
      ]), FETCH_TIMEOUT_MS);
      if (!fetched) {
        log.warn(`[mfe-calibrator] ${symbol}: fetch timed out after ${FETCH_TIMEOUT_MS}ms — fallback to default SL/TP`);
        cache.set(norm, { result: null, ts: Date.now() });
        return null;
      }
      const candles1h = fetched[0];
      const candles5m = fetched[1];
      // 1h forward window ≈ 12 candles (12h swing); 5m forward window ≈ 100
      // candles (≈ 8.3h). Each frame yields both UP and DOWN extensions so
      // BUY and SELL can be calibrated against the correct direction.
      const ext1h = measureExtensions(candles1h, 12);
      const ext5m = measureExtensions(candles5m, 100);
      const result = buildCalibration(
        symbol,
        ext1h.mfePct,   // upward 1h
        ext1h.maePct,   // downward 1h
        ext5m.mfePct,   // upward 5m
        ext5m.maePct,   // downward 5m
      );
      cache.set(norm, { result, ts: Date.now() });
      if (result) {
        log.info(`[mfe-calibrator] ${symbol}: LONG TP=${(result.tpTargetLongPct * 100).toFixed(2)}%/<${(result.tpCapLongPct * 100).toFixed(2)}% SL>${(result.slFloorLongPct * 100).toFixed(2)}% | SHORT TP=${(result.tpTargetShortPct * 100).toFixed(2)}%/<${(result.tpCapShortPct * 100).toFixed(2)}% SL>${(result.slFloorShortPct * 100).toFixed(2)}% (${result.samples1h}×1h + ${result.samples5m}×5m)`);
      } else {
        log.info(`[mfe-calibrator] ${symbol}: insufficient samples — fallback to default SL/TP`);
      }
      return result;
    } catch (err) {
      log.warn(`[mfe-calibrator] ${symbol}: fetch failed — ${err instanceof Error ? err.message : String(err)}`);
      cache.set(norm, { result: null, ts: Date.now() });
      return null;
    } finally {
      inflight.delete(norm);
    }
  })();
  inflight.set(norm, promise);
  return promise;
}

/** Test helper: clear cache (used by tests). */
export function clearMfeCalibrationCache(): void {
  cache.clear();
  inflight.clear();
}
