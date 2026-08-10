// ─── Entry Quality System (v2.0.868) — P1 Confirmation Gate + P2 MAE Profile ───
//
// 主神調查發現:輸贏喺「入場後 5 分鐘」決定——
//   蝕錢 trade:入場後立即逆向(MAE -5~-7.7% margin,MFE 0.1~2.1%)
//   賺錢 trade:入場後立即順行(MAE -0.4~-2.4%,MFE 4~6.8%)
// → 負偏度(win rate 62% 但 avgLoss/avgWin = 1.9x)
//
// P1 Confirmation Gate:「反彈已開始先入,唔係預期會反彈就入」
//   3 個確認訊號(Price 位置 / Momentum / Noise)——未確認 → conviction 降(判斷層)
// P2 Entry MAE Profile:rolling window(最近 30 日)——全部 close 類型——
//   過濾污染樣本——EV 校準(保守:Wilson LB win rate + median MAE/MFE)
//
// 全遵主神約束:唔 hard block、唔碰 SL、唔自動 size、唔設持倉時間限制

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'entry-quality' });
const DEFAULT_PATH = 'data/evolution/entry-quality.json';
const MIN_SAMPLES = 20;              // Profile 冷啟動
const ROLLING_DAYS = 30;             // 最近 30 日(主神:「相同資產最近數據」)
const MAX_SAMPLES = 100;             // per context rolling cap

// ── P1:Confirmation Gate(純函數——可測)────────────────────────────

export interface ConfirmationSignals {
  pricePosition: boolean;
  momentum: boolean;
  noise: boolean;
}

export interface ConfirmationResult {
  confirmedCount: number;   // 0-3
  signals: ConfirmationSignals;
  multiplier: number;       // conviction 乘數
}

/**
 * 3 訊號確認——未確認 → conviction 降(判斷層——唔 hard block)
 * 訊號設計(對應負偏度根源):
 *   ① Price 位置:價格已「離開」demand/supply zone(BUY > support×1.0015)
 *      證明「反彈已開始」而唔係「預期會反彈」
 *   ② Momentum:最近 1 支 candle 方向同目標一致(反彈已有動能)
 *   ③ Noise:ATR < SL 距離(noise 唔會直接 stop-out——高波動唔入)
 * 中性處理:缺數據(support 無/ATR 0/candle unknown)→ 唔懲罰(當通過——
 *   避免冷啟動全部唔入)——只有「明確未確認」先扣分
 */
export function checkConfirmation(params: {
  side: 'buy' | 'sell';
  currentPrice: number;
  slDistancePct: number;          // SL 距離(價格 %,0.8 = 0.8%)
  support?: number | null;        // BUY 用
  resistance?: number | null;     // SELL 用
  atrPct?: number;                // ATR 相對價格(%)
  lastCandleDir?: 'up' | 'down' | 'sideways' | 'unknown';
}): ConfirmationResult {
  const side = params.side === 'sell' ? 'sell' : 'buy';
  const cur = Number.isFinite(params.currentPrice) && params.currentPrice > 0 ? params.currentPrice : 0;

  // ① Price 位置確認(離開 zone)
  let pricePosition = true; // 缺數據中性
  if (cur > 0) {
    if (side === 'buy' && Number.isFinite(params.support) && (params.support ?? 0) > 0) {
      // BUY:price 應該高過 support 0.15%——「已離開 demand」(唔係喺 zone 邊緣)
      pricePosition = cur >= (params.support as number) * 1.0015;
    } else if (side === 'sell' && Number.isFinite(params.resistance) && (params.resistance ?? 0) > 0) {
      pricePosition = cur <= (params.resistance as number) * 0.9985;
    }
  }

  // ② Momentum 確認(candle 方向同目標一致)
  let momentum = true; // unknown 中性
  const dir = params.lastCandleDir;
  if (dir === 'up') momentum = side === 'buy';
  else if (dir === 'down') momentum = side === 'sell';
  else if (dir === 'sideways') momentum = false; // v2.0.868-attack:sideways = 反彈未開始——明確未確認

  // ③ Noise 確認(ATR < SL——noise 唔會直接 stop-out)
  let noise = true; // 缺數據中性
  const atr = Number.isFinite(params.atrPct) ? (params.atrPct as number) : 0;
  const slDist = Number.isFinite(params.slDistancePct) && params.slDistancePct > 0 ? params.slDistancePct : 0;
  if (slDist <= 0) {
    // v2.0.868-attack:冇 SL = 冇保護——noise 唔確認(唔應該入無保護倉位)
    noise = false;
  } else if (slDist < 0.8) {
    // SL 太貼(<0.8% price = 8% margin at 10x)——noise(0.5%+)就 stop-out——
    // 數據顯示蝕錢 trade 全部 SL 太貼——未確認(唔改 SL——Gate 判斷層唔入)
    noise = false;
  } else if (atr > 0) {
    noise = atr < slDist;
  }

  const signals: ConfirmationSignals = { pricePosition, momentum, noise };
  const confirmedCount = [pricePosition, momentum, noise].filter(Boolean).length;

  // Multiplier:≥2 確認正常;1 確認 ×0.85;0 確認 ×0.7(等確認——判斷層)
  let multiplier = 1.0;
  if (confirmedCount === 1) multiplier = 0.85;
  else if (confirmedCount === 0) multiplier = 0.7;

  return { confirmedCount, signals, multiplier };
}

