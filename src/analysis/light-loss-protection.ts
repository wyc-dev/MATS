/**
 * v2.0.873-P9-llpp: Light-Loss Premature Protection（輕虧損過早保護）
 *
 * 背景（PLAN_lightloss-protection.md, 2026-08-30 兩輪邏輯實驗）:
 *  - consensus close 輕虧損倉（-3%~0% margin）有 32% 機會係過早離場
 *    （close 後 6×15m 內價格反彈 ≥0.5%）
 *  - SL-aware replay（真實 SL backfill 292/292）: maxDefer=6 cycles（30min）
 *    延遲 → Δ+48.36pp, SL 止蝕 5, 漏洞 0（scripts/exit-gate-experiment/）
 *
 * 架構（關鍵——純延遲模型, P9-defer 鏡像）:
 *  - LLPP 唔係「主動 cut 工具」——系統每 cycle 自行重新評估 consensus
 *  - LLPP 只係「延長窗口」: 輕虧損 consensus close → 延遲 maxDefer cycles,
 *    期間 SL hit 止蝕（永遠）/ 回升至 resume 救返 / 到期以最後價 close
 *  - 冇「續跌確認 cut」——實驗證明嗰個係過度設計（cut 咗本應反彈嘅單）
 *
 * 不變式:
 *  - SL hit / 大蝕（<-3% margin）/ thesis_invalidation / holdmin——永遠優先
 *  - P9-defer（浮盈 ≥1%）正交——嗰個保護浮盈, 呢個保護輕虧損, 唔重疊
 *  - 已證偽源（OLR/Q-RL/FP）零參與
 *
 * env 回滾:
 *  - P9_LIGHTLOSS_PROTECT=false（默認 true——有實驗數據支持）
 *  - P9_LLPP_MAX_DEFER（clamp [1, 12], 預設 6 = 30min @5min cycle）
 *  - P9_LLPP_RESUME_PNL_PCT（clamp [0, 0.02], 預設 0.005 = 回本+0.5% 救返）
 */

export interface LLPPConfig {
  /** 總開關——默認 true（實驗支持） */
  enabled: boolean;
  /** 最大延遲 cycles（[1, 12]）——預設 6 = 30 分鐘 @5min cycle */
  maxDefer: number;
  /** 回升救返閾值（margin fraction, [0, 0.02]）——預設 0.005 = +0.5% margin
   *  ⚠️ 實驗對照參數: production 語義上「回升到 0 交返正常流程」（P9-defer 接手浮盈）
   *  先正確——LLPP 只擋虧損, 唔會用嚟拖浮盈倉。呢個值保留供 counterfactual 對照。 */
  resumePnlPct: number;
  /** 輕虧損下限（margin fraction, [-0.05, -0.005]）——預設 -0.03 = -3% margin */
  minLossPct: number;
  /** 上限（margin fraction）——輕虧損係虧損, 永遠 < 0 */
  maxLossPct: number;
}

