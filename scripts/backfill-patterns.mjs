// ─── One-time backfill: import real portfolio trades into pattern DB ───
// Reads portfolio-state.json and trade-patterns.json, merges closed trades
// that have |PnL%| >= 0.5% but are missing from the pattern DB.

import { readFileSync, writeFileSync } from 'node:fs';

const PORTFOLIO_PATH = 'data/evolution/portfolio-state.json';
const PATTERNS_PATH = 'data/evolution/trade-patterns.json';

const portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf8'));
const existingPatterns = JSON.parse(readFileSync(PATTERNS_PATH, 'utf8'));

const existingIds = new Set(existingPatterns.map(p => p.id));

let added = 0;
let skipped = 0;

for (const trade of portfolio.trades) {
  if (existingIds.has(trade.id)) {
    skipped++;
    continue;
  }
  if (trade.status !== 'closed') {
    skipped++;
    continue;
  }
  const pnlAbs = Math.abs(trade.pnlPct ?? 0);
  if (pnlAbs < 0.005) {
    skipped++;
    continue; // Skip noise
  }

  const outcome = trade.pnlPct > 0 ? 'win' : 'loss';
  const holdDuration = Math.max(1, Math.round(
    (trade.closedAt - trade.openedAt) / 300_000
  ));

  // Build a best-guess context from limited data
  const baseCtx = {
    regime: 'unknown',
    regimeConfidence: 0.5,
    volatility: 0,
    trendStrength: 0.5,
    srDistanceBps: 0,
    obImbalance: 0,
    fundingRate: 0,
    fundingRateAccel: 0,
    volumeRatio: 1,
    signalAgreement: 0.5,
    positionSizePct: trade.investment && portfolio.balance
      ? trade.investment / portfolio.balance
      : 0.01,
    leverage: trade.leverage ?? 1,
    sentiment: 0,
    sentimentConviction: 0.5,
  };

  const record = {
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    entryTimestamp: trade.openedAt,
    exitTimestamp: trade.closedAt,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    entryContext: { ...baseCtx },
    exitContext: { ...baseCtx },
    outcome,
    pnlPct: trade.pnlPct,
    holdDuration,
    metaInsight: '[backfill] Imported from portfolio-state history',
    agentDecisions: [],
  };

  existingPatterns.push(record);
  added++;
}

// Enforce max 1000 patterns
if (existingPatterns.length > 1000) {
  existingPatterns.splice(0, existingPatterns.length - 1000);
}

writeFileSync(PATTERNS_PATH, JSON.stringify(existingPatterns, null, 2));
console.log(`Done: added ${added} trades, skipped ${skipped} (${existingPatterns.length} total patterns)`);