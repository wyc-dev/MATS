/**
 * resolveClosePipelineReason — 層級化 close 流水線嘅關倉原因解析（v2.0.873-P9-close-pipeline-fix）
 *
 * 問題（Fix A 邏輯實驗 E1/E2 實證）:
 *   層級化 close 流水線所有路徑（SL hit / MFE 鎖利 / 虧損止血 / 盈利止盈 / Skeptics 通過）
 *   統一 tag `closeReason='consensus'`（index.ts 12781）→ 學習歸因層污染:
 *   ① SL hit（真市場確認破位）被當「系統共識決策」→ computeLearningWeight 由應有嘅
 *      1.0 折半成 0.5（learning-weight.ts: 真 market signal 被打折）
 *   ② MFE 鎖利被當 consensus → close-decision-calibrator 收唔到 'exit_price_lock'
 *      歸因（CLOSE_REASONS_TO_CALIBRATE 有 exit_price_lock 但流水線冇用）
 *
 * 修復語義（以「實際離場機制」而非「執行入口」為準）:
 *   - closeStructureConfirmed（價格真穿 SL）→ 'sl_tp'——市場確認破位, 真風險訊號, weight 1.0
 *   - mfeLock（MFE 鎖利 advice 觸發）→ 'exit_price_lock'——系統鎖利決策, 歸因歸位
 *   - 其餘（共識 close / Meta-Agent override 止血 / 盈利共識止盈 / Skeptics 通過閉環）
 *     → 'consensus'——agents/仲裁者決策, 系統決策語義正確（0.5）
 *
 * 設計: 純函數 + 單一 source of truth——所有 call site 必須行過呢度先可以傳 reason
 * 落 closeTrade(), 唔可以再喺 call site 亂寫 reason（v2.0.855-attack sanitize 係最後防線,
 * 呢度係語義層第一防線）。
 */
import type { TradeRecord } from '../types/index.ts';

export type ClosePipelineReasonInput = {
  /** 價格已穿 SL（買倉 cur<=SL / 賣倉 cur>=SL）——市場確認 thesis 破位 */
  closeStructureConfirmed: boolean;
  /** close-calibrator MFE 鎖利 advice 觸發（唔 hold, 直接 close） */
  mfeLock: boolean;
};

/**
 * 解析層級化 close 流水線嘅真實離場原因。
 * Priority: SL hit（市場）> MFE 鎖利（系統鎖利）> consensus（決策）。
 * 返回永遠合法（白名單內）——唔需要再 sanitize。
 */
export function resolveClosePipelineReason(input: ClosePipelineReasonInput): TradeRecord['closeReason'] {
  const { closeStructureConfirmed, mfeLock } = input;
  if (closeStructureConfirmed === true) return 'sl_tp'; // 真市場確認——最高權重訊號
  if (mfeLock === true) return 'exit_price_lock'; // 系統鎖利——歸因歸位
  return 'consensus'; // 共識 / 止血 / 止盈——系統決策
}

/** 兼容 helper：將 raw 值（可能係 garbage）轉成 boolean（attack-hardening 一致） */
export function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true';
}
