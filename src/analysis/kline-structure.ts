// ─── K-Line Structure Extractor (Phase 1) — v2.0.863 ───────────────────
//
// 純函數:蠟燭陣列 → 結構化圖表摘要(趨勢/形態/突破/成交量)。
// 目的:將「統計 feature 表達唔到嘅蠟燭形態」轉成 Meta-Agent 可讀嘅
// 結構化描述——LLM 世界模型嘅「讀圖」能力就係喺呢度用。
//
// 設計原則(Google Tech Lead):
//   - 純函數、零 I/O、可單元測試、deterministic
//   - 輸入防禦:NaN/Infinity/空陣列/不足樣本 → 安全 fallback
//   - 輸出係「結構化事實」,唔係「判斷」——判斷由 LLM 做
//   - 邊界 case:蠟燭數 < 20 → 用可用樣本,趨勢 confidence 降低

export interface Candle {
  o: number; h: number; l: number; c: number; v: number;
}

export type TrendDirection = 'up' | 'down' | 'sideways';
export type StructureType = 'higher_high' | 'lower_low' | 'range';

export interface KlineSummary {
  trend: TrendDirection;
  /** 0-1:趨勢強度(close 方向一致性 × EMA 斜率正規化) */
  trendStrength: number;
  structure: StructureType;
  /** 最近突破(近 3 根破前 20 根 extreme)——LLM 判斷真偽 */
  breakout?: { direction: 'up' | 'down'; level: number; candlesAgo: number };
  /** 最近 3 根成交量異常(> 3σ) */
  volumeAnomaly: boolean;
  /** 近 5 根形態:「HH HL HH」等(簡短,LLM 讀) */
  recentShape: string;
  /** 人類可讀摘要(注入 context 用) */
  description: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function safeNum(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 最近 N 根 EMA(簡化——用加權平均,production 可用真 EMA,但摘要用途足夠) */
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

// ─── Main ──────────────────────────────────────────────────────────────

export function summarizeKlines(candles: Candle[] | undefined | null): KlineSummary {
  // 防禦:malformed input → 中性 fallback,永不 crash
  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      trend: 'sideways', trendStrength: 0, structure: 'range',
      volumeAnomaly: false, recentShape: '', description: '無 K 線數據',
    };
  }

  // sanitize 蠟燭(濾掉 NaN/Infinity/非法)
  const clean = candles.filter(c => c && Number.isFinite(c.o) && Number.isFinite(c.h)
    && Number.isFinite(c.l) && Number.isFinite(c.c) && c.o > 0);
  if (clean.length === 0) {
    return {
      trend: 'sideways', trendStrength: 0, structure: 'range',
      volumeAnomaly: false, recentShape: '', description: 'K 線數據異常(全部非法)',
    };
  }

  const n = clean.length;
  const closes = clean.map(c => c.c);
  const highs = clean.map(c => c.h);
  const lows = clean.map(c => c.l);
  const vols = clean.map(c => safeNum(c.v, 0));

  // ── Trend(用可用樣本,至少 5 根先有可信度)────────────────────────
  let trend: TrendDirection = 'sideways';
  let trendStrength = 0;
  if (n >= 5) {
    const ema20 = ema(closes, Math.min(20, Math.max(2, n)));
    const first = closes[0]!;
    const last = closes[n - 1]!;
    const netMove = (last - first) / Math.max(1e-9, Math.abs(first));
    // close 方向一致性:幾多根 close > open
    const upCount = clean.filter(c => c.c >= c.o).length;
    const directionConsistency = Math.abs(upCount - (n - upCount)) / n; // 0-1
    if (netMove > 0.003 && upCount >= n * 0.55) { trend = 'up'; trendStrength = Math.min(1, directionConsistency + Math.min(0.5, netMove * 20)); }
    else if (netMove < -0.003 && upCount <= n * 0.45) { trend = 'down'; trendStrength = Math.min(1, directionConsistency + Math.min(0.5, -netMove * 20)); }
    else { trend = 'sideways'; trendStrength = 0.2 + directionConsistency * 0.3; }
  }

