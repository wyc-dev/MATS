// ─── 精確 24h 動量 BUY filter — v2.0.873-P9-mom24-guard ────────────────
//
// 主神指令 2026-08-31: 「實作『精確 24h filter』(六關全過、+140.7%, 唯一未實作嘅正成效方案)」
//
// 問題 (831.md §6): 4 筆蝕 BUY (SILVER −6.2% / SKHX −5.4% / BNB −15.1% / GOLD −3.7%)
//   開倉時 24h 動量全部「微正」(+0.10% ~ +1.23%)——F1 gate 眼中係順勢/噪音
//   (|mom| < 1.5% → ×1.0) 放行, 但「由正轉弱初期」同「逆勢買跌中」就係接刀陷阱:
//   SILVER mom24=+0.21% / GOLD mom24=+0.10% 就係「24h 仲企穩但隨後反轉」。
//
// 驗證 (scripts/trade-history-archive/24-precise-filter.ts, 304 單/244 BUY, 零 look-ahead):
//   blocked (mom24 < −0.5% 或 0 ≤ mom24 < +0.5%): avg −1.35% / 中位 −0.98% (普遍虧損)
//   skip → Δ+140.7% | size½ → +70.4% (skip 二倍於 half——硬 block 正確)
//   關 4 SELL Δ−2.5% (唔誤傷 SELL) | 關 5 敏感性: 鄰近 4 組合全正 (非孤立 peak)
//   關 6 中位數: blocked 中位 −0.98% < kept +0.34%
// 保留區: −0.5 ≤ mom24 < 0 (跌到底反彈, +2.83% WR 68%) 同 mom24 ≥ +0.5% (順勢)
//
// 同 F1 (momentum-directional-bias) 零重疊互補:
//   F1 管 |mom24| ≥ 1.5% 嘅方向層 (順勢 boost/逆勢逐級/≥8% hard block);
//   本 guard 填「微動量陷阱區」(|mom24| < 1.5% 為主: 逆勢買跌 + 微正假順勢)。
//
// 幻覺修正不變式: 已證偽源 (OLR/Q-RL/FP) 唔做決定——本 guard 只用真實 mom24
//   candle 數據, 同 F1/5m-gate 同一可信源。只 apply BUY;SELL 側驗證係中性
//   (Δ−2.5% — 唔為做而做)。SL 唔收窄。唔影響任何離場路徑 (純入場 gate)。

import { robustMomentumPct } from './momentum-directional-bias.ts';

export interface Mom24GuardResult {
  blocked: boolean;
  reason: string;
}

/**
 * 精確 24h 動量 BUY filter——純決策, 零 I/O。
 *
 * block 條件 (BUY only): `mom24Pct < low`（逆勢買跌中, 接刀 avg −1.35%）
 *   或 `0 ≤ mom24Pct < high`（由正轉弱初期陷阱, avg −0.46%）。
 * keep 條件: `low ≤ mom24Pct < 0`（跌到底反彈區, +2.83% WR 68%）
 *   或 `mom24Pct ≥ high`（順勢）。
 *
 * ATTACK-HARDENING (v2.0.873-P9-mom24-guard-attack):
 *   - side 垃圾值 ('hold'/'long'/undefined) → keep（唔可以當 BUY block）
 *   - mom24Pct null / NaN / ±Infinity / |mom| > 100 → keep（污染值唔可以操控 gate——
 *     同 F1 `momentumDirectionalBias` 一致; 1e308 級污染當硬 block = 攻擊者可直接
 *     凍結所有 BUY;當放行 = 中立, 唔偏幫任何方向）
 *   - low/high 參數 validate（合法 band low∈[-10,0] / high∈[0,10];超出/非 finite →
 *     落回預設 −0.5/+0.5）——env 注入極值（ENTRY_MOM24_LOW=1e308）產同驗證
 *     完全一致嘅行為（垃圾唔可以改寫 gate 行為）
 */
