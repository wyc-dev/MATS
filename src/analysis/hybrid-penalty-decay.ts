// ═══════════════════════════════════════════════════════════════════════════
// v2.0.870-P16 + P16-attack2 + P17: Hybrid Penalty Decay(混合衰減)
//
// 背景:Plan G(v2.0.227)嘅 penalty 只喺 idle(冇交易)時衰減——
//   decayMultiplier = max(0, 1 - idleCycles / 30)
// 系統蝕緊錢時 → penalty 高 → 壓制 trade → 繼續蝕(但唔 idle)→ penalty
// 永遠唔衰減 → death spiral(penaltyFactor 永久卡喺 floor 0.70)。
//
// 主神方案(混合衰減,20/40/40 權重):
//   1) 30 cycles 衰減 + 贏錢衰減        —— 20%
//   2) 時間衰減 exp(−Δt/τ_eff)          —— 40%
//   3) Edge-aware(強 edge 唔壓制)     —— 40%
//
// 三個結構修正(P16 + 回測驅動):
//   修正 1(time floor):score 必須 ≥ dTime——時間係保底,唔係普通加權項。
//   修正 2(edge hard-bypass):極強 edge 完全豁免(唔係只豁免 40%)。
//   修正 3(idle floor,回測捉到):idle-complete 必須保持全釋放——
//     純加權會令佢只剩 20% 貢獻(burden +442% 退化)。
//   最終結構 = 三層 OR:score = max(idleFloor, timeFloor, weighted)。
//   數學保證:score ≥ dIdle = 舊規則 decay → 新規則嚴格支配舊規則。
//
// τ_eff = τ × runsTestMultiplier(主神裁決:τ 預設 12h;v2.0.870-P17):
//   v2.0.870-P17 Runs Test Loss-Clustering Detector(Wald-Wolfowitz 游程檢定):
//   時間衰減嘅職責係「證據過時」——但過時速度取決於證據係 regime 持續定隨機噪聲:
//     z ≤ −1.96(連蝕成串 = regime 持續)→ τ_eff = τ × 1.5(18h,慢放)
//     |z| < 1.96(隨機散落 = 運氣)→ τ_eff = τ(12h,正常)
//     z ≥ +1.96(乒乓交替 = 高噪聲市)→ τ_eff = τ × 0.75(9h,快放)
//   全蝕 ring(方差為零)→ 極端成串 → ×1.5;全贏 → 極端回復 → ×0.75。
//   n < 15 → ×1.0(冷啟動中性)。
//
// ══ P16-attack2 硬化(bypass 係最強動作,證據要最足)══════════════════════
//   - F1/F2 持久化污染:combo tracker 狀態可被通脹 wins 偽造——hybrid 層加
//     plausibility 檢查:① wilsonLB ≤ maxLB(n) = 1/(1+z²/n)(不可能嘅 LB = 污染)
//     ② n ∈ [1, 5000](超出 = 通脹注入,成個 edge 通道歸零——bypass 同
//     graduated 都唔俾)③ median/ewma |值| ≤ 300%(MAX_SANITY 慣例)
//   - F3 新鮮度:bypass 要求 currentCycle − edgeLastCycle ≤ edgeStaleCycles
//     (預設 1000 ≈ 2× EWMA 半衰期)——陳舊強 edge(EWMA write-only decay
//     嘅讀取盲點)唔能喺新 regime 豁免。缺 cycle 資訊 → 唔 bypass(保守)。
//     graduated dE 唔受新鮮度影響(歷史證據仍值部分 credit)。
//   - F6 雙計防禦:recordEvent 接受 tradeId,LRU ring(cap 500)去重。
//   - 未來 lastPenaltyEventAt → max(0, Δt) clamp(P15-attack 教訓)
//   - per-symbol 狀態(v2.0.228 教訓)
//   - 持久化(JSON atomic write)——restart 唔會免費 reset decay clock
//   - persistence pollution:__proto__ key 防禦 + finite 檢查 + clamp + map cap
// ═══════════════════════════════════════════════════════════════════════════

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'hybrid-penalty-decay' });

// ─── Constants(主神裁決權重 + 量化校準)──────────────────────────────────

