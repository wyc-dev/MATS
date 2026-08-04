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
// v2.0.849: Consume the stop-out-trained execution lens that index.ts prepares
// before each trade. Previously only the DEAD computeATRSLTP read this lens, so
// the momentum-adaptive + execution-lens SL widening never reached real trades.
import { getPendingExecutionLens } from './atr.ts';

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
  /** v2.0.849: Adverse short-term momentum (fraction, e.g. 0.03 = +3% AGAINST
   *  this position). When > 0, the SL distance is widened to cover 2.5× the
   *  adverse momentum range so a continuation of the push doesn't stop the
   *  position out before the thesis plays out. This is the v2.0.207 (#C) fix
   *  ported onto the LIVE `computeSmartSLTP` path (was only in dead
   *  `computeATRSLTP`). */
  adverseMomentum?: number;
  /** v2.0.849: OLR P(win) confidence (0-1). High confidence → wider SL to avoid
   *  premature stops; low confidence → tighter SL. Ported from v2.0.231. */
  olrConfidence?: number;
  /** v2.0.852: Position leverage. Higher leverage amplifies the margin impact of
   *  any price move, so the SL distance must be widened to avoid normal-volatility
   *  stop-outs destroying the (smaller) margin. Only affects the SL floor; it
   *  never narrows a structurally-placed SL. Default 1 (no scaling). */
  leverage?: number;
  /** v2.0.852: Data-driven MFE calibration (from mfe-calibrator.ts). When
   *  present, overrides the TP target with the median favourable extension in
   *  the position's direction (×0.8), caps TP at the 90th-percentile extension,
   *  and raises the SL floor to the 95th-percentile adverse excursion so
   *  high-leverage positions aren't noise-stopped. Direction-aware: BUY uses
   *  tpTargetLongPct/tpCapLongPct/slFloorLongPct; SELL uses the *ShortPct fields.
   *  Legacy flat fields (tpTargetPct/tpCapPct/slFloorPct) are accepted and used
   *  for BOTH directions (backward-compatible for tests). */
  mfeCalibration?: {
    tpTargetPct?: number;
    tpCapPct?: number;
    slFloorPct?: number;
    tpTargetLongPct?: number;
    tpCapLongPct?: number;
    slFloorLongPct?: number;
    tpTargetShortPct?: number;
    tpCapShortPct?: number;
    slFloorShortPct?: number;
  };
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

  // ═══════════════════════════════════════════════════════════════
  // v2.0.852: LEVERAGE-AWARE SL FLOOR (fix #A)
  // A structural S/R-based SL can sit very close to entry (e.g. 0.81%).
  // On a 10x position that means a 0.81% adverse price move wipes out ~8%
  // of margin — normal volatility can stop the position out long before
  // the thesis plays out (this is exactly the SILVER SELL defect: entry
  // $56.82, SL $57.28 = +0.81%, got stopped out by routine noise).
  // Higher leverage amplifies margin impact, so we scale the MINIMUM SL
  // distance with leverage. This is a FLOOR only — it never narrows a
  // structurally-wide SL, and downstream momentum/exec-lens widenings still
  // apply on top. Clamped so it cannot exceed the SL cap (5%) nor go below
  // the 1.5×ATR floor.
  //
  // levFactor grows sub-linearly so 20x does not produce absurdly wide stops:
  //   1x → 1.0, 5x → 1.6, 10x → 2.35, 20x → 3.85 (then clamped to 5%).
  // ═══════════════════════════════════════════════════════════════
  const rawLeverage = Number.isFinite(input.leverage ?? 1) ? (input.leverage ?? 1) : 1;
  const leverage = Math.max(1, Math.min(50, rawLeverage)); // sane clamp [1, 50]
  const levFactor = 1.0 + (leverage - 1) * 0.15;
  const levFloorPct = Math.min(0.05, Math.max(slFloorPct, 0.01 * levFactor));
  if (levFloorPct > slFloorPct && levFloorPct > Math.abs(slPrice - entryPrice) / entryPrice) {
    const levCurrentSlPct = Math.abs(slPrice - entryPrice) / entryPrice;
    slPrice = isBuy
      ? entryPrice * (1 - levFloorPct)
      : entryPrice * (1 + levFloorPct);
    logParts.push(`[SL-leverage] widened from ${(levCurrentSlPct * 100).toFixed(2)}% to ${(levFloorPct * 100).toFixed(2)}% (${leverage}x, factor ${levFactor.toFixed(2)})`);
  }

  const currentSlPct = Math.abs(slPrice - entryPrice) / entryPrice;

  if (currentSlPct < slFloorPct) {
    // SL too narrow — widen to ATR floor (prevents noise stop-out)
    slPrice = isBuy
      ? entryPrice * (1 - slFloorPct)
      : entryPrice * (1 + slFloorPct);
    logParts.push(`[SL-floor] widened from ${(currentSlPct * 100).toFixed(2)}% to ${(slFloorPct * 100).toFixed(2)}% (1.5×ATR)`);
  }

  // ═══════════════════════════════════════════════════════════════
  // v2.0.849: MOMENTUM-ADAPTIVE + EXECUTION-LENS + CONFIDENCE SL WIDENING
  // Ported onto the LIVE `computeSmartSLTP` path. These protections existed
  // only in `computeATRSLTP` — which is DEAD CODE (never called by
  // trading-manager) — so high-confidence trades kept getting stopped out in
  // 3-22 min by continued adverse push. Now the live SL adapts to:
  //   1. Confidence (v2.0.231): P(win) > 0.8 → 2.5×ATR; < 0.5 → 1.2×ATR (base)
  //   2. Raw adverse momentum (v2.0.207 #C): SL ≥ 2.5×adverseMomentum
  //   3. Execution-lens momentum (v2.0.213 #7): stop-out-trained adverse move
  //   4. Execution-lens volatility scaling (v2.0.213): vol > 1.5× implied → up to +40%
  //   5. Entropy dampening (v2.0.213): uncertain lens → dampen widening 50%
  //
  // SEMANTIC INVARIANT (v2.0.849-fix): confidence only sets the BASE ATR floor
  // multiplier. Momentum + execution-lens widenings are applied AFTER as
  // unconditional hard floors (Math.max) — so a low-confidence trade NEVER
  // strips adverse-momentum / exec-lens protection, and a high-confidence trade
  // is never narrowed. This exactly mirrors computeATRSLTP (which sets
  // effectiveSlMult first, then Math.max's momentum/exec-lens on top).
  // ═══════════════════════════════════════════════════════════════

  // Helper: set the SL distance from entry as a fraction.
  const setSlPct = (pct: number): void => {
    slPrice = isBuy ? entryPrice * (1 - pct) : entryPrice * (1 + pct);
  };
  const getSlPct = (): number => Math.abs(slPrice - entryPrice) / entryPrice;

  // 0. Confidence scaling (v2.0.231) — sets the BASE ATR floor multiplier.
  //    Applied here (base stage) so momentum/exec-lens below can only widen.
  const conf = Number.isFinite(input.olrConfidence ?? 0)
    ? Math.max(0, Math.min(1, input.olrConfidence ?? 0))
    : 0;
  let baseSlFloorPct = slFloorPct; // 1.5×ATR default
  let confLabel = '';
  if (conf > 0.8) {
    baseSlFloorPct = Math.max(slFloorPct, atrPct > 0 ? atrPct * 2.5 : 0.008);
    confLabel = `[SL-conf] base ${(baseSlFloorPct * 100).toFixed(2)}% (P(win)=${(conf * 100).toFixed(0)}%)`;
  } else if (conf < 0.5 && conf > 0) {
    baseSlFloorPct = atrPct > 0 ? Math.min(slFloorPct, Math.max(atrPct * 1.2, 0.005)) : slFloorPct;
    confLabel = `[SL-conf] base ${(baseSlFloorPct * 100).toFixed(2)}% (P(win)=${(conf * 100).toFixed(0)}%)`;
  }
  if (confLabel && baseSlFloorPct > getSlPct()) {
    setSlPct(baseSlFloorPct);
    logParts.push(confLabel);
  } else if (confLabel) {
    logParts.push(confLabel);
  }

  // ── HARD FLOOR (v2.0.849 fix): the MINIMUM SL distance that no downstream
  // dampening (high-entropy) may go below. Combines the (confidence-scaled) ATR
  // floor with the raw adverse-momentum floor. Low-confidence is handled at the
  // base stage above — it cannot undo momentum/exec-lens applied below.
  const advMom = Number.isFinite(input.adverseMomentum ?? 0)
    ? Math.max(0, input.adverseMomentum ?? 0)
    : 0;
  const momFloorPct = Math.min(advMom * 2.5, 0.05); // 2.5× range, capped 5%
  const hardFloorPct = Math.max(baseSlFloorPct, momFloorPct);

  // 1. Raw adverse momentum floor (v2.0.207 #C) — apply once.
  if (momFloorPct > getSlPct()) {
    setSlPct(momFloorPct);
    logParts.push(`[SL-momentum] widened to ${(momFloorPct * 100).toFixed(2)}% (2.5× adverseMomentum ${(advMom * 100).toFixed(2)}%)`);
  }

  // 2-4. Execution lens (v2.0.213 #7). Cold-start safe: no lens / not blended /
  //      wExecution untrained → skip (identical to pre-v2.0.849 behavior).
  const execLens = getPendingExecutionLens();
  const useExecLens = execLens && execLens.blended && execLens.updateCount > 0;
  if (useExecLens) {
    // Base SL distance (ATR floor + raw momentum) BEFORE the execution lens.
    // execWidening tracks the TOTAL exec-lens contribution OVER this base —
    // so high-entropy dampening (base + widening×0.5) mirrors computeATRSLTP
    // exactly. Increment-based tracking under-counted and the dampened SL
    // stayed at the cap (attack-test failure).
    const execBasePct = getSlPct();
    let execWidening = 0;

    // 2a. Execution adverse momentum — filtered through wExecution's stop-out
    //     learning. Replaces raw momentum as primary when the lens is trained.
    const execMom = execLens!.momentumShort;
    const execAdverse = isBuy ? Math.max(0, -execMom) : Math.max(0, execMom);
    if (execAdverse > 0) {
      const execMomFloorPct = Math.min(execAdverse * 2.5, 0.05);
      if (execMomFloorPct > getSlPct()) {
        execWidening = Math.max(execWidening, execMomFloorPct - execBasePct);
        setSlPct(execMomFloorPct);
      }
    }

    // 2b. Execution volatility scaling — if the lens sees elevated volatility
    //     through the stop-out filter, widen SL by up to 40%.
    const currentImpliedVol = atrPct; // ATR/entryPrice (0 if no ATR)
    if (execLens!.volatility > currentImpliedVol * 1.5 && currentImpliedVol > 0) {
      const volRatio = Math.min(execLens!.volatility / currentImpliedVol, 3.0);
      const volWidenFactor = 1.0 + Math.min((volRatio - 1.0) * 0.2, 0.4); // up to +40%
      const volSlPct = getSlPct() * volWidenFactor;
      if (volSlPct > getSlPct()) {
        execWidening = Math.max(execWidening, volSlPct - execBasePct);
        setSlPct(volSlPct);
      }
    }

    // 2c. Entropy confidence — low entropy = confident pattern → trust widening;
    //     high entropy (> 2.0 for 9 sources, log2(9) ≈ 3.17) → dampen 50%.
    //     The dampened SL may not fall below the HARD floor (ATR + raw momentum).
    if (execLens!.entropy > 2.0) {
      const dampedPct = execBasePct + execWidening * 0.5;
      const finalPct = Math.max(hardFloorPct, dampedPct);
      if (finalPct < getSlPct()) {
        setSlPct(finalPct);
        logParts.push(`[SL-entropy] dampened (entropy ${execLens!.entropy.toFixed(2)} > 2.0)`);
      }
    } else if (execWidening > 0) {
      logParts.push(`[SL-exec-lens] widened ${(execWidening * 100).toFixed(2)}% (stop-out-trained)`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // v2.0.836: PROFILE + DCS SL/TP SCALING
  // DCS-aware continuous scaling of SL/TP based on risk profile + DCS score.
  // Aggressive: SL wider (×1.0–1.3), TP wider (×1.0–1.5)
  // Moderate:   SL ×1.0, TP ×1.0 (standard, never changes)
  // Conservative: SL tighter (×0.7–1.0), TP tighter (×0.8–1.0)
  // ═══════════════════════════════════════════════════════════════

  // v2.0.836: Clamp DCS to [0, 1] — same fix as dcs-calculator.ts and
  // analysis-matrix.ts. The previous code only checked `>= 0`, so an untrusted
  // DCS > 1 (e.g. 5) silently inflated the SL multiplier (×2.5) and TP
  // multiplier (×3.5), widening SL/TP far beyond the designed [1.0, 1.3] /
  // [1.0, 1.5] range before the caps clamped them. Negative DCS is invalid.
  const safeDcs = Number.isFinite(input.dcs ?? 0)
    ? Math.max(0, Math.min(1, input.dcs ?? 0))
    : 0;
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
  // v2.0.852 (fix #D): MFE-CALIBRATED TP TARGET + DATA-DRIVEN CAP + SL FLOOR
  // Uses the real historical price-extension distribution (candle-derived,
  // immune to the contaminated TradeRecord.MFE fields) to:
  //   1. TP target ← median favourable 1h extension (realistic profit aim,
  //      not an unreachable 5× MFE). Only tightens if the structural S/R TP
  //      was aiming too far (the "TP set too far → giveback" failure).
  //   2. TP cap   ← 90th-percentile extension (data-driven ceiling that
  //      replaces the fixed 10% ceiling only when the data says price rarely
  //      runs further; the fixed cap still applies as an absolute backstop).
  //   3. SL floor ← 95th-percentile adverse 5m excursion (noise floor so a
  //      high-leverage position isn't stopped out by routine noise).
  // All are FLOORS/CEILINGS — they never remove the structural S/R placement,
  // they only correct over-optimistic / over-tight values.
  // ═══════════════════════════════════════════════════════════════
  const cal = input.mfeCalibration;
  if (cal) {
    // Defense-in-depth (attack fix #9): clamp caller-supplied calibration values
    // to sane bounds BEFORE use. Callers may be untrusted (constructed at runtime
    // from arbitrary sources); an unbounded tpTargetPct could push TP to an
    // absurd level before the cap logic runs. Hard clamps mirror buildCalibration:
    //   tpTarget ∈ [0.003, 0.20], tpCap ∈ [0.005, 0.30], slFloor ∈ [0.005, 0.15].
    //
    // DIRECTION-AWARE (fix: BUY ≠ SELL): select the calibration values for the
    // position's direction. A LONG's TP rides the upswing and its SL is pierced
    // by a down-move; a SHORT's TP rides the downswing and its SL by an up-move.
    const calTpTarget = Number.isFinite(cal.tpTargetPct ?? cal[isBuy ? 'tpTargetLongPct' : 'tpTargetShortPct'])
      ? Math.max(0.003, Math.min(0.20, (cal.tpTargetPct ?? cal[isBuy ? 'tpTargetLongPct' : 'tpTargetShortPct'])!))
      : 0;
    const calTpCap = Number.isFinite(cal.tpCapPct ?? cal[isBuy ? 'tpCapLongPct' : 'tpCapShortPct'])
      ? Math.max(0.005, Math.min(0.30, (cal.tpCapPct ?? cal[isBuy ? 'tpCapLongPct' : 'tpCapShortPct'])!))
      : 0;
    const calSlFloor = Number.isFinite(cal.slFloorPct ?? cal[isBuy ? 'slFloorLongPct' : 'slFloorShortPct'])
      ? Math.max(0.005, Math.min(0.15, (cal.slFloorPct ?? cal[isBuy ? 'slFloorLongPct' : 'slFloorShortPct'])!))
      : 0;

    // 1. TP target — `calTpTarget` is ALREADY median×0.8 (the calibrated aim).
    //    If the structural S/R TP is aiming FURTHER than this realistic target
    //    (beyond ~1.1× to tolerate level noise), pull TP in to the calibrated
    //    target so profit is realised instead of given back. A 10% tolerance
    //    prevents churn when the structural TP is only marginally further.
    const tpPctBeforeCal = Math.abs(tpPrice - entryPrice) / entryPrice;
    if (calTpTarget > 0 && tpPctBeforeCal > calTpTarget * 1.1) {
      tpPrice = isBuy ? entryPrice * (1 + calTpTarget) : entryPrice * (1 - calTpTarget);
      logParts.push(`[MFE-TP] target ${(calTpTarget * 100).toFixed(2)}% (median 1h ext ×0.8) — pulled in from ${(tpPctBeforeCal * 100).toFixed(2)}%`);
    }

    // 2. TP cap — data-driven ceiling, but never below the fixed absolute cap.
    const effectiveTpCap = Math.min(tpCap, Math.max(calTpCap, tpMin * 1.5));
    const tpPctAfterTarget = Math.abs(tpPrice - entryPrice) / entryPrice;
    if (effectiveTpCap > 0 && tpPctAfterTarget > effectiveTpCap) {
      tpPrice = isBuy ? entryPrice * (1 + effectiveTpCap) : entryPrice * (1 - effectiveTpCap);
      logParts.push(`[MFE-TP-cap] ${(effectiveTpCap * 100).toFixed(2)}% (90th pct 1h ext, fixed cap ${(tpCap * 100).toFixed(1)}%)`);
    }

    // 3. SL floor — noise floor from adverse 5m excursion. Only widens SL if
    //    the current SL is tighter than this floor (and still below SL cap).
    if (calSlFloor > 0) {
      const slPctNow = Math.abs(slPrice - entryPrice) / entryPrice;
      const slFloorApplied = Math.min(slCap, Math.max(calSlFloor, slPctNow));
      if (slFloorApplied > slPctNow) {
        slPrice = isBuy ? entryPrice * (1 - slFloorApplied) : entryPrice * (1 + slFloorApplied);
        logParts.push(`[MFE-SL-floor] ${(slFloorApplied * 100).toFixed(2)}% (95th pct 5m adverse)`);
      }
    }
  }

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
  // v2.0.852 (attack fix #4): TP must NEVER cross SL (R:R >= 0).
  // The MFE TP target pulls TP in toward entry — if SL was widened (leverage /
  // momentum / MFE SL floor) and TP pulled in too far, TP can end up on the
  // WRONG side of SL (BUY: TP below SL, or SELL: TP above SL). A crossed
  // SL/TP pair is degenerate: one always triggers immediately or they cancel
  // out on HL. Enforce a minimum gap of `tpMin` between SL and TP, widening
  // TP away from SL as needed. This only fires on degenerate cases; it never
  // narrows a sane TP.
  // ═══════════════════════════════════════════════════════════════
  const slAfter = Math.abs(slPrice - entryPrice) / entryPrice;
  const tpAfter = Math.abs(tpPrice - entryPrice) / entryPrice;
  const gapPct = Math.abs(slAfter - tpAfter);
  if (slAfter > 0 && gapPct < tpMin - 1e-9) {
    // Too close / crossed → push TP out so gap >= tpMin on the profit side.
    // Clamp to tpCap so the widened TP never exceeds the profile ceiling
    // (the CAPS block already ran, so we must re-apply the cap here).
    const tpFromSL = Math.min(tpCap, Math.max(tpAfter, slAfter + tpMin));
    tpPrice = isBuy ? entryPrice * (1 + tpFromSL) : entryPrice * (1 - tpFromSL);
    logParts.push(`[SL/TP-gap] widened TP from ${(tpAfter * 100).toFixed(2)}% to ${(tpFromSL * 100).toFixed(2)}% to keep ≥${(tpMin * 100).toFixed(2)}% gap from SL (${(slAfter * 100).toFixed(2)}%)`);
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