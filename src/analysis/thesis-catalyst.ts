// ─── Thesis Catalyst Classifier (Phase 0.1) — v2.0.863 ─────────────────
//
// 分析 Meta-Agent entryThesis 有冇引用「可驗證嘅世界事件」——即係 LLM
// 世界模型嘅證據。核心問題:LLM 世界模型(新聞/宏觀推理)有冇真 alpha?
// 呢個 classifier 將 thesis 分為:
//   strong — 引用具體新聞/宏觀事件(「Fed 減息」「CPI 高於預期」)
//   weak   — 引用數據事件(「突破 $64K」「成交量激增」)但冇宏觀
//   none   — 只有統計引用(OLR/P(win)/First-Passage/Q-RL)或含糊表述
//
// 統計引用(OLR/Q-RL/combo)唔算 catalyst——嗰啲係「後視鏡」,唔係 LLM
// 世界模型嘅「前瞻」。catalyst 一定要係「世界發生緊咩事」嘅具體證據。
//
// 純函數、無依賴、可單元測試。

// ─── 特徵 pattern(可驗證世界事件)─────────────────────────────────────
// v2.0.863-attack (V1): `\b` word boundary 對 CJK 失效(中文之間冇 boundary)
// ——「央行」「趨勢」等中文 pattern 全部 match 唔到(系統係繁中 prompt,
// 呢個係嚴重 bug)。改用 ASCII word-boundary lookaround:
//   (?<![A-Za-z0-9_])pattern(?![A-Za-z0-9_])
// ——英文受 word boundary 限制(「trend」唔會 match 喺「downtrend」中間),
//   中文自由(CJK 唔係 ASCII word char,lookaround 唔阻)。

function wb(pattern: string): RegExp {
  // v2.0.863-attack (V2): `(?:${pattern})` GROUP 包住全部 alternatives——
  // 否則 lookaround 只包住第一個同最後一個 alternative,中間嘅冇 boundary
  // (「downtrend」入面嘅「trend」會被獨立 match)。
  return new RegExp(`(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`, 'i');
}

const NEWS_MACRO_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // 央行/貨幣政策
  { name: 'central_bank', re: wb('fed|美聯儲|聯儲局|央行|central\\s*bank|ecb|boj|pboc|人行') },
  // 宏觀經濟數據
  { name: 'macro_data', re: wb('cpi|ppi|非農|nfp|interest\\s*rate|利率|通脹|inflation|gdp|pmi|失業率|unemployment') },
  // 地緣政治
  { name: 'geopolitics', re: wb('地緣|geopolit|戰爭|war|制裁|sanction|衝突|conflict|入侵|invasion|選舉|election') },
  // 新聞/公告/事件
  { name: 'news_event', re: wb('新聞|news|報道|report(?!s\\b)|announcement|宣布|宣佈|突破性|surge|plunge') },
  // 供應鏈/商品
  { name: 'supply_demand', re: wb('opec|增產|減產|supply|demand|庫存|inventory|產量|output|供應|需求') },
];

const DATA_EVENT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // 技術突破/結構
  { name: 'breakout', re: wb('突破|跌破|升破|breakout|break\\s*below|break\\s*above|reclaim|失守') },
  // 成交量/流動性
  { name: 'volume_liquidity', re: wb('成交量|volume|流動性|liquidity|ob\\s*imbalance|訂單簿|order\\s*book|清算|liquidation') },
  // funding/持倉
  { name: 'funding_positioning', re: wb('funding\\s*rate|資金費率|open\\s*interest|持倉|positioning|擠倉|squeeze') },
  // 具體數字/價位/日期(數字 pattern 唔使 word boundary)
  { name: 'concrete_level', re: /\$\s?\d[\d,.]*|\d+\.\d+\s*%|\bQ[1-4]\b|\b20\d{2}\b|\d+\s*月/ },
];

/** 統計引用——唔算 catalyst(後視鏡,唔係世界模型前瞻) */
const STAT_PATTERNS: RegExp[] = [
  wb('olr|p\\s*\\(win\\)|first[- ]passage|q-rl|combo|wilson|cond\\s*wr|shadow|edge\\s*\\+|-?\\d+\\s*pp'),
];

