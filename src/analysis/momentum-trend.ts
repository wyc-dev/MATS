/**
 * ═══ v2.0.870-P26: Local Momentum Trend(趨勢盲修復)═══
 *
 * 背景(主神實問「趨勢咁明顯都開唔到單」):
 *   WS tick handler 每個 tick 覆蓋 ticker——priceChangePercent 寫死 0,
 *   將 REST 補給嘅真 24h 動量即刻踩扁。calcTrend 靠的呢個數 ⇒ 永遠
 *   sideways ⇒ regime 永遠 mean_reverting ⇒ trending_bull/bear 係死代碼。
 *   主神定調:棄用 24h REST 欄位(成日攞唔到 + 對短炒無用)——
 *   trend 改由**本機蠟燭動量**(5m/15m/1h/4h)計算,每 cycle 一次,
 *   原料嚟自 candleCache(LLM chart layer 反正都 fetch),零新增 API。
 *
 * 設計(頂尖量化口徑):
 *   - 4h 動量 = 主方向(抗雜訊);1h 動量 = 方向確認(時機);
 *     **兩者同向先判 trending**——單窗口極端值八成係假突破。
 *   - 閾值按窗口線性縮放:τ24(校準沿用嘅 24h 口徑)→ τ4h=τ24/6、
 *     τ1h=τ24/24,下限 0.05%/0.03%(貴金屬正常波動下限以下=雜訊)。
 *   - 5m volume ratio(最新收市支 ÷ 前 24 支中位數)做**質地標記**
 *     (strong/normal/thin)——soft context,永不 hard-block(主神教條)。
 *   - NaN 盾牌 + 缺數據 graceful(null,hasData=false)。
 */

/** 統一蠟燭形狀(同 data/candle-cache.ts 一致,結構型別) */
export interface CandleLike { t: number; o: number; h: number; l: number; c: number; v: number }

export interface MomentumSnapshot {
  /** 各窗口動量(%),例:+1.2 = +1.2%;數據唔夠 → null */
  m5m: number | null;
  m15m: number | null;
  m1h: number | null;
  m4h: number | null;
  /** 最新收市 5m 支成交量 ÷ 前 24 支中位數;數據唔夠 → null */
  volumeRatio: number | null;
  volumeState: 'strong' | 'normal' | 'thin' | 'unknown';
  /** v2.0.870-P26.5: 4h 量能核對——最近 48 支收市支量 ÷ 再前 48 支量。
   *  主神定調:4h 量能係 vol-judge / 市況判斷嘅定量核對來源。
   *  需 ≥97 支 5m 蠟燭(48+48+1 forming),唔夠 → null(唔會亂估)。 */
  vol4hRatio: number | null;
  /** 有任何一個有效動量窗口 */
  hasData: boolean;
}

export type MomentumTrend = 'bullish' | 'bearish' | 'sideways' | 'volatile';

/** 窗口動量:lastClose vs 窗口起點嗰支嘅收市價(%)。數據唔夠長 → null */
function windowMomentum(candles: CandleLike[], windowBars: number): number | null {
  if (!candles || candles.length < windowBars + 1) return null;
  const last = candles[candles.length - 1]!.c;
  const anchor = candles[candles.length - 1 - windowBars]!.c;
  if (!Number.isFinite(last) || !Number.isFinite(anchor) || anchor <= 0 || last <= 0) return null;
  const pct = ((last - anchor) / anchor) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) > 100) return null; // 單窗口 100%+ 係壞數據
  return pct;
}

