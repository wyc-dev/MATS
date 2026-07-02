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
// v2.0.42: Import normalizeSymbol to ensure symbol casing matches portfolio storage.
// Without this, colon symbols (xyz:MU) get .toUpperCase() → XYZ:MU, but portfolio
// stores them as xyz:MU → hasPosition() fails → duplicate opens + false closes.
import { normalizeSymbol } from './portfolio.ts';

/** Default TradingDecision with safe fallback values */
export const DEFAULT_TRADING_DECISION: TradingDecision = {
  action: 'hold',
  symbol: 'BTCUSDT',
  positionSizePct: 0,
  rationale: 'Default rationale — required field missing from LLM output.',
  urgency: 'patient',
};

// ═══════════════════════════════════════════════════════════════
// v2.0.41: MAX_POSITION_PCT REMOVED — Market Agent controls position size.
//
// Position size is set by the user via the Market Agent UI slider and
// enforced deterministically by HACP Phase 4.5 (Market Agent Hard
// Constraints Override). LLM agents do NOT control position size — their
// positionSizePct output is always overridden.
//
// Therefore MAX_POSITION_PCT clamping is unnecessary and was removed.
// The only remaining size-related logic is:
//   1. normalizeDecision() clamps to [0, 1.0] (100% — sanity floor only)
//   2. HACP Phase 4.5 overrides to Market Agent's value
//   3. Risk Auditor can reduce size (choppy market 50% cut, loss streak
//      graduated reduction) but cannot increase it
//
// ⚠️ MAINTENANCE NOTE: If you add any new position size clamping logic,
// you MUST update this comment to reflect the new enforcement layer.
// The position size enforcement chain is: normalizeDecision (sanity) →
// Risk Auditor (can reduce) → Phase 4.5 (Market Agent override).
// ═══════════════════════════════════════════════════════════════

/**
 * Normalize a partial/raw TradingDecision from any agent (including meta-agent).
 *
 * - Fills in all required fields with safe defaults if missing
 * - Clamps positionSizePct to [0, 1.0] (sanity floor only — Market Agent
 *   controls the actual size via HACP Phase 4.5 override)
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

  // v2.0.42: Use normalizeSymbol for consistent symbol casing.
  // Colon-prefixed symbols (xyz:MU) preserve their original case —
  // normalizeSymbol keeps them as-is. Non-colon symbols (BTC) are
  // lowercased. This MUST match how positions are stored in the portfolio
  // (via normalizeSymbol), otherwise hasPosition() will fail to find
  // existing positions → duplicate opens + false closes.
  //
  // ⚠️ MAINTENANCE NOTE: If you change symbol normalization here, you MUST
  // also update normalizeSymbol() in portfolio.ts. The symbol normalization
  // chain is: normalizeDecision() here → normalizeSymbol() in portfolio.ts.
  // Both MUST produce the same result for the same input symbol.
  const symbol = normalizeSymbol(raw?.symbol ?? 'BTCUSDT');
  let positionSizePct = typeof raw?.positionSizePct === 'number' ? raw.positionSizePct : 0;

  // v2.0.41: Sanity clamp only — Market Agent controls actual size.
  // No MAX_POSITION_PCT cap. HACP Phase 4.5 will override to Market Agent's value.
  if (positionSizePct > 1.0) positionSizePct = 1.0; // 100% sanity floor
  if (positionSizePct < 0) positionSizePct = 0;

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
  rationale: 'Insufficient data — no directional signal from sub-agents, no RBC edge detected, no clear S/R levels. Cannot form a judgment without data.',
};

/** Normalize a raw PerSymbolDecision from LLM output */
export function normalizePerSymbolDecision(raw: Partial<PerSymbolDecision> | undefined | null, symbol: string): PerSymbolDecision {
  if (!raw) return { ...DEFAULT_PER_SYMBOL, symbol };
  const action = raw.action === 'buy' || raw.action === 'sell' || raw.action === 'hold' ? raw.action : 'hold';
  let positionSizePct = typeof raw.positionSizePct === 'number' ? raw.positionSizePct : 0;
  // v2.0.41: Sanity clamp only — Market Agent controls size via HACP Phase 4.5
  if (positionSizePct > 1.0) positionSizePct = 1.0;
  if (positionSizePct < 0) positionSizePct = 0;
  const leverage = typeof raw.leverage === 'number' ? Math.max(1, Math.min(10, raw.leverage)) : 1;
  // v2.0.28: Preserve pattern tag from per-symbol decision
  const patternTag = typeof raw.patternTag === 'string' && raw.patternTag.trim().length > 0
    ? raw.patternTag.trim().slice(0, 80)
    : undefined;
  // v2.0.79: Per-symbol confidence (0.0-1.0), clamped
  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : undefined;
  // v2.0.80: Forward entryThesis from LLM output (Meta-Agent only, but
  // normalizePerSymbolDecision is shared so it passes through for all agents).
  // Only set if it's a non-empty string. Truncate to 500 chars for sanity.
  const entryThesis = typeof raw.entryThesis === 'string' && raw.entryThesis.trim().length > 0
    ? raw.entryThesis.trim().slice(0, 500)
    : undefined;
  // v2.0.81: Forward holdReason — Meta-Agent's explanation for HOLD decisions.
  const holdReason = typeof raw.holdReason === 'string' && raw.holdReason.trim().length > 0
    ? raw.holdReason.trim().slice(0, 500)
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
    ...(confidence !== undefined ? { confidence } : {}),
    ...(entryThesis !== undefined ? { entryThesis } : {}),
    ...(holdReason !== undefined ? { holdReason } : {}),
  };
}

/** Normalize a complete MultiSymbolDecision */
export function normalizeMultiSymbolDecision(
  raw: Partial<MultiSymbolDecision> | undefined | null,
  marketSymbol: string,
  positionSymbols: string[],
): MultiSymbolDecision {
  const marketTicker = normalizePerSymbolDecision(raw?.marketTicker, normalizeSymbol(marketSymbol));
  const positions: PerSymbolDecision[] = positionSymbols.map(sym => {
    // v2.0.42: Use normalizeSymbol for case-insensitive comparison that
    // respects colon-prefixed symbols (xyz:MU vs XYZ:MU).
    const normSym = normalizeSymbol(sym);
    const found = (raw?.positions ?? []).find((p: any) => {
      if (!p?.symbol) return false;
      return normalizeSymbol(p.symbol) === normSym;
    });
    return normalizePerSymbolDecision(found, normSym);
  });
  return { marketTicker, positions };
}