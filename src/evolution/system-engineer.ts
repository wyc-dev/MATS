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
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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

1. ZERO HALLUCINATION — Only modify code you fully understand. You see the actual source code AND test files in the context. Read BOTH before proposing changes. Your fix must not break any existing test.
2. ONE FIX AT A TIME — Propose at most ONE fix per run. Multiple simultaneous changes make rollback impossible if one fails.
3. COMPLETE CODE BLOCKS — Your oldCode must match the EXACT text in the file (including whitespace). Your newCode must be the complete replacement. You may rewrite entire methods or add new helper functions — the oldCode/newCode block can be as large as needed.
4. CAPITAL PRESERVATION FIRST — Never propose a change that could increase risk of capital loss.
5. DIRECTION SAFETY — Never propose a change that could mix BUY and SELL logic or remove direction filtering.
6. TEST UPDATE — If your fix changes behavior, include a testUpdate that verifies the new behavior.
7. CHANGELOG + ARCHITECTURE — Your fix MUST include a changelogEntry. If architecture changes, include architectureUpdate.
8. READ THE TESTS — Before proposing a fix, read the test files shown in context. Understand what the tests assert. Your fix must keep all tests passing. If a test is wrong, fix the test too — but explain why the test was wrong.
9. TOP TIER PRODUCTION GRADE — Every modification must be production-grade: explicit types, complete error handling, no silent failures, no hardcoded magic numbers, match existing codebase conventions.
10. DEPUTY AUTHORITY — You are not a suggestion box. You have full authority to refactor, restructure, and rewrite code within your allowed scope. Do not artificially limit your fixes to "minimal" changes. If the root cause requires a deeper fix (e.g. adding interface fields, restructuring a method, adding helper functions), do it properly. You have the output token budget for large changes — use it.

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

// v2.0.188: Failed fix memory — prevents retrying the same fix that already failed.
// v2.0.202: Keyed by file path only (was file:title — LLM could bypass by changing title).
// Expires after 1 hour (in case the underlying issue changes).
const failedFixes = new Map<string, number>(); // file path → timestamp of failure
const FAILED_FIX_TTL_MS = 3600_000; // 1 hour

// v2.0.202: Hard block list — methods/patterns the SE must NEVER modify.
// These have been verified correct and repeatedly targeted by the SE.
// If the diagnosis mentions these, reject immediately without calling Phase 2.
const BLOCKED_PATTERNS: { file: string; pattern: RegExp; reason: string }[] = [
  { file: 'src/evolution/shadow-trade-engine.ts', pattern: /getStats/i, reason: 'getStats() dedup logic is verified correct — do NOT modify' },
  { file: 'src/evolution/thesis-experience.ts', pattern: /checkThesisHistory/i, reason: 'checkThesisHistory() direction filter is correct — do NOT remove' },
  { file: 'src/evolution/reason-analytics.ts', pattern: /findSimilar/i, reason: 'SimilarTradeRetriever.findSimilar() side filter is correct — do NOT remove' },
];

// v2.0.208: Permanent feedback log (gitignored) — records every SE run for debugging
const FEEDBACK_LOG = join(PROJECT_ROOT, 'SYSTEM_ENGINEER_FEEDBACK.md');

function logFeedback(phase: string, result: string, title: string, file: string, details: string): void {
  try {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `\n## [${ts}] [${phase}] [${result}]\n\n- **Title**: ${title}\n- **File**: ${file}\n- **Details**: ${details}\n`;
    appendFileSync(FEEDBACK_LOG, line + '\n---\n', 'utf-8');
  } catch { /* non-critical */ }
}

