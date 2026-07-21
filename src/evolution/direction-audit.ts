// ─── LLM-Powered Trade Record Audit ───
// v2.0.180: Instead of hardcoded rules, an LLM agent examines recent trade
// records and detects ANY suspicious pattern — including ones humans never
// thought of. The LLM sees the actual trade data (thesis, PnL, direction,
// market conditions, hold time, exit type) and reasons about what went wrong.
//
// Runs every 2 cycles. Uses the Terminal Agent model (fast, cheap).
// Results are logged + stored for the UI to display.

import { createLogger } from '../observability/logger.ts';
import { getActiveProvider } from '../llm/index.ts';
import { getAgentModel } from '../agents/agent-models.ts';
import type { ThesisExperienceRecord } from '../types/index.ts';
import { computeVectorConditionalWinRate, formatVectorConditional } from './evolution-utils.ts';
import type { NumericEmbedProvider } from './numeric-autoencoder.ts';

const log = createLogger({ phase: 'trade-audit' });

export interface AuditIncident {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  symbol: string;
  detail: string;
}

export interface AuditResult {
  incidents: AuditIncident[];
  summary: string;
  llmAnalysis: string;
  timestamp: number;
}

const SYSTEM_PROMPT = `You are the Trade Record Auditor of MATS, a multi-agent quant trading system on Hyperliquid.
Your job: examine recent closed trade records and detect ANY suspicious patterns, anomalies, or learning system failures.

## GROUND TRUTH RULE
Before answering, you MUST first check the actual trade records provided in context. NEVER guess or assume trade outcomes, directions, or patterns — always base your audit on the real data shown to you. If data is missing or unclear, say so instead of guessing.

You are NOT limited to a checklist. You can detect ANYTHING suspicious, including patterns no human has thought of.

Think about:
1. Is the system repeatedly making the same mistake? (same symbol, same direction, same thesis type, same loss)
2. Is the system ignoring its own learning data? (opening trades that historical data says will lose)
3. Are there data quality issues? (missing fields, inconsistent outcomes, corrupted records)
4. Are there exit timing problems? (MFE >> final PnL, premature SL, holding too long)
5. Are there direction confusion issues? (system opens SELL when all evidence favors BUY, or vice versa)
6. Are there thesis quality issues? (thesis too vague, thesis contradicts the action, thesis doesn't match market conditions)
7. Are there market condition patterns? (certain volatility/regime/OB conditions consistently producing losses)
8. Are there temporal patterns? (losses clustering at certain times, after certain events)
9. Is the system overtrading? (too many trades in a short period, churning)
10. Is there any OTHER pattern you find suspicious that isn't listed above?

For each issue found, specify:
- severity: "critical" (will cause repeated losses), "warning" (degrades performance), "info" (worth monitoring)
- category: a short name for the pattern (e.g. "direction-repetition", "thesis-contradicts-action", "sl-too-tight-for-volatility")
- symbol: the affected symbol(s)
- detail: specific explanation with numbers from the data

If you find NO issues, say so explicitly. Do not fabricate problems.

Respond ONLY with JSON:
{"incidents":[{"severity":"critical|warning|info","category":"...","symbol":"...","detail":"..."}],"analysis":"one paragraph summary of your findings"}`;

/**
 * LLM-powered audit of recent trade records.
 * Feeds the last N closed trades to the LLM and asks it to detect any
 * suspicious patterns — not limited to a predefined checklist.
 */
