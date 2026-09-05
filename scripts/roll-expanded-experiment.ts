/**
 * roll-expanded-experiment.ts — 擴充實驗（831 VERIFY-FIRST）: roll TP/SL vs lock-churn
 *
 * 主神構想: cycle 系統仍覺同向 edge 時, 唔鎖利平倉+追高重開（churn）,
 * 而係持倉期間將 TP/SL 滾動到最新信號階段——食晒成個 trend。
 *
 * 第一輪（scripts/roll-vs-churn-experiment.ts, 9 clusters 重放）:
 *   累計 −83.4pp（2 勝 7 負）——smooth trend（BNB +22pp）勝, stepping/choppy
 *   （SILVER/GOLD −27~−36pp）敗。selection bias: 只睇「有被 lock churn」嘅單。
 *
 * 本輪擴充（修正 selection bias + 判別驗證）:
 *   1. 全樣本: 近 30 日 ALL lock 類 close（exit_price_lock / profit_lock /
 *      regime_reversal_lock）——包括 lock 後冇 re-entry 嘅單（上輪盲區）
 *   2. 每單重放: 由 entry 揸住 roll SL（breakeven → 50% trail）, 離場 = SL hit /
 *      反向真實 trade 開倉（系統 flip 證據, 零 look-ahead）/ 窗口尾
 *   3. D1×D2 判別: chase re-entry（lock 後同向 re-entry 價位對現倉不利 = 追高） ×
 *      smoothness（entry→lock 期間 5m MAE——pullback 深度細 = smooth）
 *   4. 三關（831 §10）: 全樣本 / 兩半穩健 / 剔 outlier
 *
 * 裁決標準: 若「D1∧D2 命中子集」ROLL 優於 ACTUAL 且三關全過 → 條件性實作;
 * 否則維持現狀（churn 係啱嘅——誠實記錄）。
 */
import * as fs from 'fs';

const pf = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
// audit-round2: persisted realTrades 可能含 null/garbage——排序/查詢前對象化（candle 防護層之前）
const trades = (pf.realTrades || []).filter((t: any) => t && typeof t === 'object').slice().sort((a: any, b: any) => (a.openedAt || 0) - (b.openedAt || 0));

const LOCK_REASONS = new Set(['exit_price_lock', 'profit_lock', 'regime_reversal_lock']);
const WINDOW_START = Date.now() - 30 * 86_400_000;
const LEV = 10;
const HOLD_WINDOW_MS = 48 * 3600_000; // lock 後最多揸 48h（窗口尾）

