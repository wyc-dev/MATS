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
const DEFAULT_PATH = 'data/evolution/llm-direction-verifier.json';

interface Counter {
  correct: number;
  total: number;
}

export interface DirectionVerifierState {
  /** 未驗證判斷:judgmentId → { symbol, direction, trendType, cycle, ts, price } */
  pending: Record<string, { symbol: string; direction: 'buy' | 'sell'; trendType: string; cycle: number; ts: number; price?: number }>;
  /** B:方向預測結果 per (symbol|trendType) */
  direction: Record<string, Counter>;
  /** C:平倉結果 per (symbol|trendType) */
  outcome: Record<string, Counter>;
  /** 已記錄平倉嘅 tradeIds(防重複) */
  outcomeTradeIds: string[];
}

function emptyState(): DirectionVerifierState {
  return { pending: {}, direction: {}, outcome: {}, outcomeTradeIds: [] };
}

function key(symbol: string, trendType: string): string {
  return `${symbol}|${trendType}`;
}

/** 平滑準確率 → gate 乘數(×[0.80, 1.05],shrink 向中性) */
export function accuracyToMultiplier(accuracy: number, total: number): number {
  if (!Number.isFinite(accuracy) || total <= 0) return 1.0;
  const acc = Math.max(0, Math.min(1, accuracy));
  const shrink = total / (total + SHRINK_K);
  const raw = acc >= 0.65 ? 1.05 : acc >= 0.60 ? 1.0 : acc >= 0.55 ? 0.92 : acc >= 0.50 ? 0.85 : 0.80;
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
    this.state.pending[id] = {
      symbol: symbol.slice(0, 24),
      direction,
      trendType: tt.slice(0, 32),
      cycle: Number.isFinite(cycle) ? Math.floor(cycle) : 0,
      ts: Date.now(),
      price: Number.isFinite(price) && (price as number) > 0 ? price : undefined,
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

  /** 每 cycle:驗證所有 pending 判斷(用 priceFor callback 攞各 symbol 現價) */
  verifyAllPending(priceFor: (symbol: string) => number | null): void {
    const ids = Object.keys(this.state.pending);
    for (const id of ids) {
      const j = this.state.pending[id];
      if (!j) continue;
      // 判斷過太耐(> 48h 未驗證)→ 棄置(價格比較已無意義)
      if (Date.now() - (j.ts ?? Date.now()) > 48 * 3600 * 1000) {
        delete this.state.pending[id];
        continue;
      }
      let price: number | null = null;
      try { price = priceFor(j.symbol); } catch { /* non-fatal */ }
      this.verifyDirection(id, price);
    }
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

  /** 合併 B+C 嘅最終準確率:acc = (1-β)×B + β×C(C 有樣本時) */
  getBlendedAccuracy(symbol: string, trendType: string): { accuracy: number; total: number } {
    const b = this.getDirectionAccuracy(symbol, trendType);
    const c = this.getOutcomeAccuracy(symbol, trendType);
    const hasC = c.total >= PRIMARY_MIN_SAMPLES || c.source === 'fallback';
    const blend = hasC ? OUTCOME_BLEND : 0;
    const acc = (1 - blend) * b.accuracy + (blend) * c.accuracy;
    const total = b.total + c.total;
    return { accuracy: acc, total: Math.max(b.total, 1) };
  }

  /** gate 乘數 ×[0.80, 1.05]——直接乘落 effectiveConfidence */
  getTrustMultiplier(symbol: string, trendType: string): number {
    const { accuracy, total } = this.getBlendedAccuracy(symbol, trendType);
    return accuracyToMultiplier(accuracy, total);
  }

  /** 注入 Meta-Agent 嘅 block */
  getDirectionTrustBlock(symbol: string, trendType: string): string {
    const b = this.getDirectionAccuracy(symbol, trendType);
    const c = this.getOutcomeAccuracy(symbol, trendType);
    const mult = this.getTrustMultiplier(symbol, trendType);
    const lines: string[] = [];
    if (b.total > 0) {
      lines.push(`  方向預測(${b.source}): ${(b.accuracy * 100).toFixed(0)}% 正確(${b.total} 次)`);
    }
    if (c.total > 0) {
      lines.push(`  平倉結果(${c.source}): ${(c.accuracy * 100).toFixed(0)}% 賺(${c.total} 筆)`);
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
        const sanitizeCounter = (v: unknown): Counter => {
          const o = (v ?? {}) as Record<string, unknown>;
          const correct = Number.isFinite(o['correct']) ? Math.max(0, o['correct'] as number) : 0;
          const total = Number.isFinite(o['total']) ? Math.max(0, o['total'] as number) : 0;
          return { correct, total };
        };
        if (raw.pending && typeof raw.pending === 'object') {
          for (const [id, j] of Object.entries(raw.pending)) {
            if (j && typeof j === 'object') {
              const p = j as Record<string, unknown>;
              if (typeof p['symbol'] === 'string' && typeof p['trendType'] === 'string') {
                clean.pending[id] = {
                  symbol: (p['symbol'] as string).slice(0, 24),
                  direction: p['direction'] === 'sell' ? 'sell' : 'buy',
                  trendType: (p['trendType'] as string).slice(0, 32),
                  cycle: Number.isFinite(p['cycle']) ? Math.max(0, p['cycle'] as number) : 0,
                  ts: Number.isFinite(p['ts']) ? (p['ts'] as number) : Date.now(),
                  price: Number.isFinite(p['price']) && (p['price'] as number) > 0 ? (p['price'] as number) : undefined,
                };
              }
            }
          }
        }
        if (raw.direction && typeof raw.direction === 'object') {
          for (const [k, v] of Object.entries(raw.direction)) clean.direction[k] = sanitizeCounter(v);
        }
        if (raw.outcome && typeof raw.outcome === 'object') {
          for (const [k, v] of Object.entries(raw.outcome)) clean.outcome[k] = sanitizeCounter(v);
        }
        if (Array.isArray(raw.outcomeTradeIds)) {
          clean.outcomeTradeIds = raw.outcomeTradeIds
            .filter((x): x is string => typeof x === 'string')
            .slice(-15000);
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
