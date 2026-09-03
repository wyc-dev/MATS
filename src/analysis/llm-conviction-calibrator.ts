// ─── LLM Conviction Calibrator (v2.0.863 規限①+②) ─────────────────────
//
// 主神要求:「確認 LLM 回應可量化?需要明確謹慎嘅規限」——核心問題:
// LLM 嘅 conviction 數字係「未校準嘅主觀判斷」——可以話 0.95 但實際 40%。
//
// 規限①:Conviction Calibrator(好似 OLR calibration)
//   記錄每筆 LLM 決策 (conviction, action, outcome)→ 5-bin 映射:
//   計算「conviction bin → 實際 WR」——LLM 話 0.8-1.0 嘅 buy,實際 40%
//   → 校準到 40%(empirical WR + shrink,冷啟動中性)
//
// 規限②:LLM 讀圖質素追蹤
//   當 thesis 引用 K 線方向,check 引用得啱唔啱(同統計 K-LINE 比對)
//   → 累計「讀圖一致率」——LLM 讀圖可信度
//
// 純函數 + 持久化,可單元測試。malformed input → 中性(唔 crash)。

import { createLogger } from '../observability/logger.ts';
import { atomicWriteSync } from '../evolution/persistence.ts';
import fs from 'node:fs';

const log = createLogger({ phase: 'llm-calib' });

// ─── Config ────────────────────────────────────────────────────────────

const NUM_BINS = 5;
const BIN_SHRINK_K = 5;          // shrink = count/(count+K)——冷啟動唔過度校準
// v2.0.870-P1: MIN_SAMPLES 由 20 降到 5——治本關鍵。實證 40 單分桶後每桶
// n=3-9,MIN_SAMPLES=20 令 calibrator 出世至今零校準(空腹死碼)。shrink 因子
// count/(count+K) 已內建冷啟動保護(小樣本 → 強收縮向 0.5),唔需要再疊一個
// 高 MIN_SAMPLES 硬閘。n=5 時 shrink=0.5(prior 同數據等權),係合理冷啟動。
const MIN_SAMPLES = 5;           // 每 bin 最少樣本先校準(5 = Wilson CI 下限)
// v2.0.870-P5: 時間衰減 + hard cutoff——主神質疑「舊交易永續影響 → 永久鎖死」。
// bins 隨時間衰減(τ=24h),24h 後零影響(hard cutoff)。同 shadow stats 一致。
// env CALIB_DECAY_HOURS / CALIB_CUTOFF_HOURS(0 = 關閉 = 舊行為)。
const CALIB_DECAY_HOURS = (() => {
  const h = Number(process.env['CALIB_DECAY_HOURS'] ?? '24');
  // v2.0.870-P5-attack: clamp——1e-300(denormal)令 exp 分母爆炸全滅、1e308 令
  // 衰減失效(永久鎖死)。0 = 回滾(無衰減);[0.01, 8760] = 有效範圍。
  if (!Number.isFinite(h)) return 24;
  if (h === 0) return 0;
  if (h < 0.01) return 24;
  if (h > 8760) return 24;
  return h;
})();
const CALIB_DECAY_MS = CALIB_DECAY_HOURS * 3_600_000;
const CALIB_CUTOFF_HOURS = (() => {
  const h = Number(process.env['CALIB_CUTOFF_HOURS'] ?? '24');
  // v2.0.870-P5-attack: clamp——1e-9 令 cutoff ~0(bins 永遠過期 → 校準失效)、
  // 1e308 令 cutoff Infinity(永久鎖死)。0 = 回滾(無 cutoff);[1, 8760] = 有效。
  if (!Number.isFinite(h)) return 24;
  if (h === 0) return 0;
  if (h < 1) return 24;
  if (h > 8760) return 24;
  return h;
})();
const CALIB_CUTOFF_MS = CALIB_CUTOFF_HOURS * 3_600_000;
// v2.0.870-P5-attack: 時鐘容忍——lastUpdatedTs 超過 now+5min 當「未來垃圾」→
// 當 now(唔可以令 dt 負 → decay Infinity → NaN 污染 gate)。
const TS_TOLERANCE_MS = 5 * 60_000;

/** v2.0.870-P5-attack: 安全 dt——未來/NaN/負數 lastUpdatedTs 保守處理。
 *  未來 ts → 當 now(dt=0);NaN/非 finite → 當 now;負數 → dt 大(當最舊)。 */
