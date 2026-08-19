// ─── Learning weight for close-context-aware learning (v2.0.226 / v2.0.211) ───
//
// Pure function: given how a position was closed + whether it was profitable,
// return the weight multiplier [0.3, 1.0] applied when feeding the outcome
// into the learning systems (OLR, AttnRes, NA engine).
//
// v2.0.211 fix: system-decision closes (thesis_invalidation, manual, consensus)
// are discounted REGARDLESS of profitability. Previously `if (isWin) return 1.0`
// ran first, so a profitable system force-close (e.g. a $1.95 thesis_invalidation
// close) was learned at full weight 1.0 — as if the market had cleanly confirmed
// the entry thesis via SL/TP. But a system force-close is NOT a clean market
// signal: the position was not taken to SL/TP by the market, so the PnL is
// partial/noisy information. The 0.3/0.5 discount now applies to profitable
// system closes too, so the learning systems don't over-trust them.
//
// Clean market closes (sl_tp / reconciliation / exchange_closed) keep the
// original semantics: wins → 1.0, losses → 1.0 (or 0.3 if SL was narrowed,
// since that is an execution loss, not an entry loss).

export function computeLearningWeight(
  closeReason: string,
  slNarrowed: boolean,
  isWin: boolean,
): number {
  // v2.0.211: System-decision closes are discounted REGARDLESS of profitability.
  // A profit from a system force-close (LLM judged thesis broke, agent consensus,
  // or user manual close) is NOT a clean market-risk signal — the position was
  // not taken to SL/TP by the market, so the PnL is partial/noisy information.
  // This must run BEFORE the `isWin` short-circuit below, otherwise profitable
  // thesis_invalidation closes get full weight 1.0 and the v2.0.226 0.3 discount
  // never applies (the original bug: `if (isWin) return 1.0` ran first).
  switch (closeReason) {
    case 'reversal_point':
      // v2.0.870-P78-E1: reversal-point structure exit——即時結構判斷反轉
      // （ATH/ATL 回落 + 蠟燭形態），系統決策，唔係純市場風險訊號 → 0.3
      return 0.3;
    case 'consensus_reversal':
      // v2.0.870-P47: 共識反轉離場——系統判斷趨勢反轉,同 thesis_invalidation
      // 一樣係「系統判斷」,唔係純市場風險訊號 → 0.3
      return 0.3;
    case 'thesis_invalidation':
      // System LLM decision — not a pure market-risk outcome. Discount to 0.3
      // whether profitable or not (consistent with v2.0.139 conviction-gate
      // exclusion of thesis_invalidation from winRate).
      return 0.3;
    case 'manual':
      // User decision — partial market signal. The user may have closed
      // for risk management, inside knowledge, or emotional reasons.
      // Discount to 0.5 regardless of outcome.
      return 0.5;
    case 'consensus':
      // Agent consensus close — system vote, not a clean market trigger.
      return 0.5;
    case 'exit_price_lock':
      // v2.0.862: data-driven lock-profit close — the PAEL MFE extension check
      // fired (price reached the asset's typical favourable zone). The market
      // DID confirm the direction (profit existed), but the exit was a system
      // decision at p75×0.8, not a natural TP trigger — treat as a system
      // decision (0.5), never full weight. Also never a loss (the gate only
      // fires when profit > 0), so this branch is defensive.
      return 0.5;
    case 'regime_reversal_lock':
      // v2.0.869-P15: regime-reversal lock-profit close — system decision at
      // the regime-flip sweet spot (MFE ≥ 1.5×ATR AND P(win) < 0.5). The market
      // DID confirm the direction (profit existed), but the exit was a system
      // decision — treat as 0.5, never full weight.
      return 0.5;
  }
  // Wins from clean market closes (sl_tp / reconciliation / exchange_closed)
  // always get full weight — the market confirmed the entry thesis, and that
  // positive signal should not be discounted.
  if (isWin) return 1.0;
  // Losses: weight depends on whether the loss was caused by the market
  // (real signal) or by execution decisions (contaminated signal).
  switch (closeReason) {
    case 'sl_tp':
      if (slNarrowed) {
        // SL was narrowed post-entry (trailing stop, MFE giveback, TP
        // narrowing) and then hit. This is an EXECUTION loss, not an ENTRY
        // loss — the entry may have been fine, but the SL was tightened
        // to within normal volatility noise. Discount to 0.3 so the
        // learning systems don't learn "these market conditions → loss"
        // from what was really "SL too tight → loss".
        return 0.3;
      }
      // SL hit at the ORIGINAL (wide) SL — genuine market loss. The price
      // moved against the thesis by the full SL distance. Full weight.
      return 1.0;
    case 'reconciliation':
    case 'exchange_closed':
      // Exchange-side event (liquidation, delisting, etc.) — full market
      // signal. These are extreme market events.
      return 1.0;
    default:
      return 1.0;
  }
}