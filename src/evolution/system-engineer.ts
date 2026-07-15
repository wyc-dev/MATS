// ─── System Engineer Agent ───
// v2.0.181: LLM-powered self-improving code review agent.
// Reads SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md + trade records,
// detects issues, generates code fix proposals (with diffs + tests + changelog),
// writes them to audit-recommendations.jsonl for human approval.
//
// The agent has SUGGESTION power but NOT EXECUTION power.
// All fixes require human approval before being applied.

import { createLogger } from '../observability/logger.ts';
import { getActiveProvider } from '../llm/index.ts';
import { getAgentModel } from '../agents/agent-models.ts';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThesisExperienceRecord } from '../types/index.ts';

const log = createLogger({ phase: 'system-engineer' });

const PROJECT_ROOT = process.cwd();
const RECOMMENDATIONS_FILE = join(PROJECT_ROOT, 'data/evolution/audit-recommendations.jsonl');

const SYSTEM_PROMPT = `You are the System Engineer of MATS, a multi-agent quant trading system on Hyperliquid DEX.
Your mission: achieve maximum profit efficiency while approaching complete capital preservation.

You have SUGGESTION power but NOT EXECUTION power. You generate fix proposals; a human approves them.

## Core Principles

1. ZERO HALLUCINATION — Only modify code you fully understand. Read the actual implementation before proposing changes. Never invent APIs or guess types.
2. CODE SEMANTICS — Before proposing a fix, read the full function + all callers. Update function descriptions to match implementation.
3. SUBTLE BUG PREVENTION — Trading system bugs = real money loss. Watch for: direction mixing (BUY vs SELL), symbol matching (xyz:SKHX vs skhx), precision issues, race conditions.
4. CAPITAL PRESERVATION FIRST — Every fix must align with "capital preservation is the absolute first priority."
5. CONTINUOUS TRACKING — After each fix, update CHANGELOG.md (mandatory) and ARCHITECTURE.md (if architecture changed).

## Audit Process

1. Examine the trade records for suspicious patterns (repeated losses, direction confusion, missing data, premature exits)
2. Locate the relevant source code
3. Analyze the root cause — is it a code bug, logic error, or config issue?
4. Generate a specific fix proposal with: file path, old code, new code, reason, test update, changelog entry
5. Verify the fix won't break existing functionality

## Output Format

Respond ONLY with JSON array of recommendations:
[{"severity":"critical|warning|info","category":"...","title":"...","rootCause":"...","affectedFiles":["..."],"proposedFix":{"file":"...","oldCode":"...","newCode":"...","reason":"..."},"testUpdate":{"file":"...","newTest":"..."},"changelogEntry":"v2.0.XXX: ..."}]

If no issues found, return: []`;

export interface Recommendation {
  id: string;
  ts: number;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  rootCause: string;
  affectedFiles: string[];
  proposedFix: {
    file: string;
    oldCode: string;
    newCode: string;
    reason: string;
  };
  testUpdate?: {
    file: string;
    newTest: string;
  };
  changelogEntry: string;
  architectureUpdate?: string;
  approved: boolean;
  appliedAt: number | null;
}

/**
 * Run the System Engineer agent: read context files, examine trade records,
 * generate fix proposals, write to audit-recommendations.jsonl.
 */
