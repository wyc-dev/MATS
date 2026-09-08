// risk/calibration-watchdog.ts — model-confidence calibration watchdog (production).
//
// 初衷 (OpenAI research-acceleration → confidence-in-monitoring; audit C「預測校準」補完):
// 預測信心 P(win) 同實際結果長期偏離 = 模型信心唔再可信嘅早期警號。
// TailWatchdog 睇「尾部退化」;呢個睇「校準退化」——姊妹監控。
//
// 方向(量化, loss 不對稱): 只對 OVER-confidence(OLR 報高、實際 WR 低)觸發降注——
// over-confidence = 過度加注風險;UNDER-confidence(OLR 報低、實際高)係保守,唔係風險,
// 只記錄做「校準報告」(資訊: OLR 系統性低估 = 過度壓縮機會,供後續校準 counterfactual)。
//
// 機制: per-symbol rolling window(最近 N 筆 resolved)——bias = avgOLR − actualWR;
// bias > overConfThreshold 且 n≥minSamples → 降注(×0.5);bias 回落 < releaseThreshold → 回復。

function parseBoolEnv(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  return v.trim().toLowerCase() === 'true';
}

export const calibrationConfig = {
  enabled: parseBoolEnv(process.env['CALIBRATION_WATCHDOG_ENABLED'], true),
  /** 評估窗(最近 N 筆 resolved per symbol) */
  window: Math.max(5, Math.min(100, Number(process.env['CALIBRATION_WINDOW']) || 20)),
  /** 最少樣本先算校準(太少唔可信) */
  minSamples: Math.max(5, Math.min(50, Number(process.env['CALIBRATION_MIN_SAMPLES']) || 10)),
  /** over-confidence 觸發閾值: avgOLR − actualWR > 此值(pp) → 降注 */
  overConfPct: Number(process.env['CALIBRATION_OVERCONF_PCT']) >= 0 ? Number(process.env['CALIBRATION_OVERCONF_PCT']) / 100 : 0.15,
  /** 回復閾值: bias 回落 < 此值 → 回復正常 */
  releasePct: Number(process.env['CALIBRATION_RELEASE_PCT']) >= 0 ? Number(process.env['CALIBRATION_RELEASE_PCT']) / 100 : 0.10,
  /** under-confidence 報告閾值(只記錄,唔郁決策) */
  underConfReportPct: Number(process.env['CALIBRATION_UNDER_REPORT_PCT']) >= 0 ? Number(process.env['CALIBRATION_UNDER_REPORT_PCT']) / 100 : 0.15,
} as const;

/** 純函數: 由一筆 (predictedPWin, actualWin?) 更新 rolling 校準(單一 source of truth,可測) */
export function advanceCalibration(
  history: Array<[number, number]>, // [predictedPWin, actual 1|0]
  predictedPWin: number,
  actualWin: boolean,
): Array<[number, number]> {
  if (!Number.isFinite(predictedPWin)) return history; // 垃圾預測唔入
  return [...history, [predictedPWin, actualWin ? 1 : 0] as [number, number]].slice(-calibrationConfig.window);
}

/** 由 history 計校準狀態(純函數) */
export function calibrationOf(
  symbol: string,
  history: Array<[number, number]>,
): {
  symbol: string;
  n: number;
  avgOLRPct: number;
  actualWRPct: number;
  biasPct: number;          // + = over-confidence, − = under-confidence
  state: 'normal' | 'over-confident';
  sizeMultiplier: number;   // over-conf → 0.5
  tradeable: boolean;
} {
  const valid = history.filter(([p]) => Number.isFinite(p));
  const n = valid.length;
  if (n < 1) return { symbol, n: 0, avgOLRPct: 0, actualWRPct: 0, biasPct: 0, state: 'normal', sizeMultiplier: 1, tradeable: true };
  const avgOLR = valid.reduce((s, [p]) => s + Math.min(Math.max(p, 0), 1), 0) / n; // clamp 到 [0,1]
  const wins = valid.filter(([p, w]) => w === 1).length;
  const wr = wins / n;
  const bias = avgOLR - wr;
  const over = n >= calibrationConfig.minSamples && bias > calibrationConfig.overConfPct;
  return {
    symbol,
    n,
    avgOLRPct: avgOLR * 100,
    actualWRPct: wr * 100,
    biasPct: bias * 100,
    state: over ? 'over-confident' : 'normal',
    sizeMultiplier: over ? 0.5 : 1,
    tradeable: true, // over-confident 降注,唔 block(信心過高但唔係立即危險)
  };
}

