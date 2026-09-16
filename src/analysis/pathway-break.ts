// ═══════════════════════════════════════════════════════════════════════════
// pathway-break.ts —— 決策電路斷線監察（v2.0.890-C1, 主神 2026-09-16）
//
// 概念: connectomics「完整迴路」——感官輸入必須連到運動輸出;MATS:「edge 訊號 +
// agents 意向」必須通到「執行」。過去 48h 兩次教訓(mom24-guard 鎖 breakout /
// tail-watchdog 卡死)= 「系統想開但閂咗路」——呢種斷線要永久可視(LOUD 唔 block)。
//
// 觸發(全部同時): edge 訊號存在 ∧ agents 判 buy/sell ∧ 執行層被 gate block(blockedBy)
// 連續 ≥ thresholdCycles(env PATHWAY_BREAK_CYCLES, default 6)→ 斷線 LOUD。
// agents 判 hold(冇意向)唔算——嗰啲係「lean 弱」,唔係斷線。
//
// env PATHWAY_BREAK_CYCLES 可調;PATHWAY_BREAK_DISABLE=true 關。 ═══════════════

export interface PathwayBreakInput {
  symbol: string;
  /** edge 訊號存在(edgeHints / TIP / 4h 強動量未開倉候選) */
  hasEdgeSignal: boolean;
  /** agents 意向(perSymbolConsensus action)——只有 buy/sell 先算「想開」,hold 唔算 */
  agentIntent: 'buy' | 'sell' | 'hold' | 'close' | null | undefined;
  /** 執行層 gate block 原因(如 'mom24-guard: ... HARD BLOCK')——空 = 冇被閂 */
  blockedBy: string | null | undefined;
}

export interface PathwayBreakState {
  consecutive: number;
}

export interface PathwayBreakResult {
  broken: boolean;
  consecutive: number;
  reason: string | null;
}

/** 純函數——單一 cycle 嘅斷線判斷 + 累計(可測) */
export function detectPathwayBreak(
  prev: PathwayBreakState | null | undefined,
  input: PathwayBreakInput,
  thresholdCycles: number,
): PathwayBreakState {
  const hasIntent = input.agentIntent === 'buy' || input.agentIntent === 'sell';
  const hasBlock = typeof input.blockedBy === 'string' && input.blockedBy.length > 0;
  const trigger = input.hasEdgeSignal && hasIntent && hasBlock;
  if (!trigger) return { consecutive: 0 };
  const consecutive = (prev?.consecutive ?? 0) + 1;
  return { consecutive };
}

/** LOUD 訊息格式化 */
export function formatPathwayBreak(
  symbol: string,
  intent: 'buy' | 'sell',
  blockedBy: string,
  consecutive: number,
): string {
  return `🚨 [PATHWAY-BREAK] ${symbol.toUpperCase()}: edge 訊號 + agents ${intent.toUpperCase()} + 被 gate 鎖死(${blockedBy.slice(0, 80)}) ×${consecutive} cycles——決策電路斷線, 檢查 gate` ;
}