/** 權重:cycle+win 20% / time 40% / edge 40%(主神裁決,唔做 env——防誤調) */
export const W_CYCLE_WIN = 0.2;
export const W_TIME = 0.4;
export const W_EDGE = 0.4;

/** idle 完全衰減所需 cycles(同 Plan G 原有 PENALTY_DECAY_CYCLES 一致) */
const IDLE_FULL_DECAY_CYCLES = 30;
/** 贏錢衰減:每贏減半殘留,dWin = 1 − 0.5^wins;wins 計算上限(4 贏 = 93.75%) */
const WIN_HALVING_MAX_WINS = 4;
/** winsSincePenalty 持久化儲存上限(防整數無限增長;計算時再 min 到 4) */
const WINS_STORAGE_CAP = 64;
/** tracker map 上限(防持久化污染/記憶體 DoS——v2.0.854 模式) */
const MAX_TRACKED_SYMBOLS = 500;
/** tradeId dedup ring 上限(雙管道重放窗口好短,500 已係極大量緩衝) */
const TRADE_ID_RING_CAP = 500;
/** outcome ring(游程檢定輸入)每 symbol 上限 */
const OUTCOME_RING_CAP = 30;
/** 游程檢定最少樣本(低於 → τ multiplier 1.0 中性) */
const RUNS_MIN_SAMPLES = 15;
/** 游程檢定 z 門檻(95% 雙尾) */
const RUNS_Z = 1.96;
/** 預設時間衰減 τ = 12h(主神裁決:24h 太長;runs test 調製後實效 9–18h) */
const DEFAULT_TAU_MS = 12 * 3600 * 1000;
/** edge graduated 通道:wilsonLB 低於此值 → dE = 0(貢獻為零) */
const DEFAULT_EDGE_GRAD_LOW = 0.55;
/** edge graduated 通道:最少樣本(低於 → dE = 0,冷啟動保守) */
const DEFAULT_EDGE_MIN_SAMPLES = 15;
/** hard bypass:wilsonLB 門檻(統計顯著強 edge) */
const DEFAULT_EDGE_BYPASS_WILSON = 0.70;
/** hard bypass:最少樣本(高於 graduated——豁免係更強動作,要更強證據) */
const DEFAULT_EDGE_BYPASS_SAMPLES = 25;
/** F2:edge 樣本上界——超出 = 通脹注入,成個 edge 通道歸零 */
const MAX_PLAUSIBLE_EDGE_SAMPLES = 5000;
/** F2:pnl sanity 上界(同 MAE/entry-quality MAX_SANITY 一致) */
const EDGE_PNL_SANITY = 300;
/** F2:wilson z(必須同 evolution-utils wilsonScore 一致 = 1.96) */
const WILSON_Z = 1.96;
/** F2:不可能的 LB 容差(浮點誤差) */
const WILSON_PLAUSIBILITY_EPS = 0.01;
/** F3:bypass 新鮮度窗口預設(cycles ≈ 2× EWMA 半衰期 500) */
const DEFAULT_EDGE_STALE_CYCLES = 1000;

const DEFAULT_PATH = 'data/evolution/plan-g-decay-state.json';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface HybridDecayConfig {
  /** PLAN_G_HYBRID_DECAY=false → 停用(走舊 idle-only 路徑,可回滾) */
  enabled: boolean;
  /** 時間衰減基準 τ(ms;有效 τ_eff = τ × runsTestMultiplier) */
  tauMs: number;
  /** edge graduated wilsonLB 起點(低於 → dE=0) */
  edgeGradLow: number;
  /** edge graduated 最少樣本 */
  edgeMinSamples: number;
  /** hard bypass wilsonLB 門檻 */
  edgeBypassWilson: number;
  /** hard bypass 最少樣本 */
  edgeBypassSamples: number;
  /** F3:hard bypass 新鮮度窗口(cycles;現時 cycle − edgeLastCycle 超出 → 唔 bypass) */
  edgeStaleCycles: number;
}

