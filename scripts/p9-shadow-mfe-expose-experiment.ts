/**
 * P9-shadow-mfe-expose 邏輯實驗（RED/GREEN, 零 look-ahead）
 *
 * 實驗 A（#1）: getStats() avgMfe 計算法——open positions 唔入帳 vs 入帳
 * 實驗 B（#2）: gate 歸因 contribution——agreement 方向框架 vs gate 出手命中語義
 *
 * Run: npx tsx scripts/p9-shadow-mfe-expose-experiment.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data', 'evolution');

// ═════ 實驗 A: avgMfe 計算法對照 ═════
console.log('════ 實驗 A: getStats() avgMfe —— open positions 入帳前後對照 ════');
const shadow = JSON.parse(fs.readFileSync(path.join(DATA, 'shadow-state.json'), 'utf8'));
const positions: any[] = shadow.positions ?? [];
const recentResults: any[] = shadow.recentResults ?? [];

// 依家 code（step1 唔入帳 open mfe）
function currentAvg(): Map<string, { mfe: number; mae: number; n: number }> {
  const m = new Map<string, { mfe: number; mae: number; n: number }>();
  const get = (sym: string) => {
    if (!m.has(sym)) m.set(sym, { mfe: 0, mae: 0, n: 0 });
    return m.get(sym)!;
  };
  for (const p of positions) {
    if (p.status !== 'open') continue;
    const s = get(p.symbol); s.n++;
  }
  for (const p of positions) {
    if (p.status === 'open') continue;
    const s = get(p.symbol); s.n++;
    if (Number.isFinite(p.mfePct)) s.mfe = (s.mfe * (s.n - 1) + p.mfePct) / s.n;
    if (Number.isFinite(p.maePct)) s.mae = (s.mae * (s.n - 1) + p.maePct) / s.n;
  }
  for (const r of recentResults) {
    if (!r || typeof r !== 'object') continue;
    const s = get(r.symbol); s.n++;
    if (Number.isFinite(r.mfePct)) s.mfe = (s.mfe * (s.n - 1) + r.mfePct) / s.n;
    if (Number.isFinite(r.maePct)) s.mae = (s.mae * (s.n - 1) + r.maePct) / s.n;
  }
  return m;
}

// 修正 code（step1 都入帳 open mfe——極值已由 checkPositions 每 cycle 更新,係真實數據）
function fixedAvg(): Map<string, { mfe: number; mae: number; n: number }> {
  const m = new Map<string, { mfe: number; mae: number; n: number }>();
  const get = (sym: string) => {
    if (!m.has(sym)) m.set(sym, { mfe: 0, mae: 0, n: 0 });
    return m.get(sym)!;
  };
  for (const p of positions) {
    if (p.status !== 'open') continue;
    const s = get(p.symbol); s.n++;
    if (Number.isFinite(p.mfePct)) s.mfe = (s.mfe * (s.n - 1) + p.mfePct) / s.n;
    if (Number.isFinite(p.maePct)) s.mae = (s.mae * (s.n - 1) + p.maePct) / s.n;
  }
  for (const p of positions) {
    if (p.status === 'open') continue;
    const s = get(p.symbol); s.n++;
    if (Number.isFinite(p.mfePct)) s.mfe = (s.mfe * (s.n - 1) + p.mfePct) / s.n;
    if (Number.isFinite(p.maePct)) s.mae = (s.mae * (s.n - 1) + p.maePct) / s.n;
  }
  for (const r of recentResults) {
    if (!r || typeof r !== 'object') continue;
    const s = get(r.symbol); s.n++;
    if (Number.isFinite(r.mfePct)) s.mfe = (s.mfe * (s.n - 1) + r.mfePct) / s.n;
    if (Number.isFinite(r.maePct)) s.mae = (s.mae * (s.n - 1) + r.maePct) / s.n;
  }
  return m;
}

const cur = currentAvg();
const fix = fixedAvg();
console.log('symbol       現行 avgMfe  修正 avgMfe  |  現行 avgMae  修正 avgMae  |  修正後差異');
const syms = [...new Set([...cur.keys(), ...fix.keys()])].sort();
for (const sym of syms) {
  const c = cur.get(sym); const f = fix.get(sym);
  if (!c || !f) continue;
  const cm = (c.mfe * 100).toFixed(1).padStart(5);
  const fm = (f.mfe * 100).toFixed(1).padStart(5);
  const ca = (c.mae * 100).toFixed(1).padStart(5);
  const fa = (f.mae * 100).toFixed(1).padStart(5);
  const diff = Math.abs(c.mfe - f.mfe) * 100;
  console.log(`  ${sym.padEnd(10)} ${cm}%      ${fm}%    |  ${ca}%      ${fa}%    |  ΔMFE ${diff.toFixed(2)}pp (n=${f.n})`);
}
console.log('\n→ 通過準則: 有 resolved 樣本 symbol Δ<0.2pp（顯示穩定）; 純 open symbol 由 0.0% 恢復真實');

// ═════ 實驗 B: gate 歸因 contribution 兩種語義對照 ═════
console.log('\n════ 實驗 B: gate 歸因 contribution —— agreement 方向框架 vs gate 出手命中 ════');
let ca;
try { ca = JSON.parse(fs.readFileSync(path.join(DATA, 'component-attribution.json'), 'utf8')); }
catch { console.log('component-attribution.json 讀唔到'); process.exit(0); }
const recs: any[] = ca.records ?? [];

function currentContrib(r: any): number {
  // 現行: signal clamp [0,1]; buy 唔反轉 / sell 反轉
  const signal = Math.max(0, Math.min(1, r.signal));
  const side = String(r.side ?? '').toLowerCase();
  const agreement = side === 'sell' ? 1 - signal : signal;
  return (agreement - 0.5) * 2 * Math.sign(r.pnlPct ?? 0);
}
function gateContrib(r: any): number {
  // 修正: gate 出手語義——raw mult<1 收緊（蝕=啱正,賺=誤傷負）; mult>1 加成（賺=啱正,蝕=錯負）
  const sig = r.signal;
  const pnlSign = Math.sign(r.pnlPct ?? 0);
  if (sig < 1) return -pnlSign;   // 收緊
  if (sig > 1) return pnlSign;    // 加成
  return 0;                        // 中性
}

const gateIds = [...new Set(recs.filter(r => String(r.componentId ?? '').startsWith('gate:')).map(r => r.componentId))].sort();
console.log('gate  component       現行 contrib  修正 contrib  |  Expectancy(confident)  出手數');
for (const id of gateIds) {
  const r = recs.filter(x => x.componentId === id);
  const curC = r.reduce((s, x) => s + currentContrib(x), 0) / r.length;
  const fixC = r.reduce((s, x) => s + gateContrib(x), 0) / r.length;
  // confident expectancy（現行 agreement 框架）
  const confident = r.filter(x => Math.abs(currentContrib(x)) > 0);
  const exp = confident.length ? confident.reduce((s, x) => s + (x.pnlPct ?? 0), 0) / confident.length * 100 : 0;
  const actC = r.filter(x => x.signal !== 1 && x.signal !== undefined).length;
  console.log(`  ${id.padEnd(34)} ${curC.toFixed(3).padStart(8)}   ${fixC.toFixed(3).padStart(8)}  |  ${exp.toFixed(2).padStart(7)}%  ${actC}/${r.length}`);
}
console.log('\n→ mae-pattern 預期: 現行 −0.255（sell 反轉 bias）; 修正後 = 誤傷語義（出手→trade 賺→負）');
console.log('→ gate:four-window 等硬 gate（mult=1.0→signal 1.0）兩語義應相近——hard block 出手後 trade 蝕 = gate 啱');
