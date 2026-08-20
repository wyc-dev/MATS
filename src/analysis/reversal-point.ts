// ─── P78 Reversal-Point Detection（方案 B：預測反轉點）───
// 核心哲學（主神裁決）: 反轉點判斷用「即時市場結構」（而家嘅價格位置、蠟燭形態、
// 多時間框架關係、S/R 距離），唔用歷史統計做 gate。歷史數據只做校準。
//
// 設計 v4（經 SKHX -14.7% 案例 + 20 筆 SKHX 交易反事實驗證）:
//   - SKHX 案例 score 0.75 HIGH（gate ×0.5）——「追高失敗」模式有效
//   - 誤傷贏單 0/6——唔會壓制好交易
//   - 邊界: 中間位反轉（無結構前兆）唔捕捉——誠實設計邊界
//
// 權重: 極值距離 0.35 / EntryTiming 0.25 / 大陽燭後回落 0.10 / 形態 0.10 /
//       動量減速 0.05 / S/R 0.05 / 15m 分歧 0.05（總和 0.95，clamp [0,1]）

export interface ReversalCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ReversalPointInput {
  /** 入場價（決策價） */
  entryPrice: number;
  /** 入場前 1h 蠟燭（≥20 支，唔含入場後——caller 負責 slice） */
  candles1h: ReversalCandle[] | null;
  /** 入場前 5m 蠟燭（≥12 支，唔含入場後） */
  candles5m: ReversalCandle[] | null;
  /** 買入側: 'buy' | 'sell' */
  side: 'buy' | 'sell';
  /** 買入側: 距最近 resistance bps（support-resistance 輸出） */
  distanceToResistanceBps?: number | null;
  /** 賣出側: 距最近 support bps */
  distanceToSupportBps?: number | null;
}

export type ReversalLevel = 'high' | 'medium' | 'low' | 'neutral';

export interface ReversalPointResult {
  /** 0-1 反轉風險分數 */
  score: number;
  level: ReversalLevel;
  /** 結構證據（注入 agent prompt） */
  evidence: string[];
  /** 有足夠數據（candles1h ≥ 20）先算 hasData=true */
  hasData: boolean;
}

// ── 權重（設計 v4，經反事實驗證）──
const W_EXTREME = 0.35;      // 極值距離（追高/追低失敗）
const W_TIMING = 0.25;       // EntryTiming（回落途中追入）
const W_BIG_CANDLE = 0.10;   // 大陽燭/大陰燭後回落
const W_SHAPE = 0.10;         // 蠟燭形態（長上影/長下影）
const W_DECAY = 0.05;        // 動量減速
const W_SR = 0.05;            // S/R 距離
const W_MTF = 0.05;           // 15m 分歧

/** 閾值: 極值距離 < 100bps = 高風險（由高位/低位回落緊） */
const EXTREME_HIGH_BPS = 100;
/** 閾值: 極值距離 < 200bps = 中風險（接近極值） */
const EXTREME_MED_BPS = 200;
/** 閾值: entry 低過/高過 1h close > 30bps = 回落途中 */
const TIMING_HIGH_BPS = 30;
/** 閾值: 1h 動量 > 2% = 大陽燭（buy）/ < -2% = 大陰燭（sell） */
const BIG_CANDLE_PCT = 2.0;
/** 閾值: 5m 後半動量 < 前半 × 0.5 = 減速 */
const DECAY_RATIO = 0.5;
/** 閾值: 影線 ≥ 2× 實體 = exhaustion 形態 */
const WICK_BODY_RATIO = 2.0;
/** 閾值: 距 resistance/support ≤ 100bps = 高風險 */
const SR_HIGH_BPS = 100;
/** 閾值: 距 resistance/support ≤ 300bps = 中風險 */
const SR_MED_BPS = 300;

function safeNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 純函數: 計算反轉風險分數（無 I/O、無 Date.now） */
export function computeReversalRiskScore(input: ReversalPointInput): ReversalPointResult {
  const evidence: string[] = [];
  const entry = safeNum(input.entryPrice, 0);
  // FIX-1（攻擊輪 A1/A2/A3）: candle 元素驗證——null/undefined/非 finite 元素剔除
  // （`c.h` 訪問 null 會 crash——入口 filter 根治）
  const c1h = Array.isArray(input.candles1h)
    ? input.candles1h.filter((c): c is ReversalCandle => !!c && Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))
    : null;
  const c5m = Array.isArray(input.candles5m)
    ? input.candles5m.filter((c): c is ReversalCandle => !!c && Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))
    : null;
  const side = input.side === 'sell' ? 'sell' : 'buy';

  // 冷啟動: 唔夠 20 支 1h candle → 中性（唔干擾 bootstrap）
  if (!c1h || c1h.length < 20 || entry <= 0) {
    return { score: 0, level: 'neutral', evidence: [], hasData: false };
  }

  const last1h = c1h[c1h.length - 1];
  const ath = Math.max(...c1h.slice(-20).map(c => safeNum(c.h, 0)));
  const atl = Math.min(...c1h.slice(-20).map(c => safeNum(c.l, 0)));
  let score = 0;

  // ① 極值距離 (0.35): buy 用 ATH（entry 低過 ATH = 由高位回落緊）; sell 用 ATL
  if (side === 'buy') {
    const pullbackBps = ath > 0 ? (ath - entry) / entry * 10000 : 0;
    if (pullbackBps < 0) { /* entry > ATH = 突破新高 = 強勢, 低風險 */ }
    else if (pullbackBps < EXTREME_HIGH_BPS) { score += W_EXTREME; evidence.push(`距 ATH ${pullbackBps.toFixed(0)}bps — 由高位回落緊(追高失敗)`); }
    else if (pullbackBps < EXTREME_MED_BPS) { score += 0.2; evidence.push(`距 ATH ${pullbackBps.toFixed(0)}bps — 接近高位回落`); }
    /* 遠離 ATH = 低位, 低風險 */
  } else {
    const pullbackBps = entry > 0 && atl > 0 ? (entry - atl) / entry * 10000 : 0;
    if (pullbackBps < 0) { /* entry < ATL = 突破新低 = 強勢, 低風險 */ }
    else if (pullbackBps < EXTREME_HIGH_BPS) { score += W_EXTREME; evidence.push(`距 ATL ${pullbackBps.toFixed(0)}bps — 由低位反彈緊(追低失敗)`); }
    else if (pullbackBps < EXTREME_MED_BPS) { score += 0.2; evidence.push(`距 ATL ${pullbackBps.toFixed(0)}bps — 接近低位反彈`); }
  }

  // ② EntryTiming (0.25): entry vs 最近 1h close——只有「接近極值」時先計（回落途中追入）
  if (last1h && last1h.c > 0) {
    const entryVsCloseBps = (entry - last1h.c) / last1h.c * 10000;
    const nearExtreme = side === 'buy'
      ? (ath - entry) / entry * 10000 < EXTREME_MED_BPS
      : (entry - atl) / entry * 10000 < EXTREME_MED_BPS;
    if (nearExtreme && entryVsCloseBps < -TIMING_HIGH_BPS) { score += W_TIMING; evidence.push(`entry 低過 1h close ${(-entryVsCloseBps).toFixed(0)}bps — 高位回落途中追入`); }
    else if (nearExtreme && entryVsCloseBps < 0) { score += 0.15; evidence.push(`entry 低過 1h close ${(-entryVsCloseBps).toFixed(0)}bps — 輕微回落`); }
  }

  // ③ 大陽燭/大陰燭後回落 (0.10): 1h 動量 > 2%（buy）/ < -2%（sell）+ entry 反向 + 接近極值
  if (last1h && c1h.length >= 2 && c1h[c1h.length - 2]!.c > 0) {
    const m1hPct = (last1h.c - c1h[c1h.length - 2]!.c) / c1h[c1h.length - 2]!.c * 100;
    const entryVsCloseBps = last1h.c > 0 ? (entry - last1h.c) / last1h.c * 10000 : 0;
    const nearExtreme = side === 'buy'
      ? (ath - entry) / entry * 10000 < EXTREME_MED_BPS
      : (entry - atl) / entry * 10000 < EXTREME_MED_BPS;
    if (side === 'buy' && m1hPct > BIG_CANDLE_PCT && entryVsCloseBps < -TIMING_HIGH_BPS && nearExtreme) {
      score += W_BIG_CANDLE; evidence.push(`1h 大陽燭 +${m1hPct.toFixed(1)}% 後回落 — 追高失敗`);
    }
    if (side === 'sell' && m1hPct < -BIG_CANDLE_PCT && entryVsCloseBps > TIMING_HIGH_BPS && nearExtreme) {
      score += W_BIG_CANDLE; evidence.push(`1h 大陰燭 ${m1hPct.toFixed(1)}% 後反彈 — 追低失敗`);
    }
  }

  // ④ 蠟燭形態 (0.10): 最近 1h 長上影（buy）/ 長下影（sell）= exhaustion
  if (last1h) {
    const body = Math.abs(last1h.c - last1h.o);
    const upperWick = last1h.h - Math.max(last1h.c, last1h.o);
    const lowerWick = Math.min(last1h.c, last1h.o) - last1h.l;
    if (side === 'buy' && upperWick >= WICK_BODY_RATIO * body && body > 0) { score += W_SHAPE; evidence.push('1h 長上影 — exhaustion 形態'); }
    if (side === 'sell' && lowerWick >= WICK_BODY_RATIO * body && body > 0) { score += W_SHAPE; evidence.push('1h 長下影 — exhaustion 形態'); }
  }

  // ⑤ 動量減速 (0.05): 5m 後半 < 前半 × 0.5
  if (c5m && c5m.length >= 12 && c5m[0]!.c > 0 && c5m[6]!.c > 0) {
    const firstHalf = (c5m[5]!.c - c5m[0]!.c) / c5m[0]!.c * 100;
    const secondHalf = (c5m[11]!.c - c5m[6]!.c) / c5m[6]!.c * 100;
    if (secondHalf < firstHalf * DECAY_RATIO) { score += W_DECAY; evidence.push('動量減速 — 反轉前兆'); }
  }

  // ⑥ S/R 距離 (0.05): buy 距 resistance / sell 距 support
  const srBps = side === 'buy' ? input.distanceToResistanceBps : input.distanceToSupportBps;
  if (typeof srBps === 'number' && Number.isFinite(srBps) && srBps >= 0) {
    if (srBps <= SR_HIGH_BPS) { score += W_SR; evidence.push(`距 ${side === 'buy' ? 'resistance' : 'support'} ${srBps.toFixed(0)}bps — 買/賣喺邊界`); }
    else if (srBps <= SR_MED_BPS) { score += 0.03; evidence.push(`距 ${side === 'buy' ? 'resistance' : 'support'} ${srBps.toFixed(0)}bps — 接近邊界`); }
  }

  // ⑦ 15m 分歧 (0.05): buy 1h>0 且 15m<0（時機分歧）
  if (c5m && c5m.length >= 4 && last1h && c1h.length >= 2 && c1h[c1h.length - 2]!.c > 0 && c5m[c5m.length - 4]!.c > 0) {
    const m15m = (c5m[c5m.length - 1]!.c - c5m[c5m.length - 4]!.c) / c5m[c5m.length - 4]!.c * 100;
    const m1h = (last1h.c - c1h[c1h.length - 2]!.c) / c1h[c1h.length - 2]!.c * 100;
    if (side === 'buy' && m1h > 0 && m15m < 0) { score += W_MTF; evidence.push('15m 反對 1h — 時機分歧'); }
    if (side === 'sell' && m1h < 0 && m15m > 0) { score += W_MTF; evidence.push('15m 反對 1h — 時機分歧'); }
  }

  score = Math.min(1, Math.max(0, score));
  const level: ReversalLevel = score >= 0.7 ? 'high' : score >= 0.5 ? 'medium' : score >= 0.3 ? 'low' : 'neutral';
  return { score, level, evidence, hasData: true };
}

