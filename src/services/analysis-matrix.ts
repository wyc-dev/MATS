// ─── Analysis Matrix Builder ────────────────────────────────────────────
//
// v2.0.822: Expands a per-asset HACP consensus decision into a recommendation
// matrix indexed by (position state).
//
// v2.0.857: REDUCED to moderate-only — aggressive/conservative risk profiles
// removed (they were uncalibrated placeholders). The client reads
// `matrix.moderate[positionState]`; position sizing is controlled by the
// Position Size / Max Portion / Leverage sliders, not risk profile.
// See plan-task3-4.md for the DCS design history (DCS no longer affects
// conviction since only the moderate baseline is used).

import type {
  AssetAnalysis,
  AnalysisConsensus,
  AnalysisMarketData,
  AnalysisMatrix,
  MatrixCell,
  PositionState,
  RiskProfile,
  EdgeReport,
  ExecutionReport,
} from '../types/index.ts';
import { sanitizeExecutionReport } from './execution-metadata.ts';
import type { PerSymbolConsensus } from '../types/index.ts';
import type { AggregatedMarketState } from '../data/market-state.ts';

/** Map a raw consensus action (+ closePosition flag) to a MatrixCell action,
 *  depending on the user's current position state. */
function mapAction(
  rawAction: string,
  closePosition: boolean,
  posState: PositionState,
): MatrixCell['action'] {
  // Explicit close signal (either the closePosition flag OR action='close')
  // → close the current position. Flat + close → hold (can't close nothing).
  if ((closePosition || rawAction === 'close') && posState !== 'flat') return 'close';
  switch (posState) {
    case 'flat':
      // No position — can only open or stay out.
      if (rawAction === 'buy') return 'buy';
      if (rawAction === 'sell') return 'sell';
      return 'hold';
    case 'long':
      // Already long — buy = hold, sell = flip (close long + open short),
      // close/hold = hold (unless closePosition, handled above).
      if (rawAction === 'sell') return 'flip';
      return 'hold';
    case 'short':
      // Already short — sell = hold, buy = flip (close short + open long).
      if (rawAction === 'buy') return 'flip';
      return 'hold';
  }
}

/** Build a single matrix cell for a (positionState) combination.
 *  v2.0.857: moderate-only — conviction = base conviction (live consensus).
 *  Edge Report skip → hard hold (never act on a no-edge signal). */
function buildProfileCell(
  baseAction: MatrixCell['action'],
  baseConviction: number,
  rationale: string,
  edge?: EdgeReport,
): MatrixCell {
  // Edge Report skip → hard hold
  if (edge?.recommendation === 'skip') {
    return { action: 'hold', conviction: 0, rationale: 'Edge Report: skip', calibrated: true, edge };
  }

  // Moderate baseline — live consensus conviction, DCS never affects it.
  return { action: baseAction, conviction: baseConviction, rationale, calibrated: true, edge };
}

/** Build the (moderate-only) recommendation matrix for one asset from its
 *  per-symbol consensus. v2.0.857: single profile — the client reads
 *  `matrix.moderate[positionState]`. `edge` (optional) carries the
 *  risk-neutral conditional edge report; a 'skip' recommendation forces
 *  the cell action to 'hold'. */
function buildMatrix(
  rawAction: string,
  closePosition: boolean,
  confidence: number,
  rationale: string,
  edge?: EdgeReport,
): AnalysisMatrix {
  const states: PositionState[] = ['long', 'short', 'flat'];
  const matrix = {} as AnalysisMatrix;
  matrix.moderate = {} as Record<PositionState, MatrixCell>;
  for (const state of states) {
    let action = mapAction(rawAction, closePosition, state);
    // v2.0.833: a 'skip' recommendation forces the cell to 'hold' — the
    // backend has no edge for this (symbol, regime) and the client must
    // not act on it. This is the ONLY place edge can mute a signal; it
    // never fabricates a new action.
    if (edge?.recommendation === 'skip') action = 'hold';
    matrix.moderate[state] = buildProfileCell(action, confidence, rationale, edge);
  }
  return matrix;
}

/** Build a complete AssetAnalysis row from the consensus + market state.
 *  Returns null if the symbol has no usable data (skip writing).
 *
 *  v2.0.833: `edgeReport` (risk-neutral) + `profileEdges` (per-profile
 *  conditional) are optional — the orchestrator computes them via the Edge
 *  Validation layer and passes them in. When absent, the matrix is built
 *  exactly as before (backward compatible). */
