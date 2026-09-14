// ═══════════════════════════════════════════════════════════════════════════
// timing-edge.ts —— 時機條件 edge cache（v2.0.886, 主神「BTC 兩週冇單——voice 斷層」）
//
// 問題: buildShadowVoiceBlock 只用 decayed 全局 stats —— BTC 跌勢時「買 dip WR 76%」
// 呢個時機條件 edge 從來冇俾 agents 睇(跌勢嗰刻 agents 見到嘅係全局 WR 14%)。
//
// 設計: shadow-resolve-archive(有精確 openedAt) + HL 1h candle → 離線重算
//   「symbol × side × 開倉時 m4hAtOpen 桶(drop≤−0.5 / rise≥+0.5)」→ 統計 WR/n/avg
//   → 寫入 data/evolution/timing-edge-cache.json（每幾分鐘 refresh 一次,voice 讀 cache 好快）。
//
// 使用方: buildShadowVoiceBlock 喺「而家 m4h ≤ −0.5%」嗰刻,引用 cache 中該 symbol
//   「跌勢開 BUY」樣本 —— pure context, 零 gate。
//
// env TIMING_EDGE_VOICE=true 先注入。 ═══════════════════════════════════════

import fs from 'node:fs';

export const TIMING_EDGE_CACHE_PATH = 'data/evolution/timing-edge-cache.json';
export const TIMING_EDGE_ENV = 'TIMING_EDGE_VOICE';
export const TIMING_EDGE_MIN_N = 20; // voice 報數門檻（context 用,較 gate 低但仍要「有實證」）

export interface TimingEdgeStats { n: number; wins: number; wr: number; avgPct: number; }
/** cache map: key = `${symbol}|${side}|${bucket}` → stats */
export type TimingEdgeMap = Record<string, TimingEdgeStats>;
export type CandleFetcher = (hlCoin: string) => Promise<Array<{ t: number; c: number }> | null>;

/**
 * 重建 timing-edge cache —— 讀 archive(精確 openedAt)+ 8 symbol 1h candle →
 * 每筆 resolve 計開倉時 m4hAtOpen → 分側×桶統計 → 寫 json(atomic)。
 * fail-safe: candle fetch 失敗 → 唔寫,保留舊 cache(voice 用舊數據仍 OK)。
 * 由呼叫方 throttle(如 300s)+ archive mtime 變檢查後先 call。
 */
export async function refreshTimingEdgeCache(opts: {
  archivePath?: string;
  cachePath?: string;
  fetchCandles: CandleFetcher;
  symbols?: Array<{ sym: string; hl: string }>;
}): Promise<{ updated: boolean; entries: number }> {
  const archivePath = opts.archivePath ?? 'data/evolution/shadow-resolve-archive.jsonl';
  const cachePath = opts.cachePath ?? TIMING_EDGE_CACHE_PATH;
  const symbols = opts.symbols ?? [
    { sym: 'btc', hl: 'BTC' }, { sym: 'bnb', hl: 'BNB' }, { sym: 'xyz:GOLD', hl: 'xyz:GOLD' }, { sym: 'xyz:SP500', hl: 'xyz:SP500' },
    { sym: 'xyz:SKHX', hl: 'xyz:SKHX' }, { sym: 'xyz:SNDK', hl: 'xyz:SNDK' }, { sym: 'xyz:DRAM', hl: 'xyz:DRAM' }, { sym: 'xyz:SILVER', hl: 'xyz:SILVER' },
  ];
  const CYCLE_MS = 3 * 60 * 1000;
  try {
    if (!fs.existsSync(archivePath)) return { updated: false, entries: 0 };
    const lines = fs.readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x): x is any => x !== null);
    if (lines.length < 10) return { updated: false, entries: 0 };
    // candle map
    const candleMap = new Map<string, Array<{ t: number; c: number }> | null>();
    for (const { sym, hl } of symbols) candleMap.set(sym, await opts.fetchCandles(hl));
    const m4hAt = (candles: Array<{ t: number; c: number }> | null, t: number): number | null => {
      if (!candles) return null;
      let idx = -1;
      for (let i = 0; i < candles.length; i++) { if (candles[i]!.t + 3600_000 <= t) idx = i; else break; }
      if (idx < 5) return null;
      return (candles[idx]!.c / candles[idx - 4]!.c - 1) * 100;
    };
    // 統計
    const acc: Record<string, { n: number; wins: number; sum: number }> = {};
    for (const r of lines) {
      if (r.side !== 'buy' && r.side !== 'sell') continue;
      const openedAt = typeof r.openedAt === 'number' ? r.openedAt : (typeof r.resolvedAt === 'number' && typeof r.holdCycles === 'number' ? r.resolvedAt - r.holdCycles * CYCLE_MS : NaN);
      if (!Number.isFinite(openedAt)) continue;
      const m4h = m4hAt(candleMap.get(r.symbol) ?? null, openedAt);
      if (m4h === null) continue;
      const bucketRaw: 'drop' | 'rise' | null = m4h <= -0.5 ? 'drop' : m4h >= 0.5 ? 'rise' : null;
      if (!bucketRaw) continue;
      const bucket: 'drop' | 'rise' = bucketRaw;
      const pnl = Number(r.pnlPct);
      if (!Number.isFinite(pnl)) continue;
      const key = `${String(r.symbol).toLowerCase()}|${r.side}|${bucket}`;
      const e = (acc[key] = acc[key] ?? { n: 0, wins: 0, sum: 0 });
      e.n++; if (r.outcome === 'win') e.wins++; e.sum += pnl;
    }
    // 寫出(原子)
    const out: TimingEdgeMap = {};
    for (const [k, e] of Object.entries(acc)) {
      out[k] = { n: e.n, wins: e.wins, wr: e.wins / e.n, avgPct: e.sum / e.n };
    }
    const tmp = cachePath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf-8');
    fs.renameSync(tmp, cachePath);
    return { updated: true, entries: Object.keys(out).length };
  } catch {
    return { updated: false, entries: 0 };
  }
}
// key: `${symbol}|${bucket}`   bucket: 'drop' | 'rise'

