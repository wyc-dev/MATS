// ─── P80: Success Pattern Tracker（成功類型統計 + 持久化）───
// 完整閉環: 贏單 close → record() → 統計 → 持久化 success-patterns.json
//          → 入場 gate getMultiplier() → effectiveConfidence *=（soft）
import { rootLogger } from '../observability/logger.ts';
import { SUCCESS_PATTERNS, classifySuccessPattern, type SuccessPattern, type SuccessPatternStats } from '../analysis/success-pattern.ts';
import { lockedWrite } from '../evolution/persistence.ts';
import fs from 'fs';

const log = rootLogger;
const STATE_FILE = 'data/evolution/success-patterns.json';

// V1: pnlPct clamp 範圍（±100%——正常 pnlPct 係百分比 <100%；100% 已係極端）
const MAX_PNL_PCT = 100;
// V3: 樣本上限（同其他 tracker 一致——防持久化污染 n=1e9）
const MAX_SAMPLES = 100000;
// E1: 時間衰減 half-life（24h——同 RegimeWinRateLearner 一致）
const DECAY_TAU_MS = 24 * 3600 * 1000;
// E1: recent ring 上限
const RECENT_CAP = 100;
// F1-v2: backfill 指紋版本——stats 結構升級（加 recent ring）時 version bump → 強制重新 backfill
const BACKFILL_VERSION = 2;

/** V1: clamp pnlPct 到合理範圍（±300%）——1e308 污染值唔入 stats */
function clampPnl(pnlPct: number): number {
  if (!Number.isFinite(pnlPct)) return 0;
  return Math.max(-MAX_PNL_PCT, Math.min(MAX_PNL_PCT, pnlPct));
}

interface SuccessPatternState {
  stats: Record<SuccessPattern, SuccessPatternStats>;
  /** P80-backfill: 已 backfill 歷史數據（idempotent——唔會重複） */
  backfillDone?: boolean;
  /** F1: backfill 數據指紋——trades count + 最新 closedAt + 指紋版本（數據集身份）。
   *  只有「成功 record 全部」先 set——指紋唔 match（包括舊檔冇指紋 / 版本過期）→ 重新 backfill。
   *  修復 P80 部署後 backfillDone=true 但 stats 得 5 筆（200 筆歷史從未入）嘅假成功 bug。
   *  F1-v2: version 維度——stats 結構升級（加 recent ring）時舊指紋唔 match → 重新 backfill。 */
  backfillFingerprint?: { count: number; latestClosedAt: number; version: number };
}

function emptyStats(): Record<SuccessPattern, SuccessPatternStats> {
  const s = {} as Record<SuccessPattern, SuccessPatternStats>;
  for (const p of SUCCESS_PATTERNS) s[p] = { n: 0, wins: 0, pnlSum: 0 };
  return s;
}

export class SuccessPatternTracker {
  private stats: Record<SuccessPattern, SuccessPatternStats> = emptyStats();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private backfillDone = false;
  /** F1-v2: backfill 數據指紋（load 時還原；舊檔冇 / 版本過期 → undefined → 下次 backfill 重新做） */
  private backfillFingerprint: { count: number; latestClosedAt: number; version: number } | undefined = undefined;
  /** DI: state file 可注入（測試用 temp path——唔污染 production 檔） */
  private readonly stateFile: string;

  constructor(stateFile: string = STATE_FILE) {
    this.stateFile = stateFile;
  }

  /** 記錄一筆交易嘅成功類型（close 後 call） */
  record(pattern: SuccessPattern, pnlPct: number, isWin: boolean, closedAt: number = Date.now()): void {
    // FIX-3（攻擊輪 C1）: 白名單驗證——垃圾 pattern 唔入 stats（無限 key 增長）
    if (!SUCCESS_PATTERNS.includes(pattern)) return;
    const s = this.stats[pattern] ?? { n: 0, wins: 0, pnlSum: 0, recent: [] };
    // V1: clamp pnlPct（±300%）——1e308 污染值唔入 stats
    const pnl = clampPnl(pnlPct);
    s.n++;
    if (isWin) s.wins++;
    s.pnlSum += pnl;
    // E1: recent ring（cap 100）——時間衰減用
    if (!Array.isArray(s.recent)) s.recent = [];
    s.recent.push({ pnlPct: pnl, closedAt: Number.isFinite(closedAt) && closedAt > 0 ? closedAt : Date.now() });
    if (s.recent.length > RECENT_CAP) s.recent.splice(0, s.recent.length - RECENT_CAP);
    // V3: 樣本上限（防 runtime 無限累積）
    if (s.n > MAX_SAMPLES) s.n = MAX_SAMPLES;
    if (s.wins > s.n) s.wins = s.n;
    this.stats[pattern] = s;
    this.scheduleSave();
  }