export function buildAssetAnalysis(
  symbol: string,
  psc: PerSymbolConsensus | undefined,
  marketState: AggregatedMarketState | undefined,
  cycleId: number,
  pwin: number,
  agentsAligned: number,
  agentsTotal: number,
  edgeReport?: EdgeReport,
  execution?: ExecutionReport,
): AssetAnalysis | null {
  // No consensus for this symbol → emit a neutral matrix (all 'hold').
  const rawAction = psc?.action ?? 'hold';
  const closePosition = psc?.closePosition ?? false;
  // Clamp confidence to [0, 1] — guards against NaN / negative / >1 from
  // upstream consensus edge cases (a bad confidence must never corrupt the
  // matrix; the app renders conviction as a percentage).
  const rawConfidence = psc?.confidence ?? 0;
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
  const rationale = psc?.rationale ?? psc?.entryThesis ?? 'No consensus reached this cycle.';

  // v2.0.870-P26: 卡片「24h」位改由本機蠟燭動量驅動(WS 清零 24h% 嘅趨勢盲修復)。
  // change24h/volume24h 保留(legacy 欄位);新欄位可選,舊卡/舊 UI 自動 fallback。
  const mom = marketState?.momentum;
  const marketData: AnalysisMarketData = {
    price: marketState?.price ?? 0,
    volatility: marketState?.volatility ?? 0,
    regime: marketState?.regime ?? 'unknown',
    change24h: marketState?.change24h ?? 0,
    volume24h: marketState?.volume24h ?? 0,
    ...(mom ? {
      momentum4h: mom.m4h ?? 0,
      momentum1h: mom.m1h ?? 0,
      momentum15m: mom.m15m ?? 0,
      volumeRatio5m: mom.volumeRatio ?? 0,
      volumeState: mom.volumeState ?? 'unknown',
      volume4hUsd: mom.vol4hNotionalUsd ?? 0,
    } : {}),
  };

  // Compute SL/TP prices from the consensus signal + entry price.
  // Uses the same computeSLTP logic as the trading engine for consistency.
  const entryPrice = marketData.price;
  const slPct = psc?.suggestedStopLoss ? undefined : 0.02; // default 2% if no suggestion
  const tpPct = psc?.suggestedTakeProfit ? undefined : 0.05; // default 5% if no suggestion
  const isBuy = rawAction === 'buy';
  const isSell = rawAction === 'sell';
  const stopLoss = (isBuy || isSell) && entryPrice > 0
    ? isBuy
      ? entryPrice * (1 - (psc?.suggestedStopLoss ? 0 : slPct ?? 0.02))
      : entryPrice * (1 + (psc?.suggestedStopLoss ? 0 : slPct ?? 0.02))
    : 0;
  const takeProfit = (isBuy || isSell) && entryPrice > 0
    ? isBuy
      ? entryPrice * (1 + (psc?.suggestedTakeProfit ? 0 : tpPct ?? 0.05))
      : entryPrice * (1 - (psc?.suggestedTakeProfit ? 0 : tpPct ?? 0.05))
    : 0;
  const suggestedLeverage = psc?.leverage ?? 1;

  const consensus: AnalysisConsensus = {
    action: rawAction,
    confidence,
    thesis: rationale,
    pwin,
    agentsAligned,
    agentsTotal,
    stopLoss: stopLoss > 0 ? Math.round(stopLoss * 100) / 100 : undefined,
    takeProfit: takeProfit > 0 ? Math.round(takeProfit * 100) / 100 : undefined,
    suggestedLeverage,
  };

  // v2.0.857: moderate-only matrix — pass the risk-neutral edge report.
  // v2.0.859: profileEdges/dcs parameters REMOVED (MiniLM edge-store + DCS
  // deleted — zero decision consumers since v2.0.857).
  const matrix = buildMatrix(rawAction, closePosition, confidence, rationale, edgeReport);

  // v2.0.870-attack: execution 參數必須 sanitise——垃圾輸入（string/array/
  // 非 boolean blocked/超長字段）唔可以寫入 metadata（持久化污染）。
  const safeExecution = sanitizeExecutionReport(execution);
  return {
    symbol,
    cycleId,
    updatedAt: Date.now(),
    marketData,
    consensus,
    matrix,
    metadata: safeExecution ? { execution: safeExecution } : {},
    edgeReport,
  };
}