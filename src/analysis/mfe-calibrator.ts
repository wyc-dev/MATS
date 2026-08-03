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
  /** Median favourable 1h extension (fraction, e.g. 0.023 = 2.3%). */
  tpTargetPct: number;
  /** 90th-percentile favourable 1h extension — data-driven TP cap. */
  tpCapPct: number;
  /** 95th-percentile adverse 5m extension — SL noise floor. */
  slFloorPct: number;
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
 */
export function buildCalibration(
  symbol: string,
  mfe1h: number[],
  mae5m: number[],
): MfeCalibrationResult | null {
  const MIN_SAMPLES = 20;
  const fav1h = mfe1h.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const adv5m = mae5m.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (fav1h.length < MIN_SAMPLES || adv5m.length < MIN_SAMPLES) return null;

  const tpTargetPct = percentile(fav1h, 50);
  const tpCapPct = percentile(fav1h, 90);
  const slFloorPct = percentile(adv5m, 95);

  // Sane guards: never produce a negative / degenerate cap.
  const result: MfeCalibrationResult = {
    tpTargetPct: Math.max(0.003, Math.min(0.20, tpTargetPct)),
    tpCapPct: Math.max(0.005, Math.min(0.30, tpCapPct)),
    slFloorPct: Math.max(0.005, Math.min(0.15, slFloorPct)),
    samples1h: fav1h.length,
    samples5m: adv5m.length,
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

/** Fetch a single candle range via MarketAgent.hlFetch. */
async function fetchCandles(symbol: string, interval: string, count: number): Promise<Candle[]> {
  const { MarketAgent } = await import('../market-agent/index.ts');
  const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
  const endTime = Date.now();
  const startTime = endTime - count * (interval === '1h' ? 3_600_000 : 300_000);
  const data = await MarketAgent.hlFetch({
    type: 'candleSnapshot',
    req: { coin, interval, startTime, endTime },
  }) as Candle[] | null;
  if (!Array.isArray(data)) return [];
  // Sort chronologically (oldest first) for forward-window measurement.
  return [...data].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

/**
 * Get the MFE calibration for a symbol, cached 15 min.
 * Thread-safe (in-flight dedup). Returns null on cold-start / fetch failure.
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
      const [candles1h, candles5m] = await Promise.all([
        fetchCandles(symbol, '1h', 100),
        fetchCandles(symbol, '5m', 100),
      ]);
      // 1h forward window ≈ 12 candles (12h swing); 5m forward window ≈ 100
      // candles (≈ 8.3h) for the adverse excursion — matches the design doc.
      const mfe1h = measureExtensions(candles1h, 12).mfePct;
      const mae5m = measureExtensions(candles5m, 100).maePct;
      const result = buildCalibration(symbol, mfe1h, mae5m);
      cache.set(norm, { result, ts: Date.now() });
      if (result) {
        log.info(`[mfe-calibrator] ${symbol}: TP_target=${(result.tpTargetPct * 100).toFixed(2)}% TP_cap=${(result.tpCapPct * 100).toFixed(2)}% SL_floor=${(result.slFloorPct * 100).toFixed(2)}% (${result.samples1h}×1h + ${result.samples5m}×5m)`);
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