// ── P78-E1: MAE/MFE 反轉離場（持倉中結構判斷）──
// 主神洞察: MAE/MFE 係「呢筆交易實際行咗幾遠」——per-symbol 即時結果，
// 比 ATH/ATL 通用閾值更準（驗證: 200 筆 realTrades 避免 228.1% / 誤傷 0%）。
// 主神裁決: 收窄版（s1 0.9/s2 2.0/連續確認）冇好處——避免少 17% 誤傷一樣 0 → 回滾原版。
// 訊號（結構邏輯，唔係歷史統計）:
//   SL ① 入場即水下: |unrealizedPnlPct| ≥ 0.8 × maePct（價格冇返嚟——逆向持續）
//   SL ② 逆向主導:   maePct > 1.5 × mfePct（逆向 >> 順向）
//   SL ③ 冇動能:      mfePct < 0.1%
//   SL 離場: holdMin ≥ 15（全局必要）AND ① AND（② OR ③）——唔誤傷「先蝕後贏」
//   TP 鎖利: holdMin ≥ 15 AND mfePct ≥ 0.5% AND 贏緊 AND 已回吐 ≥ 30%（驗證 +25.4% / 錯過 0%）

export interface MaeMfeReversalInput {
  /** margin-basis 未實現 PnL %（負數 = 水下） */
  unrealizedPnlPct: number;
  /** margin-basis 逆向 excursion %（MAE） */
  maePct: number;
  /** margin-basis 順向 excursion %（MFE） */
  mfePct: number;
  /** 持倉分鐘數 */
  holdMin: number;
  /** E2: per-symbol MAE 中位數（entry-quality 提供，margin %）——s1 閾值用 per-symbol
   *   （正常波動唔止血——BTC MAE 4% 係 p50 附近，唔應該止血）。冷啟動（冇數據）→ fallback 固定 0.8×maePct。 */
  perSymbolMaeP50?: number;
  /** E1: 趨勢支持方向（BUY + trending_bull/bullish、SELL + trending_bear/bearish）——
   *   閾值 ×1.5（暫時回調唔止血——方向啱嘅 trade 喺反彈前都會有 MAE）。
   *   唔加「趨勢逆轉 → 止血」——trend 係 lagging indicator（BTC 案例：trending_bear 出現嗰陣已經係底部）。 */
  trendAligned?: boolean;
  /** E2: per-symbol MFE 中位數（entry-quality 提供，margin %）——鎖利閾值校準。
   *   高波動 symbol（CL mfeP50=1.51%）鎖利目標遠啲（唔會太早鎖利——俾 profit 跑）。
   *   冷啟動（冇數據）→ fallback 固定 0.5%。 */
  perSymbolMfeP50?: number;
}