  /** P80-backfill: 用歷史 realTrades 初始化（idempotent——數據指紋保證唔重複） */
  backfillFromTrades(trades: Array<{ entryThesis?: string | null; pnlPct?: number | null; closedAt?: number | null }>): void {
    if (!Array.isArray(trades) || trades.length === 0) return;
    // F1: 數據指紋——同一批數據已 backfill → skip（idempotent）
    const fp = this.computeFingerprint(trades);
    if (this.backfillDone && this.backfillFingerprint &&
        this.backfillFingerprint.count === fp.count &&
        this.backfillFingerprint.latestClosedAt === fp.latestClosedAt &&
        this.backfillFingerprint.version === fp.version) {
      return;
    }
    // 指紋唔 match（舊檔冇指紋 / 數據集有變）→ 重新 backfill（全量重算，避免 double count）
    if (this.backfillDone) {
      log.warn(`[success-pattern] backfill fingerprint mismatch (was ${JSON.stringify(this.backfillFingerprint)}, now ${JSON.stringify(fp)}) — re-backfilling from ${trades.length} trades`);
    }
    this.stats = emptyStats();
    let fed = 0;
    for (const t of trades) {
      // V5: 單筆失敗（getter-bomb/垃圾元素）→ skip 唔中斷成個 backfill
      try {
        if (typeof t?.entryThesis !== 'string' || t.entryThesis.trim().length === 0) continue;
        // pnlPct 無效（NaN/Infinity）→ skip（數據唔可靠——唔入統計）
        if (typeof t.pnlPct !== 'number' || !Number.isFinite(t.pnlPct)) continue;
        // V1: clamp pnlPct（±300%）——1e308 污染值唔入 stats
        const pnlPct = clampPnl(t.pnlPct * 100);
        const isWin = pnlPct > 0;
        const closedAt = typeof t.closedAt === 'number' && Number.isFinite(t.closedAt) && t.closedAt > 0 ? t.closedAt : Date.now();
        this.record(classifySuccessPattern(t.entryThesis), pnlPct, isWin, closedAt);
        fed++;
      } catch { /* V5: 單筆失敗 skip——唔中斷 */ }
    }
    this.backfillDone = true;
    this.backfillFingerprint = fp;
    this.save();
    log.info(`[success-pattern] Backfilled ${fed} historical trades (fingerprint=${JSON.stringify(fp)})`);
  }

  /** F1: 計算 backfill 數據指紋——trades count + 最新 closedAt + 指紋版本（數據集身份；NaN/負數 → 0 安全） */
  private computeFingerprint(trades: Array<{ closedAt?: number | null }>): { count: number; latestClosedAt: number; version: number } {
    let latestClosedAt = 0;
    for (const t of trades) {
      // V5: 單筆 getter-bomb/垃圾元素 → skip（唔中斷成個 fingerprint）
      try {
        const c = typeof t?.closedAt === 'number' && Number.isFinite(t.closedAt) && t.closedAt > 0 ? t.closedAt : 0;
        if (c > latestClosedAt) latestClosedAt = c;
      } catch { /* V5: 單筆失敗 skip */ }
    }
    return { count: trades.length, latestClosedAt, version: BACKFILL_VERSION };
  }

  /** 入場 gate 用——成功類型校準乘數（soft） */
  getMultiplier(pattern: SuccessPattern): number {
    // V4: 白名單驗證——垃圾 pattern（__proto__/constructor）唔入 stats
    if (!SUCCESS_PATTERNS.includes(pattern)) return 1.0;
    const s = this.stats[pattern];
    if (!s || s.n === 0) return 1.0;
    // 冷啟動: n < 10 → ×1.0（唔干擾 bootstrap）
    if (s.n < 10) return 1.0;
    // E1: 時間加權中位數 avgPnl（recent ring + exp(-Δt/τ)）——robust（離群值免疫）+ 舊數據唔再等權
    const robustAvg = this.computeRobustAvgPnl(s);
    if (robustAvg > 1.0) return 1.1;
    if (robustAvg < -0.5) return 0.7;
    return 1.0;
  }

  /** E1: 時間加權中位數 avgPnl——recent ring 用 exp(-Δt/τ) 權重（τ=24h）；
   *   robust（中位數對離群值免疫——1e308 污染值唔翻轉統計）；recent 空 → 點估計 fallback */
  private computeRobustAvgPnl(s: SuccessPatternStats): number {
    const recent = s.recent;
    if (!Array.isArray(recent) || recent.length === 0) {
      return s.pnlSum / s.n;
    }
    const now = Date.now();
    const weighted: Array<{ pnl: number; w: number }> = [];
    for (const r of recent) {
      // V5: 單筆垃圾元素 → skip
      try {
        const pnl = typeof r?.pnlPct === 'number' && Number.isFinite(r.pnlPct) ? r.pnlPct : 0;
        const closedAt = typeof r?.closedAt === 'number' && Number.isFinite(r.closedAt) ? r.closedAt : now;
        const w = Math.exp(-Math.max(0, now - closedAt) / DECAY_TAU_MS);
        weighted.push({ pnl, w });
      } catch { /* V5: skip */ }
    }
    if (weighted.length === 0) return s.pnlSum / s.n;
    // 按 pnl 排序，累計權重搵中位數（時間加權中位數）
    weighted.sort((a, b) => a.pnl - b.pnl);
    const totalW = weighted.reduce((sum, x) => sum + x.w, 0);
    if (totalW <= 0) return s.pnlSum / s.n;
    let cum = 0;
    for (const x of weighted) {
      cum += x.w;
      if (cum >= totalW / 2) return x.pnl;
    }
    const last = weighted[weighted.length - 1];
    return last ? last.pnl : s.pnlSum / s.n;
  }

