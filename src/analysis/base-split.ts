/**
 * base-split.ts —— v2.0.893-P9-base-split: base 站位拆分(六組件獨立條目 + 獨立 disable)
 *
 * 背景(PLAN_base-split, 2026-09-18): base(consensus×pwin×blend×penalty×boost×dirTrust×ev)
 *   一個打包乘數 avg=0.424——「consensus 100% 一站縮至 42%」嘅元兇無法歸因。
 *   「You can't tune what you can't attribute」最後一塊盲區。
 *
 * 語義:
 *   - calibrated-consensus = 基數(校準後 consensus)——disable 時 fallback 去未校準
 *     consensus 原值(基數唔係乘數,唔可以乘 1.0)
 *   - 其餘五個(pwin-blend / plan-g-penalty / plan-g-boost / llm-dir-trust / ev-filter)
 *     = 乘數——disable 時 ×1.0(soft,唔 block,唔改方向)
 *   - 連乘 = 原 baseConfidence(數值不變,純歸因層拆分——同 P9-ledger-shape-expose 先例)
 *
 * ⚠️ ATTACK ROUND 硬化(2026-09-18, 主神「不擇手段」):
 *   A1: c 傳 null/undefined/string/function → 唔 crash,保守閉
 *   A2: 1e308/MAX_VALUE 天文注入 → 唔可以 Infinity(原代碼 Infinity>=threshold 必定開倉 = 繞過一切 gate)
 *       → 範圍語義: 概率類組件(calibrated/consensus)合法 [0,1];乘數類合法 [0,10](boost≤1.35/ev≤1.25/penalty≤1)
 *         超出 = 污染 → fallback 0(閉,同原 NaN→HOLD 一致)
 *   A3: -0 注入 → 唔可以輸出 -0(Object.is(-0,0) 污染 ledger)
 *   A4: proxy getter-bomb → 讀 field 時 throw → 唔 crash,保守閉
 *   全部失敗語義 = fallback 0(閉)→ HOLD,即「失敗 → 更保守」單向性(831 資本保存第一)。
 *
 * 單一 source of truth: index.ts 同 tests 都用呢個 helper。env `P9_SOFTGATE_DISABLE`
 * 加關鍵字即可單獨停用(預設全開 = 零行爲變化)。
 */
export interface BaseComponents {
  /** 原始(未校準)consensus——calibrated-consensus disable 時嘅 fallback 基數 */
  consensusConfidence: number;
  /** 校準後 consensus(基數) */
  calibratedConsensus: number;
  /** pwin blend factor(OLR 已剔,P9-provenance-restrict——只係 combo override) */
  pwinBlendFactor: number;
  /** Plan G hybrid decay penalty(5-factor) */
  penaltyFactor: number;
  /** Plan G winner boost(lossStreakTracker) */
  boostFactor: number;
  /** LLM direction trust(09-09 起恆 1.0) */
  llmDirectionTrust: number;
  /** EV filter multiplier */
  evMultiplier: number;
}

export interface BaseLedgerEntry {
  gate: string;
  mult: number;
}

export interface BaseSplitResult {
  baseConfidence: number;
  ledger: BaseLedgerEntry[];
}

/** 概率類讀取: 合法 [lo, hi];null/垃圾/getter-trap → null(閉) */
function readWithin(c: unknown, key: string, lo: number, hi: number): number | null {
  if (!c || typeof c !== 'object') return null;
  let v: unknown;
  try {
    v = (c as Record<string, unknown>)[key];
  } catch { return null; } // A4: getter bomb / Proxy trap
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (Object.is(v, -0)) return null; // A3: -0 係垃圾
  if (v < lo || v > hi) return null; // A2: 天文注入 / 負數 → 閉
  return v;
}

/**
 * 拆 base——六組件獨立條目 + 各自可 disable。
 *  - calibrated-consensus disable → 用未校準 consensus(基數語義)
 *  - 其餘 disable → ×1.0(soft)
 *  - 全部連乘 = 原 baseConfidence
 *  - 任何組件超出合法範圍(概率 [0,1] / 乘數 [0,10])→ fallback 0(保守閉)
 */
export function buildBaseConviction(c: BaseComponents | null | undefined, disabled: ReadonlySet<string> | undefined | null): BaseSplitResult {
  // 防禦: runtime 傳入非 Set(undefined/null/垃圾)——當空 Set(全部開, 零行爲變化)。
  // 831「不可以假設 caller 一定啱」——helper 自身要扛。
  const dis: ReadonlySet<string> = disabled instanceof Set ? disabled : new Set<string>();
  // A4→S3(attack2): has() 都可能被 Proxy trap throw——無法確認 disable → 當冇 disable
  // (保留 gate = 保守: disable 係移除 shrink/防禦,唔可以喺不確定下移除)。
  const isDisabled = (name: string): boolean => {
    try { return dis.has(name); } catch { return false; }
  };
  // A1/A4: c 垃圾或 proxy trap → 全閉(0)。失敗 → 更保守。
  const calRaw = readWithin(c, 'calibratedConsensus', 0, 1);
  const cal = calRaw === null ? 0 : calRaw;
  const consRaw = readWithin(c, 'consensusConfidence', 0, 1);
  const cons = consRaw === null ? cal : consRaw;
  const mult = (key: string): number => {
    const v = readWithin(c, key, 0, 10);
    return v === null ? 0 : v;
  };
  const effCalibrated = isDisabled('calibrated-consensus') ? (consRaw === null ? cal : cons) : cal;
  const effPwinBlend = isDisabled('pwin-blend') ? 1.0 : mult('pwinBlendFactor');
  const effPenalty = isDisabled('plan-g-penalty') ? 1.0 : mult('penaltyFactor');
  const effBoost = isDisabled('plan-g-boost') ? 1.0 : mult('boostFactor');
  const effDirTrust = isDisabled('llm-dir-trust') ? 1.0 : mult('llmDirectionTrust');
  const effEv = isDisabled('ev-filter') ? 1.0 : mult('evMultiplier');
  // 溢出水尾防線: 六個 [0,10] 乘數連乘最多 1e6,唔可能 Infinity?10^6=1e6 finite——
  // 但概率組件 ≤1,乘數 ≤10,極限 = 1×10×10×10×10×10 = 1e5,finite。純防禦 double-check。
  const product = effCalibrated * effPwinBlend * effPenalty * effBoost * effDirTrust * effEv;
  const baseConfidence = Number.isFinite(product) ? product : 0;
  return {
    baseConfidence,
    ledger: [
      { gate: 'calibrated-consensus', mult: effCalibrated },
      { gate: 'pwin-blend', mult: effPwinBlend },
      { gate: 'plan-g-penalty', mult: effPenalty },
      { gate: 'plan-g-boost', mult: effBoost },
      { gate: 'llm-dir-trust', mult: effDirTrust },
      { gate: 'ev-filter', mult: effEv },
    ],
  };
}