function safeDt(now: number, ts: number | undefined): number {
  const raw = Number.isFinite(ts) ? (ts ?? now) : now;
  const clamped = raw > now + TS_TOLERANCE_MS ? now : raw;
  return Math.max(0, now - clamped);
}
const KLINE_READ_WINDOW = 20;    // 讀圖一致率窗口
const DEFAULT_PATH = 'data/evolution/llm-conviction-calibration.json';

export interface LLMCalibrationState {
  /** per (side × bin): wins/losses + lastUpdatedTs(時間衰減) */
  bins: Record<string, { wins: number; losses: number; lastUpdatedTs?: number }>;
  /** K-LINE 讀圖記錄:{ correct, total } */
  klineReads: { correct: number; total: number; recent: boolean[] };
}

function emptyState(): LLMCalibrationState {
  return { bins: {}, klineReads: { correct: 0, total: 0, recent: [] } };
}

function binKey(side: 'buy' | 'sell', binIdx: number): string {
  return `${side}|${binIdx}`;
}

function binOf(conviction: number): number {
  const c = Math.max(0, Math.min(0.9999, conviction));
  return Math.floor(c * NUM_BINS);
}

/** empirical WR + shrink(同 OLR applyCalibration 一致)。
 *  v2.0.863-calib-attack (V2): clamp 負數 wins/losses(毒 state 會令
 *  empirical 負 → 校準負數);非 finite raw → 0.5 中性。 */
export function calibrateBin(wins: number, losses: number, raw: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.5;
  // v2.0.870-P3-attack: Math.max(0, NaN) = NaN——毒 state 注入 NaN wins/losses
  // 會令 empirical/shrink 全 NaN → 校準返 NaN 污染 gate。Number.isFinite guard
  // 先 reject 非 finite,再 clamp 負數。
  const w = Number.isFinite(wins) ? Math.max(0, wins) : 0;
  const l = Number.isFinite(losses) ? Math.max(0, losses) : 0;
  const count = w + l;
  if (count <= 0) return raw; // 空 bin → identity(唔校準)
  const empirical = w / count;
  const shrink = count / (count + BIN_SHRINK_K);
  return 0.5 + (empirical - 0.5) * shrink;
}

// ─── Shadow-Informed Hierarchical Shrinkage（v2.0.873-P9-shadow-calib）───
// 主神構想（2026-09-04）:「參考埋 Shadow trade 資訊, 準繩度應該更高——
// 更能如實反映貼近當下情況?」——數據驗證（E1-真, 09-02 後 n=26）:
//   shadowWR≥0.55 → WR 57.1% avg +0.65% | <0.45 → WR 16.7% avg −2.85%
//   ρ=+0.1378（同 CHANGELOG ρ=+0.106 唯一有預測力特徵一致）
// 機制: shadow 每 symbol×side 累積 24h decay 統計（btc|buy n=269 vs real
// close 25——樣本密度 10 倍）——正好填補 Part B 驗證出嘅「per-symbol real
// 樣本餓死」（close-decision-calibrator per-symbol 桶得 n=1）。
//
// 階層合併公式（Bayesian-inspired）:
//   weight_real = nReal / (nReal + K_REAL)              // real = ground truth 主導
//   weight_shadow = (1 − weight_real) × nShadow / (nShadow + K_SHADOW)
//   calibrated = 0.5 + (realEmp − 0.5)×wReal + (shadowWR−0.5)×wShadow×(1−wReal)
//
// 收斂性質（quant 嚴謹）:
//   • real 樣本足（nReal→∞）→ wReal→1, shadow 影響→0（real 先係真錢 truth）
//   • real 冷啟動（nReal=0）→ 純 shadow prior（per-symbol 當下 lean 填充）
//   • shadow n 細（如 CL n=4）→ wShadow→0 → 收縮向 0.5 中性（831 冷啟動紀律）
//   • K_SHADOW=20 > K_REAL=5——shadow 係模擬（無費用/滑點/真實 execution）
//     → 保守 shrink, shadow 唔可以 over-ride real 太多
const K_REAL = BIN_SHRINK_K;      // 5——real 樣本 shrink（歷史一致）
const K_SHADOW = 20;              // 保守——shadow 係模擬, 權重要更弱先可信

