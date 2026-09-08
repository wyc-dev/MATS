// risk/tail-watchdog.ts — per-symbol tail-event watchdog (production).
//
// 初衷 (audit C production 版, 2026-09-08): 系統無全局 mean 漂移(328 筆 0 警報),
// 但 4 筆大蝕(SNDK/SKHX/SILVER)係「單 symbol 尾部事件」——「知道何時不可信」
// 必須喺 symbol 層。觸發 = 統計尾部事件(唔係連輸反應),遲滯狀態機(升級快回復慢)。
//
// 時間窗設計(量化): tail 事件帶時間戳——低頻 symbol(SNDK 幾日一單)唔可以用
// 純筆數窗(幾日冇交易 tail 會滑出窗 → 過早回復)。用「最近 T 小時內尾部數」+
// 「回復需最少觀察時長」——高低頻 symbol 一致。
//
// 輸出動作(production 接入, env 可控):
//   normal        → 照常(sizeMultiplier 1)
//   caution       → 新倉 size × 0.5(降注,唔 block)
//   observe-only  → 唔開新倉(僅觀察)
//   recovery-check→ 唔開新倉(等回復證明)
//
// 數據: 只用 REAL resolved pnl(shadow 有固定 SL/TP 分佈,會誤導尾部判斷)。

function parseBoolEnv(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  return v.trim().toLowerCase() === 'true';
}

export type TailState = 'normal' | 'caution' | 'observe-only' | 'recovery-check';

export const tailWatchdogConfig = {
  enabled: parseBoolEnv(process.env['TAIL_WATCHDOG_ENABLED'], true),
  /** 評估窗(recent N resolved trades per symbol) */
  window: Math.max(5, Math.min(100, Number(process.env['TAIL_WATCHDOG_WINDOW']) || 20)),
  /** 尾部事件閾值: margin pnlPct < 此值 計一單尾部(10x 下 -8% margin = 0.8% price 逆向) */
  tailThreshold: Number(process.env['TAIL_WATCHDOG_TAIL_PCT']) >= 0 ? (Number(process.env['TAIL_WATCHDOG_TAIL_PCT']) / 100) : -0.08,
  /** 窗內 ≥ N 個尾部事件 → caution */
  tailEventsToCaution: Math.max(1, Math.min(10, Number(process.env['TAIL_WATCHDOG_TAIL_N']) || 2)),
  /** 單筆嚴重尾部(超正常 SL 範圍, 11% margin)→ 直接 caution(唔使等兩次) */
  severeTailPct: Number(process.env['TAIL_WATCHDOG_SEVERE_PCT']) >= 0 ? (Number(process.env['TAIL_WATCHDOG_SEVERE_PCT']) / 100) : -0.11,
  /** observe-only 後連續 ≥ N 筆「無尾部」→ recovery-check */
  recoveryClean: Math.max(5, Math.min(100, Number(process.env['TAIL_WATCHDOG_RECOVERY_CLEAN']) || 15)),
  /** recovery-check 持續 ≥ N 筆乾淨 → normal */
  recoveryConfirm: Math.max(1, Math.min(50, Number(process.env['TAIL_WATCHDOG_RECOVERY_CONFIRM']) || 3)),
  /** 低頻 symbol 防護: 回復最低觀察時長(ms)——唔單靠筆數(幾日冇交易會過早回復) */
  recoveryMinMs: Math.max(1, Number(process.env['TAIL_WATCHDOG_RECOVERY_MIN_HOURS']) || 48) * 3_600_000,
  /** 時間窗: 最近 T ms 內尾部數(補低頻 symbol 嘅筆數窗失效) */
  tailTimeWindowMs: Math.max(1, Number(process.env['TAIL_WATCHDOG_TAIL_TIME_WINDOW_HOURS']) || 72) * 3_600_000,
} as const;

