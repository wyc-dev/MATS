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
// v2.0.836: aggressive/conservative now use DCS v2 continuous scoring from
// Q-RL Alpha Discovery to differentiate conviction, SL/TP, and position size.
// moderate remains the calibrated baseline (DCS never affects it).
// See plan-task3-4.md for the full design.

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
import { dcsConvictionFactor } from '../edge/dcs-calculator.ts';

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
 *  v2.0.836: Uses DCS v2 continuous scoring for aggressive/conservative.
 *  Moderate is the standard baseline — DCS never affects it.
 *
 *  DCS × Profile decision matrix:
 *  - Moderate: action + conviction unchanged (standard)
 *  - Aggressive: conviction × (1.0 + 0.15 × DCS²) [1.0, 1.15] — quadratic boost
 *  - Conservative: DCS ≥ 0.55 → honest conviction ×1.0; DCS 0.3–0.55 → extremely
 *    low conviction (threshold ×1.15 blocks most, but not a hard HOLD);
 *    DCS < 0.3 → hard HOLD; Edge Report skip → hard HOLD for all profiles */
function buildProfileCell(
  profile: RiskProfile,
  baseAction: MatrixCell['action'],
  baseConviction: number,
  rationale: string,
  edge?: EdgeReport,
  dcs: number = 0,
): MatrixCell {
  // v2.0.836 security: clamp DCS to [0, 1] — same fix as dcs-calculator.ts.
  // Without this, negative DCS boosts Aggressive (D1 bug) and DCS > 1
  // produces out-of-range multipliers (D2 bug).
  const safeDcs = Number.isFinite(dcs) ? Math.max(0, Math.min(1, dcs)) : 0;

  // Edge Report skip → hard hold for ALL profiles
  if (edge?.recommendation === 'skip') {
    return { action: 'hold', conviction: 0, rationale: 'Edge Report: skip', calibrated: false, edge, dcs: safeDcs };
  }

  // Moderate = standard, never affected by DCS
  if (profile === 'moderate') {
    return { action: baseAction, conviction: baseConviction, rationale, calibrated: true, edge, dcs: 0 };
  }

  // Aggressive: DCS > 0 → accept, conviction continuous boost (quadratic)
  if (profile === 'aggressive') {
    const factor = 1.0 + 0.15 * safeDcs * safeDcs; // [1.0, 1.15], quadratic
    return {
      action: baseAction,
      conviction: Math.min(1.0, baseConviction * factor),
      rationale: safeDcs > 0.01
        ? `${rationale} [Aggr DCS=${safeDcs.toFixed(2)} ×${factor.toFixed(3)}]`
        : rationale,
      calibrated: safeDcs >= 0.55,
      edge,
      dcs: safeDcs,
    };
  }

  // Conservative: DCS ≥ 0.55 → honest; DCS 0.3–0.55 → extremely low; DCS < 0.3 → HOLD
  if (profile === 'conservative') {
    if (safeDcs < 0.3) {
      // Hard HOLD — DCS too low
      return {
        action: 'hold',
        conviction: 0,
        rationale: `Conservative: DCS=${safeDcs.toFixed(2)} < 0.3`,
        calibrated: false,
        edge,
        dcs: safeDcs,
      };
    }
    if (safeDcs >= 0.55) {
      // Honest conviction — DCS is high enough, triple protection is sufficient
      return {
        action: baseAction,
        conviction: baseConviction, // ×1.0 honest
        rationale: `${rationale} [Cons DCS=${safeDcs.toFixed(2)} honest]`,
        calibrated: true,
        edge,
        dcs: safeDcs,
      };
    }
    // DCS 0.3–0.55: extremely low conviction (threshold ×1.15 will block most)
    const factor = 0.3 * (safeDcs - 0.3) / 0.25; // [0, 0.3]
    return {
      action: baseAction,
      conviction: baseConviction * factor,
      rationale: `${rationale} [Cons DCS=${safeDcs.toFixed(2)} ×${factor.toFixed(3)} gate]`,
      calibrated: false,
      edge,
      dcs: safeDcs,
    };
  }

  // Fallback (should not reach — RiskProfile has only 3 values)
  return { action: baseAction, conviction: baseConviction, rationale, calibrated: false, edge, dcs: safeDcs };
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
  dcs: number = 0,
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
      matrix[profile][state] = buildProfileCell(profile, action, confidence, rationale, edge, dcs);
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
  dcs: number = 0,
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

  const matrix = buildMatrix(rawAction, closePosition, confidence, rationale, profileEdges, dcs);

  return {
    symbol,
    cycleId,
    updatedAt: Date.now(),
    marketData,
    consensus,
    matrix,
    metadata: {},
    edgeReport,
    dcs,
  };
}