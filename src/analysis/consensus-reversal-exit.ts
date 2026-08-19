/**
 * v2.0.870-P43: 加強版共識反轉止蝕(組件 2)
 *
 * 背景(主神 vision):「真係轉 trend 嘅時候識得用共識提早止蝕,先係真正智能」。
 * 闊 SL 防噪音(假反轉),共識反轉止蝕防真反轉(唔等闊 SL 被打)。
 *
 * 加強點(唔係單次 flip 就離場,係「確認反轉」):
 *   ① 共識方向反轉(SELL 倉 → 共識轉 BUY)
 *   ② 確認:連續 N 個 cycle 都反轉(過濾噪音 flip)
 *   ③ 信心:反轉信心 ≥ 門檻(過濾弱 flip)
 *   ④ 趨勢互證:trend 都反轉(雙重確認)
 * 四條件全中先離場。
 *
 * 紀律:純函數、無副作用;NaN/大小寫/unknown 安全;env flag 回滾。
 */

export interface ReversalExitConfig {
  /** 連續反轉 cycle 數門檻(過濾噪音) */
  confirmCycles: number;
  /** 反轉信心門檻(0-1) */
  minConfidence: number;
}

export const DEFAULT_REVERSAL_EXIT_CONFIG: ReversalExitConfig = {
  confirmCycles: 2,
  minConfidence: 0.55,
};

/** 持倉 side 正規化——hostile side(hold/''/__proto__/數字)返 null,
 *  唔准被當做 'sell' 誤觸發反轉止蝕(P43-attack2 A2)。 */
export function normalizePositionSide(side: unknown): 'buy' | 'sell' | null {
  const s = String(side ?? '').toLowerCase();
  if (s === 'buy' || s === 'long') return 'buy';
  if (s === 'sell' || s === 'short') return 'sell';
  return null;
}

/** 共識方向係咪同持倉方向相反 */
export function isOpposedDirection(positionSide: 'buy' | 'sell', consensusAction: string | undefined | null): boolean {
  const a = (consensusAction ?? '').toLowerCase();
  if (positionSide === 'sell') return a === 'buy';
  if (positionSide === 'buy') return a === 'sell';
  return false;
}

/** trend 係咪同持倉方向相反(雙重確認) */
export function isTrendOpposed(positionSide: 'buy' | 'sell', trend: string | undefined | null): boolean {
  const t = (trend ?? '').toLowerCase();
  if (positionSide === 'sell') return t === 'bullish';
  if (positionSide === 'buy') return t === 'bearish';
  return false;
}

export function shouldExitOnReversal(
  positionSide: 'buy' | 'sell',
  consensusAction: string | undefined | null,
  consensusConfidence: number,
  consecutiveOpposedCycles: number,
  trend: string | undefined | null,
  config: ReversalExitConfig = DEFAULT_REVERSAL_EXIT_CONFIG,
): boolean {
  // ① 共識方向反轉
  if (!isOpposedDirection(positionSide, consensusAction)) return false;
  // ② 確認:連續 N cycle(consecutiveOpposedCycles 由 caller 追蹤)
  if (!Number.isFinite(consecutiveOpposedCycles) || consecutiveOpposedCycles < config.confirmCycles) return false;
  // ③ 信心門檻(NaN/Infinity/污染值 >1 盾——信心必須 0-1)
  if (!Number.isFinite(consensusConfidence) || consensusConfidence < config.minConfidence || consensusConfidence > 1) return false;
  // ④ 趨勢互證
  if (!isTrendOpposed(positionSide, trend)) return false;
  return true;
}