export interface SymbolWatch {
  history: Array<[number, number]>; // [margin pnlPct, epoch ms](最多 window×2)
  state: TailState;
  tailEventsSinceState: number;
  cleanSinceCaution: number;        // caution/observe 期內連續乾淨筆數
  cleanSinceEpoch: number;          // 最後一個尾部事件嘅 epoch(回復計時基準)
  lastStateEpoch: number;           // 進入現狀態嘅 epoch
}

export interface TailWatchStatus {
  symbol: string;
  state: TailState;
  windowAvgPct: number;
  tailCount: number;
  historyN: number;
  sizeMultiplier: number; // normal=1, caution=0.5, else=0
  tradeable: boolean;     // normal/caution 可開倉(caution 降注); observe/recovery 唔開
}

/** 純函數: 由一筆 pnl + epoch 更新 watch 狀態(單一 source of truth,可測) */
export function advanceWatch(w: SymbolWatch, pnlPct: number, ts: number): SymbolWatch {
  const next: SymbolWatch = {
    history: [...w.history, [pnlPct, ts] as [number, number]].slice(-tailWatchdogConfig.window * 2),
    state: w.state,
    tailEventsSinceState: w.tailEventsSinceState,
    cleanSinceCaution: w.cleanSinceCaution,
    cleanSinceEpoch: w.cleanSinceEpoch,
    lastStateEpoch: w.lastStateEpoch,
  };
  if (next.state !== w.state) next.lastStateEpoch = ts;

  const H = next.history;
  const window = tailWatchdogConfig.window;
  const recent = H.slice(-window);
  const tailCount = recent.filter(([p]) => p < tailWatchdogConfig.tailThreshold).length;
  // 時間窗尾部數(補低頻): 最近 tailTimeWindowMs 內嘅尾部
  const timeTailCount = H.filter(([p, t]) => p < tailWatchdogConfig.tailThreshold && ts - t <= tailWatchdogConfig.tailTimeWindowMs).length;

  const isTail = pnlPct < tailWatchdogConfig.tailThreshold;
  if (isTail) {
    next.tailEventsSinceState += 1;
    next.cleanSinceCaution = 0; // 尾部中斷回復證明
    next.cleanSinceEpoch = ts;
  } else {
    next.cleanSinceCaution += 1;
  }

  switch (w.state) {
    case 'normal':
      // tail 就係信號: 筆數窗 ≥2 / 時間窗 ≥2(低頻) / 單筆嚴重尾部
      if (tailCount >= tailWatchdogConfig.tailEventsToCaution || timeTailCount >= tailWatchdogConfig.tailEventsToCaution || pnlPct < tailWatchdogConfig.severeTailPct) {
        next.state = 'caution';
        next.tailEventsSinceState = tailCount;
      }
      break;
    case 'caution':
      if (isTail) {
        next.state = 'observe-only'; // 持續 → 升級
      } else if (next.cleanSinceCaution >= window && ts - next.cleanSinceEpoch >= tailWatchdogConfig.recoveryMinMs) {
        next.state = 'normal';
        next.tailEventsSinceState = 0;
      }
      break;
    case 'observe-only':
      if (next.cleanSinceCaution >= tailWatchdogConfig.recoveryClean && ts - next.cleanSinceEpoch >= tailWatchdogConfig.recoveryMinMs) {
        next.state = 'recovery-check';
      }
      break;
    case 'recovery-check':
      if (isTail) {
        next.state = 'observe-only'; // 回復失敗 → 跌返
      } else if (next.cleanSinceCaution >= tailWatchdogConfig.recoveryClean + tailWatchdogConfig.recoveryConfirm && ts - next.cleanSinceEpoch >= tailWatchdogConfig.recoveryMinMs * 2) {
        next.state = 'normal';
        next.tailEventsSinceState = 0;
        next.cleanSinceCaution = 0;
      }
      break;
  }
  return next;
}