export interface MaeMfeReversalResult {
  exit: boolean;
  signals: { s1: boolean; s2: boolean; s3: boolean };
}

/** 純函數: MAE/MFE 反轉離場判斷（SL 止血——原版，無 I/O、無 Date.now） */
export function shouldExitOnMaeMfeReversal(input: MaeMfeReversalInput): MaeMfeReversalResult {
  // FIX-1（攻擊輪 2 A1/A2）: 輸入 sanitize——maePct/mfePct clamp [0, MAX_EXCURSION]，
  // unrealizedPnlPct finite 檢查。負數 mfePct 會令 s2 誤觸發（maePct > 1.5×負數 = 一定 true），
  // -Infinity pnl 會令 s1 誤觸發（Math.abs(-Infinity)=Infinity >= 0.8×mae）。
  const MAX_EXCURSION = 10; // 1000% margin excursion 上限（5x leverage 下價格逆向 200% 先到）
  const pnl = Number.isFinite(input.unrealizedPnlPct) ? input.unrealizedPnlPct : 0;
  const mae = Number.isFinite(input.maePct) ? Math.min(Math.max(0, input.maePct), MAX_EXCURSION) : 0;
  // mfeValid: 負數/NaN mfePct = 無效（唔係「冇順向」）——clamp 到 0 會令 s2 誤觸發（mae > 1.5×0 = true）
  const mfeValid = Number.isFinite(input.mfePct) && input.mfePct >= 0;
  const mfe = mfeValid ? Math.min(input.mfePct, MAX_EXCURSION) : 0;
  const hold = Number.isFinite(input.holdMin) ? input.holdMin : 0;
  // E2: per-symbol MAE 閾值（p50×2 cap 20%）——有數據用 per-symbol（正常波動唔止血），
  // 冷啟動（冇數據）→ fallback 固定 0.8×maePct。
  // 量化金融: per-symbol 波動特性唔同（BTC MAE p50=4% vs SKHX p50=1.9%）——
  // 固定閾值對高波動 symbol 太貼（正常波動都止血）、對低波動 symbol 太闊。
  // B1: perSymbolMaeP50 下限 0.5%——太細嘅閾值（1e-9）令 s1 永遠觸發（誤傷）——
  // 正常波動（<0.5% margin）唔應該止血。
  const MIN_PER_SYMBOL_MAE = 0.5;
  const perSymThreshold = Number.isFinite(input.perSymbolMaeP50) && (input.perSymbolMaeP50 ?? 0) >= MIN_PER_SYMBOL_MAE
    ? Math.min((input.perSymbolMaeP50 ?? 0) * 2, 20)
    : 0.8 * mae;
  // E1: 趨勢支持方向 → 閾值 ×1.5（暫時回調唔止血——方向啱嘅 trade 喺反彈前都會有 MAE）
  const threshold = input.trendAligned === true ? perSymThreshold * 1.5 : perSymThreshold;
  // 原版（主神裁決回滾收窄版）: s1 0.8×mae, s2 1.5×mfe——避免 228.1% / 誤傷 0%
  // E1+E2: s1 用 per-symbol 閾值（正常波動唔止血）——真反轉（超閾值）仍然止血
  const s1 = mae > 0 && pnl < 0 && Math.abs(pnl) >= threshold;
  const s2 = mfeValid && mae > 1.5 * mfe;
  const s3 = mfeValid && mfe < 0.1;
  // holdMin ≥ 15 係全局必要條件（避免一開倉就離場——H5 攻擊發現 s2 單獨觸發）
  return { exit: hold >= 15 && s1 && (s2 || s3), signals: { s1, s2, s3 } };
}

