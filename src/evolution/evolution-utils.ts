// ─── Evolution Shared Utilities ───
// Shared helpers extracted from pattern-tag-tracker, trade-pattern-classifier,
// thesis-experience, and experience-digester to eliminate duplication.

import type { RationaleCategory } from '../types/index.ts';

// ─── Wilson Score (95% confidence lower bound) ───
// Penalises small sample sizes — 3/5 = 60% becomes ~25%, 30/50 = 60% stays ~47%.
// Prevents overfitting on tiny match counts.

export function wilsonScore(wins: number, total: number): number {
  if (total <= 0) return 0;
  const p = Math.min(1, Math.max(0, wins / total));
  const z = 1.96; // 95% confidence
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  // v2.0.721: Use p (not centre) in the variance term — the standard Wilson
  // formula uses p(1-p)/n. Using centre caused NaN when p=1.0 (centre > 1
  // → centre*(1-centre) < 0 → sqrt of negative). This is the correct formula.
  const variance = (p * (1 - p)) / total + (z * z) / (4 * total * total);
  const margin = z * Math.sqrt(Math.max(0, variance));
  const adjusted = (centre - margin) / denominator;
  return Math.max(0, Math.min(1, adjusted));
}

// ─── JSON extraction (robust against markdown fences) ───
// Strips ```json fences, finds the first balanced {…}, and JSON.parses it.

export function extractJSON(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('unbalanced JSON');
  return JSON.parse(s.slice(start, end + 1));
}

// ─── Heuristic rationale categorisation ───
// Regex-based fallback when LLM categorisation is unavailable.
// The experience-digester version has an expanded news regex (adds
// front-run|accumulation|distribution) — we use the expanded version
// as the canonical one since it's a superset.

export function categoriseRationale(text: string): RationaleCategory {
  const t = text.toLowerCase();
  if (/(resistance|support|breakout|rsi|macd|moving average|ema|sma|trendline|fib|volume|vol |ob |order book|imbalance|bps|retest)/.test(t)) return 'technical';
  if (/(capex|earnings|revenue|ai |secular|tailwind|fundamental|valuation|pe |margin)/.test(t)) return 'fundamental';
  if (/(news|fud|announcement|headline|ceasefire|geopolit|tweet|statement|front-run|accumulation|distribution)/.test(t)) return 'news';
  if (/(fed|rate|interest|inflation|cpi|macro|liquidity|qt|qe|yield|risk-off|risk off)/.test(t)) return 'macro';
  if (/(flow|inflow|outflow|etf|fund flow|whale|onchain|on-chain|funding rate)/.test(t)) return 'flow';
  if (/(sentiment|fear|greed|conviction|social)/.test(t)) return 'sentiment';
  if (/(pattern|flag|triangle|wedge|double top|double bottom|reversal|continuation|mean reversion)/.test(t)) return 'pattern';
  return 'other';
}

// ─── Normalise a category string to a valid RationaleCategory ───

const VALID_CATEGORIES: RationaleCategory[] = ['technical', 'fundamental', 'news', 'macro', 'flow', 'sentiment', 'pattern', 'other'];

export function normaliseCategory(c?: string): RationaleCategory {
  const lower = (c ?? 'other').toLowerCase().trim() as RationaleCategory;
  return VALID_CATEGORIES.includes(lower) ? lower : 'other';
}

// ─── Win/Loss statistics ───
// Shared pattern for computing win rate + avg PnL from a set of records.
// Used across pattern-tag-tracker, trade-pattern-classifier, trade-history,
// shadow-trade-engine, reason-analytics.

export interface WinLossStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;       // raw win rate (0-1)
  wilsonWinRate: number; // Wilson score lower bound (0-1)
  avgPnl: number;
}

export function computeWinLossStats(
  records: Array<{ pnl?: number }>,
  isWinFn: (r: { pnl?: number }) => boolean = (r) => (r.pnl ?? 0) >= 0,
): WinLossStats {
  const total = records.length;
  if (total === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, wilsonWinRate: 0, avgPnl: 0 };
  }
  const wins = records.filter(isWinFn).length;
  const losses = total - wins;
  const pnlSum = records.reduce((s, r) => s + (r.pnl ?? 0), 0);
  return {
    total,
    wins,
    losses,
    winRate: wins / total,
    wilsonWinRate: wilsonScore(wins, total),
    avgPnl: pnlSum / total,
  };
}