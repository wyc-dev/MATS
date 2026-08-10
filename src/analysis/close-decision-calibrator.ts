// ─── Close-Decision Calibrator (v2.0.866) — 平倉判斷校準(Phase A) ────
//
// 主神問題:「連續 4 次 BUY BNB over-trade 蝕手續費」——根因:
// consensus close 太快(1.5 分鐘 close 方向正確嘅倉——「見好即收」心理)。
//
// 核心邏輯(反事實代理):close 唔影響市場——
// 「close 後價格走勢」=「如果冇 close、繼續持有,會發生嘅事」。
//   close 後價格繼續原方向 > 0.5%  = 過早 close(錯失利潤)
//   close 後價格反轉             = 啱 close(避開回吐)
//
// 校準範圍(污染防護——Google Tech Lead):
//   ✅ consensus / thesis_invalidation close(自主判斷——校準對象)
//   ❌ SL hit(風險底——永遠唔可以教「唔好止蝕」——主神裁決 SL 正確)
//   ❌ PAEL exit_price_lock(已有 backtest +42% 驗證)
//   ❌ manual / reconciliation / exchange 跟隨(非自主判斷)
//
// 「唔會製造死揸」保證(Phase A 只記錄+驗證+統計,唔 apply gate multiplier):
//   · Phase A 唔影響任何操作——只建立數據
//   · 情境分層(symbol|盈利|趨勢):「虧損 + 趨勢已破」close 過早率低
//     → 唔會被抑制——趨勢反轉照 close
//   · SL / thesis invalidation 完全唔掂——永遠自動平倉
//
// Phase A 輸出:per-context 過早率統計(Phase B 先注入 Meta-Agent + gate)

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'close-calib' });

// ─── Config ────────────────────────────────────────────────────────────

const MIN_SAMPLES = 20;              // per context 最少樣本
const PREMATURE_LIGHT_PCT = 0.005;   // 輕微過早(升/跌 > 0.5%)
const PREMATURE_HIGH_PCT = 0.010;    // 明顯過早(升/跌 > 1%)
const PREMATURE_LIGHT_WEIGHT = 0.5;  // 輕微過早權重
const PREMATURE_HIGH_WEIGHT = 1.0;   // 明顯過早權重
const VERIFY_WINDOWS = [5 * 60, 15 * 60, 30 * 60, 60 * 60];  // 窗口候選
const DEFAULT_VERIFY_WINDOW = 30 * 60;  // 短炒 default 30m
const STALE_MS = 48 * 3600 * 1000;    // pending 超時棄置
const MAX_PENDING = 5000;
const DEFAULT_PATH = 'data/evolution/close-decision-calibration.json';

const CLOSE_REASONS_TO_CALIBRATE = new Set(['consensus', 'thesis_invalidation', 'exit_price_lock']);

interface Counter {
  premature: number;  // weighted
  correct: number;
}

export interface CloseRecord {
  closeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  closePrice: number;
  pnlPct: number;
  wasProfitable: boolean;
  closeReason: string;
  trendAtClose: string;
  verifyWindowSec: number;
  ts: number;
  /** v2.0.866-fix(主神 edge case——路徑感知):
   *  close 後極端價追蹤(初始 = closePrice)——MFE/MAE 淨值用
   *  close 後跌 15min 再升返——單點驗證 miss「中間錯失」——極端捕捉 */
  minPriceSinceClose: number;
  maxPriceSinceClose: number;
}

export interface PendingCloseDecision {
  symbol: string;
  triggeredAtCycle: number;
  prematureRate: number;
}

export interface CloseCalibrationState {
  pending: Record<string, CloseRecord>;
  stats: Record<string, Counter>;
  windowStats: Record<string, Counter>;
  backfillDone: boolean;
  /** v2.0.866 Phase B:二次確認 hold gate——過早率高情境嘅 close 決定 hold 一個 cycle */
  pendingCloses: Record<string, PendingCloseDecision>;
}

