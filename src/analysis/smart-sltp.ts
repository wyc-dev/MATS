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
  /** v2.0.836: Risk profile for DCS-aware SL/TP scaling (optional, backward compatible) */
  riskProfile?: 'aggressive' | 'moderate' | 'conservative';
  /** v2.0.836: DCS v2 Discovery Confidence Score [0, 1] (optional, backward compatible) */
  dcs?: number;
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

  // v2.0.835 security: guard against NaN/Infinity/0/negative entryPrice — without this,
  // all downstream calculations produce NaN, which propagates to the trading
  // engine as a NaN SL or TP (market order with no stop = catastrophic risk).
  // Also guard against extremely large entryPrice (Number.MAX_VALUE) which causes
  // floating-point overflow in all downstream × operations → Infinity SL/TP.
  // No real asset price exceeds 1e15 (1 quadrillion); clamp to that.
  const entryPrice = Number.isFinite(input.entryPrice) && input.entryPrice > 0 && input.entryPrice < 1e15
    ? input.entryPrice
    : 1; // fallback to 1 (all % math still works, SL/TP become tiny but finite)

  // v2.0.835 security: guard against NaN/Infinity stopLossPct/takeProfitPct
  const safeStopLossPct = Number.isFinite(stopLossPct) && stopLossPct >= 0 ? stopLossPct : 0.02;
  const safeTakeProfitPct = Number.isFinite(takeProfitPct) && takeProfitPct >= 0 ? takeProfitPct : 0.03;

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
      slPrice = entryPrice * (1 - safeStopLossPct);
      slSource = 'config-default';
      logParts.push(`SL=config default ${(safeStopLossPct * 100).toFixed(1)}%`);
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
      slPrice = entryPrice * (1 + safeStopLossPct);
      slSource = 'config-default';
      logParts.push(`SL=config default ${(safeStopLossPct * 100).toFixed(1)}%`);
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
      tpPrice = entryPrice * (1 + safeTakeProfitPct);
      tpSource = 'config-default';
      logParts.push(`TP=config default ${(safeTakeProfitPct * 100).toFixed(1)}%`);
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
      tpPrice = entryPrice * (1 - safeTakeProfitPct);
      tpSource = 'config-default';
      logParts.push(`TP=config default ${(safeTakeProfitPct * 100).toFixed(1)}%`);
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
  // v2.0.836: PROFILE + DCS SL/TP SCALING
  // DCS-aware continuous scaling of SL/TP based on risk profile + DCS score.
  // Aggressive: SL wider (×1.0–1.3), TP wider (×1.0–1.5)
  // Moderate:   SL ×1.0, TP ×1.0 (standard, never changes)
  // Conservative: SL tighter (×0.7–1.0), TP tighter (×0.8–1.0)
  // ═══════════════════════════════════════════════════════════════

  const safeDcs = Number.isFinite(input.dcs ?? 0) && (input.dcs ?? 0) >= 0 ? (input.dcs ?? 0) : 0;
  const profile = input.riskProfile ?? 'moderate';

  // SL/TP multipliers from DCS (continuous, not tiered)
  const slMultiplier = profile === 'aggressive' ? 1.0 + 0.3 * safeDcs   // [1.0, 1.3]
    : profile === 'conservative' ? 0.7 + 0.3 * safeDcs                  // [0.7, 1.0]
    : 1.0;                                                              // moderate
  const tpMultiplier = profile === 'aggressive' ? 1.0 + 0.5 * safeDcs  // [1.0, 1.5]
    : profile === 'conservative' ? 0.8 + 0.2 * safeDcs                 // [0.8, 1.0]
    : 1.0;                                                              // moderate

  // Apply SL/TP scaling (only if prices are finite and > 0)
  if (Number.isFinite(slPrice) && slPrice > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    const slPctBeforeScale = Math.abs(slPrice - entryPrice) / entryPrice;
    const scaledSlPct = slPctBeforeScale * slMultiplier;
    slPrice = isBuy ? entryPrice * (1 - scaledSlPct) : entryPrice * (1 + scaledSlPct);
    if (slMultiplier !== 1.0) {
      logParts.push(`[DCS-SL] ×${slMultiplier.toFixed(3)} (${profile}, DCS=${safeDcs.toFixed(2)})`);
    }
  }
  if (Number.isFinite(tpPrice) && tpPrice > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    const tpPctBeforeScale = Math.abs(tpPrice - entryPrice) / entryPrice;
    const scaledTpPct = tpPctBeforeScale * tpMultiplier;
    tpPrice = isBuy ? entryPrice * (1 + scaledTpPct) : entryPrice * (1 - scaledTpPct);
    if (tpMultiplier !== 1.0) {
      logParts.push(`[DCS-TP] ×${tpMultiplier.toFixed(3)} (${profile}, DCS=${safeDcs.toFixed(2)})`);
    }
  }

  // Profile-specific caps
  const slCap = profile === 'aggressive' ? 0.07 : profile === 'conservative' ? 0.03 : 0.05;
  const tpCap = profile === 'aggressive' ? 0.15 : profile === 'conservative' ? 0.06 : 0.10;
  const tpMin = profile === 'aggressive' ? 0.005 : profile === 'conservative' ? 0.002 : 0.003;

  // ═══════════════════════════════════════════════════════════════
  // CAPS — SL max (profile-specific), TP max (profile-specific)
  // ═══════════════════════════════════════════════════════════════

  const finalSlPct = Math.abs(slPrice - entryPrice) / entryPrice;
  const finalTpPct = Math.abs(tpPrice - entryPrice) / entryPrice;

  if (finalSlPct > slCap + 1e-9) {
    slPrice = isBuy ? entryPrice * (1 - slCap) : entryPrice * (1 + slCap);
    logParts.push(`[SL-cap] narrowed from ${(finalSlPct * 100).toFixed(2)}% to ${(slCap * 100).toFixed(1)}%`);
  }
  if (finalTpPct > tpCap + 1e-9) {
    tpPrice = isBuy ? entryPrice * (1 + tpCap) : entryPrice * (1 - tpCap);
    logParts.push(`[TP-cap] narrowed from ${(finalTpPct * 100).toFixed(2)}% to ${(tpCap * 100).toFixed(1)}%`);
  }
  if (finalTpPct < tpMin - 1e-9) {
    tpPrice = isBuy ? entryPrice * (1 + tpMin) : entryPrice * (1 - tpMin);
    logParts.push(`[TP-min] widened from ${(finalTpPct * 100).toFixed(2)}% to ${(tpMin * 100).toFixed(1)}% (min viable)`);
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL VALUES + LOG
  // ═══════════════════════════════════════════════════════════════

  const slPctFinal = Math.abs(slPrice - entryPrice) / entryPrice;
  const tpPctFinal = Math.abs(tpPrice - entryPrice) / entryPrice;
  const rr = slPctFinal > 0 ? tpPctFinal / slPctFinal : 0;

  // v2.0.835 security: final finite guard — floating-point overflow can produce
  // Infinity when entryPrice is very large (Number.MAX_VALUE × 0.95 = Infinity).
  // Without this, NaN/Infinity SL or TP propagates to the trading engine.
  const finiteFallback = (pct: number) =>
    Number.isFinite(entryPrice * (1 - pct)) ? entryPrice * (1 - pct) : entryPrice / (1 + pct);
  const safeSl = Number.isFinite(slPrice) ? slPrice : (isBuy ? finiteFallback(0.05) : finiteFallback(-0.05));
  const safeTp = Number.isFinite(tpPrice) ? tpPrice : (isBuy ? finiteFallback(-0.03) : finiteFallback(0.03));
  const safeSlPct = Number.isFinite(slPctFinal) ? slPctFinal : 0.02;
  const safeTpPct = Number.isFinite(tpPctFinal) ? tpPctFinal : 0.03;
  const safeRr = Number.isFinite(rr) ? rr : 0;

  const logStr = `${isBuy ? 'BUY' : 'SELL'} entry=$${entryPrice.toFixed(2)} SL=$${safeSl.toFixed(2)} (${(safeSlPct * 100).toFixed(2)}%, ${slSource}) TP=$${safeTp.toFixed(2)} (${(safeTpPct * 100).toFixed(2)}%, ${tpSource}) R:R=${safeRr.toFixed(2)} | ${logParts.join(', ')}`;

  log.info(`📐 [smart-sltp] ${logStr}`);

  return {
    sl: safeSl,
    tp: safeTp,
    slSource,
    tpSource,
    slPct: safeSlPct,
    tpPct: safeTpPct,
    rr: safeRr,
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