const fmtT = (ts: number) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const candleCache = new Map<string, any[]>();
async function getCandles(coin: string, startTs: number, endTs: number) {
  const key = `${coin}|${startTs}|${endTs}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const raw = coin.includes(':') ? coin : `xyz:${coin}`;
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: raw, interval: '5m', startTime: startTs, endTime: endTs } }),
    });
    const j = await r.json();
    const arr = Array.isArray(j) && j.length ? j.sort((a: any, b: any) => a.t - b.t) : null;
    candleCache.set(key, arr);
    return arr;
  } catch { return null; }
}

/** candle 數值（V10 硬化: HL API 歷史 candle 嘅 OHLC 係 string——831 §13.2③ 教訓; garbage → null） */
function candleNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
/** candle timestamp 安全轉換（garbage → -Infinity, 永遠唔 match） */
function candleTs(c: any): number {
  if (!c || typeof c !== 'object') return -Infinity;
  const n = Number(c.t);
  return Number.isFinite(n) ? n : -Infinity;
}

/** 模擬 roll: entry 揸住, MFE≥0.5% 上移 SL 至 breakeven, MFE≥1% 後 trail 50% */
function simulateRoll(entry: number, side: 'buy' | 'sell', candles: any[], openTs: number, exitBy: { at?: number; type: string } | null, oppOpenTs: number | null) {
  // V11 硬化（audit-round2）: entry 非有限/≤0（負 entry 無意義）→ 唔可以除零; side 白名單
  if (!Number.isFinite(entry) || entry <= 0 || (side !== 'buy' && side !== 'sell')) {
    return { stop: false, pnlPct: 0, exitReason: 'bad-input' };
  }
  const dir = side === 'buy' ? 1 : -1;
  let sl = entry * (1 - dir * 0.015);
  let peak = entry, breakevenArmed = false;
  const startIdx = candles.findIndex((c: any) => candleTs(c) >= openTs - 300_000);
  if (startIdx < 0) return { stop: false, pnlPct: 0, exitReason: 'no-candle' };
  const oppIdx = oppOpenTs ? candles.findIndex((c: any) => candleTs(c) >= oppOpenTs) : -1;
  const endIdx = exitBy?.at ? candles.findIndex((c: any) => candleTs(c) >= exitBy.at) : candles.length;
  const lastIdx = Math.min(endIdx > startIdx ? endIdx : candles.length, oppIdx > startIdx ? oppIdx : candles.length) - 1;
  if (lastIdx < startIdx) return { stop: false, pnlPct: 0, exitReason: 'no-window' };
  let exitPx: number | null = null; let exitReason = 'end';
  for (let i = startIdx; i <= lastIdx; i++) {
    const c = candles[i];
    // V12 硬化: candle element null/垃圾 → 保守退出（唔 crash, 唔靜默 NaN）
    if (!c || typeof c !== 'object') return { stop: false, pnlPct: 0, exitReason: 'bad-candle' };
    const hi = candleNum(c.h), lo = candleNum(c.l), clo = candleNum(c.c);
    if (hi === null || lo === null || clo === null) return { stop: false, pnlPct: 0, exitReason: 'bad-candle' };
    // 2026-09-05 修正（PLAN_tool-integrity-fix）: BREAKEVEN 嘅 MFE 必須方向感知——
    // BUY 睇 candle high / SELL 睇 candle low。原 bug: 雙向都用 high → SELL 永遠唔 arm
    // breakeven → 34% 嘅 SELL 單模擬被扭曲（多咗 SL hit）。
    const mfe = (dir * ((dir > 0 ? hi : lo) - entry)) / entry;
    if (!breakevenArmed && mfe >= 0.005) { sl = entry; breakevenArmed = true; }
    const peakMfe = dir > 0 ? (peak - entry) / entry : (entry - peak) / entry;
    if (peakMfe >= 0.01) sl = entry + dir * 0.5 * peakMfe * entry;
    if (breakevenArmed) sl = dir > 0 ? Math.max(sl, entry) : Math.min(sl, entry);
    peak = dir > 0 ? Math.max(peak, hi) : Math.min(peak, lo);
    if (dir > 0 && lo <= sl) { exitPx = sl; exitReason = 'sl-hit'; break; }
    if (dir < 0 && hi >= sl) { exitPx = sl; exitReason = 'sl-hit'; break; }
    exitPx = clo;
  }
  if (oppIdx > startIdx && exitReason !== 'sl-hit') exitReason = 'opposite-signal';
  if (exitBy?.at && exitReason !== 'sl-hit' && exitReason !== 'opposite-signal') exitReason = 'window-end';
  const pnlPct = ((exitPx! - entry) / entry) * dir * LEV * 100;
  return { stop: exitReason === 'sl-hit', pnlPct, exitReason };
}

/** entry→lock 期間 5m MAE（smoothness proxy——pullback 深度細 = smooth） */
function computeMaeToLock(entry: number, side: 'buy' | 'sell', candles: any[], openTs: number, lockTs: number): number {
  if (!Number.isFinite(entry) || entry === 0) return 0;
  const startIdx = candles.findIndex((c: any) => candleTs(c) >= openTs - 300_000);
  const endIdx = candles.findIndex((c: any) => candleTs(c) >= lockTs);
  if (startIdx < 0 || endIdx <= startIdx) return 0;
  const dir = side === 'buy' ? 1 : -1;
  let worst = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];
    if (!c || typeof c !== 'object') continue;
    const h = candleNum(c.h), l = candleNum(c.l);
    if (h === null || l === null) continue;
    const adverse = dir > 0 ? (entry - l) / entry : (h - entry) / entry;
    if (Number.isFinite(adverse)) worst = Math.max(worst, adverse);
  }
  return worst;
}

(async () => {
  // ── 樣本: 近 30 日全部 lock 類 close ──
  const locks = trades.filter((t: any) =>
    LOCK_REASONS.has(t.closeReason) && t.openedAt >= WINDOW_START && t.closedAt && Number.isFinite(t.pnlPct));
  console.log(`樣本: 近 30 日 lock 類 close = ${locks.length} 單\n`);

  // 每單: 預拉 candle + 搵「後續反向真實 trade」+「同向 re-entry（D1）」
  const results: any[] = [];
  for (let i = 0; i < locks.length; i++) {
    const t = locks[i];
    const sym = t.symbol;
    const openTs = t.openedAt, lockTs = t.closedAt;
    const candleStart = openTs - 3600_000;
    const candleEnd = lockTs + HOLD_WINDOW_MS;
    const candles = await getCandles(sym, candleStart, candleEnd);
    if (!candles) { console.log(`  skip ${sym} ${fmtT(openTs)} (no candle)`); continue; }

    // 反向信號: 之後第一個反向 side real trade 開倉
    const opp = trades.find((x: any) => x.symbol === sym && x.side !== t.side && x.openedAt > lockTs);
    // 同向 re-entry（D1）: lock 後 12h 內同向 trade
    const sameDir = trades.find((x: any) => x.symbol === sym && x.side === t.side && x.openedAt > lockTs && x.openedAt < lockTs + 12 * 3600_000);

    const maeToLock = computeMaeToLock(t.entryPrice, t.side, candles, openTs, lockTs);
    let roll = simulateRoll(t.entryPrice, t.side, candles, openTs, null, opp ? opp.openedAt : null);

    // D1: chase = 同向 re-entry 價位對現倉不利（buy 越買越高 / sell 越賣越低）
    // ⚠️ 2026-09-05 標註（PLAN_tool-integrity-fix）: D1 依賴「lock 之後 12h 內」嘅 re-entry ——
    // 呢個係事後歸因變量（lock 當刻唔可觀測），只可作事後 partition 分析，
    // 唔可以當鎖利當刻已知嘅實時 gate 條件。主實驗（全樣本/兩半/剔 outlier）冇用 D1。
    let d1Chase: boolean | null = null;
    if (sameDir && sameDir.entryPrice && t.entryPrice) {
      d1Chase = t.side === 'buy' ? sameDir.entryPrice > t.entryPrice : sameDir.entryPrice < t.entryPrice;
    }
    // D2: smooth = entry→lock MAE < 0.5%（1.5% SL 嘅 1/3——pullback 唔得深）
    const d2Smooth = maeToLock < 0.005;

    const actual = t.pnlPct * 100;
    results.push({
      symbol: sym, side: t.side, openTs, lockTs, entryPrice: t.entryPrice,
      actual, roll: roll.pnlPct, delta: roll.pnlPct - actual,
      rollExit: roll.exitReason, maeToLock, d1Chase, d2Smooth,
    });
    if ((i + 1) % 25 === 0) console.log(`  ...已處理 ${i + 1}/${locks.length}`);
  }

  // ── 統計 ──
  const stat = (arr: any[], label: string) => {
    if (arr.length === 0) { console.log(`  ${label}: n=0`); return; }
    const sum = arr.reduce((s, r) => s + r.delta, 0);
    const rollSum = arr.reduce((s, r) => s + r.roll, 0);
    const actSum = arr.reduce((s, r) => s + r.actual, 0);
    const rollWin = arr.filter(r => r.roll > 0).length;
    const actWin = arr.filter(r => r.actual > 0).length;
    const rollStop = arr.filter(r => r.rollExit === 'sl-hit').length;
    console.log(`  ${label}: n=${arr.length} | ACTUAL Σ=${actSum.toFixed(1)}% (WR ${(actWin / arr.length * 100).toFixed(0)}%) | ROLL Σ=${rollSum.toFixed(1)}% (WR ${(rollWin / arr.length * 100).toFixed(0)}%) | Δ=${sum.toFixed(1)}pp | ROLL 止蝕率 ${(rollStop / arr.length * 100).toFixed(0)}%`);
    return sum;
  };

  console.log('\n════════ 三關 ─═══════════');
  console.log('關1: 全樣本');
  stat(results, 'all');

  console.log('\n關2: 兩半穩健（時間序前後半）');
  const half = Math.floor(results.length / 2);
  stat(results.slice(0, half), '前一半');
  stat(results.slice(half), '後一半');

  console.log('\n關2b: 剔 outlier（|Δ|>50pp 或 |actual|>30% margin）');
  const noOut = results.filter(r => Math.abs(r.delta) <= 50 && Math.abs(r.actual) <= 30);
  stat(noOut, '剔 outlier');

  console.log('\n════════ D1×D2 診斷（⚠️ 事後歸因——唔具部署資格）════════');
  console.log('D1（lock 後 re-entry 判追價）依賴鎖利後先發生嘅資訊——lock 當刻不可觀測。');
  console.log('以下只係事後 partition 診斷，唔可以作為實時 gate 條件; 主裁決以關1/關2/關2b 為準。');
  const d1t = results.filter(r => r.d1Chase === true);
  const d1f = results.filter(r => r.d1Chase === false);
  const d2t = results.filter(r => r.d2Smooth);
  const d2f = results.filter(r => !r.d2Smooth);
  const both = results.filter(r => r.d1Chase === true && r.d2Smooth);
  console.log('D1=true (chase re-entry):'); stat(d1t, 'chase');
  console.log('D1=false (有利 re-entry):'); stat(d1f, '非 chase');
  console.log('D2=true (smooth, MAE<0.5%):'); stat(d2t, 'smooth');
  console.log('D2=false (stepping, MAE≥0.5%):'); stat(d2f, 'stepping');
  console.log('D1∧D2 (chase AND smooth):'); stat(both, '命中');

  console.log('\n════════ 逐單明細（全部）════════');
  results.sort((a, b) => b.delta - a.delta).forEach(r => {
    console.log(`${r.delta > 0 ? '✅' : '❌'} ${r.symbol} ${r.side} ${fmtT(r.openTs)}→${fmtT(r.lockTs)} actual=${r.actual.toFixed(1)}% roll=${r.roll.toFixed(1)}% Δ=${r.delta.toFixed(1)}pp exit=${r.rollExit} MAE=${(r.maeToLock * 100).toFixed(2)}% d1=${r.d1Chase === null ? '?' : r.d1Chase ? 'chase' : 'favor'} d2=${r.d2Smooth ? 'smooth' : 'step'}`);
  });

  // ── 裁決建議 ──
  const bothDelta = both.reduce((s, r) => s + r.delta, 0);
  const bothN = both.length;
  const hitWR = bothN > 0 ? both.filter(r => r.delta > 0).length / bothN : 0;
  fs.writeFileSync('/tmp/roll-exp-result.json', JSON.stringify({ results, summary: { bothDelta, bothN, hitWR } }));
  // ── 主裁決（audit-round2: 只用唔含 look-ahead 嘅全樣本/兩半/剔 outlier——D1 唔准參與裁決）──
  const allDelta = results.reduce((s, r) => s + r.delta, 0);
  const allN = results.length;
  const allWinRate = allN > 0 ? results.filter(r => r.delta > 0).length / allN : 0;
  fs.writeFileSync('/tmp/roll-exp-result.json', JSON.stringify({ results, summary: { bothDelta, bothN, hitWR, allDelta, allN, allWinRate } }));
  console.log(`\n════════ 裁決 ════════════`);
  console.log(`主裁決（全樣本, 唔含 look-ahead）: n=${allN} Δ=${allDelta.toFixed(1)}pp 勝率 ${(allWinRate * 100).toFixed(0)}%`);
  console.log(`D1∧D2 診斷子集（事後歸因, 唔計入裁決）: n=${bothN} Δ=${bothDelta.toFixed(1)}pp 命中率 ${(hitWR * 100).toFixed(0)}%`);
  if (allN >= 15 && allDelta > 0) {
    console.log('→ 過關（OOS 第四關前只係候選——需 time-locked holdout 再驗證）');
  } else {
    console.log('→ 不過關: 全樣本 Δ 唔正或樣本不足——維持現狀（lock-churn 係啱嘅, 誠實記錄）');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
