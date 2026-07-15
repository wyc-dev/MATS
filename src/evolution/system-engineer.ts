// ─── System Engineer Agent (Autonomous) ───
// v2.0.182: LLM-powered self-improving code agent with AUTONOMOUS execution.
// Reads SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md + trade records +
// source code, detects issues, generates fixes, APPLIES them, runs tests,
// auto-rollbacks on failure, commits on success.
//
// Safety net: tsc --noEmit + npm test must pass. If either fails → rollback.
// Scope: src/evolution/ + src/cognition/hacp.ts only (learning + decision logic).
// Forbidden: src/trading/ (order execution + SL/TP + signing) + src/config/ (risk).

import { createLogger } from '../observability/logger.ts';
import { getActiveProvider } from '../llm/index.ts';
import { getAgentModel } from '../agents/agent-models.ts';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { ThesisExperienceRecord } from '../types/index.ts';

const log = createLogger({ phase: 'system-engineer' });

const PROJECT_ROOT = process.cwd();
const RECOMMENDATIONS_FILE = join(PROJECT_ROOT, 'data/evolution/audit-recommendations.jsonl');

// Files the agent is ALLOWED to modify (learning + decision logic only)
const ALLOWED_PREFIXES = [
  'src/evolution/',
  'src/cognition/',
  'src/analysis/',
  'src/agents/',
  'tests/',
];

// Files the agent is FORBIDDEN from modifying (trading execution + risk config)
const FORBIDDEN_PREFIXES = [
  'src/trading/',
  'src/config/',
  'src/data/',
  'src/api-server.ts',
  'src/index.ts',
  '.env',
];

const SYSTEM_PROMPT = `You are the System Engineer of MATS, a multi-agent quant trading system on Hyperliquid DEX.
Your mission: achieve maximum profit efficiency while approaching complete capital preservation.

You have AUTONOMOUS EXECUTION power. Your fixes will be applied directly to the codebase.
A safety net runs after each fix: tsc --noEmit + npm test. If either fails, your change is automatically rolled back.

## What You CAN Modify
- src/evolution/*.ts — learning systems (EXP, OLR, shadow, pattern classifier, digester, etc.)
- src/cognition/*.ts — HACP decision protocol, A2A utils (consensus, debate, Skeptics validation)
- src/analysis/*.ts — sentiment, S/R, ATR, chaos, options, news analysis
- src/agents/*.ts — agent base class, sub-agents, meta-agent, skeptics
- tests/*.ts — test files (you own these, keep them updated with your changes)

## What You CANNOT Modify (STRICTLY FORBIDDEN)
- src/trading/*.ts — order execution, SL/TP, position management, signing
- src/config/*.ts — risk parameters, leverage, trade mode
- src/index.ts — main orchestrator
- .env — environment configuration
- src/api-server.ts — API server
- src/data/*.ts — WebSocket data feeds

## Core Principles

1. ZERO HALLUCINATION — Only modify code you fully understand. You see the actual source code in the context. Read it carefully before proposing changes.
2. ONE FIX AT A TIME — Propose at most ONE fix per run. Multiple simultaneous changes make rollback impossible if one fails.
3. COMPLETE CODE BLOCKS — Your oldCode must match the EXACT text in the file (including whitespace). Your newCode must be the complete replacement.
4. CAPITAL PRESERVATION FIRST — Never propose a change that could increase risk of capital loss.
5. DIRECTION SAFETY — Never propose a change that could mix BUY and SELL logic or remove direction filtering.
6. TEST UPDATE — If your fix changes behavior, include a testUpdate that verifies the new behavior.
7. CHANGELOG + ARCHITECTURE — Your fix MUST include a changelogEntry. If architecture changes, include architectureUpdate.

## Output Format

Respond with EXACTLY ONE JSON object (not an array):
{"severity":"critical|warning|info","category":"...","title":"...","rootCause":"specific code lines and why they're wrong","affectedFile":"src/evolution/...","proposedFix":{"oldCode":"EXACT text from the file","newCode":"replacement text","reason":"why this fix is correct"},"testUpdate":{"file":"tests/...","oldCode":"...","newCode":"..."},"changelogEntry":"v2.0.XXX: description","architectureUpdate":"optional architecture description"}

If you find NO issues worth fixing, respond with:
{"severity":"info","category":"none","title":"No issues found","rootCause":"","affectedFile":"","proposedFix":{"oldCode":"","newCode":"","reason":""},"testUpdate":null,"changelogEntry":""}`;