function emptyState(): CloseCalibrationState {
  return { pending: {}, stats: {}, windowStats: {}, backfillDone: false, pendingCloses: {} };
}

function contextKey(symbol: string, wasProfitable: boolean, trend: string): string {
  return `${symbol}|${wasProfitable ? 'win' : 'loss'}|${trend}`;
}

function windowKey(trend: string, windowIdx: number): string {
  return `${trend}|w${windowIdx}`;
}

// ─── Main ──────────────────────────────────────────────────────────────

export class CloseDecisionCalibrator {
  private state: CloseCalibrationState;
  private path: string;

  constructor(path = DEFAULT_PATH) {
    this.state = emptyState();
    this.path = path;
  }

  // ── 記錄(close 時——只 consensus/thesis_invalidation)────────────────

  /** 記錄一次自主 close。SL/PAEL/manual/reconciliation 由 caller 過濾 */
  recordClose(input: {
    symbol: string;
    side: 'buy' | 'sell';
    closePrice: number;
    pnlPct: number;
    closeReason: string;
    trendAtClose: string;
  }): string | null {
    if (!input.symbol || (input.side !== 'buy' && input.side !== 'sell')) return null;
    if (!Number.isFinite(input.closePrice) || input.closePrice <= 0) return null;
    if (!CLOSE_REASONS_TO_CALIBRATE.has(input.closeReason)) return null; // 污染防護
    const closeId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const trend = typeof input.trendAtClose === 'string' && input.trendAtClose ? input.trendAtClose : 'unknown';
    const pnlPct = Number.isFinite(input.pnlPct) ? input.pnlPct : 0;
    this.state.pending[closeId] = {
      closeId,
      symbol: input.symbol.slice(0, 24),
      side: input.side,
      closePrice: input.closePrice,
      pnlPct,
      wasProfitable: pnlPct > 0,
      closeReason: input.closeReason,
      trendAtClose: trend.slice(0, 16),
      verifyWindowSec: this.getBestVerifyWindow(trend),
      ts: Date.now(),
      minPriceSinceClose: input.closePrice, // 極端初始 = closePrice
      maxPriceSinceClose: input.closePrice,
    };
    this.capPending();
    this.save(); // v2.0.868-fix1:persist——之前 save 從未被 call——restart 後過早率數據清空
    return closeId;
  }

  private capPending(): void {
    const keys = Object.keys(this.state.pending);
    if (keys.length > MAX_PENDING) {
      // 刪最舊
      const sorted = keys.sort((a, b) => this.state.pending[a]!.ts - this.state.pending[b]!.ts);
      for (let i = 0; i < sorted.length - MAX_PENDING; i++) {
        delete this.state.pending[sorted[i]!];
      }
    }
  }

  // ── 驗證(每 cycle 巡邏——延遲驗證)─────────────────────────────────