export async function auditTradeRecordsLLM(records: ThesisExperienceRecord[], embeddingProvider?: NumericEmbedProvider): Promise<AuditResult> {
  const timestamp = Date.now();

  if (records.length === 0) {
    return { incidents: [], summary: 'No records to audit', llmAnalysis: '', timestamp };
  }

  // Take last 20 records (most recent + most relevant)
  const recent = records.slice(-20);

  // Build a compact data summary for the LLM
  const dataLines = recent.map((r, i) => {
    const features = r.marketFeatures
      ? `vol=${(r.marketFeatures['volatility'] ?? 0).toFixed(4)} ob=${(r.marketFeatures['obImbalance'] ?? 0).toFixed(2)} funding=${(r.marketFeatures['fundingRate'] ?? 0).toFixed(5)} srDist=${(r.marketFeatures['srDistanceBps'] ?? 0).toFixed(0)}bps`
      : 'NO_MARKET_DATA';
    const olr = r.olrPWinAtEntry !== undefined ? `OLR_PWin=${(r.olrPWinAtEntry * 100).toFixed(0)}%` : 'NO_OLR';
    const shadow = r.shadowWinRateAtEntry !== undefined ? `shadowWR=${(r.shadowWinRateAtEntry * 100).toFixed(0)}%` : 'NO_SHADOW';
    return `#${i + 1} ${r.side.toUpperCase()} ${r.symbol} ${r.outcome} pnl=$${r.pnl.toFixed(2)} (${(r.pnlPct * 100).toFixed(1)}%) hold=${r.holdMin}min exit=${r.exitType ?? '?'} regime=${r.regime} ${features} ${olr} ${shadow} | thesis: ${r.entryThesis.slice(0, 120)}`;
  });

  const userPrompt = `Recent closed trades (${recent.length} of ${records.length} total):
${dataLines.join('\n')}

Also, VECTOR-CONDITIONAL win rate per recent trade (win rate of historically similar MARKET CONDITIONS, not raw per-symbol counts — a symbol's 0W/1L is meaningless when current conditions differ from that single trade):
${buildVectorConditionalSummary(records, embeddingProvider)}

IMPORTANT: Do NOT accuse the system of "ignoring learning data" based on raw per-symbol win rates alone. A symbol with 0% raw WR may have only 1 trade under totally different market conditions. The VECTOR-CONDITIONAL win rate above is the correct signal — if conditional WR is high but the trade lost, the issue is exit timing / luck, not direction. If conditional WR is low and the system still entered, THAT is a real learning failure.

Examine these trade records for ANY suspicious patterns. Detect issues that hardcoded rules would miss.`;

  try {
    const provider = getActiveProvider();
    const response = await provider.chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      model: getAgentModel('terminal_agent'),
      timeoutMs: 30_000,
    });

    const content = response.content.trim();
    const parsed = parseAuditResponse(content);

    // Log results
    const critical = parsed.incidents.filter(i => i.severity === 'critical');
    const warnings = parsed.incidents.filter(i => i.severity === 'warning');
    const info = parsed.incidents.filter(i => i.severity === 'info');

    for (const inc of critical) log.warn(`🚨 [trade-audit] ${inc.category}: ${inc.detail}`);
    for (const inc of warnings) log.warn(`⚠️ [trade-audit] ${inc.category}: ${inc.detail}`);
    if (info.length > 0) log.info(`[trade-audit] ${info.length} info items`);
    log.info(`[trade-audit] LLM analysis: ${parsed.analysis}`);
    log.info(`[trade-audit] ${parsed.incidents.length} incidents: ${critical.length} critical, ${warnings.length} warning, ${info.length} info`);

    return {
      incidents: parsed.incidents,
      summary: `${parsed.incidents.length} incidents: ${critical.length} critical, ${warnings.length} warning, ${info.length} info`,
      llmAnalysis: parsed.analysis,
      timestamp,
    };
  } catch (err) {
    log.warn(`[trade-audit] LLM audit failed: ${err instanceof Error ? err.message : String(err)}`);
    return { incidents: [], summary: 'LLM audit failed', llmAnalysis: '', timestamp };
  }
}

/**
 * v2.0.203: Vector-conditional win rate per recent trade.
 * For each of the most recent trades, retrieves the historical win rate of
 * trades that had SIMILAR MARKET CONDITIONS at entry (cosine similarity on
 * normalised entry features, same direction, cross-symbol) and compares it
 * to the actual outcome. This replaces the old raw per-symbol win-rate
 * summary which falsely accused the system of ignoring learning data when
 * the learning data was collected under entirely different market conditions.
 *
 * Interpretation for the LLM auditor:
 *   - conditional WR HIGH + trade LOST  → exit timing / luck issue, NOT direction
 *   - conditional WR LOW  + trade OPENED → genuine learning-system failure
 *   - conditional WR ≈ actual outcome → system is well-calibrated
 */
function buildVectorConditionalSummary(records: ThesisExperienceRecord[], embeddingProvider?: NumericEmbedProvider): string {
  // Use the most recent 15 trades that have marketFeatures.
  const recent = records
    .filter((r) => r.marketFeatures && Object.keys(r.marketFeatures).length > 0)
    .slice(-15);
  if (recent.length === 0) {
    return '  (no trades with marketFeatures — cannot compute conditional win rate)';
  }

  const lines: string[] = [];
  for (const r of recent) {
    // Exclude the trade itself from its own similarity set.
    const others = records.filter((x) => x.id !== r.id);
    const result = computeVectorConditionalWinRate(
      r.marketFeatures!,
      others,
      { side: r.side, minSamples: 3, threshold: 0.80, topN: 20, embeddingProvider },
    );
    const actualIcon = r.outcome === 'WIN' ? '✅' : '❌';
    const condLine = formatVectorConditional(result, `  ${r.side.toUpperCase()} ${r.symbol}`);
    lines.push(`${actualIcon} actual=${r.outcome} | ${condLine}`);
  }
  return lines.join('\n');
}

function parseAuditResponse(content: string): { incidents: AuditIncident[]; analysis: string } {
  try {
    // Strip markdown fences
    let s = content.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) s = fence[1].trim();

    // Find balanced JSON
    const start = s.indexOf('{');
    if (start < 0) return { incidents: [], analysis: content.slice(0, 200) };
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return { incidents: [], analysis: content.slice(0, 200) };

    const parsed = JSON.parse(s.slice(start, end + 1)) as {
      incidents?: Array<{ severity?: string; category?: string; symbol?: string; detail?: string }>;
      analysis?: string;
    };

    const incidents: AuditIncident[] = (parsed.incidents ?? []).map(i => ({
      severity: (i.severity === 'critical' || i.severity === 'warning' || i.severity === 'info') ? i.severity : 'info',
      category: i.category ?? 'unknown',
      symbol: i.symbol ?? 'ALL',
      detail: i.detail ?? '',
    }));

    return { incidents, analysis: parsed.analysis ?? '' };
  } catch {
    return { incidents: [], analysis: content.slice(0, 200) };
  }
}