/** 純函數: MAE/MFE 提早鎖利判斷（TP 鎖利——主神要求「提早 TP 盈利」，無 I/O、無 Date.now） */
export function shouldLockProfitOnMaeMfe(input: MaeMfeReversalInput): boolean {
  // FIX-2（攻擊輪 2 B1）: 輸入 sanitize——Infinity mfePct 會令鎖利誤觸發（pnl <= 0.7×Infinity = true）
  const MAX_EXCURSION = 10;
  const pnl = Number.isFinite(input.unrealizedPnlPct) ? input.unrealizedPnlPct : 0;
  // mfeValid: 負數/NaN mfePct = 無效（唔鎖利）
  const mfeValid = Number.isFinite(input.mfePct) && input.mfePct >= 0;
  const mfe = mfeValid ? Math.min(input.mfePct, MAX_EXCURSION) : 0;
  const hold = Number.isFinite(input.holdMin) ? input.holdMin : 0;
  // E2: per-symbol MFE 鎖利閾值——高波動 symbol 鎖利目標遠啲（唔會太早鎖利——俾 profit 跑）。
  // 冷啟動（冇數據）→ fallback 固定 0.5%。
  const lockThreshold = Number.isFinite(input.perSymbolMfeP50) && (input.perSymbolMfeP50 ?? 0) > 0
    ? Math.max(0.5, (input.perSymbolMfeP50 ?? 0) * 0.8)
    : 0.5;
  // MFE 已達實質水平（per-symbol 閾值）+ 仲贏緊 + 已回吐 ≥ 30%（「賺咗又返轉頭」）
  return hold >= 15 && mfeValid && mfe >= lockThreshold && pnl > 0 && pnl <= 0.7 * mfe;
}

// ── P79: 即時動量順向入場（防止「TP 後 re-entry 倒蝕」同「追高入場」）──
// 主神洞察: 「TP 咗 → 返轉頭入返 → 倒蝕」係典型蝕錢模式（BTC 案例: 21:13 TP +18.4%
// → 21:53 追高入場 → 22:12 E1 平倉 -5.2%）。reopen-guard ±0.3% 太窄攔唔到。
// 驗證（50 筆 realTrades 反事實）: 兩窗都逆動量 WR 10% / avgPnl -2.50% vs
// 兩窗都順動量 WR 44% / avgPnl +2.58%——逆動量明顯差（差 34pp / 5.08pp）。
// 即時動量係「而家」嘅數據——唔係歷史統計（符合主神哲學）。soft gate 唔 hard block。

