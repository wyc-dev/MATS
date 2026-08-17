// ─── Regime Win-Rate Learner (v2.0.869-P15) ───────────────────────────
//
// 主神洞察:隔 12-24 小時嘅 trade,開倉 regime 同平倉 regime 可以完全唔同。
// 呢個組件學「開倉 regime × 平倉 regime × side」嘅時間加權混合 win rate,
// 用嚟偵測「regime 反轉」(開倉 regime 轉去一個歷史 win rate 低嘅平倉 regime)。
//
// 混合:單 symbol 80% + 跨 symbol 20%(主神裁決)。
// 時間衰減:weight = exp(−Δt / 24h)——舊 trade 影響指數衰減。
//
// 用途:Regime-Reversal Profit Lock gate(組合信號 MFE ≥ 1.5×ATR AND P(win) < 0.5)。

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'regime-win-rate' });

const MAX_TRADES = 300;                 // ring buffer cap
const MIN_SAMPLES = 10;                 // 最少加權樣本(每 cell)
const TAU_MS = 24 * 3600 * 1000;        // τ = 24h(regime 轉變長周期)
const W_SYMBOL = 0.8;                   // 單 symbol 權重(主神裁決)
const W_CROSS = 0.2;                    // 跨 symbol 權重
const DEFAULT_PATH = 'data/evolution/regime-win-rate.json';

interface RegimeWinRateTrade {
  entryRegime: string;
  closeRegime: string;
  side: 'buy' | 'sell';
  symbol: string;
  pnl: number;
  closedAt: number;
}

interface RegimeWinRateState {
  version: number;
  savedAt: number;
  trades: RegimeWinRateTrade[];
}

function emptyState(): RegimeWinRateState {
  return { version: 1, savedAt: 0, trades: [] };
}

export class RegimeWinRateLearner {
  private state: RegimeWinRateState = emptyState();
  private path: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(path = DEFAULT_PATH) {
    this.path = path;
  }

  /** 平倉時記錄 (entryRegime, closeRegime, side, symbol, pnl, closedAt)。 */
  recordTrade(
    entryRegime: string | undefined,
    closeRegime: string | undefined,
    side: 'buy' | 'sell',
    symbol: string | undefined,
    pnl: number | undefined,
    closedAt: number | undefined,
  ): void {
    try {
      const e = String(entryRegime ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
      const c = String(closeRegime ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
      const s: 'buy' | 'sell' = side === 'sell' ? 'sell' : 'buy';
      const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
      const p = Number.isFinite(pnl) ? (pnl as number) : 0;
      const t = Number.isFinite(closedAt) ? (closedAt as number) : Date.now();
      if (!e || !c || !sym) return;
      this.state.trades.push({ entryRegime: e, closeRegime: c, side: s, symbol: sym, pnl: p, closedAt: t });
      if (this.state.trades.length > MAX_TRADES) {
        this.state.trades = this.state.trades.slice(-MAX_TRADES);
      }
      this.markDirty();
    } catch { /* 非致命——learner 唔影響交易 */ }
  }

  /**
   * 計算時間加權混合 win rate P(win | entryRegime × closeRegime × side × symbol)。
   * 混合:單 symbol 80% + 跨 symbol 20%。樣本不足 → null(唔鎖)。
   */
  getWinRate(entryRegime: string, closeRegime: string, side: 'buy' | 'sell', symbol: string): number | null {
    try {
      const now = Date.now();
      let symWins = 0;
      let symTotal = 0;
      let crossWins = 0;
      let crossTotal = 0;

      for (const t of this.state.trades) {
        if (t.entryRegime !== entryRegime || t.closeRegime !== closeRegime || t.side !== side) continue;
        const weight = Math.exp(-(now - t.closedAt) / TAU_MS);
        const win = t.pnl > 0;
        crossTotal += weight;
        if (win) crossWins += weight;
        if (t.symbol === symbol) {
          symTotal += weight;
          if (win) symWins += weight;
        }
      }

      if (crossTotal < MIN_SAMPLES) return null; // 跨 symbol 樣本不足 → 唔鎖

      const pCross = crossWins / crossTotal;
      if (symTotal < MIN_SAMPLES) return pCross; // 單 symbol 樣本不足 → 跨 symbol 兜底

      const pSymbol = symWins / symTotal;
      return W_SYMBOL * pSymbol + W_CROSS * pCross;
    } catch {
      return null;
    }
  }

  getStats(): { trades: number } {
    return { trades: this.state.trades.length };
  }

  private markDirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  save(): void {
    try {
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.state, savedAt: Date.now() }), 'utf-8');
      fs.renameSync(tmp, this.path);
    } catch (err) {
      log.warn(`[regime-win-rate] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as Record<string, unknown>;
      const clean = emptyState();
      if (raw && typeof raw === 'object' && Array.isArray(raw['trades'])) {
        for (const t of raw['trades'] as unknown[]) {
          if (!t || typeof t !== 'object') continue;
          const o = t as Record<string, unknown>;
          const entryRegime = String(o['entryRegime'] ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
          const closeRegime = String(o['closeRegime'] ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
          const side: 'buy' | 'sell' = o['side'] === 'sell' ? 'sell' : 'buy';
          const symbol = String(o['symbol'] ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
          const pnl = Number.isFinite(o['pnl']) ? (o['pnl'] as number) : 0;
          const closedAt = Number.isFinite(o['closedAt']) ? (o['closedAt'] as number) : Date.now();
          if (!entryRegime || !closeRegime || !symbol) continue;
          clean.trades.push({ entryRegime, closeRegime, side, symbol, pnl, closedAt });
        }
        clean.trades = clean.trades.slice(-MAX_TRADES);
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[regime-win-rate] load failed (fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.state = emptyState();
    }
  }
}

/** 全系統共享單例 */
export const regimeWinRateLearner = new RegimeWinRateLearner();
