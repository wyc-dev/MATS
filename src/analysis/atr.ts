// ─── ATR (Average True Range) Module ───
// v2.0.73 S2.3: Volatility-adaptive stop-loss/take-profit.
//
// Fixed-percentage SL/TP fails across different asset regimes — a 1.5% SL
// is noise on BTC but a full move on a low-vol TradFi name. ATR scales
// automatically with each asset's actual recent volatility.
//
// Institutional default: SL = 1.5×ATR, TP = 3×ATR (R:R 2:1).
// ATR is computed over 14 periods (Wilder's original).

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'atr' });

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** HL fetch function type — same as support-resistance.ts setHLFetchFn. */
type HLFetchFn = (body: unknown) => Promise<unknown>;
let hlFetchFn: HLFetchFn | null = null;

/** Register the HL fetch function (with rate limiting). Called from market-agent. */
export function setHLFetchFnForATR(fn: HLFetchFn): void {
  hlFetchFn = fn;
}

/**
 * Compute ATR (Average True Range) over `period` candles using Wilder's smoothing.
 *
 * True Range = max(
 *   high - low,
 *   |high - prevClose|,
 *   |low  - prevClose|
 * )
 *
 * Wilder's ATR = previous ATR × (period - 1) + current TR, all / period.
 * First ATR = simple average of TR over the first `period` candles.
 *
 * @param candles  Candles oldest→newest. Needs at least `period + 1` for a
 *                 proper Wilder seed (uses prevClose for TR).
 * @param period   ATR period (default 14, Wilder's original).
 * @returns ATR in price units, or 0 if insufficient data.
 */
export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    // Fallback: if we have at least 2 candles, use simple average of (high-low)
    if (candles.length < 2) return 0;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1]!;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      );
      trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  // Wilder's smoothing
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }

  // Seed: simple average of first `period` TRs
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Smooth remaining
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

/**
 * Fetch recent candles for a symbol and compute ATR.
 * Uses HL candleSnapshot (1h interval, ~30 candles → 14-period ATR seeded + smoothed).
 *
 * @param symbol  HL symbol (e.g. 'BTC' or 'xyz:MU'). Full coin name required for DEX 1-8.
 * @param period  ATR period (default 14).
 * @returns ATR in price units, or 0 if unavailable.
 */
export async function getATR(symbol: string, period = 14): Promise<number> {
  if (!hlFetchFn) {
    log.debug(`[getATR] HL fetch fn not set — skipping ${symbol}`);
    return 0;
  }
  try {
    // v2.0.XX: DEX 1-8 symbols (xyz:SKHX) require the FULL coin name.
    // Stripping the prefix caused HL to return empty data for all DEX 1-8 assets.
    const coin = symbol;
    const endTime = Date.now();
    // 1h candles, fetch 30 → enough for 14-period ATR + smoothing
    const intervalMs = 3_600_000;
    const startTime = endTime - 30 * intervalMs;
    const data = await hlFetchFn({
      type: 'candleSnapshot',
      req: { coin, interval: '1h', startTime, endTime },
    }) as Array<{ t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }>;

    if (!Array.isArray(data) || data.length < 2) {
      log.debug(`[getATR] No 1h data for ${symbol}`);
      return 0;
    }
    const candles: Candle[] = data
      .map(c => ({
        timestamp: parseInt(c['t'] ?? '0', 10),
        open: parseFloat(c['o'] ?? '0'),
        high: parseFloat(c['h'] ?? '0'),
        low: parseFloat(c['l'] ?? '0'),
        close: parseFloat(c['c'] ?? '0'),
        volume: parseFloat(c['v'] ?? '0'),
      }))
      .filter(c => c.timestamp > 0 && c.high > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    return computeATR(candles, period);
  } catch (err) {
    log.debug(`[getATR] Failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * v2.0.73 S2.3: Compute volatility-adaptive SL/TP from ATR.
 *
 *   LONG:  SL = entry - 1.5×ATR   TP = entry + 3×ATR
 *   SHORT: SL = entry + 1.5×ATR   TP = entry - 3×ATR
 *
 * R:R = 2:1. ATR scales with each asset's actual volatility, so SL/TP
 * are never too tight (noise stop-out) or too wide (excessive risk).
 *
 * @param entryPrice  Position entry price.
 * @param atr         ATR in price units (from getATR).
 * @param side        'buy' (long) or 'sell' (short).
 * @param slMult      SL multiplier (default 1.5).
 * @param tpMult      TP multiplier (default 3.0).
 * @returns { sl, tp } or null if ATR is 0 (caller should fall back to %).
 */
export function computeATRSLTP(
  entryPrice: number,
  atr: number,
  side: 'buy' | 'sell',
  slMult = 1.5,
  tpMult = 3.0,
): { sl: number; tp: number } | null {
  if (atr <= 0 || entryPrice <= 0) return null;
  const slDist = slMult * atr;
  const tpDist = tpMult * atr;
  if (side === 'buy') {
    return {
      sl: entryPrice - slDist,
      tp: entryPrice + tpDist,
    };
  }
  return {
    sl: entryPrice + slDist,
    tp: entryPrice - tpDist,
  };
}