/** 有遲滯嘅 class 版: 觸發後要 bias 回落 < releaseThreshold 先回復(防抖) */
export class CalibrationWatchdog {
  private histories = new Map<string, Array<[number, number]>>();
  private flagged = new Set<string>();

  /** 每筆 REAL resolved: 餵 predictedPWin(entryOlrPWin)+ actualWin(pnlPct>0) */
  consume(symbol: string, predictedPWin: number, pnlPct: number): ReturnType<typeof calibrationOf> {
    if (!Number.isFinite(predictedPWin) && !Number.isFinite(pnlPct)) return this.getStatus(symbol);
    if (!Number.isFinite(predictedPWin)) return this.getStatus(symbol);
    const h = this.histories.get(symbol) ?? [];
    const next = advanceCalibration(h, predictedPWin, Number.isFinite(pnlPct) ? pnlPct > 0 : false);
    this.histories.set(symbol, next);
    return this.getStatus(symbol, next);
  }

  getStatus(symbol: string, override?: Array<[number, number]>): ReturnType<typeof calibrationOf> {
    const h = override ?? this.histories.get(symbol) ?? [];
    const s = calibrationOf(symbol, h);
    // 遲滯: 已 flagged 嘅 symbol 要 bias 回落 < release 先復位
    if (this.flagged.has(symbol)) {
      const st = calibrationOf(symbol, h);
      if (st.biasPct * 0.01 < calibrationConfig.releasePct && st.n >= calibrationConfig.minSamples) {
        this.flagged.delete(symbol);
        return { ...st, state: 'normal', sizeMultiplier: 1 };
      }
      return { ...st, state: 'over-confident', sizeMultiplier: 0.5 };
    }
    if (s.state === 'over-confident') this.flagged.add(symbol);
    return s;
  }

  sizeMultiplier(symbol: string): number { return this.getStatus(symbol).sizeMultiplier; }

  /** 校準報告(under-confidence info + over-confidence 主動)——供主神/日誌 */
  report(): Array<ReturnType<typeof calibrationOf>> {
    const out: Array<ReturnType<typeof calibrationOf>> = [];
    for (const [sym, h] of this.histories) out.push(calibrationOf(sym, h));
    return out.sort((a, b) => Math.abs(b.biasPct) - Math.abs(a.biasPct));
  }

  /** 清理低活躍 symbol(同 pruneStaleSymbols 對應) */
  pruneInactive(keepSymbols: string[]): void {
    const keep = new Set(keepSymbols);
    for (const sym of [...this.histories.keys()]) if (!keep.has(sym)) { this.histories.delete(sym); this.flagged.delete(sym); }
  }

  save(): string {
    const obj: Record<string, { h: Array<[number, number]>; f: boolean }> = {};
    for (const [sym, h] of this.histories) obj[sym] = { h, f: this.flagged.has(sym) };
    return JSON.stringify(obj);
  }

  load(json: string): void {
    try {
      const data = JSON.parse(json);
      for (const [sym, v] of Object.entries(data as Record<string, any>)) {
        if (typeof sym !== 'string' || !v || typeof v !== 'object') continue;
        const h = Array.isArray(v.h) ? v.h.filter((x: any) => Array.isArray(x) && Number.isFinite(x[0]) && (x[1] === 1 || x[1] === 0)).slice(-calibrationConfig.window) as Array<[number, number]> : [];
        this.histories.set(sym, h);
        if (v.f === true) this.flagged.add(sym);
      }
    } catch { /* corrupt → empty(安全) */ }
  }
}