export function createLLPPConfig(env: NodeJS.ProcessEnv = process.env): LLPPConfig {
  const parseBool = (v: string | undefined, def: boolean): boolean => {
    if (v === undefined) return def;
    // 明確 true/false 先接受; 其他垃圾值 → 默認(保守但有實驗支持)
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return def;
  };
  const clampNum = (v: string | undefined, def: number, lo: number, hi: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  return {
    enabled: parseBool(env['P9_LIGHTLOSS_PROTECT'], true),
    maxDefer: Math.round(clampNum(env['P9_LLPP_MAX_DEFER'], 6, 1, 12)),
    resumePnlPct: clampNum(env['P9_LLPP_RESUME_PNL_PCT'], 0.005, 0, 0.02),
    minLossPct: clampNum(env['P9_LLPP_MIN_LOSS'], -0.03, -0.05, -0.005),
    maxLossPct: 0, // 虧損先保護——上限固定 0
  };
}

export interface LLPPInput {
  /** 當前持倉已實現/未實現 PnL（margin fraction, 0.01 = 1% margin） */
  unrealizedPnlPct: number;
  /** 持倉時長（分鐘）——<15min 由 holdmin 處理, LLPP 唔重疊 */
  holdMin: number;
  /** 開倉方向 */
  side: 'buy' | 'sell';
  /** 當前價格 */
  currentPrice: number;
  /** stop loss 價（>0 先有效） */
  stopLossPrice: number;
  /** 今 cycle 已延遲次數（llpp deferrals count） */
  deferCount: number;
  /** SL 已觸發（由 caller 判定——價格已穿 SL） */
  isSLHit: boolean;
  config: LLPPConfig;
}

export interface LLPPDecision {
  /** 應唔應該延遲 close */
  defer: boolean;
  /** 延遲已達上限, 照 close */
  expired: boolean;
  /** 決策理由（log + audit） */
  reason: string;
  /** 延遲後嘅 count（caller 用嚟更新 Map） */
  nextDeferCount: number;
}

/**
 * per-symbol 過早率 → 動態 maxDefer（量化金融: 條件概率條件化）
 *
 * 邏輯: symbol×side 歷史過早率（close 後價格繼續走 = 過早平倉）高嘅話,
 * 延遲窗口加長（更俾時間反彈）; 低過早率 -> 縮短（唔好無謂 hold）。
 *
 * - rate ≥ 60%（顯著過早）-> maxDefer × 2（上限 12）
 * - rate ≥ 40%（有過早傾嚮）-> maxDefer × 1.5
 * - rate ≥ 20%（普通）-> 原樣
 * - rate < 20%（準確離場）-> maxDefer × 0.5（下限 2）——唔好拖
 *
 * 冷啟動（total < 5 或 rate 無效）-> 原樣。
 */
export function computeLLPPMaxDefer(baseMaxDefer: number, prematureRate?: number, sampleN?: number): number {
  if (prematureRate === undefined || sampleN === undefined) return baseMaxDefer;
  if (!Number.isFinite(prematureRate) || !Number.isFinite(sampleN) || sampleN < 5) return baseMaxDefer;
  const rate = Math.max(0, Math.min(1, prematureRate));
  if (rate >= 0.6) return Math.min(12, Math.round(baseMaxDefer * 2));
  if (rate >= 0.4) return Math.min(12, Math.round(baseMaxDefer * 1.5));
  if (rate < 0.2) return Math.max(2, Math.round(baseMaxDefer * 0.5));
  return baseMaxDefer;
}

/**
 * 純函數: 輕虧損過早保護決策。
 *
 * 決策樹:
 *  1. 閘唔開 / SL hit / 大蝕（<-3%）/ 持倉太短 / 非輕虧損 → 唔 defer
 *  2. 輕虧損 + deferCount < maxDefer → defer（延長窗口）
 *  3. deferCount ≥ maxDefer → expired, 照 close
 */
export function decideLightLossProtection(input: LLPPInput): LLPPDecision {
  const { config } = input;
  const D = (reason: string, defer = false, expired = false, next = input.deferCount): LLPPDecision =>
    ({ defer, expired, reason, nextDeferCount: next });

  if (!config.enabled) return D('llpp disabled');

  // ── 不變式: SL hit 永遠第一（P9-llpp-attack D1）——即使 pnl 垃圾都要先檢查 ──
  if (input.isSLHit) return D('SL hit — 止血優先, 唔延遲');

  // ── 入口 sanitize（P9-llpp-attack 2026-08-30）: NaN/Infinity 狀態注入防禦 ──
  // 任何非有限數值 → 唔 defer（安全方向——唔可以俾垃圾值觸發/穿越範圍檢查）:
  //  - NaN pnl 曾穿越 [-3%, 0) 檢查落入 defer → 無限延遲 DoS（A1）
  //  - NaN deferCount 令 `NaN >= maxDefer` 永遠 false → 永久延遲（A4）
  //  - NaN holdMin 穿越 <15 檢查誤 defer（A6）
  if (!Number.isFinite(input.unrealizedPnlPct)) return D('pnl 非有限值(NaN/Infinity)— 唔 defer');
  if (!Number.isFinite(input.holdMin) || input.holdMin < 0) {
    // 垃圾持倉時長 → 當 0（唔 defer, 交 holdmin 邏輯或安全 fallback）
    return D('holdMin 非有限/負數 — 唔 defer');
  }
  // 垃圾 deferCount(NaN/負)→ 當「已到期」（expired, 照 close）——唔可以俾 NaN 撐起無限延遲;
  // 正常 count 則 clamp 到 [0, maxDefer]
  const safeDeferCount = Number.isFinite(input.deferCount) && input.deferCount >= 0
    ? Math.min(input.deferCount, config.maxDefer)
    : config.maxDefer;
  // 輕虧損範圍: [-3%, 0) —— 大蝕（< -3%）唔保護（止血）
  if (input.unrealizedPnlPct >= config.maxLossPct) return D(`非虧損倉 (${(input.unrealizedPnlPct * 100).toFixed(2)}% ≥ 0) — 唔 apply`);
  if (input.unrealizedPnlPct < config.minLossPct) return D(`大蝕 (${(input.unrealizedPnlPct * 100).toFixed(2)}% < ${(config.minLossPct * 100).toFixed(0)}%) — 止血, 唔延遲`);
  // 持倉 <15min 由 holdmin 處理（喺 LLPP 之前行）——喺度防守重疊
  if (input.holdMin < 15) return D(`持倉 ${input.holdMin.toFixed(0)}min < 15min — holdmin 已覆蓋`);

  // 到期檢查
  if (safeDeferCount >= config.maxDefer) {
    return D(`LLPP 已延遲 ${safeDeferCount}/${config.maxDefer} cycles — 到期, 照 consensus close`, false, true, safeDeferCount);
  }

  return D(
    `輕虧損 ${(input.unrealizedPnlPct * 100).toFixed(2)}% margin → 延遲 consensus close（${safeDeferCount + 1}/${config.maxDefer} cycles, LLPP——實驗: 32% premature +48pp）`,
    true, false, safeDeferCount + 1,
  );
}
