// ─── Q-RL Expectancy Audit (Phase 0.1, v2.0.861) ─────────────────────
//
// 目的:
//   證明 / 量化 Q-RL table 嘅 regime-conditioned expectancy oracle。
//   Q-RL 每個 cell = E[pnlPct | regime × vol × momentum × funding × action],
//   由 aligned shadow + EXP backfill 嘅 reward 以 EWMA 更新。本工具:
//
//   [1] 資料完整性檢查(q-rl-table.json parse + sanitize)
//   [2] 全 populated bucket 地圖 —— 每個 bucket 嘅 BUY/SELL Q + 統計
//   [3] Action 聚合(visit-weighted)——「sell 喺而家狀態分佈下係負期望」
//   [4] 主導 bucket 聚光燈 —— 最高 visit 嘅 bucket(即而家市場狀態)
//   [5] Oracle vs 現實一致性檢查 —— Q-RL 方向訊號 vs tradeHistory 實際
//       real/simulated 交易 expectancy(timestamp 窗口內)
//   [6] 判定:oracle 方向訊號可唔可以作為方向過濾(Phase 1.1/1.2 依據)
//
// ⚠️ 唯讀工具——唔改任何系統狀態,唔 import src/(self-contained,可喺
//    任何 directory 跑)。
//
// 用法:
//   npx tsx scripts/qrl-audit.ts [--min-visits 5] [--recent-days 8] [--json]
//
// 退出碼:0 = 正常完成(含「無足夠數據」判定);1 = 檔案缺失/無法解析。

import fs from 'node:fs';
import path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────

interface QRLState {
  values?: Record<string, number>;
  visits?: Record<string, number>;
  rewardHistory?: Record<string, number[]>;
  totalCycles?: number;
  backfillDone?: boolean;
}

interface CellStats {
  key: string;
  action: 'buy' | 'sell';
  q: number;
  visits: number;
  meanReward: number | null;
  medianReward: number | null;
  stdReward: number | null;
  positiveRate: number | null;
  wilsonLB: number | null;
  tStat: number | null;
  minReward: number | null;
  maxReward: number | null;
}

interface AggStats {
  action: 'buy' | 'sell';
  totalVisits: number;
  populatedCells: number;
  expectancy: number;          // visit-weighted Q
  pooledRewardCount: number;   // total rewards pooled across cells
  meanReward: number | null;   // from all rewards pooled
  stdReward: number | null;
  positiveRate: number | null;
  wilsonLB: number | null;
  tStat: number | null;
}

interface TradeRecord {
  decision?: { action?: string };
  realisedPnl?: number;
  simulatedPnl?: number;
  timestamp?: number;
  regime?: string;
  type?: string;
}

// ─── Stats helpers(production-grade,self-contained)───────────────────

/** Wilson score 95% lower bound for a positive-rate test. */
function wilsonLower(positive: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const phat = positive / n;
  const denom = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / denom;
  const half = z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / denom;
  return Math.max(0, center - half);
}

/** Pooled stats over a finite number array. Returns nulls for empty input. */
function pooledStats(rewards: number[]): {
  mean: number; median: number; std: number; positiveRate: number;
  wilsonLB: number; tStat: number; min: number; max: number; n: number;
} {
  const clean = rewards.filter((r) => typeof r === 'number' && Number.isFinite(r));
  if (clean.length === 0) {
    return { mean: 0, median: 0, std: 0, positiveRate: 0, wilsonLB: 0, tStat: 0, min: 0, max: 0, n: 0 };
  }
  const n = clean.length;
  const sorted = [...clean].sort((a, b) => a - b);
  const mean = clean.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 1
    ? sorted[(n - 1) / 2]!
    : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const variance = clean.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(Math.max(0, variance));
  const positiveRate = clean.filter((r) => r > 0).length / n;
  const wilsonLB = wilsonLower(clean.filter((r) => r > 0).length, n);
  // t-statistic: mean / (std/√n). For n≥30 the normal approx is fine;
  // |t|≥2 ≈ 95% significance either way.
  const tStat = std > 1e-12 ? mean / (std / Math.sqrt(n)) : 0;
  return { mean, median, std, positiveRate, wilsonLB, tStat, min: sorted[0]!, max: sorted[n - 1]!, n };
}

