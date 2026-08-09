// ─── Supabase Trade Writer (v2.0.867-fix B) — close 事件 → Supabase trades ──
//
// 主神問題:「Trade Incident 呢個交易的資料消失了」——
// 徹查:UI Trade Incident 讀 Supabase `trades` 表,但係「冇人自動寫」
// (後端 SupabaseAnalysisWriter 只寫 asset_analyses;mats_app 只讀唔寫)
// → close 事件唔填充 Supabase trades → UI 唔顯示 = 「消失」
//
// 修復:close 事件 → 寫 Supabase trades(by trade id idempotent + 非阻塞)。
// Production grade:
//   · idempotent(by trade id——同一 trade 兩次 close 只寫一次)
//   · 非阻塞(void .catch——寫失敗唔影響交易)
//   · 冇 Supabase key → skip(本地模式)
//   · 字段映射 TradeRecord → UserTrade row(同 mats_frontend supabase.ts 一致)
//   · upsert onConflict trade_id(重複寫都唔會重複 row)

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
    entryThesis?: string; leverage?: number;
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

    const closedAt = Number.isFinite(trade.closedAt) && (trade.closedAt as number) > 0
      ? new Date(trade.closedAt as number).toISOString()
      : new Date().toISOString();
    const openedAt = Number.isFinite(trade.openedAt) && (trade.openedAt as number) > 0
      ? new Date(trade.openedAt as number).toISOString()
      : null;
    const holdMin = openedAt && Number.isFinite(trade.closedAt)
      ? Math.max(0, Math.round(((trade.closedAt as number) - (trade.openedAt as number)) / 60000))
      : 0;

    const row = {
      trade_id: tradeId,
      user_id: this.userId,
      symbol: trade.symbol.slice(0, 24),
      direction: trade.side === 'sell' ? 'SHORT' : 'LONG',
      entry_price: Number.isFinite(trade.entryPrice) ? trade.entryPrice : null,
      exit_price: Number.isFinite(trade.exitPrice) ? trade.exitPrice : null,
      size: Number.isFinite(trade.quantity) ? trade.quantity : null,
      leverage: Number.isFinite(trade.leverage) ? trade.leverage : null,
      pnl: Number.isFinite(trade.pnl) ? trade.pnl : null,
      pnl_pct: Number.isFinite(trade.pnlPct) ? trade.pnlPct : null,
      duration: `${holdMin}min`,
      thesis: typeof trade.entryThesis === 'string' ? trade.entryThesis.slice(0, 500) : null,
      source,
      opened_at: openedAt,
      closed_at: closedAt,
    };

    // v2.0.867-fix-attack (V12):onConflict 'trade_id' 需要 unique constraint——
    // trades 表(migration 未定義)可能冇——upsert 會報錯 → 每次 insert 重複 row!
    // 改用「select → update/insert」(唔靠 constraint——idempotent by trade_id)
    const c = this.client;
    void Promise.resolve(c.from('trades').select('trade_id').eq('trade_id', tradeId).maybeSingle()).then(({ data }) => {
      if (data) {
        return Promise.resolve(c.from('trades').update(row).eq('trade_id', tradeId));
      }
      return Promise.resolve(c.from('trades').insert(row));
    }).then(({ error }: { error: { message: string } | null }) => {
      if (error) {
        log.warn(`[supabase-trades] write failed for ${tradeId}: ${error.message}`);
      }
    }).catch((err: unknown) => {
      log.warn(`[supabase-trades] write failed (${tradeId}): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/** 全系統共享單例 */
export const supabaseTradeWriter = new SupabaseTradeWriter();
