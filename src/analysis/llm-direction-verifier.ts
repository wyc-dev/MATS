// ─── LLM Direction Verifier (v2.0.864) — 方向預測 + 平倉結果雙層校準 ──
//
// 主神問題:「有沒有記錄每次執行的時候 LLM 所給予的判斷和建議,來給予日後的
// LLM 判斷之前對於相關資產和相關走勢的判斷是否正確?」
//
// 三層驗證(每 cycle + 平倉時):
//   A. 讀圖一致(規限②已有——thesis claim vs 嗰刻統計 K-LINE)
//   B. 方向預測(每 cycle)——LLM 判斷 direction vs 之後實際 price 方向
//      ——每 cycle 驗證,樣本 = cycles(包括 HOLD/冇落單嘅判斷)
//   C. 平倉結果(平倉時,終極)——該筆判斷嘅 trade 最終賺定蝕
//      ——by tradeId idempotent(每筆 trade 只記錄一次)
//
// 準確率 = blend(B 方向預測 + C 平倉結果)——B 樣本多、C 係終極
// gate 乘數 ×[0.80, 1.05] + shrink(樣本少 → 中性)——永遠唔 hard block
// 三層 fallback:symbol×trend-type → trend-type 全局 → 中性(新市場參考其他走勢)

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'dir-verifier' });

// ─── Config ────────────────────────────────────────────────────────────

const PRIMARY_MIN_SAMPLES = 10;   // (symbol × trend-type) 最少樣本
const FALLBACK_MIN_SAMPLES = 20;  // trend-type 全局最少樣本
const SHRINK_K = 8;               // 樣本加權 shrink——少樣本唔過度校準
const OUTCOME_BLEND = 0.30;       // C(平倉結果)喺準確率嘅權重(終極但稀疏)
const WINDOW_MIN_SAMPLES = 10;    // 窗口校準最少樣本(先信該窗口)
// 較準:驗證窗口候選(秒)——自動揀「準確率最高」嗰個
// v2.0.864-scalp:短炒導向——5m/15m 優先,default 15m(1-10 分鐘 cycle 玩家)
const VERIFY_WINDOWS = [5 * 60, 15 * 60, 30 * 60, 60 * 60, 120 * 60];
const DEFAULT_VERIFY_WINDOW = 15 * 60; // 短炒 default 15m(窗口校準會自動調)
const DEFAULT_PATH = 'data/evolution/llm-direction-verifier.json';

interface Counter {
  correct: number;
  total: number;
}

export interface DirectionVerifierState {
  /** 未驗證判斷:judgmentId → { symbol, direction, trendType, cycle, ts, price, quickVerified, scheduledVerifyAt } */
  pending: Record<string, { symbol: string; direction: 'buy' | 'sell'; trendType: string; cycle: number; ts: number; price?: number; quickVerified?: boolean; scheduledVerifyAt: number }>;
  /** B:方向預測結果 per (symbol|trendType) */
  direction: Record<string, Counter>;
  /** C:平倉結果 per (symbol|trendType) */
  outcome: Record<string, Counter>;
  /** 已記錄平倉嘅 tradeIds(防重複) */
  outcomeTradeIds: string[];
  /** 較準:per trend-type × window 嘅準確驗證結果(揀最佳窗口用) */
  windowStats: Record<string, Counter>;
  /** v2.0.865-fix:backfill 完成標記(persisted)——防止 restart 重複 backfill */
  backfillDone: boolean;
}

function emptyState(): DirectionVerifierState {
  return { pending: {}, direction: {}, outcome: {}, outcomeTradeIds: [], windowStats: {}, backfillDone: false };
}

function windowKey(trendType: string, windowIdx: number): string {
  return `${trendType}|w${windowIdx}`;
}

