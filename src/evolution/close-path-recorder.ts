// ─── Close-Path Recorder（v2.0.873-P9-let-run, 2026-09-09）───
//
// 目的（主神 D:candle path 精確重放——「BUY 贏單 let-run」alpha 驗證）:
//   實時記錄「real trade close 後 24h 內嘅 price path 極值」——等樣本累積(2-4 週)
//   後用 p9-let-run-replay.ts 精確重放:「如果 close 晚啲(lock at X% MFE)→ 用真實
//   post-close path 計算實際回收 vs 實收」——零 look-ahead(只用 close 後真實價格,
//   唔用任何預測)。
//
// 純數據基建——零決策邏輯(唔影響任何 gate/decision/learning)。append-only JSONL。
// 攻擊硬化: id/symbol/price garbage → skip(唔記錄污染);價格 clamp 合理範圍;
//           24h 到期 → finalize(唔會永遠 pending 洩漏)。

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ClosedPathRecord {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  closePrice: number;
  closedAt: number;
  /** 開倉至 close 期間 MFE(margin %——由 maxValueReached 折算) */
  mfeAtClosePct: number;
  pnlPctAtClose: number;
  /** 開倉時 4h 動量 lean(finite 先存——重放分方向: dip vs trend) */
  momentumLongAtClose?: number;
  /** post-close 追蹤(空 = 未更新) */
  postClose: { high: number; low: number; last: number; ts: number } | null;
  finalizedAt?: number;
}

const MAX_TS_MS = 1e15;
const WINDOW_MS = 24 * 3600_000;
const MAX_PRICE = 1e8; // 價格 clamp(天文 garbage 唔准入)

export class ClosePathRecorder {
  private pending = new Map<string, ClosedPathRecord>();

  constructor(private file = join(process.cwd(), 'data', 'archive', 'close-path-archive.jsonl')) {}

  /** close 時記錄(P9-let-run):garbage → skip(唔污染) */
  record(input: {
    id: unknown; symbol: unknown; side: unknown; entryPrice: unknown; closePrice: unknown;
    closedAt: unknown; mfeAtClosePct: unknown; pnlPctAtClose: unknown;
    momentumLongAtClose?: unknown;
  }): void {
    try {
      const id = typeof input.id === 'string' ? input.id.slice(0, 64) : '';
      const symbol = typeof input.symbol === 'string' ? input.symbol.replace(/[\x00-\x1F]/g, '').slice(0, 24) : '';
      const side = input.side === 'buy' || input.side === 'sell' ? input.side : '';
      if (!id || !symbol || !side) return;
      // Number(Symbol) throws——全部用 typeof guard(唔可以用 Number() 包 garbage)
      const entry = typeof input.entryPrice === 'number' ? input.entryPrice : NaN;
      const close = typeof input.closePrice === 'number' ? input.closePrice : NaN;
      const ts = typeof input.closedAt === 'number' ? input.closedAt : NaN;
      const mfe = typeof input.mfeAtClosePct === 'number' ? input.mfeAtClosePct : NaN;
      const pnl = typeof input.pnlPctAtClose === 'number' ? input.pnlPctAtClose : NaN;
      if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(close) || close <= 0) return;
      if (!Number.isFinite(ts) || ts <= 0 || ts > MAX_TS_MS) return;
      if (entry > MAX_PRICE || close > MAX_PRICE) return;
      // mfe/pnl 唔 finite(garbage)→ skip——半吊子記錄冇價值(重放會歪曲)
      if (!Number.isFinite(mfe) || !Number.isFinite(pnl)) return;
      this.pending.set(id, {
        id, symbol, side, entryPrice: entry, closePrice: close, closedAt: ts,
        mfeAtClosePct: Math.min(Math.max(mfe, 0), 1000),
        pnlPctAtClose: pnl,
        momentumLongAtClose: typeof input.momentumLongAtClose === 'number' && Number.isFinite(input.momentumLongAtClose) ? Math.min(Math.max(input.momentumLongAtClose as number, -1), 1) : undefined,
        postClose: null,
      });
    } catch { /* skip */ }
  }

  /** 每 cycle 更新 post-close 極值(price 無效/garbage → 唔更新——保守;唔可以 throw) */
  update(symbol: unknown, price: unknown, now: number): void {
    try {
      const sym = typeof symbol === 'string' ? symbol : '';
      const p = typeof price === 'number' && Number.isFinite(price) ? price : NaN; // 唔可以用 Number(garbage)——Symbol throw
      if (!sym || !Number.isFinite(p) || p <= 0 || p > MAX_PRICE) return;
      if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) return;
      for (const rec of this.pending.values()) {
        if (rec.symbol !== sym) continue;
        if (now - rec.closedAt < 0 || now - rec.closedAt > WINDOW_MS) continue;
        const cur = rec.postClose;
        rec.postClose = {
          high: cur ? Math.max(cur.high, p) : p,
          low: cur ? Math.min(cur.low, p) : p,
          last: p,
          ts: now,
        };
      }
    } catch { /* 唔可以 throw——純記錄 */ }
  }

  /** 超過 24h → finalize + append JSONL(append-only)+ 移除 pending */
  finalize(now: number): void {
    if (!Number.isFinite(now) || now <= 0) return;
    const due: ClosedPathRecord[] = [];
    for (const [id, rec] of this.pending) {
      if (now - rec.closedAt >= WINDOW_MS || !rec.postClose) {
        if (now - rec.closedAt >= WINDOW_MS) due.push(rec);
        this.pending.delete(id);
      }
    }
    for (const rec of due) {
      try {
        rec.finalizedAt = now;
        const dir = dirname(this.file);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf-8');
      } catch { /* 非致命 */ }
    }
  }

  pendingCount(): number { return this.pending.size; }
}
