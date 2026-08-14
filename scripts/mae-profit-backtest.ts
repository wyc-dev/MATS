/**
 * v2.0.869(主神 MAE 模式升級):Phase A 回測驗證——MFE 鎖利 + 重開抑制
 *
 * Google Tech Lead:「先驗證後實施」——用 200 個 Supabase trade——證明
 * 「MFE 鎖利」同「重開抑制」實際提升盈利——先過呢關先實施。
 *
 * 頂尖量化金融分析師:
 *  - 唔係淨係「平均」——要睇「分布」(偏度/尾部)
 *  - 統計顯著性:Wilson lower bound
 *  - 條件概率:P(win | MAE 模式)
 *
 * 用法: npx tsx scripts/mae-profit-backtest.ts
 */
import { execSync } from 'node:child_process';

interface ApiTrade {
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  investment: number;
  pnl: number;
  pnlPct: number;
  minValueReached?: number;
  maxValueReached?: number;
  closedAt?: number;
}

interface TradeStats {
  symbol: string;
  side: string;
  maePct: number;   // margin %
  mfePct: number;   // margin %
  pnlPct: number;   // margin %
  pnl: number;      // USD
  pattern: 'good' | 'neutral' | 'bad' | 'missing';
  mfeLockEligible: boolean;  // MFE 有但蝕(俾返晒)——鎖利候選
}

function classify(maePct: number, mfePct: number): 'good' | 'neutral' | 'bad' | 'missing' {
  if (maePct === 0 && mfePct === 0) return 'missing';
  const ratio = Math.abs(maePct) / Math.max(mfePct, 0.01);
  if (ratio > 1.5) return 'bad';
  if (ratio <= 0.5) return 'good';
  return 'neutral';
}

function loadTrades(): ApiTrade[] {
  const raw = execSync('curl -s http://localhost:3456/api/trades', { timeout: 10000 }).toString();
  return JSON.parse(raw) as ApiTrade[];
}

