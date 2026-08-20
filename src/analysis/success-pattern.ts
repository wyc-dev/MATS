// ─── P80: 成功類型分類（Success Pattern Classification）───
// 主神洞察: 「認準成功嘅 pattern 會更加有助增大盈利」——成功分類係「進攻」
// （重複成功 pattern），錯誤分類係「防守」（避免錯誤）——增大盈利靠進攻。
// 驗證（200 筆 realTrades）: 順勢突破 avgPnl +2.92%（正期望值——boost）vs
// 低波動擴張/新聞/動量確認 -1.47% 到 -2.42%（負期望值——降權）——校準後 +0.19pp。
// 完整閉環: 贏單 close → 分類 → 統計（持久化）→ 入場 gate 用 multiplier（soft）。

export type SuccessPattern = 'breakout' | 'sr_bounce' | 'pullback' | 'momentum' | 'news' | 'vol_expansion' | 'other';

export const SUCCESS_PATTERNS: SuccessPattern[] = ['breakout', 'sr_bounce', 'pullback', 'momentum', 'news', 'vol_expansion', 'other'];

/** 純函數: 分類 entryThesis 嘅成功類型（heuristic 關鍵詞——無 I/O） */
export function classifySuccessPattern(entryThesis: string | null | undefined): SuccessPattern {
  if (typeof entryThesis !== 'string' || entryThesis.trim().length === 0) return 'other';
  const s = entryThesis.toLowerCase();
  if (s.includes('breakout') || s.includes('突破')) return 'breakout';
  // pullback 檢查喺 sr_bounce 之前——'pullback to support' 係 pullback 唔係 sr_bounce
  if (s.includes('pullback') || s.includes('回調')) return 'pullback';
  if (s.includes('bounce') || s.includes('反彈') || s.includes('support') || s.includes('demand')) return 'sr_bounce';
  if (s.includes('momentum') || s.includes('動量') || s.includes('higher-high')) return 'momentum';
  if (s.includes('news') || s.includes('新聞') || s.includes('catalyst')) return 'news';
  if (s.includes('compression') || s.includes('低波動') || s.includes('expansion')) return 'vol_expansion';
  return 'other';
}

export interface SuccessPatternStats {
  n: number;
  wins: number;
  pnlSum: number;
  /** E1: 時間衰減——最近樣本 ring（cap 100），每筆 { pnlPct, closedAt }。
   *   getMultiplier 用 exp(-Δt/τ) 時間加權 avgPnl（τ=24h，同 RegimeWinRateLearner 一致）——
   *   舊數據（30 日前）唔再同新數據等權。 */
  recent?: Array<{ pnlPct: number; closedAt: number }>;
  /** E1: 時間加權 avgPnl（tracker 計算後填入；純函數優先使用） */
  weightedAvgPnl?: number;
}

/** 純函數: 成功類型校準乘數（soft——唔 hard block） */
export function successPatternMultiplier(pattern: SuccessPattern, stats: SuccessPatternStats | null): number {
  // 冷啟動: 冇數據 / n < 10 → ×1.0（唔干擾 bootstrap）
  if (!stats || typeof stats !== 'object' || stats.n < 10 || stats.n === 0) return 1.0;
  // FIX-1（攻擊輪 A1）: pnlSum/n 計算前 sanitize——Infinity/NaN 唔誤判 boost
  const n = Number.isFinite(stats.n) && stats.n > 0 ? stats.n : 0;
  const pnlSum = Number.isFinite(stats.pnlSum) ? stats.pnlSum : 0;
  if (n === 0) return 1.0;
  // E1: 時間加權 avgPnl 優先（tracker 計算）——否則點估計
  const wAvg = stats.weightedAvgPnl;
  const avgPnl = typeof wAvg === 'number' && Number.isFinite(wAvg) ? wAvg : pnlSum / n;
  // 正期望值（avgPnl > 1%）→ ×1.1（boost——多啲做）
  if (avgPnl > 1.0) return 1.1;
  // 負期望值（avgPnl < -0.5%）→ ×0.7（降權——少啲做）
  if (avgPnl < -0.5) return 0.7;
  // 中性 → ×1.0
  return 1.0;
}

/** 格式化成功類型統計 block（注入 Meta-Agent & Skeptics context） */
export function formatSuccessPatternBlock(stats: Record<SuccessPattern, SuccessPatternStats> | null | undefined): string {
  if (!stats || typeof stats !== 'object') return '';
  const lines: string[] = ['=== SUCCESS PATTERN STATS (per entry-thesis type — learned from closed trades) ==='];
  let any = false;
  for (const p of SUCCESS_PATTERNS) {
    const s = stats[p];
    // FIX-2（攻擊輪 B1/B2）: 形狀驗證——n/wins/pnlSum 必須 finite 非負——垃圾 skip（唔顯示 NaN%）
    if (!s || typeof s !== 'object') continue;
    const n = typeof s.n === 'number' && Number.isFinite(s.n) && s.n > 0 ? Math.floor(s.n) : 0;
    const wins = typeof s.wins === 'number' && Number.isFinite(s.wins) && s.wins >= 0 ? Math.floor(s.wins) : 0;
    const pnlSum = typeof s.pnlSum === 'number' && Number.isFinite(s.pnlSum) ? s.pnlSum : 0;
    if (n === 0) continue;
    any = true;
    const wr = (wins / n * 100).toFixed(0);
    const avgPnlNum = pnlSum / n;
    const avgPnl = avgPnlNum.toFixed(2);
    // 數字比較（唔係字串——'-2.42' < '-0.50' 字串 lexicographic 會錯）
    const edge = avgPnlNum > 1.0 ? 'POSITIVE edge (boost ×1.1)' : avgPnlNum < -0.5 ? 'NEGATIVE edge (downweight ×0.7)' : 'neutral';
    lines.push(`  ${p}: n=${n} WR=${wr}% avgPnl=${avgPnl}% — ${edge}`);
  }
  if (!any) return '';
  lines.push('  (cold-start: n<10 per type → neutral ×1.0; stats update every close)');
  return lines.join('\n');
}