export interface MomentumAlignmentInput {
  /** 入場方向 */
  side: 'buy' | 'sell';
  /** 5m 動量 %（入場前最近 1 支 vs 前 1 支） */
  m5m: number | null;
  /** 15m 動量 %（入場前最近 3 支 vs 前 3 支） */
  m15m: number | null;
}

export type MomentumAlignment = 'aligned' | 'pullback' | 'dead_cat' | 'against' | 'unknown';

export interface MomentumAlignmentResult {
  alignment: MomentumAlignment;
  /** soft gate 乘數: aligned ×1.1（強勢獎勵）/ pullback ×1.0（順勢回調——WR 54% 最高）/ dead_cat ×0.5（死貓彈——WR 0%）/ against ×0.5 / unknown ×1.0 */
  multiplier: number;
}

/** 純函數: 即時動量順向判斷（無 I/O、無 Date.now） */
export function checkMomentumAlignment(input: MomentumAlignmentInput): MomentumAlignmentResult {
  const side = input.side === 'sell' ? 'sell' : 'buy';
  const m5 = Number.isFinite(input.m5m) ? input.m5m : null;
  const m15 = Number.isFinite(input.m15m) ? input.m15m : null;
  // 冷啟動: 冇動量數據 → 中性（唔干擾 bootstrap）
  if (m5 === null && m15 === null) return { alignment: 'unknown', multiplier: 1.0 };
  // 方向期望: buy 需要動量正, sell 需要動量負
  const expect = side === 'buy' ? 1 : -1;
  const m5Aligned = m5 !== null && m5 * expect > 0;
  const m15Aligned = m15 !== null && m15 * expect > 0;
  const m5Against = m5 !== null && m5 * expect < 0;
  const m15Against = m15 !== null && m15 * expect < 0;
  // 主神洞察（驗證 50 筆）: 15m 係主方向、5m 係短期時機——「混合」要拆開:
  //   兩窗都順（15m順+5m順）→ ×1.1（avgPnl +2.58% 最高——強勢獎勵）
  //   順勢回調（15m順+5m逆）→ ×1.0（WR 54% 最高——回調買入係好嘢）
  //   死貓彈（5m順+15m逆）→ ×0.5（WR 0%——逆勢反彈危險）
  //   兩窗都逆 → ×0.5（追高/接刀）
  if (m5Aligned && m15Aligned) return { alignment: 'aligned', multiplier: 1.1 };
  if (m15Aligned && m5Against) return { alignment: 'pullback', multiplier: 1.0 };
  if (m5Aligned && m15Against) return { alignment: 'dead_cat', multiplier: 0.5 };
  return { alignment: 'against', multiplier: 0.5 };
}

// ── P79-v2: 四窗驗證（4h+1h+15m+5m）——死貓彈/兩窗都逆/大方向錯 hard block ──
// 主神指令: 將 15m+5m 整合 4h+1h——變成四窗驗證機制;死貓彈（5m順+15m逆）&
// 兩窗都逆 直接 hard block;方向必須分清楚（buy/sell 鏡像）。
// 驗證（40 筆反事實）: 死貓彈 WR 0% / 兩窗都逆 WR 13% avgPnl -1.80% /
// 4h+1h都逆 WR 25% avgPnl -2.07%——全部差 → hard block;
// 順勢回調 WR 100% avgPnl +7.16%——好 → 唔 block。

export interface FourWindowInput {
  /** 入場方向 */
  side: 'buy' | 'sell';
  /** 4h 動量 % */
  m4h: number | null;
  /** 1h 動量 % */
  m1h: number | null;
  /** 15m 動量 % */
  m15m: number | null;
  /** 5m 動量 % */
  m5m: number | null;
}

export type FourWindowAction = 'block' | 'aligned' | 'pullback' | 'neutral' | 'unknown';

