// ─── Trend-Hold Gate ──────────────────────────────────────────────────
// v2.0.870: 量化金融分析師思路——trend-following 第一原則係 let winners
// run。當 close 訊號出現，如果 4h/1h momentum 仍然支持持倉方向 + 盈利 +
// 冇 SL/thesis 確認退出 → soft hold（降低 close 傾向）。
//
// 背景（主神報告）：BNB 連續 4 個 BUY trade 反覆 OPEN & CLOSE——
// $680.48 開到 $707.84 收，如果一直持有應該賺更多，中間進出淨係蝕
// 手續費 + 錯過趨勢。其中 trade 2（+8.6%）agents 全部投 HOLD 但系統
// close 咗，close 後價格繼續升 +2.9%——典型 whipsaw close。
//
// 設計：soft gate（唔 hard block——P49 裁決：判斷準確性靠學習系統唔靠
// block）。趨勢支持 + 盈利 → 降低 close 傾向（multiplier < 1），配合
// close-decision-calibrator 嘅 pending-close 確認機制（下 cycle 再 close
// = 確認執行；冇再 close = 取消揸住；3 cycle 超時兜底——唔會死揸）。

export interface TrendHoldInput {
  side: 'buy' | 'sell';
  /** 4h 本機蠟燭動量 % */
  momentum4h: number;
  /** 1h 本機蠟燭動量 % */
  momentum1h: number;
  closeReason: string;
  slHit: boolean;
  thesisInvalidated: boolean;
  wasProfitable: boolean;
  /** per-symbol × close-reason 過早率（0-1，close-decision-calibrator） */
  prematureRate?: number;
  prematureSamples?: number;
}

export interface TrendHoldResult {
  hold: boolean;
  /** close 傾向乘數——hold 時 < 1（soft），唔 hold 時 1 */
  multiplier: number;
  reason: string;
}

const MIN_PREMATURE_SAMPLES = 5;
/** 0.05%——低過係噪音，唔算趨勢支持 */
const MIN_MOMENTUM_PCT = 0.05;
/** 超過 ±100% 當垃圾（1e308 污染值唔可以觸發 hold） */
const MAX_MOMENTUM_PCT = 100;
/** prematureSamples 合理上限 */
const MAX_PREMATURE_SAMPLES = 100_000;

/** 純函數：判斷 close 訊號應唔應該被趨勢 hold。
 *  市場確認退出（SL hit / thesis invalidation）永遠唔 hold——死揸防禦。
 *  虧損 close 唔 hold——止血優先。趨勢支持 + 盈利 → soft hold。 */
export function shouldHoldForTrend(input: TrendHoldInput): TrendHoldResult {
  // 市場/判斷確認退出——永遠唔 hold
  if (input.slHit || input.thesisInvalidated) {
    return { hold: false, multiplier: 1, reason: 'market-confirmed exit (SL/thesis)' };
  }
  // 虧損 close——止血優先
  if (!input.wasProfitable) {
    return { hold: false, multiplier: 1, reason: 'stop-loss priority (losing)' };
  }
  // 垃圾/極端輸入——保守唔 hold（1e308 / NaN / Infinity 污染值）
  if (!Number.isFinite(input.momentum4h) || !Number.isFinite(input.momentum1h)) {
    return { hold: false, multiplier: 1, reason: 'invalid momentum' };
  }
  if (Math.abs(input.momentum4h) > MAX_MOMENTUM_PCT || Math.abs(input.momentum1h) > MAX_MOMENTUM_PCT) {
    return { hold: false, multiplier: 1, reason: 'momentum out of range' };
  }
  if (input.side !== 'buy' && input.side !== 'sell') {
    return { hold: false, multiplier: 1, reason: 'invalid side' };
  }

  // 趨勢支持持倉方向？雙窗確認 + 最小閾值（噪音唔觸發）
  const trendSupports = input.side === 'buy'
    ? input.momentum4h > MIN_MOMENTUM_PCT && input.momentum1h > MIN_MOMENTUM_PCT
    : input.momentum4h < -MIN_MOMENTUM_PCT && input.momentum1h < -MIN_MOMENTUM_PCT;
  if (!trendSupports) {
    return { hold: false, multiplier: 1, reason: 'trend against position' };
  }

  // 趨勢支持 + 過早率數據 → 強度分級（垃圾值 reject——唔可以 clamp 成有效證據）
  const rawRate = input.prematureRate;
  const rate = typeof rawRate === 'number' && Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 1 ? rawRate : undefined;
  const rawSamples = input.prematureSamples;
  const samples = typeof rawSamples === 'number' && Number.isFinite(rawSamples) && rawSamples >= 0 && rawSamples <= MAX_PREMATURE_SAMPLES
    ? Math.floor(rawSamples)
    : undefined;
  if (rate !== undefined && samples !== undefined && samples >= MIN_PREMATURE_SAMPLES) {
    if (rate >= 0.6) {
      return { hold: true, multiplier: 0.5, reason: `trend supports + premature ${(rate * 100).toFixed(0)}% (n=${samples})` };
    }
    if (rate >= 0.4) {
      return { hold: true, multiplier: 0.7, reason: `trend supports + premature ${(rate * 100).toFixed(0)}% (n=${samples})` };
    }
  }

  // 趨勢支持但冇過早率數據（冷啟動）→ 輕 hold
  return { hold: true, multiplier: 0.85, reason: 'trend supports position (4h+1h aligned)' };
}