export interface HybridDecayInput {
  /** per-symbol idle cycles(冇交易嘅 cycle 數) */
  idleCycles: number;
  /** 該 symbol 最近一次蝕錢 close 嘅 timestamp(ms epoch);null = 從未記錄 */
  lastPenaltyEventAt: number | null;
  /** lastPenaltyEventAt 之後嘅贏錢 close 數(新蝕錢會 reset 為 0) */
  winsSincePenalty: number;
  /** combo tracker wilsonLB(symbol × side × 當前 regime);null = 無數據 */
  edgeWilsonLB: number | null;
  /** combo 樣本數 */
  edgeSamples: number;
  /** combo median pnlPct(skew trap 守衛);null = 缺失(保守 ×0.5) */
  edgeMedianPnlPct: number | null;
  /** combo EWMA pnlPct(新鮮度守衛,只用於 hard bypass);null = 缺失(唔 bypass) */
  edgeEwmaPnlPct: number | null;
  /** F3:combo 最後更新 cycle(bypass 新鮮度);null/缺失 → 唔 bypass(保守) */
  edgeLastCycle?: number | null;
  /** F3:當前 cycle 數(index.ts totalCycles) */
  currentCycle?: number;
  /** P17:runs test τ 調製倍率 [0.5, 2](預設 1);tracker 游程檢定輸出 */
  tauMultiplier?: number;
  /** 注入時鐘(測試用);預設 Date.now() */
  now?: number;
}

export interface HybridDecayBreakdown {
  dIdle: number;
  dWin: number;
  dCW: number;
  dTime: number;
  dEdge: number;
  weighted: number;
  idleFloor: number;
  timeFloor: number;
  /** P17:實際生效嘅 τ 調製倍率(1 = 基準 12h) */
  tauMultiplier: number;
}

export interface HybridDecayResult {
  /** 衰減分數 [0,1](1 = penalty 完全釋放)。用法:decayedPenalty = netPenalty × (1 − score) */
  score: number;
  /** hard bypass 觸發(極強 edge → 完全豁免) */
  bypassed: boolean;
  breakdown: HybridDecayBreakdown;
  reason: string;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nonNegInt(v: number | null | undefined, cap: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(cap, Math.floor(v)));
}

/** F2:n 個樣本全贏嘅理論 wilsonLB 上限(中心極限——超出即污染) */
function maxWilsonLB(n: number): number {
  if (n <= 0) return 0;
  return 1 / (1 + (WILSON_Z * WILSON_Z) / n);
}

/**
 * v2.0.870-P17: Wald-Wolfowitz 游程檢定 → τ 調製倍率(純函數)。
 *
 * 量化金融邏輯:penalty 應該對 regime 持續性(serial correlation)反應,
 * 唔係對隨機運氣反應。連蝕顯著成串 = 壞 regime 仲未完 → 時鐘行慢啲;
 * 贏蝕頻密交替 = 高噪聲 → 證據唔可靠,時鐘行快啲。
 *
 * @param outcomes 最近 outcome ring(1 = 贏,0 = 蝕),時間順序
 * @returns τ multiplier:1.5(成串)/ 1.0(隨機)/ 0.75(交替);n<15 → 1.0
 */
export function computeRunsTestTauMultiplier(outcomes: number[]): number {
  try {
    const clean = outcomes.filter(o => o === 0 || o === 1);
    const n = clean.length;
    if (n < RUNS_MIN_SAMPLES) return 1.0;
    let n1 = 0; // wins
    for (const o of clean) n1 += o;
    const n2 = n - n1;  // losses
    // 全蝕 = 極端 regime 持續(方差為零,z 無定義)→ 直接最強延長
    if (n1 === 0) return 1.5;
    // 全贏 = 極端回復 → 最快釋放
    if (n2 === 0) return 0.75;

    let runs = 1;
    for (let i = 1; i < n; i++) {
      if (clean[i] !== clean[i - 1]) runs++;
    }
    const mu = 1 + (2 * n1 * n2) / n;
    const varR = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
    if (!Number.isFinite(varR) || varR <= 0) return 1.0;
    const z = (runs - mu) / Math.sqrt(varR);
    if (!Number.isFinite(z)) return 1.0;
    if (z <= -RUNS_Z) return 1.5;  // 成串(regime 持續)→ 慢放
    if (z >= RUNS_Z) return 0.75;  // 交替(高噪聲)→ 快放
    return 1.0;
  } catch {
    return 1.0;
  }
}

// ─── Pure scoring function ─────────────────────────────────────────────────