/** Shadow-Informed hierarchical blend 純函數。
 *  @param realEmpirical global side×bin 實證 WR（0-1）
 *  @param nReal real 樣本數
 *  @param shadowWR per-symbol×side shadow WR（0-1, 24h decay 後）
 *  @param nShadow shadow 樣本數
 *  @param raw 原始 conviction（0-1）
 *  返回 [0,1] clamp。任何 garbage → 0.5 中性（攻擊硬化）。 */
export function blendShadowCalibration(
  realEmpirical: number,
  nReal: number,
  shadowWR: number,
  nShadow: number,
  raw: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.5;
  const rE = Number.isFinite(realEmpirical) ? Math.max(0, Math.min(1, realEmpirical)) : 0.5;
  const nR = Number.isFinite(nReal) ? Math.max(0, nReal) : 0;
  const sW = Number.isFinite(shadowWR) ? Math.max(0, Math.min(1, shadowWR)) : 0.5;
  const nS = Number.isFinite(nShadow) ? Math.max(0, nShadow) : 0;
  if (nR <= 0 && nS <= 0) return raw; // 零樣本 → identity（冷啟動中性）
  const wReal = nR / (nR + K_REAL);
  // shadow 只填 real 未覆蓋嘅權重份額（(1−wReal)）——real 足則 shadow 無權重
  const wShadow = (1 - wReal) * (nS / (nS + K_SHADOW));
  const out = 0.5 + (rE - 0.5) * wReal + (sW - 0.5) * wShadow;
  return Math.max(0, Math.min(1, out));
}

// ─── Main ──────────────────────────────────────────────────────────────

export class LLMConvictionCalibrator {
  private state: LLMCalibrationState;
  private path: string;

  constructor(path = DEFAULT_PATH) {
    this.state = emptyState();
    this.path = path;
  }

  /** 記錄一筆 LLM 決策(conviction + outcome)——每筆 trade close 時 */
  recordDecision(side: 'buy' | 'sell', conviction: number, outcome: 'win' | 'loss'): void {
    if (side !== 'buy' && side !== 'sell') return;
    const c = Number.isFinite(conviction) ? conviction : 0.5;
    const key = binKey(side, binOf(c));
    const now = Date.now();
    const bin = this.state.bins[key] ?? { wins: 0, losses: 0, lastUpdatedTs: now };
    // v2.0.870-P5: write-time decay——記錄前先按時間衰減(同 shadow stats 一致)。
    const dt = safeDt(now, bin.lastUpdatedTs);
    const decay = CALIB_DECAY_MS > 0 ? Math.exp(-dt / CALIB_DECAY_MS) : 1;
    bin.wins = (Number.isFinite(bin.wins) ? bin.wins : 0) * decay;
    bin.losses = (Number.isFinite(bin.losses) ? bin.losses : 0) * decay;
    if (outcome === 'win') bin.wins++;
    else bin.losses++;
    bin.lastUpdatedTs = now;
    this.state.bins[key] = bin;
  }

  /** v2.0.870-P5: 讀取時 decayed bin——read-time decay + hard cutoff。
   *  超過 cutoff 嘅 bin → null(零影響,identity 唔校準)。 */
  private getDecayedBin(side: 'buy' | 'sell', binIdx: number): { wins: number; losses: number } | null {
    const bin = this.state.bins[binKey(side, binIdx)];
    if (!bin) return null;
    const now = Date.now();
    const dt = safeDt(now, bin.lastUpdatedTs);
    if (CALIB_CUTOFF_MS > 0 && dt > CALIB_CUTOFF_MS) return null; // hard cutoff——bin 過期
    const decay = CALIB_DECAY_MS > 0 ? Math.exp(-dt / CALIB_DECAY_MS) : 1;
    return {
      wins: (Number.isFinite(bin.wins) ? bin.wins : 0) * decay,
      losses: (Number.isFinite(bin.losses) ? bin.losses : 0) * decay,
    };
  }

