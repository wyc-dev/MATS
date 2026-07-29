// ─── Smart SL/TP Calculator (v2.0.832) ──────────────────────────────────
//
// 機構級 SL/TP 計算——優先級：S/R zones > 50-candle 頂底 > ATR fallback。
//
// 設計原則：
//   1. SL/TP 應該基於真實市場結構（頂底、S/R），唔係任意百分比
//   2. TP 近過 SL 照設——賺少都係賺，唔夾硬推 TP 到觸及唔到嘅位置
//   3. ATR 只用嚟防止 SL 太窄（SL ≥ 1.5×ATR），唔用嚟推 TP
//   4. 唔強制 R:R——如果市場結構顯示 TP 近，就照設
//   5. Leverage + position size = 用戶設定（唔變）
//
// 優先級：
//   1. S/R zones（如果有）→ 最精準嘅 SL/TP（用 zone strength 加權 buffer）
//   2. 50 支蠟燭頂底（如果冇 S/R）→ 次精準
//   3. ATR（如果都冇）→ 最後 fallback
//   4. ATR 只用嚟 ensure SL ≥ 1.5×ATR（防止噪音止損）

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'smart-sltp' });

export interface SmartSLTPInput {
  entryPrice: number;
  side: 'buy' | 'sell';
  /** S/R zones: nearest support below entry, nearest resistance above entry */
  srSupport: number | null;
  srResistance: number | null;
  /** S/R zone strength: 'strong' | 'moderate' | 'weak' | null */
  srSupportStrength: 'strong' | 'moderate' | 'weak' | null;
  srResistanceStrength: 'strong' | 'moderate' | 'weak' | null;
  /** 50-candle all-time high / low (from 1h + 5min candles) */
  candleHigh: number | null;
  candleLow: number | null;
  /** ATR (absolute, e.g. $384 for BTC) — used only for SL floor */
  atr: number;
  /** Config fallback percentages */
  stopLossPct: number;
  takeProfitPct: number;
}

export interface SmartSLTPResult {
  sl: number;
  tp: number;
  slSource: 'sr-zone' | 'candle-low' | 'atr-floor' | 'config-default';
  tpSource: 'sr-zone' | 'candle-high' | 'config-default';
  slPct: number;
  tpPct: number;
  rr: number;
  log: string;
}

/**
 * Compute SL/TP using the institutional priority chain:
 * S/R zones → 50-candle 頂底 → ATR floor → config default.
 *
 * SL logic:
 *   BUY:  SL = below nearest support (or candle low, or ATR-based)
 *   SELL: SL = above nearest resistance (or candle high, or ATR-based)
 *   SL is widened to ≥ 1.5×ATR if too narrow (prevents noise stop-out).
 *   SL is capped at 5% (excessive risk above that).
 *
 * TP logic:
 *   BUY:  TP = at nearest resistance (or candle high, or config default)
 *   SELL: TP = at nearest support (or candle low, or config default)
 *   TP is NOT widened to meet any R:R ratio — if the market structure
 *   says TP is close, we take it. 賺少都係賺.
 *   TP is capped at 10% (unreachable above that).
 *
 * Buffer (how far beyond the level SL/TP is placed):
 *   strong S/R:    0.2% beyond (tight — strong levels hold, don't need much room)
 *   moderate S/R:  0.3% beyond
 *   weak S/R:      0.5% beyond (loose — weak levels break easily)
 *   candle H/L:    0.3% beyond
 *   ATR fallback:  1.5×ATR for SL, config default for TP
 */
