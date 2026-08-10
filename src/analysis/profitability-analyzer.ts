// ─── Profitability Analyzer (v2.0.868) — 量化分析器 ───
//
// 以概率/分布量化金融分析師思路設計——「數據層/判斷層」組件——
// 唔控制任何操作(唔設時間限制、唔控制 size、唔碰 SL——主神約束)。
//
// 功能:
//   1. Hold-Time EV:per (symbol×side)——EV by hold 區間(<15m/15m-1h/1-4h/>4h)
//      → 最佳持倉區間提示(實証:短 hold <15m 負 EV -0.545% vs 15m-1h +0.505%)
//   2. Direction Bias:per (symbol×side)——WR/EV/median——極端偏差標記
//      (實証:MU|buy -51.7%、SILVER|sell -49.2%、GOLD|sell -32.6%)
//   3. Fee Impact:累計手續費 vs 總 PnL(透明——fee 侵蝕量化)
//
// 設計原則:
//   · LLM 世界模型主導方向——統計只做歷史校準(advice 係「提示」唔係 gate)
//   · 冷啟動中性(<20 samples 唔出 advice——唔干擾早期)
//   · 持久化 debounce(學 close-calibrator 教訓:markDirty + flushSave + unref)
//   · 攻擊硬化(safeNum、白名單、防污染、null-safe)

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'profitability' });
const DEFAULT_PATH = 'data/evolution/profitability-analyzer.json';
const MIN_SAMPLES = 20;           // 冷啟動——少過唔出 advice
const MIN_BUCKET_SAMPLES = 10;    // per bucket 最少
const BUCKETS = ['<15m', '15m-1h', '1-4h', '>4h'] as const;
type Bucket = typeof BUCKETS[number];

export interface BucketEV {
  bucket: Bucket;
  n: number;
  wr: number;          // win rate 0-1
  ev: number;          // 平均 pnlPct(已含費)
  median: number;      // 中位數 pnlPct
}

export interface DirectionBias {
  symbol: string;
  side: 'buy' | 'sell';
  n: number;
  wr: number;
  ev: number;
  median: number;
  /** bias = (ev − 0) 嘅標準化——正數 = 做呢邊有利 */
  biasPct: number;
}

interface ProfitabilityState {
  version: number;
  savedAt: number;
  holdTime: Record<string, Record<string, number[]>>;  // `${sym}|${side}` → bucket → pnlPcts
  bias: Record<string, number[]>;                      // `${sym}|${side}` → 全部 pnlPcts
  fees: { totalFees: number; trades: number };
  backfillDone: boolean;
}

function emptyState(): ProfitabilityState {
  return { version: 1, savedAt: 0, holdTime: {}, bias: {}, fees: { totalFees: 0, trades: 0 }, backfillDone: false };
}

