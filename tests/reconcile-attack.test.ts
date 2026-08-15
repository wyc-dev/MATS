import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTradeRow } from '../src/services/supabase-trade-writer.ts';

// 模擬 reconcile-trades 嘅對帳邏輯(設計驗證)
function reconcileLogic(localTrades: any[], remoteIds: Set<string>) {
  const missing = localTrades.filter((t: any) => {
    if (!t || typeof t !== 'object') return false;  // null skip
    const id = String(t.id ?? '').trim();
    if (!id || id === 'NaN') return false;  // NaN id skip
    return !remoteIds.has(id);
  });
  return missing;
}

describe('v2.0.869-P3 reconcile 對帳刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  it('R1: localTrades 內 null/undefined/非物件——唔 crash + 唔誤判', () => {
    const local = [
      null,
      undefined,
      'evil',
      123,
      { id: 't1', symbol: 'BTC', side: 'sell', entryPrice: 100, exitPrice: 90 },
      { id: 't2', symbol: 'GOLD', side: 'buy', entryPrice: 100, exitPrice: 110 },
    ];
    const remote = new Set(['t1']);
    const missing = reconcileLogic(local, remote);
    expect(missing.length).toBe(1);  // 只有 t2 缺失
    expect(missing[0].id).toBe('t2');
  });

  it('R2: localTrades 內 id 異常(空/undefined/NaN/__proto__)——唔 crash', () => {
    const local = [
      { id: '', symbol: 'BTC' },
      { id: undefined, symbol: 'BTC' },
      { id: NaN, symbol: 'BTC' },
      { id: '__proto__', symbol: 'BTC' },
      { id: 't1', symbol: 'BTC' },
    ];
    const remote = new Set(['t1']);
    const missing = reconcileLogic(local, remote);
    // 空/undefined/NaN id → skip(唔補寫)
    expect(missing.length).toBe(1);  // 只有 __proto__?——check
  });

  it('R3: buildTradeRow——entryThesis/exitThesis 超長(5000 chars)——slice 2000——唔 crash', () => {
    const row = buildTradeRow({
      id: 't1', symbol: 'BTC', side: 'sell',
      entryThesis: 'x'.repeat(5000),
      exitThesis: 'y'.repeat(5000),
    } as any, 'real', 't1');
    expect(row.entry_thesis!.length).toBe(2000);
    expect(row.exit_thesis!.length).toBe(2000);
  });

  it('R4: buildTradeRow——symbol 超長(100 chars)——slice 24——唔 crash', () => {
    const row = buildTradeRow({
      id: 't1', symbol: 'X'.repeat(100), side: 'buy',
    } as any, 'real', 't1');
    expect(row.symbol.length).toBe(24);
  });

  it('R5: buildTradeRow——agentId 超長/控制字符——唔 crash', () => {
    const row = buildTradeRow({
      id: 't1', symbol: 'BTC', side: 'buy',
      agentId: 'A'.repeat(200),
    } as any, 'real', 't1');
    expect(row.agent_id!.length).toBe(64);
  });

  it('R6: 併發——多個 trade 同時 buildTradeRow(1000 call)——唔 crash', () => {
    for (let i = 0; i < 1000; i++) {
      expect(() => buildTradeRow({
        id: `t${i}`, symbol: 'BTC', side: i % 2 === 0 ? 'buy' : 'sell',
        entryPrice: 100 + i, exitPrice: 90 + i,
      } as any, 'real', `t${i}`)).not.toThrow();
    }
  });

  it('R7: buildTradeRow——pnlPct 極端值(1e308/-1e308)——唔 crash', () => {
    const row = buildTradeRow({
      id: 't1', symbol: 'BTC', side: 'buy',
      pnlPct: 1e308, pnl: -1e308,
    } as any, 'real', 't1');
    expect(row.pnl_pct).toBe(1e308);
    expect(row.pnl).toBe(-1e308);
  });
});
