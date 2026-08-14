/**
 * v2.0.869(主神 動態鎖利調查):兩層動態鎖利驗證——用 200 Supabase trade
 *
 * 驗證:
 *  1. 層 1(條件 threshold):唔同 regime 嘅 MFE 行為——有冇數據支持?
 *  2. 層 2(閉環校準):過早率——有冇數據支持?
 *  3. 模擬「兩層動態」vs「固定」——比較 pnl——有冇明顯改善?
 */
import { execSync } from 'node:child_process';

interface ApiTrade {
  symbol: string;
  side: string;
  investment: number;
  pnl: number;
  pnlPct: number;
  minValueReached?: number;
  maxValueReached?: number;
  entryMarketFeatures?: { regimeOrdinal?: number };
}

function loadTrades(): ApiTrade[] {
  const raw = execSync('curl -s http://localhost:3456/api/trades', { timeout: 10000 }).toString();
  return JSON.parse(raw) as ApiTrade[];
}

function regimeName(ord: number): string {
  if (ord < 0.33) return 'mean_reverting';
  if (ord < 0.66) return 'sideways';
  return 'trending';
}

function main(): void {
  const trades = loadTrades();
  console.log('══════════════════════════════════════════════════════');
  console.log('兩層動態鎖利驗證(v2.0.869)——200 Supabase trade');
  console.log('══════════════════════════════════════════════════════');

  // 清洗:移除 MFE 負值/異常(HL pnl 修復前污染)
  const clean: Array<{ t: ApiTrade; maePct: number; mfePct: number; regime: string }> = [];
  for (const t of trades) {
    const inv = Number(t.investment);
    const min = Number(t.minValueReached);
    const max = Number(t.maxValueReached);
    if (!Number.isFinite(inv) || inv <= 0) continue;
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const maePct = (min - inv) / inv * 100;
    const mfePct = (max - inv) / inv * 100;
    if (mfePct < 0 || maePct > 0) continue; // 數據污染
    const ord = Number(t.entryMarketFeatures?.regimeOrdinal);
    const regime = Number.isFinite(ord) ? regimeName(ord) : 'sideways';
    clean.push({ t, maePct, mfePct, regime });
  }
  console.log(`清洗後樣本: ${clean.length}/${trades.length}`);
  console.log('');

  // ── 層 1 驗證:唔同 regime 嘅 MFE 行為 ──
  console.log('══════════════════════════════════════════════════════');
  console.log('層 1 驗證:唔同 regime 嘅 MFE 分布(條件 threshold 有冇數據支持?)');
  console.log('══════════════════════════════════════════════════════');
  const byRegime: Record<string, number[]> = { mean_reverting: [], sideways: [], trending: [] };
  for (const s of clean) byRegime[s.regime]!.push(s.mfePct);
  for (const r of ['mean_reverting', 'sideways', 'trending']) {
    const arr = byRegime[r]!.sort((a, b) => a - b);
    if (arr.length === 0) { console.log(`  ${r.padEnd(15)} n=0`); continue; }
    const med = arr[Math.floor(arr.length / 2)];
    const p75 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.75))];
    console.log(`  ${r.padEnd(15)} n=${String(arr.length).padStart(3)} median MFE=${med.toFixed(2)}% p75=${p75.toFixed(2)}%`);
  }
  console.log('');

  // ── 層 2 驗證:MFE 有但蝕——鎖利後 price 行為 ──
  console.log('══════════════════════════════════════════════════════');
  console.log('層 2 驗證:MFE 有但蝕(俾返晒)——閉環校準有冇數據支持?');
  console.log('══════════════════════════════════════════════════════');
  const lockCandidates = clean.filter(s => s.mfePct > 0 && s.t.pnl < 0);
  const lockLoss = lockCandidates.reduce((a, s) => a + Math.abs(Number(s.t.pnl)), 0);
  console.log(`MFE 有但蝕: ${lockCandidates.length} 個——總蝕 $${lockLoss.toFixed(2)}`);
  // 模擬鎖利(喺 MFE 峰值 close——保守 70%)
  let lockSaved = 0;
  for (const s of lockCandidates) {
    const inv = Number(s.t.investment);
    const lockPnlUsd = s.mfePct * 0.7 / 100 * inv;
    const saved = lockPnlUsd - Number(s.t.pnl);
    if (saved > 0) lockSaved += saved;
  }
  console.log(`模擬鎖利(保守 70% MFE):慳 $${lockSaved.toFixed(2)}`);
  console.log('');

  // ── 模擬:兩層動態 vs 固定 ──
  console.log('══════════════════════════════════════════════════════');
  console.log('模擬:兩層動態 vs 固定(比較 pnl)');
  console.log('══════════════════════════════════════════════════════');
  // 固定:MFE ≥ 1.5×ATR 且回吐 ≥ 50% → 鎖利(ATR 用 1% 近似)
  // 兩層動態:層 1(regime threshold)+ 層 2(閉環校準)
  const FIXED_ATR = 0.01; // 1% 近似
  let fixedLockCount = 0;
  let fixedSaved = 0;
  let dynamicLockCount = 0;
  let dynamicSaved = 0;
  for (const s of clean) {
    const inv = Number(s.t.investment);
    const pnl = Number(s.t.pnl);
    if (s.mfePct <= 0 || pnl >= 0) continue;
    // 固定:MFE ≥ 1.5×ATR 且回吐 ≥ 50%(假設回吐 100%——因為蝕)
    if (s.mfePct >= 1.5 * FIXED_ATR * 100) {
      fixedLockCount++;
      const lockPnl = s.mfePct * 0.7 / 100 * inv;
      if (lockPnl - pnl > 0) fixedSaved += lockPnl - pnl;
    }
    // 兩層動態:層 1(regime threshold)+ 層 2(閉環——假設過早率 0.3 → mult 1.0)
    const regimeMult = s.regime === 'mean_reverting' ? 1.0 : s.regime === 'trending' ? 1.5 : 1.2;
    const threshold = 1.5 * FIXED_ATR * 100 * regimeMult;
    if (s.mfePct >= threshold) {
      dynamicLockCount++;
      const lockPnl = s.mfePct * 0.7 / 100 * inv;
      if (lockPnl - pnl > 0) dynamicSaved += lockPnl - pnl;
    }
  }
  console.log(`固定鎖利: ${fixedLockCount} 個——慳 $${fixedSaved.toFixed(2)}`);
  console.log(`兩層動態: ${dynamicLockCount} 個——慳 $${dynamicSaved.toFixed(2)}`);
  console.log(`差異: ${dynamicLockCount - fixedLockCount} 個 trade——慳 $${(dynamicSaved - fixedSaved).toFixed(2)}`);
  console.log('');

  // ── 驗證結論 ──
  console.log('══════════════════════════════════════════════════════');
  console.log('驗證結論(Google Tech Lead——數據支持先實施)');
  console.log('══════════════════════════════════════════════════════');
  const mr = byRegime.mean_reverting!;
  const tr = byRegime.trending!;
  if (mr.length >= 10 && tr.length >= 10) {
    const mrMed = mr.sort((a, b) => a - b)[Math.floor(mr.length / 2)];
    const trMed = tr.sort((a, b) => a - b)[Math.floor(tr.length / 2)];
    if (trMed > mrMed * 1.2) {
      console.log(`✅ 層 1 有數據支持:trending median MFE ${trMed.toFixed(2)}% > mean_reverting ${mrMed.toFixed(2)}%——trending 鎖遲啲有根據`);
    } else {
      console.log(`⚠️ 層 1 數據唔明顯:trending ${trMed.toFixed(2)}% vs mean_reverting ${mrMed.toFixed(2)}%——差異 < 20%——層 1 可能冇用`);
    }
  } else {
    console.log(`⚠️ 層 1 樣本不足(mean_reverting n=${mr.length}/trending n=${tr.length})`);
  }
  if (lockCandidates.length >= 10) {
    console.log(`✅ 層 2 有數據支持:${lockCandidates.length} 個「MFE 有但蝕」——鎖利可慳 $${lockSaved.toFixed(2)}——閉環校準有根據`);
  } else {
    console.log(`⚠️ 層 2 樣本不足`);
  }
  if (dynamicSaved > fixedSaved * 1.1) {
    console.log(`✅ 兩層動態明顯改善:慳 $${dynamicSaved.toFixed(2)} vs 固定 $${fixedSaved.toFixed(2)}——改善 ${((dynamicSaved / fixedSaved - 1) * 100).toFixed(0)}%`);
  } else {
    console.log(`⚠️ 兩層動態改善唔明顯:慳 $${dynamicSaved.toFixed(2)} vs 固定 $${fixedSaved.toFixed(2)}——差異 < 10%——可能唔值得加複雜度`);
  }
}

main();
