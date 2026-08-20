// ─── EMR (v2.0.870-EMR): Exploration Market Rotation — pure selection logic ───
//
// Attack-hardened (v2.0.870-EMR-attack):
//   1. toHLSymbol — HL-compatible symbol (prefix lowercase, name uppercase).
//      `exploreTarget.toUpperCase()` would produce 'XYZ:SKHX' (prefix uppercased),
//      breaking HL case-sensitive lookups + OLR/pattern queries that key on
//      normalizeSymbol() output ('xyz:SKHX').
//   2. safeNum everywhere — `?? 0` does NOT catch NaN/Infinity; a NaN volume
//      would corrupt sort order, a NaN price would open a NaN-priced position.
//   3. filterValidMarkets — empty/whitespace/non-string markets are dropped
//      (normalizeSymbol('') = '' would select an empty symbol).
//   4. Pure functions — no this.*, fully unit-testable against state injection,
//      persistence pollution, and boundary inputs.

import { normalizeSymbol } from '../trading/portfolio.ts';
import { safeNum } from './evolution-utils.ts';

/** HL-compatible symbol: prefix lowercase, asset name uppercase (BTC, xyz:SKHX). */
export function toHLSymbol(sym: string): string {
  const norm = normalizeSymbol(sym).trim();
  if (norm.includes(':')) {
    const idx = norm.indexOf(':');
    return norm.slice(0, idx + 1) + norm.slice(idx + 1).toUpperCase();
  }
  return norm.toUpperCase();
}

/** Drop empty/whitespace/non-string markets, normalize to HL-compatible form. */
export function filterValidMarkets(markets: readonly (string | null | undefined)[]): string[] {
  return markets
    .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    .map((m) => toHLSymbol(m));
}

/**
 * Select the exploration target: the highest-volume user-selected market
 * (activeSymbol + tradingMarkets) that currently has NO open position.
 * Returns null when every selected market has a position.
 *
 * Volume is safeNum'd — NaN/Infinity/negative volumes cannot corrupt sort.
 * Candidates are deduped and invalid symbols dropped.
 */
export function selectExplorationTargetPure(
  activeSymbol: string,
  tradingMarkets: readonly (string | null | undefined)[],
  hasPosition: (sym: string) => boolean,
  volumeBySymbol: ReadonlyMap<string, number>,
): string | null {
  const candidates = [...new Set([
    toHLSymbol(activeSymbol),
    ...filterValidMarkets(tradingMarkets),
  ])].filter((s) => s.length > 0);
  const open = candidates.filter((sym) => !hasPosition(sym));
  if (open.length === 0) return null;
  open.sort((a, b) => safeNum(volumeBySymbol.get(normalizeSymbol(b)), 0) - safeNum(volumeBySymbol.get(normalizeSymbol(a)), 0));
  return open[0]!;
}