/** v2.0.864-attack (V5): 毒 key 會 pollution prototype——跳過 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function key(symbol: string, trendType: string): string {
  return `${symbol}|${trendType}`;
}

/** 平滑準確率 → gate 乘數(×[0.80, 1.05],shrink 向中性)。
 *  v2.0.864-fix:0.5(隨機/冇預測力)= 中性錨點 → ×1.0——
 *  唔可以壓抑(0.5 唔係反指,係「無資訊」);只有 <0.5(真反指)先壓。 */
export function accuracyToMultiplier(accuracy: number, total: number): number {
  if (!Number.isFinite(accuracy) || total <= 0) return 1.0;
  const acc = Math.max(0, Math.min(1, accuracy));
  const shrink = total / (total + SHRINK_K);
  const raw = acc >= 0.65 ? 1.05 : acc >= 0.60 ? 1.0 : acc >= 0.55 ? 0.95 : acc >= 0.50 ? 1.0 : 0.85;
  return 1.0 + (raw - 1.0) * shrink; // 少樣本 → 乘數趨近 1.0
}

// ─── Main ──────────────────────────────────────────────────────────────

export class LLMDirectionVerifier {
  private state: DirectionVerifierState;
  private path: string;
  private nextId = 1;

  constructor(path = DEFAULT_PATH) {
    this.state = emptyState();
    this.path = path;
  }

  // ── 每 cycle:記錄 LLM 判斷 ──────────────────────────────────────────

  /** 記錄一筆 LLM 方向判斷(每 cycle——包括 HOLD/冇落單)。price = 判斷時價格(驗證用) */
  recordJudgment(symbol: string, direction: 'buy' | 'sell', trendType: string, cycle: number, price?: number): string | null {
    if (!symbol || typeof symbol !== 'string') return null;
    if (direction !== 'buy' && direction !== 'sell') return null;
    const tt = typeof trendType === 'string' && trendType.length > 0 ? trendType : 'unknown';
    const id = `j${this.nextId++}`;
    const now = Date.now();
    const bestWindow = this.getBestVerifyWindow(tt); // 較準:該 trend-type 最佳驗證窗口
    this.state.pending[id] = {
      symbol: symbol.slice(0, 24),
      direction,
      trendType: tt.slice(0, 32),
      cycle: Number.isFinite(cycle) ? Math.floor(cycle) : 0,
      ts: now,
      price: Number.isFinite(price) && (price as number) > 0 ? price : undefined,
      quickVerified: false,
      scheduledVerifyAt: now + bestWindow,
    };
    this.capPending();
    return id;
  }

  /** pending 上限——防無限增長(每 cycle 一條,cap 5000 足夠幾個月) */
  private capPending(): void {
    const entries = Object.entries(this.state.pending);
    if (entries.length > 5000) {
      // 刪最舊(cycle 細)直到 <= 4000
      entries.sort((a, b) => a[1].cycle - b[1].cycle);
      const toDrop = entries.slice(0, entries.length - 4000);
      for (const [id] of toDrop) {
        delete this.state.pending[id];
      }
    }
  }

  // ── 每 cycle:驗證 B(方向預測)──────────────────────────────────────

  /**
   * 驗證一筆判斷:B 方向預測——用「判斷時 price vs 而家 price」比較。
   *   buy  + price 升 = 正確;sell + price 跌 = 正確
   *   (判斷時無 price 或 currentPrice 無效 → delete 唔計——避免 pending 堆積)
   */
  verifyDirection(judgmentId: string, currentPrice: number | null): void {
    if (!judgmentId || !Number.isFinite(currentPrice) || (currentPrice as number) <= 0) {
      if (judgmentId) delete this.state.pending[judgmentId]; // 無效驗證 → 棄置
      return;
    }
    const j = this.state.pending[judgmentId];
    if (!j) return; // 已驗證/唔存在——安全
    delete this.state.pending[judgmentId];
    const jp = j.price;
    if (jp === undefined || !Number.isFinite(jp) || jp <= 0) return; // 判斷時無價 → 唔計
    const cp = currentPrice as number;
    const up = cp > jp;
    const k = key(j.symbol, j.trendType);
    const correct = (j.direction === 'buy') === up;
    const c = this.state.direction[k] ?? { correct: 0, total: 0 };
    c.total++;
    if (correct) c.correct++;
    this.state.direction[k] = c;
  }

