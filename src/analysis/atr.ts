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
    // v2.0.98: HL candleSnapshot API is CASE-SENSITIVE. DEX 0 symbols (BTC, ETH)
    // must be UPPERCASE. normalizeSymbol lowercases non-colon symbols → fix here.
    const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
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
 * v2.0.207 (#C/#D): Fetch short-term momentum (% price change over last `n`
 * 1h candles) from Hyperliquid. Returns a fraction (0.03 = +3%). 0 on failure.
 * This is the SAME data source as getATR (1h candleSnapshot) so the momentum
 * is consistent with the ATR-based SL. Used by trading-manager to widen SL
 * against adverse momentum and by Skeptics to flag "price is being pushed".
 */
export async function getMomentum(symbol: string, n = 5): Promise<number> {
  if (!hlFetchFn) return 0;
  try {
    const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
    const endTime = Date.now();
    const intervalMs = 3_600_000;
    const startTime = endTime - (n + 2) * intervalMs;
    const data = await hlFetchFn({
      type: 'candleSnapshot',
      req: { coin, interval: '1h', startTime, endTime },
    }) as Array<{ t?: string; c?: string }>;
    if (!Array.isArray(data) || data.length < 2) return 0;
    const closes = data
      .map(c => parseFloat(c['c'] ?? '0'))
      .filter(c => c > 0)
      .sort((a, b) => a - b);
    if (closes.length < 2) return 0;
    const recent = closes.slice(-Math.min(n, closes.length));
    if (recent.length < 2) return 0;
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (first <= 0) return 0;
    const mom = (last - first) / first;
    return Math.max(-0.5, Math.min(0.5, mom));
  } catch {
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
  tpMult = 2.0,
  /** v2.0.207 (#C): Adverse short-term momentum (fraction, e.g. 0.03 = +3%
   *  AGAINST this position). When provided and > 0, the SL distance is widened
   *  to cover 2.5× the adverse momentum range so a continuation of the push
   *  doesn't stop the position out before the thesis plays out. This is the
   *  fix for "SL $59.40 (+0.8%) gets blown by continued push" — the SL adapts
   *  to "the market is being pushed RIGHT NOW" instead of relying on
   *  historical ATR alone. */
  adverseMomentum?: number,
): { sl: number; tp: number } | null {
  if (atr <= 0 || entryPrice <= 0) return null;
  let slDist = slMult * atr;
  // v2.0.207 (#C): Momentum-adaptive SL — widen to cover adverse push.
  if (adverseMomentum && adverseMomentum > 0) {
    const momentumSlDist = adverseMomentum * entryPrice * 2.5;
    slDist = Math.max(slDist, momentumSlDist);
  }
  // v2.0.210 (Fix 2): Momentum-adaptive TP — ensure R:R ≥ 1.5:1 even when SL
  // was widened by momentum. Fixes audit 'premature-exit-mfe-mismatch': a
  // 59-hour hold for 0.1% gain happened because TP was too near (2×ATR) while
  // SL was wider — R:R < 1, so the trade needed a tiny move to TP but the
  // market wandered. Now tpDist = max(tpMult×ATR, 1.6×slDist) so the reward
  // always justifies the risk.
  let tpDist = tpMult * atr;
  if (tpDist < slDist * 1.6) tpDist = slDist * 1.6;
  // Cap SL/TP distance to prevent unreachable levels
  // v2.0.207 (#C): raise SL cap to 5% when momentum-adaptive (was 3%) — a 2.5×
  // momentum SL can legitimately exceed 3% in a strong push; capping at 3%
  // would re-introduce the stop-out problem the momentum SL is solving.
  const maxSlDist = (adverseMomentum && adverseMomentum > 0) ? entryPrice * 0.05 : entryPrice * 0.03;
  // v2.0.210 (Fix 2): raise TP cap to 8% when momentum-adaptive so the R:R
  // guarantee isn't undone by the cap (was 5%). A 5% SL × 1.6 R:R = 8% TP.
  const maxTpDist = (adverseMomentum && adverseMomentum > 0) ? entryPrice * 0.08 : entryPrice * 0.05;
  const cappedSlDist = Math.min(slDist, maxSlDist);
  const cappedTpDist = Math.min(tpDist, maxTpDist);
  if (side === 'buy') {
    return {
      sl: entryPrice - cappedSlDist,
      tp: entryPrice + cappedTpDist,
    };
  }
  return {
    sl: entryPrice + cappedSlDist,
    tp: entryPrice - cappedTpDist,
  };
}