export interface FourWindowResult {
  action: FourWindowAction;
  /** soft 乘數: aligned ×1.1 / pullback ×1.0 / unknown ×1.0;block → 0（hard block） */
  multiplier: number;
  reason: string;
}

/** 純函數: 四窗驗證（無 I/O、無 Date.now）——方向分清楚（buy/sell 鏡像） */
export function checkFourWindowAlignment(input: FourWindowInput): FourWindowResult {
  const side = input.side === 'sell' ? 'sell' : 'buy';
  const expect = side === 'buy' ? 1 : -1;
  const fin = (x: number | null): number | null => (x !== null && Number.isFinite(x) ? x : null);
  const m4 = fin(input.m4h), m1 = fin(input.m1h), m15 = fin(input.m15m), m5 = fin(input.m5m);

  // 冷啟動: 冇 15m/5m 時機數據 → unknown（唔 block——唔干擾 bootstrap）
  if (m15 === null && m5 === null) return { action: 'unknown', multiplier: 1.0, reason: 'no timing data' };

  const m15Aligned = m15 !== null && m15 * expect > 0;
  const m5Aligned = m5 !== null && m5 * expect > 0;
  const m15Against = m15 !== null && m15 * expect < 0;
  const m5Against = m5 !== null && m5 * expect < 0;

  // HARD BLOCK ①: 死貓彈（5m順 + 15m逆）——15m 逆 = 主方向錯（驗證 WR 0%）
  if (m5Aligned && m15Against) return { action: 'block', multiplier: 0, reason: 'dead_cat (5m aligned, 15m against)' };
  // HARD BLOCK ②: 兩窗都逆（5m逆 + 15m逆）——追高/接刀（驗證 WR 13%）
  if (m5Against && m15Against) return { action: 'block', multiplier: 0, reason: 'both_against (5m+15m against)' };

  // 主神設計: 4h+1h 係「方向 gate」——大方向順先入（由 classifyMomentumTrend 處理）。
  // 4h+1h 都逆 → 唔 boost（×1.0 中性——大方向逆唔獎勵——方向 gate 會攔）
  const trendOk = m4 !== null && m1 !== null && m4 * expect > 0 && m1 * expect > 0;
  if (!trendOk) return { action: 'neutral', multiplier: 1.0, reason: 'trend not confirmed (4h+1h)' };

  // 兩窗都順 → aligned ×1.1（強勢獎勵）
  if (m5Aligned && m15Aligned) return { action: 'aligned', multiplier: 1.1, reason: 'aligned (5m+15m)' };
  // 順勢回調（15m順 + 5m逆）→ pullback ×1.0（驗證 WR 100%——回調買入係好嘢）
  if (m15Aligned && m5Against) return { action: 'pullback', multiplier: 1.0, reason: 'pullback (15m aligned, 5m against)' };

  return { action: 'unknown', multiplier: 1.0, reason: 'insufficient' };
}

/** Gate 乘數（soft——唔 hard block）: high ×0.5 / medium ×0.75 / low ×0.9 / neutral ×1.0 */
export function reversalRiskMultiplier(level: ReversalLevel): number {
  switch (level) {
    case 'high': return 0.5;
    case 'medium': return 0.75;
    case 'low': return 0.9;
    case 'neutral': return 1.0;
    // FIX-2（攻擊輪 B1/B2）: 垃圾 level → 中性 1.0（唔返回 undefined → effectiveConfidence *= undefined = NaN）
    default: return 1.0;
  }
}

/** 格式化證據（注入 agent prompt） */
export function formatReversalEvidence(result: ReversalPointResult, symbol: string): string {
  // FIX-3（攻擊輪 C1/C2）: 垃圾 result 防禦——score 非 finite → 中性;evidence 非 string → skip
  if (!result || typeof result !== 'object') return '';
  const score = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : 0;
  const evidence = Array.isArray(result.evidence) ? result.evidence.filter((e): e is string => typeof e === 'string') : [];
  if (!result.hasData || evidence.length === 0) return '';
  const lines = [`=== REVERSAL-POINT RISK (${symbol}) ===`, `Score: ${score.toFixed(2)} (${String(result.level).toUpperCase()})`];
  for (const e of evidence) lines.push(`- ${e}`);
  return lines.join('\n');
}
