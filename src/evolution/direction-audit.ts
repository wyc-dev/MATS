// ─── Trade Record Integrity Self-Audit ───
// v2.0.179: Suspicious trade record detection — runs every 2 cycles.
// Examines EVERY trade record for patterns that indicate learning system
// corruption or missed signals.
//
// Detection categories:
//   1. Direction losing streaks — same symbol+side losing N times consecutively
//   2. Direction win rate divergence — BUY 67% vs SELL 14% for same symbol
//   3. Missing market conditions — recent records without marketFeatures
//   4. PnL/outcome inconsistency — pnl>0 but outcome=LOSS or vice versa
//   5. Premature SL pattern — hold time ≤2min + loss (SL too tight)
//   6. MFE giveback — MFE >> final PnL (exit timing problem)
//   7. Fusion data missing — olrPWinAtEntry/shadowWinRateAtEntry undefined
//   8. Side field validation — records with invalid side field

import { createLogger } from '../observability/logger.ts';
import type { ThesisExperienceRecord } from '../types/index.ts';

const log = createLogger({ phase: 'trade-audit' });

export interface AuditIncident {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  symbol: string;
  detail: string;
  records?: string[];
}

export interface AuditResult {
  incidents: AuditIncident[];
  summary: string;
  timestamp: number;
}

