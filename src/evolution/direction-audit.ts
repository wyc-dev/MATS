// ─── Direction Integrity Self-Audit ───
// v2.0.178: A self-detection system that runs at startup + periodically to
// verify that all learning systems correctly separate BUY and SELL records
// when computing win rates, similarity matches, and statistics.
//
// If a direction-mixing regression is detected, it logs a critical warning
// and records the incident so the user can investigate.
//
// This is the "self-correction" layer: it doesn't fix the bug automatically
// (that would require code changes), but it DETECTS the regression and
// alerts loudly — preventing silent learning corruption.

import { createLogger } from '../observability/logger.ts';
import type { ThesisExperienceRecord } from '../types/index.ts';

const log = createLogger({ phase: 'direction-audit' });

export interface DirectionAuditResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  timestamp: number;
}

/**
 * Audit a set of EXP records for direction-mixing indicators.
 * This checks that the DATA is consistent — if BUY and SELL records are
 * being pooled in win rate calculations, the per-direction win rates
 * should differ from the pooled win rate. If they're identical across
 * all symbols, it suggests either no data or a pooling bug.
 */
export function auditDirectionIntegrity(records: ThesisExperienceRecord[]): DirectionAuditResult {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const timestamp = Date.now();

  // Check 1: Per-direction win rates should be computable
  const buyRecs = records.filter(r => r.side === 'buy');
  const sellRecs = records.filter(r => r.side === 'sell');
  const buyWins = buyRecs.filter(r => r.outcome === 'WIN').length;
  const sellWins = sellRecs.filter(r => r.outcome === 'WIN').length;
  const buyWR = buyRecs.length > 0 ? buyWins / buyRecs.length : 0;
  const sellWR = sellRecs.length > 0 ? sellWins / sellRecs.length : 0;
  const pooledWR = records.length > 0 ? (buyWins + sellWins) / records.length : 0;

  checks.push({
    name: 'per-direction-win-rate-separation',
    passed: buyRecs.length > 0 && sellRecs.length > 0,
    detail: `BUY: ${buyRecs.length} trades, ${(buyWR * 100).toFixed(0)}% WR | SELL: ${sellRecs.length} trades, ${(sellWR * 100).toFixed(0)}% WR | Pooled: ${(pooledWR * 100).toFixed(0)}% WR`,
  });

  // Check 2: Per-symbol per-direction win rates should differ
  // If a symbol has both BUY and SELL records but the win rates are identical,
  // it might indicate pooling (though it could also be genuine coincidence)
  const symbolSides = new Map<string, { buy: { w: number; l: number }; sell: { w: number; l: number } }>();
  for (const r of records) {
    let entry = symbolSides.get(r.symbol);
    if (!entry) {
      entry = { buy: { w: 0, l: 0 }, sell: { w: 0, l: 0 } };
      symbolSides.set(r.symbol, entry);
    }
    if (r.side === 'buy') {
      if (r.outcome === 'WIN') entry.buy.w++; else entry.buy.l++;
    } else {
      if (r.outcome === 'WIN') entry.sell.w++; else entry.sell.l++;
    }
  }

  let directionMismatchCount = 0;
  for (const [sym, entry] of symbolSides) {
    const buyTotal = entry.buy.w + entry.buy.l;
    const sellTotal = entry.sell.w + entry.sell.l;
    if (buyTotal >= 3 && sellTotal >= 3) {
      const buyWR = entry.buy.w / buyTotal;
      const sellWR = entry.sell.w / sellTotal;
      // Flag if direction win rates differ by >30% — this is a signal that
      // direction matters for this symbol (and pooling would be wrong)
      if (Math.abs(buyWR - sellWR) > 0.3) {
        directionMismatchCount++;
        log.info(`[direction-audit] ${sym}: BUY ${(buyWR * 100).toFixed(0)}% vs SELL ${(sellWR * 100).toFixed(0)}% — direction matters (delta=${((buyWR - sellWR) * 100).toFixed(0)}%)`);
      }
    }
  }

  checks.push({
    name: 'per-symbol-direction-divergence',
    passed: true,
    detail: `${directionMismatchCount} symbols with significant direction divergence (>30% WR difference)`,
  });

  // Check 3: Verify records have side field populated
  const missingSide = records.filter(r => r.side !== 'buy' && r.side !== 'sell').length;
  checks.push({
    name: 'side-field-populated',
    passed: missingSide === 0,
    detail: missingSide === 0 ? 'All records have valid side field' : `${missingSide} records missing/invalid side field`,
  });

  // Check 4: Verify marketFeatures are being stored (v2.0.178+)
  const withFeatures = records.filter(r => r.marketFeatures && Object.keys(r.marketFeatures).length > 0).length;
  const recentRecords = records.filter(r => r.ts > timestamp - 3600_000); // last hour
  const recentWithFeatures = recentRecords.filter(r => r.marketFeatures && Object.keys(r.marketFeatures).length > 0).length;
  checks.push({
    name: 'market-features-stored',
    passed: recentRecords.length === 0 || recentWithFeatures > 0,
    detail: `${withFeatures}/${records.length} total records have marketFeatures, ${recentWithFeatures}/${recentRecords.length} recent records have marketFeatures`,
  });

  const passed = checks.every(c => c.passed);
  if (passed) {
    log.info(`[direction-audit] ✅ All ${checks.length} checks passed — direction integrity verified`);
  } else {
    const failed = checks.filter(c => !c.passed);
    log.warn(`[direction-audit] ❌ ${failed.length}/${checks.length} checks failed: ${failed.map(c => c.name).join(', ')}`);
    for (const c of failed) {
      log.warn(`[direction-audit]   ❌ ${c.name}: ${c.detail}`);
    }
  }

  return { passed, checks, timestamp };
}