/**
 * 計算混合衰減分數(純函數——無 I/O、無 Date.now() 除非省略 now、無副作用)。
 * 任何污染輸入都被 sanitize 為保守值(衰減變慢/唔 bypass——永遠唔會放大 decay)。
 */
export function computeHybridDecayScore(
  input: HybridDecayInput,
  cfg: HybridDecayConfig,
): HybridDecayResult {
  const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();

  // ── F2:edge 輸入 plausibility 檢查(持久化污染防線)───────────────────
  // combo tracker 狀態嚟自磁碟 JSON,可被通脹 wins 偽造。P16 之前污染最多
  // 扭曲 blend/penalty;P16 之後同一污染可以買到「完全豁免 penalty」。
  // 所以 bypass/graduated 都必須通過:
  //   ① wilsonLB ≤ maxLB(n)——n=25 嘅理論上限係 0.867;報 0.99 即不可能
  //   ② n ≤ 5000——真實 combo 幾十至幾百 trades;100k = 通脹注入
  //   ③ median/ewma |值| ≤ 300%(MAX_SANITY 慣例)
  const rawLb = finiteOrNull(input.edgeWilsonLB);
  const rawSamples = nonNegInt(input.edgeSamples, Number.MAX_SAFE_INTEGER);
  const rawMedian = finiteOrNull(input.edgeMedianPnlPct);
  const rawEwma = finiteOrNull(input.edgeEwmaPnlPct);

  const plausible =
    rawLb !== null &&
    rawSamples >= 1 && rawSamples <= MAX_PLAUSIBLE_EDGE_SAMPLES &&
    rawLb <= maxWilsonLB(rawSamples) + WILSON_PLAUSIBILITY_EPS;

  const lb = plausible ? rawLb : null;
  const samples = plausible ? rawSamples : 0;
  const median = rawMedian !== null && Math.abs(rawMedian) <= EDGE_PNL_SANITY ? rawMedian : null;

  // ── F3:bypass 新鮮度(EWMA write-only decay 嘅讀取盲點)────────────────
  // combo 休眠時 ewmaPnlPct 唔會衰減(只喺 trackTrade write 時衰減)——
  // 陳舊強 edge 會喺新 regime 繼續 bypass。要求最後更新喺窗口內。
  const edgeLastCycle = finiteOrNull(input.edgeLastCycle);
  const currentCycle = Number.isFinite(input.currentCycle) ? (input.currentCycle as number) : null;
  const edgeFresh =
    edgeLastCycle !== null && currentCycle !== null &&
    currentCycle - edgeLastCycle >= 0 &&
    currentCycle - edgeLastCycle <= cfg.edgeStaleCycles;

  // ewma 只喺 bypass 用,且必須過 sanity
  const ewma = rawEwma !== null && Math.abs(rawEwma) <= EDGE_PNL_SANITY ? rawEwma : null;

  // ── Hard bypass(極強 edge 完全豁免)──────────────────────────────────
  // 全部條件必須成立;任何數據缺失/陳舊/不可信 → 唔 bypass
  // (豁免係最強動作,證據要最足)。
  if (
    lb !== null && lb >= cfg.edgeBypassWilson &&
    samples >= cfg.edgeBypassSamples &&
    median !== null && median > 0 &&
    ewma !== null && ewma > 0 &&
    edgeFresh
  ) {
    return {
      score: 1.0,
      bypassed: true,
      breakdown: { dIdle: 0, dWin: 0, dCW: 0, dTime: 0, dEdge: 1, weighted: 0, idleFloor: 0, timeFloor: 0, tauMultiplier: 1 },
      reason: `EDGE-BYPASS: wilsonLB=${lb.toFixed(2)}≥${cfg.edgeBypassWilson}, n=${samples}≥${cfg.edgeBypassSamples}, median/EWMA>0, fresh → 強 edge 完全豁免`,
    };
  }

  // ── Channel 1:cycle + win 複合(取 max,唔 double-count)──────────────
  const idle = nonNegInt(input.idleCycles, 100000);
  const dIdle = Math.min(1, idle / IDLE_FULL_DECAY_CYCLES);
  const wins = nonNegInt(input.winsSincePenalty, WIN_HALVING_MAX_WINS);
  const dWin = 1 - Math.pow(0.5, wins);
  const dCW = Math.max(dIdle, dWin);

  // ── Channel 2:時間衰減(max(0, Δt)——未來時間戳 clamp,P15-attack 教訓)──
  // P17:τ_eff = τ × runsTestMultiplier——連蝕成串(regime 持續)行慢啲,
  // 贏蝕交替(噪聲)行快啲。
  const tauMult = Number.isFinite(input.tauMultiplier)
    ? Math.max(0.5, Math.min(2.0, input.tauMultiplier as number))
    : 1.0;
  const tauEffMs = cfg.tauMs * tauMult;
  const lastPenalty = finiteOrNull(input.lastPenaltyEventAt);
  const dTime = lastPenalty === null
    ? 0
    : 1 - Math.exp(-Math.max(0, now - lastPenalty) / tauEffMs);

  // ── Channel 3:edge graduated(冷啟動保守;median ≤0/缺失 → skew trap 減半)──
  let dEdge = 0;
  if (lb !== null && samples >= cfg.edgeMinSamples) {
    const range = cfg.edgeBypassWilson - cfg.edgeGradLow;
    if (range > 0) {
      dEdge = Math.max(0, Math.min(1, (lb - cfg.edgeGradLow) / range));
      if (median === null || median <= 0) dEdge *= 0.5;
    }
  }

  // ── 合成:三層 OR——idle floor + time floor + 加權加速 ─────────────────
  // floors 保證任何單一充分證據都可以完成釋放;加權項令 wins/edge
  // 喺 floors 未起時率先加速。數學保證:score ≥ dIdle = 舊規則 decay。
  const weighted = W_CYCLE_WIN * dCW + W_TIME * dTime + W_EDGE * dEdge;
  const score = Math.max(0, Math.min(1, Math.max(dIdle, dTime, weighted)));

  return {
    score,
    bypassed: false,
    breakdown: { dIdle, dWin, dCW, dTime, dEdge, weighted, idleFloor: dIdle, timeFloor: dTime, tauMultiplier: tauMult },
    reason: `score=${(score * 100).toFixed(0)}% (idle=${(dIdle * 100).toFixed(0)}% time=${(dTime * 100).toFixed(0)}% [τ×${tauMult}] edge=${(dEdge * 100).toFixed(0)}% weighted=${(weighted * 100).toFixed(0)}%)`,
  };
}

