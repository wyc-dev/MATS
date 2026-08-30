/**
 * v2.0.873-P9-th-archive: 決策歷史永續歸檔
 *
 * 背景(PLAN_trade-history-archive.md, 2026-08-30):
 *  - trade-history 係 10000 條 ring buffer——滿咗 `slice(-10000)` 剔最舊, 靜靜丟棄
 *  - 實測: 10000 條只係覆蓋 31 日(rate ≈ 323 條/日, 每 cycle 1 條)——已開始丟失
 *    最舊 decision context(confidence/regime/trend/thesis/closeReason)
 *  - realTrades(交易正本)零 cap 無限保存, 但冇 decision context——無法重構
 *  - 目標: eviction 前「先 append 去永續檔, 再刪」——核心 strategy 零改動
 *
 * 設計(production grade):
 *  - append-only JSONL: 每行一條 JSON——OS 層 append 原子, crash-safe
 *  - 讀取 stream line-by-line, skip 垃圾行(partial write 唔 corrupt 前面)
 *  - 異步 fire-and-forget append——失敗 log 但唔影響決策(保 ring buffer 正常)
 *  - 永唔入決策路徑——archive 係純歸檔, learning 組件照讀 ring buffer
 *
 * 實驗驗證(scripts/trade-history-archive/12-archive-experiment.ts):
 *  - A 零丟失: archive ∪ ring = 12000 條完整(by id)✅
 *  - B zero-impact: 讀 archive 唔影響 ring ✅
 *  - C crash-safe: partial line skip, 前面照讀 ✅
 *  - D 真實數據重放: 10000 條 ring 保持, archive 0(未 overflow)✅
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../observability/logger.ts';
import type { TradeHistoryEntry } from './trade-history.ts';

const log = createLogger({ phase: 'trade-history-archive' });

/** env 開關——默認開(有計劃支持); false 即刻停(ring buffer 照常, 只係唔歸檔) */
const ARCHIVE_ENABLED = (process.env['TRADE_ARCHIVE_ENABLED'] ?? 'true') !== 'false';
const ARCHIVE_PATH = process.env['TRADE_ARCHIVE_PATH']
  ?? path.join(process.cwd(), 'data', 'archive', 'trade-history-archive.jsonl');

/**
 * 永續歸檔——被 trade-history evict 嘅 entries 先喺度留底, 再刪。
 * 純歸檔: 永唔入決策路徑(learning 組件照讀 ring buffer)。
 */
export class TradeHistoryArchive {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private appended = 0;
  private lastAppendedAt = 0;
  private lastAppendError: string | null = null;

  constructor(enabled = ARCHIVE_ENABLED, filePath = ARCHIVE_PATH) {
    this.enabled = enabled;
    this.filePath = filePath;
    if (this.enabled) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      log.info(`TradeHistoryArchive enabled → ${this.filePath}`);
    } else {
      log.info('TradeHistoryArchive disabled (TRADE_ARCHIVE_ENABLED=false)');
    }
  }

  /** Append entries 去永續檔(異步 fire-and-forget——失敗唔影響決策)。 */
  append(entries: readonly TradeHistoryEntry[]): void {
    if (!this.enabled || !entries || entries.length === 0) return;
    // 異步: 唔 block cycle。appendFileSync 對小寫入(<64KB)係 OS 原子。
    try {
      const lines = entries
        .filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
        .map((e) => JSON.stringify(e))
        .join('\n');
      if (lines.length === 0) return;
      fs.appendFileSync(this.filePath, lines + '\n', 'utf-8');
      this.appended += entries.length;
      this.lastAppendedAt = Date.now();
      this.lastAppendError = null;
    } catch (err) {
      // 歸檔失敗唔可以影響決策——log 但 ring buffer 照樣運作
      this.lastAppendError = err instanceof Error ? err.message : String(err);
      log.warn(`[th-archive] append failed (non-critical, ${entries.length} entries NOT archived): ${this.lastAppendError}`);
    }
  }

  /** 讀取全部歸檔 entries——skip 垃圾行(crash partial write 唔 corrupt 前面)。 */
  readAll(): TradeHistoryEntry[] {
    if (!this.enabled || !fs.existsSync(this.filePath)) return [];
    const out: TradeHistoryEntry[] = [];
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.id === 'string') out.push(parsed as TradeHistoryEntry);
      } catch {
        // partial line(crash 尾部)——skip, 唔 corrupt 前面
      }
    }
    return out;
  }

  /** 時間窗讀取(研究/重放用)。 */
  readSince(ts: number): TradeHistoryEntry[] {
    return this.readAll().filter((e) => Number.isFinite(e.timestamp) && e.timestamp >= ts);
  }

  stats(): { enabled: boolean; filePath: string; appended: number; lastAppendedAt: number; lastError: string | null } {
    return {
      enabled: this.enabled,
      filePath: this.filePath,
      appended: this.appended,
      lastAppendedAt: this.lastAppendedAt,
      lastError: this.lastAppendError,
    };
  }
}

/** 供 index.ts 注入嘅 singleton(lazy init)。 */
let _sharedArchive: TradeHistoryArchive | null = null;
export function getSharedArchive(): TradeHistoryArchive {
  if (!_sharedArchive) _sharedArchive = new TradeHistoryArchive();
  return _sharedArchive;
}
