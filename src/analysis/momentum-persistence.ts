// ─── Momentum Persistence — v2.0.870-sell-architecture（主神 2026-08-25）─
//
// 邏輯實驗 E1（真實 200 支 1h candles, 7 symbol）證明:
//   BTC/BNB/GOLD（加密+貴金屬）=「反彈型」——mom24h<0 後 4h 反彈（WR跌 11-40%）
//   SNDK/SKHX/DRAM（股票類）  =「續跌型」——mom24h<0 後 4h 續跌（WR跌 52-71%）
// → sell 只喺「續跌型」有 edge（4h 短線）;「反彈型」開 sell = 送錢。
//
// 三次「不 SELL」fix 失效架構根因（sell-decay → sell-seed → sell-seed-accel）:
//   ① sell-seed 喺反彈型（BTC/BNB/GOLD）開 sell → 全輸（bnb|sell n=38 WR 0.7%）
//     → 毒化 OLR sell 統計 → 連「應該 sell」嘅 SNDK/SKHX/DRAM 都冇 sell 訊號
//   ② F1 hard block 閾值 8% 太高——SNDK mom -1~-4% 唔到 8% → 只 ×0.85 軟懲罰
//     → LLM 照開 BUY（全蝕）
//   ③ sell 冇「短持倉」概念——SKHX sell 4h edge 71% 但 24h 反彈 +1.26%
//
// 架構（per-symbol 動態延續性分類——數據驅動, 唔 hardcode symbol）:
//   computePersistenceScore(): 量度「mom24<0 後續 4h 續跌比例」——rolling
//   classifyPersistence(): persistent_bear（≥0.55）/ range（≤0.45）/ neutral
//   momentumDirectionalBiasPersistence(): F1 加 persistence-aware 閾值——
//     persistent_bear + BUY + mom<0 → HARD BLOCK（唔等 8%——SNDK 案例直接封）
// 純函數零依賴——可測。cold-start（樣本<5 / 數據不足）→ neutral（唔誤傷）。

export interface PersistenceResult {
  /** mom24<0 之後 4h 續跌嘅比例（0-1）——>0.5 表示跌勢延續（sell 有 edge） */
  score: number;
  /** 有效樣本數（mom24<0 嘅時刻）——<5 當冷啟動 */
  n: number;
}

export type Persistence = 'persistent_bear' | 'range' | 'neutral';

/** 量度「mom24<0 → 後續 4h 係咪續跌」。純函數。
 *  closes: 1h 閉市價（升序）。垃圾元素 skip。唔足 lookback+forward+1 → null。
 *  attack-hardening: NaN/Infinity/非正/字串全部 skip。 */
export function computePersistenceScore(
  closes: Array<number | { c: number } | null | undefined> | null | undefined,
  lookback = 24,
  forward = 4,
): PersistenceResult | null {
  if (!Array.isArray(closes)) return null;
  const cs: number[] = [];
  for (const c of closes) {
    const v = typeof c === 'number' ? c : (c && typeof c === 'object' ? (c as { c: number }).c : NaN);
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) cs.push(v);
  }
  if (cs.length < lookback + forward + 1) return null;
  const lb = Number.isFinite(lookback) && lookback > 0 ? Math.floor(lookback) : 24;
  const fw = Number.isFinite(forward) && forward > 0 ? Math.floor(forward) : 4;
  let down = 0;
  let n = 0;
  for (let i = lb; i < cs.length - fw; i++) {
    const mom = ((cs[i]! - cs[i - lb]!) / cs[i - lb]!) * 100;
    if (mom >= 0) continue; // 只有「跌市時刻」先算 sell 環境
    const fwd = ((cs[i + fw]! - cs[i]!) / cs[i]!) * 100;
    if (fwd < 0) down++;
    n++;
  }
  if (n < 5) return null; // 冷啟動——樣本太少唔可以有結論
  return { score: down / n, n };
}

