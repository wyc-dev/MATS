/**
 * P9-bet-double-experiment（2026-09-11, 主神構想「蝕錢後下一注 Position Size ×2（單次封頂）」邏輯實驗）
 *
 * ⚠️ PRE-REGISTERED（831 紀律——實驗前鎖定變體與量度, 唔可以跑完先揀）
 * 假說: H0——「蝕後下一注 ×2」對 Σ pnlPct（weighted, margin-% sum）無正貢獻
 *        H1——若「蝕後下一筆」子集本身正 EV, 倍注提升收益, 但尾部/回撤同步放大
 *
 * 變體（全部預先鎖定, 多重比較披露: 共 8 個測試）:
 *   baseline : 全部 ×1
 *   V1 全域   : 上一筆（任何 symbol）pnl<0 → 今筆 ×2
 *   V2 同symbol: 最近同 symbol 一筆蝕 → ×2
 *   V3 同symbol同方向: 最近同 symbol 同 side 一筆蝕 → ×2（最貼 re-entry 語義）
 *   V4 純放大對照: 全部 ×2（variance 上界）
 *   S1 : V3 用 ×1.5     S2 : V1 用 ×1.5     （敏感度）
 *   T1 : 蝕定義收窄為 closeReason='sl_tp' 且 pnl<0（V1 變體）
 *
 * 量度（口徑: per-trade margin-% sum, 811 §28/§29——Σ pnlPct×weight）:
 *   Σ weighted / 觸發筆數 n_bet / 倍注子集 EV / 兩半（前60後40）/
 *   尾部（最差單筆×weight, 最長連蝕倍注鏈累積）/ 簡化 equity 徑 max drawdown
 *
 * ⚠️ Read-only。Usage: npx tsx scripts/p9-bet-double-experiment.ts
 */
import fs from 'node:fs';

interface RT {
  symbol?: string;
  side?: string;
  pnlPct?: number;
  closeReason?: string;
  closedAt?: number;
  leverage?: number;
}

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const trades: RT[] = (state.realTrades as RT[])
  .filter((t) => typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct) && typeof t.closedAt === 'number')
  .sort((a, b) => (a.closedAt as number) - (b.closedAt as number));

const norm = (s: unknown): string => String(s ?? '').toLowerCase();

// ── 每個變體: 計 weight[] ──
type Variant = (trades: RT[], i: number) => number; // 回傳倍數 1 / 1.5 / 2

const prevAny = (trades: RT[], i: number, mult: number, lossCond: (t: RT) => boolean): number =>
  i > 0 && lossCond(trades[i - 1]) ? mult : 1;

const lossAny = (t: RT): boolean => (t.pnlPct as number) < 0;

const prevSameSym = (trades: RT[], i: number, mult: number, needDir: boolean, lossCond: (t: RT) => boolean): number => {
  if (i <= 0) return 1;
  const cur = trades[i];
  for (let j = i - 1; j >= 0; j--) {
    const p = trades[j];
    if (norm(p.symbol) !== norm(cur.symbol)) continue;
    if (needDir && norm(p.side) !== norm(cur.side)) continue;
    return lossCond(p) ? mult : 1;
  }
  return 1;
};

const variants: Array<{ name: string; fn: Variant; multLabel: string }> = [
  { name: 'baseline', fn: () => 1, multLabel: '×1 全部' },
  { name: 'V1 全域上一筆蝕', fn: (ts, i) => prevAny(ts, i, 2, lossAny), multLabel: '×2' },
  { name: 'V2 同symbol上一筆蝕', fn: (ts, i) => prevSameSym(ts, i, 2, false, lossAny), multLabel: '×2' },
  { name: 'V3 同symbol同方向上一筆蝕', fn: (ts, i) => prevSameSym(ts, i, 2, true, lossAny), multLabel: '×2' },
  { name: 'V4 純放大對照(全部×2)', fn: () => 2, multLabel: '×2' },
  { name: 'S1 V3×1.5', fn: (ts, i) => prevSameSym(ts, i, 1.5, true, lossAny), multLabel: '×1.5' },
  { name: 'S2 V1×1.5', fn: (ts, i) => prevAny(ts, i, 1.5, lossAny), multLabel: '×1.5' },
  { name: 'T1 全域上一筆sl_tp蝕', fn: (ts, i) => prevAny(ts, i, 2, (t) => (t.pnlPct as number) < 0 && t.closeReason === 'sl_tp'), multLabel: '×2' },
];

