// ─── Exploration Direction — v2.0.870-exploration-dual（主神 2026-08-25）─
// 問題: exploration priority 鏈——OLR sell 毒化 + trending_bull→BUY 規則——
// sell 側永遠輸 → 近 50 單 100% BUY → sell 樣本餓死（死循環）。
// 修復: 「sell 結構性訊號」最高優先級——E1 實證 persistent_bear（續跌型）
// 持續跌勢（mom24<0 且 mom4<0）sell 4h edge WR 55-68%——覆蓋 OLR sell 毒化。
// 純函數零依賴——可測。毒值保守（唔觸發）。

export type Persistence = 'persistent_bear' | 'persistent_bull' | 'range' | 'neutral';

export interface SellSignalInput {
  persistence: Persistence | string | null | undefined;
  mom24hPct: number | null | undefined;
  mom4hPct: number | null | undefined;
}

/** sell 結構性訊號: persistent_bear（續跌型）+ mom24<0 + mom4<0（持續跌勢
 *  雙確認——E1 驗證 sell edge WR 55-68%）。垃圾值 → false（唔觸發）。 */
export function shouldExploreSell(input: SellSignalInput): boolean {
  const p = input?.persistence;
  if (p !== 'persistent_bear') return false;
  const m24 = input?.mom24hPct;
  const m4 = input?.mom4hPct;
  if (typeof m24 !== 'number' || !Number.isFinite(m24) || m24 >= 0) return false;
  if (typeof m4 !== 'number' || !Number.isFinite(m4) || m4 >= 0) return false;
  return true;
}

/** BUY 結構性訊號（反向——防死貓彈）: persistent_bear + mom24<0 → 唔好探索 buy
 *  （續跌型跌市買 = 追跌——E1 WR 55% 續跌）。用喺 exploration buy 抑制。 */
export function shouldSuppressExploreBuy(input: SellSignalInput): boolean {
  const p = input?.persistence;
  if (p !== 'persistent_bear') return false;
  const m24 = input?.mom24hPct;
  if (typeof m24 !== 'number' || !Number.isFinite(m24) || m24 >= 0) return false;
  return true;
}

/** 探索雙向最終裁決（NO ENTRY 支援）:
 *  sellSignal 成立 → SELL（覆蓋 OLR 毒化）;
 *  buySuppress 成立 → 唔選 BUY（續跌型跌市）;
 *  兩邊都冇 → 保持候選（交 priority 鏈其餘訊號）。 */
export function resolveExplorationDirection(
  input: SellSignalInput,
  candidate: 'buy' | 'sell' | null,
): 'buy' | 'sell' | null {
  // sell 結構性訊號最高優先——覆蓋 candidate
  if (shouldExploreSell(input)) return 'sell';
  // 續跌型跌市——buy candidate 被抑制
  if (candidate === 'buy' && shouldSuppressExploreBuy(input)) return null;
  return candidate;
}

// ─── v2.0.872-P9-fine-tune: Strength/TIP 信號（主神 2026-08-28）──────────
// 語義真相（四組合 × era 重放 269 喺）:唯一跨時代穩健 edge = buy-tip（買強勢）。
// buy-dip 時代依賴（9-13 贏 73% → 14-27 蝕 25%）；sell-dip/sell-tip 冇穩健 edge。
// 9-13 SKHX 實證:低波動 range + 極端 sell 壓力（obImb −0.36）買 dip → +74.9pp/5日。
// 對稱設計:dip-buy（sell 壓力 dip）有 edge ✓；dip-sell（buy 壓力 rip）數據否定
// （−21.7pp）——信號只產生 dip-BUY（主神批准範圍:組件 2a）。

export interface DipSignalInput {
  regime: string | null | undefined;
  volatility: number | null | undefined;
  obImbalance: number | null | undefined;
  /** v2.0.872-P9-fine-tune: entry 價喺近期 range 嘅位置（0=低位,1=高位）。
   *  14-27 重放實證:高位買 +1.77/喺 vs 低位買 −1.92/喺——賣壓吸收喺高位先有 edge。
   *  undefined = 數據不足 → 唔過濾（保守放行，vol+obImb 閘照把關）。 */
  rangePosition?: number | null;
}

