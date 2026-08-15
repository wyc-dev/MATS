/**
 * v2.0.869-P3(主神 trade 缺失調查):Trade 對帳機制
 *
 * 問題:HL 有真實 trade——但係 Supabase trade_records(UI 顯示)缺失——
 * recordTrade 寫入失敗(間歇性錯誤——唔 retry)或者 writtenIds skip——
 * trade 永久缺失——冇人發現。
 *
 * 方案:定期對帳——realTrades(本地)vs Supabase trade_records——
 * 缺失 → 補寫(用 realTrades 完整資料——包括 entryThesis/exitThesis)。
 *
 * 用法: npx tsx scripts/reconcile-trades.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

interface LocalTrade {
  id?: string | number;
  symbol?: string;
  side?: string;
  entryPrice?: number;
  exitPrice?: number;
  quantity?: number;
  leverage?: number;
  investment?: number;
  pnl?: number;
  pnlPct?: number;
  openedAt?: number;
  closedAt?: number;
  closeReason?: string;
  entryThesis?: string;
  exitThesis?: string;
  minValueReached?: number;
  maxValueReached?: number;
  agentId?: string;
}

function main(): void {
  const supabaseUrl = process.env['SUPABASE_URL'] ?? '';
  const supabaseKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_KEY'] ?? '';
  if (!supabaseUrl || !supabaseKey) {
    console.log('❌ 冇 Supabase 配置(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)——check .env');
    return;
  }

  // 1. 讀本地 realTrades
  const path = resolve('data/evolution/portfolio-state.json');
  if (!existsSync(path)) {
    console.log('❌ 冇 portfolio-state.json——先跑系統');
    return;
  }
  const state = JSON.parse(readFileSync(path, 'utf-8')) as { realTrades?: LocalTrade[] };
  const localTrades = state.realTrades ?? [];
  console.log(`本地 realTrades: ${localTrades.length} 個`);

  // 2. 讀 Supabase trade_records
  const supabase = createClient(supabaseUrl, supabaseKey);
  supabase.from('trade_records').select('trade_id').then(({ data, error }) => {
    if (error) {
      console.log(`❌ Supabase 讀取失敗: ${error.message}`);
      return;
    }
    const remoteIds = new Set((data ?? []).map((r: { trade_id: string }) => r.trade_id));
    console.log(`Supabase trade_records: ${remoteIds.size} 個`);

    // 3. 搵缺失 trade
    const missing = localTrades.filter(t => {
      // v2.0.869-P3(主神 刁鑽攻擊):null/非物件 skip + NaN id skip(String(NaN) = 'NaN')
      if (!t || typeof t !== 'object') return false;
      const id = String(t.id ?? '').trim();
      if (!id || id === 'NaN') return false;
      return !remoteIds.has(id);
    });
    console.log(`缺失 trade: ${missing.length} 個`);

    if (missing.length === 0) {
      console.log('✅ 冇缺失——全部 trade 已同步');
      return;
    }

    // 4. 補寫(用 realTrades 完整資料——包括 entryThesis/exitThesis)
    let written = 0;
    let failed = 0;
    for (const t of missing) {
      const tradeId = String(t.id ?? '').trim();
      const row = {
        trade_id: tradeId,
        symbol: String(t.symbol ?? '').slice(0, 24),
        side: t.side === 'sell' ? 'sell' : 'buy',
        mode: 'real',
        entry_price: Number.isFinite(t.entryPrice) ? t.entryPrice : null,
        exit_price: Number.isFinite(t.exitPrice) ? t.exitPrice : null,
        quantity: Number.isFinite(t.quantity) ? t.quantity : null,
        leverage: Number.isFinite(t.leverage) ? t.leverage : null,
        investment: Number.isFinite(t.investment) ? t.investment : null,
        pnl: Number.isFinite(t.pnl) ? t.pnl : null,
        pnl_pct: Number.isFinite(t.pnlPct) ? t.pnlPct : null,
        opened_at: Number.isFinite(t.openedAt) && (t.openedAt as number) > 0 ? Math.round(t.openedAt as number) : null,
        closed_at: Number.isFinite(t.closedAt) && (t.closedAt as number) > 0 ? Math.round(t.closedAt as number) : null,
        close_reason: typeof t.closeReason === 'string' ? t.closeReason.slice(0, 64) : null,
        entry_thesis: typeof t.entryThesis === 'string' ? t.entryThesis.slice(0, 2000) : null,
        exit_thesis: typeof t.exitThesis === 'string' ? t.exitThesis.slice(0, 2000) : null,
        min_value_reached: Number.isFinite(t.minValueReached) ? t.minValueReached : null,
        max_value_reached: Number.isFinite(t.maxValueReached) ? t.maxValueReached : null,
        agent_id: String(t.agentId ?? '').slice(0, 64) || null,
      };
      supabase.from('trade_records').upsert(row, { onConflict: 'trade_id' })
        .then(({ error }) => {
          if (error) {
            failed++;
            console.log(`  ❌ ${tradeId} 補寫失敗: ${error.message}`);
          } else {
            written++;
            console.log(`  ✅ ${tradeId} 補寫成功(${t.symbol} ${t.side} entry=${t.entryPrice} exit=${t.exitPrice} pnl=${t.pnl})`);
          }
          if (written + failed === missing.length) {
            console.log(`\n對帳完成:補寫 ${written} 個——失敗 ${failed} 個`);
          }
        });
    }
  });
}

main();
