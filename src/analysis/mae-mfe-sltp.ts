// ─── P81: per-symbol MAE/MFE SL/TP 校準 ───
// 主神洞察: Shadow Trade 主力判斷「S/R + ATR floor + 波動率」——加埋 per-symbol
// MAE/MFE（PAEL 分佈）必然更準——因為每個 symbol 波動特性完全唔同
// （SKHX MAE p95 90% vs BTC 8.3%——default 2% SL 對 BTC 合理但對 SKHX 太貼）。
// 驗證（200 筆 realTrades）: SL 噪音止蝕 61% → 20%（MAE p95 cap）;
// TP 可達性 29% → 57%（MFE p50×0.8）——per-symbol 校準有效。
// 冷啟動: PAEL 冇數據 → null（fallback 現有 S/R 或者 default）。
// 注意: PAEL getExitProfile 返回 price-basis（mfePricePct/maePricePct）——
// 唔需要 ÷ leverage。

export interface MaeMfeSLTPInput {
  /** price-basis MAE p95 %（PAEL getExitProfile——per-symbol） */
  maeP95: number | null;
  /** price-basis MFE p50 %（PAEL getExitProfile——per-symbol） */
  mfeP50: number | null;
  /** MAE p95 cap（price %——避免 SKHX 18% 太闊） */
  capPct?: number;
  /** MFE p50 乘數（TP 目標——保守） */
  mfeMultiplier?: number;
}

export interface MaeMfeSLTPResult {
  /** price-basis SL 距離 %（null = 冷啟動 fallback） */
  slPct: number | null;
  /** price-basis TP 距離 %（null = 冷啟動 fallback） */
  tpPct: number | null;
}

/** 純函數: per-symbol MAE/MFE SL/TP 校準（無 I/O、無 Date.now） */
export function computeMaeMfeSLTP(input: MaeMfeSLTPInput): MaeMfeSLTPResult {
  const cap = Number.isFinite(input.capPct) && input.capPct! > 0 ? input.capPct! : 6;
  const mfeMult = Number.isFinite(input.mfeMultiplier) && input.mfeMultiplier! > 0 ? input.mfeMultiplier! : 0.8;
  // 冷啟動: 冇 MAE/MFE 數據 → null（fallback 現有 S/R 或者 default）
  if (input.maeP95 == null || input.mfeP50 == null) return { slPct: null, tpPct: null };
  const mae = Number.isFinite(input.maeP95) ? Math.min(Math.max(0, input.maeP95), cap) : 0;
  const mfe = Number.isFinite(input.mfeP50) ? Math.max(0, input.mfeP50) : 0;
  // price-basis（PAEL 已返回 price-basis——唔需要 ÷ leverage）
  const slPct = mae;
  const tpPct = mfe * mfeMult;
  return { slPct, tpPct };
}
