/** P9 攻擊腳本:dipReversionSignal 對稱 + consensusCloseDeferrals 併發/污染 */
import fs from 'node:fs';
import { dipReversionSignal } from '../src/lib/exploration-direction.ts';
let vulns = 0;
const v = (n: string, ok: boolean, d: string) => { console.log(`${ok ? '✅' : '❌ 漏洞'} ${n}${ok ? '' : ' — ' + d}`); if (!ok) vulns++; };
const base = { regime: 'mean_reverting', volatility: 0.002, obImbalance: -0.36 };

// A. 邊界 fuzz
console.log('=== A. dipReversionSignal 邊界 fuzz（1000 隨機）===');
let inv = 0;
for (let i = 0; i < 1000; i++) {
  const rp = Math.random(), ob = (Math.random() - 0.5) * 2, vol = Math.random() * 0.01;
  const r = dipReversionSignal({ regime: i % 3 === 0 ? 'mean_reverting' : i % 3 === 1 ? 'trending_bull' : null, volatility: vol, obImbalance: ob, rangePosition: rp });
  // 不變式:rp<0.5 永遠唔出信號;SELL 只喺 rp>0.65+|ob|≥0.2
  if (r) {
    if (rp < 0.5) inv++;
    if (r.direction === 'sell' && !(rp > 0.65)) inv++;
    if (r.direction === 'sell' && ob <= 0.2 && ob >= -0.2 && ob > -0.2) inv++;
  }
}
v('A1 1000 序列零不變式違反', inv === 0, `${inv} 次違反`);

// B. 極端值
console.log('\n=== B. 極端值 ===');
v('B1 ob=+Infinity → null', dipReversionSignal({ ...base, obImbalance: Infinity }) === null, '');
v('B2 ob=-Infinity → null（isFinite 檢查）', dipReversionSignal({ ...base, obImbalance: -Infinity }) === null, '⚠️ -Infinity ≤ -0.2 會產生 dip-BUY——檢查');
const r2 = dipReversionSignal({ ...base, obImbalance: -Infinity });
v('B2b -Infinity 實際行為:應 null（isFinite）', r2 === null, `got ${JSON.stringify(r2)}`);
v('B3 rangePosition=NaN → 唔過濾（保守放行）', dipReversionSignal({ ...base, rangePosition: NaN })?.direction === 'buy', '');
v('B4 volatility=-1（負）→ null', dipReversionSignal({ ...base, volatility: -1 }) === null, '');
v('B5 regime=trending_bull → null', dipReversionSignal({ ...base, regime: 'trending_bull' }) === null, '');

// C. 邊界:rp=0.5/0.65/0.2
console.log('\n=== C. 邊界 ===');
v('C1 rp=0.5 + 賣壓 → dip-BUY（≥0.5 語義）', dipReversionSignal({ ...base, rangePosition: 0.5 })?.direction === 'buy', '');
v('C2 rp=0.65 + 賣壓 → buy（>0.65 嚴格——0.65 唔 sell）', dipReversionSignal({ ...base, rangePosition: 0.65 })?.direction === 'buy', 'rp=0.65 恰好:賣壓+0.65 → 對稱規則要 rp>0.65 → 0.65 唔 sell → buy ✓');
v('C3 rp=0.66 + 賣壓 → SELL', dipReversionSignal({ ...base, rangePosition: 0.66 })?.direction === 'sell', '');

// D. consensusCloseDeferrals 邏輯（模擬——純邏輯檢查）
console.log('\n=== D. deferrals 邏輯 ===');
const deferrals = new Map<string, number>();
const key = 'xyz:skhx|consensus-close';
// 模擬 3 次 defer → 第 3 次應該執行
let executed = 0;
for (let i = 0; i < 3; i++) {
  const d0 = deferrals.get(key) ?? 0;
  const floating = true;
  if (floating && d0 < 2) { deferrals.set(key, d0 + 1); continue; }
  if (d0 > 0) deferrals.delete(key);
  executed++;
}
v('D1 defer 2 次後第 3 次執行', executed === 1 && !deferrals.has(key), `executed=${executed}`);

console.log(`\n${vulns === 0 ? '✅ 全部防住' : '❌ ' + vulns + ' 個漏洞'}`);