  /** 觀測: 每種成功類型嘅統計（SSE/audit 用） */
  getStats(): Record<SuccessPattern, SuccessPatternStats> {
    const out = {} as Record<SuccessPattern, SuccessPatternStats>;
    for (const p of SUCCESS_PATTERNS) {
      const s = this.stats[p] ?? { n: 0, wins: 0, pnlSum: 0, recent: [] };
      // E1: 填入時間加權中位數 avgPnl（audit 顯示用）
      const robustAvg = this.computeRobustAvgPnl(s);
      out[p] = { ...s, weightedAvgPnl: Number.isFinite(robustAvg) ? robustAvg : undefined };
    }
    return out;
  }

  save(): void {
    try {
      const state: SuccessPatternState = { stats: this.stats, backfillDone: this.backfillDone, backfillFingerprint: this.backfillFingerprint };
      lockedWrite(this.stateFile, JSON.stringify(state));
    } catch (err) {
      log.warn(`[success-pattern] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<SuccessPatternState>;
      const loaded = emptyStats();
      if (raw.stats && typeof raw.stats === 'object') {
        for (const p of SUCCESS_PATTERNS) {
          const s = (raw.stats as Record<string, unknown>)[p] as Partial<SuccessPatternStats> | undefined;
          if (s && typeof s === 'object') {
            // sanitize: n/wins 必須 finite 非負整數;pnlSum finite
            // V3: cap n/wins 上限（MAX_SAMPLES）——1e9 污染值唔通過
            const n = typeof s.n === 'number' && Number.isFinite(s.n) && s.n >= 0 ? Math.min(Math.floor(s.n), MAX_SAMPLES) : 0;
            const wins = typeof s.wins === 'number' && Number.isFinite(s.wins) && s.wins >= 0 ? Math.min(Math.floor(s.wins), n) : 0;
            const pnlSum = typeof s.pnlSum === 'number' && Number.isFinite(s.pnlSum) ? s.pnlSum : 0;
            // E1: recent ring sanitize（cap 100，每筆 pnlPct/clampedAt finite）
            let recent: Array<{ pnlPct: number; closedAt: number }> | undefined;
            if (Array.isArray(s.recent)) {
              recent = [];
              for (const r of s.recent) {
                if (r && typeof r === 'object') {
                  const rp = (r as Record<string, unknown>);
                  const pnl = typeof rp['pnlPct'] === 'number' && Number.isFinite(rp['pnlPct']) ? clampPnl(rp['pnlPct'] as number) : 0;
                  const ca = typeof rp['closedAt'] === 'number' && Number.isFinite(rp['closedAt']) && (rp['closedAt'] as number) > 0 ? (rp['closedAt'] as number) : 0;
                  if (ca > 0) recent.push({ pnlPct: pnl, closedAt: ca });
                }
              }
              if (recent.length > RECENT_CAP) recent = recent.slice(recent.length - RECENT_CAP);
            }
            loaded[p] = { n, wins, pnlSum, ...(recent ? { recent } : {}) };
          }
        }
      }
      this.stats = loaded;
      this.backfillDone = raw.backfillDone === true;
      // F1: 讀 backfill 指紋（舊檔冇 / 版本過期 → undefined → 下次 backfill 重新做——修復假成功 bug）
      const bf = raw.backfillFingerprint;
      this.backfillFingerprint = bf && typeof bf === 'object' &&
        typeof bf.count === 'number' && Number.isFinite(bf.count) && bf.count >= 0 &&
        typeof bf.latestClosedAt === 'number' && Number.isFinite(bf.latestClosedAt) && bf.latestClosedAt >= 0 &&
        typeof bf.version === 'number' && Number.isFinite(bf.version) && bf.version === BACKFILL_VERSION
        ? { count: Math.floor(bf.count), latestClosedAt: bf.latestClosedAt, version: bf.version }
        : undefined;
      log.info(`[success-pattern] Loaded ${SUCCESS_PATTERNS.reduce((sum, p) => sum + (loaded[p]?.n ?? 0), 0)} samples (backfillDone=${this.backfillDone}, fingerprint=${JSON.stringify(this.backfillFingerprint)})`);
    } catch (err) {
      log.warn(`[success-pattern] load failed (fresh start): ${err instanceof Error ? err.message : String(err)}`);
      this.stats = emptyStats();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.save(); this.saveTimer = null; }, 2000);
  }
}