export function statusOf(symbol: string, w: SymbolWatch): TailWatchStatus {
  const recent = w.history.slice(-tailWatchdogConfig.window);
  const avgWin = recent.length > 0 ? recent.reduce((s, [p]) => s + p, 0) / recent.length : 0;
  const tailCount = recent.filter(([p]) => p < tailWatchdogConfig.tailThreshold).length;
  const sizeMultiplier = w.state === 'normal' ? 1 : w.state === 'caution' ? 0.5 : 0;
  return {
    symbol,
    state: w.state,
    windowAvgPct: avgWin * 100,
    tailCount,
    historyN: w.history.length,
    sizeMultiplier,
    tradeable: w.state === 'normal' || w.state === 'caution',
  };
}

export class TailWatchdog {
  private watches = new Map<string, SymbolWatch>();

  createOrGet(symbol: string): SymbolWatch {
    let w = this.watches.get(symbol);
    if (!w) { w = { history: [], state: 'normal', tailEventsSinceState: 0, cleanSinceCaution: 0, cleanSinceEpoch: 0, lastStateEpoch: 0 }; this.watches.set(symbol, w); }
    return w;
  }

  /** 每筆 REAL resolved pnl 餵入(production: real close 處 call) */
  consumePnl(symbol: string, pnlPct: number, ts = Date.now()): TailWatchStatus {
    if (!tailWatchdogConfig.enabled) return statusOf(symbol, this.createOrGet(symbol));
    const w = this.createOrGet(symbol);
    const next = advanceWatch(w, pnlPct, ts);
    this.watches.set(symbol, next);
    return statusOf(symbol, next);
  }

  getStatus(symbol: string): TailWatchStatus {
    return statusOf(symbol, this.createOrGet(symbol));
  }

  getAll(): Array<{ symbol: string } & Omit<TailWatchStatus, 'symbol'>> {
    const out: Array<{ symbol: string } & Omit<TailWatchStatus, 'symbol'>> = [];
    for (const [sym, w] of this.watches) {
      const s = statusOf(sym, w);
      out.push({ symbol: sym, state: s.state, windowAvgPct: s.windowAvgPct, tailCount: s.tailCount, historyN: s.historyN, sizeMultiplier: s.sizeMultiplier, tradeable: s.tradeable });
    }
    return out;
  }

  sizeMultiplier(symbol: string): number {
    return this.getStatus(symbol).sizeMultiplier;
  }

  tradeable(symbol: string): boolean {
    return this.getStatus(symbol).tradeable;
  }

  /** 持久化(狀態 + 最近歷史,重啟唔 reset) */
  save(): string {
    const obj: Record<string, { history: Array<[number, number]>; state: TailState; t: number; c: number; e: number; s: number }> = {};
    for (const [sym, w] of this.watches) {
      obj[sym] = { history: w.history.slice(-tailWatchdogConfig.window), state: w.state, t: w.tailEventsSinceState, c: w.cleanSinceCaution, e: w.cleanSinceEpoch, s: w.lastStateEpoch };
    }
    return JSON.stringify(obj);
  }

  load(json: string): void {
    try {
      const data = JSON.parse(json);
      for (const [sym, v] of Object.entries(data as Record<string, any>)) {
        if (typeof sym !== 'string' || !v || typeof v !== 'object') continue;
        const state: TailState = ['normal', 'caution', 'observe-only', 'recovery-check'].includes(v.state) ? v.state : 'normal';
        const history = Array.isArray(v.history)
          ? (v.history.filter((x: any) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).slice(-tailWatchdogConfig.window) as Array<[number, number]>)
          : [];
        this.watches.set(sym, {
          history, state,
          tailEventsSinceState: Number.isFinite(v.t) ? v.t : 0,
          cleanSinceCaution: Number.isFinite(v.c) ? v.c : 0,
          cleanSinceEpoch: Number.isFinite(v.e) ? v.e : 0,
          lastStateEpoch: Number.isFinite(v.s) ? v.s : 0,
        });
      }
    } catch { /* corrupt → start empty(安全) */ }
  }
}