  /**
   * 驗證所有到期 pending(close 後 verifyWindowSec):
   *   side-aware:buy 倉 close 後價格繼續升 > 0.5% → 過早;反轉 → 啱 close
   *   分級:>1% 明顯過早(weight 1.0)、>0.5% 輕微(weight 0.5)、0~0.5% neutral 唔計
   *   priceFor:strict price(同 Direction Verifier——唔用 latest fallback)
   */
  verifyPending(priceFor: (symbol: string) => number | null): void {
    const now = Date.now();
    const ids = Object.keys(this.state.pending);
    for (const id of ids) {
      const rec = this.state.pending[id];
      if (!rec) continue;
      if (now - rec.ts > STALE_MS + 2 * VERIFY_WINDOWS[VERIFY_WINDOWS.length - 1]! * 1000) {
        delete this.state.pending[id]; // 超時棄置
        continue;
      }
      // v2.0.866-fix:路徑感知——每 cycle 更新 close 後極端(未到期都更新)
      let price: number | null = null;
      try { price = priceFor(rec.symbol); } catch { /* non-fatal */ }
      if (price !== null && Number.isFinite(price) && price > 0) {
        rec.minPriceSinceClose = Math.min(rec.minPriceSinceClose, price);
        rec.maxPriceSinceClose = Math.max(rec.maxPriceSinceClose, price);
      }
      // v2.0.866-attack (V13):verifyWindowSec 係「秒」——要 ×1000 先係毫秒
      // (舊:rec.ts + 1800(秒) → 1.8 秒後即到期——根本冇延遲驗證——pending 全部即時 delete)
      if (now < rec.ts + rec.verifyWindowSec * 1000) continue; // 未到期——留低(極端已更新)
      // v2.0.866-attack (V3):closePrice<=0(毒 state)→ division by zero → Infinity
      // → premature_high 污染統計——delete 唔計(唔好污染)
      if (!Number.isFinite(rec.closePrice) || rec.closePrice <= 0) {
        delete this.state.pending[id];
        continue;
      }
      // v2.0.866-fix(主神 edge case):MFE/MAE 淨值判據(路徑感知——單點驗證 miss
      // 「close 後跌 15min 再升返」——極端捕捉「錯失 vs 避開」淨效果):
      //   SELL:MFE(錯失利潤)= (close−min)/close;MAE(避開虧損)= (max−close)/close
      //   BUY: MFE = (max−close)/close;MAE = (close−min)/close
      //   net = MFE − MAE
      //   net > 1% → premature_high;>0.5% → premature_low;<-0.5% → correct;之間 neutral
      const cp = rec.closePrice;
      let mfe: number, mae: number;
      if (rec.side === 'buy') {
        mfe = (rec.maxPriceSinceClose - cp) / cp;
        mae = (cp - rec.minPriceSinceClose) / cp;
      } else {
        mfe = (cp - rec.minPriceSinceClose) / cp;
        mae = (rec.maxPriceSinceClose - cp) / cp;
      }
      const net = mfe - mae;
      let verdict: 'premature_high' | 'premature_low' | 'correct' | 'neutral';
      // v2.0.866-attack:邊界用 >=/<=——1% 整數應該算「明顯過早」(同 getCloseMultiplier 一致)
      verdict = net >= PREMATURE_HIGH_PCT ? 'premature_high' : net >= PREMATURE_LIGHT_PCT ? 'premature_low' : net <= -PREMATURE_LIGHT_PCT ? 'correct' : 'neutral';
      const ctx = contextKey(rec.symbol, rec.wasProfitable, rec.trendAtClose);
      const c = this.state.stats[ctx] ?? { premature: 0, correct: 0 };
      if (verdict === 'premature_high') c.premature += PREMATURE_HIGH_WEIGHT;
      else if (verdict === 'premature_low') c.premature += PREMATURE_LIGHT_WEIGHT;
      else if (verdict === 'correct') c.correct += 1;
      // neutral 唔計(噪音防護)
      this.state.stats[ctx] = c;
      // 窗口統計(校準用)
      const wi = this.windowIndexFor(rec.verifyWindowSec);
      const wKey = windowKey(rec.trendAtClose, wi);
      const wc = this.state.windowStats[wKey] ?? { premature: 0, correct: 0 };
      if (verdict === 'premature_high' || verdict === 'premature_low') wc.premature += verdict === 'premature_high' ? 1 : 0.5;
      else if (verdict === 'correct') wc.correct += 1;
      this.state.windowStats[wKey] = wc;
      delete this.state.pending[id]; // idempotent——驗證一次
    }
    this.save(); // v2.0.868-fix1:驗證結果持久化(閉環數據累積)
  }

  /** 某 context 嘅過早率(weighted) */
  getPrematureRate(symbol: string, wasProfitable: boolean, trend: string): { rate: number; total: number } {
    const c = this.state.stats[contextKey(symbol, wasProfitable, trend)];
    if (!c || c.premature + c.correct < MIN_SAMPLES) return { rate: 0.5, total: 0 }; // 冷啟動中性
    return { rate: c.premature / (c.premature + c.correct), total: c.premature + c.correct };
  }

