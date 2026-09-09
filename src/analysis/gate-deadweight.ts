// ─── Gate Deadweight 自動評估（v2.0.873-P9-got-deadweight, 2026-09-09）───
// 市場適應機制: GOT(gate-outcome)量度每個 close/entry gate 嘅攔截 hit rate——
// hit rate < 45% 且樣本 ≥ 30 → 該 gate 係「deadweight」(攔截錯多過啱)→ 自動停用。
// 純函數——零 I/O、可單測。garbage 統計 → skip(唔誤判)。
export interface DeadweightEntry {
  hits: number;
  misses: number;
}

/** 評估 GOT stats——抽 deadweight gate(hit rate < 45% + n ≥ 30)。
 *  garbage(非 object/NaN/負)→ skip——唔可以扮「零命中」誤停。 */
export function evaluateDeadweightGates(stats: Record<string, DeadweightEntry> | null | undefined): string[] {
  if (!stats || typeof stats !== 'object') return [];
  const dead: string[] = [];
  for (const [gate, s] of Object.entries(stats)) {
    if (!s || typeof s !== 'object') continue;
    const hits = s.hits, misses = s.misses;
    if (typeof hits !== 'number' || typeof misses !== 'number') continue;
    if (!Number.isFinite(hits) || !Number.isFinite(misses) || hits < 0 || misses < 0) continue;
    const total = hits + misses;
    if (total < 30) continue; // 樣本門檻(市場適應——唔可以細樣本誤停)
    if (hits / total < 0.45) dead.push(gate);
  }
  return dead;
}

/** clean gate 名(去垃圾/控制字符)——deadweight set key 安全 */
export function sanitizeGateName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.replace(/[\x00-\x1F]/g, '').slice(0, 48);
}
