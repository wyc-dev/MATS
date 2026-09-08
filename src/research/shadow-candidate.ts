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
  /** 樣本門檻: 最少 shadow resolved 事件 */
  minEvents: Number(process.env['SHADOW_CAND_MIN_EVENTS']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_EVENTS']) : 500,
  /** 最少運行日數(防「幾分鐘灌爆」假樣本) */
  minAgeDays: Number(process.env['SHADOW_CAND_MIN_AGE_DAYS']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_AGE_DAYS']) : 10,
  /** 特徵預測力門檻: |ρ(feature, pnlPct)| ≥ 此值(分辨力) */
  minRho: Number(process.env['SHADOW_CAND_MIN_RHO']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_RHO']) : 0.15,
  /** 平均 margin edge 門檻(%): 候選特徵對應嘅平均 pnl ≥ 此值 */
  minEdgePct: Number(process.env['SHADOW_CAND_MIN_EDGE']) >= 0 ? Number(process.env['SHADOW_CAND_MIN_EDGE']) : 0.5,
} as const;

function finiteOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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
  const rx = rank(pairs.map((p) => p[0])), ry = rank(pairs.map((p) => p[1]));
  const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const rxi = rx[i] ?? 0, ryi = ry[i] ?? 0; num += (rxi - mx) * (ryi - my); dx += (rxi - mx) ** 2; dy += (ryi - my) ** 2; }
  return { rho: dx * dy ? num / Math.sqrt(dx * dy) : 0, n };
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

/**
 * 純函數: shadow 候選 gate——評估「邊個 entry 特徵有分辨力」用 shadow 樣本。
 * 回傳 VerdictResult(PASS=候選就緒,記錄;FAIL;INSUFFICIENT=繼續累積)。
 */
export function evaluateShadowCandidate(
  events: ShadowEventLike[],
  featureKeys: string[],
  options: { startedAt?: number; now?: number } = {},
): { verdict: 'PASS' | 'FAIL' | 'INSUFFICIENT'; reason: string; bestFeature?: string; bestRho?: number; bestEdgePct?: number; n: number } {
  const n = Array.isArray(events) ? events.filter((e) => e && finiteOr(e.pnlPct) !== undefined).length : 0;
  const cfg = shadowCandidateConfig;
  if (n < cfg.minEvents) return { verdict: 'INSUFFICIENT', reason: `樣本唔夠: n=${n} < minEvents=${cfg.minEvents}(Shadow 門檻——real 唔卡)`, n };
  if (cfg.minAgeDays > 0) {
    const now = options.now ?? Date.now();
    const start = options.startedAt ?? (n > 0 ? Math.min(...events.filter((e) => e && finiteOr(e.resolvedAt) !== undefined).map((e) => (e.resolvedAt as number))) : now);
    if ((now - start) / 86_400_000 < cfg.minAgeDays) return { verdict: 'INSUFFICIENT', reason: `運行日數唔夠: < ${cfg.minAgeDays} 日`, n };
  }
  // 掃描候選特徵: 攞 ρ 最強且 edge 正嘅
  let best: { k: string; rho: number; edge: number } | null = null;
  for (const k of featureKeys) {
    const { rho } = shadowFeatureRho(events, k);
    const { edgePct } = shadowFeatureEdge(events, k);
    if (Math.abs(rho) >= cfg.minRho && edgePct >= cfg.minEdgePct) {
      if (!best || Math.abs(rho) > Math.abs(best.rho)) best = { k, rho, edge: edgePct };
    }
  }
  if (best) return { verdict: 'PASS', reason: `候選就緒: "${best.k}" ρ=${best.rho.toFixed(3)} edge=${best.edge.toFixed(2)}% (Shadow 樣本夠,可實盤 observe)`, bestFeature: best.k, bestRho: best.rho, bestEdgePct: best.edge, n };
  return { verdict: 'FAIL', reason: `Shadow ${n} 筆無特徵過門檻(ρ≥${cfg.minRho} 且 edge≥${cfg.minEdgePct}%)——記錄,唔做`, n };
}