  /**
   * v2.0.868-fix2:PAEL 鎖利 threshold 加成——過早率閉環去 exit-price-lock。
   *   premature rate > 0.4 → multiplier > 1(鎖利門檻提高——等 price 行得更遠先鎖)
   *   rate 0.5 → ×1.10;0.6 → ×1.20;0.8 → ×1.40;cap ×1.5
   *   冷啟動(樣本 < MIN_SAMPLES)→ ×1.0(唔影響現有行為)
   */
  getLockThresholdMultiplier(symbol: string, trend: string): number {
    const { rate, total } = this.getPrematureRate(symbol, true, trend);
    if (total < MIN_SAMPLES) return 1.0;
    if (rate <= 0.4) return 1.0;
    return Math.min(1.5, 1 + (rate - 0.4) * 1.0);
  }

  /** Phase B 用:close 傾向乘數(>75% 過早 → ×0.85;>60% → ×0.9;否則 1.0) */
  getCloseMultiplier(symbol: string, wasProfitable: boolean, trend: string): number {
    const { rate, total } = this.getPrematureRate(symbol, wasProfitable, trend);
    if (total < MIN_SAMPLES) return 1.0; // 冷啟動——唔影響
    if (rate >= 0.75) return 0.85;
    if (rate >= 0.60) return 0.92;
    return 1.0;
  }

  /** 注入 Meta-Agent 嘅 block(Phase B 用) */
  getCalibrationBlock(symbol: string, wasProfitable: boolean, trend: string): string {
    const { rate, total } = this.getPrematureRate(symbol, wasProfitable, trend);
    if (total < MIN_SAMPLES) return '';
    const mult = this.getCloseMultiplier(symbol, wasProfitable, trend);
    const dir = symbol + (wasProfitable ? ' × 盈利' : ' × 虧損') + ' × ' + trend;
    const advice = rate > 0.6
      ? `——呢類情況趨勢未完應揸住(close 需要明確理由:趨勢反轉/catalyst 完成/風險;『見好即收』唔係理由)`
      : `——呢類 close 判斷正常`;
    return `=== CLOSE-DECISION CALIBRATION (${dir}) ===\n  過早 close 率: ${(rate * 100).toFixed(0)}%(${total} 次)${advice}\n  (close 傾向 ×${mult.toFixed(2)}——只校準自主 close,SL/PAEL 永遠唔掂)`;
  }

  // ── 窗口校準 ─────────────────────────────────────────────────────────

  getBestVerifyWindow(trend: string): number {
    const tt = typeof trend === 'string' && trend ? trend : 'unknown';
    let best = DEFAULT_VERIFY_WINDOW;
    let bestScore = -1;
    for (let wi = 0; wi < VERIFY_WINDOWS.length; wi++) {
      const c = this.state.windowStats[windowKey(tt, wi)];
      if (!c || c.premature + c.correct < 10) continue;
      // 揀「過早率最高」嘅窗口——最敏感捕捉過早 close
      const rate = c.premature / (c.premature + c.correct);
      const score = rate - (10 / (10 + c.premature + c.correct)) * 0.5;
      if (score > bestScore) { bestScore = score; best = VERIFY_WINDOWS[wi]!; }
    }
    return best;
  }

  private windowIndexFor(sec: number): number {
    let best = 0;
    for (let wi = 0; wi < VERIFY_WINDOWS.length; wi++) {
      if (Math.abs(sec - VERIFY_WINDOWS[wi]!) < Math.abs(sec - VERIFY_WINDOWS[best]!)) best = wi;
    }
    return best;
  }

  // ── Phase B:二次確認 hold gate(真係可以 hold 到平倉決定)───────────

