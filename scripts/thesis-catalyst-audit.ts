// ─── Thesis Catalyst Audit (Phase 0.1) — v2.0.863 ─────────────────────
//
// 核心驗證:「LLM 世界模型(新聞/宏觀推理)有冇真 alpha?」
// 方法:過去 real trades 嘅 entryThesis → classifyThesisCatalyst →
//       A 組(有 catalyst)vs B 組(冇 catalyst)→ 比較勝率/median/avg。
// 驗證門:A 組 median 顯著 > B 組 → LLM 世界模型有 edge → Phase 1 落。
//       ❌ 冇分別 → LLM 世界模型冇加值 → 方案改為「新聞直接做 factor」。
//
// ⚠️ 唯讀——唔改任何系統狀態。
// 用法:npx tsx scripts/thesis-catalyst-audit.ts

import fs from 'node:fs';
import path from 'node:path';
import { classifyThesisCatalyst } from '../src/analysis/thesis-catalyst.ts';

interface RealTrade {
  symbol: string;
  side: string;
  entryThesis?: string;
  pnl: number;
  pnlPct: number;
  closedAt: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function main(): void {
  const pfPath = path.join(process.cwd(), 'data/evolution/portfolio-state.json');
  if (!fs.existsSync(pfPath)) { console.error('✖ 找不到 portfolio-state.json'); process.exit(1); }
  const pf = JSON.parse(fs.readFileSync(pfPath, 'utf-8')) as { realTrades?: RealTrade[] };
  const trades = (pf.realTrades ?? []).filter(t => t && typeof t === 'object' && t.status === 'closed');

  const groups: Record<string, Array<{ sym: string; side: string; pnlPct: number; level: string; evidence: string[] }>> = {
    strong: [], weak: [], none: [],
  };

  let noThesis = 0;
  for (const t of trades) {
    if (!t.entryThesis) { noThesis++; continue; }
    const r = classifyThesisCatalyst(t.entryThesis);
    groups[r.level].push({
      sym: t.symbol, side: t.side, pnlPct: t.pnlPct ?? 0,
      level: r.level, evidence: r.evidence,
    });
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('  THESIS CATALYST AUDIT (Phase 0.1) — LLM 世界模型有冇 alpha?');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  real trades: ${trades.length} | 冇 thesis: ${noThesis}`);
  console.log('');

  const stat = (g: typeof groups.strong) => {
    if (g.length === 0) return null;
    const pnlPcts = g.map(x => x.pnlPct);
    const wins = pnlPcts.filter(p => p > 0).length;
    return {
      n: g.length,
      winRate: wins / g.length,
      median: median(pnlPcts),
      avg: pnlPcts.reduce((s, p) => s + p, 0) / g.length,
      wins,
    };
  };

  for (const level of ['strong', 'weak', 'none'] as const) {
    const s = stat(groups[level]);
    if (!s) { console.log(`  ${level.padEnd(7)}: 0 trades`); continue; }
    console.log(`  ${level.padEnd(7)}: n=${String(s.n).padStart(3)} | WR=${(s.winRate * 100).toFixed(0)}% | median=${(s.median * 100).toFixed(2)}% | avg=${(s.avg * 100).toFixed(2)}%`);
  }

  // A 組 = strong + weak(有 catalyst);B 組 = none
  const groupA = [...groups.strong, ...groups.weak];
  const groupB = groups.none;
  const sA = stat(groupA);
  const sB = stat(groupB);

  console.log('');
  console.log('─'.repeat(60));
  console.log('  A 組(有 catalyst:strong+weak)vs B 組(冇 catalyst)');
  console.log('─'.repeat(60));
  if (sA && sB) {
    console.log(`  A: n=${sA.n} | WR=${(sA.winRate * 100).toFixed(0)}% | median=${(sA.median * 100).toFixed(3)}% | avg=${(sA.avg * 100).toFixed(3)}%`);
    console.log(`  B: n=${sB.n} | WR=${(sB.winRate * 100).toFixed(0)}% | median=${(sB.median * 100).toFixed(3)}% | avg=${(sB.avg * 100).toFixed(3)}%`);
    const spread = sA.median - sB.median;
    console.log('');
    console.log(`  median spread (A−B): ${(spread * 100).toFixed(3)}%`);
    if (spread > 0.002 && sA.n >= 10) {
      console.log('  ✅ 驗證門 PASS:有 catalyst 嘅 thesis 期望值顯著好過冇 → LLM 世界模型有 edge → Phase 1 落 Catalyst-Aware');
    } else if (spread < -0.002 && sB.n >= 10) {
      console.log('  ❌ 驗證門 FAIL:有 catalyst 嘅 thesis 反而差 → LLM 世界模型冇加值 → 方案改「新聞直接做 factor」');
    } else {
      console.log('  ⚠️ 樣本不足/無顯著差異 → 需要更多數據,或者 LLM 世界模型冇明顯 edge');
    }
  } else {
    console.log('  ⚠️ A 或 B 組樣本不足——無法判定');
  }

  // 抽樣 evidence(strong 例子)
  if (groups.strong.length > 0) {
    console.log('');
    console.log('─'.repeat(60));
    console.log('  STRONG catalyst 例子(頭 5 個)');
    console.log('─'.repeat(60));
    groups.strong.slice(0, 5).forEach(g => {
      console.log(`  [${g.side.toUpperCase()} ${g.sym}] ${g.pnlPct >= 0 ? '✅' : '❌'} ${(g.pnlPct * 100).toFixed(1)}% | ${g.evidence.join(', ')}`);
    });
  }
}

main();
