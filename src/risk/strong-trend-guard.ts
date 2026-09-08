// risk/strong-trend-guard.ts — 強升勢方向防護(①observe ②block SELL)。
//
// 賽後檢討 09-08: 逆強升勢做空接刀(SILVER −11.7%)。驗證(327 筆 + OOS):
//   - 強升勢 SELL 金額級淨成效 +$1.04(防大蝕/誤傷微利)
//   - 強升勢 BUY OOS +1.81%(做多 edge 方向正確)——observe 收集
// pre-registered: 只強升勢側(主神裁決唔做強跌勢側)——
//   momentumLong ≥ +0.4% → SELL block(試行, env 可回滾); BUY 保持 observe。

function parseBoolEnv(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  return v.trim().toLowerCase() === 'true';
}

export const strongTrendConfig = {
  enabled: parseBoolEnv(process.env['STRONG_UP_BLOCK_SELL'], true),
  /** 強升勢閾值(1h 動量 fraction)——sim-feat3 已驗證桶,pre-registered 零 tune */
  strongUpPct: Number(process.env['STRONG_UP_PCT']) >= 0 ? Number(process.env['STRONG_UP_PCT']) / 100 : 0.004,
} as const;

/** 純函數: 強升勢時 SELL 應該 block? */
export function shouldBlockStrongUpSell(momentumLong: number | undefined | null, action: string | undefined | null): boolean {
  if (!strongTrendConfig.enabled) return false;
  if (action !== 'sell') return false;
  if (typeof momentumLong !== 'number' || !Number.isFinite(momentumLong)) return false; // 冇動量數據 → 唔 block(保守)
  return momentumLong >= strongTrendConfig.strongUpPct;
}

/** 純函數: 強升勢分類(observe/記錄用) */
export function momentumBiasOf(momentumLong: number | undefined | null): 'strong-up' | 'strong-down' | 'neutral' {
  if (typeof momentumLong !== 'number' || !Number.isFinite(momentumLong)) return 'neutral';
  if (momentumLong >= strongTrendConfig.strongUpPct) return 'strong-up';
  if (momentumLong <= -strongTrendConfig.strongUpPct) return 'strong-down';
  return 'neutral';
}