function median(xs: number[]): number | null {
  const v = xs.filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * 由蠟燭計多窗口動量 + 5m 成交量確認。
 * @param c5m 5m 蠟燭(建議 ≥27 支:m1h 需 12 支 + vol 中位需 24 支)
 * @param c1h 1h 蠟燭(≥5 支畀 m4h)
 */
export function computeMomentum(c5m: CandleLike[] | null, c1h: CandleLike[] | null): MomentumSnapshot {
  const snap: MomentumSnapshot = {
    m5m: null, m15m: null, m1h: null, m4h: null,
    volumeRatio: null, volumeState: 'unknown', vol4hRatio: null, hasData: false,
  };
  if (c5m && c5m.length >= 2) {
    snap.m5m = windowMomentum(c5m, 1);
    snap.m15m = windowMomentum(c5m, 3);
    snap.m1h = windowMomentum(c5m, 12);
  }
  if (c1h && c1h.length >= 2) {
    snap.m4h = windowMomentum(c1h, 4);
    // 1h 動量細窗口優先去 5m(更準);5m 唔夠就先由 1h 補
    if (snap.m1h === null) snap.m1h = windowMomentum(c1h, 1);
  }

  // 5m 成交量:用「已收市」支做主體(最後一支可能 forming——但佢就係
  // 當下實時量,作分子;分母用之前 24 支,排除 forming 支嘅偏差)
  if (c5m && c5m.length >= 6) {
    const lastV = c5m[c5m.length - 1]!.v;
    const base = median(c5m.slice(-25, -1).map(c => c.v));
    if (Number.isFinite(lastV) && lastV >= 0 && base !== null && base > 0) {
      const ratio = lastV / base;
      if (Number.isFinite(ratio) && ratio < 1000) {
        snap.volumeRatio = ratio;
        snap.volumeState = ratio >= 1.5 ? 'strong' : ratio >= 0.7 ? 'normal' : 'thin';
      }
    }
  }

  // P26.5: 4h 量能核對——最近 48 支收市支(剔除最後 forming 支)
  // ÷ 再之前 48 支。窗口對窗口(same-shape)比 median 更抗離群值;
  // 需要 97 支(48+48+1 forming)。
  if (c5m && c5m.length >= 97) {
    const last48 = c5m.slice(-49, -1);
    const prior48 = c5m.slice(-97, -49);
    const sumRecent = last48.reduce((a, c) => a + (Number.isFinite(c.v) && c.v > 0 ? c.v : 0), 0);
    const sumPrior = prior48.reduce((a, c) => a + (Number.isFinite(c.v) && c.v > 0 ? c.v : 0), 0);
    if (sumPrior > 0 && Number.isFinite(sumRecent)) {
      const ratio = sumRecent / sumPrior;
      if (Number.isFinite(ratio) && ratio < 1000) snap.vol4hRatio = ratio;
    }
  }

  snap.hasData = snap.m1h !== null || snap.m4h !== null || snap.m15m !== null || snap.m5m !== null;
  return snap;
}

/**
 * 多窗口趨勢分類。
 * @param snap computeMomentum 輸出
 * @param tau24 沿用校準嘅 24h 趨勢閾值(%;per-symbol 優先,見 marketState.getTrendTau)
 * @param volatility per-cycle σ(fraction,如 0.0018)
 */
export function classifyMomentumTrend(snap: MomentumSnapshot, tau24: number, volatility: number): MomentumTrend {
  const tauAbs = Number.isFinite(tau24) && tau24 > 0 ? Math.abs(tau24) : 0.5;
  // 窗口線性縮放:純線性趨勢下 24h return ≈ 6×4h ≈ 24×1h
  const tau4h = Math.min(Math.max(tauAbs / 6, 0.05), tauAbs);
  const tau1h = Math.min(Math.max(tauAbs / 24, 0.03), tauAbs);

  if (volatility > 0.02) return 'volatile'; // 沿用 legacy 高波動覆蓋

  const { m1h, m4h } = snap;
  if (m4h !== null && m1h !== null) {
    // 主規則:4h 定方向強度,1h 確認時機(任一方「過閾」而另一方同向)
    if ((m4h >= tau4h && m1h > 0) || (m1h >= tau1h && m4h > 0)) return 'bullish';
    if ((m4h <= -tau4h && m1h < 0) || (m1h <= -tau1h && m4h < 0)) return 'bearish';
    return 'sideways';
  }
  if (m1h !== null) {
    // 1h-only fallback(1h 蠟燭缺):單窗口要更強先算數
    if (m1h >= tau1h * 1.5) return 'bullish';
    if (m1h <= -tau1h * 1.5) return 'bearish';
    return 'sideways';
  }
  if (m4h !== null) {
    if (m4h >= tau4h * 1.5) return 'bullish';
    if (m4h <= -tau4h * 1.5) return 'bearish';
    return 'sideways';
  }
  return 'sideways';
}

/** 顯示用一話概括(分析卡/日誌) */
export function describeMomentum(snap: MomentumSnapshot): string {
  const f = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  const vol = snap.volumeRatio === null ? 'vol n/a' : `vol ${snap.volumeRatio.toFixed(1)}×(${snap.volumeState})`;
  const vol4 = snap.vol4hRatio === null ? '' : ` · 4h量 ${snap.vol4hRatio.toFixed(1)}×`;
  return `5m ${f(snap.m5m)} · 15m ${f(snap.m15m)} · 1h ${f(snap.m1h)} · 4h ${f(snap.m4h)} · ${vol}${vol4}`;
}