export function shouldBlockMom24(input: {
  mom24Pct: number | null;
  side: 'buy' | 'sell';
  low: number;
  high: number;
}): Mom24GuardResult {
  const side = input.side;
  if (side !== 'buy') {
    return { blocked: false, reason: 'SELL 唔 apply——SELL 側驗證 Δ−2.5% 中性' };
  }
  const mom = input.mom24Pct;
  if (mom === null || !Number.isFinite(mom) || Math.abs(mom) > 100) {
    return { blocked: false, reason: 'mom24 數據缺失/無效——保守放行(冷啟動/污染)' };
  }
  const low = validateLow(input.low);
  const high = validateHigh(input.high);
  if (mom < low) {
    return { blocked: true, reason: `mom24=${mom.toFixed(2)}% < ${low}%——24h 逆勢買跌中(接刀, 歷史 avg −1.35%)` };
  }
  if (mom >= 0 && mom < high) {
    return { blocked: true, reason: `mom24=${mom.toFixed(2)}% ∈ [0, ${high}%)——由正轉弱初期陷阱(歷史 avg −0.46%)` };
  }
  if (mom < 0) {
    return { blocked: false, reason: `mom24=${mom.toFixed(2)}% ∈ [${low}, 0)——跌到底反彈區(歷史 +2.83% WR 68%)——放行` };
  }
  return { blocked: false, reason: `mom24=${mom.toFixed(2)}% ≥ ${high}%——順勢——放行` };
}

/**
 * 開倉前 24h 動量——「開倉前 24 支已 CLOSED 1h candle」嘅 robust median
 * per-candle return × 24（%）。
 *
 * 同 24-precise-filter.ts 驗證語義零偏差:
 *   verification: `endIdx = first t > openedAt` → `closes = c1h.slice(endIdx-24, endIdx)`
 *   live:         剔 in-progress 燭 (t + 1h > now) → 最後 24 支 close
 *   (now == 開倉時刻——gate 喺落單前同步跑——等價)
 *
 * ⚠️ 831.md §7.1 look-ahead 教訓: in-progress 燭含「開倉嗰刻未完成嘅數據」=
 *   未來資訊——必須剔除, 唔可以當已 close。零 look-ahead 係六關之一 (關 3)。
 *
 * ATTACK-HARDENING: 垃圾 element (null/NaN/非正/垃圾 t) skip; 未來 t 自然被
 *   closed 過濾剔走; now 垃圾 → fallback Date.now(); 唔足 24 支 → null (保守放行)。
 * 返回 % (正 = 向上), clamp [-100, 100]（robustMomentumPct 內建）。
 */
export function computeMom24PctFromCandles(
  candles: Array<{ t: number; c: number } | null | undefined> | null | undefined,
  nowMs?: number,
): number | null {
  if (!Array.isArray(candles)) return null;
  const now = Number.isFinite(nowMs) && (nowMs ?? 0) > 0 ? nowMs! : Date.now();
  const HOUR_MS = 3_600_000;
  const closed: number[] = [];
  for (const c of candles) {
    if (!c || typeof c !== 'object') continue;
    const t = c.t;
    const v = c.c;
    // Symbol/BigInt/object/非 finite → skip（Number(Symbol) 會 throw）
    if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(t) || !Number.isFinite(v) || v <= 0) continue;
    if (t + HOUR_MS > now) continue; // in-progress 燭——剔 (look-ahead 防線)
    closed.push(v);
  }
  if (closed.length < 24) return null;
  return robustMomentumPct(closed.slice(-24));
}

/**
 * env 解析 + validate（ATTACK-HARDENING）:
 *   low  合法 band [-10, 0]  → 接受; 超出 band / NaN / Infinity → 預設 −0.5
 *   high 合法 band [0, 10]   → 接受; 超出 band / NaN / Infinity → 預設 +0.5
 *   ——垃圾 env 產同驗證完全一致嘅行為（污染唔可以改寫 gate）。合法後必 low ≤ high。
 */
