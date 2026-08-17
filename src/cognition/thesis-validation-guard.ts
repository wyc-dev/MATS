/**
 * v2.0.869-P6: Thesis validation pre-check guard — extracted to a PURE function
 * for unit-testability. This is the v2.0.782 pre-check that runs BEFORE the
 * Skeptics LLM call, deciding whether an open position's entry thesis may be
 * re-validated (and potentially force-closed via thesis_invalidation).
 *
 * The guard enforces three capital-preservation invariants:
 *   1. PROFITABLE positions are NEVER force-closed (thesis is working).
 *   2. Positions with < 0.5% adverse move are NEVER force-closed (untested).
 *   3. Positions held < 30 min are NEVER force-closed (premature exit).
 *
 * EXCEPTION (v2.0.832): if the market structure has confirmed the thesis is
 * broken (SL hit), ALL guards are bypassed — holding is riskier than closing.
 *
 * Pure function: no I/O, no logging, no Date.now() unless `now` is omitted.
 * Deterministic and trivially unit-testable.
 */

export type ThesisValidationVerdict =
  | { allow: true; reason: 'structure_confirmed' | 'passed' }
  | { allow: false; reason: 'profitable' | 'minor_loss' | 'hold_time' };

export interface ThesisValidationInput {
  side: 'buy' | 'sell';
  currentPrice: number;
  stopLossPrice?: number;
  unrealizedPnlPct: number;
  openedAt?: number;
}

export function shouldAllowThesisValidation(
  position: ThesisValidationInput,
  now: number = Date.now(),
): ThesisValidationVerdict {
  // v2.0.869-P7: null/undefined position → conservative hold_time block (never crash).
  // Defense-in-depth: the caller (hacp.ts) already guards `if (!position) return true`,
  // but a future caller must never be able to crash the guard with a null position.
  if (!position || typeof position !== 'object') {
    return { allow: false, reason: 'hold_time' };
  }
  // v2.0.869-P6: sanitize NaN/Infinity pnlPct → 0 (flat). A corrupt pnlPct must
  // never bypass the guards (NaN < -0.005 is false → would pass as "significant
  // loss" and allow a premature close of a position with unknown PnL).
  const pnlPct = Number.isFinite(position.unrealizedPnlPct) ? position.unrealizedPnlPct : 0;
  const isProfitable = pnlPct > 0;
  const isSignificantLoss = pnlPct < -0.005; // >0.5% loss

  // v2.0.832: STRUCTURAL CONFIRMATION — SL hit bypasses ALL guards. The market
  // itself has confirmed the thesis is broken; holding is riskier than closing.
  // v2.0.869-P7: sanitize currentPrice/stopLossPrice to FINITE positive values.
  // Infinity/NaN SL or price must NEVER trigger structure_confirmed (Infinity
  // currentPrice <= Infinity SL is always true → would bypass all guards and
  // force-close a profitable position).
  const currentPrice = Number.isFinite(position.currentPrice) && position.currentPrice > 0 ? position.currentPrice : 0;
  const slPriceRaw = position.stopLossPrice ?? 0;
  const slPrice = Number.isFinite(slPriceRaw) && slPriceRaw > 0 ? slPriceRaw : 0;
  if (slPrice > 0 && currentPrice > 0) {
    if (position.side === 'buy' && currentPrice <= slPrice) {
      return { allow: true, reason: 'structure_confirmed' };
    }
    if (position.side === 'sell' && currentPrice >= slPrice) {
      return { allow: true, reason: 'structure_confirmed' };
    }
  }

  // v2.0.782: PROFITABLE — never force-close a winner. The thesis is WORKING.
  if (isProfitable) {
    return { allow: false, reason: 'profitable' };
  }

  // v2.0.782: MINOR LOSS / SIDEWAYS — thesis not yet tested. Only allow
  // invalidation when price has moved against the position by ≥ 0.5%.
  if (!isSignificantLoss) {
    return { allow: false, reason: 'minor_loss' };
  }

  // v2.0.782: MINIMUM HOLD TIME — < 30 min never force-closed. Unknown hold
  // time (openedAt missing/0/negative) → assume < 30 min (conservative).
  const holdTimeMinutes =
    position.openedAt && position.openedAt > 0 ? (now - position.openedAt) / 60000 : 0;
  if (holdTimeMinutes < 30) {
    return { allow: false, reason: 'hold_time' };
  }

  return { allow: true, reason: 'passed' };
}
