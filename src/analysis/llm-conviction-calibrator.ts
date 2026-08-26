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
const KLINE_READ_WINDOW = 20;    // 讀圖一致率窗口
const DEFAULT_PATH = 'data/evolution/llm-conviction-calibration.json';

export interface LLMCalibrationState {
  /** per (side × bin): wins/losses */
  bins: Record<string, { wins: number; losses: number }>;
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
    const bin = this.state.bins[key] ?? { wins: 0, losses: 0 };
    if (outcome === 'win') bin.wins++;
    else bin.losses++;
    this.state.bins[key] = bin;
  }

  /** 校準一筆 conviction——LLM 話 0.85 → bin 實際 WR。
   *  v2.0.863-calib-attack (V1): 非 finite conviction → 0.5 中性——
   *  NaN/Infinity/undefined 唔可以傳播返 gate(會污染 effectiveConfidence)。 */
  getCalibratedConviction(side: 'buy' | 'sell', conviction: number): number {
    if (typeof conviction !== 'number' || !Number.isFinite(conviction)) return 0.5;
    const key = binKey(side, binOf(conviction));
    const bin = this.state.bins[key];
    if (!bin || bin.wins + bin.losses < MIN_SAMPLES) return conviction; // 冷啟動中性
    return calibrateBin(bin.wins, bin.losses, conviction);
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
        const bin = this.state.bins[binKey(side, i)];
        if (!bin || bin.wins + bin.losses < MIN_SAMPLES) continue;
        const lo = i / NUM_BINS, hi = (i + 1) / NUM_BINS;
        const emp = bin.wins / (bin.wins + bin.losses);
        parts.push(`[${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%: 實際 ${(emp * 100).toFixed(0)}%(${bin.wins}W/${bin.losses}L)]`);
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
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.state }), 'utf-8');
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
    for (const [key, bin] of Object.entries(this.state.bins)) {
      const w = Math.max(0, bin.wins ?? 0);
      const l = Math.max(0, bin.losses ?? 0);
      const n = w + l;
      if (n <= 0) continue;
      // key = "side|binIdx" → binIdx → 中點 conviction = (idx+0.5)/NUM_BINS
      const idx = Number(key.split('|')[1] ?? 0);
      if (!Number.isInteger(idx) || idx < 0 || idx >= NUM_BINS) continue; // 毒 key 防護
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
