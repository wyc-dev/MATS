/**
 * v2.0.870-P16: Plan G Hybrid Penalty Decay 回測——驗證死亡螺旋被打破
 *
 * 量化金融分析師方法:唔係信公式,信數據。重放真實 trade 序列,逐筆模擬
 * 舊規則(idle-only)vs 新規則(hybrid 三通道)嘅 penalty 衰減軌跡。
 *
 * 兩條規則共享同一個簡化假設(公平對比):
 *   - penalty 喺 loss close 時啟動,直到衰減 ≥95% 或下一次 loss(延長 episode)
 *   - 離線冇 edge 數據(combo wilsonLB)——dE = 0。呢個 UNDERSTATE 新規則
 *     收益(真實系統仲有 edge 通道釋放)——係保守下界。
 *
 * 舊規則(idle-only):decay = min(idleGapCycles / 30, 1)
 *   - 任何 trade(win 或 loss)都 reset idle → 只有完全停止交易 30 cycles
 *     (4min × 30 = 2h)先完全衰減。連續交易 → 永遠唔衰減(death spiral)。
 *
 * 新規則(hybrid):score = max(dTime, 0.2·dCW + 0.4·dTime + 0.4·dE)
 *   - dTime 唔理有冇交易都衰減(spiral-break floor)
 *   - 贏錢加速(dWin),idle 一樣計(dIdle)
 *
 * 指標:
 *   1. Penalty burden-hours:Σ (1 − decay) × Δt——越低越好
 *   2. Time-to-95%-recovery per loss——越短越好
 *   3. Spiral windows:loss 後舊規則喺下一次 loss 前從未恢復嘅次數
 *
 * 用法: npx tsx scripts/plan-g-decay-backtest.ts [--state data/evolution/portfolio-state.json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { computeHybridDecayScore, hybridDecayConfigFromEnv } from '../src/analysis/hybrid-penalty-decay.ts';

// ─── Config ────────────────────────────────────────────────────────────────
const CYCLE_MS = 4 * 60 * 1000;          // market-agent-config.json: cyclePeriodMinutes = 4
const GRID_MS = 5 * 60 * 1000;           // 採樣間隔 5 min
const IDLE_FULL_DECAY_CYCLES = 30;       // 舊規則:30 idle cycles 完全衰減
const RECOVERY_TARGET = 0.95;            // 衰減 ≥95% 視為恢復
const HORIZON_MS = 72 * 3600 * 1000;     // 恢復觀察上限 72h

const HYBRID_CFG = hybridDecayConfigFromEnv({}); // 預設值(τ=24h, 20/40/40)

// ─── Types ─────────────────────────────────────────────────────────────────
interface Trade {
  symbol: string;
  side: string;
  pnl: number;
  pnlPct?: number;
  closedAt: number;
}

interface LossRecovery {
  lossAt: number;
  oldRecoveredAt: number | null;   // 舊規則恢復時間(null = 觀察期內未恢復)
  hybridRecoveredAt: number | null;
  interruptedByNextLoss: boolean;
}

interface SymbolResult {
  symbol: string;
  trades: number;
  losses: number;
  burdenHoursOld: number;
  burdenHoursHybrid: number;
  recoveries: LossRecovery[];
  spiralWindows: number;           // 舊規則 interrupted(未恢復就被下次 loss 延長)
}

// ─── Core simulation(純函數,可測)─────────────────────────────────────────

/** 舊規則 decay fraction [0,1]——idle cycles since last trade(integer floor,同生產嘅 perSymbolIdleCycles 計數器一致) */
function oldRuleDecay(nowMs: number, lastTradeAt: number | null): number {
  if (lastTradeAt === null) return 0;
  const idleCycles = Math.max(0, Math.floor((nowMs - lastTradeAt) / CYCLE_MS));
  return Math.min(1, idleCycles / IDLE_FULL_DECAY_CYCLES);
}

/** 新規則 score [0,1]——hybrid(離線保守:edge 通道 = 0) */
function hybridScore(
  nowMs: number,
  lastTradeAt: number | null,
  lastPenaltyEventAt: number | null,
  winsSincePenalty: number,
): number {
  const idleCycles = lastTradeAt === null ? 0 : Math.max(0, Math.floor((nowMs - lastTradeAt) / CYCLE_MS));
  const r = computeHybridDecayScore({
    idleCycles,
    lastPenaltyEventAt,
    winsSincePenalty,
    edgeWilsonLB: null,       // 離線冇 combo 數據 → 保守下界
    edgeSamples: 0,
    edgeMedianPnlPct: null,
    edgeEwmaPnlPct: null,
    now: nowMs,
  }, HYBRID_CFG);
  return r.score;
}

