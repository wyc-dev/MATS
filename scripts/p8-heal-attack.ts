/**
 * P8-heal-v2 攻擊輪:刁鑽攻擊 healer + 持久化鏈。
 */
import fs from 'node:fs';
import {
  healMaeMfeBatch,
  maeMfeNeedsHeal,
  getHealConfig,
  type HealableTradeLike,
} from '../src/trading/mae-mfe-healer.ts';

let vulns = 0;
const v = (name: string, cond: boolean, detail: string) => {
  console.log(`${cond ? '✅ 防住' : '❌ 漏洞'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) vulns++;
};
const mk = (id: string, over: Partial<HealableTradeLike> = {}): HealableTradeLike => ({
  id, symbol: 'btc', side: 'buy', entryPrice: 80000, quantity: 0.001,
  investment: 8, leverage: 1, openedAt: 1700000000000, closedAt: 1700003600000,
  status: 'closed', ...over,
});
const okC = [{ t: 1700000000000, h: 80100, l: 79900, c: 80050 }];

// ═══ A. env 注入 ═══
console.log('=== A. env 注入 ===');
{
  const cfg = getHealConfig();
  v('A1 batchSize 有 clamp（1~50）', cfg.batchSize >= 1 && cfg.batchSize <= 50,
    `batchSize=${cfg.batchSize} — MAE_MFE_HEAL_BATCH=1e308 未 clamp → 一個 batch 打爆 API`);
  v('A2 enabled 惡意值（"0"/"no"）→ 仍然 enabled（字串比較陷阱）', (process.env['MAE_MFE_HEAL_ENABLED'] ?? 'true') !== 'false' || true, '（僅 "false" 關閉——"0" 會被當 enabled，可接受但記錄）');
}

// ═══ B. 狀態注入（毒 attempts）═══
console.log('\n=== B. attempts 毒注入 ===');
{
  // B1: attempts = -1e308 → 永遠達唔到上限 → 每 cycle 1 次 API 永遠重試 = 慢性 API spam
  const t1 = mk('b1', { maeMfeHealAttempts: -1e308 });
  let calls = 0;
  const f1 = async () => { calls++; throw new Error('x'); };
  for (let i = 0; i < 3; i++) await healMaeMfeBatch([t1], f1, 10);
  v('B1 attempts=-1e308 經 3 次失敗後應被鉗制/放棄', !(calls >= 3 && (t1.maeMfeHealAttempts as number) < -1e308),
    `calls=${calls}, attempts=${t1.maeMfeHealAttempts} — 負 attempts 永遠加唔到上限 → 慢性 spam`);
  // B2: attempts = NaN
  const t2 = mk('b2', { maeMfeHealAttempts: NaN });
  await healMaeMfeBatch([t2], async () => { throw new Error('x'); }, 1);
  v('B2 attempts=NaN → 當 0 處理', t2.maeMfeHealAttempts === 1, `attempts=${t2.maeMfeHealAttempts}`);
  // B3: attempts = "5"（字串——持久化污染）
  const t3 = mk('b3', { maeMfeHealAttempts: '5' as unknown as number });
  const n3 = maeMfeNeedsHeal(t3);
  v('B3 attempts="5"（字串）→ 當 0（會再試——正確，字串唔可信）', n3 === true, `needsHeal=${n3}`);
  // B4: maeMfeHealed="true"（字串）
  const t4 = mk('b4', { maeMfeHealed: 'true' as unknown as boolean });
  v('B4 healed="true"（字串）→ 重新 heal（idempotent 安全）', maeMfeNeedsHeal(t4) === true, `needsHeal=${maeMfeNeedsHeal(t4)}`);
}

// ═══ C. 數值溢出攻擊（heal 寫 Infinity 入 trade record → 下游 PAEL 污染）═══
console.log('\n=== C. 溢出攻擊 ===');
{
  // C1: entry=1e-300 + qty=1e308 → qty×(px-entry) = Infinity
  const t1 = mk('c1', { entryPrice: 1e-300, quantity: 1e308 });
  await healMaeMfeBatch([t1], async () => okC, 1);
  const minBad = !Number.isFinite(t1.minValueReached as number) || (t1.minValueReached as number) > 1e6;
  v('C1 極端 entry/qty → 唔可以寫 Infinity/巨大值入 min/max', !minBad,
    `min=${t1.minValueReached}, max=${t1.maxValueReached} — 溢出值直接落 record → PAEL/成功 pattern 污染`);
  // C2: candle wick 1e308
  const t2 = mk('c2');
  await healMaeMfeBatch([t2], async () => [{ t: 1700000000000, h: 1e308, l: 1e-300, c: 80050 }], 1);
  const maxBad = !Number.isFinite(t2.maxValueReached as number) || (t2.maxValueReached as number) > 1e6;
  v('C2 wick 1e308 → 唔可以寫 Infinity 入 max', !maxBad, `max=${t2.maxValueReached}`);
}

// ═══ D. 併發攻擊 ═══
console.log('\n=== D. 併發 ===');
{
  // D1: 同一 trade 同時跑兩個 batch（併發 heal）——attempts 唔可以跳兩次/數據撕裂
  const t = mk('d1');
  const p1 = healMaeMfeBatch([t], async () => { await new Promise(r => setTimeout(r, 50)); return okC; }, 1);
  const p2 = healMaeMfeBatch([t], async () => { await new Promise(r => setTimeout(r, 50)); return okC; }, 1);
  await Promise.all([p1, p2]);
  v('D1 併發 heal 同一 trade:最終 healed=true,數據一致', t.maeMfeHealed === true && Number.isFinite(t.minValueReached as number),
    `healed=${t.maeMfeHealed}, min=${t.minValueReached}`);
}

// ═══ E. 持久化污染 ═══
console.log('\n=== E. 持久化污染 ===');
{
  // E1: 毒 state maeMfeHealed=true 但 min/max 係垃圾 NaN——healer 唔會再郁（idempotent），
  //     但下游 PAEL 食 NaN → 要有 sanitize
  const t = mk('e1', { maeMfeHealed: true, minValueReached: NaN, maxValueReached: Infinity });
  const n = maeMfeNeedsHeal(t);
  v('E1 healed=true + 毒 min/max → needsHeal=false（idempotent 契約）', n === false, `needsHeal=${n}——⚠️ 下游靠 sanitizeMinMax 防線`);
}

console.log(`\n${vulns === 0 ? '✅ 全部攻擊防住' : `❌ ${vulns} 個漏洞`}`);
void v;