/** 分類 persistence。垃圾/冷啟動 → neutral（唔誤傷）。 */
export function classifyPersistence(
  score: number | null | undefined,
  n: number | null | undefined,
  bearThreshold = 0.55,
  rangeThreshold = 0.45,
): Persistence {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'neutral';
  if (score < 0 || score > 1) return 'neutral'; // 負分/超分 = 垃圾（score 係比例 ∈[0,1]）
  const nn = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (nn < 5) return 'neutral';
  const bt = Number.isFinite(bearThreshold) ? bearThreshold : 0.55;
  const rt = Number.isFinite(rangeThreshold) ? rangeThreshold : 0.45;
  if (score >= bt) return 'persistent_bear';
  if (score <= rt) return 'range';
  return 'neutral';
}

/** F1 persistence-aware 動量方向偏置——原 F1 超 8% hard block 對 SNDK（mom
 *  -1~-4%）唔夠（只 ×0.85 軟懲罰 → LLM 照開 BUY 全蝕）。E1 實證:
 *  persistent_bear + 逆勢（BUY 喺 mom<0）→ HARD BLOCK（唔使等 8%）。
 *  range/recover 沿用原 F1 邏輯（8% hard block 保留——防極端）。 */
export function momentumDirectionalBiasPersistence(
  side: 'buy' | 'sell',
  momPct: number | null,
  persistence: Persistence,
): number {
  if (side !== 'buy' && side !== 'sell') return 1.0;
  if (momPct === null || !Number.isFinite(momPct) || Math.abs(momPct) > 100) return 1.0;
  // v2.0.870-sell-architecture-fix2（主神 2026-08-25 DRAM 死猫弹案例）: persistent_bear
  // 型 BUY 需要 mom24h 明顯轉正先允许——DRAM mom24h=0.00%（打和）+ 4h 急弹 +3.7%
  // （死猫弹）開咗 BUY——F1 只 block mom<0 擋唔住「打和/微正」嘅追高。E1:
  // 续跌型 symbol 跌市反彈後多數續跌——mom24h < 1.5% 一律 block（唔等負）。
  // 放噪音 return 之前——mom=0 打和都要 block。
  if (side === 'buy' && persistence === 'persistent_bear') {
    if (momPct < 1.5) return 0;
  }
  const mag = Math.abs(momPct);
  if (mag < 1.5) return 1.0; // 噪音——唔影響
  const bullish = momPct > 0;
  const aligned = (side === 'buy' && bullish) || (side === 'sell' && !bullish);
  if (!aligned && persistence === 'persistent_bear' && mag >= 1.5) return 0; // 核心: 跌市唔買
  if (aligned) {
    // v2.0.870-sell-architecture-attack A1: range（反彈型）+ SELL + mom<0 係
    // 「假順勢」——E1 實證反彈型 sell 全輸（bnb n=38 WR 0.7%）——mom<0 後 4h
    // 反彈。唔可以當順勢 boost（幫倒忙）——用逆勢懲罰（反彈型 sell 無 edge）。
    if (side === 'sell' && persistence === 'range') {
      if (mag >= 8.0) return 0;
      if (mag >= 6.0) return 0.45;
      if (mag >= 4.0) return 0.70;
      return 0.85;
    }
    return mag >= 4.0 ? 1.15 : 1.05;
  }
  // 非 persistent_bear 嘅逆勢——原 F1 逐級
  if (mag >= 8.0) return 0;
  if (mag >= 6.0) return 0.45;
  if (mag >= 4.0) return 0.70;
  return 0.85;
}

/** sell shadow seed 資格——persistent_bear 先 seed（E1 實證: 反彈型 sell 全輸
 *  → bnb n=38 WR 0.7%; 續跌型 sell 4h WR 52-71%）。range/neutral 唔 seed。 */
export function shouldSeedSell(persistence: Persistence): boolean {
  return persistence === 'persistent_bear';
}