export function computeSmartSLTP(input: SmartSLTPInput): SmartSLTPResult {
  const {
    entryPrice,
    side,
    srSupport,
    srResistance,
    srSupportStrength,
    srResistanceStrength,
    candleHigh,
    candleLow,
    atr,
    stopLossPct,
    takeProfitPct,
  } = input;

  const isBuy = side === 'buy';
  let slPrice = 0;
  let tpPrice = 0;
  let slSource: SmartSLTPResult['slSource'] = 'config-default';
  let tpSource: SmartSLTPResult['tpSource'] = 'config-default';
  const logParts: string[] = [];

  // ── Buffer calculation based on S/R strength ──
  const srBuffer = (strength: 'strong' | 'moderate' | 'weak' | null): number => {
    if (strength === 'strong') return 0.002;  // 0.2%
    if (strength === 'moderate') return 0.003; // 0.3%
    return 0.005; // weak or null → 0.5%
  };

  // ═══════════════════════════════════════════════════════════════
  // SL CALCULATION — priority: S/R zone → candle low/high → ATR floor → config
  // ═══════════════════════════════════════════════════════════════

  if (isBuy) {
    // BUY: SL below entry
    // Priority 1: S/R support zone
    if (srSupport !== null && srSupport > 0 && srSupport < entryPrice) {
      const buffer = srBuffer(srSupportStrength);
      slPrice = srSupport * (1 - buffer);
      slSource = 'sr-zone';
      logParts.push(`SL=S/R support $${srSupport.toFixed(2)}${srSupportStrength ? ` (${srSupportStrength})` : ''} -${(buffer * 100).toFixed(1)}% buffer`);
    }
    // Priority 2: 50-candle low
    else if (candleLow !== null && candleLow > 0 && candleLow < entryPrice) {
      slPrice = candleLow * 0.997; // 0.3% below candle low
      slSource = 'candle-low';
      logParts.push(`SL=50-candle low $${candleLow.toFixed(2)} -0.3% buffer`);
    }
    // Priority 3: ATR-based (1.5×ATR below entry)
    else if (atr > 0) {
      slPrice = entryPrice * (1 - (atr / entryPrice) * 1.5);
      slSource = 'atr-floor';
      logParts.push(`SL=1.5×ATR ($${atr.toFixed(2)}) = $${slPrice.toFixed(2)}`);
    }
    // Priority 4: config default
    else {
      slPrice = entryPrice * (1 - stopLossPct);
      slSource = 'config-default';
      logParts.push(`SL=config default ${(stopLossPct * 100).toFixed(1)}%`);
    }
  } else {
    // SELL: SL above entry
    // Priority 1: S/R resistance zone
    if (srResistance !== null && srResistance > 0 && srResistance > entryPrice) {
      const buffer = srBuffer(srResistanceStrength);
      slPrice = srResistance * (1 + buffer);
      slSource = 'sr-zone';
      logParts.push(`SL=S/R resistance $${srResistance.toFixed(2)}${srResistanceStrength ? ` (${srResistanceStrength})` : ''} +${(buffer * 100).toFixed(1)}% buffer`);
    }
    // Priority 2: 50-candle high
    else if (candleHigh !== null && candleHigh > 0 && candleHigh > entryPrice) {
      slPrice = candleHigh * 1.003; // 0.3% above candle high
      slSource = 'candle-low'; // reusing the enum (means "candle-based")
      logParts.push(`SL=50-candle high $${candleHigh.toFixed(2)} +0.3% buffer`);
    }
    // Priority 3: ATR-based (1.5×ATR above entry)
    else if (atr > 0) {
      slPrice = entryPrice * (1 + (atr / entryPrice) * 1.5);
      slSource = 'atr-floor';
      logParts.push(`SL=1.5×ATR ($${atr.toFixed(2)}) = $${slPrice.toFixed(2)}`);
    }
    // Priority 4: config default
    else {
      slPrice = entryPrice * (1 + stopLossPct);
      slSource = 'config-default';
      logParts.push(`SL=config default ${(stopLossPct * 100).toFixed(1)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TP CALCULATION — priority: S/R zone → candle high/low → config default
  // NOTE: TP is NOT widened to meet any R:R ratio. 賺少都係賺.
  // ═══════════════════════════════════════════════════════════════

  if (isBuy) {
    // BUY: TP above entry
    // Priority 1: S/R resistance zone
    if (srResistance !== null && srResistance > 0 && srResistance > entryPrice) {
      // TP just BELOW resistance (we want to exit before the level, not after)
      const buffer = srBuffer(srResistanceStrength);
      tpPrice = srResistance * (1 - buffer);
      tpSource = 'sr-zone';
      logParts.push(`TP=S/R resistance $${srResistance.toFixed(2)}${srResistanceStrength ? ` (${srResistanceStrength})` : ''} -${(buffer * 100).toFixed(1)}% buffer`);
    }
    // Priority 2: 50-candle high
    else if (candleHigh !== null && candleHigh > 0 && candleHigh > entryPrice) {
      tpPrice = candleHigh * 0.997; // 0.3% below candle high (exit before)
      tpSource = 'candle-high';
      logParts.push(`TP=50-candle high $${candleHigh.toFixed(2)} -0.3% buffer`);
    }
    // Priority 3: config default
    else {
      tpPrice = entryPrice * (1 + takeProfitPct);
      tpSource = 'config-default';
      logParts.push(`TP=config default ${(takeProfitPct * 100).toFixed(1)}%`);
    }
  } else {
    // SELL: TP below entry
    // Priority 1: S/R support zone
    if (srSupport !== null && srSupport > 0 && srSupport < entryPrice) {
      const buffer = srBuffer(srSupportStrength);
      tpPrice = srSupport * (1 + buffer);
      tpSource = 'sr-zone';
      logParts.push(`TP=S/R support $${srSupport.toFixed(2)}${srSupportStrength ? ` (${srSupportStrength})` : ''} +${(buffer * 100).toFixed(1)}% buffer`);
    }
    // Priority 2: 50-candle low
    else if (candleLow !== null && candleLow > 0 && candleLow < entryPrice) {
      tpPrice = candleLow * 1.003; // 0.3% above candle low (exit before)
      tpSource = 'candle-high'; // reusing enum
      logParts.push(`TP=50-candle low $${candleLow.toFixed(2)} +0.3% buffer`);
    }
    // Priority 3: config default
    else {
      tpPrice = entryPrice * (1 - takeProfitPct);
      tpSource = 'config-default';
      logParts.push(`TP=config default ${(takeProfitPct * 100).toFixed(1)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ATR FLOOR — SL must be ≥ 1.5×ATR% to prevent noise stop-out
  // This is the ONLY use of ATR — it does NOT affect TP.
  // ═══════════════════════════════════════════════════════════════

  const atrPct = (Number.isFinite(atr) && atr > 0 && entryPrice > 0)
    ? atr / entryPrice
    : 0;
  const slFloorPct = Math.max(0.005, Number.isFinite(atrPct) ? atrPct * 1.5 : 0.005);
  const currentSlPct = Math.abs(slPrice - entryPrice) / entryPrice;

  if (currentSlPct < slFloorPct) {
    // SL too narrow — widen to ATR floor (prevents noise stop-out)
    slPrice = isBuy
      ? entryPrice * (1 - slFloorPct)
      : entryPrice * (1 + slFloorPct);
    logParts.push(`[SL-floor] widened from ${(currentSlPct * 100).toFixed(2)}% to ${(slFloorPct * 100).toFixed(2)}% (1.5×ATR)`);
  }

  // ═══════════════════════════════════════════════════════════════
  // CAPS — SL max 5%, TP max 10%
  // ═══════════════════════════════════════════════════════════════

  const finalSlPct = Math.abs(slPrice - entryPrice) / entryPrice;
  const finalTpPct = Math.abs(tpPrice - entryPrice) / entryPrice;

  if (finalSlPct > 0.05) {
    slPrice = isBuy ? entryPrice * 0.95 : entryPrice * 1.05;
    logParts.push(`[SL-cap] narrowed from ${(finalSlPct * 100).toFixed(2)}% to 5%`);
  }
  if (finalTpPct > 0.10) {
    tpPrice = isBuy ? entryPrice * 1.10 : entryPrice * 0.90;
    logParts.push(`[TP-cap] narrowed from ${(finalTpPct * 100).toFixed(2)}% to 10%`);
  }
  // v2.0.832: TP minimum viability check — TP must be on the correct side
  // of entry AND at least 0.3% away (not worth the fees below).
  // This also catches the edge case where S/R resistance is so close to entry
  // that TP = resistance × (1 - buffer) ends up BELOW entry for a BUY
  // (or ABOVE entry for a SELL) — which would be an inverted TP.
  if (finalTpPct < 0.003) {
    // TP too tight (less than 0.3%) — not worth the fees
    tpPrice = isBuy ? entryPrice * 1.003 : entryPrice * 0.997;
    logParts.push(`[TP-min] widened from ${(finalTpPct * 100).toFixed(2)}% to 0.3% (min viable)`);
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL VALUES + LOG
  // ═══════════════════════════════════════════════════════════════

  const slPctFinal = Math.abs(slPrice - entryPrice) / entryPrice;
  const tpPctFinal = Math.abs(tpPrice - entryPrice) / entryPrice;
  const rr = slPctFinal > 0 ? tpPctFinal / slPctFinal : 0;

  const logStr = `${isBuy ? 'BUY' : 'SELL'} entry=$${entryPrice.toFixed(2)} SL=$${slPrice.toFixed(2)} (${(slPctFinal * 100).toFixed(2)}%, ${slSource}) TP=$${tpPrice.toFixed(2)} (${(tpPctFinal * 100).toFixed(2)}%, ${tpSource}) R:R=${rr.toFixed(2)} | ${logParts.join(', ')}`;

  log.info(`📐 [smart-sltp] ${logStr}`);

  return {
    sl: slPrice,
    tp: tpPrice,
    slSource,
    tpSource,
    slPct: slPctFinal,
    tpPct: tpPctFinal,
    rr,
    log: logStr,
  };
}

/**
 * Fetch 50 1h candles and compute the all-time high / low for SL/TP placement.
 * Uses MarketAgent.hlFetch (rate-limited, same queue as backfill).
 * Returns null for both if fetch fails.
 */
export async function fetchCandleHighLow(
  symbol: string,
  candleCount: number = 50,
): Promise<{ high: number | null; low: number | null }> {
  try {
    // v2.0.832: Use dynamic import to avoid circular dependency with MarketAgent
    const { MarketAgent } = await import('../market-agent/index.ts');
    const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
    const endTime = Date.now();
    const startTime = endTime - candleCount * 3_600_000; // 1h candles

    const data = await MarketAgent.hlFetch({
      type: 'candleSnapshot',
      req: { coin, interval: '1h', startTime, endTime },
    }) as Array<{ h?: string; l?: string }>;

    if (!Array.isArray(data) || data.length === 0) {
      return { high: null, low: null };
    }

    let high = 0;
    let low = Infinity;
    for (const c of data) {
      const h = parseFloat(c['h'] ?? '0');
      const l = parseFloat(c['l'] ?? '0');
      if (Number.isFinite(h) && h > high) high = h;
      if (Number.isFinite(l) && l > 0 && l < low) low = l;
    }

    return {
      high: high > 0 ? high : null,
      low: low !== Infinity ? low : null,
    };
  } catch (err) {
    log.warn(`[fetchCandleHighLow] ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    return { high: null, low: null };
  }
}