/**
 * verify-shadow-wr-divergence.ts
 * 目的: 量化 shadow 模擬 WR（entryShadowWinRate）vs 真實 PnL 嘅分歧，
 *       驗證候選 B1（entryShadowWinRate 返 undefined）嘅必要性。
 * 紀律: 零 look-ahead——只用 entryShadowWinRate（開倉時存檔）+ 真實 pnlPct。
 * 三關:
 *   關1: 全樣本 ρ(entryShadowWinRate, pnlPct)
 *   關2: 分桶（<0.3 / 0.3-0.5 / >0.5）真實 WR/EV
 *   關3: within-symbol ρ
 */
import * as fs from 'fs';
import * as path from 'path';
import { avgRankSpearman } from '../src/analysis/rank-correlation.ts';

interface Trade {
  symbol?: string;
  side?: string;
  pnlPct?: number;
  entryShadowWinRate?: number;
  entryOlrPWin?: number;
  closeReason?: string;
  openedAt?: number;
}

function loadTrades(): Trade[] {
  const p = path.resolve(process.cwd(), 'data/evolution/portfolio-state.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rt = (s.realTrades ?? []) as Trade[];
  // V3 硬化（attack-round6）: persisted 污染可能含 null/garbage element——object guard 先
  return rt.filter((t) => t && typeof t === 'object' && (t.status === undefined || (t as any).status === 'closed'));
}

function main() {
  const trades = loadTrades();
  const withSwr = trades.filter((t) => typeof t.entryShadowWinRate === 'number' && Number.isFinite(t.entryShadowWinRate) && typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct));
  console.log(`有 entryShadowWinRate 嘅 real trades: n=${withSwr.length} / ${trades.length}`);

  // P9-attack-round6（E1 發現）: entryShadowWinRateSource 分層——fallback fill 記錄
  // （live-fallback）係回溯快照（資訊含量低）; entry-snapshot 先係開倉當刻真值。
  // 歷史記錄冇 source field——以「symbol×value 出現次數」做 proxy（出現 >1 次 = fallback 嫌疑）。
  const src = withSwr.map((t) => t.entryShadowWinRateSource ?? (t as any).shadowWinRateSource);
  const snap = withSwr.filter((_, i) => src[i] === 'entry-snapshot');
  if (snap.length > 0) {
    const r = avgRankSpearman(snap.map((t) => t.entryShadowWinRate!), snap.map((t) => t.pnlPct!));
    console.log(`[Source] entry-snapshot n=${snap.length} ρ=${r === null ? 'undefined' : r.toFixed(4)}（開倉當刻真值）`);
  }
  const cnt: Record<string, number> = {};
  for (const t of withSwr) {
    const k = `${(t.symbol ?? '?').toLowerCase()}|${t.entryShadowWinRate!.toFixed(6)}`;
    cnt[k] = (cnt[k] ?? 0) + 1;
  }
  const unique = withSwr.filter((t) => cnt[`${(t.symbol ?? '?').toLowerCase()}|${t.entryShadowWinRate!.toFixed(6)}`] === 1);
  if (unique.length >= 3) {
    const r = avgRankSpearman(unique.map((t) => t.entryShadowWinRate!), unique.map((t) => t.pnlPct!));
    console.log(`[Source] 每 symbol×value 只出現一次（無 fallback 嫌疑）n=${unique.length} ρ=${r === null ? 'undefined' : r.toFixed(4)}`);
  }

  // 關1: 全樣本 ρ
  const xs = withSwr.map((t) => t.entryShadowWinRate!);
  const ys = withSwr.map((t) => t.pnlPct!);
  const rho = avgRankSpearman(xs, ys);
  console.log(`\n[關1] 全樣本 ρ(entryShadowWinRate, pnlPct) = ${rho === null ? 'undefined（零變異/樣本不足）' : rho.toFixed(4)}`);
  console.log(`  → ${rho === null ? '無法判定（無排名資訊）' : Math.abs(rho) < 0.1 ? '零預測力（shadow WR 係噪音）' : Math.abs(rho) < 0.2 ? '弱預測力' : '有預測力'}`);

  // 關2: 分桶
  const buckets = [
    { name: 'swr < 0.3', lo: -Infinity, hi: 0.3 },
    { name: 'swr 0.3-0.5', lo: 0.3, hi: 0.5 },
    { name: 'swr > 0.5', lo: 0.5, hi: Infinity },
  ];
  console.log(`\n[關2] 分桶（真實 WR/EV）:`);
  for (const b of buckets) {
    const g = withSwr.filter((t) => t.entryShadowWinRate! > b.lo && t.entryShadowWinRate! <= b.hi);
    const sum = g.reduce((a, t) => a + t.pnlPct! * 100, 0);
    const win = g.filter((t) => t.pnlPct! > 0).length;
    const wr = g.length ? (win / g.length) * 100 : 0;
    console.log(`  ${b.name.padEnd(14)} n=${String(g.length).padEnd(4)} 真實WR=${wr.toFixed(0)}%  Σ=${sum.toFixed(2)}%  avg=${(g.length ? sum / g.length : 0).toFixed(2)}%`);
  }

  // 關3: within-symbol ρ
  console.log(`\n[關3] within-symbol ρ(entryShadowWinRate, pnlPct):`);
  const bySym = new Map<string, Trade[]>();
  for (const t of withSwr) {
    const k = (t.symbol ?? '?').toLowerCase();
    if (!bySym.has(k)) bySym.set(k, []);
    bySym.get(k)!.push(t);
  }
  for (const [sym, g] of bySym) {
    if (g.length < 3) continue;
    const r = avgRankSpearman(g.map((t) => t.entryShadowWinRate!), g.map((t) => t.pnlPct!));
    const sum = g.reduce((a, t) => a + t.pnlPct! * 100, 0);
    console.log(`  ${sym.padEnd(12)} n=${String(g.length).padEnd(4)} ρ=${r === null ? 'undefined'.padEnd(7) : r.toFixed(3).padEnd(7)}  Σ=${sum.toFixed(2)}%`);
  }

  // 額外: 對比 OLR ρ（對照組）
  const withOlr = trades.filter((t) => typeof t.entryOlrPWin === 'number' && Number.isFinite(t.entryOlrPWin) && typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct));
  const rhoOlr = avgRankSpearman(withOlr.map((t) => t.entryOlrPWin!), withOlr.map((t) => t.pnlPct!));
  console.log(`\n[對照] 全樣本 ρ(entryOlrPWin, pnlPct) = ${rhoOlr === null ? 'undefined' : rhoOlr.toFixed(4)} (n=${withOlr.length})`);
}

main();