// ─── Env config ────────────────────────────────────────────────────────────

function parseEnvNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvInt(raw: string | undefined, fallback: number, min: number): number {
  const n = parseEnvNum(raw, fallback);
  return Math.max(min, Math.floor(n));
}

/**
 * 從 env 構建 config(預設全部安全;污染值 → 預設)。
 * Env flags:
 *   PLAN_G_HYBRID_DECAY       (default true; 'false' → 停用,走舊 idle-only 路徑)
 *   PLAN_G_DECAY_TAU_HOURS    (default 12;時間衰減基準 τ,必須 > 0——
 *                              主神裁決 12h;runs test 調製後實效 9–18h)
 *   PLAN_G_EDGE_BYPASS_WILSON (default 0.70;clamp 到 (edgeGradLow, 1))
 *   PLAN_G_EDGE_BYPASS_SAMPLES(default 25)
 *   PLAN_G_EDGE_MIN_SAMPLES   (default 15)
 *   PLAN_G_EDGE_STALE_CYCLES  (default 1000;bypass 新鮮度窗口)
 */
export function hybridDecayConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): HybridDecayConfig {
  const edgeGradLow = DEFAULT_EDGE_GRAD_LOW;
  const tauHours = parseEnvNum(env['PLAN_G_DECAY_TAU_HOURS'], 12);
  const bypassWilsonRaw = parseEnvNum(env['PLAN_G_EDGE_BYPASS_WILSON'], DEFAULT_EDGE_BYPASS_WILSON);
  return {
    enabled: env['PLAN_G_HYBRID_DECAY'] !== 'false',
    tauMs: tauHours > 0 ? tauHours * 3600 * 1000 : DEFAULT_TAU_MS,
    edgeGradLow,
    edgeMinSamples: parseEnvInt(env['PLAN_G_EDGE_MIN_SAMPLES'], DEFAULT_EDGE_MIN_SAMPLES, 1),
    // bypass 門檻必須高過 graduated 起點,否則 dE 公式 range ≤ 0 → clamp 回預設
    edgeBypassWilson: bypassWilsonRaw > edgeGradLow && bypassWilsonRaw <= 1
      ? bypassWilsonRaw
      : DEFAULT_EDGE_BYPASS_WILSON,
    edgeBypassSamples: parseEnvInt(env['PLAN_G_EDGE_BYPASS_SAMPLES'], DEFAULT_EDGE_BYPASS_SAMPLES, 1),
    edgeStaleCycles: parseEnvInt(env['PLAN_G_EDGE_STALE_CYCLES'], DEFAULT_EDGE_STALE_CYCLES, 1),
  };
}

