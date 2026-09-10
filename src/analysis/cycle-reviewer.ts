/**
 * v2.0.875-CYCLE-REVIEW（2026-09-10, 主神「就算 npm run dev 都要有檢討系統——點解冇開倉/點解賺蝕, 更新去 investigation.md」）:
 * 規則式 Cycle Review——任何模式(dev/engineer)都行, 唔依賴 LLM/SE。
 * 兩個 hook: ①close 檢討(賺/蝕原因, 統一 onPositionClosedLearning 出口)
 *           ②冇開倉檢討(idle N cycles → 最後決策摘要: gate blocked / 信心不足)。
 */

/** close 檢討 —— 攞 TradeRecord 生成一行「賺/蝕原因」。garbage 輸入 → null(唔寫)。 */
export function buildCloseReview(t: {
  symbol?: unknown; side?: unknown; pnlPct?: unknown; closeReason?: unknown;
  mfePct?: unknown; maePct?: unknown;
}): string | null {
  if (typeof t !== 'object' || t === null) return null;
  const sym = typeof t.symbol === 'string' ? t.symbol.split(':').pop() : '?';
  const side = typeof t.side === 'string' ? t.side.toUpperCase() : '?';
  const pnl = typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct) ? t.pnlPct * 100 : null;
  const reason = typeof t.closeReason === 'string' ? t.closeReason : '?';
  if (pnl === null) return null;
  const mfe = typeof t.mfePct === 'number' && Number.isFinite(t.mfePct) ? (t.mfePct * 100).toFixed(1) : 'n/a';
  const mae = typeof t.maePct === 'number' && Number.isFinite(t.maePct) ? (t.maePct * 100).toFixed(1) : 'n/a';
  const dir = pnl >= 0 ? '✅ 賺' : '❌ 蝕';
  const why =
    reason === 'tp_hit' ? 'TP 目標到達——方向啱' :
    reason === 'exit_price_lock' || reason === 'profit_lock' ? '鎖利離場(有 profit 先鎖)' :
    reason === 'sl_tp' ? 'SL 止血(方向/時機錯, 止蝕正確)' :
    reason === 'reversal_point' || reason === 'reversal_point_exit' ? '反轉止蝕(趨勢反轉)' :
    reason === 'thesis_invalidation' ? 'thesis 失效(強制離場)' :
    reason === 'consensus' ? '共識離場' :
    reason === 'reconciliation' ? '對帳平倉(HL 側 close)' : reason;
  return `${dir} ${sym} ${side} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% (${why}, reason=${reason}, MFE=${mfe}% MAE=${mae}%)`;
}

/** 冇開倉檢討 —— 最後決策摘要生成「點解冇開」。 */
export function buildNoOpenReview(cycle: number, summary: {
  decisions?: Array<{ symbol?: unknown; action?: unknown; confidence?: unknown; threshold?: unknown; gateBlocked?: unknown | null }>;
}): string | null {
  if (!summary || !Array.isArray(summary.decisions) || summary.decisions.length === 0) return null;
  const lines: string[] = [];
  for (const d of summary.decisions) {
    if (typeof d !== 'object' || d === null) continue;
    const sym = typeof d.symbol === 'string' ? d.symbol.split(':').pop() : '?';
    const action = typeof d.action === 'string' ? d.action : '?';
    if (action === 'buy' || action === 'sell') continue; // 有開倉意圖唔係佢
    const gate = typeof d.gateBlocked === 'string' && d.gateBlocked.length > 0 ? d.gateBlocked : null;
    const conf = typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? d.confidence : null;
    const th = typeof d.threshold === 'number' && Number.isFinite(d.threshold) ? d.threshold : null;
    if (gate) {
      lines.push(`  🔍 ${sym}: hold — gate 攔截: ${gate}`);
    } else if (conf !== null && th !== null) {
      const diff = ((conf - th) * 100).toFixed(1);
      lines.push(`  🔍 ${sym}: hold — confidence ${(conf * 100).toFixed(0)}% vs threshold ${(th * 100).toFixed(1)}% (Δ${diff >= '0' ? '+' : ''}${diff}pp)`);
    } else if (conf !== null) {
      lines.push(`  🔍 ${sym}: hold — confidence ${(conf * 100).toFixed(0)}%`);
    } else {
      lines.push(`  🔍 ${sym}: hold`);
    }
  }
  if (lines.length === 0) return null;
  return `── cycle ${cycle} 檢討: 冇開倉原因\n${lines.join('\n')}`;
}

/** append investigation.md(atomic temp+rename)。lines 空 → no-op。 */
export function appendInvestigation(filePath: string, lines: string[]): void {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const fs = require('node:fs');
  // C4-attack(2026-09-10): 非 string line(42/null)唔可以 .replace TypeError——String() 兜底, 唔 throw
  const header = lines.map((l) =>
    String(l ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300),
  );
  const block = `\n## ${new Date().toISOString().replace('T', ' ').slice(0, 16)} (investigation)\n${header.join('\n')}\n`;
  try {
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `# MATS Investigation Log\n`;
    fs.writeFileSync(tmp, prev + block, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // 記錄失敗唔可以影響交易 cycle——吞, console warn(唔 import logger——純函數)
    try { console.warn(`[investigation] append failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
  }
}
