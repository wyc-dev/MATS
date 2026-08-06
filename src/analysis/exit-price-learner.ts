// ─── Exit-Price Learner (PAEL) — v2.0.862 ─────────────────────────────
//
// Per-asset × per-direction MFE/MAE distribution model. Learns "how far does
// THIS asset typically extend in my favour (MFE) and against me (MAE) after
// an entry" from REAL trade position-value extremes — the data-driven answer
// to "where should TP/SL be" that the owner asked for.
//
// The insight: TradeRecord.minValueReached/maxValueReached (position-value =
// margin + unrealizedPnl) are recorded for 100% of real trades. Converting
// them to price excursions (÷leverage) yields a per-asset distribution of
// typical favourable/adverse extension. TP aimed at MFE p50×0.8 and SL floored
// at MAE p95 is the "profit-maximising exit" for that asset.
//
// Design principles:
//   - Per-asset × per-direction (SILVER and BTC have completely different
//     personalities — never share distributions)
//   - Percentile-based (median/p75/p90/p95) — outlier-immune robust stats,
//     NOT sigmoid / mean (a single extreme trade cannot skew the profile)
//   - Weighted by source: real=1.0, shadow=0.5 (shadow MFE is truncated by
//     fixed SL/TP — lower-bound only), paper=0.3
//   - Rolling window (newest N per cell) — MFE distributions drift with
//     regime; stale samples must age out
//   - Cold-start safe: < minSamples → null profile → caller falls back to
//     existing S/R + ATR + candle-MFE logic (identical behaviour)
//   - Phase A is LEARNING-ONLY: nothing consumes this in the execution path.
//     Wired in (Phase C) only after the historical simulation (Phase B) proves
//     it improves exit expectancy.
//
// Persistence: exit-price-state.json (atomic save, corruption-tolerant load).

import { createLogger } from '../observability/logger.ts';
import { safeLeverage } from '../trading/position-utils.ts';
import fs from 'node:fs';

const log = createLogger({ phase: 'exit-price' });

// ─── Config ────────────────────────────────────────────────────────────