export function mom24EnvThresholds(
  lowRaw: string | number | null | undefined,
  highRaw: string | number | null | undefined,
): { low: number; high: number } {
  /** safe number 解析——Symbol/BigInt/object/非 finite → null（Number(Symbol) 會 throw） */
  function safeNum(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    return null; // Symbol/BigInt/object/array/boolean
  }

  const parse = (v: unknown, fallback: number): number => safeNum(v) ?? fallback;
  return { low: validateLow(parse(lowRaw, -0.5)), high: validateHigh(parse(highRaw, 0.5)) };
}

function validateLow(v: number): number {
  if (!Number.isFinite(v)) return -0.5;
  return v >= -10 && v <= 0 ? v : -0.5;
}

function validateHigh(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return v >= 0 && v <= 10 ? v : 0.5;
}

/**
 * BUY 追升尾 guard（v2.0.873-P9-chase-tail——scripts/31-mom24-last1-grid.ts, 主神 2026-08-31）:
 *   24h 強勢（mom24 ≥ 1.0%）但最後已 close 1h 已轉跌（last1 < 0）= 追升尾 =
 *   「強動量但開倉嗰刻已轉頭」——mom24-guard 未覆蓋（佢只 cover mom24<0.5）。
 *   SKHX mom24=+0.95% / BNB +1.23% 兩筆大蝕單正正嚟自呢個區（831 §6.1 已知限制）。
 *
 * 驗證（305 單, 零 look-ahead）: n=21 avg −2.58%（中位 −1.68%）→ block Δ+54.2%; 兩半
 *   期1 −1.19%(+10.7%) / 期2 −3.63%(+43.5%)（兩半都正）; 剔 outlier 21/21; 敏感性
 *   mom24≥0.5(+22.7)/≥1.5(+40.6)/last1<−0.1(+25.7) 全正（非孤立 peak）; 分 symbol 5/7
 *   負（SKHX +3.64% n=4 例外——誤傷 ~15pp vs 全組 +54.2pp, 期望值仍大正）。
 *   SELL 鏡像唔實作（n=4 樣本太少——T1 已否決, 誠實記錄）。
 *
 * 同 mom24-guard 零重疊: guard cover mom24<−0.5 ∪ [0,0.5); 本函數 cover mom24≥1.0
 *   —中間 0.5-1.0 不動（表證 avg +1.37% 正, 唔應該 block）。
 *
 * ATTACK-HARDENING: mom24/last1 垃圾（Symbol/NaN/Infinity/|值|>100）→ keep（中性）;
 *   threshold 垃圾 → 預設（band validate）; side 非 'buy' → keep。
 */
export function shouldBlockChaseTail(input: {
  mom24Pct: number | null;
  last1Pct: number | null;
  side: 'buy' | 'sell';
  thresholdMom24?: number; // 預設 1.0
  thresholdLast1?: number;  // 預設 0
}): Mom24GuardResult {
  if (input.side !== 'buy') {
    return { blocked: false, reason: 'SELL 唔 apply（鏡像 n=4 樣本太少——T1 已否決）' };
  }
  const mom = input.mom24Pct;
  const last1 = input.last1Pct;
  if (mom === null || last1 === null || !Number.isFinite(mom) || !Number.isFinite(last1)
    || Math.abs(mom) > 100 || Math.abs(last1) > 100) {
    return { blocked: false, reason: 'mom24/last1 數據缺失/無效——保守放行' };
  }
  const thMom = validateTh(input.thresholdMom24, 1.0, 0.5, 10);
  const thLast = validateTh(input.thresholdLast1, 0, -2, 0);
  if (mom >= thMom && last1 < thLast) {
    return { blocked: true, reason: `mom24=${mom.toFixed(2)}% ≥ ${thMom}%（強勢）但 last1=${last1.toFixed(2)}% < ${thLast}%（1h 已轉跌）——追升尾（歷史 avg −2.58%, Δ+54.2%）` };
  }
  return { blocked: false, reason: 'mom24/last1 組合非追升尾——放行' };
}

/** band validate——超出範圍／垃圾 → 預設（唔可以改寫 zone） */
function validateTh(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v >= min && v <= max ? v : fallback;
}