/** v2.0.863: K 線/圖表結構引用——LLM 讀圖嘅世界模型證據(唔係新聞) */
const CHART_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'trend', re: wb('上升趨勢|下降趨勢|uptrend|downtrend|trend|趨勢|bullish|bearish|強勢|弱勢') },
  { name: 'structure', re: wb('higher[- ]high|lower[- ]low|雙頂|雙底|頭肩|head[- ]and[- ]shoulders|形態|pattern|盤整|range|通道|channel') },
  { name: 'breakout', re: wb('突破|跌破|升破|breakout|break\\s*above|break\\s*below|reclaim|失守|守住|hold') },
  { name: 'candle', re: wb('蠟燭|candle|k線|k-line|長上影|長下影|吞沒|engulf|錘頭|hammer') },
  { name: 'volume_price', re: wb('價量|volume.*(confirm|配合|背離|divergence)|量價') },
];

export type CatalystLevel = 'strong' | 'weak' | 'none';

export interface CatalystResult {
  level: CatalystLevel;
  /** matched 世界事件類別(strong/weak 時) */
  categories: string[];
  /** matched 具體證據 snippet(審計用) */
  evidence: string[];
  /** 有冇引用統計(OLR 等)——輔助資訊 */
  hasStatReference: boolean;
  /** v2.0.868-attack12(主神審計):catalyst 方向——利好/利淡/中性。
   *  之前只有 level(strong/weak/none)——BUY thesis + bearish catalyst
   *  矛盾冇被偵測(方向資料缺失) */
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

/**
 * 分析 thesis 文字 → catalyst 分類。
 * 純函數——任何 malformed input(空/undefined/非 string)→ 'none',唔 crash。
 */
export function classifyThesisCatalyst(thesis: string | undefined | null): CatalystResult {
  if (typeof thesis !== 'string' || thesis.length === 0) {
    return { level: 'none', categories: [], evidence: [], hasStatReference: false, sentiment: 'neutral' };
  }
  const categories: string[] = [];
  const evidence: string[] = [];

  // 1. 新聞/宏觀事件(強 catalyst 證據)
  for (const p of NEWS_MACRO_PATTERNS) {
    const m = thesis.match(p.re);
    if (m) {
      categories.push(p.name);
      evidence.push(m[0] ?? p.name);
    }
  }

  // 2. 數據事件(弱 catalyst 證據)
  for (const p of DATA_EVENT_PATTERNS) {
    const m = thesis.match(p.re);
    if (m) {
      categories.push(p.name);
      evidence.push(m[0] ?? p.name);
    }
  }

  // 2.5. K 線/圖表結構引用(v2.0.863——LLM 讀圖,唔係新聞)
  for (const p of CHART_PATTERNS) {
    const m = thesis.match(p.re);
    if (m) {
      categories.push(p.name);
      evidence.push(m[0] ?? p.name);
    }
  }

  // 3. 統計引用(唔算 catalyst)
  const hasStatReference = STAT_PATTERNS.some(re => re.test(thesis));

  // 分類:
  //   strong = 有新聞/宏觀事件
  //   weak   = 有數據事件 / K 線圖表結構(冇新聞)
  //   none   = 乜都冇(或者只有統計)
  const hasNews = categories.some(c =>
    c === 'central_bank' || c === 'macro_data' || c === 'geopolitics' || c === 'news_event' || c === 'supply_demand');
  const hasData = categories.some(c =>
    c === 'breakout' || c === 'volume_liquidity' || c === 'funding_positioning' || c === 'concrete_level'
    || c === 'trend' || c === 'structure' || c === 'candle' || c === 'volume_price');

  let level: CatalystLevel = 'none';
  if (hasNews) level = 'strong';
  else if (hasData) level = 'weak';

  // v2.0.868-attack12:catalyst 方向偵測——bullish/bearish 字(中英兼容)
  let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  const bullScore = (thesis.match(/(利好|看漲|上升趨勢|突破|強勢|bullish|uptrend|breakout|surge|rally|soar|overtake|accumulation|inflow|expansion)/gi) ?? []).length;
  const bearScore = (thesis.match(/(利淡|看跌|下降趨勢|跌破|弱勢|bearish|downtrend|breakdown|plunge|crash|distribution|outflow|recession|fear)/gi) ?? []).length;
  if (bullScore > bearScore) sentiment = 'bullish';
  else if (bearScore > bullScore) sentiment = 'bearish';
  return { level, categories, evidence: evidence.slice(0, 6), hasStatReference, sentiment };
}