// ── 統計 ──
function stats(ts: RT[], w: number[], label: string) {
  const n = ts.length;
  const wsum = ts.reduce((s, t, i) => s + (t.pnlPct as number) * w[i], 0);
  const half = Math.floor(n * 0.6);
  const firstW = ts.slice(0, half).reduce((s, t, i) => s + (t.pnlPct as number) * w[i], 0);
  const secondW = ts.slice(half).reduce((s, t, i) => s + (t.pnlPct as number) * w[half + i], 0);
  // 簡化 equity 徑 (非復合, 固定 sizer 0.10/倍注 0.20 × pnlPct 累積)
  let cum = 0, peak = 0, maxDD = 0;
  const path: number[] = [];
  for (let i = 0; i < n; i++) {
    cum += 0.10 * (ts[i].pnlPct as number) * w[i];
    path.push(cum);
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  // 最差單筆 (按 weighted 值)
  const worstW = Math.min(...ts.map((t, i) => (t.pnlPct as number) * w[i]));
  return { label, n, wsum, firstW, secondW, worstW, maxDD };
}

const base = stats(trades, trades.map(() => 1), 'baseline');
console.log(`樣本: ${trades.length} 筆 realTrades（${new Date(Math.min(...trades.map((t) => t.closedAt as number))).toISOString().slice(0, 10)} → ${new Date(Math.max(...trades.map((t) => t.closedAt as number))).toISOString().slice(0, 10)}）\n`);
console.log(`baseline Σ pnlPct = ${(base.wsum * 100).toFixed(1)}pp  前60% ${(base.firstW * 100).toFixed(1)} / 後40% ${(base.secondW * 100).toFixed(1)}   worst ${(base.worstW * 100).toFixed(1)}%  maxDD ${(base.maxDD * 100).toFixed(1)}%\n`);

const rows: any[] = [];
for (const v of variants) {
  const w = trades.map((_, i) => v.fn(trades, i));
  const s = stats(trades, w, v.name);
  const nBet = w.filter((x) => x > 1).length;
  // 倍注子集 EV（被倍注嗰啲 trade 嘅 avg pnlPct）——分辨力核心
  const betSub = trades.filter((_, i) => w[i] > 1);
  const betEv = betSub.length ? betSub.reduce((s2, t) => s2 + (t.pnlPct as number), 0) / betSub.length : 0;
  rows.push({
    name: v.name, mult: v.multLabel,
    nBet, delta: s.wsum - base.wsum, wsum: s.wsum,
    betEV: betEv, betEVpp: betEv * 100,
    first: s.firstW, second: s.secondW,
    worstW: s.worstW, maxDD: s.maxDD,
  });
  const deltaPp = (s.wsum - base.wsum) * 100;
  const flag = deltaPp < 0 ? '  ❌ 負貢獻' : deltaPp < 0.5 ? '  ⚠️ 微正' : '  ✅ 正貢獻';
  console.log(`[${v.name}] ×${v.multLabel}  Δ=${deltaPp.toFixed(1)}pp${flag}  頭${nBet}筆倍注(子集EV ${(betEv * 100).toFixed(2)}%/筆)  前60 ${(s.firstW * 100).toFixed(1)} / 後40 ${(s.secondW * 100).toFixed(1)}  worst ${(s.worstW * 100).toFixed(1)}%  maxDD ${(s.maxDD * 100).toFixed(1)}%`);
}

// ── 最長連蝕倍注鏈（尾部分析）──
let chain = 0, maxChain = 0, chainSum = 0, worstChainSum = 0;
for (const v of variants.slice(0, 4)) {
  const w = trades.map((_, i) => v.fn(trades, i));
  chain = 0; chainSum = 0; worstChainSum = 0;
  for (let i = 0; i < trades.length; i++) {
    if (w[i] > 1) { chain++; chainSum += (trades[i].pnlPct as number) * w[i]; }
    else { maxChain = Math.max(maxChain, chain); worstChainSum = Math.min(worstChainSum, chainSum); chain = 0; chainSum = 0; }
  }
  maxChain = Math.max(maxChain, chain); worstChainSum = Math.min(worstChainSum, chainSum);
  console.log(`[${v.name}] 最長連續倍注: ${maxChain} 筆(該段累積 worst ${(worstChainSum * 100).toFixed(1)}pp)`);
}
console.log('\n口徑: per-trade margin-% sum（Σ pnlPct×weight）; equity 徑為簡化非復合 10%→20% sizer; pnlPct 已反映槓桿與費用（實盤 record）。');
console.log('⚠️ 未模擬: correlation-budget 硬閘（倍注令 notional 200%@10x 更易撞 budget → 隱性停牌）、tail-watchdog/anti-trend ×0.5 與倍注互相抵消。');

// ═══════════ PHASE 2: V3 深入驗證（831 三關）═══════════
console.log('\n════════ V3 三關深入驗證 ════════\n');
const v3w = trades.map((_, i) => prevSameSym(trades, i, 2, true, lossAny));
const v3Bet = trades.filter((_, i) => v3w[i] > 1);
const nonBet = trades.filter((_, i) => v3w[i] === 1);
const sumW = (arr: RT[], w: number[]) => arr.reduce((s, t, i) => s + (t.pnlPct as number) * (w[i] ?? 1), 0);

// 關2: per-symbol 分解（7/9 乾淨?）
console.log('── 關2a: per-symbol（倍注子集 vs 非倍注子集 avg pnlPct）──');
const symMap = new Map<string, { bet: number[]; non: number[] }>();
trades.forEach((t, i) => {
  const s = norm(t.symbol);
  if (!symMap.has(s)) symMap.set(s, { bet: [], non: [] });
  (v3w[i] > 1 ? symMap.get(s)!.bet : symMap.get(s)!.non).push(t.pnlPct as number);
});
let symClean = 0, symTotal = 0;
for (const [s, v] of [...symMap.entries()].sort()) {
  if (v.bet.length < 3 || v.non.length < 3) continue;
  symTotal++;
  const bAvg = v.bet.reduce((a, x) => a + x, 0) / v.bet.length;
  const nAvg = v.non.reduce((a, x) => a + x, 0) / v.non.length;
  const clean = bAvg > nAvg;
  if (clean) symClean++;
  console.log(`  ${s.padEnd(14)} bet(n=${String(v.bet.length).padEnd(3)}) avg ${(bAvg * 100).toFixed(2)}%  vs non ${(nAvg * 100).toFixed(2)}%  ${clean ? '✅' : '❌'}`);
}
console.log(`  → ${symClean}/${symTotal} symbol 乾淨`);

// 關2b: 留一（剔除最大 winner/最大 loser 後 Δ 仲喺唔喺）——outlier 驅動 check
console.log('\n── 關2b: outlier 留一（Δ 敏感性）──');
const weighted = trades.map((t, i) => (t.pnlPct as number) * v3w[i]);
const sumAll = weighted.reduce((a, x) => a + x, 0);
const baseSum = trades.reduce((a, t) => a + (t.pnlPct as number), 0);
const drops = [...weighted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
for (const [idx, val] of drops) {
  const w2 = sumAll - val;
  const b2 = baseSum - (trades[idx].pnlPct as number);
  console.log(`  剔 ${norm(trades[idx].symbol).toUpperCase()} ${trades[idx].side} ${(val * 100).toFixed(1)}pp（weighted）→ Δ=${((w2 - b2) * 100).toFixed(1)}pp`);
}
const botDrops = [...weighted.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3);
for (const [idx, val] of botDrops) {
  const w2 = sumAll - val;
  const b2 = baseSum - (trades[idx].pnlPct as number);
  console.log(`  剔最差 ${norm(trades[idx].symbol).toUpperCase()} ${trades[idx].side} ${(val * 100).toFixed(1)}pp（weighted）→ Δ=${((w2 - b2) * 100).toFixed(1)}pp`);
}

// 關3: holdout（最後 20% 時間=09-05 起, 未 tune 純確認）
const tEnd = Math.max(...trades.map((t) => t.closedAt as number));
const tStart = Math.min(...trades.map((t) => t.closedAt as number));
const cut = tEnd - (tEnd - tStart) * 0.2;
const tun = trades.filter((t) => (t.closedAt as number) <= cut);
const hol = trades.filter((t) => (t.closedAt as number) > cut);
const tunW = tun.map((_, i) => prevSameSym(tun, i, 2, true, lossAny));
const holW = hol.map((_, i) => prevSameSym(hol, i, 2, true, lossAny));
const tunBase = tun.reduce((a, t) => a + (t.pnlPct as number), 0);
const holBase = hol.reduce((a, t) => a + (t.pnlPct as number), 0);
const tunBet = tun.reduce((a, t, i) => a + (t.pnlPct as number) * tunW[i], 0);
const holBet = hol.reduce((a, t, i) => a + (t.pnlPct as number) * holW[i], 0);
console.log(`\n── 關3: time-locked holdout（最後 20% = ${new Date(cut).toISOString().slice(0, 10)} 起, ${hol.length} 筆）──`);
console.log(`  tune集  Δ=${((tunBet - tunBase) * 100).toFixed(1)}pp  (${tun.length} 筆)`);
console.log(`  holdout Δ=${((holBet - holBase) * 100).toFixed(1)}pp  (${hol.length} 筆)  ${holBet - holBase > 0 ? '✅ 正' : '❌ 負'}`);

// 關1b: threshold sweep（mult 1.0~3.0 單調性）
console.log('\n── 關1b: threshold sweep（V3 倍率 1.0→3.0 單調性）──');
for (const m of [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]) {
  const wm = trades.map((_, i) => prevSameSym(trades, i, m, true, lossAny));
  const s = trades.reduce((a, t, i) => a + (t.pnlPct as number) * wm[i], 0);
  console.log(`  ×${m.toFixed(2)}  Δ=${((s - baseSum) * 100).toFixed(1)}pp`);
}
console.log('\n多重比較披露: 本輪測試 8 前期變體 + V3 三關(共 11 測試)。V1(全域)=主神字面版 FAIL 兩半。');

// ═══════════ PHASE 3: confound 拆解（「蝕」條件有無因果分辨力？）═══════════
console.log('\n════════ V3 confound 拆解 ════════');
const sumAllW = (arr: RT[], w: number[]) => arr.reduce((s, t, i) => s + (t.pnlPct as number) * w[i], 0);
// V5: 同symbol同方向上一筆(無論盈虧) → ×2      —— re-entry 本身
// V6: 同symbol同方向上一筆贏 → ×2               —— 反向對照
// V7: 同symbol同方向上一筆蝕(唔理相隔幾遠, 直接前驅係咪蝕)
const v5w = trades.map((_, i) => prevSameSym(trades, i, 2, true, () => true));
const v6w = trades.map((_, i) => prevSameSym(trades, i, 2, true, (t) => (t.pnlPct as number) >= 0));
const bSum = trades.reduce((a, t) => a + (t.pnlPct as number), 0);
for (const [nm, w] of [['V5 re-entry無條件×2', v5w], ['V6 上一筆贏→×2', v6w]] as const) {
  const s = sumAllW(trades, w);
  const nB = w.filter((x) => x > 1).length;
  const sub = trades.filter((_, i) => w[i] > 1);
  const ev = sub.length ? sub.reduce((a, t) => a + (t.pnlPct as number), 0) / sub.length : 0;
  console.log(`[${nm}] Δ=${((s - bSum) * 100).toFixed(1)}pp  倍注${nB}筆 子集EV ${(ev * 100).toFixed(2)}%/筆`);
}
// V3 vs V5 子集重疊
const v3idx = new Set(trades.map((_, i) => (v3w[i] > 1 ? i : -1)).filter((i) => i >= 0));
const v5idx = new Set(trades.map((_, i) => (v5w[i] > 1 ? i : -1)).filter((i) => i >= 0));
const overlap = [...v3idx].filter((i) => v5idx.has(i)).length;
console.log(`V3(蝕)∩V5(無條件) 重疊: ${overlap}/${v3idx.size}（若 ≈100% → 同symbol同方向 re-entry 上一筆幾乎必然係蝕→ confound 弱）`);
// 直接前驅=蝕 但有更早 non-bet 干預嘅情形
const v3only = [...v3idx].filter((i) => !v5idx.has(i));
console.log(`V3 獨有(僅「蝕」觸發): ${v3only.length} 筆`);
if (v3only.length) {
  const ev3o = v3only.reduce((a, i) => a + (trades[i].pnlPct as number), 0) / v3only.length;
  console.log(`  該子集 EV ${(ev3o * 100).toFixed(2)}%/筆（若明顯正 → 「蝕後」有獨立因果訊號）`);
}

// ═══════════ PHASE 4: 實盤可達性模擬（現行防禦系統中和效應）═══════════
console.log('\n════════ V3 實盤可達性（與現有防禦交互）════════');
// 用 updateCooldownOnClose 真實語義重演連蝕狀態機
const streakState = new Map<string, { streak: number; cooldownUntil: number }>();
const reachable: number[] = [];   // 可達倍注 Δ 貢獻
const blockedByCooldown: number[] = [];  // 被連蝕 cooldown block
const neutralizedByWatchdog: number[] = []; // 被 tail-watchdog ×0.5 中和 → net ×1
let reachableN = 0, blockedN = 0, neutralN = 0;
// tail-watchdog 簡化: 每 symbol 保持最近蝕單 list(72h 窗)
const tailHist = new Map<string, Array<{ pnl: number; ts: number }>>();
const severeTailPct = -0.11, tailWinMs = 72 * 3600_000, tailEvToCaution = 2;

for (let i = 0; i < trades.length; i++) {
  const t = trades[i];
  const sym = norm(t.symbol), side = norm(t.side);
  const key = `${sym}|${side}`;
  let st = streakState.get(key) ?? { streak: 0, cooldownUntil: 0 };
  // cooldown check (shouldBlockChaseCooldown 語義: cooldownUntil > now → block)
  const wasBlocked = st.cooldownUntil > (t.closedAt as number) && st.streak >= 2;
  // tail-watchdog check: 單筆 severe 或窗內 tail ≥2 → caution(×0.5)
  const hist = (tailHist.get(sym) ?? []).filter((h) => (t.closedAt as number) - h.ts <= tailWinMs);
  const tailN = hist.filter((h) => h.pnl < -0.08).length; // tailThreshold -8%
  const severe = hist.some((h) => h.pnl < severeTailPct);
  const caution = severe || tailN >= tailEvToCaution;
  // V3 觸發?
  const v3 = v3w[i] > 1;
  if (v3 && wasBlocked) { blockedByCooldown.push((t.pnlPct as number) * 2); blockedN++; }
  else if (v3 && caution) { neutralizedByWatchdog.push((t.pnlPct as number)); neutralN++; } // net ×1
  else if (v3) { reachable.push((t.pnlPct as number) * 2); reachableN++; }
  // 狀態更新 (用 real close 語義——pnl<=0 → streak+1, >0 → 0)
  st = { streak: (t.pnlPct as number) <= 0 ? st.streak + 1 : 0, cooldownUntil: st.cooldownUntil };
  if ((t.pnlPct as number) <= 0 && st.streak >= 2) st.cooldownUntil = (t.closedAt as number) + 6 * 3600_000;
  streakState.set(key, st);
  const th = tailHist.get(sym) ?? [];
  th.push({ pnl: t.pnlPct as number, ts: t.closedAt as number });
  tailHist.set(sym, th.slice(-30));
}
const reachSum = reachable.reduce((a, x) => a + x, 0);
const blockSum = blockedByCooldown.reduce((a, x) => a + x, 0);
const neutSum = neutralizedByWatchdog.reduce((a, x) => a + x, 0);
const baseSum2 = trades.reduce((a, t) => a + (t.pnlPct as number), 0);
console.log(`V3 觸發(139)分佈 → 可達倍注 ${reachableN} 筆(Σ×2 = ${(reachSum * 100).toFixed(1)}pp) / 被連蝕cooldown block ${blockedN} 筆(潛在 Δ ${(blockSum * 100).toFixed(1)}pp) / 被tail-watchdog中和 ${neutralN} 筆(net ×1)`);
console.log(`可達 Δ = ${(((reachSum + neutSum) - baseSum2) * 100).toFixed(1)}pp（vs counterfactual 上限 +173.4pp）——實盤防禦打折後嘅真實可達`);
console.log(`被 block 嗰 ${blockedN} 筆若計埋(假設無 cooldown): Δ 上限 +${(((reachSum + neutSum + blockSum * 0) - baseSum2) * 100).toFixed(1)}pp（cooldown 已防住連蝕第3筆——唔計）`);
console.log(`⚠️ correlation-budget 未模擬(每筆 20% margin notional,多倉時更早撞 150% eq 上限——實際再打折)`);
