// ─── Trend-Defer Profit Run — v2.0.876-TREND-DEFER（2026-09-13, 主神「trend 唔識堅持唔斷 TP」）──
//
// 問題實錘（PLAN_trend-aware-exit v2, Phase 2 counterfactual）:
//   close-path-archive 509 條（280 BUY 有 postClose）:
//     lock 50% MFE: Σ47pp（29/280 有增益）/ lock 80%: Σ69pp（38 筆）/ 唔 lock: Σ81pp（48 筆）
//     → 「唔鎖」比「鎖」多 Σ12pp —— let-run 有真 alpha（831: 樣本≥30 且 Σ正）。
//   BNB 12 筆全 exit_price_lock（+0.19%~+11.79%）, 間隔 1-4h —— 鎖 1% → reentry → 再鎖循環:
//   trend 行咗好遠, 但系統每注只食雞碎。
//
// 根因（runExitPriceLockGate, index.ts→live-mfe shouldTrailingLock / decideTrailingLockAction）:
//   L3 decision==='none'（創新高）→ fall through 到 PAEL final close 即鎖 —— 系統喺
//   MFE ≥ threshold 就鎖, 趨勢繼續升但永遠「鎖喺新高位」, 冇真正 hold 機制。
//
// Fix（soft, 唔 block, 唔改 mean-reversion 主邏輯）:
//   shouldDeferTrendLock —— 當 4h trending + 持倉方向對齊 trend + 已盈（≥門檻）時,
//   PAEL「即鎖」改為 defer → 交俾 L3 trailing（峰值回吐 ≥50% 先鎖, pending 確認）;
//   創新高 → 刷新 peak 繼續 hold（趨勢有效時唔鎖）。
//   震盪市 / 反向倉 / 未盈倉 → 100% 原邏輯（保護系統最大賺錢來源: mean-reversion 買 dip）。
//
// 純函數單一 source of truth —— index.ts 只做 wiring。毒輸入一律 false（保守唔 defer）。

import { MAX_LIVE_MFE_PCT } from './live-mfe.ts';

/** 觸發門檻: 盈倉（margin %, 0.005 = +0.5%）。
 *  與 PROFIT_LOCK_MARGIN_THRESHOLD_PCT（live-mfe.ts, 預設 0.5%）對稱——
 *  連微利都未夠嘅倉唔可能係「trend 讓利」主角, 止血/正常管道優先。 */
export const TREND_DEFER_MIN_PROFIT_PCT = 0.005;

export interface TrendDeferInput {
  /** regime 是否含 'trending'（4h/1d 大框趨勢） */
  isTrending: boolean;
  /** 1h 趨勢方向: 'up' | 'down' | 'sideways'（lastKlineSummary.trend1h） */
  trend1h: string | null | undefined;
  /** 持倉方向: 'buy' | 'sell' */
  side: 'buy' | 'sell';
  /** 當前浮盈（margin %, 0.01 = +1%）—— 實時重算, 唔用 stale unrealizedPnl */
  pnlPctNow: number;
}

/**
 * 決定 PAEL「即鎖」要唔要 defer（交 L3 trailing 回吐追蹤, 等 trend 行多啲）。
 *   true  = defer（trend 對齊 + 盈倉 → 唔鎖, 交 L3 峰值回吐 ≥50% 先鎖）
 *   false = 原邏輯 100% 不變
 * 毒輸入一律 false（保守唔 defer —— 原邏輯照行, 唔會因為我哋嘅改動誤鎖/誤放）。
 */
export function shouldDeferTrendLock(i: TrendDeferInput): boolean {
  if (!i || typeof i !== 'object') return false;
  if (i.isTrending !== true) return false;                       // 唔係 trending regime → 唔 defer
  if (!Number.isFinite(i.pnlPctNow) || i.pnlPctNow <= 0) return false; // 未盈/垃圾 pnl → 唔 defer
  if (i.pnlPctNow < TREND_DEFER_MIN_PROFIT_PCT) return false;    // 微利未達門檻 → 唔 defer
  if (i.side !== 'buy' && i.side !== 'sell') return false;       // garbage side → 唔 defer
  const t = String(i.trend1h ?? '').toLowerCase();
  if (t !== 'up' && t !== 'down') return false;                  // sideways/unknown/garbage → 唔 defer
  // 方向對齊: buy 倉要 trend up; sell 倉要 trend down
  if (i.side === 'buy') return t === 'up';
  return t === 'down';
}

// ─── 攻擊輪（2026-09-13, 主神「不擇手段攻擊 trend-defer 週邊」）─────────────
// V1 🔴: 位2 喺 liveMfe===null（candle 缺失/狀態注入）時照 continue → 無 MFE 數據 =
//        系統永遠唔鎖 → trend 反轉全數回吐（giveback 黑洞）。
// V4 🔴: pending 已存在（L3 確認期內）但 MFE 縮細 → L3 skip → 位2 見 pending 照 continue
//        → pending 永遠唔 close → 倉 hold 到 SL/反轉全蝕。
// 修復: 將「位2 defer 決策」抽成單一純函數 gate —— hasPendingLock / liveMfeAvailable
//       任一 guard 唔過 → 唔 defer（保守 fall through PAEL 原邏輯）。

export interface TrendDeferGateInput extends TrendDeferInput {
  /** 已有 L3 pending trailing lock（確認期內）——有就要交 L3 機制, 唔可以再 defer */
  hasPendingLock: boolean;
  /** live MFE 數據可用（candle 存在且有效）——冇數據唔可以 defer（會變永遠唔鎖） */
  liveMfeAvailable: boolean;
}

/**
 * 位2（PAEL final close 前）安全 defer 決策。
 * 所有條件: base defer 判斷 ∧ 冇 pending ∧ live MFE 可用。
 * 任一唔過 → false（fall through PAEL 原邏輯, 保守鎖利）。
 */
export function shouldDeferTrendLockGate(i: TrendDeferGateInput): boolean {
  if (!i || typeof i !== 'object') return false;
  if (i.hasPendingLock === true) return false;        // V4: 有 pending → 交 L3 確認（唔無限 defer）
  if (i.liveMfeAvailable !== true) return false;      // V1: 冇 live MFE → 照 PAEL 鎖（唔可以盲 defer）
  return shouldDeferTrendLock(i);
}

/**
 * 統一 peak price 計算（V3: 位1/位2 共用, 消除 drift）。
 * 毒輸入（side/entry/mfe 垃圾、mfe 超 cap、mfe=0）→ null（保守）。
 */
export function computeTrendPeakPrice(
  side: 'buy' | 'sell',
  entryPrice: number,
  mfePricePct: number | null | undefined,
): number | null {
  if (side !== 'buy' && side !== 'sell') return null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (mfePricePct === null || mfePricePct === undefined) return null;
  if (!Number.isFinite(mfePricePct)) return null;
  if (mfePricePct <= 0 || mfePricePct > MAX_LIVE_MFE_PCT) return null; // 0/負/超 cap（1e308 假 peak）→ null
  return side === 'sell'
    ? entryPrice * (1 - mfePricePct / 100)
    : entryPrice * (1 + mfePricePct / 100);
}
