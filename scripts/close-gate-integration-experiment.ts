/**
 * close-gate-integration-experiment.ts — Phase 2: 層級化整合邏輯實驗
 *
 * 驗證目標:
 *  2.1 算力節省量: 幾多 % 嘅 consensus close 可以由 deterministic pre-filter
 *      （4h/1h momentum proxy）決定,而唔使 call LLM sentinel?
 *  2.2 pre-filter hold 準確率: momentum 明確支持持倉方向時 hold,close 後
 *      價格繼續沿方向行(用「close 後 12h 同向 re-entry 盈利」做 proxy)?
 *  2.3 Skeptics 延遲: 整合後 LLM call 總數降幅估算
 *
 * 用法: npx tsx scripts/close-gate-integration-experiment.ts
 */
import * as fs from 'node:fs';

const p = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const trades = (p.realTrades ?? []) as any[];
const ch = JSON.parse(fs.readFileSync('data/evolution/cycle-history.json', 'utf8'));
const states = (ch?.states ?? []) as Array<{ symbol: string; cycles: Array<{ features: any; ts: number }> }>;

// symbol → cycles（ts 排序）
const symbolCycles = new Map<string, Array<{ features: any; ts: number }>>();
for (const s of states) {
  const cycles = (s.cycles ?? []).filter(c => c && c.features && Number.isFinite(c.ts)).sort((a, b) => a.ts - b.ts);
  if (cycles.length > 0) symbolCycles.set(s.symbol.toLowerCase(), cycles);
}

/** 攞 close 時刻最近嘅 cycle features（proxy 4h/1h momentum） */
function momentumAtClose(symbol: string, closedAt: number): { mShort: number; mLong: number } | null {
  const cycles = symbolCycles.get(symbol.toLowerCase());
  if (!cycles || cycles.length === 0) return null;
  // binary search 最近 ts <= closedAt
  let lo = 0, hi = cycles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cycles[mid]!.ts <= closedAt) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best < 0) return null;
  const f = cycles[best]!.features;
  const ms = Number(f.momentumShort);
  const ml = Number(f.momentumLong);
  if (!Number.isFinite(ms) || !Number.isFinite(ml)) return null;
  return { mShort: ms, mLong: ml };
}

/** close 後 12h 內同 symbol+side 嘅下一個 trade 結果（「close 係錯」proxy） */
function nextTradeAfter(symbol: string, side: string, closedAt: number): { pnl: number; gapH: number } | null {
  const sorted = [...trades].filter(t => t.symbol === symbol && t.side === side).sort((a, b) => Number(a.openedAt) - Number(b.openedAt));
  for (const t of sorted) {
    const gap = Number(t.openedAt) - closedAt;
    if (gap > 0 && gap < 12 * 3_600_000) return { pnl: Number(t.pnl), gapH: gap / 3_600_000 };
    if (gap >= 12 * 3_600_000) break;
  }
  return null;
}

// consensus close（盈利）trades——sentinel/pre-filter 適用範圍
const consensusCloses = trades.filter(t =>
  (t.closeReason === 'consensus' || t.closeReason === 'consensus_reversal') && Number(t.pnl) > 0,
);
console.log(`consensus close（盈利）trades: ${consensusCloses.length}`);

interface Enriched {
  t: any;
  mom: { mShort: number; mLong: number } | null;
  next: { pnl: number; gapH: number } | null;
}
const enriched: Enriched[] = consensusCloses.map(t => ({
  t,
  mom: momentumAtClose(t.symbol, Number(t.closedAt)),
  next: nextTradeAfter(t.symbol, t.side, Number(t.closedAt)),
}));
const withMom = enriched.filter(e => e.mom !== null);
console.log(`有 momentum 數據: ${withMom.length}（close 時刻 proxy）`);

// ── 2.1 算力節省: momentum threshold 掃描 ──
// pre-filter 邏輯: 4h/1h 雙窗（mShort=5-cycle ≈ 時機, mLong=288-cycle ≈ 結構方向）
//   明確支持（兩窗同向, 幅度 ≥ threshold）→ HOLD（唔 call LLM）
//   明確逆轉（兩窗同向逆方向, 幅度 ≥ threshold）→ CLOSE（唔 call LLM）
//   中性/矛盾 → call LLM sentinel
console.log('\n=== 2.1 算力節省掃描（pre-filter 決定比例 vs LLM call 比例）===');
console.log('threshold | 明確支持(HOLD) | 明確逆轉(CLOSE) | pre-filter決定% | 需 call LLM%');
for (const thr of [0.0005, 0.001, 0.002, 0.003, 0.005]) {
  let support = 0, reverse = 0, neutral = 0;
  for (const e of withMom) {
    const { mShort: ms, mLong: ml } = e.mom!;
    const isBuy = e.t.side === 'buy';
    const supportDir = isBuy ? ms > thr && ml > thr : ms < -thr && ml < -thr;
    const reverseDir = isBuy ? ms < -thr && ml < -thr : ms > thr && ml > thr;
    if (supportDir) support++;
    else if (reverseDir) reverse++;
    else neutral++;
  }
  const n = withMom.length;
  const decided = ((support + reverse) / n * 100).toFixed(0);
  const llm = (neutral / n * 100).toFixed(0);
  console.log(`${String(thr).padEnd(9)} | ${String(support).padEnd(13)} | ${String(reverse).padEnd(13)} | ${decided.padEnd(16)} | ${llm}`);
}

