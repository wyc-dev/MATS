/**
 * v2.0.872-P8: 5m 動量方向硬閘（主神指令 2026-08-27）
 *
 * 「最近 5 分鐘跌 → 絕對唔開 BUY；最近 5 分鐘升 → 絕對唔開 SELL」
 *
 * v2.0.872-P8b（主神質疑「唔可以動態計算每個獨立 asset 嘅 falling？」）:
 * 固定 bps 門檻對唔同波動率嘅 asset 唔公平——BTC 嘅 30bps 係噪音、
 * xyz:SP500 嘅 30bps 係崩盤。改為**波動率自適應門檻**:
 *
 *   threshold = min( capBps, max( floorBps, kSigma × σ_candle × √(n-1) ) )
 *
 *   - σ_candle = 該 asset 最近 N 支 5m 燉 return 嘅 standard deviation（每個
 *     asset 動態計算，唔係硬編碼）
 *   - ×√(n-1) = diffusion scaling——隨機遊走下窗口 return 嘅自然波動幅
 *     （統計意義:|slope| 超 kSigma 個 diffusion σ 先算「真跌/真升」，
 *     唔係噪音——經典 drift significance 檢定）
 *   - floorBps: 死成交 tape（σ→0）嘅最低門檻，防一格 tick 觸發
 *   - capBps: 高波動 asset 嘅上限——超過 cap 嘅跌幅係毫無歧義嘅跌，
 *     t-stat 唔可以因為「平時更癲」就放行 9% 跌勢
 *
 * 判決:BUY blocked if slope ≤ -threshold；SELL blocked if slope ≥ +threshold。
 * 鏡像對稱；數據不足/垃圾 → 唔 block（caller LOUD log）。
 * 純函數 + 攻擊加固:NaN/Infinity/≤0 close 靜默剔除，Infinity slope → null。
 *
 * @module momentum-5m-gate
 */

/** 預設:30 分鐘窗口（6 × 5m 燉） */
export const DEFAULT_GATE_5M_CANDLES = 6;
/** diffusion 倍數——|slope| 超 2 個 σ_window 先算真方向（~95% 顯著） */
export const DEFAULT_GATE_5M_KSIGMA = 2.0;
/** 死成交 tape 最低門檻（bps） */
export const DEFAULT_GATE_5M_FLOOR_BPS = 10;
/** 高波動 asset 嘅門檻上限（bps）——超過呢個嘅跌幅係毫無歧義嘅跌 */
export const DEFAULT_GATE_5M_CAP_BPS = 500;

export interface FiveMinGateInput {
  side: 'buy' | 'sell';
  /** 最近 N 支 5m 燉 close（時間升序，最後一支最新） */
  closes: number[];
  /** diffusion 倍數（預設 2.0） */
  kSigma?: number;
  /** 最低門檻（bps，預設 10） */
  floorBps?: number;
  /** 門檻上限（bps，預設 500） */
  capBps?: number;
  /** 最少有效燭數（預設 6） */
  minCandles?: number;
}

export interface FiveMinGateResult {
  blocked: boolean;
  reason?: string;
  /** 窗口斜率（bps）——null = 數據不足/無效 */
  slopeBps: number | null;
  /** 動態門檻（bps）——null = 數據不足 */
  thresholdBps: number | null;
}

/** 窗口斜率（bps）:first→last total return × 10000。
 *  非有限/非正數靜默剔除；有效 < minCandles 或斜率非有限（1e308 垃圾）→ null。
 *  v2.0.872-P8-attack: minCandles sanity fallback——範圍外（負數/0/>50）→ 用預設 6。
 *  clamp 語義唔安全:clamp 到 2 = 噪音判決、clamp 到 200 = 樣本永遠不足 = 閘失效
 *  （攻擊實錄 V1）。只有 [2,50] 內嘅值先係「意圖內配置」。 */
const MIN_CANDLES_HARD_FLOOR = 2;
const MIN_CANDLES_HARD_CAP = 50;
export function compute5mSlopeBps(closes: number[], minCandles = DEFAULT_GATE_5M_CANDLES): number | null {
  if (!Array.isArray(closes)) return null;
  const mc = Number.isFinite(minCandles) && minCandles >= MIN_CANDLES_HARD_FLOOR && minCandles <= MIN_CANDLES_HARD_CAP
    ? Math.floor(minCandles)
    : DEFAULT_GATE_5M_CANDLES;
  const valid = closes.filter((c) => typeof c === 'number' && Number.isFinite(c) && c > 0);
  if (valid.length < mc) return null;
  const first = valid[0]!;
  const last = valid[valid.length - 1]!;
  if (!(first > 0)) return null;
  const slope = ((last - first) / first) * 10_000;
  if (!Number.isFinite(slope)) return null;
  return slope;
}

