// ─── Real SL/TP Local Watcher ─────────────────────────────────────────
// v2.0.873-P9-sltp-watch（主神 2026-09-02, #5 深挖）:
// 真相: HL native trigger 係 primary 保護, 但涉案單（DRAM -14.63%）
//   price 真穿 SL（candle L=55.145 < SL 55.222）而 HL trigger 冇觸發
//   （userFills 零 SL fill）——加上本地兩層兜底全部失效
//   （checkStopLossTakeProfit 零 caller + checkPositionExits 對 real skip）
//   = 雙裸奔。本 watcher 係 backup-of-record: HL trigger 存在時唔爭（防
//   double-close / race），HL trigger 缺失時用 HL 權威價（mark）檢查擊穿——
//   確保「任何 real 倉位任何時刻都唔可以裸奔」。
//
// 純函數（零 I/O, 零 side-effect）——全部 guard 可獨立測試。
// 攻擊硬化（v2.0.873-P9-sltp-watch-attack, 主神「不擇手段攻擊」紅先 7 中全修）:
//  V1: side 大小寫/語義（'SELL'/'Short'/'hold'/null/undefined）——唔可以
//      靜默 fallback BUY（方向顛倒 CRITICAL）→ 白名單 normalize, 垃圾 → skip
//  V2: boolean 字段 truthy 污染（hlHasTrigger/positionExists 傳 string）——
//      必須 strict boolean（'false' string 唔可以當 false）
//  V3: input/pos null 或 garbage（array/string/number）——解構前 guard, 唔 crash
//  V5: prototype pollution（o.coin 經 chain 攞到）——own-property check
//  V6: SL/TP 天文數字（1e308 finite）——合理範圍 clamp, 唔可以誤觸發

export interface SltpWatchPosition {
  symbol: string;
  side: 'buy' | 'sell';
  // 有效 SL/TP 價（本地 mirror 嘅權威副本——最後成功放設值）
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
}

export interface SltpWatchInput {
  pos: SltpWatchPosition;
  /** HL 權威現價（mark/allMids——唔可以用 local stale currentPrice） */
  hlPrice: number;
  /** HL 上是否已有 active trigger order 覆蓋呢個倉位（有 → 本地唔爭） */
  hlHasTrigger: boolean;
  /** 倉位仍存在於 portfolio mirror（防 double-close） */
  positionExists: boolean;
}

export type SltpWatchDecision =
  | { action: 'close'; reason: 'sl_tp' | 'tp_hit'; triggeredAt: number }
  | { action: 'skip'; reason: string };

const PRICE_MIN = 1e-9;
const PRICE_MAX = 1e9;
/** V6: SL/TP 合理範圍——超過 ±50% entry 距離嘅 SL 唔可能有效（1e308 天文數字
 *  唔可以成為「止蝕」基準——正常 SL 喺 0.1%~30% price 距離, 50% cap 寬鬆但安全） */
const SLTP_MAX_FRACTION = 0.5;

function safeNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** V1: side 白名單 normalize——codebase normalizeTradeSide 語義一致
 *  （'sell'/'short' → sell; 'buy'/'long' → buy; 垃圾 → null）。 */
function normalizeSide(side: unknown): 'buy' | 'sell' | null {
  const s = String(side ?? '').toLowerCase();
  if (s === 'sell' || s === 'short') return 'sell';
  if (s === 'buy' || s === 'long') return 'buy';
  return null;
}

/** V5: own-property safe getter——唔可以經 prototype chain 攞到垃圾值 */
function ownProp<T>(o: Record<string, unknown>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(o, key) ? (o[key] as T) : undefined;
}

/** 核心裁決: 呢個倉位而家應唔應該由本地 watcher 關閉?
 *  優先序:
 *  0. input/pos 必須有效 object（V3——null/garbage 唔 crash）
 *  1. 倉位唔存在 → skip（防 double-close）
 *  2. HL 已有 trigger 覆蓋 → skip（HL 自己會處理, 本地爭會 race/duplicate）
 *  3. side 必須白名單（V1——垃圾 side 唔可以假設 BUY）
 *  4. hlPrice 無效 → skip（唔可以靠垃圾價誤判）
 *  5. SL/TP 價無效 / 超範圍 → skip（冇保護基準 / 天文數字唔可以當止蝕）
 *  6. BUY: hlPrice ≤ SL → 止蝕; hlPrice ≥ TP → 止盈
 *     SELL: hlPrice ≥ SL → 止蝕; hlPrice ≤ TP → 止盈 */
