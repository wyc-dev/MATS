// ─── Supabase Trade Writer (v2.0.868) — close 事件 → Supabase trade_records ──
//
// 背景:v2.0.867-fix B 寫 `trades` 表——但該表係 mats_app 早期手動建
// (id/user_id/direction/buy_price/sell_price/pnl/sell_time/buy_time/source_id)
// 冇 migration 定義——同本 writer 期望結構(trade_id/side/entry_price/pnl_pct)
// 完全唔 match → select('trade_id') 報 42703 column does not exist
// → 由 v2.0.867 起每次寫入都失敗(catch + log.warn 吞咗)→ UI Trade Incident
// 永遠讀唔到新 trade。
//
// 修正(v2.0.868):新表 `trade_records`(migration 00000000000020)——完整結構、
// trade_id unique constraint → 直接 upsert(idempotent 原子)——唔再 select→update。
// Production grade:
//   · upsert onConflict trade_id(重複 close 事件唔重複 row——idempotent)
//   · 非阻塞(void .catch——寫失敗唔影響交易)
//   · 冇 Supabase key → skip(本地模式)
//   · opened_at/closed_at 存 epoch ms(bigint column——唔使 ISO string)

import { createLogger } from '../observability/logger.ts';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const log = createLogger({ phase: 'supabase-trades' });

export class SupabaseTradeWriter {
  private client: SupabaseClient | null = null;
  private userId: string;
  /** v2.0.867-fix:idempotent——同一 trade 只寫一次(close 事件可兩次) */
  private writtenIds: Set<string> = new Set();

  constructor() {
    const url = process.env['SUPABASE_URL'] ?? '';
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
    this.userId = process.env['SUPABASE_USER_ID'] ?? 'system';
    if (url && key) {
      try {
        this.client = createClient(url, key);
        log.info('✓ SupabaseTradeWriter enabled (trades → Supabase)');
      } catch {
        this.client = null;
        log.warn('[supabase-trades] client init failed — disabled (local-only mode)');
      }
    } else {
      log.warn('[supabase-trades] Supabase not configured — disabled (local-only mode)');
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * close 事件 → 寫 Supabase trades(非阻塞 + idempotent)。
   * 失敗只 warn——永遠唔影響交易流程。
   */
  recordTrade(trade: {
    id?: string | number; symbol?: string; side?: string;
    entryPrice?: number; exitPrice?: number; quantity?: number;
    pnl?: number; pnlPct?: number; openedAt?: number; closedAt?: number;
    entryThesis?: string; exitThesis?: string; closeReason?: string;
    leverage?: number; investment?: number; minValueReached?: number;
    maxValueReached?: number; agentId?: string;
  }, source: 'paper' | 'real'): void {
    if (!this.client) return;
    const tradeId = String(trade.id ?? '');
    if (!tradeId || !trade.symbol) return;
    if (this.writtenIds.has(tradeId)) return; // 同一 trade 兩次 close → 只寫一次
    this.writtenIds.add(tradeId);
    if (this.writtenIds.size > 500) {
      const first = this.writtenIds.values().next().value as string | undefined;
      if (first) this.writtenIds.delete(first);
    }

    // v2.0.868:trade_records 表 opened_at/closed_at 係 bigint(epoch ms)——直接存
    const closedAtMs = Number.isFinite(trade.closedAt) && (trade.closedAt as number) > 0
      ? Math.round(trade.closedAt as number)
      : null;
    const openedAtMs = Number.isFinite(trade.openedAt) && (trade.openedAt as number) > 0
      ? Math.round(trade.openedAt as number)
      : null;
    const num = (v: unknown): number | null => Number.isFinite(v) ? v as number : null;
    const str = (v: unknown, max = 2000): string | null =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

    const row = {
      trade_id: tradeId,
      symbol: String(trade.symbol ?? '').slice(0, 24),
      side: trade.side === 'sell' ? 'sell' : 'buy',
      mode: source,
      entry_price: num(trade.entryPrice),
      exit_price: num(trade.exitPrice),
      quantity: num(trade.quantity),
      leverage: num(trade.leverage),
      investment: num(trade.investment),
      pnl: num(trade.pnl),
      pnl_pct: num(trade.pnlPct),
      opened_at: openedAtMs,
      closed_at: closedAtMs,
      close_reason: str(trade.closeReason, 64),
      entry_thesis: str(trade.entryThesis),
      exit_thesis: str(trade.exitThesis),
      min_value_reached: num(trade.minValueReached),
      max_value_reached: num(trade.maxValueReached),
      agent_id: str(trade.agentId, 64),
    };

    // v2.0.868:trade_records 表有 trade_id unique constraint → 直接 upsert
    // (原子 + idempotent——唔再需要 select→update/insert 兩步)
    const c = this.client;
    void Promise.resolve(c.from('trade_records').upsert(row, { onConflict: 'trade_id' }))
      .then(({ error }) => {
        if (error) {
          log.warn(`[supabase-trades] write failed for ${tradeId}: ${error.message}`);
        }
      })
      .catch((err: unknown) => {
        log.warn(`[supabase-trades] write failed (${tradeId}): ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}

/** 全系統共享單例 */
export const supabaseTradeWriter = new SupabaseTradeWriter();