// ─── Per-symbol state tracker(持久化)─────────────────────────────────────

interface SymbolDecayEntry {
  lastPenaltyEventAt: number | null;
  winsSincePenalty: number;
  /** P17:outcome ring(1=贏 0=蝕,時間順序,cap 30)——游程檢定輸入 */
  outcomes: number[];
}

interface DecayStateFile {
  version: number;
  savedAt: number;
  symbols: Record<string, { lastPenaltyEventAt: number | null; winsSincePenalty: number; outcomes?: number[] }>;
}

function normalizeSymKey(symbol: unknown): string {
  return String(symbol ?? '')
    .replace(/[\x00-\x1F]/g, '')
    .trim()
    .toLowerCase()
    .slice(0, 64);
}

/**
 * v2.0.870-P16: per-symbol penalty-event tracker。
 * 記錄「最近一次蝕錢 close 時間」+「其後贏錢次數」+「outcome ring」——
 * 混合衰減嘅證據來源。
 *
 * 語義:
 *   - 蝕錢 close → 重置 penalty 時鐘 + wins 歸零(新嘅懲罰證據)
 *   - 贏錢/pnl≥0 close → wins +1(時鐘繼續行——時間衰減係「距上次蝕錢
 *     幾耐」,兩個通道獨立運作)
 *   - win/loss 都推入 outcome ring(游程檢定——τ 調製)
 *
 * F6:tradeId dedup——同一 close 事件經雙管道(closePosition + onFills
 * 鏡像)重放時唔雙計 wins/時鐘/ring。
 *
 * 持久化必須——否則 restart = 免費 reset 所有 penalty decay clock(exploit)。
 */
export class HybridPenaltyDecayTracker {
  private entries: Map<string, SymbolDecayEntry> = new Map();
  /** F6:最近 tradeId ring(去重);Map 保證插入序 → 最舊 evict */
  private recentTradeIds: Map<string, true> = new Map();
  private path: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(path = DEFAULT_PATH) {
    this.path = path;
  }

