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
import { atomicWriteSync } from '../evolution/persistence.ts';
import * as fs from 'node:fs';
import {
  computeDistributionShape,
  shapeToMultiplier,
  computeConservativeEV,
  convexityToMultiplier,
  MIN_SHAPE_SAMPLES,
} from './distribution-shape.ts';

const log = createLogger({ phase: 'ev-filter' });

const MIN_SAMPLES = 20;             // 每 (symbol×side) 最少樣本
// v2.0.870-P2: EV 硬閘最少樣本——低過軟閘 MIN_SAMPLES(20)。硬閘用點估計
// EV(唔係 Wilson LB——Wilson LB 喺 n=10 時太保守,WR 50% 嘅 CI 下界得 27%,
// 會誤殺「點 EV 正但樣本噪聲」嘅方向)。n≥10 時點估計 EV 符號已穩定。
const EV_HARD_BLOCK_MIN_SAMPLES = 10;
const DEFAULT_PATH = 'data/evolution/ev-filter.json';

// ── v2.0.870-FIX(主神指示 2026-08-23): EV 時間衰減 τ=1d ──
// 主神洞察:「距離越遠嘅交易紀錄影響力應該越少,先公平同靈活」。
// 實證:bnb|buy 無衰減 EV +1.44% → τ=1d -0.58%（最近 BNB BUY 負 EV——正正係
// BNB 連蝕根因）;silver|buy +0.48% → -3.53%;6/11 方向被翻轉——舊數據一直誤導。
// 設計: n 用原始樣本數（資格門,防冷啟動亂判）;EV 用時間加權值（方向校準）。
// env EV_TIME_DECAY_HOURS（default 24 = 1d;0 = 關閉 = 舊行為等權）。
export interface EVSample {
  pnlPct: number;
  closedAt: number;
}

const EV_TIME_DECAY_HOURS = (() => {
  const h = Number(process.env['EV_TIME_DECAY_HOURS'] ?? '24');
  // v2.0.870-P5-attack: clamp——1e-9(denormal)令 exp 分母爆炸全滅、1e308 令
  // 衰減失效(永久鎖死)。0 = 回滾(等權);[0.01, 8760] = 有效範圍。
  if (!Number.isFinite(h)) return 24;
  if (h === 0) return 0;
  if (h < 0.01) return 24;
  if (h > 8760) return 24;
  return h;
})();
const EV_TIME_DECAY_MS = EV_TIME_DECAY_HOURS * 3_600_000;
// v2.0.870-P5: EV hard cutoff——超過 cutoff 嘅 trade 零權重(唔係指數衰減嘅
// 無限尾巴)。主神質疑「舊交易永續影響 → 永久鎖死」——實驗證實半衰期(3h-96h)
// 唔改變 block 數(最近一筆 trade 永遠主導加權平均),真正解鎖靠 hard cutoff:
// 24h 後舊 trade 零權重 → EV 歸零 → 硬閘自動解鎖。同 shadow stats
// SHADOW_STAT_CUTOFF_HOURS 一致。env EV_CUTOFF_HOURS(0 = 關閉 = 舊行為)。
const EV_CUTOFF_HOURS = (() => {
  const h = Number(process.env['EV_CUTOFF_HOURS'] ?? '24');
  // v2.0.870-P5-attack: clamp——1e-9 令 cutoff ~0(全部 trade 過期 → 硬閘失效)、
  // 1e308 令 cutoff Infinity(永久鎖死)。0 = 回滾(無 cutoff);[1, 8760] = 有效。
  if (!Number.isFinite(h)) return 24;
  if (h === 0) return 0;
  if (h < 1) return 24;
  if (h > 8760) return 24;
  return h;
})();
const EV_CUTOFF_MS = EV_CUTOFF_HOURS * 3_600_000;
/** v2.0.870-FIX-V1(攻擊輪): 時鐘 skew 容忍——closedAt 超過 now+5min 當「未來垃圾」→ 當最舊
 *  （1e308 / 未來 10 年嘅污染值唔可以當「最新」有全權重）。 */