// ── 2.2 pre-filter hold 準確率（用 close 後同向 re-entry 盈利做 proxy）──
// 如果 pre-filter 話「明確支持」而系統 close 咗 → 之後同向 re-entry 盈利 = close 係錯（hold 啱）
console.log('\n=== 2.2 pre-filter hold 準確率（close 後 12h 同向 re-entry 結果）===');
const thr = 0.001;
const supportCloses = withMom.filter(e => {
  const { mShort: ms, mLong: ml } = e.mom!;
  return e.t.side === 'buy' ? ms > thr && ml > thr : ms < -thr && ml < -thr;
});
const neutralCloses = withMom.filter(e => {
  const { mShort: ms, mLong: ml } = e.mom!;
  const supportDir = e.t.side === 'buy' ? ms > thr && ml > thr : ms < -thr && ml < -thr;
  const reverseDir = e.t.side === 'buy' ? ms < -thr && ml < -thr : ms > thr && ml > thr;
  return !supportDir && !reverseDir;
});
const base = withMom.filter(e => e.next !== null);
const baseWR = base.filter(e => e.next!.pnl > 0).length / Math.max(1, base.length) * 100;
const supNext = supportCloses.filter(e => e.next !== null);
const supWR = supNext.filter(e => e.next!.pnl > 0).length / Math.max(1, supNext.length) * 100;
const neuNext = neutralCloses.filter(e => e.next !== null);
const neuWR = neuNext.filter(e => e.next!.pnl > 0).length / Math.max(1, neuNext.length) * 100;
console.log(`base（全部 close 後 re-entry WR）: ${baseWR.toFixed(1)}% (n=${base.length})`);
console.log(`pre-filter 話「明確支持」嘅 close 後 re-entry WR: ${supWR.toFixed(1)}% (n=${supNext.length})`);
console.log(`  → 如果 supWR > baseWR: 趨勢支持時 close 係錯（hold 啱）——pre-filter 有預測力`);
console.log(`中性（要 call LLM）close 後 re-entry WR: ${neuWR.toFixed(1)}% (n=${neuNext.length})`);

// ── 2.3 總 LLM call 估算 ──
console.log('\n=== 2.3 整合後 LLM call 估算（per consensus close）===');
const n = withMom.length;
const neutralPct = neutralCloses.length / Math.max(1, n);
// 現狀: Skeptics(100%) + Sentinel(100%) = 2 call/close
// 整合: pre-filter 已決定部分 0 call; 中性部分 Sentinel 1 call; Skeptics 只喺 sentinel CLOSE 後
console.log(`現狀: 2.0 LLM call / close（Skeptics + Sentinel 並行）`);
console.log(`整合: pre-filter 決定 ${(withMom.length - neutralCloses.length)}/${n} = ${((withMom.length - neutralCloses.length) / Math.max(1, n) * 100).toFixed(0)}% → 0 call`);
console.log(`      中性 ${neutralCloses.length}/${n} = ${(neutralPct * 100).toFixed(0)}% → 1 call（Sentinel）`);
console.log(`      保守假設 sentinel 60% 話 CLOSE → Skeptics 額外 ${(neutralPct * 0.6 * 100).toFixed(0)}% call`);
console.log(`      整合後 ≈ ${(neutralPct * 1 + neutralPct * 0.6).toFixed(2)} call/close（由 2.0 降）`);

// ── 2.2b 額外驗證: 「明確支持但系統 close 咗」嘅損失成本 ──
console.log('\n=== 2.2b 「趨勢支持但被 close」嘅機會成本 ===');
const supWithNext = supNext.map(e => ({ e, next: e.next! }));
const supLost = supWithNext.filter(x => x.next.pnl > 0);
const supLostSum = supLost.reduce((s, x) => s + x.next.pnl, 0);
console.log(`趨勢支持時 close 後同向 re-entry 盈利（= close 早咗嘅機會成本）: ${supLost.length} 筆, 合共 $${supLostSum.toFixed(2)}`);
console.log(`趨勢支持時 close 後同向 re-entry 虧損（= close 啱,避免更大損失）: ${supWithNext.length - supLost.length} 筆`);
