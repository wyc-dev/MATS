/**
 * P8 分佈偵測:266 喺 closed realTrades 全景掃描——搵架構級盈利邊際。
 * 只讀唔寫。
 */
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const T = (d.realTrades ?? []).filter((x: any) => x.closedAt).sort((a: any, b: any) => a.closedAt - b.closedAt);

const pct = (x: any) => (x?.pnlPct ?? 0) * 100;
const stats = (a: number[]) => {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  const skew = a.reduce((x, y) => x + ((y - mean) / sd) ** 3, 0) / a.length;
  return { n: a.length, mean: +mean.toFixed(2), med: +s[Math.floor(a.length / 2)].toFixed(2), p5: +s[Math.floor(a.length * 0.05)].toFixed(2), p95: +s[Math.floor(a.length * 0.95)].toFixed(2), sd: +sd.toFixed(2), skew: +skew.toFixed(2), sum: +a.reduce((x, y) => x + y, 0).toFixed(1) };
};

console.log(`=== 樣本: ${T.length} 喺 closed (${new Date(T[0].openedAt).toISOString().slice(0, 10)} → ${new Date(T[T.length - 1].closedAt).toISOString().slice(0, 10)}) ===\n`);

// ── 1. 全體 + 最近 50 喺 ──
const all = T.map(pct);
console.log('1. 全體分佈:', JSON.stringify(stats(all)));
console.log('   最近50喺 :', JSON.stringify(stats(T.slice(-50).map(pct))));
const wins = all.filter(x => x > 0), losses = all.filter(x => x <= 0);
console.log(`   WR=${(wins.length / all.length * 100).toFixed(0)}%  avgWin=${stats(wins).mean}%  avgLoss=${stats(losses).mean}%  盈虧比=${(stats(wins).mean / Math.abs(stats(losses).mean)).toFixed(2)}`);

// ── 2. closeReason 分解——邊個出場類型漏水 ──
console.log('\n2. closeReason 分解（盈利來源/漏水點）:');
const byReason: Record<string, number[]> = {};
for (const t of T) { const r = t.closeReason || 'unknown'; (byReason[r] ??= []).push(pct(t)); }
for (const [r, a] of Object.entries(byReason).sort((x, y) => y[1].length - x[1].length)) {
  const s = stats(a);
  console.log(`   ${r.padEnd(22)} n=${String(s.n).padStart(3)}  sum=${String(s.sum).padStart(8)}%  mean=${String(s.mean).padStart(6)}%  WR=${(a.filter(x => x > 0).length / a.length * 100).toFixed(0)}%`);
}

// ── 3. symbol×side EV 排行（反選擇檢查）──
console.log('\n3. symbol×side EV 排行（n≥5）:');
const bySS: Record<string, number[]> = {};
for (const t of T) { const k = `${t.symbol}|${t.side}`; (bySS[k] ??= []).push(pct(t)); }
const ssRows = Object.entries(bySS).map(([k, a]) => ({ k, ...stats(a) })).filter(r => r.n >= 5).sort((x, y) => (x.mean!) - (y.mean!));
for (const r of ssRows) console.log(`   ${r.k.padEnd(20)} n=${String(r.n).padStart(3)}  EV=${String(r.mean).padStart(7)}%  sum=${String(r.sum).padStart(8)}%  WR=${(r.n && bySS[r.k].filter(x => x > 0).length / r.n * 100).toFixed(0)}%`);

// ── 4. MFE 回吐分析——利潤回吐（profit giveback）──
console.log('\n4. MFE vs 實現——回吐分析（贏單幾多利潤畀返市場）:');
const winners = T.filter((t: any) => pct(t) > 0);
const givebacks = winners.map((t: any) => {
  const mfe = (t.maxValueReached != null && t.entryPrice) ? Math.abs((t.maxValueReached - t.entryPrice) / t.entryPrice) * 100 * (t.side === 'sell' ? -1 : 1) : null;
  const realized = pct(t);
  return mfe != null && mfe > realized ? { realized, mfe, gb: mfe - realized } : null;
}).filter(Boolean) as { realized: number; mfe: number; gb: number }[];
if (givebacks.length) {
  const totalGb = givebacks.reduce((a, g) => a + g.gb, 0);
  const big = givebacks.filter(g => g.gb >= 2);
  console.log(`   贏單 ${givebacks.length} 喂有回吐;總回吐 ${totalGb.toFixed(1)}pp;回吐≥2pp 嘅有 ${big.length} 喂(合計 ${big.reduce((a, g) => a + g.gb, 0).toFixed(1)}pp)`);
  for (const g of [...big].sort((a, b) => b.gb - a.gb).slice(0, 8)) console.log(`     MFE ${g.mfe.toFixed(1)}% → 實收 ${g.realized.toFixed(1)}%  (畀返 ${(g.gb).toFixed(1)}pp)`);
}

