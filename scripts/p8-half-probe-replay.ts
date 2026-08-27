/**
 * P8-profit 重放實驗 2:半倉試探（<15min 生存確認）——candle path 前向模擬
 *
 * 變體 A:15min 後無條件補足全倉
 *   pnl_sim = 0.5 × move(entry→15min) + 1.0 × move(15min→close)
 * 變體 B:15min 浮盈 ≥ +0.3%（margin）先補足,否則維持半倉到平倉
 *
 * 對照:實際 pnlPct。冇 candle 嘅單 skip（保持樣本一致公平比較）。
 * Usage: npx tsx scripts/p8-half-probe-replay.ts
 */
import fs from 'node:fs';

interface RT { symbol?: string; side?: string; entryPrice?: number; leverage?: number; pnlPct?: number; openedAt?: number; closedAt?: number; closeReason?: string }
interface Candle { t: number; h: number; l: number; c: number }

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const trades: RT[] = (state.realTrades ?? [])
  .filter((t: RT) => t.closedAt && t.entryPrice && t.leverage && t.symbol)
  .sort((a: RT, b: RT) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

const symbols = [...new Set(trades.map((t: RT) => t.symbol!))];
const minOpen = Math.min(...trades.map((t: RT) => t.openedAt ?? 0)) - 3_600_000;
const maxClose = Math.max(...trades.map((t: RT) => t.closedAt ?? 0)) + 60_000;
const candleCache = new Map<string, Candle[]>();

async function fetchCandles15m(coin: string, startMs: number, endMs: number): Promise<Candle[]> {
  const xyzName = coin.includes(':') ? coin : `xyz:${coin}`;
  try {
    const d = await (await import('../src/market-agent/index.ts')).MarketAgent.hlFetch({ type: 'candleSnapshot', req: { coin: xyzName, interval: '15m', startTime: startMs, endTime: endMs } }) as Candle[] | null;
    if (Array.isArray(d) && d.length > 0) return d;
  } catch { /* fallthrough */ }
  try {
    const d = await (await import('../src/market-agent/index.ts')).MarketAgent.hlFetch({ type: 'candleSnapshot', req: { coin: coin.includes(':') ? coin.replace('xyz:', '') : coin.toUpperCase(), interval: '15m', startTime: startMs, endTime: endMs } }) as Candle[] | null;
    if (Array.isArray(d) && d.length > 0) return d;
  } catch { /* fallthrough */ }
  return [];
}

console.log(`抓 candles: ${symbols.length} symbols...`);
for (const sym of symbols) {
  const c = await fetchCandles15m(sym, minOpen, maxClose);
  candleCache.set(sym, c ?? []);
}

function sliceCandles(sym: string, opened: number, closed: number): Candle[] {
  return (candleCache.get(sym) ?? []).filter((c) => c.t >= opened - 900_000 && c.t <= closed + 60_000);
}

const PROBE_MIN = 15; // 分鐘
const ADD_THRESHOLD = 0.3; // 變體 B:15min 浮盈 ≥0.3%（margin）先補足

function simulateHalfProbe(t: RT, candles: Candle[], variant: 'A' | 'B'): { pnl: number; probeDied: boolean } | null {
  const entry = t.entryPrice!, lev = t.leverage!, side = t.side === 'sell' ? -1 : 1;
  const opened = t.openedAt!, closed = t.closedAt!;
  const actual = (t.pnlPct ?? 0) * 100;
  const probeEnd = opened + PROBE_MIN * 60_000;
  if (closed <= probeEnd) return { pnl: actual * 0.5, probeDied: true }; // <15min 死:半倉止蝕
  // 搵 15min 時點嘅 candle close
  let close15: number | null = null;
  for (const c of candles) { if (c.t >= probeEnd) { close15 = c.c; break; } }
  if (close15 == null) return null;
  const firstLeg = ((close15 - entry) / entry) * 100 * lev * side;
  const restLeg = ((t.exitPrice! - close15) / close15) * 100 * lev * side;
  let sizeFirst = 0.5, sizeRest = 1.0;
  if (variant === 'B' && firstLeg < ADD_THRESHOLD) { sizeFirst = 0.5; sizeRest = 0.5; } // 浮盈唔夠 → 維持半倉
  return { pnl: firstLeg * sizeFirst + restLeg * sizeRest, probeDied: false };
}

// 公平比較:只計有 candle 嘅單
const withCandles = trades.filter((t: RT) => sliceCandles(t.symbol!, t.openedAt!, t.closedAt!).length > 0);
const baseline = withCandles.reduce((a: number, t: RT) => a + (t.pnlPct ?? 0) * 100, 0);
console.log(`公平樣本: ${withCandles.length}/${trades.length} 喺, 基線 ${baseline.toFixed(1)}pp\n`);

for (const variant of ['A', 'B'] as const) {
  let sim = 0, affected = 0, saved = 0, lost = 0;
  const detail: string[] = [];
  for (const t of withCandles) {
    const candles = sliceCandles(t.symbol!, t.openedAt!, t.closedAt!);
    const r = simulateHalfProbe(t, candles, variant);
    if (!r) { sim += (t.pnlPct ?? 0) * 100; continue; }
    const actual = (t.pnlPct ?? 0) * 100;
    sim += r.pnl;
    if (r.pnl < actual - 0.01) { lost += actual - r.pnl; if (detail.length < 5) detail.push(`${t.symbol} ${t.side} 實收${actual.toFixed(1)}→${r.pnl.toFixed(1)}`); }
    if (r.pnl > actual + 0.01) { saved += r.pnl - actual; }
    void affected;
  }
  const delta = sim - baseline;
  console.log(`變體 ${variant}: 模擬 ${sim.toFixed(1)}pp (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp) | 救回 ${saved.toFixed(1)}pp / 損失 ${lost.toFixed(1)}pp`);
  for (const d of detail) console.log(`     ${d}`);
}