function fmtPct(x: number | null, digits = 2): string {
  if (x === null || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtNum(x: number | null, digits = 4): string {
  if (x === null || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function fmtSigned(x: number | null, digits = 4): string {
  if (x === null || !Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
}

/** Verdict for a mean-expectancy estimate with sample floor. */
function expectancyVerdict(n: number, mean: number | null, wilsonLB: number | null): string {
  if (mean === null || n < 5) return '⚠️ 樣本不足';
  if (wilsonLB !== null && wilsonLB > 0.50 && mean > 0) return '✅ 正期望';
  if (wilsonLB !== null && wilsonLB > 0.50 && mean < 0) return '❌ 負期望';
  if (mean > 0) return '➖ 正(未達統計顯著)';
  if (mean < 0) return '➖ 負(未達統計顯著)';
  return '➖ 中性';
}

// ─── Loaders ──────────────────────────────────────────────────────────

function loadJson<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) {
    console.error(`✖ 找不到 ${filePath} — 系統未運行過 ${label}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    console.error(`✖ ${filePath} 無法解析(可能係 interrupted write 導致 partial JSON): ${err instanceof Error ? err.message : String(err)}`);
    console.error('  請檢查檔案完整性,或等系統下次 atomic save 覆寫。');
    process.exit(1);
  }
}

function parseArgs(argv: string[]): { minVisits: number; recentDays: number; json: boolean } {
  let minVisits = 5;
  let recentDays = 8;
  let json = false;
  const mvIdx = argv.indexOf('--min-visits');
  if (mvIdx >= 0) {
    const parsed = Number.parseInt(argv[mvIdx + 1] ?? '5', 10);
    if (Number.isFinite(parsed) && parsed >= 0) minVisits = parsed;
    else console.warn(`⚠️ 忽略無效 --min-visits 值 "${argv[mvIdx + 1] ?? '(missing)'}" — 使用預設 5`);
  }
  const rdIdx = argv.indexOf('--recent-days');
  if (rdIdx >= 0) {
    const parsed = Number.parseInt(argv[rdIdx + 1] ?? '8', 10);
    if (Number.isFinite(parsed) && parsed > 0) recentDays = parsed;
    else console.warn(`⚠️ 忽略無效 --recent-days 值 "${argv[rdIdx + 1] ?? '(missing)'}" — 使用預設 8`);
  }
  if (argv.includes('--json')) json = true;
  return { minVisits, recentDays, json };
}

// ─── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const { minVisits, recentDays, json } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const qrlPath = path.join(root, 'data/evolution/q-rl-table.json');
  const evoPath = path.join(root, 'data/evolution/evolution-state.json');

  const qrl = loadJson<QRLState>(qrlPath, 'Q-RL table');

  // ── [1] 資料完整性 ────────────────────────────────────────────────
  const values = qrl.values ?? {};
  const visits = qrl.visits ?? {};
  const rewardHistory = qrl.rewardHistory ?? {};
  const totalCycles = qrl.totalCycles ?? 0;

  const keys = Object.keys(values);
  const populatedKeys = keys.filter((k) => {
    const v = visits[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  });

  if (!json) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Q-RL EXPECTANCY AUDIT (Phase 0.1)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  totalCycles=${totalCycles} | cells=${keys.length} | populated(visits>0)=${populatedKeys.length} | backfillDone=${qrl.backfillDone === true}`);
    console.log(`  min-visits 門檻=${minVisits} | 現實一致性窗口=${recentDays} 日`);
    console.log('');
  }

  if (populatedKeys.length === 0) {
    console.log('  ⚠️ Q-RL table 無任何 populated cell — oracle 未有數據(冷啟動)。');
    console.log('  結論:Phase 1.1/1.2 嘅 Q-RL 方向訊號暫不可用,需先累積 aligned shadow rewards。');
    process.exit(0);
  }

  // ── [2] 全 bucket 地圖 ────────────────────────────────────────────
  const cells: CellStats[] = [];
  for (const key of populatedKeys) {
    const parts = key.split('|');
    const action = (parts[4] ?? '').toLowerCase();
    if (action !== 'buy' && action !== 'sell') continue;
    const v = values[key];
    const n = visits[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const rewards = Array.isArray(rewardHistory[key]) ? rewardHistory[key] : [];
    const clean = rewards.filter((r) => typeof r === 'number' && Number.isFinite(r));
    let meanReward: number | null = null;
    let medianReward: number | null = null;
    let stdReward: number | null = null;
    let positiveRate: number | null = null;
    let wilsonLB: number | null = null;
    let tStat: number | null = null;
    let minReward: number | null = null;
    let maxReward: number | null = null;
    if (clean.length > 0) {
      const ps = pooledStats(clean);
      meanReward = ps.mean; medianReward = ps.median; stdReward = ps.std;
      positiveRate = ps.positiveRate; wilsonLB = ps.wilsonLB; tStat = ps.tStat;
      minReward = ps.min; maxReward = ps.max;
    }
    cells.push({
      key, action, q: v, visits: n, meanReward, medianReward, stdReward,
      positiveRate, wilsonLB, tStat, minReward, maxReward,
    });
  }
  cells.sort((a, b) => b.visits - a.visits);

  if (!json) {
    console.log('─'.repeat(78));
    console.log(`  [2] 全 populated bucket 地圖(按 visit 降序,>${minVisits} visits 先有統計)`);
    console.log('─'.repeat(78));
    console.log('  bucket'.padEnd(44), 'action'.padEnd(6), 'Q%'.padStart(7), 'n'.padStart(6), 'mean%'.padStart(8), 'pos%'.padStart(6), 'WilLB'.padStart(6), '|t|'.padStart(5));
    for (const c of cells) {
      const bucket = c.key.slice(0, c.key.lastIndexOf('|'));
      const statsOk = c.visits >= minVisits && c.meanReward !== null;
      console.log(
        `  ${bucket.padEnd(42)} ${c.action.padEnd(5)} ${(c.q * 100).toFixed(3).padStart(7)} ${String(c.visits).padStart(6)}` +
        (statsOk
          ? ` ${(c.meanReward! * 100).toFixed(3).padStart(8)} ${(c.positiveRate! * 100).toFixed(0).padStart(5)}% ${(c.wilsonLB! * 100).toFixed(1).padStart(5)}% ${Math.abs(c.tStat!).toFixed(1).padStart(5)}`
          : '  —(樣本不足)—'),
      );
    }
  }

  // ── [3] Action 聚合(visit-weighted)───────────────────────────────
  const agg: AggStats[] = (['buy', 'sell'] as const).map((action) => {
    const actionCells = cells.filter((c) => c.action === action);
    const totalVisits = actionCells.reduce((s, c) => s + c.visits, 0);
    // Visit-weighted expectancy from EWMA Q values
    const expectancy = totalVisits > 0
      ? actionCells.reduce((s, c) => s + c.q * c.visits, 0) / totalVisits
      : 0;
    // Pooled reward stats across all rewards of this action
    let pooled: ReturnType<typeof pooledStats> | null = null;
    const allRewards: number[] = [];
    for (const c of actionCells) {
      const rh = rewardHistory[c.key];
      if (Array.isArray(rh)) allRewards.push(...rh);
    }
    const cleanRewards = allRewards.filter((r) => typeof r === 'number' && Number.isFinite(r));
    if (cleanRewards.length > 0) pooled = pooledStats(cleanRewards);
    return {
      action, totalVisits, populatedCells: actionCells.length, expectancy,
      pooledRewardCount: cleanRewards.length,
      meanReward: pooled?.mean ?? null,
      stdReward: pooled?.std ?? null,
      positiveRate: pooled?.positiveRate ?? null,
      wilsonLB: pooled?.wilsonLB ?? null,
      tStat: pooled?.tStat ?? null,
    };
  });

  if (!json) {
    console.log('');
    console.log('─'.repeat(78));
    console.log('  [3] Action 聚合(visit-weighted expectancy — 全 bucket 合併)');
    console.log('─'.repeat(78));
    for (const a of agg) {
      console.log(`  ${a.action.toUpperCase().padEnd(6)} visits=${String(a.totalVisits).padStart(7)} cells=${String(a.populatedCells).padStart(3)} expectancy=${fmtSigned(a.expectancy * 100, 3)}%/trade`);
      if (a.meanReward !== null && a.tStat !== null) {
        console.log(`        pooled rewards: n=${a.pooledRewardCount} mean=${fmtSigned(a.meanReward * 100, 3)}% std=${fmtNum(a.stdReward, 4)} positive=${fmtPct(a.positiveRate, 0)} WilsonLB=${fmtPct(a.wilsonLB, 1)} t=${fmtSigned(a.tStat, 1)}`);
      }
    }
  }

  // ── [4] 主導 bucket 聚光燈 ───────────────────────────────────────
  if (!json) {
    console.log('');
    console.log('─'.repeat(78));
    console.log('  [4] 主導 bucket 聚光燈(最高 visit 嘅 state bucket = 而家市場狀態)');
    console.log('─'.repeat(78));
  }
  // group cells by bucket
  const byBucket = new Map<string, CellStats[]>();
  for (const c of cells) {
    const bucket = c.key.slice(0, c.key.lastIndexOf('|'));
    const arr = byBucket.get(bucket);
    if (arr) arr.push(c); else byBucket.set(bucket, [c]);
  }
  const bucketTotals = [...byBucket.entries()]
    .map(([bucket, arr]) => ({ bucket, visits: arr.reduce((s, c) => s + c.visits, 0), cells: arr }))
    .sort((a, b) => b.visits - a.visits);
  const dominant = bucketTotals[0];

  const spotlight: Array<{ label: string; n: number; q: number; mean: number | null; wilsonLB: number | null; t: number | null; posRate: number | null }> = [];
  if (dominant) {
    if (!json) console.log(`  主導 bucket: ${dominant.bucket} (total visits=${dominant.visits})`);
    for (const action of ['buy', 'sell'] as const) {
      const cell = dominant.cells.find((c) => c.action === action);
      if (cell) {
        spotlight.push({
          label: action.toUpperCase(),
          n: cell.visits,
          q: cell.q,
          mean: cell.meanReward,
          wilsonLB: cell.wilsonLB,
          t: cell.tStat,
          posRate: cell.positiveRate,
        });
        const statsOk = cell.visits >= minVisits && cell.meanReward !== null;
        if (!json) {
          console.log(`    ${action.toUpperCase().padEnd(6)} Q=${(cell.q * 100).toFixed(3)}% n=${cell.visits}`);
          if (statsOk) {
            console.log(`          pooled: mean=${fmtSigned(cell.meanReward! * 100, 3)}% median=${fmtSigned(cell.medianReward! * 100, 3)}% [${fmtSigned(cell.minReward! * 100, 2)},${fmtSigned(cell.maxReward! * 100, 2)}] positive=${fmtPct(cell.positiveRate, 0)} WilsonLB=${fmtPct(cell.wilsonLB, 1)} t=${fmtSigned(cell.tStat, 1)}`);
          }
        }
      }
    }
    // 主導 bucket 方向判定
    const buyS = spotlight.find((s) => s.label === 'BUY');
    const sellS = spotlight.find((s) => s.label === 'SELL');
    if (buyS && sellS && !json) {
      console.log('');
      const verdict = buyS.q > sellS.q ? 'oracle 偏好 BUY(買方期望值較高)' : sellS.q > buyS.q ? 'oracle 偏好 SELL(賣方期望值較高)' : 'oracle 中性';
      const spread = (buyS.q - sellS.q) * 100;
      console.log(`    方向訊號: BUY−SELL spread = ${fmtSigned(spread, 3)}pp → ${verdict}`);
    }
  } else if (!json) {
    console.log('  (無 populated bucket)');
  }

  // ── [5] Oracle vs 現實一致性檢查 ────────────────────────────────
  const reality: Record<'buy' | 'sell', { n: number; wins: number; pnl: number; regimeSet: Set<string> }> = {
    buy: { n: 0, wins: 0, pnl: 0, regimeSet: new Set() },
    sell: { n: 0, wins: 0, pnl: 0, regimeSet: new Set() },
  };
  if (fs.existsSync(evoPath)) {
    const evo = loadJson<{ tradeHistory?: TradeRecord[] }>(evoPath, 'evolution state');
    const history = Array.isArray(evo.tradeHistory) ? evo.tradeHistory : [];
    const cutoff = Date.now() - recentDays * 86400000;
    for (const h of history) {
      const action = (h.decision?.action ?? '').toLowerCase();
      if (action !== 'buy' && action !== 'sell') continue;
      if (typeof h.timestamp === 'number' && h.timestamp < cutoff) continue;
      const pnl = Number.isFinite(h.realisedPnl) ? h.realisedPnl
        : Number.isFinite(h.simulatedPnl) ? h.simulatedPnl : NaN;
      if (!Number.isFinite(pnl)) continue;
      const target = reality[action];
      target.n++;
      if (pnl > 0) target.wins++;
      target.pnl += pnl;
      if (h.regime) target.regimeSet.add(h.regime);
    }
  } else if (!json) {
    console.log('  (evolution-state.json 不存在 — 跳過現實一致性檢查)');
  }

  if (!json) {
    console.log('');
    console.log('─'.repeat(78));
    console.log(`  [5] Oracle vs 現實一致性檢查(tradeHistory,最近 ${recentDays} 日)`);
    console.log('─'.repeat(78));
    for (const side of ['buy', 'sell'] as const) {
      const r = reality[side];
      if (r.n === 0) {
        console.log(`  ${side.toUpperCase().padEnd(6)} 無 ${recentDays} 日內交易`);
        continue;
      }
      console.log(`  ${side.toUpperCase().padEnd(6)} n=${String(r.n).padStart(3)} winRate=${fmtPct(r.wins / r.n, 0)} totalPnl=${fmtSigned(r.pnl, 3)} avg=${fmtSigned(r.pnl / r.n * 100, 3)}%/trade regimes=[${[...r.regimeSet].join(',')}]`);
    }
    const rb = reality.buy, rs = reality.sell;
    if (rb.n > 0 && rs.n > 0) {
      const oracleSpread = agg.find((a) => a.action === 'buy')!.expectancy - agg.find((a) => a.action === 'sell')!.expectancy;
      const realitySpread = rb.pnl / rb.n - rs.pnl / rs.n;
      const agree = (oracleSpread > 0 && realitySpread > 0) || (oracleSpread < 0 && realitySpread < 0);
      console.log('');
      console.log(`  oracle spread (buy−sell expectancy) = ${fmtSigned(oracleSpread * 100, 3)}pp`);
      console.log(`  reality spread (buy−sell avg pnl)   = ${fmtSigned(realitySpread * 100, 3)}pp`);
      console.log(`  方向一致: ${agree ? '✅ 係 — oracle 方向同現實相符,可作為方向訊號' : '❌ 唔係 — oracle 同現實方向相反,Phase 1.1/1.2 需再驗證'}`);
    }
  }

  // ── [6] 判定 ─────────────────────────────────────────────────────
  const buyAgg = agg.find((a) => a.action === 'buy')!;
  const sellAgg = agg.find((a) => a.action === 'sell')!;
  const oracleSpread = buyAgg.expectancy - sellAgg.expectancy;
  const rb2 = reality.buy, rs2 = reality.sell;
  const realitySpread = (rb2.n > 0 && rs2.n > 0) ? (rb2.pnl / rb2.n - rs2.pnl / rs2.n) : null;
  const oracleSaysSellNegative = sellAgg.expectancy < 0;
  const oracleSaysBuyPositive = buyAgg.expectancy > 0;
  const oracleConsistent = realitySpread !== null && ((oracleSpread > 0) === (realitySpread > 0));

  if (!json) {
    console.log('');
    console.log('═'.repeat(78));
    console.log('  [6] 判定 — Q-RL expectancy oracle 診斷結果');
    console.log('═'.repeat(78));
    console.log(`  Q-RL sell expectancy(visit-weighted)= ${fmtSigned(sellAgg.expectancy * 100, 3)}%/trade (visits=${sellAgg.totalVisits})`);
    console.log(`  Q-RL buy  expectancy(visit-weighted)= ${fmtSigned(buyAgg.expectancy * 100, 3)}%/trade (visits=${buyAgg.totalVisits})`);
    if (sellAgg.meanReward !== null && sellAgg.tStat !== null) {
      console.log(`  sell pooled: mean=${fmtSigned(sellAgg.meanReward * 100, 3)}% t=${fmtSigned(sellAgg.tStat, 1)} WilsonLB=${fmtPct(sellAgg.wilsonLB, 1)}`);
    }
    console.log('');
    if (oracleSaysSellNegative) {
      console.log('  ✅ Q-RL 已學到「sell 喺現有狀態分佈下係負期望」— Phase 1.1/1.2 方向訊號有數據支持。');
    } else {
      console.log(`  ⚠️ Q-RL sell expectancy 唔係負數(${fmtSigned(sellAgg.expectancy * 100, 3)}%) — 方向訊號強度需再評估。`);
    }
    if (oracleConsistent && realitySpread !== null) {
      console.log(`  ✅ Oracle 方向同現實(${fmtSigned(realitySpread * 100, 3)}pp spread)一致 — 可作方向過濾。`);
    } else if (realitySpread === null) {
      console.log('  ⚠️ 現實窗口無兩邊交易 — 一致性未能確認,需更多數據。');
    } else {
      console.log('  ⚠️ Oracle 方向同現實相反 — Phase 1.1/1.2 需加樣本門檻 + 保守 multiplier。');
    }
    console.log('');
    console.log('  ⚠️ 註:Q-RL 係 global bucket(非 per-symbol);reward 主要來自 aligned shadow + EXP backfill。');
    console.log('     主導 bucket 以外嘅 cell 樣本少,extrapolation 風險高 — Phase 1.1 注入時應只展示 n≥ 門檻嘅 cell。');
  }

  // JSON 輸出(machine-readable)
  if (json) {
    const out = {
      totalCycles,
      populatedCells: populatedKeys.length,
      backfillDone: qrl.backfillDone === true,
      cells: cells.filter((c) => c.visits >= minVisits).map((c) => ({
        bucket: c.key.slice(0, c.key.lastIndexOf('|')),
        action: c.action,
        q: c.q,
        visits: c.visits,
        meanReward: c.meanReward,
        wilsonLB: c.wilsonLB,
        tStat: c.tStat,
      })),
      actionAgg: agg.map((a) => ({
        action: a.action, totalVisits: a.totalVisits, populatedCells: a.populatedCells,
        expectancy: a.expectancy, meanReward: a.meanReward, wilsonLB: a.wilsonLB, tStat: a.tStat,
      })),
      dominantBucket: dominant ? {
        bucket: dominant.bucket,
        visits: dominant.visits,
        buy: spotlight.find((s) => s.label === 'BUY') ?? null,
        sell: spotlight.find((s) => s.label === 'SELL') ?? null,
      } : null,
      reality: {
        windowDays: recentDays,
        buy: { n: rb2.n, winRate: rb2.n > 0 ? rb2.wins / rb2.n : null, totalPnl: rb2.pnl, avgPnl: rb2.n > 0 ? rb2.pnl / rb2.n : null, regimes: [...rb2.regimeSet] },
        sell: { n: rs2.n, winRate: rs2.n > 0 ? rs2.wins / rs2.n : null, totalPnl: rs2.pnl, avgPnl: rs2.n > 0 ? rs2.pnl / rs2.n : null, regimes: [...rs2.regimeSet] },
        oracleConsistent,
      },
      verdict: {
        sellNegativeExpectancy: oracleSaysSellNegative,
        buyPositiveExpectancy: oracleSaysBuyPositive,
        oracleConsistent,
        recommendation: oracleSaysSellNegative && oracleConsistent
          ? 'USE_QRL_DIRECTION_SIGNAL'
          : 'REVALIDATE',
      },
    };
    console.log(JSON.stringify(out, null, 2));
  }
}

main();
