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
import fs from 'node:fs'; // v2.0.883-investigation-fix: require → ESM import——type=module(ESM) 下 require 爆 ReferenceError → reviewMarketPairs 每 cycle throw → investigation.md 由 09-11 零寫入(根因)
import { atomicWriteSync } from '../evolution/persistence.ts'; // v2.0.884-atomic-unify: 統一 shared atomic helper（unique tmp + dir ensure）取代手寫 tmp+rename（功能重複審計）

/** v2.0.883-attack fix (A2): path traversal 防禦——拒絕含 '..' 嘅 path（出界寫入）;
 * 注意唔可以同時拒絕絕對路徑（測試/外部用絕對 path 係合法）——caller(index.ts)自負相對路徑 */
function isSafeTargetPath(filePath: string): boolean {
  return typeof filePath === 'string' && filePath.length > 0 && !filePath.includes('..');
}

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
    // v2.0.883-attack fix (A6): per-item try/catch——單一垃圾 item（getter bomb / proxy）skip,唔 kill 成個 review
    try {
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
    } catch { /* garbage item——skip,唔影響其他 item */ }
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
  // v2.0.884-edge-label-fix: 0.5% 係 regime 分界（momentum-persistence）,唔係實證 edge——
  // 強動量只係「進入 trend-following 模式」,唔等於正期望。字面修正避免誤導（決策邏輯零改動）。
  const edge = mom <= -0.5 ? 'BUY-dip(強跌勢)' : mom >= 0.5 ? 'SELL-rip(強升勢)' : null;
  if (!edge) return null;
  const regime = typeof item.regime === 'string' ? item.regime : '?';
  const gate = typeof item.gateBlocked === 'string' && item.gateBlocked.length > 0 ? item.gateBlocked : null;
  return `⚠️ ${sym}: 「${edge}」訊號存在(4h ${mom >= 0 ? '+' : ''}${mom.toFixed(2)}%, regime=${regime})但冇開倉${gate ? ` — 屏障: ${gate}` : ''} — 4h 強動量未開倉檢討候選(唔等於實證 edge)`;
}

/** append 去 file(atomic temp+rename)。非 string line → String() 兜底; \n 摺疊防結構注入。 */
export function appendInvestigation(filePath: string, lines: string[]): void {
  if (!isSafeTargetPath(filePath)) return; // v2.0.883-attack fix (A2)
  if (!Array.isArray(lines) || lines.length === 0) return;
  const header = lines.map((l) => String(l ?? '').replace(/\r?\n/g, ' ').slice(0, 300));
  const block = `\n${header.join('\n')}\n`;
  try {
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `# MATS Investigation\n\n> 每 Cycle 檢討 Selected Market Pairs —— 點解冇開倉 / 開咗嘅點解賺蝕 / 當前狀況成因 / Edge & Alpha 改善方向(活文檔, 規則式, 任何模式自動維持)\n`;
    atomicWriteSync(filePath, prev + block); // v2.0.884-atomic-unify: 統一 shared helper
  } catch (err) {
    try { console.warn(`[investigation] append failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
  }
}

/**
 * appendOrMerge(2026-09-10, 主神「每次 Edit 之前檢查 investigation.md 有冇類似觀點, 用修正取代新增」):
 * 寫之前 scan 全文——搵「類似觀點」嘅 entry(行含所有 keyTokens 關鍵字)→ 修正取代新增(更新 timestamp/次數);
 * 冇類似 → 先 append。返 'merged' | 'appended'。pure: 唔 throw, 失敗 → append fallback。
 */
export function appendOrMergeInvestigation(
  filePath: string,
  keyTokens: string[],
  mergedLine: string,
  appendBlock: string[],
): 'merged' | 'appended' {
  if (!isSafeTargetPath(filePath)) return 'appended'; // v2.0.883-attack fix (A2)
  try {
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `# MATS Investigation\n`;
    const tokens = (Array.isArray(keyTokens) ? keyTokens : []).filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    );
    if (tokens.length === 0) { appendInvestigation(filePath, appendBlock); return 'appended'; }
    const lines = prev.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.includes(tokens[0]!)) continue;
      const all = tokens.every((t) => l.includes(t));
      if (!all) continue;
      // v2.0.883-attack fix (A3): mergedLine sanitize——同 append 一致,摺疊 \n + cap 300（防 header/Markdown 注入）
      lines[i] = String(mergedLine ?? '').replace(/\r?\n/g, ' ').slice(0, 300);
      atomicWriteSync(filePath, lines.join('\n')); // v2.0.884-atomic-unify: 統一 shared helper
      return 'merged';
    }
    appendInvestigation(filePath, appendBlock);
    return 'appended';
  } catch {
    try { appendInvestigation(filePath, appendBlock); } catch { /* noop */ }
    return 'appended';
  }
}
export function writeCurrentInvestigationSection(filePath: string, sectionTitle: string, body: string | null): void {
  // v2.0.883-attack fix (A4/A5): type guard——body/sectionTitle 唔係 string、空、或含 header 注入(\n) → 唔寫
  if (!isSafeTargetPath(filePath)) return;
  if (typeof body !== 'string' || body.length === 0) return;
  if (typeof sectionTitle !== 'string' || sectionTitle.length === 0 || sectionTitle.includes('\n')) return;
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
    atomicWriteSync(filePath, updated); // v2.0.884-atomic-unify: 統一 shared helper（unique tmp 內部處理,唔再自己 tmp+rename）
  } catch (err) {
    try { console.warn(`[investigation] section write failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
  }
}
