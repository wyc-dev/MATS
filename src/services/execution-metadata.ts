// ─── Execution metadata helpers (pure, testable) ──────────────────────
// v2.0.870-execution-metadata attack round: single sanitise entry point
// for the `metadata.execution` payload. Persisted pollution (string /
// number / array / null / oversized fields) must NEVER reach the DB or
// crash the flush path. Pure functions — no I/O, no side effects.

import type { ExecutionGate, ExecutionReport } from '../types/index.ts';

const MAX_GATES = 50;
const MAX_GATE_NAME = 40;
const MAX_REASON = 500;
const MAX_ACTION = 20;
const MAX_BLOCKED_BY = 40;

/** Match-normalise a symbol for execution rows: lowercase + strip the `xyz:`
 *  prefix, mirroring `normalizeSymbol` semantics (v2.0.873-P9-exec-upload:
 *  the row key may be `xyz:GOLD` while the audit symbol is `xyz:gold` or
 *  `gold` — case/prefix drift must never miss the match). */
function normSymbolForExec(s: string): string {
  const lowered = s.toLowerCase();
  return lowered.startsWith('xyz:') ? lowered.slice(4) : lowered;
}

/** v2.0.870-FIX-C1(主神檢查 mats_web_app 適配): 通用 close block——
 *  skeptics 同 sentinel 都可以 attach 去 metadata.execution, 帶各自標籤。
 *  之前第四參數硬編碼 skeptics——sentinel/prefilter hold 被誤標「CLOSE BLOCKED」——
 *  前端訊號唔準確。blockedBy/gate default 係 skeptics（向後兼容）。 */
export interface CloseBlock {
  reason: string;
  /** 標籤——default 'skeptics'（向後兼容） */
  blockedBy?: string;
  /** gate 名——default 'skeptics-close-validation' */
  gate?: string;
}

/** Sanitise an unknown execution payload into a valid ExecutionReport.
 *  Returns null when the payload is not a usable object (string / number /
 *  array / null / missing boolean `blocked`). Every field is length-capped
 *  and type-guarded — oversized or garbage input is clamped, never dropped
 *  wholesale (a valid report with one bad gate still surfaces). */
export function sanitizeExecutionReport(execution: unknown): ExecutionReport | null {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return null;
  const e = execution as Record<string, unknown>;
  if (typeof e['blocked'] !== 'boolean') return null;

  const gates: ExecutionGate[] = Array.isArray(e['gates'])
    ? e['gates']
        .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object' && !Array.isArray(g)
          && typeof g['gate'] === 'string' && g['gate'].trim().length > 0)
        .map((g) => ({
          gate: (g['gate'] as string).trim().slice(0, MAX_GATE_NAME),
          passed: g['passed'] === true,
          reason: typeof g['reason'] === 'string' ? g['reason'].slice(0, MAX_REASON) : '',
        }))
        .slice(0, MAX_GATES)
    : [];

  const report: ExecutionReport = {
    finalAction: typeof e['finalAction'] === 'string' ? e['finalAction'].slice(0, MAX_ACTION) : 'hold',
    blocked: e['blocked'],
    gates,
  };
  if (typeof e['blockedBy'] === 'string' && e['blockedBy']) {
    report.blockedBy = e['blockedBy'].slice(0, MAX_BLOCKED_BY);
  }
  if (typeof e['blockedReason'] === 'string' && e['blockedReason']) {
    report.blockedReason = e['blockedReason'].slice(0, MAX_REASON);
  }
  return report;
}

/** v2.0.873-P9-exec-upload: Convert a decision-audit trail (symbol + gates +
 *  executed flag) into a sanitised ExecutionReport and attach it to the
 *  matching pending analysis row (per-symbol visibility in Supabase).
 *  Pure — mutates the analyses array in place, returns the report (or null).
 *
 *  WHY: before this, per-symbol entry gates (mom24-guard / chase-tail / ...)
 *  only reached the in-memory decisionAudit (cap 50, backend-only). Clients
 *  reading asset_analyses saw consensus.action='buy' with NO metadata.execution
 *  — and would execute a HARD-BLOCKED signal. This closes that hole: every
 *  recordDecisionAudit() call now patches its row's metadata.execution, and
 *  the cycle-end atomic flush ships it to Supabase.
 *
 *  Execution-report shape mirrors flushPendingAnalyses' execReport so the two
 *  sources are interchangeable (flush can overwrite for the active symbol). */
