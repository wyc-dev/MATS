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

// ─── v2.0.213: Execution Lens integration (K.md #7) ───
//
// The AttnRes wExecution pseudo-query is trained on SL/TP stop-out outcomes.
// Its blend (retrieveBlend(sym, 'execution')) provides a stop-out-aware view
// of the recent regime. computeATRSLTP uses this as the PRIMARY SL/TP signal:
//
//   1. execAdverseMomentum — from hBlend.momentumShort, filtered through
//      wExecution's stop-out learning. Replaces raw getMomentum as primary.
//   2. execVolatilityScaling — if hBlend.volatility is elevated (the
//      execution lens "sees" a volatile stop-out-prone regime), widen SL.
//   3. entropyConfidence — low entropy = wExecution confident in its pattern
//      → trust the widening more. High entropy = uncertain → dampen.
//
// Module-level state: index.ts calls prepareExecutionLens(sym) before each
// trade, computeATRSLTP reads it, clearExecutionLens() after. No changes to
// trading-manager.ts (the caller) — the lens is picked up automatically.

/** Execution lens snapshot — the data computeATRSLTP needs from the
 *  execution-mode AttnRes blend. */
export interface ExecutionLensData {
  /** Blended volatility (0-1 fraction) from execution-mode AttnRes. */
  volatility: number;
  /** Blended short-term momentum (fraction, e.g. 0.03 = +3%) from exec AttnRes. */
  momentumShort: number;
  /** Blended long-term momentum (fraction) from exec AttnRes. */
  momentumLong: number;
  /** Attention distribution entropy (bits). Low = confident pattern. */
  entropy: number;
  /** Whether blending was active (false = cold-start fallback). */
  blended: boolean;
  /** wExecution update count (0 = cold-start, never trained). */
  updateCount: number;
}

/** Provider callback: index.ts wires this to cycleHistory.retrieveBlend(sym, 'execution'). */
type ExecutionLensProvider = (symbol: string) => ExecutionLensData | null;

let executionLensProvider: ExecutionLensProvider | null = null;
let pendingExecutionLens: ExecutionLensData | null = null;

/** Wire the execution lens provider (called once at init by index.ts). */
export function setExecutionLensProvider(fn: ExecutionLensProvider | null): void {
  executionLensProvider = fn;
}

/** Fetch + cache the execution lens for a symbol before a trade (called by
 *  index.ts executeTrade before tradingManager.executeDecision). */
export function prepareExecutionLens(symbol: string): void {
  if (!executionLensProvider) { pendingExecutionLens = null; return; }
  try {
    pendingExecutionLens = executionLensProvider(symbol);
  } catch {
    pendingExecutionLens = null;
  }
}

/** Clear the pending execution lens after a trade (called by index.ts). */
export function clearExecutionLens(): void {
  pendingExecutionLens = null;
}

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

  // ── v2.0.213 (#7): Execution lens as PRIMARY SL/TP signal ──
  // The execution lens provides a stop-out-trained view of the recent regime.
  // When available + blended + wExecution has been trained (updateCount > 0),
  // it takes priority over the raw ATR + adverseMomentum logic. The raw
  // adverseMomentum parameter is still used as a FLOOR (we never narrow below
  // what raw momentum suggests). When the lens is unavailable (cold-start,
  // not blended, or provider not wired), we fall back to the original logic.
  const execLens = pendingExecutionLens;
  const useExecLens = execLens && execLens.blended && execLens.updateCount > 0;

  let slDist = slMult * atr;
  let execWidening = 0; // log how much the execution lens added

  if (useExecLens) {
    // PRIMARY: execution-lens-adjusted SL.
    //
    // 1. Execution adverse momentum — filtered through wExecution's stop-out
    //    learning. This replaces raw adverseMomentum as the primary signal.
    const execMom = execLens!.momentumShort;
    const execAdverse = side === 'buy' ? Math.max(0, -execMom) : Math.max(0, execMom);
    if (execAdverse > 0) {
      const execMomSlDist = execAdverse * entryPrice * 2.5;
      slDist = Math.max(slDist, execMomSlDist);
      execWidening = Math.max(execWidening, execMomSlDist - slMult * atr);
    }

    // 2. Execution volatility scaling — if the execution lens sees elevated
    //    volatility through the stop-out filter, widen SL proportionally.
    //    The blend's volatility is a 0-1 fraction; ATR/entryPrice is the
    //    current implied vol. If exec vol > 1.5× current implied vol, the
    //    regime is stop-out-prone → widen SL by up to 40%.
    const currentImpliedVol = atr / entryPrice;
    if (execLens!.volatility > currentImpliedVol * 1.5 && currentImpliedVol > 0) {
      const volRatio = Math.min(execLens!.volatility / currentImpliedVol, 3.0); // cap at 3×
      const volWidenFactor = 1.0 + Math.min((volRatio - 1.0) * 0.2, 0.4); // up to +40%
      const volSlDist = slMult * atr * volWidenFactor;
      if (volSlDist > slDist) {
        execWidening = Math.max(execWidening, volSlDist - slDist);
        slDist = volSlDist;
      }
    }

    // 3. Entropy confidence — low entropy = wExecution is confidently
    //    attending to specific stop-out patterns → trust the widening.
    //    High entropy = uncertain → dampen the widening back toward ATR.
    //    Entropy range: 0 (one-hot) to log2(n) (uniform). For 9 sources,
    //    log2(9) ≈ 3.17. Below 1.0 = confident, above 2.0 = uncertain.
    if (execLens!.entropy > 2.0) {
      // Uncertain — dampen any execution-lens widening by 50%.
      const dampedSl = slMult * atr + execWidening * 0.5;
      slDist = Math.max(slMult * atr, dampedSl);
    }

    // 4. Raw adverseMomentum FLOOR — never narrow below what the raw
    //    getMomentum signal suggests (the execution lens supplements, not
    //    replaces, the raw signal).
    if (adverseMomentum && adverseMomentum > 0) {
      const rawMomSlDist = adverseMomentum * entryPrice * 2.5;
      slDist = Math.max(slDist, rawMomSlDist);
    }
  } else {
    // FALLBACK: original v2.0.207 (#C) logic — ATR + raw adverseMomentum.
    if (adverseMomentum && adverseMomentum > 0) {
      const momentumSlDist = adverseMomentum * entryPrice * 2.5;
      slDist = Math.max(slDist, momentumSlDist);
    }
  }

  // v2.0.210 (Fix 2): TP — ensure R:R ≥ 1.6:1 even when SL was widened.
  let tpDist = tpMult * atr;
  if (tpDist < slDist * 1.6) tpDist = slDist * 1.6;

  // Cap SL/TP distance to prevent unreachable levels.
  // v2.0.213: execution lens gets widest caps (6%/10%) because the
  // stop-out-trained lens has evidence for wider stops; raw momentum gets
  // medium (5%/8%); baseline gets tightest (3%/5%).
  const finalMaxSlDist = useExecLens
    ? entryPrice * 0.06
    : (adverseMomentum && adverseMomentum > 0)
      ? entryPrice * 0.05
      : entryPrice * 0.03;
  const finalMaxTpDist = useExecLens
    ? entryPrice * 0.10
    : (adverseMomentum && adverseMomentum > 0)
      ? entryPrice * 0.08
      : entryPrice * 0.05;

  const cappedSlDist = Math.min(slDist, finalMaxSlDist);
  const cappedTpDist = Math.min(tpDist, finalMaxTpDist);
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