export interface AutoFixResult {
  applied: boolean;
  title: string;
  file: string;
  reason: string;
  tscPassed: boolean;
  testsPassed: boolean;
  rolledBack: boolean;
  changelogEntry: string;
  error?: string;
  timestamp: number;
}

/**
 * Run the System Engineer agent with autonomous execution.
 * 1. Read context (SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md + trades + code)
 * 2. LLM generates ONE fix proposal
 * 3. Validate: is the file in the allowed scope?
 * 4. Apply: replace oldCode with newCode in the file
 * 5. Test: run tsc --noEmit + npm test
 * 6. If pass: update CHANGELOG.md + git commit + log success
 * 7. If fail: rollback (restore original file) + log failure
 *
 * v2.0.183: Concurrency safety — uses a module-level lock to prevent
 * overlapping runs. The run is fire-and-forget from the trading cycle
 * (via `void`), so it doesn't block trading. But file modifications
 * while tsx watch is active will trigger a restart — this is expected
 * and acceptable (the fix is already applied + committed before restart).
 */
let engineerRunning = false;

export async function runSystemEngineer(records: ThesisExperienceRecord[]): Promise<AutoFixResult | null> {
  // v2.0.183: Prevent overlapping runs
  if (engineerRunning) {
    log.info(`🔧 [system-engineer] Previous run still in progress — skipping`);
    return null;
  }
  engineerRunning = true;
  const timestamp = Date.now();
  log.info(`🔧 [system-engineer] Starting autonomous audit (${records.length} trade records)`);

  // Phase 1: Read context
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

  const dirSummary = buildDirectionSummary(records);

  // Phase 3: Read relevant source code
  const relevantCode = readRelevantSourceCode();

  const userPrompt = `## System Context

### SystemEngineer.md (your operating manual)
${systemEngineerMd.slice(0, 2000)}

### ARCHITECTURE.md (system architecture)
${architectureMd.slice(0, 2000)}

### CHANGELOG.md (last 3 versions)
${changelogTail}

### Loop Engineering Memory (known bugs)
${loopMemory.slice(0, 1500)}

## Trade Records (last 20 of ${records.length})
${tradeSummary}

## Per-Symbol Direction Summary
${dirSummary}

## Relevant Source Code (you can modify files under src/evolution/ and src/cognition/hacp.ts)
${relevantCode}

## Your Task
Find the SINGLE MOST IMPACTFUL issue in the learning/decision system that is causing losses or preventing the system from learning correctly. Generate ONE fix with exact code replacement.

The fix must be in a file under src/evolution/ or src/cognition/hacp.ts or tests/.
The oldCode must EXACTLY match text in the file (copy it from the source code shown above).
The newCode must be the complete replacement.

ZERO HALLUCINATION. If you're not sure, say "No issues found".`;

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

    const proposal = parseProposal(response.content);
    if (!proposal || !proposal.proposedFix.oldCode || !proposal.proposedFix.newCode) {
      log.info(`🔧 [system-engineer] No actionable fix proposed`);
      return null;
    }

    // Validate scope
    const targetFile = proposal.affectedFile;
    if (!isFileAllowed(targetFile)) {
      log.warn(`🚫 [system-engineer] REJECTED: ${targetFile} is outside allowed scope (src/evolution/ + src/cognition/hacp.ts + tests/)`);
      return {
        applied: false, title: proposal.title, file: targetFile, reason: 'File outside allowed scope',
        tscPassed: false, testsPassed: false, rolledBack: false,
        changelogEntry: '', error: 'Scope violation', timestamp,
      };
    }

    // Read the target file
    const fullPath = join(PROJECT_ROOT, targetFile);
    if (!existsSync(fullPath)) {
      log.warn(`🚫 [system-engineer] File not found: ${targetFile}`);
      return null;
    }
    const originalContent = readFileSync(fullPath, 'utf-8');

    // Check if oldCode exists in the file
    if (!originalContent.includes(proposal.proposedFix.oldCode)) {
      log.warn(`🚫 [system-engineer] oldCode not found in ${targetFile} — LLM may have hallucinated the exact text`);
      // Log first 100 chars of oldCode for debugging
      log.warn(`   oldCode preview: "${proposal.proposedFix.oldCode.slice(0, 100)}..."`);
      return {
        applied: false, title: proposal.title, file: targetFile, reason: 'oldCode not found (hallucination detected)',
        tscPassed: false, testsPassed: false, rolledBack: false,
        changelogEntry: '', error: 'oldCode mismatch', timestamp,
      };
    }

    // Apply the fix
    log.info(`🔧 [system-engineer] Applying fix: ${proposal.title} → ${targetFile}`);
    const newContent = originalContent.replace(proposal.proposedFix.oldCode, proposal.proposedFix.newCode);
    writeFileSync(fullPath, newContent, 'utf-8');

    // Apply test update if provided
    let originalTestContent: string | null = null;
    let testFile: string | null = null;
    if (proposal.testUpdate?.file && proposal.testUpdate.oldCode && proposal.testUpdate.newCode) {
      testFile = proposal.testUpdate.file;
      if (isFileAllowed(testFile)) {
        const testPath = join(PROJECT_ROOT, testFile);
        if (existsSync(testPath)) {
          originalTestContent = readFileSync(testPath, 'utf-8');
          if (originalTestContent.includes(proposal.testUpdate.oldCode)) {
            const newTestContent = originalTestContent.replace(proposal.testUpdate.oldCode, proposal.testUpdate.newCode);
            writeFileSync(testPath, newTestContent, 'utf-8');
            log.info(`🔧 [system-engineer] Test updated: ${testFile}`);
          } else {
            log.warn(`⚠️ [system-engineer] Test oldCode not found — skipping test update`);
            originalTestContent = null;
          }
        }
      }
    }

    // Run safety net: tsc --noEmit
    log.info(`🔧 [system-engineer] Running tsc --noEmit...`);
    let tscPassed = false;
    try {
      execSync('npx tsc --noEmit', { cwd: PROJECT_ROOT, timeout: 30_000, stdio: 'pipe' });
      tscPassed = true;
      log.info(`✅ [system-engineer] tsc passed`);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      log.warn(`❌ [system-engineer] tsc FAILED: ${stderr.slice(0, 200)}`);
    }

    // Run safety net: npm test
    let testsPassed = false;
    if (tscPassed) {
      log.info(`🔧 [system-engineer] Running npm test...`);
      try {
        const output = execSync('npm test 2>&1', { cwd: PROJECT_ROOT, timeout: 60_000, stdio: 'pipe', encoding: 'utf-8' });
        testsPassed = output.includes('passed') && !output.includes('failed');
        if (testsPassed) {
          log.info(`✅ [system-engineer] tests passed`);
        } else {
          log.warn(`❌ [system-engineer] tests FAILED`);
        }
      } catch (err) {
        const stderr = err instanceof Error ? err.message : String(err);
        log.warn(`❌ [system-engineer] tests FAILED: ${stderr.slice(0, 200)}`);
      }
    }

    // Decision: apply or rollback
    if (tscPassed && testsPassed) {
      // SUCCESS: Update CHANGELOG.md
      updateChangelog(proposal.changelogEntry);

      // Update ARCHITECTURE.md if needed
      if (proposal.architectureUpdate) {
        updateArchitecture(proposal.architectureUpdate);
      }

      // Git commit
      try {
        execSync(`git add -A && git commit -m "${proposal.changelogEntry.replace(/"/g, '\\"')}"`, {
          cwd: PROJECT_ROOT, timeout: 15_000, stdio: 'pipe',
        });
        log.info(`✅ [system-engineer] Git committed: ${proposal.changelogEntry}`);
      } catch (err) {
        log.warn(`⚠️ [system-engineer] Git commit failed: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
      }

      // Record success
      const result: AutoFixResult = {
        applied: true, title: proposal.title, file: targetFile,
        reason: proposal.proposedFix.reason, tscPassed, testsPassed,
        rolledBack: false, changelogEntry: proposal.changelogEntry, timestamp,
      };
      appendRecommendation(result, true);
      log.info(`✅ [system-engineer] Fix applied successfully: ${proposal.title}`);
      return result;
    } else {
      // FAILURE: Rollback
      log.warn(`🔄 [system-engineer] Rolling back: tsc=${tscPassed} tests=${testsPassed}`);
      writeFileSync(fullPath, originalContent, 'utf-8');
      if (originalTestContent && testFile) {
        writeFileSync(join(PROJECT_ROOT, testFile), originalTestContent, 'utf-8');
      }

      const result: AutoFixResult = {
        applied: false, title: proposal.title, file: targetFile,
        reason: proposal.proposedFix.reason, tscPassed, testsPassed,
        rolledBack: true, changelogEntry: proposal.changelogEntry,
        error: `tsc=${tscPassed} tests=${testsPassed}`, timestamp,
      };
      appendRecommendation(result, false);
      log.warn(`🔄 [system-engineer] Fix rolled back: ${proposal.title} (tsc=${tscPassed} tests=${testsPassed})`);
      return result;
    }
  } catch (err) {
    log.warn(`[system-engineer] failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    // v2.0.183: Release the lock so the next run can proceed
    engineerRunning = false;
  }
}

// ─── Helpers ───

function isFileAllowed(filePath: string): boolean {
  // Check forbidden first
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (filePath.startsWith(prefix)) return false;
  }
  // Check allowed
  for (const prefix of ALLOWED_PREFIXES) {
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
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
    const lines = content.split('\n');
    const versionLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('## v2.0.')) versionLines.push(i);
    }
    const start = versionLines.length >= versions ? versionLines[versionLines.length - versions]! : 0;
    return lines.slice(start, start + 80).join('\n');
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
  const files = [
    'src/evolution/thesis-experience.ts:660:730',
    'src/evolution/experience-digester.ts:495:525',
    'src/evolution/reason-analytics.ts:372:420',
    'src/evolution/shadow-trade-engine.ts:408:470',
    'src/evolution/olr-engine.ts:360:380',
    'src/cognition/hacp.ts:905:960',
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
    } catch { /* skip */ }
  }
  return parts.join('\n\n');
}