  /**
   * 記錄一次 close 事件(symbol 正規化;時間戳 clamp 到 [0, now])。
   * @param isWin pnl ≥ 0(同 onPositionClosedLearning 嘅 WIN 慣例一致)
   * @param tradeId F6:去重用——重複 id 嘅事件完全忽略
   */
  recordEvent(symbol: string, isWin: boolean, at?: number, tradeId?: string | number): void {
    try {
      const sym = normalizeSymKey(symbol);
      if (!sym) return;

      // F6:tradeId dedup(雙管道重放 → 唔雙計)
      if (tradeId !== undefined && tradeId !== null) {
        const id = String(tradeId).slice(0, 128);
        if (id) {
          if (this.recentTradeIds.has(id)) return;
          this.recentTradeIds.set(id, true);
          if (this.recentTradeIds.size > TRADE_ID_RING_CAP) {
            const oldest = this.recentTradeIds.keys().next().value;
            if (oldest !== undefined) this.recentTradeIds.delete(oldest);
          }
        }
      }

      const now = Date.now();
      const t = typeof at === 'number' && Number.isFinite(at)
        ? Math.max(0, Math.min(at, now))
        : now;

      let entry = this.entries.get(sym);
      if (!entry) {
        this.evictIfFull();
        entry = { lastPenaltyEventAt: null, winsSincePenalty: 0, outcomes: [] };
        this.entries.set(sym, entry);
      }

      if (isWin) {
        entry.winsSincePenalty = Math.min(entry.winsSincePenalty + 1, WINS_STORAGE_CAP);
      } else {
        entry.lastPenaltyEventAt = t;
        entry.winsSincePenalty = 0;
      }
      entry.outcomes.push(isWin ? 1 : 0);
      if (entry.outcomes.length > OUTCOME_RING_CAP) entry.outcomes.shift();
      this.markDirty();
    } catch (err) {
      log.warn(`[hybrid-decay] recordEvent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 讀取該 symbol 嘅衰減證據(gate 用)。未知 symbol → 中性零值。 */
  getState(symbol: string): { lastPenaltyEventAt: number | null; winsSincePenalty: number } {
    const entry = this.entries.get(normalizeSymKey(symbol));
    if (!entry) return { lastPenaltyEventAt: null, winsSincePenalty: 0 };
    return {
      lastPenaltyEventAt: entry.lastPenaltyEventAt,
      winsSincePenalty: entry.winsSincePenalty,
    };
  }

  /**
   * P17:游程檢定 τ 調製倍率(該 symbol 嘅 outcome ring)。
   * 未知 symbol / 樣本不足 → 1.0(中性)。
   */
  getTauMultiplier(symbol: string): number {
    const entry = this.entries.get(normalizeSymKey(symbol));
    if (!entry) return 1.0;
    return computeRunsTestTauMultiplier(entry.outcomes);
  }

  getStats(): { symbols: number } {
    return { symbols: this.entries.size };
  }

  /** Map 滿 → evict lastPenaltyEventAt 最舊嘅 entry(最衰減、最無關緊要嘅) */
  private evictIfFull(): void {
    if (this.entries.size < MAX_TRACKED_SYMBOLS) return;
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of this.entries) {
      const ts = v.lastPenaltyEventAt ?? -1; // 從未蝕錢嘅 entry 先 evict
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = k;
        if (ts === -1) break; // 最早可能值,即刻停
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }

  private markDirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  save(): void {
    try {
      const symbols: DecayStateFile['symbols'] = Object.create(null) as DecayStateFile['symbols'];
      for (const [k, v] of this.entries) {
        symbols[k] = {
          lastPenaltyEventAt: v.lastPenaltyEventAt,
          winsSincePenalty: v.winsSincePenalty,
          outcomes: v.outcomes.slice(-OUTCOME_RING_CAP),
        };
      }
      const file: DecayStateFile = { version: 2, savedAt: Date.now(), symbols };
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), 'utf-8');
      fs.renameSync(tmp, this.path);
    } catch (err) {
      log.warn(`[hybrid-decay] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') return;
      const symbols = raw['symbols'];
      if (!symbols || typeof symbols !== 'object' || Array.isArray(symbols)) return;
      const now = Date.now();
      const fresh: Map<string, SymbolDecayEntry> = new Map();
      for (const [key, val] of Object.entries(symbols as Record<string, unknown>)) {
        // __proto__/constructor/prototype key 防禦(持久化污染)
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (fresh.size >= MAX_TRACKED_SYMBOLS) break;
        if (!val || typeof val !== 'object') continue;
        const o = val as Record<string, unknown>;
        const sym = normalizeSymKey(key);
        if (!sym) continue;
        const tsRaw = o['lastPenaltyEventAt'];
        const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw)
          ? Math.max(0, Math.min(tsRaw, now))  // 未來時間戳 clamp(P15-attack 教訓)
          : null;
        const winsRaw = o['winsSincePenalty'];
        const wins = typeof winsRaw === 'number' && Number.isFinite(winsRaw)
          ? Math.max(0, Math.min(WINS_STORAGE_CAP, Math.floor(winsRaw)))
          : 0;
        // P17:outcome ring sanitize——只接受 0/1,cap 30
        const outcomesRaw = o['outcomes'];
        const outcomes = Array.isArray(outcomesRaw)
          ? outcomesRaw.filter(v => v === 0 || v === 1).slice(-OUTCOME_RING_CAP)
          : [];
        fresh.set(sym, { lastPenaltyEventAt: ts, winsSincePenalty: wins, outcomes });
      }
      this.entries = fresh;
    } catch (err) {
      log.warn(`[hybrid-decay] load failed (fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.entries = new Map();
    }
  }

  /** 測試用:清空全部狀態 */
  reset(): void {
    this.entries = new Map();
    this.recentTradeIds = new Map();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}
