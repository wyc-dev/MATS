/**
 * ═══ v2.0.870-P24: Deployment-Version Awareness ═══
 *
 * 問題(實證 08-18):trade-audit LLM 控告「P21 fix 已部署但 trade #17
 * (SKHX −11.3%)係 post-fix 新發生」——實際上嗰單係 fix 部署前 43 分鐘
 * 收場嘅歷史單。根因:audit 嘅 prompt 只有「fix 存在」(CHANGELOG),
 * 冇「fix 幾時落地」→ LLM 用估嘅嚟判 NEW/STALE,必然錯。
 *
 * 解法:git log 係唯一權威 (commit time ≈ deploy time,tsx watch 儲存後秒級生效;
 * 注意 commit 通常遲過 file-save 幾分鐘 → deploy 時間微微高估 →
 * 判斷方向保守:寧願少判 post-fix,唔會誤判) →
 * 每個 fix version 嘅 first-landing timestamp → 注入 audit prompt,
 * 同每筆 trade 預計算 postFix 清單(deployTs ≤ closeTs 嘅版本)——
 * 比較 mechanize 咗,LLM 冇得估錯。
 *
 * 設計紀律:
 * - Pure parse 核心(`parseVersionDeployments`)可單元測試;git I/O 隔離喺薄殼
 * - TTL cache(10 min)——audit 每 2 cycle 跑,git 唔使次次 exec
 * - 任何失敗(git 唔存在/repo 非 git/timeout)→ 空清單 + prompt 明寫「UNKNOWN」,
 *   唔阻塞 audit
 * - execSync timeout 5s,output 上限 45 日窗(歷史 fix 冇 audit 價值)
 */

import { execSync } from 'node:child_process';

export interface VersionDeployment {
  /** 完整 token,如 'v2.0.870-P21' */
  token: string;
  /** 短 alias,如 'P21'(去掉 'v2.0.XXX-' 前綴;冇前綴就等於 token) */
  alias: string;
  /** 首次落地(最早 commit)unix ms */
  firstDeployMs: number;
  /** commit subject 首 80 字(畀 LLM 對 topic) */
  subject: string;
}

/** 版本 token regex:v2.0.870-P16-attack2 / v2.0.869-P15 / v2.0.864 等 */
const VERSION_RE = /v2\.0\.\d+(?:-[A-Za-z][A-Za-z0-9'-]*)*/g;

/**
 * 純函數:parse `git log --format='%ct|%s'` 輸出 → per-version 最早 deploy。
 * 同一版本多次 commit → 攞最早(首次落地)。無版本 token 嘅行忽略。
 */
export function parseVersionDeployments(gitLogText: string): VersionDeployment[] {
  const byToken = new Map<string, VersionDeployment>();
  for (const line of gitLogText.split('\n')) {
    const sep = line.indexOf('|');
    if (sep <= 0) continue;
    const tsSec = Number(line.slice(0, sep));
    if (!Number.isFinite(tsSec) || tsSec <= 0) continue;
    const subject = line.slice(sep + 1);
    const tokens = subject.match(VERSION_RE);
    if (!tokens) continue;
    for (const raw of tokens) {
      const token = raw.replace(/-+$/, ''); // 尾部 dash 清理
      const ms = tsSec * 1000;
      const prev = byToken.get(token);
      if (!prev || ms < prev.firstDeployMs) {
        // alias = 剝走 'vX.Y.Z-' 主版本前綴(P18-attack2 / P23-fix 保留完整後綴——
        // 唔係 lastIndexOf('-'),否則 alias 只剩 'fix'/'attack2' 呢啲冇用字眼)
        const m = token.match(/^v\d+(?:\.\d+)+-(.+)$/);
        const alias = m ? m[1]! : token;
        byToken.set(token, { token, alias, firstDeployMs: ms, subject: subject.slice(0, 80) });
      }
    }
  }
  // 新舊排序:最新 deploy 喺前(audit 關心最近)
  return [...byToken.values()].sort((a, b) => b.firstDeployMs - a.firstDeployMs);
}

/**
 * 判斷 trade 係咪某 fix 嘅 post-fix 樣本。
 * 版本唔喺 timeline(例如手工作業冇 commit)→ 'unknown'(唔准估)。
 */
export function classifyTradeVsFix(
  timeline: VersionDeployment[],
  tradeCloseMs: number,
  versionTokenOrAlias: string,
): 'post-fix' | 'pre-fix' | 'unknown' {
  const v = timeline.find(d => d.token === versionTokenOrAlias || d.alias === versionTokenOrAlias);
  if (!v) return 'unknown';
  return tradeCloseMs >= v.firstDeployMs ? 'post-fix' : 'pre-fix';
}

/**
 * 每筆 trade 預計算 postFix 清單——audit dataLine 注入,LLM 唔使自己 join。
 * 只考慮最近 maxVersions 個版本(上下文成本控制)。
 */
export function postFixVersionsFor(
  timeline: VersionDeployment[],
  tradeCloseMs: number,
  maxVersions = 8,
): string[] {
  return timeline
    .slice(0, maxVersions)
    .filter(d => tradeCloseMs >= d.firstDeployMs)
    .map(d => d.token);
}

/** Prompt 用嘅緊湊 timeline block */
export function formatDeploymentTimeline(timeline: VersionDeployment[], maxVersions = 12): string {
  if (timeline.length === 0) {
    return '### DEPLOYMENT TIMELINE: UNAVAILABLE (git history not readable — treat ALL fix-deploy times as UNKNOWN; never claim a trade is "post-fix" without evidence)';
  }
  const lines = timeline.slice(0, maxVersions).map(d =>
    `- ${d.token} (alias: ${d.alias}) deployed ${new Date(d.firstDeployMs).toISOString()} — ${d.subject}`
  );
  return `### DEPLOYMENT TIMELINE (fix version → when it went LIVE in production; commit time, tsx watch applies saved code within seconds):\n${lines.join('\n')}`;
}

// ── 薄 I/O 殼(cache + graceful degradation)───────────────────────────

let cached: { at: number; timeline: VersionDeployment[] } | null = null;
const TTL_MS = 10 * 60_000;

/** 取 timeline(10 min TTL;fail → 空清單,唔 throw) */
export function getDeploymentTimeline(maxAgeDays = 45): VersionDeployment[] {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.timeline;
  try {
    const out = execSync(
      `git log --since="${maxAgeDays} days ago" --format='%ct|%s'`,
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString('utf-8');
    const timeline = parseVersionDeployments(out);
    cached = { at: now, timeline };
    return timeline;
  } catch {
    cached = { at: now, timeline: [] };
    return [];
  }
}

/** 測試用:清 cache */
export function _resetDeploymentTimelineCache(): void { cached = null; }