function bucketFor(holdMin: number): Bucket {
  if (holdMin < 15) return '<15m';
  if (holdMin < 60) return '15m-1h';
  if (holdMin < 240) return '1-4h';
  return '>4h';
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function pct(v: number): number {
  return Number.isFinite(v) ? v * 100 : 0;
}

export class ProfitabilityAnalyzer {
  private state: ProfitabilityState = emptyState();
  private path: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(path = DEFAULT_PATH) {
    this.path = path;
  }

  // ── 記錄(close 事件)────────────────────────────────────────────────

  /** recordTrade:close 事件累積——holdMin + pnlPct(已含費) */
  recordTrade(symbol: string, side: 'buy' | 'sell', holdMin: number, pnlPct: number, feeUsd?: number): void {
    try {
      // v2.0.868-attack6:symbol 控制字符 sanitize(換行/CR——防 prompt 注入 advice)
      const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
      if (!sym || (side !== 'buy' && side !== 'sell')) return;
      const hold = Number.isFinite(holdMin) ? Math.max(0, holdMin) : 0;
      const pnl = Number.isFinite(pnlPct) ? pnlPct : 0;
      const key = `${sym}|${side}`;
      // hold-time bucket
      const bucket = bucketFor(hold);
      this.state.holdTime[key] ??= {};
      this.state.holdTime[key]![bucket] ??= [];
      this.state.holdTime[key]![bucket]!.push(pnl);
      // direction bias(全部)
      this.state.bias[key] ??= [];
      this.state.bias[key]!.push(pnl);
      // fee
      const fee = Number.isFinite(feeUsd) ? (feeUsd as number) : 0;
      if (fee > 0) {
        this.state.fees.totalFees += fee;
      }
      this.state.fees.trades += 1;
      this.capMemory();
      this.markDirty();
    } catch { /* 非致命——分析器唔影響交易 */ }
  }

  /** v2.0.868-attack:memory cap——防無限增長(rolling window 500 per cell) */
  private capMemory(): void {
    const CAP = 500;
    for (const key of Object.keys(this.state.bias)) {
      const arr = this.state.bias[key];
      if (arr && arr.length > CAP) this.state.bias[key] = arr.slice(-CAP);
    }
    for (const key of Object.keys(this.state.holdTime)) {
      for (const b of Object.keys(this.state.holdTime[key] ?? {})) {
        const arr = this.state.holdTime[key]![b];
        if (arr && arr.length > CAP) this.state.holdTime[key]![b] = arr.slice(-CAP);
      }
    }
  }

  // ── 查詢(判斷層)────────────────────────────────────────────────────

  /** per (symbol×side):各 hold 區間 EV(排序後)——冷啟動返 [] */
  getHoldTimeEV(symbol: string, side: 'buy' | 'sell'): BucketEV[] {
    const key = `${String(symbol ?? '').slice(0, 24)}|${side}`;
    const cells = this.state.holdTime[key];
    if (!cells) return [];
    const out: BucketEV[] = [];
    for (const b of BUCKETS) {
      const arr = cells[b];
      if (!arr || arr.length < MIN_BUCKET_SAMPLES) continue;
      const wins = arr.filter(p => p > 0).length;
      out.push({
        bucket: b,
        n: arr.length,
        wr: wins / arr.length,
        ev: arr.reduce((a, c) => a + c, 0) / arr.length,
        median: median(arr),
      });
    }
    return out.sort((a, b) => b.ev - a.ev);
  }

  /** per (symbol×side):方向偏差——冷啟動返 null */
  getDirectionBias(symbol: string, side: 'buy' | 'sell'): DirectionBias | null {
    const key = `${String(symbol ?? '').slice(0, 24)}|${side}`;
    const arr = this.state.bias[key];
    if (!arr || arr.length < MIN_SAMPLES) return null;
    const wins = arr.filter(p => p > 0).length;
    return {
      symbol: String(symbol ?? '').slice(0, 24),
      side,
      n: arr.length,
      wr: wins / arr.length,
      ev: arr.reduce((a, c) => a + c, 0) / arr.length,
      median: median(arr),
      biasPct: pct(arr.reduce((a, c) => a + c, 0) / arr.length),
    };
  }

  /** 判斷層提示(俾 Meta-Agent/conviction)——冷啟動返 ''(唔打擾) */
  getContextAdvice(symbol: string, side: 'buy' | 'sell'): string {
    const parts: string[] = [];
    const hold = this.getHoldTimeEV(symbol, side);
    if (hold.length > 0) {
      const best = hold[0]!;
      parts.push(`[hold-time EV ${symbol} ${side.toUpperCase()}] 最佳 ${best.bucket} (EV ${pct(best.ev).toFixed(2)}%, WR ${(best.wr * 100).toFixed(0)}%, n=${best.n})`);
      for (const b of hold.slice(0, 3)) {
        if (b.bucket !== best.bucket) {
          parts.push(`  ${b.bucket}: EV ${pct(b.ev).toFixed(2)}% (n=${b.n})`);
        }
      }
    }
    const bias = this.getDirectionBias(symbol, side);
    if (bias) {
      const dir = bias.biasPct >= 0 ? '有利' : '不利';
      parts.push(`[direction bias ${symbol} ${side.toUpperCase()}] EV ${bias.biasPct.toFixed(2)}% WR ${(bias.wr * 100).toFixed(0)}% (n=${bias.n}) — 歷史${dir}做${side.toUpperCase()}`);
      if (Math.abs(bias.biasPct) > 0.5) {
        parts.push(`  ⚠️ 極端偏差——考慮相反方向(世界模型仍主導——統計只做校準)`);
      }
    }
    return parts.join('\n');
  }

  /**
   * v2.0.868-q:Skew(偏度)advice——識別「贏細輸大」負偏度 trap。
   * 主神觀察:「win rate 高但蝕得多拉勻都係蝕」——avgLoss/avgWin ratio > 1.5 = 負偏度
   * → EV 話「負期望」——skew 話「點解負」(贏 62% 但輸嘅大 1.9 倍)
   * → LLM 世界模型理解「就算 win rate 高都要嚴格確認」——同 Entry Quality 互補
   */
  getSkewAdvice(symbol: string, side: 'buy' | 'sell'): string {
    const key = `${String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24)}|${side}`;
    const arr = this.state.bias[key];
    if (!arr || arr.length < MIN_SAMPLES) return '';
    const wins = arr.filter(p => p > 0);
    const losses = arr.filter(p => p <= 0);
    if (wins.length === 0 || losses.length === 0) return '';
    const avgWin = wins.reduce((a, c) => a + c, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((a, c) => a + c, 0) / losses.length);
    if (avgWin <= 0 || avgLoss <= 0) return '';
    // v2.0.868-attack9:ratio 可能 Infinity(極端 loss)——唔輸出 garbage
    const ratioRaw = avgLoss / avgWin;
    if (!Number.isFinite(ratioRaw)) return '';
    const ratio = ratioRaw;
    // v2.0.868-attack11:浮點邊界——ratio 啱好 1.5 但 0.0015/0.001 = 1.4999999 < 1.5 → 唔出
    // threshold 用 1.49(1.5 附近都出——唔好因為浮點誤差漏警告)
    if (ratio < 1.49) return ''; // 正常盈虧比——唔出
    const wr = wins.length / arr.length;
    return `[SKEW ${String(symbol).toUpperCase()} ${side.toUpperCase()}] win rate ${(wr * 100).toFixed(0)}% 但 avgLoss/avgWin = ${ratio.toFixed(1)}x(贏${(avgWin * 100).toFixed(1)}%/輸${(avgLoss * 100).toFixed(1)}%)——負偏度:贏細輸大——即使 win rate 高期望值都可能負——需要嚴格確認訊號/細 size(世界模型可 override)`;
  }

  /**
   * v2.0.868-attack4:雙 side advice——一次過輸出 buy + sell 兩邊數據(LLM 對比)。
   * 之前 marketDesc 注入用 global gate action 嘅 side 查 per-symbol advice——
   * global=BUY 但 GOLD 想 SELL → 顯示錯 side 嘅 bias——斷層。
   * 而家兩邊都俾——LLM 世界模型自己判斷(統計只做校準)。
   */
  getDualSideAdvice(symbol: string): string {
    const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
    if (!sym) return '';
    const buy = this.getContextAdvice(sym, 'buy');
    const sell = this.getContextAdvice(sym, 'sell');
    if (!buy && !sell) return '';
    const parts: string[] = [];
    if (buy) parts.push(`[PROFITABILITY ${sym.toUpperCase()} BUY]\n${buy}`);
    if (sell) parts.push(`[PROFITABILITY ${sym.toUpperCase()} SELL]\n${sell}`);
    // v2.0.868-attack11:skew 分開顯示 buy/sell(唔用 ||——buy 有 skew 就隱藏 sell)
    const skBuy = this.getSkewAdvice(sym, 'buy');
    const skSell = this.getSkewAdvice(sym, 'sell');
    if (skBuy) parts.push(skBuy);
    if (skSell) parts.push(skSell);
    return parts.join('\n');
  }

  /** Fee 影響報告(透明度) */
  getFeeImpact(): { totalFees: number; trades: number; avgFeePerTrade: number } {
    const { totalFees, trades } = this.state.fees;
    return { totalFees, trades, avgFeePerTrade: trades > 0 ? totalFees / trades : 0 };
  }

  getStats(): { holdCells: number; biasCells: number; feeTrades: number } {
    let holdCells = 0;
    for (const k of Object.keys(this.state.holdTime)) holdCells += Object.keys(this.state.holdTime[k] ?? {}).length;
    return { holdCells, biasCells: Object.keys(this.state.bias).length, feeTrades: this.state.fees.trades };
  }

  // ── Persistence(debounce——學 close-calibrator 教訓)──────────────────

  private markDirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  save(): void {
    try {
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.state, savedAt: Date.now() }), 'utf-8');
      fs.renameSync(tmp, this.path); // atomic
    } catch (err) {
      log.warn(`[profitability] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as Record<string, unknown>;
      const clean = emptyState();
      if (raw && typeof raw === 'object') {
        clean.backfillDone = raw['backfillDone'] === true;
        // 白名單 sanitize——防 __proto__/constructor/NaN/巨型
        const sanitizeArr = (v: unknown): number[] => {
          if (!Array.isArray(v)) return [];
          return v
            .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
            .slice(-500);
        };
        if (raw['holdTime'] && typeof raw['holdTime'] === 'object') {
          for (const [k, buckets] of Object.entries(raw['holdTime'] as Record<string, unknown>)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (buckets && typeof buckets === 'object') {
              for (const [b, arr] of Object.entries(buckets as Record<string, unknown>)) {
                if (BUCKETS.includes(b as Bucket)) {
                  const cleanArr = sanitizeArr(arr);
                  if (cleanArr.length > 0) {
                    clean.holdTime[k] ??= {};
                    clean.holdTime[k]![b as Bucket] = cleanArr;
                  }
                }
              }
            }
          }
        }
        if (raw['bias'] && typeof raw['bias'] === 'object') {
          for (const [k, arr] of Object.entries(raw['bias'] as Record<string, unknown>)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            const cleanArr = sanitizeArr(arr);
            if (cleanArr.length > 0) clean.bias[k] = cleanArr;
          }
        }
        if (raw['fees'] && typeof raw['fees'] === 'object') {
          const f = raw['fees'] as Record<string, unknown>;
          clean.fees.totalFees = Number.isFinite(f['totalFees']) && (f['totalFees'] as number) > 0 ? f['totalFees'] as number : 0;
          clean.fees.trades = Number.isFinite(f['trades']) && (f['trades'] as number) > 0 ? Math.floor(f['trades'] as number) : 0;
        }
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[profitability] load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** backfill 標記(同其他 learner 一致) */
  markBackfillDone(): void {
    this.state.backfillDone = true;
    this.markDirty();
  }
}