const TS_TOLERANCE_MS = 5 * 60_000;

export interface EVFilterState {
  /** per (symbol|side) → 最近 pnlPct 樣本（v2.0.870: 含 closedAt——時間衰減 τ=1d） */
  samples: Record<string, EVSample[]>;
  /** v2.0.865-fix:backfill 完成標記(persisted)——防止 restart 重複 backfill 加入 */
  backfillDone: boolean;
}

const MAX_SAMPLES_PER_KEY = 300;

function key(symbol: string, side: 'buy' | 'sell'): string {
  // v2.0.870-P3-attack: 統一 truncate 到 24 chars——recordTrade 曾用
  // symbol.slice(0,24) 但 getters 用 full symbol → symbol > 24 chars 時
  // 存/取 key 唔一致 → 樣本靜默 miss(硬閘失效)。truncate 喺 key() 內部做,
  // 所有 caller 自動一致。
  return `${symbol.slice(0, 24)}|${side}`;
}

function emptyState(): EVFilterState {
  return { samples: {}, backfillDone: false };
}

/** 從樣本計算 EV(分佈思維:median 優先抗 skew)。
 *  v2.0.870-FIX(主神指示): 時間衰減 τ=1d——w = exp(-Δt/τ),最近嘅 trade 影響力
 *  大過舊 trade。n 返回原始樣本數（資格門——evToMultiplier 用 n≥20 判斷有冇資格）,
 *  EV/pWin/avgWin/avgLoss 全部係時間加權值（方向校準——反映最近市況）。
 *  τ=0（env 關閉）→ 等權 = 舊行為。 */
export function computeEV(samples: EVSample[], now = Date.now(), tauMs = EV_TIME_DECAY_MS): { ev: number; pWin: number; avgWin: number; avgLoss: number; n: number } {
  const n = samples.length;
  if (n === 0) return { ev: 0, pWin: 0, avgWin: 0, avgLoss: 0, n: 0 };
  let wSum = 0, wWin = 0, wAvgWin = 0, wAvgLoss = 0;
  for (const s of samples) {
    // v2.0.870-FIX-V2(攻擊輪): 元素級 sanitize——垃圾元素唔可以污染 EV。
    //  pnlPct 必須 finite number（Infinity/NaN/string/array 拒——`'1'>0` coerces true,
    //  `undefined>0` false → NaN 傳播）; closedAt 必須合理（未來/1e308/垃圾 → 當最舊）。
    if (!s || typeof s !== 'object') continue;
    const p = (s as { pnlPct?: unknown }).pnlPct;
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    const ct = (s as { closedAt?: unknown }).closedAt;
    const dt = (typeof ct === 'number' && Number.isFinite(ct) && ct > 0 && ct <= now + TS_TOLERANCE_MS)
      ? Math.max(0, now - ct)
      : Number.MAX_SAFE_INTEGER;
    // v2.0.870-P5: hard cutoff——超過 cutoff 嘅 trade 零權重(唔係 exp 無限尾巴)。
    // 主神質疑「舊交易永續影響 → 永久鎖死」——24h 後舊 trade 零權重 → EV 歸零
    // → 硬閘自動解鎖。垃圾/未來 ts 已喺上面當最舊(dt=MAX_SAFE_INTEGER)→ 零權重。
    // ⚠️ τ=0(等權回滾)時 hard cutoff 都關閉——τ=0 係「舊行為」,唔應該有 cutoff。
    if (tauMs > 0 && EV_CUTOFF_MS > 0 && dt > EV_CUTOFF_MS) continue;
    const w = tauMs > 0 ? Math.exp(-dt / tauMs) : 1;
    wSum += w;
    if (p > 0) { wWin += w; wAvgWin += p * w; }
    else { wAvgLoss += Math.abs(p) * w; }
  }
  if (wSum <= 0) return { ev: 0, pWin: 0, avgWin: 0, avgLoss: 0, n };
  const pWin = wWin / wSum;
  const avgWin = wWin > 0 ? wAvgWin / wWin : 0;
  const avgLoss = (wSum - wWin) > 0 ? wAvgLoss / (wSum - wWin) : 0;
  return { ev: pWin * avgWin - (1 - pWin) * avgLoss, pWin, avgWin, avgLoss, n };
}