// ── P2:Entry MAE Profile(rolling window——最近數據)────────────────

export interface EntrySample {
  maePct: number;   // 入場後最大逆向(margin %——負數)
  mfePct: number;   // 入場後最大順向(margin %)
  pnlPct: number;   // 最終 pnl(margin %)
  closedAt: number; // epoch ms——rolling window 過濾
}

export interface EntryProfileResult {
  n: number;
  maeMedian: number;
  maeP75: number;
  mfeMedian: number;
  winRate: number;
  wilsonLB: number;
  ev: number;        // 條件期望值(margin %)
  evMultiplier: number;
}

interface EntryQualityState {
  version: number;
  savedAt: number;
  profile: Record<string, EntrySample[]>; // `${sym}|${side}` → samples(全部 close 類型)
  backfillDone: boolean;
}

function emptyState(): EntryQualityState {
  return { version: 1, savedAt: 0, profile: {}, backfillDone: false };
}

/** 保守 EV:Wilson LB win rate(90%)+ median MAE/MFE——全程保守(主神:設計謹慎) */
function wilsonLowerBound(wins: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = wins / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}

function medianSorted(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  return n % 2 ? arr[Math.floor(n / 2)]! : (arr[n / 2 - 1]! + arr[n / 2]!) / 2;
}

export class EntryQuality {
  private state: EntryQualityState = emptyState();
  private path: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(path = DEFAULT_PATH) {
    this.path = path;
  }

  /** P2:記錄 entry 樣本——全部 close 類型(sl_tp/consensus/reconciliation/PAEL)——
   *  過濾污染(mae/mfe 超 sanity range——錯價)→ 唔記錄 */
  record(symbol: string, side: 'buy' | 'sell', maePct: number, mfePct: number, pnlPct: number, closedAt: number, leverage = 1): void {
    try {
      const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
      if (!sym || (side !== 'buy' && side !== 'sell')) return;
      // 污染過濾:MAE/MFE 唔應該超出合理範圍(±3×margin——sanity)
      // 10x 槓杆 → 價格 ±30% 已經極端——margin ±300% 唔可能(錯價)
      const maxSanity = 300; // margin %
      const mae = Number.isFinite(maePct) ? Math.max(-maxSanity, Math.min(0, maePct)) : 0;
      const mfe = Number.isFinite(mfePct) ? Math.max(0, Math.min(maxSanity, mfePct)) : 0;
      // 污染樣本(MAE -50% 嗢啲)唔應該用——直接 skip(唔記錄)
      if (mae < -maxSanity * 0.5 && mfe < 10) return; // 明顯污染(逆向超 150% margin 且冇順向)
      const key = `${sym}|${side}`;
      this.state.profile[key] ??= [];
      this.state.profile[key]!.push({
        maePct: mae, mfePct: mfe,
        pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
        closedAt: Number.isFinite(closedAt) ? closedAt : Date.now(),
      });
      if (this.state.profile[key]!.length > MAX_SAMPLES) {
        this.state.profile[key] = this.state.profile[key]!.slice(-MAX_SAMPLES);
      }
      this.markDirty();
    } catch { /* 非致命 */ }
  }

