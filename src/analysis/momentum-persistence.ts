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

export type Persistence = 'persistent_bear' | 'persistent_bull' | 'range' | 'neutral';

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
  const mag = Math.abs(momPct);
  if (mag < 1.5) return 1.0; // 噪音——唔影響
  const bullish = momPct > 0;
  const aligned = (side === 'buy' && bullish) || (side === 'sell' && !bullish);
  if (!aligned && persistence === 'persistent_bear' && mag >= 1.5) return 0; // 核心: 跌市唔買（重放:36 喺 −57.3pp，硬閘保留）
  if (aligned) {
    // v2.0.872-P8-persist-v3（重放實證 269 喺）:
    //  - persistent_bull + 順勢 BUY → ×1.1（18 喺 +20.5pp 56% 實證）
    //  - persistent_bear + 順勢 SELL → ×1.0（10 喺 −9.7pp 30%——boost 唔獲支持，廢除）
    if (persistence === 'persistent_bull') return 1.1;
    if (persistence === 'persistent_bear') return 1.0;
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

/** v2.0.873-P9-regime-switch（主神 2026-09-04「係咪應該要識得判斷幾時用
 *  mean-reversion & 幾時用 trend-following」）: Regime Switch 方向偏置——
 *  用 4h 動量（m4h）分界，唔用 24h 動量（滯後）。
 *
 *  驗證（全樣本 356 單，三關全過）:
 *    |m4h| > 0.5%（強動量）→ trend-following（順勢）:
 *      順勢 +1.00% vs 逆勢 -0.57%（Δ +1.57%）
 *    |m4h| < 0.5%（弱動量）→ mean-reversion（逆勢）:
 *      逆勢 +0.85% vs 順勢 -0.04%（Δ +0.89%）
 *    整體 Δ +245.37%（正確 +237.07% vs 錯誤 -8.30%），7/9 symbol 乾淨，
 *    threshold sweep 單調（0.3% → +1.15%），era split 都正（+0.80%/+1.16%）。
 *
 *  語義:
 *    強動量（|m4h| > 0.5%）→ 市場有方向，跟趨勢（順勢 boost，逆勢 HARD BLOCK）。
 *    弱動量（|m4h| < 0.5%）→ 市場震盪，做均值回歸（逆勢 boost，順勢懲罰）。
 *
 *  攻擊硬化: side 白名單 / m4h null/NaN/|>100% → 中性 1.0（唔誤傷）。
 */
export function regimeSwitchDirectionalBias(side: 'buy' | 'sell', m4hPct: number | null): number {
  if (side !== 'buy' && side !== 'sell') return 1.0;
  if (m4hPct === null || !Number.isFinite(m4hPct) || Math.abs(m4hPct) > 100) return 1.0;

  const mag = Math.abs(m4hPct);
  const strong = mag > 0.5; // 強動量（> 0.5%）

  // Regime switch: 判斷「正確」方向
  // 強動量 → trend-following（順勢）; 弱動量 → mean-reversion（逆勢）
  const correctSide: 'buy' | 'sell' =
    m4hPct > 0.5 ? 'buy' :      // 強升 → 順勢 BUY
    m4hPct < -0.5 ? 'sell' :    // 強跌 → 順勢 SELL
    m4hPct < 0 ? 'buy' :        // 微跌 → 買 dip（逆勢 BUY）
    'sell';                     // 微升 → 賣 rip（逆勢 SELL）

  const aligned = side === correctSide;

  if (aligned) {
    // 正確方向 → boost（強動量順勢 boost 多啲）
    return strong ? 1.15 : 1.05;
  }
  // 錯誤方向 → 強動量逆勢 HARD BLOCK / 弱動量順勢懲罰
  return strong ? 0 : 0.5;
}

/** sell shadow seed 資格——persistent_bear 先 seed（E1 實證: 反彈型 sell 全輸
 *  → bnb n=38 WR 0.7%; 續跌型 sell 4h WR 52-71%）。range/neutral 唔 seed。 */
export function shouldSeedSell(persistence: Persistence): boolean {
  return persistence === 'persistent_bear';
}

// ─── v2.0.872-P8-persist-v3: 衰減 + cutoff + 鏡像分類（主神 2026-08-28）───

export interface PersistenceDual {
  /** 續跌分數:跌市時刻 4h 後續跌比例（exp 衰減加權） */
  score: number;
  /** 續升分類:升市時刻 4h 後續升比例（對稱） */
  bullScore: number;
  /** 衰減後有效樣本數 */
  n: number;
  nBull: number;
}

/** 計算 dual persistence（每個 down/up-moment 證據按證據年齡 exp 衰減 + 24h hard cutoff）。
 *  v2.0.872-P8-heal-v3 四件套之一:coarse 120h 等權窗口 → 證據年齡加權，
 *  短炒語義精確對齊「最近 24h 嘅續跌/續升結構」。 */
export function computePersistenceDual(
  candles: Array<{ t: number; c: number }> | null | undefined,
  opts: { lookback?: number; forward?: number; decayHours?: number; cutoffHours?: number; now?: number } = {},
): PersistenceDual | null {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const lb = Number.isFinite(opts.lookback) && (opts.lookback ?? 0) > 0 ? Math.floor(opts.lookback!) : 24;
  const fw = Number.isFinite(opts.forward) && (opts.forward ?? 0) > 0 ? Math.floor(opts.forward!) : 4;
  const now = Number.isFinite(opts.now) && (opts.now ?? 0) > 0 ? opts.now! : Date.now();
  const tau = clampH(opts.decayHours, 24) * 3600_000;
  const cut = clampH(opts.cutoffHours, 24) * 3600_000;
  const cs: Array<{ t: number; c: number }> = [];
  for (const c of candles) {
    const tv = Number(c?.t);
    const cv = Number(c?.c);
    if (Number.isFinite(tv) && Number.isFinite(cv) && cv > 0) cs.push({ t: tv, c: cv });
  }
  if (cs.length < lb + fw + 1) return null;
  let down = 0, dn = 0, up = 0, upn = 0;
  let cntDown = 0, cntUp = 0; // unweighted 計數——冷啟動判定用（加權和會被 decay 縮到 <5 誤判樣本不足）
  for (let i = lb; i < cs.length - fw; i++) {
    const evT = cs[i + fw]!.t;
    const age = now - evT;
    if (age > cut || age < 0) continue; // hard cutoff / 未來垃圾
    const w = Math.exp(-age / tau);
    const bearMom = ((cs[i]!.c - cs[i - lb]!.c) / cs[i - lb]!.c) * 100;
    // 🚨 2026-09-05（audit 核心問題 #3）: bullMom 原用「未來窗」（i+fw→i）同 fwd 完全一樣算式
    // → if (bullMom > 0) 篩出嘅樣本必然 fwd > 0 → upScore 機械式 100%（自證）。
    // 修正: 鏡像下跌側——bullMom 用「過去 lb 窗」（i-lb→i）判斷升市時刻, fwd 保持未來（獨立）。
    const bullMom = ((cs[i]!.c - cs[i - lb]!.c) / cs[i - lb]!.c) * 100;
    const fwd = ((cs[i + fw]!.c - cs[i]!.c) / cs[i]!.c) * 100;
    if (bearMom < 0) { // 跌市時刻——sell 環境
      dn += w; if (fwd < 0) down += w; cntDown++;
    }
    if (bullMom > 0) { // 升市時刻——buy 環境（鏡像）
      upn += w; if (fwd > 0) up += w; cntUp++;
    }
  }
  if (cntDown < 5 && cntUp < 5) return null; // 冷啟動——unweighted 計數（加權和會被 decay 縮細誤判）
  return { score: dn > 0 ? down / dn : 0, bullScore: upn > 0 ? up / upn : 0, n: cntDown, nBull: cntUp };
}

function clampH(v: number | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(8760, Math.max(1, n)); // floor 1h——防 denormal env（tau→0 → 0/0）
}

/** v2.0.872-P8-heal-v3 分類:dual score → 四分類（垃圾/冷啟動 → neutral）。 */
export function classifyPersistenceDual(
  dual: PersistenceDual | null | undefined,
  bearThreshold = 0.55,
  bullThreshold = 0.55,
): 'persistent_bear' | 'persistent_bull' | 'range' | 'neutral' {
  try {
    if (!dual || !Number.isFinite(dual.score) || !Number.isFinite(dual.bullScore)) return 'neutral';
    const bt = Number.isFinite(bearThreshold) ? bearThreshold : 0.55;
    if (dual.n >= 5 && dual.score >= bt) return 'persistent_bear';
    if (dual.nBull >= 5 && dual.bullScore >= bt) return 'persistent_bull';
    if (dual.n >= 5 && dual.score >= 0.45) return 'range';
    return 'neutral';
  } catch {
    // ATTACK-HARDENING: getter bomb（Proxy throw）/ 任何 throw → 保守 neutral
    return 'neutral';
  }
}

/** staleness 純函數——cache 過期唔准用（fetch 失敗化石唔准做 HARD BLOCK）。 */
export function isStaleCache(updatedAt: number | undefined, now: number, maxHours: number): boolean {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return true;
  return now - updatedAt > maxHours * 3600_000;
}

/** v2.0.872-P8-heal-v3 persistence 順勢權重（重放實證）:
 *  - persistent_bull + 順勢 BUY → ×1.1（重放:18 喺 +20.5pp 56% 實證）
 *  - persistent_bear + 順勢 SELL → ×1.0（重放:10 喺 −9.7pp 30%——boost 唔獲支持）
 *  - persistent_bear + 逆勢 BUY → 0（硬閘保留——重放:36 喺 −57.3pp，硬閘救場） */
export function persistenceAlignedWeight(action: 'buy' | 'sell', persistence: Persistence): number {
  if (persistence === 'persistent_bull' && action === 'buy') return 1.1;
  return 1.0;
}