export const exitPriceLearnerConfig = {
  /** Below this many samples a cell yields NO profile (cold-start fallback). */
  minSamples: 10,
  /** Rolling-window cap per (symbol|side) — oldest records evicted. */
  maxRecordsPerCell: 100,
  /** Learning weights by source. Shadow MFE is truncated by fixed SL/TP
   *  (upper bound = TP distance) — it is a LOWER-BOUND estimate, hence 0.5. */
  sourceWeights: { real: 1.0, shadow: 0.5, paper: 0.3 } as const,
  /** Sane cap on price excursion (fraction). 50% in a minutes-to-hours
   *  horizon is already extreme; anything above is corrupt data. */
  maxExcursionPct: 0.5,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────

export interface ExitRecord {
  symbol: string;           // normalized lowercase
  side: 'buy' | 'sell';
  /** Favourable price extension (fraction, >= 0; 0 = never went favourable). */
  mfePricePct: number;
  /** Adverse price excursion (fraction, >= 0). */
  maePricePct: number;
  source: 'real' | 'shadow' | 'paper';
  timestamp: number;
  /** Precomputed learning weight (real=1.0, shadow=0.5, paper=0.3). */
  weight: number;
}

export interface ExitProfile {
  symbol: string;
  side: 'buy' | 'sell';
  /** TP target anchor: 50th-pct favourable extension (aim at typical move). */
  mfeP50: number;
  /** Lock-profit zone: 75th-pct favourable extension. */
  mfeP75: number;
  /** Absolute TP cap: 90th-pct favourable extension. */
  mfeP90: number;
  /** SL noise floor: 95th-pct adverse excursion. */
  maeP95: number;
  samples: number;
  updatedAt: number;
}

export interface RawPositionExtremes {
  entryPrice: number;
  quantity: number;
  leverage: number;
  minValueReached: number;
  maxValueReached: number;
}

// ─── Conversion helper ─────────────────────────────────────────────────

/**
 * Convert position-value extremes (margin + unrealizedPnl) to price excursions.
 *   margin = entry×qty / safeLeverage
 *   MFE%   = (maxV − margin) / margin / leverage   (favourable price extension)
 *   MAE%   = (margin − minV) / margin / leverage   (adverse excursion)
 * Clamped to [0, maxExcursionPct] — negative (never favourable) → 0, and a
 * >50% move in this horizon is corrupt. Returns null on any non-finite input.
 */
export function convertToPriceExtremes(
  input: RawPositionExtremes,
): { mfePricePct: number; maePricePct: number } | null {
  const lev = safeLeverage(input.leverage); // rejects 0/NaN/Inf/neg/>50 → 1
  const margin = (input.entryPrice * input.quantity) / lev;
  if (!Number.isFinite(margin) || margin <= 0) return null;
  const mfeMarginPct = (input.maxValueReached - margin) / margin;
  const maeMarginPct = (margin - input.minValueReached) / margin;
  const mfePricePct = mfeMarginPct / lev;
  const maePricePct = maeMarginPct / lev;
  if (!Number.isFinite(mfePricePct) || !Number.isFinite(maePricePct)) return null;
  const cap = exitPriceLearnerConfig.maxExcursionPct;
  return {
    mfePricePct: Math.max(0, Math.min(cap, mfePricePct)),
    maePricePct: Math.max(0, Math.min(cap, maePricePct)),
  };
}

/** Weighted percentile — linear interpolation over cumulative weight.
 *  Zero/negative weights fall back to unweighted. Pure, testable. */
export function weightedPercentile(
  values: number[],
  weights: number[],
  p: number,
): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return Math.max(0, values[0] ?? 0);
  const pairs = values
    .map((v, i) => ({ v: Math.max(0, v), w: Math.max(0, weights[i] ?? 0) }))
    .filter(x => Number.isFinite(x.v))
    .sort((a, b) => a.v - b.v);
  if (pairs.length === 0) return 0;
  if (pairs.length === 1) return pairs[0]!.v;
  const totalW = pairs.reduce((s, x) => s + x.w, 0);
  const target = p * totalW;
  if (totalW <= 0 || target <= 0) {
    const sorted = pairs.map(x => x.v);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  }
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    const cur = pairs[i]!;
    cum += cur.w;
    if (cum >= target) {
      if (i === 0) return cur.v;
      const prev = pairs[i - 1]!;
      const frac = (target - (cum - cur.w)) / cur.w;
      return prev.v + (cur.v - prev.v) * Math.min(1, Math.max(0, frac));
    }
  }
  return pairs[pairs.length - 1]!.v;
}

// ─── Learner ───────────────────────────────────────────────────────────

const cellKey = (symbol: string, side: 'buy' | 'sell'): string =>
  `${symbol.toLowerCase()}|${side}`;

export class ExitPriceLearner {
  private records: Record<string, ExitRecord[]> = {};
  private persistPath: string;

  constructor(persistPath = 'data/evolution/exit-price-state.json') {
    this.persistPath = persistPath;
  }

  /** Record one resolved trade/shadow's exit extremes. Idempotent-safe:
   *  callers must dedupe by trade id; the learner only appends. */
  recordExit(rec: ExitRecord): void {
    const clean = this.sanitizeRecord(rec);
    if (!clean) return;
    const key = cellKey(clean.symbol, clean.side);
    const arr = this.records[key] ?? [];
    arr.push(clean);
    if (arr.length > exitPriceLearnerConfig.maxRecordsPerCell) {
      arr.splice(0, arr.length - exitPriceLearnerConfig.maxRecordsPerCell);
    }
    this.records[key] = arr;
  }