/** EV → gate 乘數(判斷層——主神澄清:Kelly「倉位建議」只做參考,
 *  但「正 EV 判斷信心 boost」係判斷力——effectiveConfidence 唔直接寫入
 *  positionSizePct,size 由用戶 Position Size slider + Meta-Agent 自己決定):
 *  正 EV → 輕 boost(×[1.0, 1.25]——EV=0.3% → ×1.08;EV≥1% → ×1.25 cap)——判斷層
 *  負 EV → 軟性降(×[0.75, 1.0]——EV=-0.5% → ×0.90;EV≤-1% → ×0.75 floor)
 *  兩者對稱:正 EV 更有信心開單、負 EV 唔慫恿開單——判斷力,唔係 size 控制
 *  永遠唔 hard block。 */
export function evToMultiplier(ev: number, n: number): number {
  // V1b-fix: -Infinity 係「極端負」(唔係「無效」)——唔准中性放行,當災難桶 0.15
  if (ev === -Infinity) return 0.15;
  if (!Number.isFinite(ev) || n < MIN_SAMPLES) return 1.0;
  if (ev >= 0) {
    // Kelly 式正 EV boost——判斷層(開單信心),唔影響 size(用戶決定)
    const boost = Math.min(0.25, ev * 0.25); // 1% EV → +0.25
    return 1.0 + boost;
  }
  // v2.0.870-P71(P1): 負 EV 降權強化。舊版 floor 0.75 攔唔住 EV<0 bucket
  // (CL:sell EV −0.268 都只降 25%)。實測剔走 7 個 EV<0 bucket 回測 PnL
  // +473%。兩檔(全部要 n≥20,同 MIN_SAMPLES 一致——唔夠樣本唔郁):
  //   EV≤−0.1%  → ×0.15(災難桶,近 block)
  //   EV<0      → ×0.30(明顯負 EV)
  //   冷啟動(n<20)→ ×1.0(earn your data——唔准未學先判)
  if (ev <= -0.1) return 0.15;
  return 0.30;
}

export class EVFilter {
  private state: EVFilterState;
  private path: string;

  constructor(path = DEFAULT_PATH) {
    this.state = emptyState();
    this.path = path;
  }

