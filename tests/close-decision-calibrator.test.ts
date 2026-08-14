// ─── Close-Decision Calibrator Tests (v2.0.866 Phase A) ───────────────
//
//   C1  記錄過濾:只 consensus/thesis_invalidation——SL/PAEL/manual 唔記
//   C2  驗證 side-aware:buy close 後升 → 過早;sell close 後跌 → 過早
//   C3  分級:>1% weight 1.0、>0.5% weight 0.5、0~0.5% neutral 唔計
//   C4  啱 close(反轉)→ correct
//   C5  情境分層(symbol|盈利|趨勢 分開)
//   C6  冷啟動(<20 樣本 → 中性)
//   C7  getCloseMultiplier(>75% → 0.85、>60% → 0.92、else 1.0)
//   C8  窗口校準
//   C9  持久化 + 毒 state
//   C10 malformed input 安全
//   C11 唔會製造「死揸」:SL/thesis 永遠唔掂——consensus 先校準
//   C12 idempotent(驗證一次)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CloseDecisionCalibrator } from '../src/analysis/close-decision-calibrator.ts';

function fresh(): CloseDecisionCalibrator {
  return new CloseDecisionCalibrator('/tmp/cc-' + Math.random() + '.json');
}

test('C1: 記錄過濾——只 consensus/thesis_invalidation', () => {
  const cc = fresh();
  const id1 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
  const id2 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'thesis_invalidation', trendAtClose: 'up' });
  assert.ok(id1, 'consensus 記錄');
  assert.ok(id2, 'thesis_invalidation 記錄');
  // SL/PAEL/manual/reconciliation 唔記——「唔會製造死揸」
  for (const r of ['sl_tp', 'exit_price_lock', 'manual', 'reconciliation']) {
    assert.equal(cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: r, trendAtClose: 'up' }), null, `${r} 唔應該記錄`);
  }
});

test('C2: 驗證 side-aware + C3 分級 + C4 啱 close', () => {
  const cc = fresh();
  // buy close 後升 1.2%(明顯過早 weight 1.0)
  const id1 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
  const st1 = cc as unknown as { state: { pending: Record<string, { verifyWindowSec: number; ts: number }> } };
  st1.state.pending[id1!]!.ts = Date.now() - 40 * 60 * 1000; // 強制到期
  cc.verifyPending(() => 607.2); // +1.2%
  // buy close 後升 0.6%(輕微 weight 0.5)
  const id2 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
  st1.state.pending[id2!]!.ts = Date.now() - 40 * 60 * 1000;
  cc.verifyPending(() => 603.6); // +0.6%
  // buy close 後跌(啱 close)
  const id3 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
  st1.state.pending[id3!]!.ts = Date.now() - 40 * 60 * 1000;
  cc.verifyPending(() => 595); // -0.8%
  // buy close 後微升 0.3%(neutral 唔計)
  const id4 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
  st1.state.pending[id4!]!.ts = Date.now() - 40 * 60 * 1000;
  cc.verifyPending(() => 601.8); // +0.3%
  const st = cc as unknown as { state: { stats: Record<string, { premature: number; correct: number }> } };
  const s = st.state.stats['BNB|win|up'];
  assert.ok(s, 'context 統計存在');
  assert.equal(s.premature, 1.5, '1.0 + 0.5(分級)');
  assert.equal(s.correct, 1, '反轉計 correct');
  // neutral 唔計 → total = premature 1.5 + correct 1 = 2.5(唔含 neutral)
  assert.ok(s.premature + s.correct < 3, 'neutral 冇計入');
});