  // ── Structure(近 5 根 high/low 關係)──────────────────────────────
  let structure: StructureType = 'range';
  if (n >= 5) {
    const last5 = clean.slice(-5);
    const hh = last5.every((c, i, arr) => i === 0 || c.h >= arr[i - 1]!.h);
    const ll = last5.every((c, i, arr) => i === 0 || c.l <= arr[i - 1]!.l);
    if (hh && !ll) structure = 'higher_high';
    else if (ll && !hh) structure = 'lower_low';
    else structure = 'range';
  }

  // ── Breakout(近 3 根破前 20 根 extreme)───────────────────────────
  let breakout: KlineSummary['breakout'];
  if (n >= 6) {
    const lookback = Math.min(20, n - 3);
    const priorHighs = highs.slice(0, -3).slice(-lookback);
    const priorLows = lows.slice(0, -3).slice(-lookback);
    const priorMax = Math.max(...priorHighs, 0);
    const priorMin = Math.min(...priorLows, Number.MAX_SAFE_INTEGER);
    const recent3 = clean.slice(-3);
    for (let i = recent3.length - 1; i >= 0; i--) {
      const c = recent3[i]!;
      if (c.h > priorMax) {
        breakout = { direction: 'up', level: c.h, candlesAgo: recent3.length - 1 - i };
        break;
      }
      if (c.l < priorMin && priorMin !== Number.MAX_SAFE_INTEGER) {
        breakout = { direction: 'down', level: c.l, candlesAgo: recent3.length - 1 - i };
        break;
      }
    }
  }

  // ── Volume anomaly(最近 3 根 vs 前 N 根 baseline ± 3σ)────────────
  // 用「前 n-3 根」做 baseline(唔含最近 3 根)——否則 outlier 自己推高
  // std,令偵測失效(3 個異常值被 3σ 遮蓋)。
  let volumeAnomaly = false;
  if (n >= 6 && vols.some(v => v > 0)) {
    const recent3Vol = vols.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const baseline = vols.slice(0, -3);
    const meanVol = baseline.reduce((s, v) => s + v, 0) / baseline.length;
    const varVol = baseline.reduce((s, v) => s + (v - meanVol) ** 2, 0) / baseline.length;
    const stdVol = Math.sqrt(Math.max(0, varVol));
    // 正常:> 3σ
    if (stdVol > 1e-12 && recent3Vol > meanVol + 3 * stdVol) volumeAnomaly = true;
    // fallback:baseline 冇波動(std≈0,constant 成交量)→ 2 倍跳變都係異常
    else if (stdVol <= 1e-12 && recent3Vol > meanVol * 2) volumeAnomaly = true;
  }

  // ── Shape(近 5 根:HH/HL/LH/LL 標記)──────────────────────────────
  let recentShape = '';
  if (n >= 2) {
    const last5 = clean.slice(-5);
    recentShape = last5.map((c, i, arr) => {
      if (i === 0) return '';
      const prev = arr[i - 1]!;
      const higherHigh = c.h > prev.h;
      const higherLow = c.l > prev.l;
      if (higherHigh && higherLow) return 'HH';
      if (!higherHigh && !higherLow) return 'LL';
      if (higherHigh) return 'LH'; // 更高高但更低低 → 唔一致
      return 'HL';
    }).filter(Boolean).join(' ');
  }

  // ── Description(注入用)───────────────────────────────────────────
  const parts: string[] = [];
  const trendLabel = trend === 'up' ? 'UP' : trend === 'down' ? 'DOWN' : 'SIDEWAYS';
  parts.push(`Trend: ${trendLabel} (strength ${(trendStrength * 100).toFixed(0)}%, ${closes.length} 根)`);
  if (structure !== 'range') parts.push(`Structure: ${structure.replace('_', '-')} (${recentShape})`);
  else parts.push(`Structure: range (${recentShape || 'n/a'})`);
  if (breakout) parts.push(`最近突破: ${breakout.direction === 'up' ? '破頂' : '破底'} $${breakout.level.toFixed(2)} (${breakout.candlesAgo} 根前)${volumeAnomaly ? ' — ⚠️ vol 異常,待確認' : ' — 待確認'}`);
  if (volumeAnomaly && !breakout) parts.push('Volume: ⚠️ 異常(最近 3 根 > 3σ)');
  else if (!breakout) parts.push('Volume: 正常');

  return {
    trend, trendStrength, structure,
    breakout, volumeAnomaly, recentShape,
    description: parts.join('\n'),
  };
}
