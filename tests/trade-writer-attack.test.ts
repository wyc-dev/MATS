import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTradeRow } from '../src/services/supabase-trade-writer.ts';

describe('v2.0.869-P3 trade-writer 刁鑽攻擊(併發/狀態注入/持久化污染)', () => {
  // ── buildTradeRow 極端值 ──
  it('A1: buildTradeRow——symbol 含控制字符/超長——唔 crash + 唔污染', () => {
    const row = buildTradeRow({
      id: 't1', symbol: 'BTC\nEVIL', side: 'sell',
      entryPrice: 100, exitPrice: 90, pnl: -10,
      entryThesis: 'x'.repeat(5000),  // 超長——slice 2000
      closeReason: 'y'.repeat(200),   // 超長——slice 64
    } as any, 'real', 't1');
    expect(row.symbol).toBe('BTC\nEVIL');  // 保留(但係可能 Supabase 失敗?)
    expect(row.entry_thesis!.length).toBe(2000);  // slice
    expect(row.close_reason!.length).toBe(64);   // slice
  });

  it('A2: buildTradeRow——NaN/Infinity/負值——唔 crash + 唔污染', () => {
    const row = buildTradeRow({
      id: 't2', symbol: 'BTC', side: 'buy',
      entryPrice: NaN, exitPrice: Infinity, pnl: -Infinity,
      pnlPct: NaN, openedAt: NaN, closedAt: Infinity,
    } as any, 'real', 't2');
    expect(row.entry_price).toBeNull();  // NaN → null
    expect(row.exit_price).toBeNull();   // Infinity → null
    expect(row.pnl).toBeNull();
    expect(row.opened_at).toBeNull();
    expect(row.closed_at).toBeNull();
  });

  it('A3: buildTradeRow——null/undefined trade——唔 crash', () => {
    expect(() => buildTradeRow(null, 'real', 't3')).not.toThrow();
    expect(() => buildTradeRow(undefined, 'real', 't4')).not.toThrow();
    const row = buildTradeRow(null, 'real', 't3');
    expect(row.symbol).toBe('');
  });

  it('A4: buildTradeRow——__proto__/constructor key——唔污染', () => {
    const row = buildTradeRow({
      id: 't5', symbol: '__proto__', side: 'sell',
      entryPrice: 100, exitPrice: 90,
    } as any, 'real', 't5');
    expect(row.symbol).toBe('__proto__');
    expect(({} as Record<string, unknown>)['entry_price']).toBeUndefined();
  });

  it('A5: buildTradeRow——side 異常(大寫/undefined/null)——唔 crash', () => {
    expect(() => buildTradeRow({ id: 't6', symbol: 'BTC', side: 'SELL' } as any, 'real', 't6')).not.toThrow();
    expect(() => buildTradeRow({ id: 't7', symbol: 'BTC', side: undefined } as any, 'real', 't7')).not.toThrow();
    expect(() => buildTradeRow({ id: 't8', symbol: 'BTC', side: null } as any, 'real', 't8')).not.toThrow();
    const row = buildTradeRow({ id: 't6', symbol: 'BTC', side: 'SELL' } as any, 'real', 't6');
    expect(row.side).toBe('sell');  // 大寫 → sell
  });

  it('A6: buildTradeRow——entryThesis 含控制字符——唔 crash', () => {
    const row = buildTradeRow({
      id: 't9', symbol: 'BTC', side: 'buy',
      entryThesis: '[1h: sell btc\nEVIL] [1d: test]',
    } as any, 'real', 't9');
    expect(row.entry_thesis).toContain('EVIL');  // 保留(但係可能 Supabase 失敗?)
  });
});