  /**
   * 應唔應該 hold 呢次 consensus close?
   *   ✅ hold:過早率高(≥60%)+ 盈利 + 自主 consensus close
   *   ❌ 唔 hold:SL/thesis/PAEL(永遠立即)、虧損 close(止血)、冷啟動
   *  -> 「有腦咁 hold」:只擋「數據證明過早率高嘅見好即收」——唔會死揸
   */
  shouldHoldClose(symbol: string, wasProfitable: boolean, trend: string, closeReason: string): boolean {
    // v2.0.866-phase-b-attack2 (V26):thesis_invalidation = Skeptics 判斷
    // 「thesis 失效」(趨勢反轉/結構破壞證據)→ 同 SL 一樣係「市場/判斷確認嘅退出」
    // → hold 佢 = 死揸!SL/thesis/manual 永遠唔 hold。
    // v2.0.868-fix3:PAEL(exit_price_lock)喺過早率 ≥70% 都 hold——鎖利門檻高。
    //   背景:PAEL 鎖完 thesis 未失效 → 下 cycle 又開 → re-open 循環 → fee 侵蝕。
    //   過早率 ≥70% = 強證據「鎖完 price 繼續行」→ hold 一 cycle 再確認
    //   (3 cycle 超時兜底執行——唔會變成死揸;pending-close 再確認機制照常)
    if (!wasProfitable) return false; // 虧損 close 唔 hold——止血優先
    const { rate, total } = this.getPrematureRate(symbol, wasProfitable, trend);
    if (total < MIN_SAMPLES) return false; // 冷啟動唔 hold
    if (closeReason === 'consensus') return rate >= 0.60;
    if (closeReason === 'exit_price_lock') return rate >= 0.70;
    return false;
  }

  /** 標記 pending-close(唔立即執行——下 cycle 再確認) */
  registerPendingClose(symbol: string, cycle: number, prematureRate: number): void {
    if (!symbol) return;
    this.state.pendingCloses[symbol.slice(0, 24)] = {
      symbol: symbol.slice(0, 24),
      triggeredAtCycle: Number.isFinite(cycle) ? Math.floor(cycle) : 0,
      prematureRate: Number.isFinite(prematureRate) ? prematureRate : 0.6,
    };
  }

  /** 每 cycle 處理 pending-close:
   *   - confirmedSymbols(本 cycle 再次 close 決定)→ 確認執行(唔再 hold)
   *   - 超時(3 cycle 冇再 close 決定)→ 超時執行(兜底——唔會永遠 hold)
   *   - 其餘(本 cycle 冇再 close = HOLD)→ 取消(揸住——見好即收被擋)
   *   返回:應該執行 close 嘅 symbol list */
  processPendingCloses(cycle: number, confirmedSymbols: Set<string>): string[] {
    const toExecute: string[] = [];
    for (const [sym, pc] of Object.entries(this.state.pendingCloses)) {
      if (confirmedSymbols.has(sym)) {
        toExecute.push(sym); // 再次 close 決定 = 確認 → 執行
        delete this.state.pendingCloses[sym];
      } else if (cycle - pc.triggeredAtCycle >= 3) {
        toExecute.push(sym); // 3 cycle 冇再 close(技術異常)→ 超時兜底執行
        delete this.state.pendingCloses[sym];
      } else {
        delete this.state.pendingCloses[sym]; // 本 cycle 冇再 close = HOLD → 取消(揸住)
      }
    }
    return toExecute;
  }

  isPendingClose(symbol: string): boolean {
    return Object.hasOwn(this.state.pendingCloses, symbol.slice(0, 24));
  }

  /** 確認執行後清理 pending(防殘留——v2.0.866-phase-b-attack V8) */
  removePendingClose(symbol: string): void {
    delete this.state.pendingCloses[symbol.slice(0, 24)];
  }

