// research/shadow-candidate.ts — Shadow 樣本門檻 gate(P5, 主神 2026-09-08 修正)。
//
// 初衷: 樣本門檻只 apply Shadow 層——shadow 樣本海量、累積快(EventArchive 幾日 500+),
// 特徵/候選驗證用 shadow 過關先升候選;real 層唔卡硬門檻(好難開單),只做最終 OOS 確認。
//
// 流程: shadow events → 特徵預測力(ρ, edge)→ Verdict:
//   INSUFFICIENT(樣本未夠 minEvents / 未夠日數)→ 繼續累積
//   PASS(ρ≥minRho 且 avg edge 正)→ 候選就緒(記錄,唔自動實裝)
//   FAIL → 記錄負結果(唔做)
//
// pre-registered 標準(env 可調,零 tune):
//   minEvents=500 / minAgeDays=10 / minRho=0.15 / minEdgePct=0.5(avg margin %)

interface ShadowEventLike {
  symbol?: string;
  side?: string;
  outcome?: string;
  pnlPct?: number;
  resolvedAt?: number;
  [k: string]: unknown;
}

export const shadowCandidateConfig = {
  /** 統計力下限(2026-09-08 自適應): permutation 嘅有意義樣本下限——樣本越少,permutation null 越闊 → ρ門檻自動越高(唔會誤判);樣本越多 → 門檻自然越低 */
  minEvents: Number(process.env['SHADOW_CAND_MIN_EVENTS']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_EVENTS']) : 50,
  /** 最少運行日數(防「幾分鐘灌爆」假樣本) */
  minAgeDays: Number(process.env['SHADOW_CAND_MIN_AGE_DAYS']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_AGE_DAYS']) : 10,
  /** ρ 門檻 floor(自適應): permutation 99th percentile(>此值)為動態門檻;但唔可以低過此 floor(ρ<0.05 無實質意義) */
  minRhoFloor: Number(process.env['SHADOW_CAND_MIN_RHO']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_RHO']) : 0.05,
  /** permutation 迭代數(shuffle null distribution) */
  permIterations: Math.max(100, Math.min(2000, Number(process.env['SHADOW_CAND_PERM_ITERS']) || 300)),
  /** permutation null 嘅 percentile 門檻 */
  permPctile: 0.99,
  /** 平均 margin edge 門檻(%): 候選特徵對應嘅平均 pnl ≥ 此值 */
  minEdgePct: Number(process.env['SHADOW_CAND_MIN_EDGE']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_EDGE']) : 0.5,
  /** 兩段穩定性(2026-09-08 改善): 前 60 / 後 40 段 ρ 要同號且都 ≥ 此值——防單段偶然 */
  minTwoSegmentRho: Number(process.env['SHADOW_CAND_MIN_2SEG_RHO']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_2SEG_RHO']) : 0.10,
  /** 尾部不劣化(改善): 高特徵桶 worst 唔可以低過「全體 worst × 此值」(容許 1.5 倍) */
  tailBadRatio: Number(process.env['SHADOW_CAND_TAIL_RATIO']) >= 0 ? Number(process.env['SHADOW_CAND_TAIL_RATIO']) : 1.5,
  /** coverage(改善): 候選特徵有效樣本最少 symbol 數(防 single-symbol 效應) */
  minCoverageSymbols: Math.max(1, Math.min(20, Number(process.env['SHADOW_CAND_MIN_SYMBOLS']) || 3)),
} as const;

export type ShadowCandidateMode = 'explore' | 'confirm';

function finiteOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 純函數: Spearman ρ(兩個數值序列)——共用(events 版 + permutation 版) */
export function rankRho(feats: number[], pnls: number[]): number {
  const n = Math.min(feats.length, pnls.length);
  if (n < 3) return 0;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let j = i; while (j + 1 < n && idx[j + 1]!.v === idx[i]!.v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]!.i] = avg;
      i = j;
    }
    return r;
  };
  const rx = rank(feats.slice(0, n)), ry = rank(pnls.slice(0, n));
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const rxi = rx[i] ?? 0, ryi = ry[i] ?? 0; num += (rxi - mx) * (ryi - my); dx += (rxi - mx) ** 2; dy += (ryi - my) ** 2; }
  return dx * dy ? num / Math.sqrt(dx * dy) : 0;
}

/** 純函數: 計「候選特徵」對 pnl 嘅 Spearman ρ(用 shadow events 入面嘅 entry 特徵 *AtEntry) */
export function shadowFeatureRho(events: ShadowEventLike[], featureKey: string): { rho: number; n: number } {
  const pairs: Array<[number, number]> = [];
  for (const e of events) {
    const f = finiteOr(e[featureKey]);
    const p = finiteOr(e.pnlPct);
    if (f === undefined || p === undefined) continue;
    pairs.push([f, p]);
  }
  const n = pairs.length;
  if (n < 10) return { rho: 0, n };
  return { rho: rankRho(pairs.map((p) => p[0]), pairs.map((p) => p[1])), n };
}

/** 自適應 ρ 門檻(2026-09-08 主神「動態/自適應」): shuffle pnl 嘅 null |ρ| 分佈 → 99th percentile。
 *  樣本細 → null 分佈闊 → 門檻高(唔會誤 PASS);樣本大 → 門檻低(更準)。
 *  返回 ρ_crit = max(floor, permNull)。 */
export function permutationRhoThreshold(events: ShadowEventLike[], featureKey: string, iterations?: number): { rhoCrit: number; nullP99: number } {
  const cfg = shadowCandidateConfig;
  const its = iterations ?? cfg.permIterations;
  const pairs: Array<[number, number]> = [];
  for (const e of events) {
    const f = finiteOr(e[featureKey]);
    const p = finiteOr(e.pnlPct);
    if (f === undefined || p === undefined) continue;
    pairs.push([f, p]);
  }
  if (pairs.length < 20) return { rhoCrit: cfg.minRhoFloor, nullP99: 0 };
  const pnls = pairs.map((x) => x[1]);
  const nullRhos: number[] = [];
  const n = pnls.length;
  // 用固定 seed(可重現)shuffle——Fisher-Yates
  let seed = 20260908;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let it = 0; it < its; it++) {
    // Fisher-Yates shuffle pnl
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = pnls[i]!; pnls[i] = pnls[j]!; pnls[j] = tmp; }
    nullRhos.push(Math.abs(rankRho(pairs.map((x) => x[0]), pnls.slice())));
    // (shuffled pnls 已 in-place;用 rankRho(feats, pnls))
  }
  nullRhos.sort((a, b) => a - b);
  const idx = Math.min(nullRhos.length - 1, Math.floor(nullRhos.length * cfg.permPctile));
  const nullP99 = nullRhos[idx] ?? 0;
  return { rhoCrit: Math.max(cfg.minRhoFloor, nullP99), nullP99 };
}