/** TIP-BUY 環境判定（純函數，重放實證 buy-tip 兩時代 +23.2/+124.0pp）:
 *  - regime ∈ range 類（mean_reverting / low_volatility / unknown——vol 門檻兜底）
 *  - σ ≤ 0.3%（平靜——9-13 實測 0.20%）
 *  - obImb ≤ −0.2（賣壓被吸收——強勢延續環境）
 *  垃圾/唔符合 → null。對稱 sell 分支:range 高位 + 壓力 → SELL（17 喺 +7.3pp 實證）。 */
export function dipReversionSignal(input: DipSignalInput, opts: { maxVol?: number; minImb?: number } = {}): { direction: 'buy' | 'sell'; strength: number } | null {
  const maxVol = opts.maxVol ?? 0.003;
  const minImb = opts.minImb ?? 0.2;
  const regimeOk = !input?.regime || input.regime === 'mean_reverting' || input.regime === 'low_volatility' || input.regime === 'unknown';
  if (!regimeOk) return null;
  const vol = input?.volatility;
  if (typeof vol !== 'number' || !Number.isFinite(vol) || vol < 0 || vol > maxVol) return null;
  const ob = input?.obImbalance;
  if (typeof ob !== 'number' || !Number.isFinite(ob) || ob > -minImb) return null;
  // v2.0.872-P9-fine-tune: range 位置過濾——14-27 重放實證:高位買 +1.77/喺 vs
  // 低位買 −1.92/喺。sell 壓力 + 價格喺 range 高位 = 賣壓被吸收（真需求）；
  // 喺低位 = 賣家贏緊（續跌）。rangePosition ≥ 0.5（上半 range）先 buy。
  const rp = input?.rangePosition;
  if (typeof rp === 'number' && Number.isFinite(rp)) {
    // v2.0.872-P9-fine-tune-v2（主神:SELL 倉位都會盈利，唔好抹煞 SHORT）:
    // 51 喂 SELL range 位置重放——對稱發現:
    //   高位（>0.65）SELL:17 喂 +7.3pp 53%（賣 rip——同賣家一齊喺阻力位封頂）✅
    //   低位（<0.35）SELL:19 喺 −28pp 32%（追跌——清算域接刀）❌
    // 對稱規則:ob 壓力 + range 極端位置 → 兩個方向嘅均值回歸/延續信號
    if (ob > minImb && rp > 0.65) return { direction: 'sell', strength: ob };       // dip-sell:buy 壓力 rip
    if (ob <= -minImb && rp > 0.65) return { direction: 'sell', strength: Math.abs(ob) }; // 賣壓喺高位封頂
    if (rp < 0.5) return null;   // 低位:BUY/SELL 都唔開（歷史雙向蝕）
    return { direction: 'buy', strength: Math.abs(ob) };  // 中上位置 + sell 壓力 → dip-BUY
  }
  return { direction: 'buy', strength: Math.abs(ob) };
}

// ─── v2.0.873-P9-amplify: 確定有效信號放大（主神 2026-08-28 指令——幻覺修正同時放大確定有效信號）──
// 只有通過統計審計、有實證 edge 嘅信號先可以放大:
//   - TIP-BUY（高位買強勢）:buy-tip 兩時代重放 +23.2pp 63% / +124.0pp 42%——唯一跨時代穩健 edge → ×1.5
//   - SELL-rip（高位 >0.65 賣）:17 喺 +7.3pp 53%（+0.43/喺）——樣本較細 → ×1.25
// 已證偽源（OLR/Q-RL/FP）唔喺放大範圍——佢哋照舊唔做決定。
export function dipAmplifyMultiplier(direction: 'buy' | 'sell' | string | null, enabled = true): number {
  if (!enabled || !direction) return 1.0;
  if (direction === 'buy') return 1.5;
  if (direction === 'sell') return 1.25;
  return 1.0;
}