  /** Robust stats for one (symbol, side). Null when sample-starved. */
  getExitProfile(symbol: string, side: 'buy' | 'sell'): ExitProfile | null {
    const key = cellKey(symbol, side);
    const arr = this.records[key];
    if (!arr || arr.length < exitPriceLearnerConfig.minSamples) return null;
    const mfe = arr.map(r => r.mfePricePct);
    const mae = arr.map(r => r.maePricePct);
    const w = arr.map(r => r.weight);
    return {
      symbol: symbol.toLowerCase(),
      side,
      mfeP50: weightedPercentile(mfe, w, 0.5),
      mfeP75: weightedPercentile(mfe, w, 0.75),
      mfeP90: weightedPercentile(mfe, w, 0.9),
      maeP95: weightedPercentile(mae, w, 0.95),
      samples: arr.length,
      updatedAt: Math.max(...arr.map(r => r.timestamp), 0),
    };
  }

  /** Backfill from closed real trades (portfolio-state shape). */
  backfillFromRealTrades(trades: Array<RawPositionExtremes & {
    symbol: string; side: string; closedAt?: number; openTimestamp?: number;
  }>): number {
    let fed = 0;
    for (const t of trades) {
      const side = t.side === 'sell' ? 'sell' : 'buy';
      const converted = convertToPriceExtremes(t);
      if (!converted) continue;
      this.recordExit({
        symbol: t.symbol.toLowerCase(),
        side,
        ...converted,
        source: 'real',
        timestamp: t.closedAt ?? t.openTimestamp ?? Date.now(),
        weight: exitPriceLearnerConfig.sourceWeights.real,
      });
      fed++;
    }
    log.info(`[exit-price] backfilled ${fed} real-trade records`);
    return fed;
  }

  getStats(): { cells: number; totalRecords: number } {
    const cells = Object.keys(this.records).length;
    const totalRecords = Object.values(this.records).reduce((s, a) => s + a.length, 0);
    return { cells, totalRecords };
  }

  // ─── Persistence ────────────────────────────────────────────────────

  save(): void {
    try {
      const data = JSON.stringify({ version: 1, savedAt: Date.now(), records: this.records });
      fs.writeFileSync(this.persistPath, data, 'utf-8');
    } catch (err) {
      log.warn(`[exit-price] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as {
        version?: number; records?: Record<string, ExitRecord[]>;
      };
      if (!raw.records || typeof raw.records !== 'object') return;
      const clean: Record<string, ExitRecord[]> = {};
      for (const [k, arr] of Object.entries(raw.records)) {
        if (!Array.isArray(arr)) continue;
        const filtered = arr
          .map(r => this.sanitizeRecord(r))
          .filter((r): r is ExitRecord => r !== null);
        if (filtered.length > 0) clean[k] = filtered;
      }
      this.records = clean;
      log.info(`[exit-price] loaded ${Object.keys(clean).length} cells`);
    } catch (err) {
      log.warn(`[exit-price] load failed (starting fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.records = {};
    }
  }

  private sanitizeRecord(r: ExitRecord): ExitRecord | null {
    if (!r || typeof r !== 'object') return null;
    const symbol = typeof r.symbol === 'string' && r.symbol.length > 0 ? r.symbol.toLowerCase() : '';
    if (!symbol) return null;
    const side = r.side === 'sell' ? 'sell' : r.side === 'buy' ? 'buy' : null;
    if (!side) return null;
    const mfe = Number.isFinite(r.mfePricePct) ? Math.max(0, Math.min(exitPriceLearnerConfig.maxExcursionPct, r.mfePricePct)) : null;
    const mae = Number.isFinite(r.maePricePct) ? Math.max(0, Math.min(exitPriceLearnerConfig.maxExcursionPct, r.maePricePct)) : null;
    if (mfe === null || mae === null) return null;
    const source = (r.source === 'real' || r.source === 'shadow' || r.source === 'paper') ? r.source : 'paper';
    const weight = Number.isFinite(r.weight) && r.weight > 0 ? r.weight : exitPriceLearnerConfig.sourceWeights[source];
    const timestamp = Number.isFinite(r.timestamp) ? r.timestamp : Date.now();
    return { symbol, side, mfePricePct: mfe, maePricePct: mae, source, timestamp, weight };
  }
}