function parseProposal(content: string): {
  severity: string; category: string; title: string; rootCause: string;
  affectedFile: string;
  proposedFix: { oldCode: string; newCode: string; reason: string };
  testUpdate: { file: string; oldCode: string; newCode: string } | null;
  changelogEntry: string; architectureUpdate?: string;
} | null {
  try {
    let s = content.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) s = fence[1].trim();

    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;

    const p = JSON.parse(s.slice(start, end + 1)) as any;
    return {
      severity: p.severity ?? 'info',
      category: p.category ?? 'unknown',
      title: p.title ?? 'Untitled',
      rootCause: p.rootCause ?? '',
      affectedFile: p.affectedFile ?? p.proposedFix?.file ?? '',
      proposedFix: {
        oldCode: p.proposedFix?.oldCode ?? '',
        newCode: p.proposedFix?.newCode ?? '',
        reason: p.proposedFix?.reason ?? '',
      },
      testUpdate: p.testUpdate ? {
        file: p.testUpdate.file ?? '',
        oldCode: p.testUpdate.oldCode ?? '',
        newCode: p.testUpdate.newCode ?? '',
      } : null,
      changelogEntry: p.changelogEntry ?? '',
      architectureUpdate: p.architectureUpdate,
    };
  } catch {
    log.warn('[system-engineer] Failed to parse proposal');
    return null;
  }
}

