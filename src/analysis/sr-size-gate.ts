// ─── S/R 距離縮 size gate — v2.0.873-P9-sr-size ─────────────────────────
//
// 主神指令 2026-08-31: 「<0.3% S/R 距離 → size×0.5」——過三關驗證絕對成效先實作
//
// 背景（36-sr-truth.ts / 37-sr-final.ts 全樣本 309 單, 零 look-ahead）:
//   831 定義 srDist% = min(entry−lo, hi−entry)/entry×100——開倉前 25×15m(6.25h)
//   candle range 極值嘅「最近距離」（雙向——support+resistance 都計, 同存檔
//   distanceToSupportBps 單向 pivot 距離唔同——存檔字段名不副實唔好用）。
//   甜區真實: <0.3% avg −0.18% / 0.3-0.7% +1.80% / 1-2% −0.72%。
//
// 三關全過（37-sr-final.ts）: SELL-only × <0.35% × size×0.5
//   關1: Δ+19.6% 命中組 avg −1.31%(WR 37%)  關2: 兩半 +15.1/+4.5%, 剔 outlier 30/30, 中位 −0.59%
//   關3: 鄰近組合全正(+12.4~+29.2%), GOLD 33% 分散
//   ⚠️ BUY-only 全負（−5.9~−42.6%）——BUY 貼 S/R 係中性/正 EV, 唔可以縮（只做 SELL）。
//   ⚠️ threshold 0.40% 急轉負（−27.5%）——0.35 係峰位前, clamp 上限 0.35。
//
// 幻覺修正不變式: 純 size 層（縮風險唔改離場/SL/TP/方向）; 冷啟動（無 15m 數據）→ 唔縮;
//   垃圾值（Symbol/NaN/負/超大）→ 中性唔縮; threshold/sizeMult env clamp。

export interface SrSizeGateResult {
  shrink: boolean;
  mult: number;
  reason: string;
}

/**
 * 831 定義嘅 S/R 距離——「開倉價距離開倉前 25×15m candle range 極值嘅最近距離」（%）。
 * highs/lows: 開倉前已 close 15m candles 嘅 high/low（升序, 每支 {h, l} 或分開兩個陣列）。
 * 零 look-ahead: caller 傳入嘅必須係開倉前已 close candle（caller 剔 in-progress）。
 * 唔足 2 支 / 垃圾 → null（保守, 唔誤傷）。
 */
export function computeSrDistancePct(
  entry: number,
  candles: Array<{ h: number; l: number } | null | undefined> | null | undefined,
): number | null {
  if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) return null;
  if (!Array.isArray(candles) || candles.length < 2) return null;
  let hi = -Infinity;
  let lo = Infinity;
  let valid = 0;
  for (const c of candles) {
    if (!c || typeof c !== 'object') continue;
    const h = c.h;
    const l = c.l;
    if (typeof h !== 'number' || typeof l !== 'number' || !Number.isFinite(h) || !Number.isFinite(l)) continue;
    if (!(h > 0) || !(l > 0) || h < l) continue; // Symbol/NaN/負/倒轉 → skip
    if (h > hi) hi = h;
    if (l < lo) lo = l;
    valid++;
  }
  if (valid < 2 || !(hi > lo)) return null;
  const d = Math.min(entry - lo, hi - entry) / entry * 100;
  return Number.isFinite(d) ? d : null;
}

/**
 * S/R 距離縮 size 決策——純函數。
 *
 * 語義: side='sell' + srDistancePct < thresholdPct → shrink（size × sizeMult）。
 *   SELL-only（BUY 側驗證負——唔可以縮）; threshold 0.35 係峰位（0.40 急轉負）。
 *
 * ATTACK-HARDENING:
 *   - side 垃圾 → 唔縮（唔可以當 SELL 縮）
 *   - srDistancePct null/NaN/±Infinity/負/|值|>10 → 唔縮（冷啟動/污染——唔可以改寫 gate）
 *   - thresholdPct / sizeMult 垃圾或超出 band → 落回預設（threshold∈[0.1,0.35] / mult∈[0.1,0.9]）
 */
export function shouldShrinkSrSize(input: {
  side: 'buy' | 'sell';
  srDistancePct: number | null;
  thresholdPct?: number; // 預設 0.35
  sizeMult?: number;     // 預設 0.5
}): SrSizeGateResult {
  if (input.side !== 'sell') {
    return { shrink: false, mult: 1, reason: 'BUY 唔 apply（貼 S/R BUY 係/中性正 EV——驗證負, 唔縮）' };
  }
  const d = input.srDistancePct;
  if (d === null || !Number.isFinite(d) || d < 0 || Math.abs(d) > 10) {
    return { shrink: false, mult: 1, reason: 'S/R 距離數據缺失/無效——保守放行' };
  }
  const th = validateNum(input.thresholdPct, 0.35, 0.1, 0.35);
  const mult = validateNum(input.sizeMult, 0.5, 0.1, 0.9);
  if (d < th) {
    return { shrink: true, mult, reason: `SELL S/R 距離 ${(d * 100).toFixed(2)}% < ${(th * 100).toFixed(2)}%（貼 S/R 接刀, 歷史 avg −1.31%）→ size ×${mult}` };
  }
  return { shrink: false, mult: 1, reason: `S/R 距離 ${(d * 100).toFixed(2)}% ≥ ${(th * 100).toFixed(2)}%——放行` };
}

/** band validate——垃圾/超出 band → 預設（唔可以改寫 threshold/mult） */
function validateNum(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v >= min && v <= max ? v : fallback;
}