  /** 校準一筆 conviction——LLM 話 0.85 → bin 實際 WR。
   *  v2.0.863-calib-attack (V1): 非 finite conviction → 0.5 中性——
   *  NaN/Infinity/undefined 唔可以傳播返 gate(會污染 effectiveConfidence)。
   *  v2.0.873-P9-shadow-calib（主神 2026-09-04）: 可選 shadow context——
   *  per-symbol×side shadow WR 做「當下先驗」——real bin 冷啟動時由 shadow
   *  填充 per-symbol 維度（shadow 樣本密度 10× real——btc|buy n=269 vs 25）。
   *  shadow 唔傳 → 保持舊行為（global bin 只靠 real）。 */
  getCalibratedConviction(
    side: 'buy' | 'sell',
    conviction: number,
    shadowCtx?: { winRate?: number; n?: number },
  ): number {
    if (typeof conviction !== 'number' || !Number.isFinite(conviction)) return 0.5;
    const bin = this.getDecayedBin(side, binOf(conviction));
    if (bin && bin.wins + bin.losses >= MIN_SAMPLES) {
      // real 樣本足夠 → real 主導（同 shadow 階層 blend——real 足則 shadow 權重→0）
      const w = bin.wins + bin.losses;
      const realEmp = bin.wins / w;
      const swr = shadowCtx?.winRate;
      const sn = shadowCtx?.n;
      if (typeof swr === 'number' && Number.isFinite(swr) && Number.isFinite(sn) && (sn ?? 0) > 0) {
        return blendShadowCalibration(realEmp, w, swr, sn ?? 0, conviction);
      }
      return calibrateBin(bin.wins, bin.losses, conviction);
    }
    // real 冷啟動（樣本<MIN_SAMPLES）→ shadow prior 填充（per-symbol 當下 lean）
    const swr = shadowCtx?.winRate;
    const sn = shadowCtx?.n;
    if (typeof swr === 'number' && Number.isFinite(swr) && Number.isFinite(sn) && (sn ?? 0) > 0) {
      return blendShadowCalibration(0.5, 0, swr, sn ?? 0, conviction);
    }
    return conviction; // 完全零樣本 → identity（冷啟動中性）
  }

  /** 規限②:記錄一次 K-LINE 讀圖(引用方向 vs 實際趨勢) */
  recordKlineRead(thesisDirection: 'up' | 'down' | null, actualTrend: 'up' | 'down' | 'sideways' | null): void {
    if (!thesisDirection || !actualTrend || actualTrend === 'sideways') return; // 含糊/無方向唔計
    const correct = thesisDirection === actualTrend;
    this.state.klineReads.correct += correct ? 1 : 0;
    this.state.klineReads.total++;
    this.state.klineReads.recent.push(correct);
    if (this.state.klineReads.recent.length > KLINE_READ_WINDOW) {
      this.state.klineReads.recent.shift();
    }
  }

  /** LLM 讀圖一致率(最近窗口) */
  getKlineReadAccuracy(): { accuracy: number; total: number } {
    const recent = this.state.klineReads.recent;
    if (recent.length === 0) return { accuracy: 0, total: 0 };
    return {
      accuracy: recent.filter(Boolean).length / recent.length,
      total: recent.length,
    };
  }

  /** 注入 Meta-Agent 嘅校準摘要 */
  getCalibrationBlock(): string {
    const lines: string[] = [];
    for (const side of ['buy', 'sell'] as const) {
      const parts: string[] = [];
      for (let i = 0; i < NUM_BINS; i++) {
        const bin = this.getDecayedBin(side, i);
        if (!bin || bin.wins + bin.losses < MIN_SAMPLES) continue;
        const lo = i / NUM_BINS, hi = (i + 1) / NUM_BINS;
        const emp = bin.wins / (bin.wins + bin.losses);
        parts.push(`[${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%: 實際 ${(emp * 100).toFixed(0)}%(${bin.wins.toFixed(1)}W/${bin.losses.toFixed(1)}L)]`);
      }
      if (parts.length > 0) lines.push(`  ${side.toUpperCase()} conviction 校準: ${parts.join(' ')}`);
    }
    const kline = this.getKlineReadAccuracy();
    if (kline.total > 0) {
      lines.push(`  你嘅 K-LINE 讀圖歷史: ${(kline.accuracy * 100).toFixed(0)}% 一致(${kline.total} 次)— 一致率高先信自己讀圖`);
    }
    if (lines.length === 0) return '';
    return `=== LLM CONVICTION CALIBRATION ===\n${lines.join('\n')}\n(你嘅 conviction 自報受歷史校準——實際 WR 低嘅 bin 請相應調整信心)`;
  }

  // ─── Persistence ────────────────────────────────────────────────────