function simulateSymbol(symbol: string, trades: Trade[]): SymbolResult {
  const sorted = trades.slice().sort((a, b) => a.closedAt - b.closedAt);
  const recoveries: LossRecovery[] = [];
  let burdenOld = 0;
  let burdenHybrid = 0;

  let lastTradeAt: number | null = null;
  let lastPenaltyAt: number | null = null;
  let wins = 0;
  let pending: LossRecovery[] = [];
  let prevT: number | null = null;

  // 時間軸 = 全部 trade 時間 + 5-min grid(覆蓋 trade 之間嘅空白)
  const t0 = sorted[0]!.closedAt;
  const tN = sorted[sorted.length - 1]!.closedAt;
  const timeline: Array<{ t: number; trade: Trade | null }> = [];
  for (const tr of sorted) timeline.push({ t: tr.closedAt, trade: tr });
  for (let g = t0 + GRID_MS; g < tN; g += GRID_MS) timeline.push({ t: g, trade: null });
  timeline.sort((a, b) => a.t - b.t || (a.trade ? -1 : 1));

  for (const ev of timeline) {
    const t = ev.t;

    // 累積 penalty burden(上一段時間)
    if (prevT !== null && lastPenaltyAt !== null) {
      const dt = (t - prevT) / 3600e3; // hours
      burdenOld += (1 - oldRuleDecay(prevT, lastTradeAt)) * dt;
      burdenHybrid += (1 - hybridScore(prevT, lastTradeAt, lastPenaltyAt, wins)) * dt;
    }
    prevT = t;

    // 檢查恢復(用事件前嘅狀態)
    for (const rec of pending) {
      if (rec.oldRecoveredAt === null && oldRuleDecay(t, lastTradeAt) >= RECOVERY_TARGET) {
        rec.oldRecoveredAt = t;
      }
      if (rec.hybridRecoveredAt === null && hybridScore(t, lastTradeAt, lastPenaltyAt, wins) >= RECOVERY_TARGET) {
        rec.hybridRecoveredAt = t;
      }
      // 超過觀察上限 → 標記未恢復
      if (t - rec.lossAt > HORIZON_MS) {
        if (rec.oldRecoveredAt === null) rec.oldRecoveredAt = -1; // -1 = horizon 內未恢復
        if (rec.hybridRecoveredAt === null) rec.hybridRecoveredAt = -1;
      }
    }
    pending = pending.filter(r => (r.oldRecoveredAt === null || r.hybridRecoveredAt === null) && t - r.lossAt <= HORIZON_MS);

    // 應用 trade(事件後嘅狀態更新)
    if (ev.trade) {
      const isWin = ev.trade.pnl >= 0;
      if (isWin) {
        wins++;
      } else {
        wins = 0;
        lastPenaltyAt = t;
        // 新 loss 延長 episode:未恢復嘅 pending 全部標記 interrupted
        for (const rec of pending) rec.interruptedByNextLoss = true;
        const rec: LossRecovery = { lossAt: t, oldRecoveredAt: null, hybridRecoveredAt: null, interruptedByNextLoss: false };
        pending.push(rec);
        recoveries.push(rec); // 創建時即刻入簿——resolved 後唔會掉失
      }
      lastTradeAt = t;
    }
  }

  return {
    symbol,
    trades: sorted.length,
    losses: recoveries.length,
    burdenHoursOld: burdenOld,
    burdenHoursHybrid: burdenHybrid,
    recoveries,
    spiralWindows: recoveries.filter(r => r.interruptedByNextLoss && (r.oldRecoveredAt === null || r.oldRecoveredAt === -1)).length,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const stateIdx = argv.indexOf('--state');
  const statePath = stateIdx >= 0 ? argv[stateIdx + 1]! : 'data/evolution/portfolio-state.json';
  if (!existsSync(statePath)) {
    console.error(`❌ state file not found: ${statePath}`);
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { realTrades?: Trade[] };
  const trades = (state.realTrades ?? []).filter(
    t => t && typeof t.symbol === 'string' && Number.isFinite(t.closedAt) && Number.isFinite(t.pnl),
  );
  console.log(`\n📊 Plan G Hybrid Penalty Decay Backtest`);
  console.log(`   trades=${trades.length} · cycle=${CYCLE_MS / 60000}min · τ=${HYBRID_CFG.tauMs / 3600e3}h · 權重 20/40/40(cycle+win/time/edge)`);
  console.log(`   ⚠️ 離線保守下界:edge 通道離線 = 0(真實系統只會更好)\n`);

  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = t.symbol.toLowerCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k)!.push(t);
  }

  const results: SymbolResult[] = [];
  for (const [sym, trs] of bySymbol) {
    results.push(simulateSymbol(sym, trs));
  }

  // ── 每 symbol 表格 ──
  console.log('┌─────────────┬────────┬────────┬──────────────────┬──────────────────┬───────────────────┬────────┐');
  console.log('│ symbol      │ trades │ losses │ burden-h (舊)    │ burden-h (hybrid)│ burden 改善        │ spiral │');
  console.log('├─────────────┼────────┼────────┼──────────────────┼──────────────────┼───────────────────┼────────┤');
  let totTrades = 0, totLosses = 0, totOld = 0, totHyb = 0, totSpiral = 0;
  for (const r of results.sort((a, b) => b.burdenHoursOld - a.burdenHoursOld)) {
    const improve = r.burdenHoursOld > 0
      ? ((r.burdenHoursOld - r.burdenHoursHybrid) / r.burdenHoursOld * 100)
      : 0;
    console.log(
      `│ ${r.symbol.padEnd(11)} │ ${String(r.trades).padStart(6)} │ ${String(r.recoveries.length).padStart(6)} │ ` +
      `${r.burdenHoursOld.toFixed(2).padStart(16)} │ ${r.burdenHoursHybrid.toFixed(2).padStart(16)} │ ` +
      `${(improve.toFixed(1) + '%').padStart(17)} │ ${String(r.spiralWindows).padStart(6)} │`,
    );
    totTrades += r.trades; totLosses += r.recoveries.length;
    totOld += r.burdenHoursOld; totHyb += r.burdenHoursHybrid; totSpiral += r.spiralWindows;
  }
  console.log('├─────────────┼────────┼────────┼──────────────────┼──────────────────┼───────────────────┼────────┤');
  const totImprove = totOld > 0 ? ((totOld - totHyb) / totOld * 100) : 0;
  console.log(
    `│ TOTAL       │ ${String(totTrades).padStart(6)} │ ${String(totLosses).padStart(6)} │ ` +
    `${totOld.toFixed(2).padStart(16)} │ ${totHyb.toFixed(2).padStart(16)} │ ` +
    `${(totImprove.toFixed(1) + '%').padStart(17)} │ ${String(totSpiral).padStart(6)} │`,
  );
  console.log('└─────────────┴────────┴────────┴──────────────────┴──────────────────┴───────────────────┴────────┘');

  // ── 恢復時間分析 ──
  const allRec = results.flatMap(r => r.recoveries);
  const oldOk = allRec.filter(r => r.oldRecoveredAt !== null && r.oldRecoveredAt > 0);
  const hybOk = allRec.filter(r => r.hybridRecoveredAt !== null && r.hybridRecoveredAt > 0);
  const oldNever = allRec.length - oldOk.length;
  const hybNever = allRec.length - hybOk.length;
  const avgOld = oldOk.length ? oldOk.reduce((s, r) => s + (r.oldRecoveredAt! - r.lossAt), 0) / oldOk.length / 3600e3 : Infinity;
  const avgHyb = hybOk.length ? hybOk.reduce((s, r) => s + (r.hybridRecoveredAt! - r.lossAt), 0) / hybOk.length / 3600e3 : Infinity;

  console.log(`\n⏱️  恢復時間(loss → decay ≥95%):`);
  console.log(`   舊規則:恢復 ${oldOk.length}/${allRec.length}(${oldNever} 次 72h 內從未恢復)· 平均 ${Number.isFinite(avgOld) ? avgOld.toFixed(1) + 'h' : 'N/A'}`);
  console.log(`   Hybrid:恢復 ${hybOk.length}/${allRec.length}( ${hybOnly(allRec)} 次舊規則冇恢復但 hybrid 有)· 平均 ${Number.isFinite(avgHyb) ? avgHyb.toFixed(1) + 'h' : 'N/A'}`);
  console.log(`   ☠️  Death spiral 窗口(連續蝕 + 舊規則從未恢復):${totSpiral} 個`);

  // ── 判決 ──
  console.log(`\n🎯 判決:`);
  if (totHyb < totOld && avgHyb < avgOld) {
    console.log(`   ✅ Hybrid  burden 降低 ${totImprove.toFixed(1)}% 且恢復更快——死亡螺旋被打破,建議 PLAN_G_HYBRID_DECAY=true`);
  } else if (totHyb <= totOld) {
    console.log(`   ✅ Hybrid burden 唔差過舊規則(${totImprove.toFixed(1)}% 改善)——edge 通道上線後只會更好`);
  } else {
    console.log(`   ⚠️ Hybrid burden 未見改善——檢查 τ/權重`);
  }
  console.log();

  // ── 合成死亡螺旋壓力測試(歷史數據太疏,冇 natural spiral)─────────────
  // 真實 spiral 情境(主神親眼見過嘅 SILVER×2 / SKHX×2 re-open 循環極端版):
  //   Phase 1(0–24h):市況差——每 30min 落單都蝕。兩條規則都唔應該放手
  //     (新 loss 不斷 reset 時鐘——流血中途衰減 = 錯誤,呢個係保護特性)。
  //   Phase 2(24–96h):市況反彈——每 30min 落單都贏。舊規則:gap 30min =
  //     7 idle cycles < 30 → decay 頂多 23% 就被下次 trade reset → 舊 loss 嘅
  //     penalty 永遠壓制住贏錢反彈期 = 真正死亡螺旋。Hybrid:time floor 從
  //     最後一次 loss 起計(冇新 loss 就唔 reset)+ 贏錢加速 → 打破 spiral。
  console.log('🧪 合成死亡螺旋壓力測試:');
  console.log('   Phase 1(t=0–24h):每 30min 落單連蝕 | Phase 2(t=24–96h):每 30min 落單連贏(反彈期)');
  const spiralT0 = 1_800_000_000_000;
  let spWins = 0;
  let spLastPenalty: number | null = null;
  let spLastTrade: number | null = null;
  const rows: string[] = [];
  const tradeEveryMs = 30 * 60e3;
  const endMs = 96 * 3600e3;
  let lastTradeSim = -Infinity;
  for (let i = 0; i <= Math.floor(endMs / CYCLE_MS); i++) {
    const t = spiralT0 + i * CYCLE_MS;
    const hours = (t - spiralT0) / 3600e3;
    // 模擬落單(每 30min 一次)
    if (t - lastTradeSim >= tradeEveryMs) {
      lastTradeSim = t;
      spLastTrade = t;
      if (t - spiralT0 < 24 * 3600e3) {
        spWins = 0;
        spLastPenalty = t;         // Phase 1:蝕
      } else {
        spWins++;                  // Phase 2:贏(唔 reset penalty 時鐘)
      }
    }
    // 採樣(揀 trade 之間嘅中點 = idle 最高峰 = 舊規則最有利嘅一刻)
    if ([0, 12, 24, 30, 36, 48, 60, 72, 96].includes(hours)) {
      const midT = t + 15 * 60e3; // 下次 trade 前 15min
      const oldD = oldRuleDecay(midT, spLastTrade);
      const hybS = hybridScore(midT, spLastTrade, spLastPenalty, spWins);
      rows.push(
        `   t=${hours.toFixed(0).padStart(3)}h ${hours < 24 ? '(連蝕中)' : '(反彈贏錢中)'}  舊規則 decay=${(oldD * 100).toFixed(0).padStart(3)}%  hybrid score=${(hybS * 100).toFixed(0).padStart(3)}%`,
      );
    }
  }
  console.log(rows.join('\n'));
  const t48 = spiralT0 + 48 * 3600e3;
  const t48old = oldRuleDecay(t48, t48 - 29 * 60e3);
  const t48hyb = hybridScore(t48, t48 - 29 * 60e3, spiralT0 + 24 * 3600e3, 4);
  const tauH = HYBRID_CFG.tauMs / 3600e3;
  const floorPct = (1 - Math.exp(-24 / tauH)) * 100; // 最後 loss 起 24h 嘅 time floor
  console.log(`   ☠️  t=48h(反彈贏咗 24h):舊規則 penalty 仲壓制 ${(100 - t48old * 100).toFixed(0)}%(spiral)vs hybrid 已釋放 ${(t48hyb * 100).toFixed(0)}%(time floor ${floorPct.toFixed(0)}% + wins 加速)`);
}

function hybOnly(recs: LossRecovery[]): number {
  return recs.filter(r =>
    (r.oldRecoveredAt === null || r.oldRecoveredAt === -1) &&
    (r.hybridRecoveredAt !== null && r.hybridRecoveredAt > 0),
  ).length;
}

main();