  /** P2:查 profile——只計最近 windowDays 日樣本(regime 過時自動淘汰) */
  getProfile(symbol: string, side: 'buy' | 'sell', windowDays = ROLLING_DAYS): EntryProfileResult | null {
    const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
    const key = `${sym}|${side}`;
    const arr = this.state.profile[key];
    if (!arr || arr.length === 0) return null;
    const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
    const recent = arr.filter(s => s.closedAt >= cutoff);
    if (recent.length < MIN_SAMPLES) return null; // 冷啟動——唔干擾

    const maes = recent.map(s => s.maePct).sort((a, b) => a - b);
    const mfes = recent.map(s => s.mfePct).sort((a, b) => a - b);
    const wins = recent.filter(s => s.pnlPct > 0).length;
    const winRate = wins / recent.length;
    const wilsonLB = wilsonLowerBound(wins, recent.length);
    const maeMedian = medianSorted(maes);
    const maeP75 = maes[Math.min(maes.length - 1, Math.floor(maes.length * 0.75))]!;
    const mfeMedian = medianSorted(mfes);

    // 保守 EV:wilsonLB win × mfeMedian − (1−wilsonLB) × |maeMedian|
    const ev = wilsonLB * mfeMedian - (1 - wilsonLB) * Math.abs(maeMedian);

    // Soft multiplier(保守分級——下限 0.75——唔 hard block):
    //   ev ≥ 0 → 1.0;ev ≥ -0.5 → 0.92;ev ≥ -1.0 → 0.85;else → 0.75
    let evMultiplier = 1.0;
    if (ev < 0) evMultiplier = ev >= -0.5 ? 0.92 : ev >= -1.0 ? 0.85 : 0.75;

    return { n: recent.length, maeMedian, maeP75, mfeMedian, winRate, wilsonLB, ev, evMultiplier };
  }

  /** P1 用:Entry MAE advice 文字(注入 Meta-Agent——LLM 睇到統計) */
  getAdvice(symbol: string, side: 'buy' | 'sell', windowDays = ROLLING_DAYS): string {
    const prof = this.getProfile(symbol, side, windowDays);
    if (!prof) return '';
    const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    return `[ENTRY QUALITY ${String(symbol).toUpperCase()} ${side.toUpperCase()} (n=${prof.n}, 最近${windowDays}日)]
  入場後 median MAE ${pct(prof.maeMedian)} margin / MFE ${pct(prof.mfeMedian)} margin / p75 MAE ${pct(prof.maeP75)}
  win rate ${(prof.winRate * 100).toFixed(0)}% (Wilson LB ${(prof.wilsonLB * 100).toFixed(0)}%)
  保守條件 EV ${pct(prof.ev)} margin — ${prof.ev >= 0 ? '正期望(可入場)' : '負期望(等確認/細 size——統計校準,世界模型可 override)'}`;
  }

  getStats(): { contexts: number; samples: number } {
    let samples = 0;
    for (const k of Object.keys(this.state.profile)) samples += (this.state.profile[k] ?? []).length;
    return { contexts: Object.keys(this.state.profile).length, samples };
  }

  // ── Persistence(debounce——學 close-calibrator 教訓)────────────────

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
      fs.renameSync(tmp, this.path);
    } catch (err) {
      log.warn(`[entry-quality] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as Record<string, unknown>;
      const clean = emptyState();
      if (raw && typeof raw === 'object') {
        clean.backfillDone = raw['backfillDone'] === true;
        if (raw['profile'] && typeof raw['profile'] === 'object') {
          for (const [k, samples] of Object.entries(raw['profile'] as Record<string, unknown>)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (Array.isArray(samples)) {
              const cleanSamples = samples
                .filter((s): s is EntrySample => !!s && typeof s === 'object'
                  && Number.isFinite((s as EntrySample).maePct)
                  && Number.isFinite((s as EntrySample).closedAt))
                .map(s => ({
                  maePct: s.maePct, mfePct: Number.isFinite(s.mfePct) ? s.mfePct : 0,
                  pnlPct: Number.isFinite(s.pnlPct) ? s.pnlPct : 0,
                  closedAt: s.closedAt,
                }))
                .slice(-MAX_SAMPLES);
              if (cleanSamples.length > 0) clean.profile[k] = cleanSamples;
            }
          }
        }
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[entry-quality] load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  markBackfillDone(): void {
    this.state.backfillDone = true;
    this.markDirty();
  }
}