// ── 5. 持倉時間 vs 結果 ──
console.log('\n5. 持倉時間分桶:');
const buckets: Record<string, number[]> = { '<15m': [], '15-60m': [], '1-4h': [], '4-24h': [], '>24h': [] };
for (const t of T) {
  const h = (t.closedAt - t.openedAt) / 3_600_000;
  const k = h < 0.25 ? '<15m' : h < 1 ? '15-60m' : h < 4 ? '1-4h' : h < 24 ? '4-24h' : '>24h';
  buckets[k]!.push(pct(t));
}
for (const [k, a] of Object.entries(buckets)) if (a.length) console.log(`   ${k.padEnd(8)} n=${String(a.length).padStart(3)}  EV=${stats(a).mean}%  WR=${(a.filter(x => x > 0).length / a.length * 100).toFixed(0)}%  sum=${stats(a).sum}%`);

// ── 6. OLR 校準（entryOlrPWin vs 實際）──
console.log('\n6. OLR P(win) 校準曲線（entryOlrPWin bucket vs 實際 WR）:');
const ob: Record<string, { w: number; n: number; pnl: number[] }> = {};
for (const t of T) {
  const p = t.entryOlrPWin;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p >= 1) continue;
  const k = `${Math.floor(p * 10) / 10}`;
  (ob[k] ??= { w: 0, n: 0, pnl: [] }); ob[k]!.n++; if (pct(t) > 0) ob[k]!.w++; ob[k]!.pnl.push(pct(t));
}
for (const k of Object.keys(ob).sort()) { const b = ob[k]!; console.log(`   P(win) ${(+k).toFixed(1)}: n=${String(b.n).padStart(3)}  實際WR=${(b.w / b.n * 100).toFixed(0)}%  EV=${stats(b.pnl).mean}%`); }

// ── 7. 信心校準（entryConsensusConfidence）──
console.log('\n7. LLM 信心校準（entryConsensusConfidence bucket vs 實際 WR）:');
const cb: Record<string, { w: number; n: number; pnl: number[] }> = {};
for (const t of T) {
  const c = t.entryConsensusConfidence;
  if (typeof c !== 'number' || !Number.isFinite(c)) continue;
  const k = `${Math.floor(c * 10) / 10}`;
  (cb[k] ??= { w: 0, n: 0, pnl: [] }); cb[k]!.n++; if (pct(t) > 0) cb[k]!.w++; cb[k]!.pnl.push(pct(t));
}
for (const k of Object.keys(cb).sort()) { const b = cb[k]!; console.log(`   conf ${k}: n=${String(b.n).padStart(3)}  實際WR=${(b.w / b.n * 100).toFixed(0)}%  EV=${stats(b.pnl).mean}%`); }

// ── 8. regime × closeReason 交叉——邊個 regime 最多漏水 ──
console.log('\n8. regime 分解:');
const byRegime: Record<string, number[]> = {};
for (const t of T) { const r = t.regime || 'unknown'; (byRegime[r] ??= []).push(pct(t)); }
for (const [r, a] of Object.entries(byRegime).sort((x, y) => y[1].length - x[1].length)) {
  const s = stats(a);
  console.log(`   ${r.padEnd(18)} n=${String(s.n).padStart(3)}  EV=${String(s.mean).padStart(6)}%  WR=${(a.filter(x => x > 0).length / a.length * 100).toFixed(0)}%  sum=${s.sum}%`);
}

// ── 9. 連蝕序列——止蝕時機 ──
console.log('\n9. 連蝕分佈:');
let streak = 0; const streaks: number[] = [];
for (const p of all) { if (p <= 0) streak++; else { if (streak > 0) streaks.push(streak); streak = 0; } }
if (streak > 0) streaks.push(streak);
const sc: Record<number, number> = {};
for (const s of streaks) sc[s] = (sc[s] ?? 0) + 1;
console.log('   streak→次數:', JSON.stringify(sc));
const streakLoss = streaks.reduce((a, s) => a + s, 0);
console.log(`   連蝕合計 ${streakLoss} 喺 / 總蝕單 ${losses.length} 喂——streak ≥3 佔 ${(streaks.filter(s => s >= 3).reduce((a, s) => a + s, 0) / Math.max(1, losses.length) * 100).toFixed(0)}%`);

// ── 10. 小時效應 ──
console.log('\n10. 開倉小時（UTC）EV:');
const byHour: Record<number, number[]> = {};
for (const t of T) { const h = new Date(t.openedAt).getUTCHours(); (byHour[h] ??= []).push(pct(t)); }
const hourRows = Object.entries(byHour).map(([h, a]) => ({ h: +h, ...stats(a) })).filter(r => r.n >= 4).sort((x, y) => y.mean! - x.mean!);
for (const r of hourRows.slice(0, 5)) console.log(`   ${r.hour.padStart(2)}:00 UTC  n=${String(r.n).padStart(3)}  EV=${r.mean}%  WR=${(byHour[+r.hour]!.filter(x => x > 0).length / r.n * 100).toFixed(0)}%`);
for (const r of hourRows.slice(-5)) console.log(`   ${r.hour.padStart(2)}:00 UTC  n=${String(r.n).padStart(3)}  EV=${r.mean}%  WR=${(byHour[+r.hour]!.filter(x => x > 0).length / r.n * 100).toFixed(0)}%`);