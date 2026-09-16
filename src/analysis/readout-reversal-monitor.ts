// ═══════════════════════════════════════════════════════════════════════════
// readout-reversal-monitor.ts —— Readout 反轉優先監察（v2.0.891, 主神 2026-09-16）
//
// 背景: BPU(readout 分離)驗證 E1/E2——開倉時 shadow WR 高 → 結果反而差
// (ρ=−0.134 n=189; 高WR組 WR 18% vs 低WR組 58%)——現行 readout(高WR→boost)
// 方向反錯。P11 由 pending 升級做「優先監察」: 每次 SCL 樣本更新自動重算 ρ,
// 達門檻(|ρ|>threshold 且 n≥minN)→ LOUD「readout 反轉候選成熟」。
//
// 純函數,零決策影響——只係監察/LOUD。env:
//   READOUT_REVERSAL_MONITOR=false  關
//   READOUT_RHO_THRESHOLD=0.1       |ρ| 門檻
//   READOUT_MIN_N=30                樣本門檻(831)
// ═══════════════════════════════════════════════════════════════════════════

export const READOUT_MIN_N_DEFAULT = 30;
export const READOUT_RHO_THRESHOLD_DEFAULT = 0.1;

/** avg-rank Spearman——paired finite filter;零變異/樣本太少 → null(同 research 工具 rank-correlation 一致) */
export function avgRankSpearman(xs: number[], ys: number[]): number | null {
  if (!Array.isArray(xs) || !Array.isArray(ys)) return null;
  const n = xs.length;
  if (n < 10 || n !== ys.length) return null;
  const rank = (a: number[]): number[] | null => {
    const idx = a.map((v, i) => ({ v, i })).sort((p, q) => (Number.isNaN(p.v) ? 1 : Number.isNaN(q.v) ? -1 : p.v - q.v));
    const r = new Array<number>(n);
    let s = 0; let eq = 0;
    for (let i = 0; i < n; i++) {
      s += i + 1; eq++;
      if (i === n - 1 || Number.isNaN(idx[i]!.v) || !Object.is(idx[i]!.v, idx[i + 1]!.v)) {
        const avg = s / eq;
        for (let k = i - eq + 1; k <= i; k++) r[idx[k]!.i] = avg;
        s = 0; eq = 0;
      }
    }
    return r;
  };
  const rx = rank(xs); const ry = rank(ys);
  if (!rx || !ry) return null;
  // zero-variance 保護
  if (new Set(xs).size < 2 || new Set(ys).size < 2) return null;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i]! - mx) * (ry[i]! - my); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - my) ** 2; }
  return dx * dy === 0 ? null : num / Math.sqrt(dx * dy);
}

export interface ReadoutMonitorInput {
  /** 開倉時 shadow WR(0-1) */
  entryShadowWRAtOpen: number | null | undefined;
  /** outcome: true = win */
  isWin: boolean | null | undefined;
}

/** 由樣本計算 readout ρ(entryShadowWRAtOpen → win)——paired + finite filter */
export function computeReadoutRho(samples: ReadoutMonitorInput[]): { rho: number | null; n: number } {
  if (!Array.isArray(samples)) return { rho: null, n: 0 };
  const xs: number[] = []; const ys: number[] = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    const w = s.entryShadowWRAtOpen;
    const win = s.isWin;
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1) continue;
    if (typeof win !== 'boolean') continue;
    xs.push(w); ys.push(win ? 1 : 0);
  }
  return { rho: avgRankSpearman(xs, ys), n: xs.length };
}

/** 監察判定: 負 ρ(反預測)且 |ρ|≥threshold 且 n≥minN → 達標(alert) */
export function shouldAlertReadoutReversal(rho: number | null, n: number, rhoThreshold: number, minN: number): boolean {
  if (rho === null) return false;
  if (!Number.isFinite(rho)) return false;
  if (!Number.isFinite(n) || n < minN) return false;
  const th = Number.isFinite(rhoThreshold) && rhoThreshold > 0 ? rhoThreshold : READOUT_RHO_THRESHOLD_DEFAULT;
  return Math.abs(rho) >= th && rho < 0; // 而家係「反預測」(負 ρ)——正 ρ(順預測)唔 alert
}

/** LOUD 訊息 */
export function formatReadoutReversalAlert(rho: number, n: number): string {
  return `🔔 [READOUT-REVERSAL] 開倉時 shadow WR 反預測 ρ=${rho.toFixed(3)} (n=${n}≥30): 高 WR→boost 方向反錯——統計 lean 反轉候選成熟, 831 裁決`;
}
