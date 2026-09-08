// research/event-archive.ts — long-term append-only research archive for shadow
// trade resolution events («entry rationale + outcome» pairs).
//
// P1(audit #2): recentResults 係「短期決策窗」(cap 200 / prune 4h)——兼任研究檔案
// 係架構缺口(舊配對消失)。呢個模組提供獨立嘅長期 append-only jsonl 存檔:
//   - 每條記錄有 unique id(shadow pos.id)→ load 時 Set 冪等(重啟/重複 append 唔會 double)
//   - append 唔會改寫舊記錄(研究數據完整性)
//   - readResearchEvents() 供離線驗證腳本(ρ / 分桶 / IS-OOS)——直接餵 /tmp/matsim 引擎
//
// 用法:
//   const archive = new EventArchive(RESEARCH_SHADOW_EVENTS_PATH);
//   archive.append(records);            // 增量歸檔(冪等)
//   const all = archive.read();         // 研究讀取
import { existsSync, readFileSync, appendFileSync } from 'fs';

export interface ResearchShadowEvent {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'win' | 'loss';
  pnlPct: number;
  resolvedAt: number;
  openedAt?: number;
  exitReason?: string;
  shadowType?: string;
  /** entry-time rationale snapshot(白名單 sanitise 過) */
  sentimentAtEntry?: number;
  sentimentConvictionAtEntry?: number;
  fundingRateAtEntry?: number;
  volatilityAtEntry?: number;
  srDistanceBpsAtEntry?: number;
  obImbalanceAtEntry?: number;
  volumeRatioAtEntry?: number;
  /** self-referential shadow stats at open */
  entryShadowWRAtOpen?: number;
  entryShadowNAtOpen?: number;
  entryShadowPnlSumAtOpen?: number;
}

export class EventArchive {
  private ids = new Set<string>();

  constructor(private readonly filePath: string) {
    this.seedIds();
  }

  private seedIds(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.id === 'string') this.ids.add(r.id);
        } catch { /* skip corrupt line — research archive is best-effort */ }
      }
    } catch { /* file absent/unreadable — start empty */ }
  }

  /** 已歸檔 id 數量(供監控) */
  count(): number { return this.ids.size; }

  /** 追加新記錄(冪等: 已存在 id 跳過)。返回實際寫入數。 */
  append(records: ResearchShadowEvent[]): number {
    let written = 0;
    for (const r of records) {
      if (!r || typeof r.id !== 'string' || this.ids.has(r.id)) continue;
      this.ids.add(r.id);
      try {
        appendFileSync(this.filePath, JSON.stringify(r) + '\n', 'utf8');
        written++;
      } catch { /* disk error — 唔好 crash production cycle */ }
    }
    return written;
  }

  /** 讀取全部研究記錄(離線驗證用) */
  read(): ResearchShadowEvent[] {
    if (!existsSync(this.filePath)) return [];
    const out: ResearchShadowEvent[] = [];
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.id === 'string') out.push(r);
        } catch { /* skip corrupt */ }
      }
    } catch { /* ignore */ }
    return out;
  }
}