/** 兩段穩定性(2026-09-08 改善): 前 60/後 40 段 ρ——同號且都 ≥ threshold 先算 stable */
export function twoSegmentRho(events: ShadowEventLike[], featureKey: string, threshold = shadowCandidateConfig.minTwoSegmentRho): { frontRho: number; backRho: number; stable: boolean } {
  const sorted = events
    .filter((e) => e && finiteOr(e[featureKey]) !== undefined && finiteOr(e.resolvedAt) !== undefined)
    .sort((a, b) => (a.resolvedAt as number) - (b.resolvedAt as number));
  const n = sorted.length;
  if (n < 20) return { frontRho: 0, backRho: 0, stable: false };
  const split = Math.floor(n * 0.6);
  const f = shadowFeatureRho(sorted.slice(0, split), featureKey).rho;
  const b = shadowFeatureRho(sorted.slice(split), featureKey).rho;
  const stable = Math.abs(f) >= threshold && Math.abs(b) >= threshold && Math.sign(f) === Math.sign(b);
  return { frontRho: f, backRho: b, stable };
}

/** 尾部不劣化(2026-09-08 改善): 高特徵桶(>中位)worst pnl vs 全體 worst——ratio ≤ tailBadRatio */
export function featureTailCheck(events: ShadowEventLike[], featureKey: string, ratio = shadowCandidateConfig.tailBadRatio): { ok: boolean; highWorst: number; allWorst: number } {
  const pairs: Array<[number, number]> = [];
  let allWorst = 0;
  for (const e of events) {
    const f = finiteOr(e[featureKey]);
    const p = finiteOr(e.pnlPct);
    if (f === undefined || p === undefined) continue;
    pairs.push([f, p]);
    if (p < allWorst) allWorst = p;
  }
  if (pairs.length < 10) return { ok: false, highWorst: 0, allWorst };
  pairs.sort((a, b) => a[0] - b[0]);
  const high = pairs.slice(Math.floor(pairs.length * 0.5));
  const highWorst = high.length ? Math.min(...high.map((x) => x[1])) : 0;
  if (highWorst >= 0 || allWorst >= 0) return { ok: true, highWorst, allWorst }; // 全正冇尾
  return { ok: highWorst >= allWorst * ratio, highWorst, allWorst };
}

/** coverage(2026-09-08 改善): 特徵有效樣本嘅 unique symbol 數 */
export function featureCoverageSymbols(events: ShadowEventLike[], featureKey: string): number {
  const syms = new Set<string>();
  for (const e of events) {
    if (e && finiteOr(e[featureKey]) !== undefined && typeof e.symbol === 'string') syms.add(e.symbol);
  }
  return syms.size;
}