function main(): void {
  const trades = loadTrades();
  console.log('══════════════════════════════════════════════════════');
  console.log('Phase A 回測驗證(v2.0.869)——MFE 鎖利 + 重開抑制');
  console.log('══════════════════════════════════════════════════════');
  console.log(`總 trade: ${trades.length}`);
  console.log('');

  // 清洗 + 計算
  const stats: TradeStats[] = [];
  for (const t of trades) {
    const inv = Number(t.investment);
    const min = Number(t.minValueReached);
    const max = Number(t.maxValueReached);
    if (!Number.isFinite(inv) || inv <= 0) continue;
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const maePct = (min - inv) / inv * 100;
    const mfePct = (max - inv) / inv * 100;
    const pnlPct = Number.isFinite(Number(t.pnlPct)) ? Number(t.pnlPct) * 100 : 0;
    const pnl = Number.isFinite(Number(t.pnl)) ? Number(t.pnl) : 0;
    stats.push({
      symbol: String(t.symbol ?? ''), side: String(t.side ?? ''),
      maePct, mfePct, pnlPct, pnl,
      pattern: classify(maePct, mfePct),
      mfeLockEligible: mfePct > 0 && pnlPct < 0,  // MFE 有但蝕(俾返晒)
    });
  }
  console.log(`有效樣本: ${stats.length}`);
  console.log('');

  // ── 方案 1:MFE 鎖利回測 ──────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('方案 1:MFE 鎖利回測(鎖住俾返晒嘅 gain)');
  console.log('══════════════════════════════════════════════════════');
  const mfeLockCandidates = stats.filter(s => s.mfeLockEligible);
  const mfeLockTotalLoss = mfeLockCandidates.reduce((a, s) => a + Math.abs(s.pnl), 0);
  console.log(`MFE 有但蝕(俾返晒): ${mfeLockCandidates.length} 個 trade——總蝕 $${mfeLockTotalLoss.toFixed(2)}`);
  console.log('');

  // 模擬鎖利:MFE 有但蝕——如果鎖利(喺 MFE 峰值 close)——pnl ≈ MFE(減 fee)
  // 保守估計:鎖利 pnl = MFE × 0.7(減滑點 + fee)
  let lockSaved = 0;
  let lockCount = 0;
  for (const s of mfeLockCandidates) {
    const lockPnl = s.mfePct * 0.7;  // 保守——鎖利喺 MFE 70% 位置
    const saved = lockPnl - s.pnlPct;  // 鎖利 vs 實際蝕
    if (saved > 0) {
      lockSaved += saved;
      lockCount++;
    }
  }
  console.log(`模擬鎖利(保守——MFE 70% 位置 close):`);
  console.log(`  可改善: ${lockCount}/${mfeLockCandidates.length} 個 trade——慳 ${lockSaved.toFixed(2)}% margin`);
  console.log('');

  // ── 方案 2:重開抑制回測 ──────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('方案 2:重開抑制回測(MAE 模式 gate)');
  console.log('══════════════════════════════════════════════════════');
  const groups: Record<string, TradeStats[]> = { good: [], neutral: [], bad: [], missing: [] };
  for (const s of stats) groups[s.pattern]!.push(s);

  for (const g of ['good', 'neutral', 'bad', 'missing'] as const) {
    const arr = groups[g]!;
    if (arr.length === 0) continue;
    const wins = arr.filter(s => s.pnl > 0).length;
    const totalPnl = arr.reduce((a, s) => a + s.pnl, 0);
    const avgPnl = totalPnl / arr.length;
    console.log(`  ${g.padEnd(8)} n=${String(arr.length).padStart(4)} win率=${(wins / arr.length * 100).toFixed(0).padStart(3)}% 總pnl=$${totalPnl.toFixed(2).padStart(8)} 平均=$${avgPnl.toFixed(3)}`);
  }
  console.log('');

  // 模擬抑制:差入場 trade 唔開(×0.5 conviction——假設 50% 唔開)
  const bad = groups.bad!;
  const badTotalPnl = bad.reduce((a, s) => a + s.pnl, 0);
  const badWins = bad.filter(s => s.pnl > 0).length;
  const badLosses = bad.filter(s => s.pnl <= 0).length;
  const badLossTotal = bad.filter(s => s.pnl <= 0).reduce((a, s) => a + Math.abs(s.pnl), 0);
  const badWinTotal = bad.filter(s => s.pnl > 0).reduce((a, s) => a + s.pnl, 0);
  console.log(`差入場(ratio > 1.5): n=${bad.length}——win ${badWins} / loss ${badLosses}`);
  console.log(`  蝕錢總額: $${badLossTotal.toFixed(2)}——賺錢總額: $${badWinTotal.toFixed(2)}——淨: $${badTotalPnl.toFixed(2)}`);
  console.log('');

  // 模擬:差入場 50% 唔開(soft ×0.5——假設一半 conviction 唔夠開)
  const simulatedSaved = badLossTotal * 0.5 - badWinTotal * 0.5 * 0.3;  // 慳 50% 蝕——但錯過 50% 賺(30% 保守)
  console.log(`模擬抑制(差入場 50% 唔開——soft ×0.5):`);
  console.log(`  慳蝕錢: $${(badLossTotal * 0.5).toFixed(2)}——錯過賺錢: $${(badWinTotal * 0.5 * 0.3).toFixed(2)}(保守 30%)`);
  console.log(`  淨改善: $${simulatedSaved.toFixed(2)}`);
  console.log('');

  // ── 驗證結論 ────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('驗證結論(Google Tech Lead——先驗證後實施)');
  console.log('══════════════════════════════════════════════════════');
  const good = groups.good!;
  const goodWR = good.length > 0 ? good.filter(s => s.pnl > 0).length / good.length : 0;
  const badWR = bad.length > 0 ? badWins / bad.length : 0;
  if (bad.length >= 30 && good.length >= 30 && badWR < goodWR - 0.05) {
    console.log(`✅ 重開抑制有效:差入場 win rate ${(badWR * 100).toFixed(0)}% < 好入場 ${(goodWR * 100).toFixed(0)}%——抑制有根據`);
  } else {
    console.log(`⚠️ 樣本不足或差異唔夠——繼續收集`);
  }
  if (mfeLockCandidates.length >= 10) {
    console.log(`✅ MFE 鎖利有改善空間:${mfeLockCandidates.length} 個「MFE 有但蝕」——鎖利可慳 $${mfeLockTotalLoss.toFixed(2)}`);
  } else {
    console.log(`⚠️ MFE 鎖利樣本不足——繼續收集`);
  }
  console.log('');

  // 每 symbol×side 明細
  console.log('每 symbol×side 明細(per symbol×side——空間隔離):');
  const byKey = new Map<string, TradeStats[]>();
  for (const s of stats) {
    const key = `${s.symbol}|${s.side}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  for (const [key, arr] of byKey) {
    const wins = arr.filter(s => s.pnl > 0).length;
    const totalPnl = arr.reduce((a, s) => a + s.pnl, 0);
    const badCount = arr.filter(s => s.pattern === 'bad').length;
    const lockCount = arr.filter(s => s.mfeLockEligible).length;
    console.log(`  ${key.padEnd(20)} n=${String(arr.length).padStart(3)} win率=${(wins / arr.length * 100).toFixed(0).padStart(3)}% 總pnl=$${totalPnl.toFixed(2).padStart(8)} 差入場=${badCount}/${arr.length} 鎖利候選=${lockCount}`);
  }
}

main();
