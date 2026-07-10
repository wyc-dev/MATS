#!/usr/bin/env tsx
// ─── EM Cycle Digestion Backfill ───
// Reads closed trades from data/exp/trades.jsonl and constructs CycleSummaries
// from each trade's entryThesis + regime + outcome + holdMin.
// Writes the result to data/evolution/em-state.json so EM Cycle Digestion
// has historical insights to query on the next startup.
//
// Usage: npx tsx scripts/backfill-em-state.ts

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

interface ExpRecord {
  id: string;
  ts: number;
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'WIN' | 'LOSS';
  pnl: number;
  pnlPct: number;
  regime: string;
  holdMin: number;
  entryThesis: string;
  rationales: string[];
  rationaleCats: string[];
}

interface CycleSummary {
  cycleNumber: number;
  timestamp: number;
  keyInsight: string;
  primarySignal: { name: string; value: number; direction: 'bullish' | 'bearish' | 'neutral' };
  delta: { exists: boolean; metric: string; from: number | null; to: number | null; significance: 'none' | 'low' | 'medium' | 'high' };
  latentState: { regimeConfidence: number; trendConfidence: number; dataQuality: number; anomalyDetected: boolean };
  convergence: { agentAgreement: number; skepticsApproved: boolean; metaOverride: boolean };
}

function extractInsight(rec: ExpRecord): string {
  // If the thesis is a placeholder, construct a synthetic insight from the trade data
  const thesis = rec.entryThesis?.trim() ?? '';
  const isPlaceholder = !thesis || thesis.includes('N/A') || thesis.includes('no entry') || thesis.includes('no trade') || thesis.includes('no position');

  if (isPlaceholder) {
    return `${rec.symbol} ${rec.side.toUpperCase()} ${rec.outcome} in ${rec.regime} — held ${rec.holdMin}min, pnl ${(rec.pnlPct * 100).toFixed(2)}% (no thesis recorded)`;
  }

  // Extract the first meaningful sentence from the thesis
  const cleaned = thesis.replace(/\[(1h|1d|4h|1w|1m|5m|15m)\s*:/g, ' ').replace(/[\[\]]/g, '').trim();
  const firstSentence = cleaned.split(/[.!?]/)[0]?.trim() ?? cleaned;
  return `${rec.symbol} ${rec.side.toUpperCase()} ${rec.outcome} in ${rec.regime} — ${firstSentence} (held ${rec.holdMin}min, pnl ${(rec.pnlPct * 100).toFixed(2)}%)`;
}

function extractDirection(rec: ExpRecord): 'bullish' | 'bearish' | 'neutral' {
  if (rec.outcome === 'WIN') return rec.side === 'buy' ? 'bullish' : 'bearish';
  if (rec.outcome === 'LOSS') return rec.side === 'buy' ? 'bearish' : 'bullish';
  return 'neutral';
}

function main(): void {
  const jsonlPath = join(process.cwd(), 'data/exp/trades.jsonl');
  const emStatePath = join(process.cwd(), 'data/evolution/em-state.json');

  if (!existsSync(jsonlPath)) {
    console.error(`No EXP trades found at ${jsonlPath}`);
    process.exit(1);
  }

  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const records: ExpRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as ExpRecord);
    } catch {
      console.warn(`Skipping corrupt line`);
    }
  }

  console.log(`Read ${records.length} EXP trades from ${jsonlPath}`);

  // Sort by timestamp (oldest first)
  records.sort((a, b) => a.ts - b.ts);

  // Construct CycleSummaries — assign approximate cycle numbers based on timestamp
  // (we don't know the exact cycle number, but we can estimate from the interval)
  const summaries: CycleSummary[] = records.map((rec, i) => {
    const direction = extractDirection(rec);
    const insight = extractInsight(rec);
    return {
      cycleNumber: i + 1, // approximate
      timestamp: rec.ts,
      keyInsight: insight,
      primarySignal: {
        name: rec.outcome === 'WIN' ? 'win' : 'loss',
        value: rec.pnlPct,
        direction,
      },
      delta: { exists: false, metric: 'none', from: null, to: null, significance: 'none' as const },
      latentState: {
        regimeConfidence: 0.5,
        trendConfidence: 0.5,
        dataQuality: 0.5,
        anomalyDetected: rec.regime === 'low_volatility',
      },
      convergence: {
        agentAgreement: 0.5,
        skepticsApproved: true,
        metaOverride: false,
      },
    };
  });

  // Merge with existing em-state.json if it has summaries
  let existingSummaries: CycleSummary[] = [];
  let convergenceAccuracy = 0.5;
  let convergenceChecks = 0;
  if (existsSync(emStatePath)) {
    try {
      const existing = JSON.parse(readFileSync(emStatePath, 'utf-8'));
      existingSummaries = Array.isArray(existing.summaries) ? existing.summaries : [];
      convergenceAccuracy = typeof existing.convergenceAccuracy === 'number' ? existing.convergenceAccuracy : 0.5;
      convergenceChecks = typeof existing.convergenceChecks === 'number' ? existing.convergenceChecks : 0;
      console.log(`Existing em-state.json has ${existingSummaries.length} summaries`);
    } catch { /* ignore */ }
  }

  // Merge: backfilled summaries first (lower cycle numbers), then existing
  const maxBackfillCycle = summaries.length;
  const existingAdjusted = existingSummaries.map(s => ({
    ...s,
    cycleNumber: s.cycleNumber + maxBackfillCycle, // shift to avoid collision
  }));
  const allSummaries = [...summaries, ...existingAdjusted];

  const state = {
    summaries: allSummaries,
    convergenceAccuracy,
    convergenceChecks,
  };

  // Write
  const dir = dirname(emStatePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = emStatePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, emStatePath);

  console.log(`Wrote ${allSummaries.length} summaries to ${emStatePath}`);
  console.log(`  Backfilled: ${summaries.length} from EXP trades`);
  console.log(`  Existing: ${existingSummaries.length} from previous runs`);
  console.log(`  Convergence: accuracy=${(convergenceAccuracy * 100).toFixed(0)}%, checks=${convergenceChecks}`);
  console.log(`\nRestart the system to load these into EM Cycle Digestion.`);
}

main();