/**
 * v2.0.875-CYCLE-REVIEW（2026-09-10, 主神「每個 Cycle 檢討 Selected Market Pairs 點解冇開到倉,
 *  investigation.md 似 ARCHITECTURE 咁——搵出當前狀況成因 + edge & alpha 改善方向」）:
 * 規則式調查引擎——任何模式(dev/engineer)都行, 唔依賴 LLM/SE。
 *
 * investigation.md 係「活調查文檔」:
 *  - 📍 當前 Cycle 檢討: 每 cycle 覆寫(Selected Market Pairs 逐個資產——點解冇開: 屏障/動量/regime)
 *  - 🔥 Missed Edge 發現: append(edge 訊號存在但連續 N cycles 冇開——新發現先寫, dedup)
 *  - 📊 開倉績效: append(close 檢討——賺/蝕原因)
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

/** Selected Market Pair 嘅逐個資產檢討 item。 */
export interface MarketReviewItem {
  symbol?: unknown;
  holding: boolean;          // 有冇倉位
  momentum4hPct?: unknown;   // 4h 動量 % (負 = 跌勢)
  regime?: unknown;
  gateBlocked?: unknown | null; // 開倉屏障(gate 名 + 原因)
  confidence?: unknown;
  threshold?: unknown;
}

/**
 * 當前 Cycle 檢討 body(Selected Market Pairs 逐個資產——點解冇開到倉)。
 * garbage item → skip; 全 garbage → null。
 */
export function buildMarketReview(title: string, items: MarketReviewItem[]): string | null {
  if (!Array.isArray(items)) return null;
  const lines: string[] = [];
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const sym = typeof it.symbol === 'string' ? it.symbol.split(':').pop() : '?';
    const mom = typeof it.momentum4hPct === 'number' && Number.isFinite(it.momentum4hPct) ? it.momentum4hPct : null;
    const momStr = mom === null ? 'n/a' : `${mom >= 0 ? '+' : ''}${mom.toFixed(2)}%`;
    const regime = typeof it.regime === 'string' ? it.regime : '?';
    const gate = typeof it.gateBlocked === 'string' && it.gateBlocked.length > 0 ? it.gateBlocked : null;
    if (it.holding) {
      lines.push(`  📉 ${sym}: 持倉中(close 時檢討), 4h=${momStr}, regime=${regime}`);
    } else if (gate) {
      lines.push(`  🔒 ${sym}: 冇開倉 — gate 攔截: ${gate} | 4h=${momStr}, regime=${regime}`);
    } else {
      const conf = typeof it.confidence === 'number' ? it.confidence : null;
      const th = typeof it.threshold === 'number' ? it.threshold : null;
      const confStr = conf !== null ? (th !== null ? ` confidence ${(conf * 100).toFixed(0)}% vs th ${(th * 100).toFixed(1)}%` : ` confidence ${(conf * 100).toFixed(0)}%`) : '';
      lines.push(`  🔍 ${sym}: 冇開倉 — 無明確 barrier${confStr} | 4h=${momStr}, regime=${regime}`);
    }
  }
  if (lines.length === 0) return null;
  return `## ${title}\n${lines.join('\n')}`;
}

/** Missed Edge 發現 —— edge 訊號(4h 強動量)存在但冇開倉 → 候選。 */
export function buildMissedEdge(item: MarketReviewItem): string | null {
  if (typeof item !== 'object' || item === null || item.holding) return null;
  const sym = typeof item.symbol === 'string' ? item.symbol.split(':').pop() : '?';
  const mom = typeof item.momentum4hPct === 'number' && Number.isFinite(item.momentum4hPct) ? item.momentum4hPct : null;
  if (mom === null) return null;
  const edge = mom <= -0.5 ? 'BUY-dip(強跌勢)' : mom >= 0.5 ? 'SELL-rip(強升勢)' : null;
  if (!edge) return null;
  const regime = typeof item.regime === 'string' ? item.regime : '?';
  const gate = typeof item.gateBlocked === 'string' && item.gateBlocked.length > 0 ? item.gateBlocked : null;
  return `⚠️ ${sym}: 「${edge}」訊號存在(4h ${mom >= 0 ? '+' : ''}${mom.toFixed(2)}%, regime=${regime})但冇開倉${gate ? ` — 屏障: ${gate}` : ''} — 潛在 missed edge / alpha 改善候選`;
}

/** append 去 file(atomic temp+rename)。非 string line → String() 兜底; \n 摺疊防結構注入。 */
export function appendInvestigation(filePath: string, lines: string[]): void {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const fs = require('node:fs');
  const header = lines.map((l) => String(l ?? '').replace(/\r?\n/g, ' ').slice(0, 300));
  const block = `\n${header.join('\n')}\n`;
  try {
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `# MATS Investigation\n\n> 每 Cycle 檢討 Selected Market Pairs —— 點解冇開倉 / 開咗嘅點解賺蝕 / 當前狀況成因 / Edge & Alpha 改善方向(活文檔, 規則式, 任何模式自動維持)\n`;
    fs.writeFileSync(tmp, prev + block, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { console.warn(`[investigation] append failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
  }
}

/**
 * 覆寫「當前 Cycle 檢討」section(活文檔——每 cycle 更新反映最新狀況)。
 * @param sectionTitle 例如「📍 當前 Cycle 檢討」——以「## <title>」開頭嘅 block 會被覆寫。
 */
export function writeCurrentInvestigationSection(filePath: string, sectionTitle: string, body: string | null): void {
  const fs = require('node:fs');
  try {
    if (body === null || body.length === 0) return;
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `# MATS Investigation\n`;
    const marker = `## ${sectionTitle}`;
    // 以 marker 開頭嘅 block → 由 marker 到(下一個 ## 或者檔尾) 被替換
    const markerIdx = prev.indexOf(marker);
    let updated: string;
    if (markerIdx < 0) {
      updated = prev + `\n${body}\n`; // 未存在 → append
    } else {
      const nextMarker = prev.indexOf('\n## ', markerIdx + marker.length);
      const before = prev.slice(0, markerIdx);
      const after = nextMarker < 0 ? '' : prev.slice(nextMarker);
      updated = before + body + (after.length > 0 ? `\n${after}` : '\n');
    }
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, updated, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { console.warn(`[investigation] section write failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
  }
}
