// ─── P80: Success Pattern Tracker（成功類型統計 + 持久化）───
// 完整閉環: 贏單 close → record() → 統計 → 持久化 success-patterns.json
//          → 入場 gate getMultiplier() → effectiveConfidence *=（soft）
import { rootLogger } from '../observability/logger.ts';
import { SUCCESS_PATTERNS, type SuccessPattern, type SuccessPatternStats } from '../analysis/success-pattern.ts';
import { lockedWrite } from '../evolution/persistence.ts';
import fs from 'fs';

const log = rootLogger;
const STATE_FILE = 'data/evolution/success-patterns.json';

interface SuccessPatternState {
  stats: Record<SuccessPattern, SuccessPatternStats>;
}

function emptyStats(): Record<SuccessPattern, SuccessPatternStats> {
  const s = {} as Record<SuccessPattern, SuccessPatternStats>;
  for (const p of SUCCESS_PATTERNS) s[p] = { n: 0, wins: 0, pnlSum: 0 };
  return s;
}

export class SuccessPatternTracker {
  private stats: Record<SuccessPattern, SuccessPatternStats> = emptyStats();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** 記錄一筆交易嘅成功類型（close 後 call） */
  record(pattern: SuccessPattern, pnlPct: number, isWin: boolean): void {
    // FIX-3（攻擊輪 C1）: 白名單驗證——垃圾 pattern 唔入 stats（無限 key 增長）
    if (!SUCCESS_PATTERNS.includes(pattern)) return;
    const s = this.stats[pattern] ?? { n: 0, wins: 0, pnlSum: 0 };
    s.n++;
    if (isWin) s.wins++;
    s.pnlSum += Number.isFinite(pnlPct) ? pnlPct : 0;
    this.stats[pattern] = s;
    this.scheduleSave();
  }

  /** 入場 gate 用——成功類型校準乘數（soft） */
  getMultiplier(pattern: SuccessPattern): number {
    const s = this.stats[pattern];
    if (!s || s.n === 0) return 1.0;
    // 冷啟動: n < 10 → ×1.0（唔干擾 bootstrap）
    if (s.n < 10) return 1.0;
    const avgPnl = s.pnlSum / s.n;
    if (avgPnl > 1.0) return 1.1;
    if (avgPnl < -0.5) return 0.7;
    return 1.0;
  }

  /** 觀測: 每種成功類型嘅統計（SSE/audit 用） */
  getStats(): Record<SuccessPattern, SuccessPatternStats> {
    const out = {} as Record<SuccessPattern, SuccessPatternStats>;
    for (const p of SUCCESS_PATTERNS) {
      const s = this.stats[p] ?? { n: 0, wins: 0, pnlSum: 0 };
      out[p] = { ...s };
    }
    return out;
  }

  save(): void {
    try {
      const state: SuccessPatternState = { stats: this.stats };
      lockedWrite(STATE_FILE, JSON.stringify(state));
    } catch (err) {
      log.warn(`[success-pattern] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<SuccessPatternState>;
      const loaded = emptyStats();
      if (raw.stats && typeof raw.stats === 'object') {
        for (const p of SUCCESS_PATTERNS) {
          const s = (raw.stats as Record<string, unknown>)[p] as Partial<SuccessPatternStats> | undefined;
          if (s && typeof s === 'object') {
            // sanitize: n/wins 必須 finite 非負整數;pnlSum finite
            const n = typeof s.n === 'number' && Number.isFinite(s.n) && s.n >= 0 ? Math.floor(s.n) : 0;
            const wins = typeof s.wins === 'number' && Number.isFinite(s.wins) && s.wins >= 0 ? Math.floor(s.wins) : 0;
            const pnlSum = typeof s.pnlSum === 'number' && Number.isFinite(s.pnlSum) ? s.pnlSum : 0;
            loaded[p] = { n, wins, pnlSum };
          }
        }
      }
      this.stats = loaded;
      log.info(`[success-pattern] Loaded ${SUCCESS_PATTERNS.reduce((sum, p) => sum + (loaded[p]?.n ?? 0), 0)} samples`);
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
