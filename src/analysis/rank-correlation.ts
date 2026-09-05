/**
 * rank-correlation.ts — Average-Rank Spearman 相關係數（研究工具嘅單一 source of truth）
 *
 * 背景（2026-09-05, PLAN_tool-integrity-fix）: 舊 scripts 各自實作嘅 Spearman 冇平均秩
 * 處理 + 冇零變異保護——常數預測（全部同值）會被算成 ρ=±1 完美預測/反預測假象。
 * 影響: verify-shadow-wr-divergence / p9-attrib-validate / 66-olr-blend-swap /
 *       70-round-number-features 四個腳本（gate 乘數同 Shadow WR 大量同值——最危險）。
 *
 * 正確語義:
 *   - ties 用平均秩（average rank）——常數同值群全部取平均值，消除任意定秩
 *   - 零變異保護: xs 或 ys 唯一值 <2（或樣本 <3）→ null（「未定義」——唔係 0/±1）
 *   - 秩嘅 Pearson correlation = Spearman（對無 ties 情況等同標準公式）
 *   - NaN/±Infinity/垃圾輸入過濾——垃圾唔可以出 ρ
 *
 * 攻擊輪硬化（P9-attack-round6-tool-integrity, 2026-09-05）:
 *   - V1: 過濾改為 **paired-filter**——(x[i], y[i]) 同索引同時有效先保留。
 *         舊版獨立 filter 會令配對移位（xs=[1,NaN,2,3] vs ys=[30,20,10,40]
 *         正確 ρ=+0.5 → 變成 −1——配對錯位反轉結論）。
 *   - V2: 取值用 own-property + try/catch——Proxy/defineProperty getter bomb
 *         （讀 element throw）唔再 crash（→ 該位視為無效）。
 */

/** 安全讀取 array element——own-property + try/catch（getter bomb / Proxy trap 免疫）；非有限 number → null */
function ownFinite(arr: unknown, i: number): number | null {
  try {
    if (!Array.isArray(arr)) return null;
    if (!Object.prototype.hasOwnProperty.call(arr, i)) return null; // Proxy getOwnPropertyDescriptor trap 都會喺 try/catch 內
    const v = (arr as unknown[])[i] as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? (v as number) : null;
  } catch {
    return null; // getter bomb / Proxy trap（get / getOwnPropertyDescriptor / length）：讀唔到 → 該位無效（唔 crash）
  }
}

/** PAIRED 過濾——(x[i], y[i]) 同時有效先保留。長度取 min（同索引語義）。Array.isArray/length 讀取都包 try/catch。 */
function finitePairs(xs: unknown, ys: unknown): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let xl = 0;
  let yl = 0;
  try {
    if (!Array.isArray(xs) || !Array.isArray(ys)) return out;
    xl = (xs as unknown[]).length; // Proxy length getter throw → catch → 空
    yl = (ys as unknown[]).length;
  } catch {
    return out;
  }
  const n = Math.min(xl, yl);
  for (let i = 0; i < n; i++) {
    const x = ownFinite(xs, i);
    const y = ownFinite(ys, i);
    if (x !== null && y !== null) out.push([x, y]);
  }
  return out;
}

/** 平均秩（1-based; ties 取平均）——pairs 已按原始索引排列 */
function averageRanks(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const r = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) r[order[k]!] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Average-Rank Spearman ρ。
 * @returns 相關系數；配對後樣本 <3、任一側唯一值 <2（零變異）→ null。
 */
export function avgRankSpearman(xs: number[], ys: number[]): number | null {
  const pairs = finitePairs(xs, ys);
  const n = pairs.length;
  if (n < 3) return null;
  const xn = pairs.map((p) => p[0]);
  const yn = pairs.map((p) => p[1]);
  // 零變異保護——常數輸入冇排名資訊，必須係「未定義」而唔係 ±1
  if (new Set(xn).size < 2 || new Set(yn).size < 2) return null;
  const rx = averageRanks(xn);
  const ry = averageRanks(yn);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null; // 防線（理論上已被零變異保護覆蓋）
  return num / Math.sqrt(dx * dy);
}