  save(): void {
    try {
      atomicWriteSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.state }));
    } catch (err) {
      log.warn(`[llm-calib] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as LLMCalibrationState;
      // sanitize——毒 state 唔 crash
      const clean = emptyState();
      if (raw && typeof raw === 'object') {
        if (raw.bins && typeof raw.bins === 'object') {
          for (const [k, v] of Object.entries(raw.bins)) {
            if (v && typeof v === 'object') {
              clean.bins[k] = {
                wins: Number.isFinite((v as { wins?: number }).wins) ? Math.max(0, (v as { wins?: number }).wins ?? 0) : 0,
                losses: Number.isFinite((v as { losses?: number }).losses) ? Math.max(0, (v as { losses?: number }).losses ?? 0) : 0,
                // v2.0.870-P5: 保留 lastUpdatedTs(時間衰減)——舊 state 無 ts → 0(當最舊)
                lastUpdatedTs: Number.isFinite((v as { lastUpdatedTs?: number }).lastUpdatedTs) ? (v as { lastUpdatedTs?: number }).lastUpdatedTs : 0,
              };
            }
          }
        }
        if (raw.klineReads && typeof raw.klineReads === 'object') {
          const kr = raw.klineReads;
          clean.klineReads = {
            correct: Number.isFinite(kr.correct) ? Math.max(0, kr.correct) : 0,
            total: Number.isFinite(kr.total) ? Math.max(0, kr.total) : 0,
            recent: Array.isArray(kr.recent) ? kr.recent.filter(Boolean).slice(-KLINE_READ_WINDOW) : [],
          };
        }
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[llm-calib] load failed (fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.state = emptyState();
    }
  }

  getStats(): { bins: number; klineReads: number } {
    return { bins: Object.keys(this.state.bins).length, klineReads: this.state.klineReads.total };
  }

  /**
   * v2.0.870-P19': 校準觀測報告——ECE(Expected Calibration Error)+ per-bin 表。
   * ECE = Σ_b (n_b/N)·|bin中點 conviction − 實績 WR|——低 ECE = LLM 老實;
   * ECE 大 = conviction 數字有水份/有保留。
   * 只計有樣本嘅 bin;冷啟動(零樣本)→ ece = null(唔好誤導)。
   */
  getCalibrationReport(): {
    ece: number | null;
    totalTrades: number;
    bins: Array<{ key: string; binMid: number; wins: number; losses: number; empiricalWR: number; samples: number; calibrated: number; gap: number }>;
    klineReads: { correct: number; total: number };
  } {
    const rows: Array<{ key: string; binMid: number; wins: number; losses: number; empiricalWR: number; samples: number; calibrated: number; gap: number }> = [];
    let totalN = 0;
    let eceSum = 0;
    for (const [key] of Object.entries(this.state.bins)) {
      // key = "side|binIdx" → binIdx → 中點 conviction = (idx+0.5)/NUM_BINS
      const idx = Number(key.split('|')[1] ?? 0);
      if (!Number.isInteger(idx) || idx < 0 || idx >= NUM_BINS) continue; // 毒 key 防護
      const side = key.split('|')[0] as 'buy' | 'sell';
      // v2.0.870-P5: 用 decayed bin(時間衰減 + hard cutoff)——ECE 反映近期校準
      const decayed = this.getDecayedBin(side, idx);
      if (!decayed) continue; // 過期 bin → 零影響
      const w = Math.max(0, decayed.wins);
      const l = Math.max(0, decayed.losses);
      const n = w + l;
      if (n <= 0) continue;
      const binMid = (idx + 0.5) / NUM_BINS;
      const empiricalWR = w / n;
      const calibrated = calibrateBin(w, l, binMid);
      const gap = binMid - empiricalWR; // 正 = 過度自信;負 = 被低估
      rows.push({ key, binMid: Math.round(binMid * 100) / 100, wins: w, losses: l, empiricalWR: Math.round(empiricalWR * 1000) / 1000, samples: n, calibrated: Math.round(calibrated * 1000) / 1000, gap: Math.round(gap * 1000) / 1000 });
      totalN += n;
      eceSum += n * Math.abs(gap);
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return {
      ece: totalN > 0 ? Math.round((eceSum / totalN) * 1000) / 1000 : null,
      totalTrades: totalN,
      bins: rows,
      klineReads: { correct: this.state.klineReads.correct, total: this.state.klineReads.total },
    };
  }
}

/** 全系統共享單例 */
export const llmConvictionCalibrator = new LLMConvictionCalibrator();