test('C5: 情境分層——唔同 context 分開', () => {
  const cc = fresh();
  const mk = (symbol: string, pnl: number, trend: string) => cc.recordClose({ symbol, side: 'buy', closePrice: 600, pnlPct: pnl, closeReason: 'consensus', trendAtClose: trend })!;
  // BNB 盈利 up:3 次過早
  for (let i = 0; i < 3; i++) { const id = mk('BNB', 0.01, 'up'); (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000; }
  cc.verifyPending(() => 610);
  // SOL 虧損 down:3 次啱 close
  for (let i = 0; i < 3; i++) { const id = mk('SOL', -0.01, 'down'); (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000; }
  cc.verifyPending(() => 590);
  const st = cc as never as { state: { stats: Record<string, { premature: number; correct: number }> } };
  assert.equal(st.state.stats['BNB|win|up']?.premature, 3, 'BNB win up 過早');
  assert.equal(st.state.stats['SOL|loss|down']?.correct, 3, 'SOL loss down 啱 close');
});

test('C6/C7: 冷啟動中性(樣本 < 20 → 唔影響)+ getCloseMultiplier', () => {
  const cc = fresh();
  assert.equal(cc.getCloseMultiplier('BNB', true, 'up'), 1.0, '零樣本中性');
  // 5 樣本(< 20 門檻)→ 仍中性(唔 apply)
  for (let i = 0; i < 5; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 610); // 全過早
  assert.equal(cc.getCloseMultiplier('BNB', true, 'up'), 1.0, '5 樣本 < 20 → 冷啟動中性');
});

test('C7b: 樣本門檻(≥20 先 apply)', () => {
  const cc = fresh();
  // 12 次過早 + 8 次啱 = 20 樣本,rate 0.6 → 0.92
  for (let i = 0; i < 12; i++) {
    const id = cc.recordClose({ symbol: 'ETH', side: 'sell', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'down' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 97); // sell 後跌 = 過早 ×12
  for (let i = 0; i < 8; i++) {
    const id = cc.recordClose({ symbol: 'ETH', side: 'sell', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'down' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 103); // sell 後升 = 啱 ×8
  assert.equal(cc.getCloseMultiplier('ETH', true, 'down'), 0.92, 'rate 0.6 → 0.92');
});

test('C8: 窗口校準', () => {
  const cc = fresh();
  const st = cc as never as { state: { windowStats: Record<string, { premature: number; correct: number }> } };
  st.state.windowStats['up|w1'] = { premature: 8, correct: 2 };  // 15m 高過早
  st.state.windowStats['up|w2'] = { premature: 2, correct: 8 };  // 30m 低
  const best = cc.getBestVerifyWindow('up');
  assert.equal(best, 15 * 60, '揀過早率最高嘅窗口');
});

test('C9: 持久化 + 毒 state', () => {
  const path = '/tmp/cc-persist-' + Math.random() + '.json';
  const cc = new CloseDecisionCalibrator(path);
  const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
  cc.save();
  const cc2 = new CloseDecisionCalibrator(path);
  cc2.load();
  const st2 = cc2 as never as { state: { pending: Record<string, unknown> } };
  assert.ok(Object.keys(st2.state.pending).length >= 1, 'pending 保留');
  // 毒 state
  const path2 = '/tmp/cc-poison-' + Math.random() + '.json';
  fs.writeFileSync(path2, JSON.stringify({
    pending: { '__proto__': { symbol: 'x' }, bad: { closeId: 'y', symbol: 'BTC' } },
    stats: { '__proto__': { premature: 99 }, 'BTC|win|up': { premature: NaN, correct: -3 } },
    windowStats: { prototype: { premature: 5, correct: 5 } },
    backfillDone: true,
  }), 'utf-8');
  const cc3 = new CloseDecisionCalibrator(path2);
  expectNoThrow(() => cc3.load());
  const cc3State = (cc3 as unknown as { state: { stats: Record<string, unknown> } }).state.stats;
  assert.equal(Object.hasOwn(cc3State, '__proto__'), false);
  assert.ok(Number.isFinite(cc3.getPrematureRate('BTC', true, 'up').rate));
});

test('C10: malformed input 安全', () => {
  const cc = fresh();
  expectNoThrow(() => {
    cc.recordClose({ symbol: '', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
    cc.recordClose({ symbol: 'BNB', side: 'sideways' as never, closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
    cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: NaN, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' });
    cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 0, pnlPct: NaN, closeReason: 'consensus', trendAtClose: 'up' });
    cc.verifyPending(() => NaN);
    cc.verifyPending(() => null);
    cc.getPrematureRate('', true, '');
    cc.getCloseMultiplier('', false, '');
  });
});

test('C11: 唔會製造死揸——consensus 先校準,SL 永遠唔掂', () => {
  const cc = fresh();
  // 大量 consensus close 都過早 → multiplier 會降(0.85)
  // 但係 SL close 永遠唔會被記錄 → 永遠唔會被校準成「唔好止蝕」
  for (let i = 0; i < 20; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 610); // 全過早
  assert.ok(cc.getCloseMultiplier('BNB', true, 'up') < 1.0, 'consensus 過早率高校準');
  // SL close 唔會記錄
  assert.equal(cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 590, pnlPct: -0.01, closeReason: 'sl_tp', trendAtClose: 'down' }), null, 'SL 唔記錄');
});

test('C12: idempotent——驗證一次', () => {
  const cc = fresh();
  const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 600, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
  (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  cc.verifyPending(() => 610);
  cc.verifyPending(() => 615); // 再驗證——pending 已刪——唔會 double count
  const st = cc as never as { state: { stats: Record<string, { premature: number }> } };
  assert.equal(st.state.stats['BNB|win|up']?.premature, 1, '只驗證一次');
});

function expectNoThrow(fn: () => void): void {
  try { fn(); } catch (e) { assert.fail(`should not throw: ${e}`); }
}

test('C13: 路徑感知(主神 edge case)——SELL close 後跌 15min 再升返 → 過早(淨值)', () => {
  const cc = fresh();
  // SELL close @100——之後跌到 98(錯失 2%)——再升到 101(避開 1%)
  const id = cc.recordClose({ symbol: 'BNB', side: 'sell', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'down' })!;
  const st = (cc as never as { state: { pending: Record<string, { ts: number; minPriceSinceClose: number; maxPriceSinceClose: number }> } }).state.pending;
  // 模擬多個 cycle 更新極端:先跌到 98,再升到 101,然後到期
  st[id].ts = Date.now() - 10 * 60000; // 未到期(30min 窗口)
  cc.verifyPending(() => 98);   // cycle 1:更新極端(min=98)
  cc.verifyPending(() => 99);   // cycle 2:極端唔變(min 仍 98)
  cc.verifyPending(() => 101);  // cycle 3:max=101
  st[id].ts = Date.now() - 40 * 60000; // 強制到期
  cc.verifyPending(() => 101);  // 到期驗證:最終價 101(高過 close 100)
  const stats = (cc as never as { state: { stats: Record<string, { premature: number; correct: number }> } }).state.stats;
  const s = stats['BNB|win|down'];
  // 舊單點邏輯:最終 101 > 100(SELL)→ correct
  // 新淨值:MFE=(100-98)/100=2%,MAE=(101-100)/100=1%,net=1% → premature_high
  assert.ok(s, '統計存在');
  assert.equal(s.premature, 1, '路徑感知:MFE-MAE 淨值 1% → 過早(唔係 correct)');
  assert.equal(s.correct, 0);
});

test('C14: 路徑感知——SELL close 後跌但最終冇升返(一直跌)→ 明顯過早', () => {
  const cc = fresh();
  const id = cc.recordClose({ symbol: 'BNB', side: 'sell', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'down' })!;
  const st = (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending;
  st[id].ts = Date.now() - 10 * 60000;
  cc.verifyPending(() => 97);   // 跌
  cc.verifyPending(() => 96);   // 再跌(極端 96)
  st[id].ts = Date.now() - 40 * 60000;
  cc.verifyPending(() => 96.5); // 到期:最終 96.5
  const stats = (cc as never as { state: { stats: Record<string, { premature: number }> } }).state.stats;
  const s = stats['BNB|win|down'];
  // MFE=(100-96)/100=4%,MAE≈0,net=4% → premature_high(weight 1)
  assert.equal(s?.premature, 1, '一路跌 → 明顯過早');
});

test('C15: 路徑感知——BUY close 後升 1.5% 再跌返 → 避開咗回吐(啱 close)', () => {
  const cc = fresh();
  const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
  const st = (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending;
  st[id].ts = Date.now() - 10 * 60000;
  cc.verifyPending(() => 101.5); // 升 1.5%(MFE)
  cc.verifyPending(() => 99);    // 跌返(MAE 1%)
  st[id].ts = Date.now() - 40 * 60000;
  cc.verifyPending(() => 99);    // 到期:最終 99(低過 close)
  const stats = (cc as never as { state: { stats: Record<string, { correct: number }> } }).state.stats;
  const s = stats['BNB|win|up'];
  // MFE=(101.5-100)/100=1.5%,MAE=(100-99)/100=1%,net=0.5% → 邊界(0.5 唔 > 0.5)→ neutral?
  // 再跌多啲:MAE 更大 → net < -0.5 → correct
  const id2 = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
  st[id2].ts = Date.now() - 10 * 60000;
  cc.verifyPending(() => 102);   // 升 2%
  cc.verifyPending(() => 97);    // 跌返 3%
  st[id2].ts = Date.now() - 40 * 60000;
  cc.verifyPending(() => 97);
  const s2 = stats['BNB|win|up'];
  // MFE=2%,MAE=3%,net=-1% → correct
  assert.ok(s2 && s2.correct >= 1, '避開咗大回吐 → 啱 close');
});

// ─── Phase B:二次確認 Hold Gate 測試(v2.0.866)───────────────────────

test('P1: shouldHoldClose — 過早率高 + 盈利 + consensus → hold', () => {
  const cc = fresh();
  // 建立過早率高情境(20 樣本:15 過早 + 5 啱 = 75%)
  for (let i = 0; i < 15; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 103); // 全過早(>1%)
  for (let i = 0; i < 5; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 98); // 5 次啱(反轉)
  assert.equal(cc.shouldHoldClose('BNB', true, 'up', 'consensus'), true, '過早率 75% + 盈利 + consensus → hold');
});

test('P2: shouldHoldClose 唔會死揸 — SL/thesis 唔 hold、虧損唔 hold', () => {
  const cc = fresh();
  // 建立過早率高情境
  for (let i = 0; i < 15; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 103);
  // SL close → 唔 hold(永遠唔掂 SL)
  assert.equal(cc.shouldHoldClose('BNB', true, 'up', 'sl_tp'), false, 'SL 永遠唔 hold');
  // PAEL → 唔 hold
  assert.equal(cc.shouldHoldClose('BNB', true, 'up', 'exit_price_lock'), false, 'PAEL 唔 hold');
  // 虧損 → 唔 hold(止血)
  assert.equal(cc.shouldHoldClose('BNB', false, 'up', 'consensus'), false, '虧損唔 hold');
  // 冷啟動(sample < 20)→ 唔 hold
  assert.equal(fresh().shouldHoldClose('BNB', true, 'up', 'consensus'), false, '冷啟動唔 hold');
});

test('P3: register + process — 見好即收被擋、再次 close 確認執行、超時兜底', () => {
  const cc = fresh();
  cc.registerPendingClose('BNB', 100, 0.75);
  assert.equal(cc.isPendingClose('BNB'), true);
  // cycle 101:agents 冇再 close(confirmed 空)→ 取消(揸住)
  const exec1 = cc.processPendingCloses(101, new Set());
  assert.deepEqual(exec1, [], '冇再 close → 取消(唔執行)');
  assert.equal(cc.isPendingClose('BNB'), false, 'pending 取消');
  // 再次:register + 下 cycle 又 close → 確認執行
  cc.registerPendingClose('BNB', 200, 0.75);
  const exec2 = cc.processPendingCloses(201, new Set(['BNB']));
  assert.deepEqual(exec2, ['BNB'], '再次 close 決定 → 確認執行');
  // 超時:register + 3 cycle 冇再 close → 兜底執行
  cc.registerPendingClose('SOL', 300, 0.75);
  const exec3 = cc.processPendingCloses(303, new Set());
  assert.deepEqual(exec3, ['SOL'], '3 cycle 超時 → 兜底執行');
});

test('P4: getCalibrationBlock 過早率高有警告', () => {
  const cc = fresh();
  for (let i = 0; i < 15; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 103);
  for (let i = 0; i < 5; i++) {
    const id = cc.recordClose({ symbol: 'BNB', side: 'buy', closePrice: 100, pnlPct: 0.01, closeReason: 'consensus', trendAtClose: 'up' })!;
    (cc as never as { state: { pending: Record<string, { ts: number }> } }).state.pending[id].ts = Date.now() - 40 * 60000;
  }
  cc.verifyPending(() => 98);
  const block = cc.getCalibrationBlock('BNB', true, 'up');
  assert.ok(block.includes('CLOSE-DECISION CALIBRATION'));
  assert.ok(block.includes('過早 close 率'));
  assert.ok(block.includes('75%') || block.includes('0.75'), '顯示過早率');
  // 冷啟動 block 空
  assert.equal(fresh().getCalibrationBlock('BNB', true, 'up'), '');
});

// ─── v2.0.869 MFE 鎖利(主神 SKHX MAE=0 調查)──────────────────────────
test('F1: 冇 MFE → 唔鎖利', () => {
  const r = fresh().getMfeLockAdvice('skhx', 'sell', 0, 0.01, 0.5);
  assert.equal(r.shouldLock, false);
});

test('F2: MFE ≥ 2×ATR 且已回吐 ≥ 30% → 鎖利', () => {
  const r = fresh().getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, 0.4);
  assert.equal(r.shouldLock, true);
});

test('F3: MFE ≥ 1.5×ATR 且已回吐 ≥ 50% → 鎖利', () => {
  const r = fresh().getMfeLockAdvice('skhx', 'sell', 0.015, 0.01, 0.6);
  assert.equal(r.shouldLock, true);
});

test('F4: MFE 夠但未回吐 → 唔鎖利(等 price 行)', () => {
  const r = fresh().getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, 0.1);
  assert.equal(r.shouldLock, false);
});

test('F5: MFE 唔夠(細過 1.5×ATR)→ 唔鎖利', () => {
  const r = fresh().getMfeLockAdvice('skhx', 'sell', 0.01, 0.01, 0.8);
  assert.equal(r.shouldLock, false);
});

test('F6: 攻擊——NaN/Infinity/負值——唔 crash', () => {
  assert.doesNotThrow(() => fresh().getMfeLockAdvice('skhx', 'sell', NaN, 0.01, 0.5));
  assert.doesNotThrow(() => fresh().getMfeLockAdvice('skhx', 'sell', Infinity, 0.01, 0.5));
  assert.doesNotThrow(() => fresh().getMfeLockAdvice('skhx', 'sell', -1, 0.01, 0.5));
  assert.doesNotThrow(() => fresh().getMfeLockAdvice('', 'x' as 'buy', 0.02, 0.01, 0.5));
  const r = fresh().getMfeLockAdvice('skhx', 'sell', NaN, 0.01, 0.5);
  assert.equal(r.shouldLock, false);
});

test('F7: retraced 超範圍(>1/<0)——clamp 唔 crash', () => {
  assert.doesNotThrow(() => fresh().getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, 1.5));
  assert.doesNotThrow(() => fresh().getMfeLockAdvice('skhx', 'sell', 0.02, 0.01, -0.5));
});