export async function runSystemEngineer(records: ThesisExperienceRecord[]): Promise<Recommendation[]> {
  const ts = Date.now();
  log.info(`🔧 [system-engineer] Starting audit (${records.length} trade records)`);

  // Phase 1: Read context files
  const systemEngineerMd = readFileSafe('SystemEngineer.md');
  const architectureMd = readFileSafe('ARCHITECTURE.md');
  const changelogTail = readChangelogTail(3);
  const loopMemory = readFileSafe('scripts/loop-engineering-memory.md');

  // Phase 2: Build trade record summary
  const recent = records.slice(-20);
  const tradeSummary = recent.map((r, i) => {
    const features = r.marketFeatures
      ? `vol=${(r.marketFeatures['volatility'] ?? 0).toFixed(4)} ob=${(r.marketFeatures['obImbalance'] ?? 0).toFixed(2)} funding=${(r.marketFeatures['fundingRate'] ?? 0).toFixed(5)}`
      : 'NO_MARKET_DATA';
    const olr = r.olrPWinAtEntry !== undefined ? `OLR=${(r.olrPWinAtEntry * 100).toFixed(0)}%` : 'NO_OLR';
    const shadow = r.shadowWinRateAtEntry !== undefined ? `shadow=${(r.shadowWinRateAtEntry * 100).toFixed(0)}%` : 'NO_SHADOW';
    return `#${i + 1} ${r.side.toUpperCase()} ${r.symbol} ${r.outcome} pnl=$${r.pnl.toFixed(2)} (${(r.pnlPct * 100).toFixed(1)}%) hold=${r.holdMin}min exit=${r.exitType ?? '?'} regime=${r.regime} ${features} ${olr} ${shadow} | ${r.entryThesis.slice(0, 100)}`;
  }).join('\n');

  // Per-symbol direction summary
  const dirSummary = buildDirectionSummary(records);

  // Phase 3: Read relevant source code (based on common problem areas)
  const relevantCode = readRelevantSourceCode();

  const userPrompt = `## System Context

### SystemEngineer.md (your operating manual)
${systemEngineerMd.slice(0, 3000)}

### ARCHITECTURE.md (system architecture)
${architectureMd.slice(0, 3000)}

### CHANGELOG.md (last 3 versions)
${changelogTail}

### Loop Engineering Memory (known bugs to avoid repeating)
${loopMemory.slice(0, 2000)}

## Trade Records (last 20 of ${records.length})
${tradeSummary}

## Per-Symbol Direction Summary
${dirSummary}

## Relevant Source Code
${relevantCode}

## Your Task
Examine the trade records and source code. Detect ANY issues that could cause losses or learning system corruption. For each issue, generate a specific fix proposal with code diff, test update, and changelog entry.

Remember: ZERO HALLUCINATION. Only propose fixes for code you fully understand. Read the actual implementation shown above.`;

  try {
    const provider = getActiveProvider();
    const response = await provider.chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      model: getAgentModel('terminal_agent'),
      timeoutMs: 60_000,
    });

    const recommendations = parseRecommendations(response.content, ts);

    // Write to audit-recommendations.jsonl
    for (const rec of recommendations) {
      appendFileSync(RECOMMENDATIONS_FILE, JSON.stringify(rec) + '\n');
    }

    // Log results
    const critical = recommendations.filter(r => r.severity === 'critical');
    const warnings = recommendations.filter(r => r.severity === 'warning');

    for (const rec of critical) {
      log.warn(`🚨 [system-engineer] ${rec.title}: ${rec.rootCause}`);
      log.warn(`🚨 [system-engineer] Proposed fix: ${rec.proposedFix.file} — ${rec.proposedFix.reason}`);
    }
    for (const rec of warnings) {
      log.warn(`⚠️ [system-engineer] ${rec.title}: ${rec.rootCause}`);
    }

    log.info(`🔧 [system-engineer] Generated ${recommendations.length} recommendations (${critical.length} critical, ${warnings.length} warning) → ${RECOMMENDATIONS_FILE}`);

    return recommendations;
  } catch (err) {
    log.warn(`[system-engineer] failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function readFileSafe(relPath: string): string {
  try {
    const full = join(PROJECT_ROOT, relPath);
    if (!existsSync(full)) return `(file not found: ${relPath})`;
    return readFileSync(full, 'utf-8');
  } catch { return `(read failed: ${relPath})`; }
}

function readChangelogTail(versions: number): string {
  try {
    const content = readFileSafe('CHANGELOG.md');
    // Find last N version headers
    const lines = content.split('\n');
    const versionLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('## v2.0.')) versionLines.push(i);
    }
    const start = versionLines.length >= versions ? versionLines[versionLines.length - versions]! : 0;
    return lines.slice(start, start + 100).join('\n');
  } catch { return '(changelog read failed)'; }
}

function buildDirectionSummary(records: ThesisExperienceRecord[]): string {
  const map = new Map<string, { buy: { w: number; l: number }; sell: { w: number; l: number } }>();
  for (const r of records) {
    let e = map.get(r.symbol);
    if (!e) { e = { buy: { w: 0, l: 0 }, sell: { w: 0, l: 0 } }; map.set(r.symbol, e); }
    if (r.side === 'buy') { if (r.outcome === 'WIN') e.buy.w++; else e.buy.l++; }
    else { if (r.outcome === 'WIN') e.sell.w++; else e.sell.l++; }
  }
  const lines: string[] = [];
  for (const [sym, s] of map) {
    const bt = s.buy.w + s.buy.l;
    const st = s.sell.w + s.sell.l;
    const bwr = bt > 0 ? `${(s.buy.w / bt * 100).toFixed(0)}%` : '-';
    const swr = st > 0 ? `${(s.sell.w / st * 100).toFixed(0)}%` : '-';
    lines.push(`  ${sym}: BUY ${bwr} (${s.buy.w}W/${s.buy.l}L) | SELL ${swr} (${s.sell.w}W/${s.sell.l}L)`);
  }
  return lines.join('\n');
}

function readRelevantSourceCode(): string {
  // Read key files that are common sources of trading bugs
  const files = [
    'src/evolution/thesis-experience.ts:660:730',  // checkThesisHistory pWin + delta
    'src/evolution/direction-audit.ts:1:50',       // audit system
    'src/trading/portfolio.ts:560:580',            // openPosition SL/TP
    'src/trading/trading-manager.ts:480:530',      // executeDecision SL/TP
  ];
  const parts: string[] = [];
  for (const spec of files) {
    const [file, start, end] = spec.split(':');
    try {
      const content = readFileSync(join(PROJECT_ROOT, file!), 'utf-8');
      const lines = content.split('\n');
      const s = parseInt(start ?? '0') - 1;
      const e = parseInt(end ?? String(lines.length));
      parts.push(`### ${file} (lines ${start}-${end})\n\`\`\`typescript\n${lines.slice(s, e).join('\n')}\n\`\`\``);
    } catch { /* skip unreadable files */ }
  }
  return parts.join('\n\n');
}

