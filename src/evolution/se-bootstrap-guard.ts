// ═══════════════════════════════════════════════════════════════════════════
// se-bootstrap-guard.ts —— Judge Layer（v2.0.877-P9-se-self-mod, 主神 2026-09-13）
//
// 問題: SE(System Engineer)嘅 ALLOWED scope 包含 src/evolution/ —— 即係佢
// 已經可以改自己嘅 code + SystemEngineer.md。冇 guard 之下,SE 可以「拆自己嘅
// 安全網」: 改壞測試判定 / scope / rollback → bootstrapping 危機(考試官自己改分數)。
//
// 本檔 = 不可被 SE 修改嘅 Judge Layer（system-engineer.ts 嘅 FORBIDDEN_PREFIXES
// 必須包含本檔路徑——G10 測試鎖死）。核心不變式:
//   「評判標準永遠唔可以由被評判者自己改。」
//
// 三層防線:
//   ① pre-apply: 自改提案嘅「要刪除文本」(oldCode) 唔可以包含 safety-critical
//      fingerprint(刪 = 拆安全網)→ reject,唔 apply。
//   ② post-apply: 改動後源碼必須仍然包含全部 safety-critical 結構
//      (assertBootstrappedSource)——缺 = 即刻還原,唔跑 tsc/test。
//   ③ env gate: SE_SELF_MOD 未開 = 自改一律拒絕(主神批准先開,貼合項目
//      P15 bet-double「實裝已埋但 env 預設 off」文化)。
// ═══════════════════════════════════════════════════════════════════════════

export const SE_SELF_MOD_ENV = 'SYSTEM_ENGINEER_SELF_MOD';

/** SE 可以「自改」嘅檔案(self-mod 範圍) */
export const SELF_MOD_FILES: readonly string[] = [
  'src/evolution/system-engineer.ts',
  'SystemEngineer.md',
];

/**
 * Safety-critical fingerprints —— self-mod oldCode 若包含以下任一結構 = 刪緊
 * 自己嘅安全網(rollback/judge/scope 層)。SE 可以「同一檔案內搬位」,但唔可以刪。
 * 'src/trading/' 同時係 FORBIDDEN 條目——SE 刪 FORBIDDEN 條目 = 擴權,一樣拒絕。
 */
const CRITICAL_FINGERPRINTS: readonly string[] = [
  'FORBIDDEN_PREFIXES',
  'src/trading/',
  'parseTestVerdict(',
  'isFileAllowed(',
  'assertSelfModSafe(',
  'Rolling back',
  'SYSTEM_ENGINEER_ENABLED',
];

/** 改動後源碼必須存在嘅結構(assertBootstrappedSource 用) */
const SOURCE_REQUIRED_SYMBOLS: readonly string[] = [
  'parseTestVerdict',
  'FORBIDDEN_PREFIXES',
  'src/trading/',
  'assertSelfModSafe',
  'Rolling back',
];

export function isSelfModFile(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  // exact match —— 唔可以用 startsWith(否則 system-engineer.ts.bak / .tmp 都會被當 self-mod)
  return SELF_MOD_FILES.includes(filePath);
}

export function selfModEnabled(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): boolean {
  return env[SE_SELF_MOD_ENV] === 'true';
}

/** 掃描「要刪除嘅文本」有冇 safety-critical fingerprint(逐行 trim 比對) */
export function findCriticalDeletion(removedCode: string): string | null {
  if (typeof removedCode !== 'string' || removedCode.length === 0) return null;
  for (const rawLine of removedCode.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    for (const fp of CRITICAL_FINGERPRINTS) {
      if (line.includes(fp)) return fp;
    }
  }
  return null;
}

/** post-apply 結構驗證 —— 改動後源碼必須保留全部 judge/scope/rollback 結構 */
export function assertBootstrappedSource(source: string): string | null {
  if (typeof source !== 'string' || source.length === 0) return 'empty source';
  for (const sym of SOURCE_REQUIRED_SYMBOLS) {
    if (!source.includes(sym)) return `missing critical structure: ${sym}`;
  }
  return null;
}

export interface SelfModDecision {
  allowed: boolean;
  reason: string;
}

/**
 * 主 gate —— pre-apply 時 call。
 *  - 非 self-mod file: 永遠放行(唔影響正常 SE flow)
 *  - self-mod file + env 未開: reject(主神批准先開)
 *  - self-mod file + env 開 + oldCode 含 critical fingerprint: reject(拆安全網)
 */
export function assertSelfModSafe(args: {
  filePath: string;
  removedCode: string;
  enabled: boolean;
}): SelfModDecision {
  const { filePath, removedCode, enabled } = args;
  if (!isSelfModFile(filePath)) return { allowed: true, reason: '' };
  if (!enabled) {
    return { allowed: false, reason: `self-modification disabled (set ${SE_SELF_MOD_ENV}=true to enable) — rejected` };
  }
  const fp = findCriticalDeletion(removedCode);
  if (fp !== null) {
    return { allowed: false, reason: `self-mod patch deletes safety-critical structure '${fp}' — rejected (bootstrapping guard)` };
  }
  return { allowed: true, reason: '' };
}