  // ── 平倉時:記錄 C(平倉結果)────────────────────────────────────────

  /**
   * 平倉時記錄終極結果:C——該筆判斷嘅 trade 最終賺定蝕。
   * by tradeId idempotent——同一筆 trade 平倉事件可能多次觸發,只記一次。
   */
  recordOutcome(symbol: string, trendType: string, tradeId: string, isWin: boolean): void {
    if (!symbol || !tradeId) return;
    if (this.state.outcomeTradeIds.includes(tradeId)) return; // idempotent
    const tt = typeof trendType === 'string' && trendType.length > 0 ? trendType : 'unknown';
    const k = key(symbol.slice(0, 24), tt.slice(0, 32));
    const c = this.state.outcome[k] ?? { correct: 0, total: 0 };
    c.total++;
    if (isWin) c.correct++;
    this.state.outcome[k] = c;
    this.state.outcomeTradeIds.push(tradeId);
    if (this.state.outcomeTradeIds.length > 20000) {
      this.state.outcomeTradeIds = this.state.outcomeTradeIds.slice(-15000);
    }
  }

  // ── 較準:時間窗口自動校準 ────────────────────────────────────────

  /**
   * 較準:揀「該 trend-type 準確率最高 + 樣本夠」嘅驗證窗口(EWMA shrink)。
   * 無樣本 → default 1h。窗口隨歷史表現漂移——「不斷調校提高準確度」。
   */
  getBestVerifyWindow(trendType: string): number {
    const tt = typeof trendType === 'string' && trendType.length > 0 ? trendType : 'unknown';
    let best = DEFAULT_VERIFY_WINDOW;
    let bestScore = -1;
    for (let wi = 0; wi < VERIFY_WINDOWS.length; wi++) {
      const c = this.state.windowStats[windowKey(tt, wi)];
      if (!c || c['total'] < WINDOW_MIN_SAMPLES) continue;
      const acc = c['correct'] / c['total'];
      const score = acc - (WINDOW_MIN_SAMPLES / (WINDOW_MIN_SAMPLES + c['total'])) * 0.5; // 樣本懲罰
      if (score > bestScore) {
        bestScore = score;
        best = VERIFY_WINDOWS[wi] ?? DEFAULT_VERIFY_WINDOW;
      }
    }
    return best;
  }