export function attachAuditExecutionToAnalyses(
  analyses: Array<{ symbol: string; metadata: Record<string, unknown> }>,
  symbol: string,
  action: 'buy' | 'sell',
  gates: Array<{ gate: string; passed: boolean; reason: string }>,
  executed: boolean,
): ExecutionReport | null {
  if (!symbol || typeof symbol !== 'string') return null;
  if (!Array.isArray(gates)) return null;

  const failedGate = gates.find((g) => !!g && typeof g === 'object' && g.passed === false && typeof g.gate === 'string');
  const report: ExecutionReport = {
    finalAction: executed ? action : 'hold',
    blocked: !executed && !!failedGate,
    gates: gates
      .filter((g): g is { gate: string; passed: boolean; reason: string } =>
        !!g && typeof g === 'object' && typeof g.gate === 'string')
      .map((g) => ({
        gate: g.gate.trim().slice(0, MAX_GATE_NAME),
        passed: g.passed === true,
        reason: typeof g.reason === 'string' ? g.reason.slice(0, MAX_REASON) : '',
      }))
      .slice(0, MAX_GATES),
  };
  if (failedGate) {
    report.blockedBy = (failedGate.gate || 'gate').trim().slice(0, MAX_BLOCKED_BY);
    report.blockedReason = String(failedGate.reason ?? '').slice(0, MAX_REASON);
  }

  const safe = sanitizeExecutionReport(report);
  if (!safe) return null;
  const sym = normSymbolForExec(symbol);
  for (const a of analyses) {
    if (!a || typeof a !== 'object' || typeof a.symbol !== 'string') continue;
    if (normSymbolForExec(a.symbol) !== sym) continue;
    const meta = a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata)
      ? { ...a.metadata }
      : {};
    meta['execution'] = safe;
    a.metadata = meta;
  }
  return safe;
}

/** Attach execution metadata to pending analyses (single atomic flush).
 *  Pure — mutates the analyses array in place. Skeptics close blocks take
 *  precedence over the active-symbol gate report (close path is more
 *  severe). Garbage rows / garbage metadata are skipped, never crash. */
export function attachExecutionToAnalyses(
  analyses: Array<{ symbol: string; metadata: Record<string, unknown> }>,
  execReport: ExecutionReport | null,
  execSym: string,
  blocks: ReadonlyMap<string, CloseBlock>,
): void {
  const normExecSym = String(execSym ?? '').toLowerCase();
  for (const a of analyses) {
    if (!a || typeof a !== 'object' || typeof a.symbol !== 'string') continue;
    const meta = a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata)
      ? { ...a.metadata }
      : {};
    const sym = a.symbol.toLowerCase();

    if (execReport && sym === normExecSym) meta['execution'] = execReport;

    const block = blocks.get(sym);
    if (block && typeof block.reason === 'string') {
      const reason = block.reason.slice(0, MAX_REASON);
      // v2.0.870-FIX-C1: blockedBy/gate 由 block 帶（sentinel ≠ skeptics）——
      // 向後兼容 default skeptics
      const blockedBy = typeof block.blockedBy === 'string' && block.blockedBy.trim()
        ? block.blockedBy.trim().slice(0, MAX_BLOCKED_BY)
        : 'skeptics';
      const gate = typeof block.gate === 'string' && block.gate.trim()
        ? block.gate.trim().slice(0, MAX_GATE_NAME)
        : 'skeptics-close-validation';
      meta['execution'] = {
        finalAction: 'hold',
        blocked: true,
        blockedBy,
        blockedReason: reason,
        gates: [{ gate, passed: false, reason }],
      };
    }
    a.metadata = meta;
  }
}
