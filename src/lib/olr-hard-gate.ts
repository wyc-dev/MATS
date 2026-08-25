// ─── OLR 硬門 — v2.0.870-olr-hard-gate（主神 2026-08-25）──────────────
// 判斷層硬防護: bnb case——thesis 自認「OLR BUY P(win)=29% is against」但照開
// BUY（LLM 用「1h momentum +1.2%」說服自己）——soft gate（×0.75）擋唔住。
// 規則: OLR P(win) < 0.35 且 live 樣本 ≥20 → 唔准開（buy/sell 雙向）。
// 冷啟動（effectiveSamples < 20）交 LLM 判斷——唔可以因樣本疏誤殺。
// env OLR_HARD_GATE=false 回退。純函數——零依賴可測。

export interface OlrHardGateInput {
  /** OLR P(win)（0-1）——任何垃圾 → 唔 block（保守——唔可以因垃圾值誤殺） */
  pWin: number | null | undefined;
  /** OLR live 樣本數（effectiveSamples——不含 backfill——P19 教訓） */
  samples: number | null | undefined;
}

/** OLR 硬門: P(win) < 門檻且樣本 ≥20 → block。垃圾值 → false（唔 block）。
 *  v2.0.870-high-winrate（主神 2026-08-25）: 0.35 → 0.45——只有統計支持
 *  （P≥45%）先准開——低 P 假訊號全部擋（每單賺優先, 少開但準）。 */
export function shouldOlrHardBlock(
  input: OlrHardGateInput | null | undefined,
  minPwin = 0.35,
  minSamples = 20,
): boolean {
  const p = input?.pWin;
  const n = input?.samples;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return false; // 垃圾 → 唔 block
  if (p >= 1) return false; // p=1（幻覺）唔係「低 P」問題
  const nn = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  const threshold = Number.isFinite(minPwin) && minPwin > 0 ? minPwin : 0.35;
  const floor = Number.isFinite(minSamples) && minSamples > 0 ? Math.floor(minSamples) : 20;
  if (nn < floor) return false; // 冷啟動交 LLM
  return p < threshold;
}
