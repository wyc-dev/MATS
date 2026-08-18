/**
 * v2.0.870-P35: 順逆勢 soft gate(趨勢對齊乘數)
 *
 * 背景(主神實證):近 7 筆實盤輸錢單,開倉嗰刻 trend= bearish +
 * regime=trending_bear —— 系統明知熊市照買(刀口接刀),每筆 -6~-10%。
 * 現有閘門(conviction/EV/MAE/macro)全部管信心,冇一層管「方向 vs 趨勢」。
 *
 * 設計紀律:
 * - soft 乘數,永不 hard-block(主神教條:判斷層唔准消滅信號)
 * - Buy/Sell 完全鏡像(主神明確要求)
 * - 雙重一致:trend 同 regime 必須互證先有乘數(單一訊號 = 假動作)
 * - 缺數/unknown → ×1.0(唔干擾,cold-start 安全)
 * - env:TREND_ALIGN_GATE=false → 完全回滾
 */

export interface TrendAlignmentVerdict {
  multiplier: number;
  /** 'aligned' | 'counter' | 'neutral' */
  label: 'aligned' | 'counter' | 'neutral';
  explanation: string;
}

/** 順勢 boost / 逆勢 penalty(量化定值——0.5 攔一半逆勢弱信號,1.2 俾順勢少少膽) */
const ALIGNED_BOOST = 1.2;
const COUNTER_PENALTY = 0.5;

export function trendAlignmentMultiplier(
  action: 'buy' | 'sell' | 'hold' | string,
  trend: string | undefined | null,
  regime: string | undefined | null,
): TrendAlignmentVerdict {
  const NEUTRAL: TrendAlignmentVerdict = { multiplier: 1.0, label: 'neutral', explanation: 'no trend/regime agreement' };
  if (!trend || !regime || typeof trend !== 'string' || typeof regime !== 'string') return NEUTRAL;
  if (action !== 'buy' && action !== 'sell') return NEUTRAL;

  const isBearConf = trend === 'bearish' && regime === 'trending_bear';
  const isBullConf = trend === 'bullish' && regime === 'trending_bull';
  if (!isBearConf && !isBullConf) return NEUTRAL;

  // trend 同 regime 已經雙重一致——睇方向
  if (isBullConf) {
    if (action === 'buy') return { multiplier: ALIGNED_BOOST, label: 'aligned', explanation: 'bullish trend + trending_bull + BUY (順勢)' };
    return { multiplier: COUNTER_PENALTY, label: 'counter', explanation: 'bullish trend + trending_bull + SELL (逆勢)' };
  }
  // isBearConf
  if (action === 'sell') return { multiplier: ALIGNED_BOOST, label: 'aligned', explanation: 'bearish trend + trending_bear + SELL (順勢)' };
  return { multiplier: COUNTER_PENALTY, label: 'counter', explanation: 'bearish trend + trending_bear + BUY (逆勢接刀)' };
}
