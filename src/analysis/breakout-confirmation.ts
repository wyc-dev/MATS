// ─── Breakout Confirmation Gate (v2.0.870-P6) ─────────────────────────
//
// 主神質疑: 系統喺阻力位買入, thesis 自己都話「breakout or rejection」——
// 擲銀仔入場。40 單實證 trade 37(bnb -8.2%)thesis 白紙黑字「breakout or
// rejection within 1h」→ rejection → 蝕。
//
// 設計(時機層): 當 entry 喺阻力位下方(< 50bps)且 BUY → 未突破 → skip
// (等 5m close 突破確認);SELL 喺支撐位上方(< 50bps)→ 未跌破 → skip。
// 已突破(price 喺阻力位上方)→ 唔 skip(唔誤傷真突破贏單)。
//
// 純函數零依賴——可測。垃圾輸入保守(唔 skip)。

export interface BreakoutConfirmationInput {
  direction: 'buy' | 'sell';
  /** 距離阻力位(bps)——price 喺阻力位下方時為正,上方時為負 */
  distanceToResistanceBps: number | null | undefined;
  /** 距離支撐位(bps)——price 喺支撐位上方時為正,下方時為負 */
  distanceToSupportBps: number | null | undefined;
}

/** 近阻力/支撐位嘅閾值(bps)——< 50bps 先算「喺阻力位賭突破」 */
const NEAR_SR_BPS = 50;

/** v2.0.870-P6: 未突破就買/賣 → skip(等突破確認)。
 *  BUY 喺阻力位下方(< 50bps)→ 未突破 → skip;
 *  SELL 喺支撐位上方(< 50bps)→ 未跌破 → skip。
 *  已突破(price 喺阻力位上方 = distance 負)→ 唔 skip。
 *  垃圾輸入(NaN/Infinity/非 number)→ 保守唔 skip。 */
export function shouldSkipBreakoutEntry(input: BreakoutConfirmationInput): boolean {
  if (input?.direction !== 'buy' && input?.direction !== 'sell') return false;
  if (input.direction === 'buy') {
    const d = input.distanceToResistanceBps;
    if (typeof d !== 'number' || !Number.isFinite(d)) return false;
    return d > 0 && d < NEAR_SR_BPS;
  }
  const d = input.distanceToSupportBps;
  if (typeof d !== 'number' || !Number.isFinite(d)) return false;
  return d > 0 && d < NEAR_SR_BPS;
}
