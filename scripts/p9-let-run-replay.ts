/** P9-let-run-replay(2026-09-09): BUY 贏單 let-run 精確重放
 *
 * 讀 data/archive/close-path-archive.jsonl(ClosePathRecorder 收集嘅 close 後 24h price path)
 * 對每筆 finalized record 計算:
 *   「如果 close 晚啲 / lock at X% MFE」→ 用真實 post-close path 嘅實際回收 vs 實收。
 *
 * 零 look-ahead: post-close path 係 close 之後先出現嘅真實價格——唔用任何預測。
 *
 * 模型(對 BUY):
 *   - 實收 = pnlPctAtClose
 *   - 「唔早 lock,hold 到 post-close 嘅有利極值」→ potential = (postClose.high - entryPrice)/entryPrice
 *   - 「lock at X×MFE」(保守——唔俾佢行到 100%)→ realized = min(potential, X × mfeAtClosePct)
 *   - gain = realized - 實收(正 = let-run 有增益/負 = 而家 close 更好)
 *   - 「lock at 80% MFE / 50% MFE」兩檔 + 「唔 lock(full path)」一檔。
 *
 * 樣本門檻: n ≥ 30 先裁決(831)——樣本不足輸出「等待累積」。
 */
import fs from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.cwd(), 'data', 'archive', 'close-path-archive.jsonl');
if (!fs.existsSync(FILE)) {
  console.log('⏳ close-path-archive.jsonl 未存在——Close-Path Recorder 由 real trade close 開始收集,2-4 週後有樣本。');
  process.exit(0);
}
const lines = fs.readFileSync(FILE, 'utf-8').split('\n').filter(Boolean);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// 只 BUY 贏單(本驗證目標——SELL 另計)
const buys = recs.filter((r: any) => r?.side === 'buy' && Number.isFinite(r.pnlPctAtClose) && Number.isFinite(r.entryPrice) && r.postClose && Number.isFinite(r.postClose.high));
console.log('close-path 記錄:', recs.length, '| BUY 有 postClose:', buys.length);
if (buys.length < 30) {
  console.log(`⏳ 樣本 ${buys.length} < 30(831 門檻)——等待 Close-Path Recorder 累積(2-4 週)。`);
  process.exit(0);
}

function gain(rec: any, ratio: number): number {
  const potential = Math.max(0, (rec.postClose.high - rec.entryPrice) / rec.entryPrice);
  const cap = (rec.mfeAtClosePct ?? 0) * ratio;
  const realized = Math.min(potential, cap);
  return realized - (rec.pnlPctAtClose ?? 0);
}
const total = (arr: number[]) => arr.reduce((s, x) => s + x, 0);
const g50 = buys.map(r => gain(r, 0.5));
const g80 = buys.map(r => gain(r, 0.8));
const gFull = buys.map(r => gain(r, 1.0));
console.log('=== BUY 贏單 let-run 精確重放(真實 post-close path) ===');
console.log(`實收 avg: ${(buys.reduce((s, r) => s + (r.pnlPctAtClose ?? 0), 0) / buys.length * 100).toFixed(2)}%`);
console.log(`lock 50% MFE: Σ${(total(g50) * 100).toFixed(0)}pp (${g50.filter(x => x > 0.005).length}/${buys.length} 筆有增益)`);
console.log(`lock 80% MFE: Σ${(total(g80) * 100).toFixed(0)}pp (${g80.filter(x => x > 0.005).length} 筆)`);
console.log(`唔 lock(full path): Σ${(total(gFull) * 100).toFixed(0)}pp (${gFull.filter(x => x > 0.005).length} 筆)`);
// 分方向: momentumLong<0(dip——買 tip 相關) vs ≥0
const byDir = (arr: any[]) => {
  const dip = arr.filter((r: any) => Number(r.momentumLongAtClose ?? 0) < 0);
  return dip.length ? dip : null;
};
console.log('── 分方向 subset(如收據有 momentumLong)──');
buys.slice(0, 3).forEach(r => console.log('  sample:', r.symbol, r.id?.slice(0, 8), 'mfe=' + (r.mfeAtClosePct * 100).toFixed(1) + '% mfLong=' + r.momentumLongAtClose));
console.log('裁決(831): 樣本 ≥ 30 且 Σ 正且方向一致 → let-run 有真 alpha —— 交主神決定 A/B/C 落地');