  getStats(): { pending: number; contexts: number; pendingCloses: number } {
    return {
      pending: Object.keys(this.state.pending).length,
      contexts: Object.keys(this.state.stats).length,
      pendingCloses: Object.keys(this.state.pendingCloses).length,
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────

  save(): void {
    try {
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.state }), 'utf-8');
    } catch (err) {
      log.warn(`[close-calib] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as CloseCalibrationState;
      const clean = emptyState();
      if (raw && typeof raw === 'object') {
        clean.backfillDone = (raw as { backfillDone?: unknown }).backfillDone === true;
        const sanitizeCounter = (v: unknown): Counter => {
          const o = (v ?? {}) as Record<string, unknown>;
          return {
            premature: Number.isFinite(o['premature']) ? Math.max(0, o['premature'] as number) : 0,
            correct: Number.isFinite(o['correct']) ? Math.max(0, o['correct'] as number) : 0,
          };
        };
        if (raw.pending && typeof raw.pending === 'object') {
          for (const [id, r] of Object.entries(raw.pending)) {
            if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
            const p = (r ?? {}) as unknown as Record<string, unknown>;
            if (typeof p['symbol'] !== 'string' || typeof p['closeId'] !== 'string') continue;
            const closePrice = Number.isFinite(p['closePrice']) && (p['closePrice'] as number) > 0 ? (p['closePrice'] as number) : 0;
            if (closePrice <= 0) continue; // v2.0.866-attack (V3):毒 closePrice → skip 唔入 pending
            const ts = Number.isFinite(p['ts']) ? (p['ts'] as number) : Date.now();
            clean.pending[id] = {
              closeId: p['closeId'] as string,
              symbol: (p['symbol'] as string).slice(0, 24),
              side: p['side'] === 'sell' ? 'sell' : 'buy',
              closePrice,
              pnlPct: Number.isFinite(p['pnlPct']) ? (p['pnlPct'] as number) : 0,
              wasProfitable: p['wasProfitable'] === true,
              closeReason: typeof p['closeReason'] === 'string' ? p['closeReason'] : 'consensus',
              trendAtClose: typeof p['trendAtClose'] === 'string' ? p['trendAtClose'] : 'unknown',
              verifyWindowSec: Number.isFinite(p['verifyWindowSec']) ? (p['verifyWindowSec'] as number) : DEFAULT_VERIFY_WINDOW,
              ts,
              minPriceSinceClose: Number.isFinite(p['minPriceSinceClose']) && (p['minPriceSinceClose'] as number) > 0 ? (p['minPriceSinceClose'] as number) : closePrice,
              maxPriceSinceClose: Number.isFinite(p['maxPriceSinceClose']) && (p['maxPriceSinceClose'] as number) > 0 ? (p['maxPriceSinceClose'] as number) : closePrice,
            };
          }
        }
        if (raw.stats && typeof raw.stats === 'object') {
          for (const [k, v] of Object.entries(raw.stats)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            clean.stats[k] = sanitizeCounter(v);
          }
        }
        if (raw.windowStats && typeof raw.windowStats === 'object') {
          for (const [k, v] of Object.entries(raw.windowStats)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            clean.windowStats[k] = sanitizeCounter(v);
          }
        }
        if (raw.pendingCloses && typeof raw.pendingCloses === 'object') {
          for (const [sym, pc] of Object.entries(raw.pendingCloses)) {
            if (sym === '__proto__' || sym === 'constructor' || sym === 'prototype') continue;
            const p = (pc ?? {}) as unknown as Record<string, unknown>;
            if (typeof p['symbol'] !== 'string') continue;
            clean.pendingCloses[sym.slice(0, 24)] = {
              symbol: (p['symbol'] as string).slice(0, 24),
              triggeredAtCycle: Number.isFinite(p['triggeredAtCycle']) ? Math.max(0, p['triggeredAtCycle'] as number) : 0,
              prematureRate: Number.isFinite(p['prematureRate']) ? Math.max(0, Math.min(1, p['prematureRate'] as number)) : 0.6,
            };
          }
        }
      }
      this.state = clean;
    } catch (err) {
      log.warn(`[close-calib] load failed (fresh): ${err instanceof Error ? err.message : String(err)}`);
      this.state = emptyState();
    }
  }
}

/** 全系統共享單例 */
export const closeDecisionCalibrator = new CloseDecisionCalibrator();
