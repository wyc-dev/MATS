// ─── Trading Decision Utilities ───
// Centralized defaulting layer for TradingDecision.
//
// LLM agents sometimes omit required fields (symbol, action, etc.).
// Instead of patching crashes one-by-one with `?? 'BTCUSDT'` scattered
// across the codebase, this single function ensures every TradingDecision
// that enters the system has ALL required fields filled with safe defaults.
//
// Meta-agent retains full creative freedom:
// - Core TradingDecision fields are normalized (never crash)
// - Any extra fields (strategyModifications, regimeWeights, etc.)
//   are PRESERVED and passed through unchanged

import type { TradingDecision, PerSymbolDecision, MultiSymbolDecision } from '../types/index.ts';

/** Default TradingDecision with safe fallback values */
export const DEFAULT_TRADING_DECISION: TradingDecision = {
  action: 'hold',
  symbol: 'BTCUSDT',
  positionSizePct: 0,
  rationale: 'Default rationale — required field missing from LLM output.',
  urgency: 'patient',
};

/** Hard cap — LLM sometimes outputs 200%+. Aligned with Risk Auditor and Risk Engine config. */
export const MAX_POSITION_PCT = 0.20;

/**
 * Normalize a partial/raw TradingDecision from any agent (including meta-agent).
 *
 * - Fills in all required fields with safe defaults if missing
 * - Clamps positionSizePct to [0, 20%]
 * - Preserves ALL extra keys (meta-agent can attach arbitrary strategy data)
 *
 * @param raw - Raw decision from LLM (may be partial, undefined, or contain extra keys)
 * @returns A complete, safe TradingDecision with extra keys preserved
 */
export function normalizeDecision(raw: Partial<TradingDecision> | undefined | null): TradingDecision {
  const action = raw?.action;
  const validatedAction: TradingDecision['action'] =
    action === 'buy' || action === 'sell' || action === 'hold'
      ? action
      : 'hold';

  const urgency = raw?.urgency;
  const validatedUrgency: TradingDecision['urgency'] =
    urgency === 'immediate' || urgency === 'soon' || urgency === 'patient'
      ? urgency
      : 'patient';

  const symbol = (raw?.symbol ?? 'BTCUSDT').toUpperCase();
  let positionSizePct = typeof raw?.positionSizePct === 'number' ? raw.positionSizePct : 0;

  // Clamp: no negative, no > MAX_POSITION_PCT
  if (positionSizePct > MAX_POSITION_PCT) {
    positionSizePct = MAX_POSITION_PCT;
  }
  if (positionSizePct < 0) {
    positionSizePct = 0;
  }

  const rationale = raw?.rationale || 'No rationale provided.';
  const entryPrice = raw?.entryPrice;
  const stopLossPct = raw?.stopLossPct;
  const takeProfitPct = raw?.takeProfitPct;
  const leverage = typeof raw?.leverage === 'number' ? Math.max(1, Math.min(10, raw.leverage)) : 1;

  // v2.0.28: Preserve LLM-identified pattern tag if provided
  const patternTag = typeof raw?.patternTag === 'string' && raw.patternTag.trim().length > 0
    ? raw.patternTag.trim().slice(0, 80) // cap length to prevent abuse
    : undefined;

  return {
    action: validatedAction,
    symbol,
    positionSizePct,
    leverage,
    rationale,
    urgency: validatedUrgency,
    ...(entryPrice !== undefined ? { entryPrice } : {}),
    ...(stopLossPct !== undefined ? { stopLossPct } : {}),
    ...(takeProfitPct !== undefined ? { takeProfitPct } : {}),
    ...(patternTag !== undefined ? { patternTag } : {}),
  } as TradingDecision;
}

/**
 * Check if a decision is effectively "do nothing" (HOLD with no position).
 */
export function isHoldDecision(decision: TradingDecision): boolean {
  return decision.action === 'hold' || decision.positionSizePct <= 0;
}

/**
 * Get human-readable summary of a decision for logging.
 */
export function summarizeDecision(decision: TradingDecision): string {
  const size = (decision.positionSizePct * 100).toFixed(1);
  return `${decision.action.toUpperCase()} ${decision.symbol} ${size}% — ${decision.rationale.slice(0, 60)}`;
}

// ─── Multi-Symbol Decision Utilities (v1.9.2) ───

const DEFAULT_PER_SYMBOL: PerSymbolDecision = {
  symbol: 'BTCUSDT',
  action: 'hold',
  positionSizePct: 0,
  leverage: 1,
  closePosition: false,
  rationale: 'Default per-symbol fallback.',
};

/** Normalize a raw PerSymbolDecision from LLM output */
export function normalizePerSymbolDecision(raw: Partial<PerSymbolDecision> | undefined | null, symbol: string): PerSymbolDecision {
  if (!raw) return { ...DEFAULT_PER_SYMBOL, symbol };
  const action = raw.action === 'buy' || raw.action === 'sell' || raw.action === 'hold' ? raw.action : 'hold';
  let positionSizePct = typeof raw.positionSizePct === 'number' ? raw.positionSizePct : 0;
  if (positionSizePct > MAX_POSITION_PCT) positionSizePct = MAX_POSITION_PCT;
  if (positionSizePct < 0) positionSizePct = 0;
  const leverage = typeof raw.leverage === 'number' ? Math.max(1, Math.min(10, raw.leverage)) : 1;
  // v2.0.28: Preserve pattern tag from per-symbol decision
  const patternTag = typeof raw.patternTag === 'string' && raw.patternTag.trim().length > 0
    ? raw.patternTag.trim().slice(0, 80)
    : undefined;
  return {
    symbol,
    action,
    positionSizePct,
    leverage,
    closePosition: raw.closePosition === true,
    closeUrgency: raw.closeUrgency === 'immediate' || raw.closeUrgency === 'soon' ? raw.closeUrgency : undefined,
    suggestedStopLoss: typeof raw.suggestedStopLoss === 'number' ? raw.suggestedStopLoss : undefined,
    suggestedTakeProfit: typeof raw.suggestedTakeProfit === 'number' ? raw.suggestedTakeProfit : undefined,
    rationale: raw.rationale || 'No rationale provided.',
    ...(patternTag !== undefined ? { patternTag } : {}),
  };
}

/** Normalize a complete MultiSymbolDecision */
export function normalizeMultiSymbolDecision(
  raw: Partial<MultiSymbolDecision> | undefined | null,
  marketSymbol: string,
  positionSymbols: string[],
): MultiSymbolDecision {
  const marketTicker = normalizePerSymbolDecision(raw?.marketTicker, marketSymbol);
  const positions: PerSymbolDecision[] = positionSymbols.map(sym => {
    const found = (raw?.positions ?? []).find((p: any) => p?.symbol?.toUpperCase() === sym.toUpperCase());
    return normalizePerSymbolDecision(found, sym);
  });
  return { marketTicker, positions };
}