export function auditTradeRecords(records: ThesisExperienceRecord[]): AuditResult {
  const incidents: AuditIncident[] = [];
  const timestamp = Date.now();

  if (records.length === 0) {
    return { incidents, summary: 'No records to audit', timestamp };
  }

  const sorted = [...records].sort((a, b) => a.ts - b.ts);

  // ── 1. Direction losing streaks ──
  const streakMap = new Map<string, ThesisExperienceRecord[]>();
  for (const r of sorted) {
    const key = `${r.symbol}_${r.side}`;
    let arr = streakMap.get(key);
    if (!arr) { arr = []; streakMap.set(key, arr); }
    arr.push(r);
  }
  for (const [key, recs] of streakMap) {
    let currentStreak = 0;
    let maxStreak = 0;
    let streakStart = 0;
    let worstStreakStart = 0;
    for (let i = 0; i < recs.length; i++) {
      if (recs[i]!.outcome === 'LOSS') {
        if (currentStreak === 0) streakStart = i;
        currentStreak++;
        if (currentStreak > maxStreak) { maxStreak = currentStreak; worstStreakStart = streakStart; }
      } else { currentStreak = 0; }
    }
    if (maxStreak >= 2) {
      const [sym, side] = key.split('_');
      const wins = recs.filter(r => r.outcome === 'WIN').length;
      const losses = recs.filter(r => r.outcome === 'LOSS').length;
      const streakRecs = recs.slice(worstStreakStart, worstStreakStart + maxStreak);
      const severity = maxStreak >= 4 ? 'critical' : maxStreak >= 3 ? 'warning' : 'info';
      incidents.push({
        severity, category: 'direction-losing-streak', symbol: sym ?? '?',
        detail: `${side?.toUpperCase()} ${sym} — ${maxStreak} consecutive losses (${wins}W/${losses}L total). Streak: ${streakRecs.map(r => `$${r.pnl.toFixed(2)}`).join(', ')}`,
        records: streakRecs.map(r => r.id),
      });
    }
  }

  // ── 2. Direction win rate divergence ──
  const symbolDirStats = new Map<string, { buy: { w: number; l: number }; sell: { w: number; l: number } }>();
  for (const r of sorted) {
    let entry = symbolDirStats.get(r.symbol);
    if (!entry) { entry = { buy: { w: 0, l: 0 }, sell: { w: 0, l: 0 } }; symbolDirStats.set(r.symbol, entry); }
    if (r.side === 'buy') { if (r.outcome === 'WIN') entry.buy.w++; else entry.buy.l++; }
    else { if (r.outcome === 'WIN') entry.sell.w++; else entry.sell.l++; }
  }
  for (const [sym, stats] of symbolDirStats) {
    const buyTotal = stats.buy.w + stats.buy.l;
    const sellTotal = stats.sell.w + stats.sell.l;
    if (buyTotal >= 2 && sellTotal >= 2) {
      const buyWR = stats.buy.w / buyTotal;
      const sellWR = stats.sell.w / sellTotal;
      const divergence = Math.abs(buyWR - sellWR);
      if (divergence >= 0.3) {
        const betterSide = buyWR > sellWR ? 'BUY' : 'SELL';
        const worseSide = buyWR > sellWR ? 'SELL' : 'BUY';
        const severity = divergence >= 0.5 ? 'critical' : 'warning';
        incidents.push({
          severity, category: 'direction-win-rate-divergence', symbol: sym,
          detail: `${sym}: ${betterSide} ${(Math.max(buyWR, sellWR) * 100).toFixed(0)}% vs ${worseSide} ${(Math.min(buyWR, sellWR) * 100).toFixed(0)}% — ${divergence >= 0.5 ? 'EXTREME' : 'significant'} divergence. System should prefer ${betterSide}.`,
        });
      }
    }
  }

  // ── 3. Missing market conditions (recent only) ──
  const recentMissing = sorted.filter(r =>
    r.ts > timestamp - 3600_000 &&
    (!r.marketFeatures || Object.keys(r.marketFeatures).length === 0)
  );
  if (recentMissing.length > 0) {
    incidents.push({
      severity: 'warning', category: 'missing-market-features', symbol: 'ALL',
      detail: `${recentMissing.length} recent records (last 1h) missing marketFeatures — cannot match by market state`,
      records: recentMissing.map(r => r.id),
    });
  }

  // ── 4. PnL/outcome inconsistency ──
  for (const r of sorted) {
    if ((r.pnl > 0 && r.outcome === 'LOSS') || (r.pnl < 0 && r.outcome === 'WIN')) {
      incidents.push({
        severity: 'critical', category: 'pnl-outcome-inconsistency', symbol: r.symbol,
        detail: `${r.side.toUpperCase()} ${r.symbol}: pnl=$${r.pnl.toFixed(2)} but outcome=${r.outcome} — data corruption`,
        records: [r.id],
      });
    }
  }

  // ── 5. Premature SL pattern ──
  const prematureSL = sorted.filter(r => r.outcome === 'LOSS' && r.holdMin <= 2 && r.exitType === 'sl_tp');
  if (prematureSL.length >= 3) {
    const symbols = new Set(prematureSL.map(r => r.symbol));
    incidents.push({
      severity: 'warning', category: 'premature-sl-pattern', symbol: Array.from(symbols).join(', '),
      detail: `${prematureSL.length} trades lost within 2min via SL — recurring premature stop-out. SL too tight or entries poorly timed.`,
      records: prematureSL.map(r => r.id),
    });
  }

  // ── 6. MFE giveback ──
  const giveback = sorted.filter(r => {
    if (!r.marketFeatures) return false;
    const mfe = r.marketFeatures['mfePct'] as number | undefined;
    return mfe !== undefined && mfe > 0.03 && Math.abs(r.pnlPct) < 0.01;
  });
  if (giveback.length >= 2) {
    incidents.push({
      severity: 'info', category: 'mfe-giveback', symbol: 'ALL',
      detail: `${giveback.length} trades had MFE >3% but closed with |PnL| <1% — exit timing problem`,
      records: giveback.map(r => r.id),
    });
  }

  // ── 7. Fusion data missing (recent only) ──
  const missingFusion = sorted.filter(r =>
    r.ts > timestamp - 3600_000 &&
    r.olrPWinAtEntry === undefined && r.shadowWinRateAtEntry === undefined
  );
  if (missingFusion.length > 0) {
    incidents.push({
      severity: 'warning', category: 'missing-fusion-data', symbol: 'ALL',
      detail: `${missingFusion.length} recent records missing both olrPWinAtEntry and shadowWinRateAtEntry — fusion was unavailable at entry`,
      records: missingFusion.map(r => r.id),
    });
  }

  // ── 8. Side field validation ──
  for (const r of sorted) {
    if (r.side !== 'buy' && r.side !== 'sell') {
      incidents.push({
        severity: 'critical', category: 'invalid-side-field', symbol: r.symbol,
        detail: `Record ${r.id} has invalid side="${r.side}"`,
        records: [r.id],
      });
    }
  }

  // ── Summary + logging ──
  const critical = incidents.filter(i => i.severity === 'critical');
  const warnings = incidents.filter(i => i.severity === 'warning');
  const info = incidents.filter(i => i.severity === 'info');
  const summary = `${incidents.length} incidents: ${critical.length} critical, ${warnings.length} warning, ${info.length} info (from ${sorted.length} records)`;

  for (const inc of critical) log.warn(`🚨 [trade-audit] ${inc.category}: ${inc.detail}`);
  for (const inc of warnings) log.warn(`⚠️ [trade-audit] ${inc.category}: ${inc.detail}`);
  if (info.length > 0) log.info(`[trade-audit] ${info.length} info items`);
  log.info(`[trade-audit] ${summary}`);

  return { incidents, summary, timestamp };
}