export function decideLocalSltp(input: SltpWatchInput): SltpWatchDecision {
  // V3: input 必須有效 object
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { action: 'skip', reason: 'invalid-input' };
  }
  const { pos, hlPrice, hlHasTrigger, positionExists } = input;
  // V3: pos 必須有效 object
  if (!pos || typeof pos !== 'object' || Array.isArray(pos)) {
    return { action: 'skip', reason: 'invalid-pos' };
  }

  // V2: boolean 字段必須 strict boolean——'false' string（truthy）唔可以當 false
  if (positionExists !== true) return { action: 'skip', reason: 'position-gone' };
  if (hlHasTrigger === true) return { action: 'skip', reason: 'hl-trigger-present' };

  const price = safeNum(hlPrice);
  if (price === null || price < PRICE_MIN || price > PRICE_MAX) {
    return { action: 'skip', reason: 'invalid-hl-price' };
  }

  // V1: side 白名單——垃圾/大小寫/語義全部 normalize
  const side = normalizeSide(pos.side);
  if (side === null) return { action: 'skip', reason: 'invalid-side' };

  // V6: SL/TP 合理範圍——相對 price 唔可以超過 50%（1e308 天文數字 skip）
  const sl = safeNum(pos.stopLossPrice);
  const tp = safeNum(pos.takeProfitPrice);
  const slInRange = sl !== null && sl >= PRICE_MIN && sl <= PRICE_MAX
    && Math.abs(sl - price) / price <= SLTP_MAX_FRACTION;
  const tpInRange = tp !== null && tp >= PRICE_MIN && tp <= PRICE_MAX
    && Math.abs(tp - price) / price <= SLTP_MAX_FRACTION;

  // 完全冇有效 SL/TP → skip
  if (!slInRange && !tpInRange) return { action: 'skip', reason: 'invalid-sltp' };

  // SL 檢查
  if (slInRange) {
    if (side === 'buy' && price <= sl!) {
      return { action: 'close', reason: 'sl_tp', triggeredAt: Date.now() };
    }
    if (side === 'sell' && price >= sl!) {
      return { action: 'close', reason: 'sl_tp', triggeredAt: Date.now() };
    }
  }

  // TP 檢查
  if (tpInRange) {
    if (side === 'buy' && price >= tp!) {
      return { action: 'close', reason: 'tp_hit', triggeredAt: Date.now() };
    }
    if (side === 'sell' && price <= tp!) {
      return { action: 'close', reason: 'tp_hit', triggeredAt: Date.now() };
    }
  }

  return { action: 'skip', reason: 'not-triggered' };
}

/** 由 HL openOrders 原始 payload 判斷某 symbol 有冇 active trigger order 覆蓋。
 *  攻擊硬化: 垃圾 array / 垃圾欄位 → 安全 false（冇 trigger = watcher 會接手 = 保守正確）。
 *  V5: own-property check——prototype pollution 唔可以令 coin/triggerPx 由 chain 攞到。 */
export function hasHlTriggerForSymbol(
  orders: ReadonlyArray<{ coin?: unknown; reduceOnly?: unknown; triggerPx?: unknown; orderType?: unknown }>,
  symbol: string,
): boolean {
  if (!Array.isArray(orders) || !symbol || typeof symbol !== 'string') return false;
  const sym = symbol.toLowerCase();
  for (const o of orders) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    // V5: own-property——唔可以經 prototype chain 攞 coin
    const coinRaw = ownProp<unknown>(o as Record<string, unknown>, 'coin');
    if (coinRaw === undefined || coinRaw === null) continue;
    if (typeof coinRaw !== 'string') continue; // 垃圾 coin（number/object）唔可以 match
    if (coinRaw.toLowerCase() !== sym) continue;

    // trigger order 特徵: reduceOnly（SL/TP 永遠 reduce-only）+ 有 triggerPx / orderType.trigger
    const triggerPx = ownProp<unknown>(o as Record<string, unknown>, 'triggerPx');
    const hasTriggerPx = triggerPx !== undefined && triggerPx !== null;
    const ot = ownProp<unknown>(o as Record<string, unknown>, 'orderType');
    const hasOrderTypeTrigger = typeof ot === 'object' && ot !== null
      && ownProp<unknown>(ot as Record<string, unknown>, 'trigger') !== undefined;
    if (hasTriggerPx || hasOrderTypeTrigger) return true;
  }
  return false;
}