/** 每 candle return 嘅 **robust σ**（MAD × 1.4826，normal-consistent）。
 *  點解唔用 std:單支崩盤燭同時製造斜率同膨脹 std → 自己掩護自己
 *  （threshold 被拉高到放行真跌）。MAD 對離群值免疫——量化標準做法。
 *  回傳 robust σ（bps）；樣本 < 2 → null。 */
export function compute5mCandleVolBps(closes: number[]): number | null {
  if (!Array.isArray(closes)) return null;
  const valid = closes.filter((c) => typeof c === 'number' && Number.isFinite(c) && c > 0);
  if (valid.length < 2) return null;
  const rets: number[] = [];
  for (let i = 1; i < valid.length; i++) {
    rets.push(((valid[i]! - valid[i - 1]!) / valid[i - 1]!) * 10_000);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  const median = sorted[Math.floor(rets.length / 2)]!;
  const absDev = rets.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const mad = absDev[Math.floor(rets.length / 2)]!;
  const sigma = mad * 1.4826;
  if (!Number.isFinite(sigma)) return null;
  return sigma;
}

/** 動態門檻（bps）= min(cap, max(floor, kSigma × σ_candle × √(n-1)))。
 *  高波動 asset 自動收緊、低波動 asset 自動放寬到 floor 為止。 */
export function compute5mThresholdBps(
  closes: number[],
  kSigma = DEFAULT_GATE_5M_KSIGMA,
  floorBps = DEFAULT_GATE_5M_FLOOR_BPS,
  capBps = DEFAULT_GATE_5M_CAP_BPS,
): number | null {
  const sigma = compute5mCandleVolBps(closes);
  if (sigma === null) return null;
  const n = closes.filter((c) => typeof c === 'number' && Number.isFinite(c) && c > 0).length;
  if (n < 2) return null;
  const fl = Number.isFinite(floorBps) && floorBps >= 0 ? floorBps : DEFAULT_GATE_5M_FLOOR_BPS;
  const cp = Number.isFinite(capBps) && capBps >= fl ? capBps : DEFAULT_GATE_5M_CAP_BPS;
  const ks = Number.isFinite(kSigma) && kSigma > 0 ? kSigma : DEFAULT_GATE_5M_KSIGMA;
  // v2.0.872-P8-attack: floor 唔准低過 1bps——floor=0 + 死成交 tape（σ=0）
  // → threshold=0 → 一格微跌 tick 全擋 BUY = 交易 DoS（攻擊實錄 V2）
  const floorSafe = Math.max(1, fl);
  const t = Math.min(cp, Math.max(floorSafe, ks * sigma * Math.sqrt(Math.max(1, n - 1))));
  return Number.isFinite(t) ? t : null;
}

/** 主神 5m 方向硬閘（鏡像對稱 + 波動率自適應）:
 *  每個 asset 用自己最近嘅 5m 燉動態計算「幾大先算跌/升」。
 *  BUY + slope ≤ -threshold → block；SELL + slope ≥ +threshold → block。 */
export function shouldBlock5mDirection(input: FiveMinGateInput): FiveMinGateResult {
  const slope = compute5mSlopeBps(input.closes, input.minCandles ?? DEFAULT_GATE_5M_CANDLES);
  const threshold = compute5mThresholdBps(
    input.closes,
    input.kSigma,
    input.floorBps,
    input.capBps,
  );
  if (slope === null || threshold === null) {
    return { blocked: false, slopeBps: slope, thresholdBps: threshold, reason: '5m 數據不足' };
  }
  if (input.side === 'buy' && slope <= -threshold) {
    return { blocked: true, reason: `5m 跌勢 slope=${slope.toFixed(1)}bps ≤ -${threshold.toFixed(1)}bps（asset 動態門檻）— 5m 跌絕對唔開 BUY`, slopeBps: slope, thresholdBps: threshold };
  }
  if (input.side === 'sell' && slope >= threshold) {
    return { blocked: true, reason: `5m 升勢 slope=${slope.toFixed(1)}bps ≥ +${threshold.toFixed(1)}bps（asset 動態門檻）— 5m 升絕對唔開 SELL`, slopeBps: slope, thresholdBps: threshold };
  }
  return { blocked: false, slopeBps: slope, thresholdBps: threshold };
}