function updateChangelog(entry: string): void {
  try {
    const changelogPath = join(PROJECT_ROOT, 'CHANGELOG.md');
    const content = readFileSync(changelogPath, 'utf-8');
    // Insert after the "---\n" that follows the header, before the first version
    const insertPoint = content.indexOf('\n---\n');
    if (insertPoint > 0) {
      const after = content.slice(insertPoint + 5); // after "---\n"
      const newContent = content.slice(0, insertPoint + 5) + '\n## ' + entry + '\n\n' + after;
      writeFileSync(changelogPath, newContent, 'utf-8');
      log.info(`📝 [system-engineer] CHANGELOG.md updated: ${entry}`);
    }
  } catch (err) {
    log.warn(`[system-engineer] CHANGELOG update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function updateArchitecture(update: string): void {
  try {
    const archPath = join(PROJECT_ROOT, 'ARCHITECTURE.md');
    const content = readFileSync(archPath, 'utf-8');
    // Append to end of file
    writeFileSync(archPath, content + '\n\n## System Engineer Update\n' + update + '\n', 'utf-8');
    log.info(`📝 [system-engineer] ARCHITECTURE.md updated`);
  } catch (err) {
    log.warn(`[system-engineer] ARCHITECTURE update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function appendRecommendation(result: AutoFixResult, applied: boolean): void {
  try {
    mkdirSync(join(PROJECT_ROOT, 'data/evolution'), { recursive: true });
    appendFileSync(RECOMMENDATIONS_FILE, JSON.stringify({ ...result, applied }) + '\n');
  } catch { /* non-critical */ }
}