export async function runSystemEngineer(records: ThesisExperienceRecord[]): Promise<AutoFixResult | null> {
  // v2.0.183: Prevent overlapping runs
  if (engineerRunning) {
    log.info(`🔧 [system-engineer] Previous run still in progress — skipping`);
    return null;
  }
  engineerRunning = true;
  try {
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

  // v2.0.201: Two-phase approach — Phase 1 diagnoses which file+issue,
  // Phase 2 reads the FULL file and asks for exact oldCode/newCode.
  // Previous single-phase approach showed only 150 lines per file, causing
  // the LLM to hallucinate oldCode for code it couldn't see (e.g. recordClose
  // at line 472 was beyond the 150-line limit).

  const provider = getActiveProvider();

  // v2.0.202: Build list of recently failed files to warn the LLM
  const failedFiles: string[] = [];
  for (const [file, ts] of failedFixes) {
    if ((timestamp - ts) < FAILED_FIX_TTL_MS) {
      failedFiles.push(file);
    }
  }

  // v2.0.209: Build list of recently fixed files from CHANGELOG to prevent
  // the LLM from re-diagnosing the same issue that was already fixed.
  // The LLM keeps targeting shadow-trade-engine.ts because it doesn't know
  // that stale S/R levels and stale features were ALREADY fixed in previous runs.
  const recentlyFixed = changelogTail
    .split('\n')
    .filter(l => l.startsWith('## v2.0.'))
    .map(l => l.slice(4))
    .slice(0, 10); // last 10 changelog entries

  // ─── Phase 1: Diagnosis ───
  const fileSummaries = readFileSummaries();

  const phase1Prompt = `## System Context

### SystemEngineer.md (your operating manual)
${systemEngineerMd.slice(0, 2000)}

### ARCHITECTURE.md (system architecture)
${architectureMd.slice(0, 2000)}

### CHANGELOG.md (last 3 versions)
${changelogTail}

### Loop Engineering Memory (known bugs)
${loopMemory.slice(0, 1500)}

${failedFiles.length > 0 ? `## ⚠️ Recently Failed Files (DO NOT propose fixes for these — they failed within the last hour)
${failedFiles.map(f => `- ${f}`).join('\n')}

` : ''}## Recently Applied Fixes (these issues are ALREADY FIXED — do not re-diagnose)
${recentlyFixed.map(f => `- ${f}`).join('\n')}

## Trade Records (last 20 of ${records.length})
${tradeSummary}

## Per-Symbol Direction Summary
${dirSummary}

## File Summaries (you can modify files under src/evolution/, src/cognition/, src/analysis/, src/agents/, tests/)
${fileSummaries}

## Known Good Code (DO NOT attempt to "fix" these — they are already correct)
- shadow-trade-engine.ts getStats(): The dedup logic (step 3 checks p.id === r.id) correctly prevents double-counting between positions[] and recentResults[]. This has been verified. Do NOT propose changes to this method.
- thesis-experience.ts checkThesisHistory(): Direction-filtered pWin (sameDirMatches) is correct. Do NOT remove the direction filter.
- reason-analytics.ts SimilarTradeRetriever.findSimilar(): The side parameter filter is correct. Do NOT remove it.

## Your Task (Phase 1: Diagnosis)
Find the SINGLE MOST IMPACTFUL issue in the learning/decision system that is causing losses or preventing the system from learning correctly.

IMPORTANT: Look at ALL files in the File Summaries above — do not fixate on shadow-trade-engine.ts. The system has many components (OLR, EXP, RIL, EM Cycle, HACP, agents, analysis). Consider issues in:
- src/evolution/thesis-experience.ts (EXP memory — thesis win rates)
- src/evolution/experience-digester.ts (experience classification)
- src/evolution/reason-analytics.ts (RIL — pattern clustering, similar trades)
- src/evolution/olr-engine.ts (online logistic regression)
- src/evolution/em-clustering.ts (EM pattern clustering)
- src/evolution/cycle-summary.ts (EM Cycle Chain — market continuity)
- src/cognition/hacp.ts (HACP decision protocol)
- src/agents/base-agent.ts (agent LLM call + confidence)
- src/agents/meta-agent.ts (Meta-Agent arbitration + entryThesis)
- src/analysis/ (sentiment, S/R, ATR, chaos, options, news)

If a file is listed in "Recently Failed Files" above, DO NOT propose a fix for it.
If an issue is listed in "Recently Applied Fixes" above, it is ALREADY FIXED — find a DIFFERENT issue.

Identify the file and describe the issue. In Phase 2, you will see the FULL file content and be asked to provide exact oldCode/newCode.

Respond with EXACTLY ONE JSON object:
{"severity":"critical|warning|info","category":"...","title":"...","rootCause":"specific description of what's wrong and why","affectedFile":"src/evolution/...","diagnosis":"what the fix should do","changelogEntry":"v2.0.XXX: description"}

If you find NO issues worth fixing, respond with:
{"severity":"info","category":"none","title":"No issues found","rootCause":"","affectedFile":"","diagnosis":"","changelogEntry":""}`;

  log.info(`🔧 [system-engineer] Phase 1: Diagnosis (sending trade data + file summaries)...`);
  const phase1Response = await provider.chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: phase1Prompt },
    ],
    temperature: 0.2,
    model: getAgentModel('terminal_agent'),
    timeoutMs: 120_000,
    maxTokens: 8192, // Deputy-level: diagnosis JSON can be detailed
  });

  const diagnosis = parseDiagnosis(phase1Response.content);
  if (!diagnosis || !diagnosis.affectedFile || diagnosis.affectedFile === '') {
    log.info(`🔧 [system-engineer] No actionable issue identified in Phase 1`);
    logFeedback('Phase 1', 'NO_ISSUE', 'No issue found', '', 'LLM found no actionable issue');
    return null;
  }

  log.info(`🔧 [system-engineer] Phase 1 complete: ${diagnosis.title} → ${diagnosis.affectedFile}`);

  // v2.0.202: Hard block list — check if the diagnosis targets a known-good method.
  // This prevents wasting a Phase 2 LLM call on methods that have been verified correct.
  for (const block of BLOCKED_PATTERNS) {
    if (diagnosis.affectedFile === block.file) {
      const textToCheck = `${diagnosis.title} ${diagnosis.rootCause} ${diagnosis.diagnosis}`;
      if (block.pattern.test(textToCheck)) {
        log.warn(`🚫 [system-engineer] BLOCKED: "${diagnosis.title}" targets ${block.reason}`);
        logFeedback('Phase 1', 'BLOCKED', diagnosis.title, diagnosis.affectedFile, block.reason);
        return null;
      }
    }
  }

  // v2.0.202: Check if this FILE had any failed fix recently.
  // Previous file:title key allowed the LLM to retry the same file with a
  // slightly different title, causing repeated failures on the same file.
  // Now: if ANY fix on a file failed within the cooldown, skip that file.
  const fixKey = diagnosis.affectedFile; // file-only key
  const lastFailed = failedFixes.get(fixKey);
  if (lastFailed && (timestamp - lastFailed) < FAILED_FIX_TTL_MS) {
    log.info(`🔧 [system-engineer] Skipping "${diagnosis.title}" — ${diagnosis.affectedFile} had a failed fix ${Math.round((timestamp - lastFailed) / 1000)}s ago, will retry in ${Math.round(FAILED_FIX_TTL_MS / 60000)}min`);
    logFeedback('Phase 1', 'COOLDOWN', diagnosis.title, diagnosis.affectedFile, `File failed ${Math.round((timestamp - lastFailed) / 1000)}s ago, cooldown ${Math.round(FAILED_FIX_TTL_MS / 60000)}min`);
    return null;
  }

  // Validate scope
  if (!isFileAllowed(diagnosis.affectedFile)) {
    log.warn(`🚫 [system-engineer] REJECTED: ${diagnosis.affectedFile} is outside allowed scope`);
    return null;
  }

  // ─── Phase 2: Exact Fix ───
  const fullFileContent = readFileSafe(diagnosis.affectedFile);
  if (fullFileContent.startsWith('(file not found') || fullFileContent.startsWith('(read failed')) {
    log.warn(`🚫 [system-engineer] Could not read ${diagnosis.affectedFile}`);
    return null;
  }

  const phase2Prompt = `## Phase 2: Exact Code Fix

You identified this issue in Phase 1:
- **Title**: ${diagnosis.title}
- **File**: ${diagnosis.affectedFile}
- **Root Cause**: ${diagnosis.rootCause}
- **Diagnosis**: ${diagnosis.diagnosis}

## Full Source Code of ${diagnosis.affectedFile}
\`\`\`typescript
${fullFileContent}
\`\`\`

## Your Task
Provide the EXACT code replacement to fix this issue.

You are a deputy with full authority to refactor. You may rewrite entire methods, add new helper functions, update interfaces, or restructure code — as long as the fix is correct and all tests pass.

Rules:
1. oldCode must be EXACT text from the file above (copy-paste, including whitespace and indentation)
2. newCode must be the complete replacement for oldCode
3. You may make large changes — do not artificially limit your fix to "minimal" changes if the issue requires a deeper fix
4. Do not break any existing tests — if your fix changes behavior, include a testUpdate
5. If you add new fields to an interface, update ALL places that construct objects of that type
6. If your fix spans multiple methods, include all of them in oldCode/newCode as one contiguous block

Respond with EXACTLY ONE JSON object:
{"severity":"${diagnosis.severity}","category":"${diagnosis.category}","title":"${diagnosis.title}","rootCause":"${diagnosis.rootCause}","affectedFile":"${diagnosis.affectedFile}","proposedFix":{"oldCode":"EXACT text from the file","newCode":"replacement text","reason":"why this fix is correct"},"testUpdate":{"file":"tests/...","oldCode":"...","newCode":"..."},"changelogEntry":"${diagnosis.changelogEntry}"}`;

  log.info(`🔧 [system-engineer] Phase 2: Generating exact fix for ${diagnosis.affectedFile} (${fullFileContent.split('\n').length} lines)...`);
  const phase2Response = await provider.chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: phase2Prompt },
    ],
    temperature: 0.1,
    model: getAgentModel('terminal_agent'),
    timeoutMs: 120_000,
    maxTokens: 16384, // Deputy-level: large refactors need room to breathe
  });

  let proposal = parseProposal(phase2Response.content);
  if (!proposal || !proposal.proposedFix.oldCode || !proposal.proposedFix.newCode) {
    log.info(`🔧 [system-engineer] No actionable fix proposed in Phase 2`);
    logFeedback('Phase 2', 'NO_FIX', diagnosis.title, diagnosis.affectedFile, 'LLM did not produce valid oldCode/newCode');
    return null;
  }

  try {
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
      // v2.0.201: Try whitespace-normalized match — LLMs often get leading/trailing
      // whitespace wrong but the actual code is correct. If normalized match works,
      // find the exact text in the file and replace it.
      const normalizedOld = proposal.proposedFix.oldCode.trim().replace(/\s+/g, ' ');
      const normalizedFile = originalContent.replace(/\s+/g, ' ');
      if (normalizedFile.includes(normalizedOld)) {
        // Find the actual text in the original file that corresponds to the normalized match
        // Use a sliding window to find the exact substring
        const fileLines = originalContent.split('\n');
        const oldLines = proposal.proposedFix.oldCode.trim().split('\n');
        const oldFirstLine = oldLines[0]!.trim();
        const oldLastLine = oldLines[oldLines.length - 1]!.trim();
        
        // Search for the block in the file
        let foundStart = -1;
        for (let i = 0; i < fileLines.length; i++) {
          if (fileLines[i]!.trim() === oldFirstLine) {
            // Check if subsequent lines match (trimmed)
            let match = true;
            for (let j = 1; j < oldLines.length; j++) {
              if (i + j >= fileLines.length) { match = false; break; }
              if (fileLines[i + j]!.trim() !== oldLines[j]!.trim()) { match = false; break; }
            }
            if (match && i + oldLines.length <= fileLines.length) {
              // Verify the last line matches too
              if (fileLines[i + oldLines.length - 1]!.trim() === oldLastLine) {
                foundStart = i;
                break;
              }
            }
          }
        }
        
        if (foundStart >= 0) {
          // Extract the exact text from the file
          const exactOldCode = fileLines.slice(foundStart, foundStart + oldLines.length).join('\n');
          log.info(`🔧 [system-engineer] Whitespace-normalized match found at line ${foundStart + 1} — using exact file text`);
          // Replace oldCode with the exact text from the file
          proposal.proposedFix.oldCode = exactOldCode;
        } else {
          log.warn(`🚫 [system-engineer] oldCode not found in ${targetFile} — normalized match also failed`);
          log.warn(`   oldCode first line: "${oldFirstLine}"`);
          log.warn(`   oldCode last line: "${oldLastLine}"`);
          log.warn(`   oldCode lines: ${oldLines.length}`);
          return {
            applied: false, title: proposal.title, file: targetFile, reason: 'oldCode not found (hallucination detected)',
            tscPassed: false, testsPassed: false, rolledBack: false,
            changelogEntry: '', error: 'oldCode mismatch', timestamp,
          };
        }
      } else {
        log.warn(`🚫 [system-engineer] oldCode not found in ${targetFile} — LLM may have hallucinated the exact text`);
        // Log first 100 chars of oldCode for debugging
        log.warn(`   oldCode preview: "${proposal.proposedFix.oldCode.slice(0, 100)}..."`);
        return {
          applied: false, title: proposal.title, file: targetFile, reason: 'oldCode not found (hallucination detected)',
          tscPassed: false, testsPassed: false, rolledBack: false,
          changelogEntry: '', error: 'oldCode mismatch', timestamp,
        };
      }
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
    let tscErrorOutput = '';
    try {
      const tscOutput = execSync('npx tsc --noEmit 2>&1', { cwd: PROJECT_ROOT, timeout: 30_000, stdio: 'pipe', encoding: 'utf-8' });
      tscPassed = true;
      log.info(`✅ [system-engineer] tsc passed`);
    } catch (err: any) {
      // v2.0.199: Capture actual tsc error output, not just "Command failed"
      tscErrorOutput = String(err?.stdout ?? err?.stderr ?? err?.message ?? String(err));
      log.warn(`❌ [system-engineer] tsc FAILED: ${tscErrorOutput.slice(0, 500)}`);
    }

    // v2.0.202: If tsc failed, try ONE retry — send the tsc error back to the LLM
    // so it can fix the type error. This handles cases where the fix is conceptually
    // correct but has a type mismatch (e.g. missing interface field).
    if (!tscPassed && tscErrorOutput) {
      log.info(`🔧 [system-engineer] Phase 2b: tsc error retry — sending error to LLM for correction...`);
      // Rollback first to get the original file content
      writeFileSync(fullPath, originalContent, 'utf-8');
      if (originalTestContent && testFile) {
        writeFileSync(join(PROJECT_ROOT, testFile), originalTestContent, 'utf-8');
      }

      const retryPrompt = `## Phase 2b: Fix tsc Error

Your previous fix for ${targetFile} failed tsc --noEmit with this error:

\`\`\`
${tscErrorOutput.slice(0, 2000)}
\`\`\`

## Your previous fix
- oldCode: \`${proposal.proposedFix.oldCode.slice(0, 200)}...\`
- newCode: \`${proposal.proposedFix.newCode.slice(0, 200)}...\`

## Full Source Code of ${targetFile}
\`\`\`typescript
${originalContent}
\`\`\`

Fix the tsc error. The issue is likely a type mismatch — you may need to update an interface, add a missing field, or fix a type annotation.

Respond with EXACTLY ONE JSON object with the CORRECTED fix:
{"severity":"${proposal.severity ?? 'warning'}","category":"${proposal.category ?? 'fix'}","title":"${proposal.title}","rootCause":"${proposal.rootCause ?? ''}","affectedFile":"${targetFile}","proposedFix":{"oldCode":"EXACT text from the file","newCode":"corrected replacement text","reason":"why this fix is correct"},"testUpdate":null,"changelogEntry":"${proposal.changelogEntry ?? ''}"}`;

      try {
        const retryResponse = await provider.chat({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: retryPrompt },
          ],
          temperature: 0.1,
          model: getAgentModel('terminal_agent'),
          timeoutMs: 120_000,
          maxTokens: 16384, // Deputy-level: corrected fix may be as large as original
        });

        const retryProposal = parseProposal(retryResponse.content);
        if (retryProposal && retryProposal.proposedFix.oldCode && retryProposal.proposedFix.newCode) {
          // Check if the retry oldCode matches the original file
          if (originalContent.includes(retryProposal.proposedFix.oldCode)) {
            log.info(`🔧 [system-engineer] Retry fix accepted — applying corrected fix...`);
            const retryContent = originalContent.replace(retryProposal.proposedFix.oldCode, retryProposal.proposedFix.newCode);
            writeFileSync(fullPath, retryContent, 'utf-8');

            // Re-run tsc
            try {
              execSync('npx tsc --noEmit 2>&1', { cwd: PROJECT_ROOT, timeout: 30_000, stdio: 'pipe', encoding: 'utf-8' });
              tscPassed = true;
              log.info(`✅ [system-engineer] tsc passed (retry)`);
              // Update proposal for the test/changelog steps
              proposal = retryProposal;
            } catch (retryErr: any) {
              const retryTscErrors = String(retryErr?.stdout ?? retryErr?.stderr ?? retryErr?.message ?? String(retryErr));
              log.warn(`❌ [system-engineer] tsc FAILED (retry): ${retryTscErrors.slice(0, 500)}`);
              // Rollback retry
              writeFileSync(fullPath, originalContent, 'utf-8');
            }
          } else {
            log.warn(`🚫 [system-engineer] Retry oldCode not found in file — giving up`);
          }
        } else {
          log.warn(`🚫 [system-engineer] Retry did not produce a valid fix — giving up`);
        }
      } catch (retryErr) {
        log.warn(`❌ [system-engineer] Retry LLM call failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
      }
    }

    // Run safety net: npm test
    let testsPassed = false;
    if (tscPassed) {
      log.info(`🔧 [system-engineer] Running npm test...`);
      try {
        const output = execSync('npm test 2>&1', { cwd: PROJECT_ROOT, timeout: 60_000, stdio: 'pipe', encoding: 'utf-8' });
        // v2.0.201: Parse the vitest summary line, not the entire output.
        // The output contains log messages with "failed" (e.g. "digestTrade LLM failed")
        // which caused false negatives with the old `!output.includes('failed')` check.
        // Look for the actual test summary: "Tests  X passed (Y)" or "Tests  X failed (Y)"
        const testSummaryLine = output.split('\n').find(l => /^\s*Tests\s+/.test(l));
        if (testSummaryLine) {
          testsPassed = testSummaryLine.includes('passed') && !testSummaryLine.includes('failed');
        } else {
          // Fallback: if no summary line found, check exit code (execSync throws on non-zero)
          testsPassed = true;
        }
        if (testsPassed) {
          log.info(`✅ [system-engineer] tests passed`);
        } else {
          log.warn(`❌ [system-engineer] tests FAILED: ${testSummaryLine?.trim() ?? 'no summary line'}`);
        }
      } catch (err: any) {
        // execSync throws on non-zero exit code — test runner returns non-zero on failure
        const output = err?.stdout ?? err?.message ?? String(err);
        const testSummaryLine = String(output).split('\n').find(l => /^\s*Tests\s+/.test(l));
        log.warn(`❌ [system-engineer] tests FAILED: ${testSummaryLine?.trim() ?? output.slice(0, 200)}`);
      }
    }

    // Decision: apply or rollback
    if (tscPassed && testsPassed) {
      // v2.0.204: No-op detection — if the fix didn't actually change the file
      // content (oldCode === newCode, or the replacement produced identical output),
      // reject it as a false positive. The SE sometimes "fixes" issues by replacing
      // code with identical or equivalent code, passing tsc+test trivially, and
      // claiming success without doing anything.
      const finalContent = readFileSync(fullPath, 'utf-8');
      if (finalContent === originalContent) {
        log.warn(`🚫 [system-engineer] NO-OP DETECTED: fix produced identical file content — rejecting as false positive`);
        log.warn(`   This means the SE replaced code with identical text. The issue may require changes outside the SE's allowed scope.`);
        // Record as failed so this file gets cooldown
        failedFixes.set(targetFile, timestamp);
        const result: AutoFixResult = {
          applied: false, title: proposal.title, file: targetFile,
          reason: 'No-op fix — file content unchanged (false positive)',
          tscPassed, testsPassed, rolledBack: false,
          changelogEntry: '', error: 'no-op detected', timestamp,
        };
        appendRecommendation(result, false);
        logFeedback('Phase 2', 'NO_OP', proposal.title, targetFile, 'Fix produced identical file content — false positive');
        return result;
      }

      // v2.0.204: Comment-only detection — if the fix only added/changed comments
      // (no actual code logic changed), reject it. Strip comments + whitespace and
      // compare. This catches SE fixes that add a clarifying comment and claim
      // success without fixing the actual issue.
      const stripNonCode = (s: string) => s
        .replace(/\/\/[^\n]*/g, '')     // strip line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
        .replace(/\s+/g, ' ')           // collapse whitespace
        .trim();
      if (stripNonCode(finalContent) === stripNonCode(originalContent)) {
        log.warn(`🚫 [system-engineer] COMMENT-ONLY DETECTED: fix only changed comments/whitespace, no code logic changed — rejecting as false positive`);
        log.warn(`   The SE added a comment but didn't fix the actual issue. The issue may require changes outside the SE's allowed scope.`);
        // Rollback the comment-only change
        writeFileSync(fullPath, originalContent, 'utf-8');
        if (originalTestContent && testFile) {
          writeFileSync(join(PROJECT_ROOT, testFile), originalTestContent, 'utf-8');
        }
        failedFixes.set(targetFile, timestamp);
        const result: AutoFixResult = {
          applied: false, title: proposal.title, file: targetFile,
          reason: 'Comment-only fix — no code logic changed (false positive)',
          tscPassed, testsPassed, rolledBack: true,
          changelogEntry: '', error: 'comment-only detected', timestamp,
        };
        appendRecommendation(result, false);
        logFeedback('Phase 2', 'COMMENT_ONLY', proposal.title, targetFile, 'Fix only changed comments/whitespace — no code logic changed');
        return result;
      }

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
      logFeedback('Phase 2', 'SUCCESS', proposal.title, targetFile, `tsc=${tscPassed} tests=${testsPassed} | ${proposal.proposedFix.reason.slice(0, 200)}`);
      log.info(`✅ [system-engineer] Triggering restart to load new code (exit code 42)...`);
      // v2.0.187: Exit with code 42 so engineer-loop.sh restarts the process
      // with the new code. Only do this if running under SYSTEM_ENGINEER_ENABLED
      // (i.e. via npm run engineer). Under npm start, the process just continues
      // with old code in memory — the fix takes effect on next manual restart.
      if (process.env['SYSTEM_ENGINEER_ENABLED'] === 'true') {
        // Give the log time to flush before exiting
        setTimeout(() => process.exit(42), 1000);
      }
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
      // v2.0.188: Record this failure so we don't retry the same fix for 1 hour
      failedFixes.set(fixKey, timestamp); // file-only key (v2.0.202)
      log.warn(`🔄 [system-engineer] Fix rolled back: ${proposal.title} (tsc=${tscPassed} tests=${testsPassed}) — ${targetFile} will not retry for ${FAILED_FIX_TTL_MS / 60000}min`);
      logFeedback('Phase 2', 'ROLLED_BACK', proposal.title, targetFile, `tsc=${tscPassed} tests=${testsPassed} | ${proposal.proposedFix.reason.slice(0, 200)}`);
      return result;
    }
  } catch (err) {
    log.warn(`[system-engineer] failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    // v2.0.183: Release the lock so the next run can proceed
    engineerRunning = false;
  }
  } catch (outerErr) {
    // v2.0.198: Outer catch — if anything before the inner try fails, release the lock
    log.warn(`[system-engineer] outer error: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`);
    return null;
  } finally {
    // v2.0.198: Guarantee the lock is ALWAYS released, even if the inner
    // finally somehow doesn't execute (e.g. process.exit(42) in the success path)
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

function readFileSummaries(): string {
  // v2.0.201: Show file name + line count + first 50 lines as a summary.
  // The full file is read in Phase 2 after the LLM identifies which file to fix.
  const keyFiles = [
    'src/evolution/thesis-experience.ts',
    'src/evolution/experience-digester.ts',
    'src/evolution/reason-analytics.ts',
    'src/evolution/shadow-trade-engine.ts',
    'src/evolution/olr-engine.ts',
    'src/evolution/em-clustering.ts',
    'src/evolution/cycle-summary.ts',
    'src/evolution/first-passage.ts',
    'src/evolution/evolution-utils.ts',
    'src/evolution/direction-audit.ts',
    'src/evolution/pattern-tag-tracker.ts',
    'src/cognition/hacp.ts',
    'src/agents/base-agent.ts',
    'src/agents/meta-agent.ts',
    'src/analysis/sentiment-engine.ts',
    'src/analysis/support-resistance.ts',
    'src/analysis/atr.ts',
    'src/analysis/planck-chaos.ts',
  ];

  const parts: string[] = [];
  for (const file of keyFiles) {
    try {
      const content = readFileSync(join(PROJECT_ROOT, file), 'utf-8');
      const lines = content.split('\n');
      const previewLines = 50;
      const preview = lines.slice(0, previewLines).join('\n');
      parts.push(`### ${file} (${lines.length} lines total, showing first ${previewLines})\n\`\`\`typescript\n${preview}\n\`\`\``);
    } catch { /* skip */ }
  }

  // Also list test files (names only — they're short and will be read in Phase 2 if needed)
  const testFiles: string[] = [];
  const collectTests = (dir: string) => {
    try {
      const entries = readdirSync(join(PROJECT_ROOT, dir));
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const absPath = join(PROJECT_ROOT, fullPath);
        const stat = statSync(absPath);
        if (stat.isDirectory()) {
          collectTests(fullPath);
        } else if (entry.endsWith('.ts')) {
          testFiles.push(fullPath);
        }
      }
    } catch { /* skip */ }
  };
  collectTests('tests');
  if (testFiles.length > 0) {
    parts.push(`### Test Files\n${testFiles.map(f => `- ${f}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

function parseDiagnosis(content: string): {
  severity: string; category: string; title: string; rootCause: string;
  affectedFile: string; diagnosis: string; changelogEntry: string;
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
      affectedFile: p.affectedFile ?? '',
      diagnosis: p.diagnosis ?? '',
      changelogEntry: p.changelogEntry ?? '',
    };
  } catch {
    log.warn('[system-engineer] Failed to parse diagnosis');
    return null;
  }
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
    if (start < 0) {
      log.warn('[system-engineer] Failed to parse proposal: no JSON object found');
      log.warn(`   Response preview: "${content.slice(0, 200)}..."`);
      return null;
    }
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) {
      log.warn('[system-engineer] Failed to parse proposal: JSON object not closed (truncated response)');
      log.warn(`   Response preview: "${content.slice(0, 200)}..."`);
      return null;
    }

    let jsonStr = s.slice(start, end + 1);
    let p: any;
    try {
      p = JSON.parse(jsonStr);
    } catch (parseErr) {
      // v2.0.205: Try to fix common JSON issues from LLM output
      // 1. Remove trailing commas before } or ]
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
      try {
        p = JSON.parse(jsonStr);
      } catch (parseErr2) {
        log.warn(`[system-engineer] Failed to parse proposal: JSON.parse failed — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        log.warn(`   JSON preview: "${jsonStr.slice(0, 300)}..."`);
        return null;
      }
    }
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