function parseRecommendations(content: string, ts: number): Recommendation[] {
  try {
    let s = content.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) s = fence[1].trim();

    // Find JSON array
    const start = s.indexOf('[');
    if (start < 0) return [];
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '[') depth++;
      else if (s[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return [];

    const parsed = JSON.parse(s.slice(start, end + 1)) as Array<{
      severity?: string; category?: string; title?: string; rootCause?: string;
      affectedFiles?: string[]; proposedFix?: { file?: string; oldCode?: string; newCode?: string; reason?: string };
      testUpdate?: { file?: string; newTest?: string };
      changelogEntry?: string; architectureUpdate?: string;
    }>;

    return parsed.map((p, i) => ({
      id: `audit-${ts}-${i}`,
      ts,
      severity: (p.severity === 'critical' || p.severity === 'warning') ? p.severity : 'info',
      category: p.category ?? 'unknown',
      title: p.title ?? 'Untitled',
      rootCause: p.rootCause ?? '',
      affectedFiles: p.affectedFiles ?? [],
      proposedFix: {
        file: p.proposedFix?.file ?? '',
        oldCode: p.proposedFix?.oldCode ?? '',
        newCode: p.proposedFix?.newCode ?? '',
        reason: p.proposedFix?.reason ?? '',
      },
      testUpdate: p.testUpdate ? { file: p.testUpdate.file ?? '', newTest: p.testUpdate.newTest ?? '' } : undefined,
      changelogEntry: p.changelogEntry ?? '',
      architectureUpdate: p.architectureUpdate,
      approved: false,
      appliedAt: null,
    }));
  } catch {
    log.warn('[system-engineer] Failed to parse recommendations');
    return [];
  }
}