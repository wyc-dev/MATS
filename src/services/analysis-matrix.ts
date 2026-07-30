// ─── Analysis Matrix Builder ────────────────────────────────────────────
//
// v2.0.822: Expands a per-asset HACP consensus decision into a 3×3
// recommendation matrix indexed by (risk profile × position state).
//
//   • moderate    = the LIVE consensus mechanism (conviction gate, OLR blend,
//                   combo WR override). This is the calibrated baseline.
//   • aggressive = placeholder — same action as moderate, conviction scaled
//                   ×1.3 (capped 1.0), `calibrated: false` until the owner
//                   defines the exact rules.
//   • conservative = placeholder — same action as moderate, conviction scaled
//                   ×0.7, `calibrated: false` until the owner defines the rules.
//
// The owner will supply the aggressive/conservative calibration separately;
// this module is structured so those rules drop into `buildProfileCell()`
// without touching the consensus-mapping logic.

import type {
  AssetAnalysis,
  AnalysisConsensus,
  AnalysisMarketData,
  AnalysisMatrix,
  MatrixCell,
  PositionState,
  RiskProfile,
  EdgeReport,
} from '../types/index.ts';
import type { PerSymbolConsensus } from '../types/index.ts';
import type { AggregatedMarketState } from '../data/binance-websocket.ts';

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

/** Build a single matrix cell for a (profile, positionState) combination.
 *  `baseAction`/`baseConviction` come from the moderate consensus mapping;
 *  the profile scales conviction and flags calibration. The optional `edge`
 *  carries the risk-profile-conditional edge report for this cell. */
function buildProfileCell(
  profile: RiskProfile,
  baseAction: MatrixCell['action'],
  baseConviction: number,
  rationale: string,
  edge?: EdgeReport,
): MatrixCell {
  switch (profile) {
    case 'moderate':
      return { action: baseAction, conviction: baseConviction, rationale, calibrated: true, edge };
    case 'aggressive':
      // Placeholder: amplify conviction, more likely to act. Owner refines.
      return {
        action: baseAction,
        conviction: Math.min(1.0, baseConviction * 1.3),
        rationale,
        calibrated: false,
        edge,
      };
    case 'conservative':
      // Placeholder: dampen conviction, more cautious. Owner refines.
      return {
        action: baseAction,
        conviction: Math.max(0, baseConviction * 0.7),
        rationale,
        calibrated: false,
        edge,
      };
  }
}

/** Build the full 3×3 matrix for one asset from its per-symbol consensus.
 *  `profileEdges` (optional) carries per-profile conditional edge reports —
 *  one EdgeReport per risk profile, applied uniformly to all three position
 *  states of that profile (edge is a property of the signal, not the
 *  existing position). If a profile's edge recommendation is 'skip', the
 *  cell action is forced to 'hold' so the client never acts on a no-edge
 *  signal. */
function buildMatrix(
  rawAction: string,
  closePosition: boolean,
  confidence: number,
  rationale: string,
  profileEdges?: Partial<Record<RiskProfile, EdgeReport>>,
): AnalysisMatrix {
  const profiles: RiskProfile[] = ['aggressive', 'moderate', 'conservative'];
  const states: PositionState[] = ['long', 'short', 'flat'];
  const matrix = {} as AnalysisMatrix;
  for (const profile of profiles) {
    const edge = profileEdges?.[profile];
    matrix[profile] = {} as Record<PositionState, MatrixCell>;
    for (const state of states) {
      let action = mapAction(rawAction, closePosition, state);
      // v2.0.833: a 'skip' recommendation forces the cell to 'hold' — the
      // backend has no edge for this (profile, symbol, regime) and the
      // client must not act on it. This is the ONLY place edge can mute a
      // signal; it never fabricates a new action.
      if (edge?.recommendation === 'skip') action = 'hold';
      matrix[profile][state] = buildProfileCell(profile, action, confidence, rationale, edge);
    }
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
  profileEdges?: Partial<Record<RiskProfile, EdgeReport>>,
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

  const marketData: AnalysisMarketData = {
    price: marketState?.price ?? 0,
    volatility: marketState?.volatility ?? 0,
    regime: marketState?.regime ?? 'unknown',
    change24h: marketState?.change24h ?? 0,
    volume24h: marketState?.volume24h ?? 0,
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

  const matrix = buildMatrix(rawAction, closePosition, confidence, rationale, profileEdges);

  return {
    symbol,
    cycleId,
    updatedAt: Date.now(),
    marketData,
    consensus,
    matrix,
    metadata: {},
    edgeReport,
  };
}