  /** 該 trend-type 喺「最佳窗口」下嘅準確率(較準——反映真實預測能力) */
  getAccurateAccuracy(trendType: string): { accuracy: number; total: number; windowSec: number } {
    const tt = typeof trendType === 'string' && trendType.length > 0 ? trendType : 'unknown';
    let bestAcc = 0.5, bestTotal = 0, bestWindow = DEFAULT_VERIFY_WINDOW, bestScore = -1;
    for (let wi = 0; wi < VERIFY_WINDOWS.length; wi++) {
      const c = this.state.windowStats[windowKey(tt, wi)];
      if (!c || c['total'] < WINDOW_MIN_SAMPLES) continue;
      const acc = c['correct'] / c['total'];
      const score = acc - (WINDOW_MIN_SAMPLES / (WINDOW_MIN_SAMPLES + c['total'])) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestAcc = acc;
        bestTotal = c['total'];
        bestWindow = VERIFY_WINDOWS[wi] ?? DEFAULT_VERIFY_WINDOW;
      }
    }
    return { accuracy: bestTotal > 0 ? bestAcc : 0.5, total: bestTotal, windowSec: bestWindow };
  }

  /** 每 cycle:驗證所有 pending 判斷。
   *  雙層驗證:
   *    quick(即時)——未驗證過 → 用現價驗證 → 計入 direction bins(快速回饋)
   *    accurate(較準)——到 scheduledVerifyAt → 用現價驗證 → 計入 windowStats
   *      (該 trend-type × 該窗口)——乘數用呢個,反映真實預測能力 */
  verifyAllPending(priceFor: (symbol: string) => number | null): void {
    const now = Date.now();
    const ids = Object.keys(this.state.pending);
    for (const id of ids) {
      const j = this.state.pending[id];
      if (!j) continue;
      const ageMs = now - (j.ts ?? now);
      // 超時棄置:48h + 兩倍最大窗口後仍未到期(判斷已過時)
      const maxWindow = VERIFY_WINDOWS[VERIFY_WINDOWS.length - 1] ?? DEFAULT_VERIFY_WINDOW;
      if (ageMs > 48 * 3600 * 1000 + 2 * maxWindow * 1000) {
        delete this.state.pending[id];
        continue;
      }
      let price: number | null = null;
      try { price = priceFor(j.symbol); } catch { /* non-fatal */ }
      if (price === null || !Number.isFinite(price) || (price as number) <= 0) continue; // 無價 → 留低下次
      const cp = price as number;
      const jp = j.price;
      if (jp === undefined || !Number.isFinite(jp) || jp <= 0) {
        delete this.state.pending[id]; // 判斷時無價 → 唔可驗證 → 棄置
        continue;
      }
      // quick:未驗證過 → 即時驗證(計入 direction bins——每 cycle 回饋)
      if (!j.quickVerified) {
        j.quickVerified = true;
        const upQ = cp > jp;
        const kQ = key(j.symbol, j.trendType);
        const cQ = this.state.direction[kQ] ?? { correct: 0, total: 0 };
        cQ['total']++;
        if ((j.direction === 'buy') === upQ) cQ['correct']++;
        this.state.direction[kQ] = cQ;
      }
      // accurate:到期 → 較準驗證(計入 windowStats——揀最佳窗口)
      if (now >= j.scheduledVerifyAt) {
        const upA = cp > jp;
        const wi = this.windowIndexFor(j.scheduledVerifyAt - j.ts);
        const wKey = windowKey(j.trendType, wi);
        const cA = this.state.windowStats[wKey] ?? { correct: 0, total: 0 };
        cA['total']++;
        if ((j.direction === 'buy') === upA) cA['correct']++;
        this.state.windowStats[wKey] = cA;
        delete this.state.pending[id];
      }
    }
  }

  /** 判斷嘅實際窗口 → 最近嘅 VERIFY_WINDOWS index */
  private windowIndexFor(durationMs: number): number {
    const sec = Math.max(1, Math.floor(durationMs / 1000));
    let best = 0;
    for (let wi = 0; wi < VERIFY_WINDOWS.length; wi++) {
      if (Math.abs(sec - (VERIFY_WINDOWS[wi] ?? DEFAULT_VERIFY_WINDOW)) < Math.abs(sec - (VERIFY_WINDOWS[best] ?? DEFAULT_VERIFY_WINDOW))) {
        best = wi;
      }
    }
    return best;
  }

  // ── 查詢(三層 fallback + blend)────────────────────────────────────

  /** 該 (symbol × trend-type) 判斷嘅 B 方向預測準確率——三層 fallback */
  getDirectionAccuracy(symbol: string, trendType: string): { accuracy: number; total: number; source: 'primary' | 'fallback' | 'neutral' } {
    const sym = typeof symbol === 'string' ? symbol : '';
    const tt = typeof trendType === 'string' && trendType.length > 0 ? trendType : 'unknown';
    const primary = this.state.direction[key(sym, tt)];
    if (primary && primary.total >= PRIMARY_MIN_SAMPLES) {
      return { accuracy: primary.correct / primary.total, total: primary.total, source: 'primary' };
    }
    // fallback:該 trend-type 全局(跨 symbol)——主神要求:新市場參考其他走勢
    const global = this.fallbackCounter(this.state.direction, tt);
    if (global.total >= FALLBACK_MIN_SAMPLES) {
      return { accuracy: global.correct / global.total, total: global.total, source: 'fallback' };
    }
    return { accuracy: 0.5, total: 0, source: 'neutral' };
  }

  /** 該 (symbol × trend-type) 判斷嘅 C 平倉結果準確率——三層 fallback */
  getOutcomeAccuracy(symbol: string, trendType: string): { accuracy: number; total: number; source: 'primary' | 'fallback' | 'neutral' } {
    const sym = typeof symbol === 'string' ? symbol : '';
    const tt = typeof trendType === 'string' && trendType.length > 0 ? trendType : 'unknown';
    const primary = this.state.outcome[key(sym, tt)];
    if (primary && primary.total >= PRIMARY_MIN_SAMPLES) {
      return { accuracy: primary.correct / primary.total, total: primary.total, source: 'primary' };
    }
    const global = this.fallbackCounter(this.state.outcome, tt);
    if (global.total >= FALLBACK_MIN_SAMPLES) {
      return { accuracy: global.correct / global.total, total: global.total, source: 'fallback' };
    }
    return { accuracy: 0.5, total: 0, source: 'neutral' };
  }

  /** 合併「較準 B + C」嘅最終準確率:acc = (1-β)×B_acc + β×C(C 有樣本時)。
   *  較準 = 用「該 trend-type 最佳窗口」下嘅準確率(真實預測能力,唔係 5 分鐘噪聲)。 */
  getBlendedAccuracy(symbol: string, trendType: string): { accuracy: number; total: number } {
    const acc = this.getAccurateAccuracy(trendType); // 較準——trend-type 最佳窗口
    const c = this.getOutcomeAccuracy(symbol, trendType);
    const hasC = c.total >= PRIMARY_MIN_SAMPLES || c.source === 'fallback';
    const blend = hasC ? OUTCOME_BLEND : 0;
    const finalAcc = (1 - blend) * (acc.total > 0 ? acc.accuracy : this.getDirectionAccuracy(symbol, trendType).accuracy) + (blend) * c.accuracy;
    const total = acc.total + c.total;
    return { accuracy: finalAcc, total: Math.max(total, 1) };
  }

  /** gate 乘數 ×[0.80, 1.05]——直接乘落 effectiveConfidence */
  getTrustMultiplier(symbol: string, trendType: string): number {
    const { accuracy, total } = this.getBlendedAccuracy(symbol, trendType);
    return accuracyToMultiplier(accuracy, total);
  }

  /** 注入 Meta-Agent 嘅 block(較準 + 即時 + 平倉 + 錯判教訓) */
  getDirectionTrustBlock(symbol: string, trendType: string): string {
    const acc = this.getAccurateAccuracy(trendType);
    const b = this.getDirectionAccuracy(symbol, trendType);
    const c = this.getOutcomeAccuracy(symbol, trendType);
    const mult = this.getTrustMultiplier(symbol, trendType);
    const lines: string[] = [];
    if (acc.total > 0) {
      lines.push(`  較準預測(${Math.round(acc.windowSec / 60)}m 窗口): ${(acc.accuracy * 100).toFixed(0)}% 正確(${acc.total} 次)`);
    }
    if (b.total > 0) {
      lines.push(`  即時回饋: ${(b.accuracy * 100).toFixed(0)}% 正確(${b.total} 次)`);
    }
    if (c.total > 0) {
      lines.push(`  平倉結果: ${(c.accuracy * 100).toFixed(0)}% 賺(${c.total} 筆)`);
    }
    // 錯判教訓:錯咗幾多次——提醒 LLM 唔好重複
    if (acc.total > 0) {
      const wrong = acc.total - Math.round(acc.accuracy * acc.total);
      if (wrong > 0) lines.push(`  錯判教訓:你對呢類判斷錯咗 ${wrong} 次——方向與價格走勢一致先好堅持`);
    }
    if (lines.length === 0) return '';
    return `=== LLM DIRECTION TRUST (${symbol} × ${trendType}) ===\n${lines.join('\n')}\n(準確率高 → 信心 ×${mult.toFixed(2)}——你對呢類判斷嘅歷史表現)`;
  }

  private fallbackCounter(map: Record<string, Counter>, trendType: string): Counter {
    const prefix = `|${trendType}`;
    let correct = 0, total = 0;
    for (const [k, c] of Object.entries(map)) {
      if (k.endsWith(prefix)) {
        correct += c['correct'];
        total += c['total'];
      }
    }
    return { correct, total };
  }

  isBackfillDone(): boolean {
    return this.state.backfillDone === true;
  }

  markBackfillDone(): void {
    this.state.backfillDone = true;
  }

  getStats(): { pending: number; directionKeys: number; outcomeKeys: number; outcomeTrades: number } {
    return {
      pending: Object.keys(this.state.pending).length,
      directionKeys: Object.keys(this.state.direction).length,
      outcomeKeys: Object.keys(this.state.outcome).length,
      outcomeTrades: this.state.outcomeTradeIds.length,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────

  save(): void {
    try {
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.state }), 'utf-8');
    } catch (err) {
      log.warn(`[dir-verifier] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as DirectionVerifierState;
      const clean = emptyState();
      if (raw && typeof raw === 'object') {
        clean.backfillDone = (raw as { backfillDone?: unknown }).backfillDone === true;
        const sanitizeCounter = (v: unknown): Counter => {
          const o = (v ?? {}) as Record<string, unknown>;
          const correct = Number.isFinite(o['correct']) ? Math.max(0, o['correct'] as number) : 0;
          const total = Number.isFinite(o['total']) ? Math.max(0, o['total'] as number) : 0;
          return { correct, total };
        };
        if (raw.pending && typeof raw.pending === 'object') {
          for (const [id, j] of Object.entries(raw.pending)) {
            if (UNSAFE_KEYS.has(id)) continue;
            if (j && typeof j === 'object') {
              const p = j as Record<string, unknown>;
              if (typeof p['symbol'] === 'string' && typeof p['trendType'] === 'string') {
                const pTs = Number.isFinite(p['ts']) ? (p['ts'] as number) : Date.now();
                clean.pending[id] = {
                  symbol: (p['symbol'] as string).slice(0, 24),
                  direction: p['direction'] === 'sell' ? 'sell' : 'buy',
                  trendType: (p['trendType'] as string).slice(0, 32),
                  cycle: Number.isFinite(p['cycle']) ? Math.max(0, p['cycle'] as number) : 0,
                  ts: pTs,
                  price: Number.isFinite(p['price']) && (p['price'] as number) > 0 ? (p['price'] as number) : undefined,
                  quickVerified: p['quickVerified'] === true,
                  scheduledVerifyAt: Number.isFinite(p['scheduledVerifyAt']) ? (p['scheduledVerifyAt'] as number) : pTs + DEFAULT_VERIFY_WINDOW,
                };
              }
            }
          }
        }
        if (raw.direction && typeof raw.direction === 'object') {
          for (const [k, v] of Object.entries(raw.direction)) {
            if (UNSAFE_KEYS.has(k)) continue;
            clean.direction[k] = sanitizeCounter(v);
          }
        }
        if (raw.outcome && typeof raw.outcome === 'object') {
          for (const [k, v] of Object.entries(raw.outcome)) {
            if (UNSAFE_KEYS.has(k)) continue;
            clean.outcome[k] = sanitizeCounter(v);
          }
        }
        if (Array.isArray(raw.outcomeTradeIds)) {
          clean.outcomeTradeIds = raw.outcomeTradeIds
            .filter((x): x is string => typeof x === 'string')
            .slice(-15000);
        }
        if (raw.windowStats && typeof raw.windowStats === 'object') {
          for (const [k, v] of Object.entries(raw.windowStats)) {
            if (UNSAFE_KEYS.has(k)) continue;
            clean.windowStats[k] = sanitizeCounter(v);
          }
        }
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[dir-verifier] load failed (fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.state = emptyState();
    }
  }
}

/** 全系統共享單例 */
export const llmDirectionVerifier = new LLMDirectionVerifier();