/** 純函數: 候選特徵平均 margin edge(%)——feature 高半分 vs 低半分 */
export function shadowFeatureEdge(events: ShadowEventLike[], featureKey: string): { edgePct: number; n: number } {
  const pairs: Array<[number, number]> = [];
  for (const e of events) {
    const f = finiteOr(e[featureKey]);
    const p = finiteOr(e.pnlPct);
    if (f === undefined || p === undefined) continue;
    pairs.push([f, p]);
  }
  const n = pairs.length;
  if (n < 10) return { edgePct: 0, n };
  pairs.sort((a, b) => a[0] - b[0]);
  const half = Math.floor(n / 2);
  const hi = pairs.slice(half), lo = pairs.slice(0, half);
  const avgHi = hi.reduce((s, x) => s + x[1], 0) / hi.length, avgLo = lo.reduce((s, x) => s + x[1], 0) / lo.length;
  return { edgePct: (avgHi - avgLo) * 100, n };
}

/** 純函數: shadow 候選 gate(2026-09-08 改善版)。
 *  - explore(候選列表): 至少 2 個特徵過「兩段穩定 ρ + edge + tail + coverage」——防 data-snooping(單一最好特徵=假陽)
 *  - confirm(主神指定單一特徵): 該特徵過「兩段穩定 ρ + edge + tail + coverage」
 *  - 兩段穩定性: 前 60/後 40 ρ 同號且 ≥ minTwoSegmentRho
 *  - tail: 高特徵桶 worst ≥ 全體 worst × tailBadRatio
 *  - coverage: ≥ minCoverageSymbols
 */
export function evaluateShadowCandidate(
  events: ShadowEventLike[],
  featureSpec: string[] | { feature: string; mode: ShadowCandidateMode },
  options: { startedAt?: number; now?: number } = {},
): { verdict: 'PASS' | 'FAIL' | 'INSUFFICIENT'; reason: string; bestFeature?: string; bestRho?: number; bestEdgePct?: number; n: number; stable?: boolean; coverageSymbols?: number } {
  const n = Array.isArray(events) ? events.filter((e) => e && finiteOr(e.pnlPct) !== undefined).length : 0;
  const cfg = shadowCandidateConfig;
  if (n < cfg.minEvents) return { verdict: 'INSUFFICIENT', reason: `樣本唔夠: n=${n} < minEvents=${cfg.minEvents}(Shadow 門檻——real 唔卡)`, n };
  if (cfg.minAgeDays > 0) {
    const now = options.now ?? Date.now();
    const start = options.startedAt ?? (n > 0 ? Math.min(...events.filter((e) => e && finiteOr(e.resolvedAt) !== undefined).map((e) => (e.resolvedAt as number))) : now);
    if ((now - start) / 86_400_000 < cfg.minAgeDays) return { verdict: 'INSUFFICIENT', reason: `運行日數唔夠: < ${cfg.minAgeDays} 日`, n };
  }
  const isExplore = Array.isArray(featureSpec);
  const keys = isExplore ? (featureSpec as string[]) : [(featureSpec as { feature: string }).feature];

  // 每個候選特徵: 自適應 ρ_crit(permutation)+ 兩段穩定 + edge + tail + coverage 全過 → 合格
  const passed: Array<{ k: string; rho: number; edge: number }> = [];
  let rhoCrit = cfg.minRhoFloor;
  for (const k of keys) {
    const perm = permutationRhoThreshold(events, k);
    rhoCrit = Math.max(rhoCrit, perm.rhoCrit);
    const seg = twoSegmentRho(events, k);
    const rho = shadowFeatureRho(events, k).rho;
    const { edgePct } = shadowFeatureEdge(events, k);
    const tail = featureTailCheck(events, k);
    const cov = featureCoverageSymbols(events, k);
    if (seg.stable && Math.abs(rho) >= rhoCrit && edgePct >= cfg.minEdgePct && tail.ok && cov >= cfg.minCoverageSymbols) {
      passed.push({ k, rho, edge: edgePct });
    }
  }
  // explore 要求 ≥2 特徵(data-snooping 保護);confirm 要求該特徵過
  const threshold = isExplore ? 2 : 1;
  if (passed.length >= threshold) {
    const best = isExplore ? passed.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))[0] : passed[0];
    if (!best) return { verdict: 'FAIL', reason: '不合格(邊界)', n };
    return { verdict: 'PASS', reason: `候選就緒: "${best.k}" ρ=${best.rho.toFixed(3)} edge=${best.edge.toFixed(2)}% (${isExplore ? `explore ${passed.length} 特徵過關` : 'confirm 指定特徵'}——兩段穩定+tail+coverage 全過)`, bestFeature: best.k, bestRho: best.rho, bestEdgePct: best.edge, n, stable: true, coverageSymbols: featureCoverageSymbols(events, best.k) };
  }
  return { verdict: 'FAIL', reason: `Shadow ${n} 筆無特徵過全部門檻(自適應 ρCrit=${rhoCrit.toFixed(3)}/兩段 ρ≥${cfg.minTwoSegmentRho}/edge≥${cfg.minEdgePct}%/tail/coverage≥${cfg.minCoverageSymbols})——記錄,唔做`, n };
}