/** 讀 cache（garbage/壞 JSON → 空 map,唔 throw） */
export function loadTimingEdgeCache(filePath: string = TIMING_EDGE_CACHE_PATH): TimingEdgeMap {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const out: TimingEdgeMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const s = v as Record<string, unknown>;
      const n = Number(s['n']);
      const wins = Number(s['wins']);
      const avgPct = Number(s['avgPct']);
      if (!Number.isFinite(n) || !Number.isFinite(wins) || !Number.isFinite(avgPct)) continue;
      if (n <= 0) continue;
      out[k] = { n, wins, wr: wins / n, avgPct };
    }
    return out;
  } catch { return {}; }
}

/** 查詢 cache——key = `${symbol}|${side}|${bucket}`(symbol 細階);側/桶白名單 + n 門檻;唔夠 → null */
export function queryTimingEdge(
  cache: TimingEdgeMap,
  symbol: string,
  side: 'buy' | 'sell',
  bucket: 'drop' | 'rise',
  minN: number = TIMING_EDGE_MIN_N,
): TimingEdgeStats | null {
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  if (side !== 'buy' && side !== 'sell') return null;
  if (bucket !== 'drop' && bucket !== 'rise') return null;
  const key = `${symbol.toLowerCase()}|${side}|${bucket}`;
  const s = cache[key];
  if (!s || s.n < minN) return null;
  return s;
}

/** 觸發判斷——跌勢(≤−0.5%)先報 buy-dip lean */
export function shouldTriggerBuyDip(m4hPct: number | null | undefined): boolean {
  return typeof m4hPct === 'number' && Number.isFinite(m4hPct) && m4hPct <= -0.5;
}

/** 鏡像(升勢賣 rip)——sell 樣本弱時 caller 可以唔用;保持 function 存在俾日後驗證 */
export function shouldTriggerSellRip(m4hPct: number | null | undefined): boolean {
  return typeof m4hPct === 'number' && Number.isFinite(m4hPct) && m4hPct >= 0.5;
}

/** 格式化 voice 行——n 夠 + WR 有意義(≥55%)先報「lean」,否則只報資訊 */
export function formatTimingEdgeLine(
  symbol: string, side: 'buy' | 'sell', bucket: 'drop' | 'rise',
  s: TimingEdgeStats, m4hPct: number,
): string {
  const wrPct = (s.wr * 100).toFixed(0);
  const dir = bucket === 'drop' ? '跌勢' : '升勢';
  const lean = side === 'buy' && bucket === 'drop' && s.wr >= 0.55 ? '——統計層 lean BUY(時機條件)' : '';
  return `⚠️ TIMING-EDGE: ${symbol.toUpperCase()} 此刻 4h ${dir}(${(m4hPct >= 0 ? '+' : '')}${m4hPct.toFixed(2)}%)——歷史「${side} @ ${dir}」樣本 n=${s.n} WR=${wrPct}% avg=${s.avgPct.toFixed(2)}%${lean}`;
}
