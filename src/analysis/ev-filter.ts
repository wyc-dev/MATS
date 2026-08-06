// ─── EV Filter (v2.0.865) — 期望值過濾器(量化金融分析師核心) ─────────
//
// 主神數據:30 日 757 fills net -$10,手續費 $9.75 為主——「手續費絞肉機」。
// 問題:系統開太多「期望值 ≈ 手續費」嘅低質素單——win rate 高但 avg win
// 細過 avg loss + 手續費 → 負 EV。
//
// Quant 思維:每筆 trade 嘅「期望淨 PnL」(含手續費)必須 > 0 先值得開。
//   per (symbol × side):用實際 pnlPct(已含費)分布:
//     pWin = P(pnl > 0)
//     avgWin = mean(pnl | pnl > 0)
//     avgLoss = mean(|pnl| | pnl < 0)
//     EV = pWin×avgWin − (1−pWin)×avgLoss
//   EV > 0 → ×1.0(正 EV 唔郁)
//   EV < 0 → 軟性降 ×[0.75, 0.98](EV 愈負降愈多)——永遠唔 hard block
//   樣本 < 20 → neutral(冷啟動)
//
// 對應主神「提高判斷力,唔好 hard block」原則——soft conviction multiplier。

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'ev-filter' });

const MIN_SAMPLES = 20;             // 每 (symbol×side) 最少樣本
const DEFAULT_PATH = 'data/evolution/ev-filter.json';

export interface EVFilterState {
  /** per (symbol|side) → 最近 pnlPct 樣本 */
  samples: Record<string, number[]>;
}

const MAX_SAMPLES_PER_KEY = 300;

function key(symbol: string, side: 'buy' | 'sell'): string {
  return `${symbol}|${side}`;
}

function emptyState(): EVFilterState {
  return { samples: {} };
}

/** 從樣本計算 EV(分佈思維:median 優先抗 skew) */
export function computeEV(samples: number[]): { ev: number; pWin: number; avgWin: number; avgLoss: number; n: number } {
  const wins = samples.filter((p) => p > 0);
  const losses = samples.filter((p) => p <= 0);
  const n = samples.length;
  if (n === 0) return { ev: 0, pWin: 0, avgWin: 0, avgLoss: 0, n: 0 };
  const pWin = wins.length / n;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + Math.abs(b), 0) / losses.length : 0;
  return { ev: pWin * avgWin - (1 - pWin) * avgLoss, pWin, avgWin, avgLoss, n };
}

/** EV → gate 乘數(負 EV 軟性降,愈負降愈多——永遠唔 hard block) */
export function evToMultiplier(ev: number, n: number): number {
  if (!Number.isFinite(ev) || n < MIN_SAMPLES) return 1.0;
  if (ev >= 0) return 1.0;
  // EV < 0:線性壓抑——EV=-0.1% → ×0.98;EV=-0.5% → ×0.90;EV=-1% → ×0.75(floor)
  const clamp = Math.max(-1.0, Math.min(0, ev)); // ev 範圍 [-1%, 0]
  const mult = 1.0 + clamp * 0.25; // -1% → 0.75
  return Math.max(0.75, Math.min(1.0, mult));
}

export class EVFilter {
  private state: EVFilterState;
  private path: string;

  constructor(path = DEFAULT_PATH) {
    this.state = emptyState();
    this.path = path;
  }

  /** 每筆 trade close 時記錄實際 pnlPct(已含手續費) */
  recordTrade(symbol: string, side: 'buy' | 'sell', pnlPct: number): void {
    if (!symbol || (side !== 'buy' && side !== 'sell')) return;
    if (!Number.isFinite(pnlPct)) return;
    const k = key(symbol.slice(0, 24), side);
    const arr = this.state.samples[k] ?? [];
    arr.push(pnlPct);
    if (arr.length > MAX_SAMPLES_PER_KEY) arr.splice(0, arr.length - MAX_SAMPLES_PER_KEY);
    this.state.samples[k] = arr;
  }

  /** 該 (symbol × side) 嘅期望值統計 */
  getEVStats(symbol: string, side: 'buy' | 'sell'): { ev: number; pWin: number; avgWin: number; avgLoss: number; n: number } {
    const k = key(symbol, side);
    const arr = this.state.samples[k];
    if (!arr || arr.length === 0) return { ev: 0, pWin: 0, avgWin: 0, avgLoss: 0, n: 0 };
    return computeEV(arr);
  }

  /** gate 乘數 ×[0.75, 1.0]——正 EV 唔郁,負 EV 軟性降 */
  getEVMultiplier(symbol: string, side: 'buy' | 'sell'): number {
    const { ev, n } = this.getEVStats(symbol, side);
    return evToMultiplier(ev, n);
  }

  /** 注入 Meta-Agent 嘅 block */
  getEVBlock(symbol: string, side: 'buy' | 'sell'): string {
    const { ev, pWin, avgWin, avgLoss, n } = this.getEVStats(symbol, side);
    if (n < MIN_SAMPLES) return '';
    const mult = this.getEVMultiplier(symbol, side);
    return `=== EV FILTER (${symbol} × ${side}) ===\n  期望值 EV: ${(ev * 100).toFixed(2)}%(pWin ${(pWin * 100).toFixed(0)}%, avgWin ${(avgWin * 100).toFixed(2)}%, avgLoss ${(avgLoss * 100).toFixed(2)}%, n=${n})\n  (EV < 0 = 手續費都搵唔返——呢個方向唔值得開;乘數 ×${mult.toFixed(2)})`;
  }

  getStats(): { keys: number; totalSamples: number } {
    let total = 0;
    for (const arr of Object.values(this.state.samples)) total += arr.length;
    return { keys: Object.keys(this.state.samples).length, totalSamples: total };
  }

  save(): void {
    try {
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.state }), 'utf-8');
    } catch (err) {
      log.warn(`[ev-filter] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as EVFilterState;
      const clean = emptyState();
      if (raw && typeof raw === 'object' && raw.samples && typeof raw.samples === 'object') {
        for (const [k, arr] of Object.entries(raw.samples)) {
          // v2.0.865-attack: __proto__/constructor/prototype 毒 key 跳過
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (!Array.isArray(arr)) continue;
          const cleanArr = arr
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
            .slice(-MAX_SAMPLES_PER_KEY);
          if (cleanArr.length > 0) clean.samples[k] = cleanArr;
        }
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[ev-filter] load failed (fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.state = emptyState();
    }
  }
}

/** 全系統共享單例 */
export const evFilter = new EVFilter();