  /** 每筆 trade close 時記錄實際 pnlPct(已含手續費)。v2.0.870: 加 closedAt（時間衰減） */
  recordTrade(symbol: string, side: 'buy' | 'sell', pnlPct: number, closedAt = Date.now()): void {
    if (!symbol || (side !== 'buy' && side !== 'sell')) return;
    if (!Number.isFinite(pnlPct)) return;
    const k = key(symbol, side);
    const arr = this.state.samples[k] ?? [];
    const ct = Number(closedAt);
    arr.push({ pnlPct, closedAt: Number.isFinite(ct) && ct > 0 ? ct : Date.now() });
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

  /** v2.0.870-P2: 保守 EV(Wilson LB win rate)——硬閘用。點估計 EV 喺小樣本
   *  下噪聲大,Wilson LB 係 95% CI 下界,保守估計「真實 EV 至少幾多」。
   *  硬閘(不可逆 block)必須用保守估計,避免誤殺「真係正 EV 但樣本噪聲」嘅方向。
   *  ⚠️ v2.0.870-P3-attack: 已改用點估計(shouldBlockNegativeEV)——Wilson LB 喺
   *  n=10 時太保守(WR 50% CI 下界得 27%,誤殺正 EV)。此方法保留供未來
   *  需要更保守硬閘時用。 */
  getConservativeEVStats(symbol: string, side: 'buy' | 'sell'): { conservativeEV: number; wilsonLB: number; pWin: number; avgWin: number; avgLoss: number; n: number } {
    const k = key(symbol, side);
    const arr = this.state.samples[k];
    if (!arr || arr.length === 0) return { conservativeEV: 0, wilsonLB: 0, pWin: 0, avgWin: 0, avgLoss: 0, n: 0 };
    return computeConservativeEV(arr.map(x => x.pnlPct));
  }

  /** v2.0.870-P2: EV 硬閘——歷史負 EV(symbol×side)直接 block,唔係軟懲罰。
   *  治本核心:系統喺最蝕嘅 symbol(bnb|buy WR 9%、SILVER|buy WR 0%)交易最多,
   *  喺最賺嘅 symbol(btc|buy WR 100%)交易最少——反選擇。硬閘封殺「驗證過嘅
   *  負 EV 方向」,令系統只喺「有歷史數據支持」嘅方向開倉。
   *
   *  設計(量化金融):
   *    - n ≥ 10 先有資格(冷啟動唔 block——earn your data)
   *    - 用點估計 EV(唔用 Wilson LB——Wilson LB 喺 n=10 時太保守,WR 50%
   *      嘅 CI 下界得 27%,會誤殺「點 EV 正但樣本噪聲」嘅方向)
   *    - EV < 0 → block(歷史蝕錢方向)
   *    - EV ≥ 0 → 放行(即使樣本噪聲,點 EV 正 = 唔夠證據 block)
   *
   *  同 WINNER-FIRST 一致:唔 block <10 樣本(冷啟動),只 block「驗證過嘅負 EV」。 */
  shouldBlockNegativeEV(symbol: string, side: 'buy' | 'sell'): { blocked: boolean; reason?: string } {
    const { ev, n } = this.getEVStats(symbol, side);
    if (n < EV_HARD_BLOCK_MIN_SAMPLES) return { blocked: false };
    if (ev < 0) {
      return {
        blocked: true,
        reason: `negative EV: ${symbol} ${side} EV=${(ev * 100).toFixed(2)}% (n=${n}) — 歷史蝕錢方向,block`,
      };
    }
    return { blocked: false };
  }

  /** gate 乘數 ×[0.75, 1.25]——判斷層:正 EV boost(開單信心),負 EV 軟性降——
   *  effectiveConfidence 唔直接寫入 positionSizePct——size 用戶 Position Size 話事 */
  getEVMultiplier(symbol: string, side: 'buy' | 'sell'): number {
    const { ev, n } = this.getEVStats(symbol, side);
    return evToMultiplier(ev, n);
  }

  /** v2.0.869-P8:分布形狀 gate 乘數(偏度/峰度)——偵測肥尾蝕錢(偶發大蝕 trap) */
  getShapeMultiplier(symbol: string, side: 'buy' | 'sell'): number {
    const k = key(symbol, side);
    const arr = this.state.samples[k];
    if (!arr || arr.length === 0) return 1.0;
    return shapeToMultiplier(computeDistributionShape(arr.map(x => x.pnlPct)));
  }

  /** v2.0.869-P8:凸性偵測乘數(Wilson LB 保守 EV)——統計顯著性 */
  getConvexityMultiplier(symbol: string, side: 'buy' | 'sell'): number {
    const k = key(symbol, side);
    const arr = this.state.samples[k];
    if (!arr || arr.length === 0) return 1.0;
    const { conservativeEV, n } = computeConservativeEV(arr.map(x => x.pnlPct));
    return convexityToMultiplier(conservativeEV, n);
  }

  /** v2.0.869-P8:注入 Meta-Agent 嘅分布形狀 block(偏度/峰度 + 保守 EV) */
  getDistributionBlock(symbol: string, side: 'buy' | 'sell'): string {
    const k = key(symbol, side);
    const arr = this.state.samples[k];
    if (!arr || arr.length < MIN_SHAPE_SAMPLES) return '';
    const shape = computeDistributionShape(arr.map(x => x.pnlPct));
    const { conservativeEV, wilsonLB, pWin } = computeConservativeEV(arr.map(x => x.pnlPct));
    const shapeMult = shapeToMultiplier(shape);
    const convMult = convexityToMultiplier(conservativeEV, arr.length);
    const shapeNote =
      shape.skewness < -0.5 && shape.excessKurtosis > 1
        ? '肥尾蝕錢(偶發大蝕 trap)'
        : shape.skewness < -0.5
          ? '負偏(左尾重)'
          : shape.skewness > 0.5
            ? '正偏(贏大輸細)'
            : '近似對稱';
    return `=== DISTRIBUTION SHAPE (${symbol} × ${side}) ===\n  偏度 skew=${shape.skewness.toFixed(2)} 峰度 kurt=${shape.excessKurtosis.toFixed(2)} (${shapeNote}) → ×${shapeMult.toFixed(2)}\n  保守 EV=${(conservativeEV * 100).toFixed(2)}%(Wilson LB win rate ${(wilsonLB * 100).toFixed(0)}% vs 點估計 ${(pWin * 100).toFixed(0)}%) → ×${convMult.toFixed(2)}`;
  }

  /** 注入 Meta-Agent 嘅 block(主神裁決:Kelly 只提供參考數據——size 用戶決定) */
  getEVBlock(symbol: string, side: 'buy' | 'sell'): string {
    const { ev, pWin, avgWin, avgLoss, n } = this.getEVStats(symbol, side);
    if (n < MIN_SAMPLES) return '';
    const mult = this.getEVMultiplier(symbol, side);
    // v2.0.865-fix7d(主神裁決):Kelly 建議「冇乜用」——移除(size 用戶決定,
    // 建議唔影響決策,塞 LLM 浪費 context)——只留真實 EV 數據
    const note = ev >= 0
      ? `(正 EV——此方向有歷史數據支持)`
      : `(EV < 0 = 手續費都搵唔返——建議唔開呢個方向;乘數 ×${mult.toFixed(2)})`;
    return `=== EV FILTER (${symbol} × ${side}) ===\n  期望值 EV: ${(ev * 100).toFixed(2)}%(pWin ${(pWin * 100).toFixed(0)}%, avgWin ${(avgWin * 100).toFixed(2)}%, avgLoss ${(avgLoss * 100).toFixed(2)}%, n=${n})\n  ${note}`;
  }

  getStats(): { keys: number; totalSamples: number } {
    let total = 0;
    for (const arr of Object.values(this.state.samples)) total += arr.length;
    return { keys: Object.keys(this.state.samples).length, totalSamples: total };
  }

  isBackfillDone(): boolean {
    return this.state.backfillDone === true;
  }

  markBackfillDone(): void {
    this.state.backfillDone = true;
  }

  save(): void {
    try {
      atomicWriteSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.state }));
    } catch (err) {
      log.warn(`[ev-filter] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as EVFilterState;
      const clean = emptyState();
      if (raw && typeof raw === 'object') {
        clean.backfillDone = (raw as { backfillDone?: unknown }).backfillDone === true;
      }
      if (raw && typeof raw === 'object' && raw.samples && typeof raw.samples === 'object') {
        for (const [k, arr] of Object.entries(raw.samples)) {
          // v2.0.865-attack: __proto__/constructor/prototype 毒 key 跳過
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (!Array.isArray(arr)) continue;
          const cleanArr: EVSample[] = [];
          for (const v of arr) {
            if (v && typeof v === 'object' && Number.isFinite((v as EVSample).pnlPct)) {
              // 新格式 { pnlPct, closedAt }
              const ct = Number((v as EVSample).closedAt);
              cleanArr.push({ pnlPct: (v as EVSample).pnlPct, closedAt: Number.isFinite(ct) && ct > 0 ? ct : 0 });
            } else if (typeof v === 'number' && Number.isFinite(v)) {
              // 舊格式 number[] → migrate（當最舊——時間衰減後零影響,等新 trade 累積）
              cleanArr.push({ pnlPct: v, closedAt: 0 });
            }
          }
          if (cleanArr.length > 0) clean.samples[k] = cleanArr.slice(-MAX_SAMPLES_PER_KEY);
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
