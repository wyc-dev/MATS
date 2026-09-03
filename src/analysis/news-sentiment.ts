// ─── Real-time News Sentiment Module ───
// v2.0.75: Replaces the dead Reddit module (403 blocked). Fetches real-time
// news headlines for the currently-selected Market symbol from free, no-key
// sources and injects them into the HACP market context so the News Reporter
// agent has REAL data to analyze (positive/negative sentiment).
//
// Design principles:
//   1. Fail-open — any error → NEUTRAL, never blocks a decision cycle
//   2. Multi-source — Google News RSS (primary) + GDELT 2.0 + Bing News RSS
//   3. 5-min in-memory cache per symbol (HL decision cycle is 5-15min)
//   4. Injects "=== NEWS SENTIMENT ===" to match the News Reporter system
//      prompt trigger (fixes the v2.0.74 label mismatch bug where Reddit
//      injected "=== REDDIT SENTIMENT ===" but the prompt looked for
//      "=== NEWS SENTIMENT ===").
//   5. Lexicon pre-score is a HINT only — the News Reporter LLM does the
//      real positive/negative analysis on the actual headlines.
//
// All endpoints verified reachable (HTTP 200, no key) as of 2026-06-30:
//   - https://news.google.com/rss/search?q=...  (XML, Bloomberg/Reuters/CNBC)
//   - https://api.gdeltproject.org/api/v2/doc/doc?query=...&format=json
//   - https://www.bing.com/news/search?q=...&format=rss  (XML)
//
// Reddit public JSON (https://www.reddit.com/.../search.json) is DEAD —
// returns HTTP 403 "Blocked" for all user-agents. Not used.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'news-sentiment' });

// ─── Symbol → News Query Name Mapping ───
// Resolves ticker ambiguity: "MU" alone could be Micron or a crypto token.
// Maps the BASE asset (after stripping xyz: prefix + USDT/USD/PERP) to the
// full name used in news search queries. Organized by asset category.

const CRYPTO_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', XBT: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB coin',
  XRP: 'XRP Ripple',
  ADA: 'Cardano ADA',
  DOGE: 'Dogecoin',
  DOT: 'Polkadot DOT',
  AVAX: 'Avalanche AVAX',
  MATIC: 'Polygon MATIC', POL: 'Polygon MATIC',
  LINK: 'Chainlink LINK',
  UNI: 'Uniswap UNI',
  ATOM: 'Cosmos ATOM',
  ARB: 'Arbitrum ARB',
  OP: 'Optimism OP',
  SUI: 'Sui SUI',
  NEAR: 'NEAR Protocol',
  APT: 'Aptos APT',
  INJ: 'Injective INJ',
  SEI: 'Sei SEI',
  TIA: 'Celestia TIA',
  FTM: 'Fantom FTM',
  S: 'Sonic SVM',
  TRUMP: 'Trump coin',
  MELANIA: 'Melania meme coin',
};

const STOCK_NAMES: Record<string, string> = {
  NVDA: 'Nvidia',
  AAPL: 'Apple',
  MSFT: 'Microsoft',
  GOOGL: 'Google Alphabet', GOOG: 'Google Alphabet',
  AMZN: 'Amazon',
  META: 'Meta Platforms',
  TSLA: 'Tesla',
  MU: 'Micron Technology',
  SKHX: 'SK Hynix',
  QQQ: 'Invesco QQQ ETF',
  SPY: 'SPDR S&P 500 ETF',
  AMD: 'AMD Advanced Micro',
  INTC: 'Intel',
  NFLX: 'Netflix',
  DIS: 'Disney',
  BA: 'Boeing',
  JPM: 'JPMorgan',
  BAC: 'Bank of America',
  COIN: 'Coinbase',
  PLTR: 'Palantir',
  SMCI: 'Super Micro Computer',
  ARM: 'Arm Holdings',
  MSTR: 'MicroStrategy',
};

const INDEX_NAMES: Record<string, string> = {
  SPX: 'S&P 500', SP500: 'S&P 500', SPY: 'S&P 500',
  NDX: 'Nasdaq 100', QQQ: 'Nasdaq 100', XYZ100: 'Nasdaq 100',
  DJI: 'Dow Jones Industrial', DIA: 'Dow Jones Industrial',
  VIX: 'VIX volatility index', UVXY: 'VIX volatility index',
  RUT: 'Russell 2000',
  SPCX: 'S&P 500 CME',
};

const COMMODITY_NAMES: Record<string, string> = {
  XAU: 'gold price', GOLD: 'gold price',
  XAG: 'silver price', SILVER: 'silver price',
  OIL: 'crude oil WTI', WTI: 'crude oil WTI', CL: 'crude oil WTI',
  BRENT: 'Brent crude oil',
  COPPER: 'copper price',
  NG: 'natural gas',
};

const FX_NAMES: Record<string, string> = {
  EUR: 'euro EUR USD',
  GBP: 'British pound GBP',
  JPY: 'Japanese yen USD JPY',
  AUD: 'Australian dollar AUD',
  CAD: 'Canadian dollar CAD',
  CHF: 'Swiss franc CHF',
  NZD: 'New Zealand dollar NZD',
  CNH: 'Chinese yuan', CNY: 'Chinese yuan',
  HKD: 'Hong Kong dollar HKD',
  SGD: 'Singapore dollar SGD',
  DXY: 'US dollar index DXY',
};

type AssetCategory = 'crypto' | 'indices' | 'stocks' | 'commodities' | 'fx' | 'unknown';

// ─── Symbol normalisation (mirrors agents.ts normalizeBaseAsset) ───

export function normalizeBaseAsset(symbol: string): string {
  // v2.0.873-P9-news-motive-attack (V6): null/undefined/Symbol/number garbage
  // → 中性 ''（fetchNewsForSymbols 上游可能收到垃圾 symbol）——唔可以 crash
  if (typeof symbol !== 'string') return '';
  const colonIdx = symbol.indexOf(':');
  const stripped = colonIdx >= 0 ? symbol.slice(colonIdx + 1) : symbol;
  return stripped.toUpperCase().replace(/USDT$/, '').replace(/USD$/, '').replace(/PERP$/, '');
}

// ─── Category detection (self-contained, no dependency on agents.ts) ───
// Order: known crypto → known stock → known index → known commodity → known fx
// → colon-prefix heuristic (TradFi) → default crypto.

function detectCategory(symbol: string): AssetCategory {
  const base = normalizeBaseAsset(symbol);
  if (CRYPTO_NAMES[base]) return 'crypto';
  if (STOCK_NAMES[base]) return 'stocks';
  if (INDEX_NAMES[base]) return 'indices';
  if (COMMODITY_NAMES[base]) return 'commodities';
  if (FX_NAMES[base]) return 'fx';
  // Colon-prefixed (xyz:MU, flx:NVDA, km:MU) → TradFi. Default to stocks
  // (most common TradFi perp type on HL xyz DEX).
  if (symbol.includes(':')) return 'stocks';
  // Non-colon on crypto exchange → crypto.
  return 'crypto';
}

// ─── Resolve symbol → news search query ───

function resolveNewsQuery(symbol: string, category: AssetCategory): string {
  const base = normalizeBaseAsset(symbol);
  let name: string | undefined;
  switch (category) {
    case 'crypto':      name = CRYPTO_NAMES[base];      break;
    case 'stocks':      name = STOCK_NAMES[base];       break;
    case 'indices':     name = INDEX_NAMES[base];       break;
    case 'commodities': name = COMMODITY_NAMES[base];   break;
    case 'fx':          name = FX_NAMES[base];          break;
  }
  const q = name ?? base;
  switch (category) {
    case 'crypto':      return `"${q}" crypto news`;
    case 'stocks':      return `"${q}" ${base} stock news`;
    case 'indices':     return `"${q}" index news`;
    case 'commodities': return `${q} news`;
    case 'fx':          return `${q} currency news`;
    default:            return `"${q}" news`;
  }
}

// ─── News headline shape ───

interface NewsHeadline {
  title: string;
  publisher: string;   // source / domain
  pubDate: Date | null;
  url?: string;
}

export interface NewsSentimentResult {
  symbol: string;
  category: AssetCategory;
  query: string;
  headlineCount: number;
  headlines: NewsHeadline[];      // top N (max 8), newest first
  lexiconHint: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  lexiconScore: number;           // -1.0 .. +1.0
  fetchedAt: number;
  source: string;                 // which tier served the result
  windowHours: number;            // actual age window used (24/72/168)
  /** v2.0.139: price-news timing context for institutional front-run /
   *  sell-the-news detection. Populated by the caller from the same asset's
   *  candle cache; null when candle data is unavailable. */
  priceNewsTiming?: PriceNewsTiming | null;
}

// ─── Source 1: Google News RSS (primary) ───

async function fetchGoogleNewsRSS(query: string, limit = 10): Promise<NewsHeadline[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(rssUrl, { signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
  const xml = await res.text();
  const headlines: NewsHeadline[] = [];
  // Each <item>: <title>...</title><source>...</source><pubDate>...</pubDate><link>...</link>
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/;
  const sourceRegex = /<source[^>]*>([\s\S]*?)<\/source>/;
  const dateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/;
  const linkRegex = /<link>([\s\S]*?)<\/link>/;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null && headlines.length < limit) {
    const block = m[1] ?? '';
    const tm = block.match(titleRegex);
    const title = (tm?.[1] ?? tm?.[2] ?? '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
    if (!title || title.includes('Google News')) continue;
    const sm = block.match(sourceRegex);
    const publisher = (sm?.[1] ?? '').replace(/&amp;/g, '&').trim() || 'unknown';
    const dm = block.match(dateRegex);
    const pubDate = dm?.[1] ? new Date(dm[1].trim()) : null;
    const lm = block.match(linkRegex);
    const url = lm?.[1]?.trim();
    headlines.push({ title, publisher, pubDate, url });
  }
  return headlines;
}

// ─── Source 2: GDELT 2.0 doc API (secondary, structured JSON) ───

interface GDELTArticle {
  url?: string;
  title?: string;
  seendate?: string;   // 20260630T141500Z
  domain?: string;
  language?: string;
}

/** v2.0.870-P32(主神決定):GDELT 預設停運——長期 429 率限(IP 級硬限
 *  1 req/5s)令佢成為「見好多次都攞唔到」嘅零產出噪音源,佢嘅失敗仲會
 *  觸發 breaker cooldown 警報洗版。google-news / bing RSS 繼續扛。
 *  翻身開關:NEWS_GDELT=1(保留 pacer,真要用都唔會炸 rate limit)。 */
const GDELT_ENABLED = process.env['NEWS_GDELT'] === '1';

// ─── GDELT host pacer(v2.0.870-P31)──
// 實證:GDELT doc API 硬限 1 req/5s(429 明文)。每 cycle 6 symbol 近並發
// 打 → 後 5 次必中 429 → breaker 循環。修:全域 promise chain 序列化 +
// reserve-on-enqueue,保證相鄰真實 HTTP ≥ 5.5s(含 0.5s buffer)。
// 就算上一次失敗,slot 都唔會壓縮(防 429 重試雪崩)。
const GDELT_MIN_INTERVAL_MS = 5_500;
const gdeltPacer = {
  nextAllowedAt: 0,
  chain: Promise.resolve() as Promise<void>,
  now: () => Date.now(), // test hook 可換
};

/** 測試專用 hook */
export function __test__resetGdeltPacer(): void {
  gdeltPacer.nextAllowedAt = 0;
  gdeltPacer.chain = Promise.resolve();
}
export function __test__setGdeltNow(n: number): void { gdeltPacer.now = () => n; }
export function __test__computeGdeltWait(): number {
  const now = gdeltPacer.now();
  const wait = Math.max(0, gdeltPacer.nextAllowedAt - now);
  gdeltPacer.nextAllowedAt = Math.max(now, gdeltPacer.nextAllowedAt) + GDELT_MIN_INTERVAL_MS;
  return wait;
}

/** 序列化 + 節奏嘅 gdelt HTTP(生產路徑) */
function gdeltFetch(url: string): Promise<Response> {
  const run = gdeltPacer.chain.then(async () => {
    const waitMs = __test__computeGdeltWait();
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    return fetch(url, { signal: AbortSignal.timeout(8_000) });
  });
  gdeltPacer.chain = run.then(() => undefined, () => undefined); // 失敗唔斷鏈
  return run;
}

async function fetchGDELT(query: string, limit = 10): Promise<NewsHeadline[]> {
  // GDELT doc API: mode=ArtList returns { articles: [...] }
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${limit * 2}&format=json&sort=datedesc`;
  const res = await gdeltFetch(url);
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const data = await res.json() as { articles?: GDELTArticle[] };
  const arts = data.articles ?? [];
  const headlines: NewsHeadline[] = [];
  for (const a of arts) {
    if (!a.title) continue;
    // Parse seendate "20260630T141500Z" → Date
    let pubDate: Date | null = null;
    if (a.seendate) {
      const m = a.seendate.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
      if (m) pubDate = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
    }
    headlines.push({
      title: a.title.trim(),
      publisher: a.domain ?? 'unknown',
      pubDate,
      url: a.url,
    });
    if (headlines.length >= limit) break;
  }
  return headlines;
}

// ─── Source 3: Bing News RSS (tertiary) ───

async function fetchBingNewsRSS(query: string, limit = 10): Promise<NewsHeadline[]> {
  const rssUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetch(rssUrl, { signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`Bing News HTTP ${res.status}`);
  const xml = await res.text();
  const headlines: NewsHeadline[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/;
  const sourceRegex = /<source[^>]*>([\s\S]*?)<\/source>/;
  const dateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null && headlines.length < limit) {
    const block = m[1] ?? '';
    const tm = block.match(titleRegex);
    const title = (tm?.[1] ?? tm?.[2] ?? '').replace(/&amp;/g, '&').trim();
    if (!title) continue;
    const sm = block.match(sourceRegex);
    const publisher = (sm?.[1] ?? '').trim() || 'Bing';
    const dm = block.match(dateRegex);
    const pubDate = dm?.[1] ? new Date(dm[1].trim()) : null;
    headlines.push({ title, publisher, pubDate });
  }
  return headlines;
}

// ─── Dedup + 24h filter ───

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function dedupAndFilter(headlines: NewsHeadline[], maxAgeHours = 24, limit = 8): NewsHeadline[] {
  const seen = new Set<string>();
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const out: NewsHeadline[] = [];
  // Sort newest first (those with pubDate), undated last
  const sorted = [...headlines].sort((a, b) => {
    if (a.pubDate && b.pubDate) return b.pubDate.getTime() - a.pubDate.getTime();
    if (a.pubDate) return -1;
    if (b.pubDate) return 1;
    return 0;
  });
  for (const h of sorted) {
    // Keep undated headlines (Google News sometimes omits pubDate) but prefer dated.
    if (h.pubDate && h.pubDate.getTime() < cutoff) continue;
    const key = normalizeTitle(h.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Lexicon sentiment hint (fast, deterministic, no LLM cost) ───
// Crypto/finance polarity words. This is a HINT only — the News Reporter
// LLM does the real positive/negative analysis on the actual headlines.

const POSITIVE_WORDS = new Set([
  'bullish', 'moon', 'pump', 'breakout', 'rally', 'surge', 'soar', 'rocket',
  'buy', 'long', 'accumulate', 'support', 'bounce', 'recovery', 'reversal',
  'undervalued', 'opportunity', 'adoption', 'partnership', 'upgrade', 'beat',
  'profit', 'gains', 'win', 'strong', 'outperform', 'accumulation',
  'whale buy', 'institutional', 'etf inflow', 'demand', 'scarcity', 'halving',
  'approve', 'approved', 'deal', 'record high', 'all-time high',
]);

const NEGATIVE_WORDS = new Set([
  'bearish', 'crash', 'plunge', 'dump', 'selloff', 'sell-off', 'decline', 'drop',
  'loss', 'lose', 'down', 'weak', 'fear', 'panic', 'fud', 'scam', 'fraud',
  'hack', 'hacked', 'exploit', 'lawsuit', 'sec', 'ban', 'banned', 'regulate',
  'investigation', 'probe', 'delist', 'bankruptcy', 'default', 'liquidation',
  'liquidated', 'overvalued', 'bubble', 'correction', 'capitulation', 'exit',
  'cut', 'slash', 'miss', 'disappoint', 'warning', 'downgrade', 'halt',
]);

function lexiconHint(headlines: NewsHeadline[]): { label: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; score: number } {
  let pos = 0, neg = 0;
  for (const h of headlines) {
    const text = h.title.toLowerCase();
    for (const w of POSITIVE_WORDS) if (text.includes(w)) pos++;
    for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg++;
  }
  const total = pos + neg;
  if (total === 0) return { label: 'NEUTRAL', score: 0 };
  const score = (pos - neg) / total;   // -1..+1
  const label = score > 0.15 ? 'BULLISH' : score < -0.15 ? 'BEARISH' : 'NEUTRAL';
  return { label, score: Math.max(-1, Math.min(1, score)) };
}

// ─── Price-News Timing (institutional front-run / sell-the-news detection) ───
// v2.0.139: enriches the news block with the SAME asset's recent price action
// so the News Reporter can detect whether price front-ran the news cluster
// (institutions pre-positioned) — the single most reliable institutional tell.
// Candle shape is minimal (time in ms + close); the caller fetches 1h candles
// from the same routed source the chart uses, ensuring same-asset consistency.

export interface TimingCandle { t: number; c: number; }

export interface PriceNewsTiming {
  change1h: number;       // fractional (0.058 = +5.8%)
  change4h: number;
  change24h: number;
  change3d: number;
  movedBeforeNews: boolean;   // price moved >2% in the hint direction before the news cluster
  preNewsMovePct: number;     // the pre-news-window move (signed, fractional)
  preNewsMoveDir: 'up' | 'down' | 'flat';
  headlineCadence: number;    // headlines per day
  cadenceLevel: 'elevated' | 'normal' | 'low';
  sourceClustering: number;   // 0..1 — fraction sharing dominant angle within a 6h window
  clusteringLevel: 'coordinated' | 'mixed' | 'independent';
  dominantAngle: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

/** Classify a single headline's angle via the same lexicon as `lexiconHint`.
 *  v2.0.873-P9-news-motive-attack (V4): title garbage（Symbol/number/null）
 *  → NEUTRAL——唔 crash（toLowerCase TypeError）。 */
function classifyAngle(title: unknown): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (typeof title !== 'string') return 'NEUTRAL';
  const text = title.toLowerCase();
  let pos = 0, neg = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) pos++;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg++;
  if (pos === 0 && neg === 0) return 'NEUTRAL';
  return pos > neg ? 'BULLISH' : neg > pos ? 'BEARISH' : 'NEUTRAL';
}

/** Closest candle close at-or-before an absolute ms timestamp (null if out of range). */
function closeAtAbs(sorted: TimingCandle[], target: number): number | null {
  let best: TimingCandle | null = null;
  for (const cd of sorted) {
    if (cd.t <= target) best = cd;
    else break;
  }
  return best?.c ?? null;
}

/**
 * Compute the price-news timing context for institutional motive detection.
 * @param candles  1h OHLC closes for the SAME asset (any reasonable count; 80
 *                 candles ≈ 3.3d covers the 3d window). Oldest or newest first —
 *                 sorted internally.
 * @param headlines  the headlines returned for this symbol (with pubDate).
 * @param windowHours  the news fetch window (24/72/168).
 * @param lexiconHint  the aggregate lexicon label for the cluster.
 * @returns PriceNewsTiming, or null if insufficient candle / headline data.
 */
export function computePriceNewsTiming(
  candles: TimingCandle[],
  headlines: NewsHeadline[],
  windowHours: number,
  lexiconHint: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
): PriceNewsTiming | null {
  // v2.0.873-P9-news-motive-attack (V4): candles/headlines 垃圾輸入防禦——
  // 非 array / element garbage（null/Symbol/無 .t/.c）→ skip——唔 crash,
  // 數據不足返回 null（中性）。
  if (!Array.isArray(candles) || !Array.isArray(headlines)) return null;
  const cleanCandles = candles
    .filter((c): c is TimingCandle => !!c && typeof c === 'object'
      && typeof (c as unknown as Record<string, unknown>)['t'] === 'number'
      && typeof (c as unknown as Record<string, unknown>)['c'] === 'number'
      && Number.isFinite((c as unknown as Record<string, unknown>)['t'] as number)
      && Number.isFinite((c as unknown as Record<string, unknown>)['c'] as number))
    .sort((a, b) => a.t - b.t);
  const cleanHeadlines = headlines.map(h => sanitizeHeadline(h)).filter((h): h is NewsHeadline => h !== null);
  if (cleanCandles.length < 5 || cleanHeadlines.length === 0) return null;
  const sorted = cleanCandles;
  const now = sorted[sorted.length - 1]!.t;
  const last = sorted[sorted.length - 1]!.c;
  const pctAgo = (msAgo: number): number => {
    const ref = closeAtAbs(sorted, now - msAgo);
    return ref && ref !== 0 ? (last - ref) / ref : 0;
  };
  const change1h = pctAgo(3_600_000);
  const change4h = pctAgo(14_400_000);
  const change24h = pctAgo(86_400_000);
  const change3d = pctAgo(3 * 86_400_000);

  // ── movedBeforeNews: did price move >2% in the hint direction BEFORE the
  //    earliest headline in the cluster? (front-run / pre-positioning tell)
  const validDates = cleanHeadlines
    .map(h => h.pubDate?.getTime() ?? null)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  let movedBeforeNews = false;
  let preNewsMovePct = 0;
  let preNewsMoveDir: 'up' | 'down' | 'flat' = 'flat';
  if (validDates.length > 0) {
    const earliest = validDates[0]!;
    const preStart = earliest - windowHours * 3_600_000;
    const priceAtEarliest = closeAtAbs(sorted, earliest);
    const priceAtPreStart = closeAtAbs(sorted, preStart);
    if (priceAtEarliest != null && priceAtPreStart != null && priceAtPreStart !== 0) {
      preNewsMovePct = (priceAtEarliest - priceAtPreStart) / priceAtPreStart;
      preNewsMoveDir = preNewsMovePct > 0.002 ? 'up' : preNewsMovePct < -0.002 ? 'down' : 'flat';
      const THRESH = 0.02;  // 2% — meaningful pre-news positioning
      if (Math.abs(preNewsMovePct) >= THRESH) {
        if (lexiconHint === 'BULLISH' && preNewsMoveDir === 'up') movedBeforeNews = true;
        else if (lexiconHint === 'BEARISH' && preNewsMoveDir === 'down') movedBeforeNews = true;
        else if (lexiconHint === 'NEUTRAL' && preNewsMoveDir !== 'flat') movedBeforeNews = true;
      }
    }
  }

  // ── headlineCadence: headlines per day vs baseline (~1-2/day is typical).
  const headlineCadence = headlines.length / Math.max(1, windowHours / 24);
  const cadenceLevel: 'elevated' | 'normal' | 'low' =
    headlineCadence >= 4 ? 'elevated' : headlineCadence >= 1 ? 'normal' : 'low';

  // ── sourceClustering: fraction of headlines sharing the dominant lexicon
  //    angle within a 6h window. High clustering ⇒ coordinated narrative push.
  const angles = headlines.map(h => classifyAngle(h.title));
  const bullN = angles.filter(a => a === 'BULLISH').length;
  const bearN = angles.filter(a => a === 'BEARISH').length;
  const dominantAngle: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    bullN > bearN && bullN > 0 ? 'BULLISH' : bearN > bullN && bearN > 0 ? 'BEARISH' : 'NEUTRAL';
  let maxIn6h = 0;
  for (let i = 0; i < validDates.length; i++) {
    const winEnd = validDates[i]! + 6 * 3_600_000;
    const cnt = validDates.filter(t => t >= validDates[i]! && t <= winEnd).length;
    if (cnt > maxIn6h) maxIn6h = cnt;
  }
  const sourceClustering = validDates.length > 0 ? maxIn6h / validDates.length : 0;
  const clusteringLevel: 'coordinated' | 'mixed' | 'independent' =
    sourceClustering >= 0.6 ? 'coordinated' : sourceClustering >= 0.3 ? 'mixed' : 'independent';

  return {
    change1h, change4h, change24h, change3d,
    movedBeforeNews, preNewsMovePct, preNewsMoveDir,
    headlineCadence, cadenceLevel,
    sourceClustering, clusteringLevel, dominantAngle,
  };
}

/** Format the price-news timing block for agent context (the 📊 section).
 *  v2.0.873-P9-news-motive（主神 2026-09-04「新聞出現代表有機構需要散播——需要知道利益瓜葛以及較早時期嘅 front running」）:
 *  motive alert 直接喺 data 層計算並標註——唔再靠 LLM 自己查 prompt 記憶表格
 *  （實證: News Reporter v2 框架 07-09 已有, 但執行率僅 4/16=25%——盲目信 news
 *  avg −1.02% vs 有懷疑 avg +1.27%）
 */
export function formatPriceNewsTiming(pt: PriceNewsTiming, lexiconHint?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): string {
  // v2.0.873-P9-news-motive-attack (V1): garbage pt（null/Symbol/string 字段）
  // → sanitize 才格式化——唔 crash, 唔輸出 NaN%/undefined。
  const clean = sanitizePriceNewsTiming(pt);
  if (!clean) return '';
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const pctSafe = (x: unknown) => pct(typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const lines = [
    `  📊 PRICE-NEWS TIMING:`,
    `     Recent move: 1h ${pctSafe(clean.change1h)} | 4h ${pctSafe(clean.change4h)} | 24h ${pctSafe(clean.change24h)} | 3d ${pctSafe(clean.change3d)}`,
  ];
  if (clean.movedBeforeNews) {
    lines.push(`     ⚡ Price MOVED ${clean.preNewsMoveDir.toUpperCase()} ${(Math.abs(clean.preNewsMovePct) * 100).toFixed(1)}% BEFORE the news cluster → institutions likely PRE-POSITIONED (front-run tell)`);
  } else {
    lines.push(`     No meaningful pre-news move (${pctSafe(clean.preNewsMovePct)} over the pre-news window) → news not obviously front-run`);
  }
  lines.push(`     Headline cadence: ${clean.headlineCadence.toFixed(1)}/day (${clean.cadenceLevel}) | Source clustering: ${(clean.sourceClustering * 100).toFixed(0)}% (${clean.clusteringLevel}, dominant=${clean.dominantAngle})`);
  // ── v2.0.873-P9-news-motive: 機構意圖動機警示——data 層直接判讀（唔靠 LLM 記憶表）──
  const alert = computeNewsMotiveAlert(clean, lexiconHint);
  if (alert) lines.push(alert);
  return lines.join('\n');
}

/**
 * 機構意圖動機警示（data 層判讀——對應 News Reporter prompt 嘅 DECODE FRAMEWORK B 表）。
 * 主神洞察: 新聞係 strategic dissemination——散播者有 agenda, 機構 pre-position 在先,
 * news 到零售手已係尾巴。
 *
 * 判讀表（headline 方向 × price 方向）:
 *   BULLISH headline + price UP（24h/3d 升）      → DISTRIBUTION-HYPE（散貨 bait——唔可以信 news 做 BUY）
 *   BEARISH headline + price DOWN（24h/3d 跌）    → ACCUMULATION-FUD（恐慌 bait——機構收貨）
 *   BULLISH headline + price DOWN / 跌            → NARRATIVE-PIVOT（新聞為反轉而散播）
 *   BEARISH headline + price UP（升）             → NARRATIVE-PIVOT（同上）
 *   NEUTRAL / 無明確方向                          → 無警示（face-value 或噪音）
 *
 * 零決策邏輯——純 context 標註（soft——agents 仍可唔跟, 但唔可以話「冇數據」）。
 */
export function computeNewsMotiveAlert(
  pt: PriceNewsTiming,
  lexiconHint?: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
): string {
  if (!pt || typeof pt !== 'object') return ''; // garbage → 無警示
  const clean = sanitizePriceNewsTiming(pt);
  if (!clean) return '';
  let hint: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lexiconHint === 'BULLISH' || lexiconHint === 'BEARISH') hint = lexiconHint;
  else if (clean.dominantAngle === 'BULLISH' || clean.dominantAngle === 'BEARISH') hint = clean.dominantAngle;
  if (hint === 'NEUTRAL') return '';
  const move24h = clean.change24h;
  const priceUp = move24h > 0.005;  // 24h 升 >0.5%
  const priceDown = move24h < -0.005; // 24h 跌 >0.5%
  if (hint === 'BULLISH' && priceUp) {
    return `     🚨 MOTIVE ALERT: DISTRIBUTION-HYPE — BULLISH headlines after price already pumped (24h ${(move24h * 100).toFixed(1)}%) → institutions likely SELLING into the narrative. Fade news-based BUY; do NOT treat bullish news as entry edge.`;
  }
  if (hint === 'BEARISH' && priceDown) {
    return `     🚨 MOTIVE ALERT: ACCUMULATION-FUD — BEARISH headlines after price already dumped (24h ${(move24h * 100).toFixed(1)}%) → institutions likely BUYING the panic. Fade news-based SELL; do NOT treat bearish news as entry edge.`;
  }
  if (hint === 'BULLISH' && priceDown) {
    return `     ⚠️ MOTIVE ALERT: NARRATIVE-PIVOT — BULLISH news while price is FALLING (24h ${(move24h * 100).toFixed(1)}%) → story released to reverse sentiment; requires PRICE CONFIRMATION upward, else it is bait.`;
  }
  if (hint === 'BEARISH' && priceUp) {
    return `     ⚠️ MOTIVE ALERT: NARRATIVE-PIVOT — BEARISH news while price is RISING (24h ${(move24h * 100).toFixed(1)}%) → story released to reverse sentiment; requires PRICE CONFIRMATION downward, else it is bait.`;
  }
  return '';
}

// ─── 5-minute in-memory cache (per symbol) ───

interface CacheEntry { result: NewsSentimentResult; ts: number; }
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

// ═══ v2.0.873-P9-news-motive-attack: 統一 sanitize 層 ═══
// 攻擊輪（紅先 25 攻 18 命中）: news-sentiment 全鏈喺 persisted/注入 garbage
// （Symbol/undefined/null/number/string pubDate）下崩潰:
//   V1 formatPriceNewsTiming pct()/toUpperCase/toFixed crash
//   V2 formatNewsForAgentMulti garbage headlines element / 非 array / results 非 array
//   V3 formatNewsForAgent lexiconScore/headlines undefined
//   V4 computePriceNewsTiming candles element garbage / headlines title Symbol
//   V6 normalizeBaseAsset null crash
// 修復: 單一 sanitize 入口——所有 formatter/compute 喺入口收垃圾, 下游只信 clean type。

/** safe number——typeof number + finite 先收, 否則 0（Symbol/BigInt/string → 0） */
function safeNewsNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** safe string——typeof string 先收（Symbol 有 toString 但唔可以入 regex/API）, 否則 '' */
function safeNewsStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** safe Date——instanceof Date 先收; 持久化 garbage（string/number）嘗試 parse, 失敗 null */
function safeNewsDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v as string | number);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/** sanitize 單條 headline——null/非 object → null（skip）; title/publisher 非 string → 中性 */
function sanitizeHeadline(h: unknown): NewsHeadline | null {
  if (!h || typeof h !== 'object') return null;
  const o = h as Record<string, unknown>;
  const title = safeNewsStr(o['title']).trim().slice(0, 200);
  if (!title) return null; // 無 title = 無資訊價值
  return {
    title,
    publisher: safeNewsStr(o['publisher']).slice(0, 100) || 'unknown',
    pubDate: safeNewsDate(o['pubDate']),
    url: safeNewsStr(o['url']).slice(0, 500) || undefined,
  };
}

/** sanitize headlines array——垃圾 element skip; 非 array → [] */
export function sanitizeHeadlines(input: unknown): NewsHeadline[] {
  if (!Array.isArray(input)) return [];
  const out: NewsHeadline[] = [];
  for (const h of input) {
    const clean = sanitizeHeadline(h);
    if (clean) out.push(clean);
    if (out.length >= 8) break; // 上下限一致（formatter cap 8）
  }
  return out;
}

/** sanitize NewsSentimentResult——garbage 字段 reset 中性, 唔會傳播落 formatter */
export function sanitizeNewsResult(r: unknown): NewsSentimentResult | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const headlines = sanitizeHeadlines(o['headlines']);
  const hint = safeNewsStr(o['lexiconHint']);
  const validHint = (hint === 'BULLISH' || hint === 'BEARISH' || hint === 'NEUTRAL') ? hint : 'NEUTRAL';
  const timing = o['priceNewsTiming'] ? sanitizePriceNewsTiming(o['priceNewsTiming']) : null;
  return {
    symbol: safeNewsStr(o['symbol']).slice(0, 50) || '?',
    category: safeNewsStr(o['category']) as AssetCategory,
    query: safeNewsStr(o['query']).slice(0, 120),
    headlineCount: Math.max(0, Math.min(8, Math.round(safeNewsNum(o['headlineCount'])))),
    headlines,
    lexiconHint: validHint,
    lexiconScore: Math.max(-1, Math.min(1, safeNewsNum(o['lexiconScore']))),
    fetchedAt: safeNewsNum(o['fetchedAt']),
    source: safeNewsStr(o['source']).slice(0, 50) || 'unknown',
    windowHours: Math.max(1, Math.min(168, Math.round(safeNewsNum(o['windowHours']) || 24))),
    priceNewsTiming: timing ?? undefined,
  };
}

/** sanitize PriceNewsTiming——garbage 字段 reset 中性（V1/V5 防禦） */
export function sanitizePriceNewsTiming(pt: unknown): PriceNewsTiming | null {
  if (!pt || typeof pt !== 'object') return null;
  const o = pt as Record<string, unknown>;
  const dir = safeNewsStr(o['preNewsMoveDir']);
  const validDir = (dir === 'up' || dir === 'down' || dir === 'flat') ? dir : 'flat';
  const cadence = safeNewsNum(o['headlineCadence']);
  const cadenceLevel = safeNewsStr(o['cadenceLevel']);
  const clustering = safeNewsNum(o['sourceClustering']);
  const dom = safeNewsStr(o['dominantAngle']);
  return {
    change1h: safeNewsNum(o['change1h']),
    change4h: safeNewsNum(o['change4h']),
    change24h: safeNewsNum(o['change24h']),
    change3d: safeNewsNum(o['change3d']),
    movedBeforeNews: o['movedBeforeNews'] === true,
    preNewsMovePct: safeNewsNum(o['preNewsMovePct']),
    preNewsMoveDir: validDir,
    headlineCadence: cadence >= 0 ? cadence : 0,
    cadenceLevel: (cadenceLevel === 'elevated' || cadenceLevel === 'low') ? cadenceLevel : 'normal',
    sourceClustering: Math.max(0, Math.min(1, clustering)),
    clusteringLevel: (() => {
      const cl = safeNewsStr(o['clusteringLevel']);
      return (cl === 'coordinated' || cl === 'independent') ? cl : 'mixed';
    })(),
    dominantAngle: (dom === 'BULLISH' || dom === 'BEARISH') ? dom : 'NEUTRAL',
  };
}

// ─── Main entry ───

export async function fetchNewsSentiment(
  symbol: string,
  /** Optional market context string (unused for now — kept for future category hints). */
  _marketContext?: string,
): Promise<NewsSentimentResult | null> {
  const cacheKey = normalizeBaseAsset(symbol);
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.result;
  }

  const category = detectCategory(symbol);
  const query = resolveNewsQuery(symbol, category);

  // Three sources in parallel — any one that resolves is enough.
  // Promise.allSettled so a single source failure doesn't reject the batch.
  // v2.0.831: Circuit breaker — skip sources in cooldown (3 consecutive failures).
  // This prevents 10 symbols × 3 sources = 30 requests when a source is down.
  const sourcesToFetch: Array<{ name: string; fn: () => Promise<NewsHeadline[]> }> = [];
  if (!isSourceInCooldown('google-news-rss')) {
    sourcesToFetch.push({ name: 'google-news-rss', fn: () => fetchGoogleNewsRSS(query) });
  }
  if (GDELT_ENABLED && !isSourceInCooldown('gdelt')) {
    sourcesToFetch.push({ name: 'gdelt', fn: () => fetchGDELT(query) });
  }
  if (!isSourceInCooldown('bing-news-rss')) {
    sourcesToFetch.push({ name: 'bing-news-rss', fn: () => fetchBingNewsRSS(query) });
  }

  // If all sources are in cooldown, return neutral (no news this cycle)
  if (sourcesToFetch.length === 0) {
    log.warn(`📰 [news] ${cacheKey}: all sources in cooldown — returning neutral (no fetch)`);
    const neutralResult: NewsSentimentResult = {
      symbol: cacheKey,
      category,
      query,
      headlineCount: 0,
      headlines: [],
      lexiconHint: 'NEUTRAL',
      lexiconScore: 0.5,
      fetchedAt: Date.now(),
      source: 'all-cooldown',
      windowHours: 24,
    };
    cache.set(cacheKey, { result: neutralResult, ts: Date.now() });
    return neutralResult;
  }

  const sourceResults = await Promise.allSettled(sourcesToFetch.map(s => s.fn()));

  // Merge ALL source results into one pool (dedup happens later).
  // v2.0.831: Record success/failure for circuit breaker.
  const mergedPool: NewsHeadline[] = [];
  let source = 'none';
  for (let i = 0; i < sourceResults.length; i++) {
    const res = sourceResults[i]!;
    const srcName = sourcesToFetch[i]!.name;
    if (res.status === 'fulfilled') {
      recordSourceSuccess(srcName);
      mergedPool.push(...res.value);
      if (res.value.length > 0 && source === 'none') source = srcName;
    } else {
      recordSourceFailure(srcName);
    }
  }
  if (mergedPool.length > 1 && source !== 'none') source = 'merged';

  // Adaptive window cascade: crypto is news-heavy (24h is plenty), but
  // low-coverage stocks (e.g. Korean SK Hynix) may have no English headlines
  // for days. Cascade 24h → 72h → 168h so the News Reporter still gets real
  // context when available. If all windows are empty, return honest NEUTRAL.
  let headlines = dedupAndFilter(mergedPool, 24);
  let windowHours = 24;
  if (headlines.length < 3) {
    const w72 = dedupAndFilter(mergedPool, 72);
    if (w72.length > headlines.length) { headlines = w72; windowHours = 72; }
  }
  if (headlines.length < 3) {
    const w168 = dedupAndFilter(mergedPool, 168);
    if (w168.length > headlines.length) { headlines = w168; windowHours = 168; }
  }
  const hint = lexiconHint(headlines);

  const result: NewsSentimentResult = {
    symbol: cacheKey,
    category,
    query,
    headlineCount: headlines.length,
    headlines,
    lexiconHint: hint.label,
    lexiconScore: hint.score,
    fetchedAt: Date.now(),
    source,
    windowHours,
  };

  cache.set(cacheKey, { result, ts: Date.now() });

  log.info(`📰 [news] ${cacheKey} (${category}): ${headlines.length} headlines via ${source}, hint=${hint.label} (${hint.score.toFixed(2)})`);
  return result;
}

// ─── Multi-symbol fetch (v2.0.77) ───
// ARCHITECTURE.md claims "每個 cycle 為所有持倉一次性 fetch 新聞". The single-symbol
// `fetchNewsSentiment` only covers the active symbol. This wrapper fetches news
// for the active symbol PLUS all other open positions (deduped, capped) so the
// News Reporter agent can evaluate sentiment for every held position, not just
// the focused one. Each symbol uses the 5-min cache, so multi-symbol only adds
// fetch cost for symbols not already cached.
//
// Cap + parallel allSettled: avoid hammering Google News/GDELT/Bing when many
// positions are open. Fail-open — any error returns null for that symbol.
//
// v2.0.831: Cap raised from 5 → 10 to support 10 trading markets.
// Added source-level circuit breaker: if a source fails 3 times in a row,
// it's skipped for 60s (cooldown) to avoid wasting requests on a down source.
// This prevents 10 symbols × 3 sources = 30 requests when one source is down
// (circuit breaker cuts it to 10 × 2 = 20, then 10 × 1 = 10 if two are down).

const MULTI_SYMBOL_CAP = 10;  // v2.0.831: raised from 5 → 10 for 10 trading markets

// v2.0.831: Source-level circuit breaker — tracks consecutive failures per source.
// After 3 consecutive failures, the source is skipped for COOLDOWN_MS.
// This prevents hammering a down/rate-limited source with 10+ requests per cycle.
interface SourceHealth {
  consecutiveFailures: number;
  cooldownUntil: number;
}
const sourceHealth = new Map<string, SourceHealth>();
const SOURCE_FAILURE_THRESHOLD = 3;
const SOURCE_COOLDOWN_MS = 60_000; // 1 min cooldown after 3 consecutive failures

/** v2.0.831: Check if a source is in cooldown (circuit breaker open). */
function isSourceInCooldown(sourceName: string): boolean {
  const health = sourceHealth.get(sourceName);
  if (!health) return false;
  if (health.consecutiveFailures < SOURCE_FAILURE_THRESHOLD) return false;
  return Date.now() < health.cooldownUntil;
}

/** v2.0.831: Record a source success (reset failure counter). */
function recordSourceSuccess(sourceName: string): void {
  const health = sourceHealth.get(sourceName);
  if (health && health.consecutiveFailures > 0) {
    health.consecutiveFailures = 0;
  }
}

/** v2.0.831: Record a source failure (increment counter, maybe enter cooldown). */
function recordSourceFailure(sourceName: string): void {
  let health = sourceHealth.get(sourceName);
  if (!health) {
    health = { consecutiveFailures: 0, cooldownUntil: 0 };
    sourceHealth.set(sourceName, health);
  }
  health.consecutiveFailures++;
  if (health.consecutiveFailures >= SOURCE_FAILURE_THRESHOLD) {
    health.cooldownUntil = Date.now() + SOURCE_COOLDOWN_MS;
    log.warn(`📰 [news] Source "${sourceName}" entered cooldown (${health.consecutiveFailures} consecutive failures) — skipping for ${SOURCE_COOLDOWN_MS / 1000}s`);
  }
}

export async function fetchNewsForSymbols(
  symbols: string[],
  _marketContext?: string,
): Promise<(NewsSentimentResult | null)[]> {
  // Dedup by normalized base asset, preserve order, cap to MULTI_SYMBOL_CAP.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const s of symbols) {
    const key = normalizeBaseAsset(s);
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(s);
      if (unique.length >= MULTI_SYMBOL_CAP) break;
    }
  }
  // Parallel fetch — allSettled so one failure doesn't reject the batch.
  // The 5-min per-symbol cache means symbols already fetched this cycle are free.
  // v2.0.831: Circuit breaker inside fetchNewsSentiment skips cooldown sources.
  const results = await Promise.all(unique.map((s) =>
    fetchNewsSentiment(s, _marketContext).catch(() => null),
  ));
  return results;
}

// ─── Formatter: builds the "=== NEWS SENTIMENT ===" block for agents ───
// Label matches the News Reporter system prompt trigger exactly.

function ageLabel(pubDate: Date | null): string {
  // v2.0.873-P9-news-motive-attack (V2): pubDate 垃圾（string/number）→ '?'——唔 crash
  if (!(pubDate instanceof Date) || !Number.isFinite(pubDate.getTime())) return '?';
  const mins = Math.round((Date.now() - pubDate.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function formatNewsForAgent(result: NewsSentimentResult | null): string {
  // v2.0.873-P9-news-motive-attack (V3): garbage result（lexiconScore undefined /
  // headlines 非 array / pubDate 垃圾元素）→ sanitize 至中性——唔 crash。
  const clean = sanitizeNewsResult(result);
  if (!clean || clean.headlineCount === 0) {
    // Still emit the trigger label so the News Reporter knows news was
    // attempted but unavailable — it should output NEUTRAL/HOLD per its
    // prompt ("Do NOT trade based on news alone — news is slow").
    return `=== NEWS SENTIMENT ===\n${clean?.symbol ?? '?'}: no recent news — NEUTRAL (no data)`;
  }
  const lines: string[] = [
    `=== NEWS SENTIMENT ===`,
    `${clean.symbol}: ${clean.headlineCount} headlines (last ${clean.windowHours}h), lexicon hint: ${clean.lexiconHint} (${clean.lexiconScore >= 0 ? '+' : ''}${clean.lexiconScore.toFixed(2)}) — source: ${clean.source}`,
  ];
  for (const h of clean.headlines.slice(0, 8)) {
    const emoji = h.title.match(new RegExp(`\\b(${[...POSITIVE_WORDS].slice(0, 12).join('|')})\\b`, 'i'))
      ? '🟢'
      : h.title.match(new RegExp(`\\b(${[...NEGATIVE_WORDS].slice(0, 12).join('|')})\\b`, 'i'))
        ? '🔴'
        : '⚪';
    lines.push(`  ${emoji} [${h.publisher}, ${ageLabel(h.pubDate)}] ${h.title.slice(0, 120)}`);
  }
  lines.push(`[News Reporter: analyze positive/negative sentiment from these REAL headlines — news is TACTICAL, confirm other signals]`);
  return lines.join('\n');
}

// ─── Multi-symbol formatter (v2.0.77) ───
// Concatenates per-symbol news blocks into one context string. The first block
// is the active symbol (full 8 headlines); subsequent blocks are other open
// positions, each capped at 3 headlines to keep total context bounded when
// multiple positions are held. Empty results still emit a NEUTRAL line so the
// agent knows news was attempted for that symbol.
export function formatNewsForAgentMulti(results: (NewsSentimentResult | null)[]): string {
  // v2.0.873-P9-news-motive-attack (V2): results 非 array / garbage element /
  // headlines 垃圾元素（null/Symbol/number title, pubDate string）→ 入口 sanitize
  // ——唔 crash（持久化污染唔可以殺 formatter）。
  if (!Array.isArray(results) || results.length === 0) return '';
  const blocks: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = sanitizeNewsResult(results[i]);
    if (!r || r.headlineCount === 0) {
      blocks.push(`${r?.symbol ?? '?'}: no recent news — NEUTRAL (no data)`);
      continue;
    }
    // First symbol: full detail (up to 8). Others: compact (up to 3).
    const cap = i === 0 ? 8 : 3;
    const lines = [
      `${r.symbol}: ${r.headlineCount} headlines (last ${r.windowHours}h), hint: ${r.lexiconHint} (${r.lexiconScore >= 0 ? '+' : ''}${r.lexiconScore.toFixed(2)}) — ${r.source}`,
    ];
    for (const h of r.headlines.slice(0, cap)) {
      const emoji = h.title.match(new RegExp(`\b(${[...POSITIVE_WORDS].slice(0, 12).join('|')})\b`, 'i'))
        ? '🟢'
        : h.title.match(new RegExp(`\b(${[...NEGATIVE_WORDS].slice(0, 12).join('|')})\b`, 'i'))
          ? '🔴'
          : '⚪';
      lines.push(`  ${emoji} [${h.publisher}, ${ageLabel(h.pubDate)}] ${h.title.slice(0, 120)}`);
    }
    // v2.0.139: append the price-news timing block (institutional front-run tell)
    // v2.0.873-P9-news-motive: 傳 lexiconHint——motive alert（DISTRIBUTION-HYPE etc.）
    // 直接喺 data 層判讀並標註（唔靠 LLM 自己查 prompt 記憶表——實測執行率得 25%）
    if (r.priceNewsTiming) {
      lines.push(formatPriceNewsTiming(r.priceNewsTiming, r.lexiconHint));
    }
    blocks.push(lines.join('\n'));
  }
  return `=== NEWS SENTIMENT ===\n${blocks.join('\n---\n')}`;
}

// ─── v2.0.109: Global Breaking News (Top 10 international headlines) ───
//
// Fetches the TOP 10 breaking international headlines from Google News RSS.
// These are NOT symbol-specific — they are global market-moving news that
// Meta-Agent uses to assess cross-asset correlations and macro context.
//
// Examples: "Fed cuts rates 50bps", "OPEC announces production cut",
// "SEC sues Binance", "China announces stimulus package"
//
// Meta-Agent receives these headlines and must determine whether any of them
// have a logical or correlated impact on the assets currently being traded.

export interface GlobalNewsHeadline {
  title: string;
  publisher: string;
  pubDate: Date | null;
  url?: string;
}

export interface GlobalNewsResult {
  headlines: GlobalNewsHeadline[];
  fetchedAt: number;
  source: string;
}

// 5-minute cache for global news (same cadence as per-symbol news)
let globalNewsCache: GlobalNewsResult | null = null;
let globalNewsCacheTime = 0;
const GLOBAL_NEWS_CACHE_TTL = 300_000; // 5 min

/**
 * Fetch the TOP 10 breaking international headlines from Google News RSS.
 * These are general market/business headlines, not symbol-specific.
 * Used by Meta-Agent for cross-asset correlation analysis.
 */
export async function fetchGlobalBreakingNews(): Promise<GlobalNewsResult | null> {
  // Check cache
  if (globalNewsCache && Date.now() - globalNewsCacheTime < GLOBAL_NEWS_CACHE_TTL) {
    return globalNewsCache;
  }

  try {
    // Google News RSS "Business" + "World" categories — top breaking headlines
    // We fetch from the general "business" section which covers markets, economy, geopolitics
    const headlines: GlobalNewsHeadline[] = [];

    // Source 1: Google News Business RSS (top breaking business/market news)
    const businessUrl = 'https://news.google.com/rss/search?q=stock+market+OR+federal+reserve+OR+economy+OR+crypto+OR+bitcoin+OR+oil+OR+gold+OR+geopolitics+OR+tariff+OR+inflation+OR+recession&hl=en-US&gl=US&ceid=US:en';
    try {
      const res = await fetch(businessUrl, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const xml = await res.text();
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
        for (const item of items.slice(0, 10)) {
          const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
          const pubMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
          const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
          const linkMatch = item.match(/<link>(.*?)<\/link>/);
          if (titleMatch?.[1]) {
            headlines.push({
              title: titleMatch[1].trim(),
              publisher: sourceMatch?.[1]?.trim() ?? 'Google News',
              pubDate: pubMatch?.[1] ? new Date(pubMatch[1].trim()) : null,
              url: linkMatch?.[1]?.trim(),
            });
          }
        }
      }
    } catch {
      // Fail-open — try next source
    }

    // Source 2: Bing News RSS as fallback (if Google News returned < 5 headlines)
    if (headlines.length < 5) {
      try {
        const bingUrl = 'https://www.bing.com/news/search?q=breaking+market+news+economy+geopolitics&format=rss';
        const res = await fetch(bingUrl, { signal: AbortSignal.timeout(6_000) });
        if (res.ok) {
          const xml = await res.text();
          const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
          for (const item of items.slice(0, 10)) {
            const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
            const pubMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
            const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
            if (titleMatch?.[1]) {
              // Dedup by title
              const title = titleMatch[1].trim();
              if (!headlines.some(h => h.title === title)) {
                headlines.push({
                  title,
                  publisher: sourceMatch?.[1]?.trim() ?? 'Bing News',
                  pubDate: pubMatch?.[1] ? new Date(pubMatch[1].trim()) : null,
                });
              }
            }
          }
        }
      } catch {
        // Fail-open
      }
    }

    if (headlines.length === 0) {
      log.debug('[global-news] No headlines fetched from any source');
      return null;
    }

    // Sort by date (newest first), cap at 10
    headlines.sort((a, b) => {
      if (!a.pubDate && !b.pubDate) return 0;
      if (!a.pubDate) return 1;
      if (!b.pubDate) return -1;
      return b.pubDate.getTime() - a.pubDate.getTime();
    });

    const result: GlobalNewsResult = {
      headlines: headlines.slice(0, 10),
      fetchedAt: Date.now(),
      source: headlines.length >= 5 ? 'Google News RSS' : 'Google News + Bing News RSS',
    };

    // Update cache
    globalNewsCache = result;
    globalNewsCacheTime = Date.now();

    log.info(`🌍 [global-news] Fetched ${result.headlines.length} breaking headlines from ${result.source}`);
    return result;
  } catch {
    log.debug('[global-news] Failed to fetch global breaking news');
    return null;
  }
}

/**
 * Format global breaking news for Meta-Agent context injection.
 * Meta-Agent receives these headlines and must assess cross-asset impact.
 */
export function formatGlobalNewsForMetaAgent(result: GlobalNewsResult | null): string {
  if (!result || result.headlines.length === 0) {
    return '';
  }

  const lines: string[] = [
    '=== GLOBAL BREAKING NEWS (Top 10 — Cross-Asset Impact Analysis) ===',
    '⚠️ META-AGENT: You MUST analyze whether ANY of these headlines have a logical or correlated',
    'impact on the assets you are currently trading (BTC, xyz:SKHX, xyz:SILVER, etc.).',
    'Consider: macro cascading effects, sector rotation, risk-on/risk-off shifts, currency impacts,',
    'commodity supply/demand changes, geopolitical risk premiums, and regulatory developments.',
    'If a headline directly impacts a traded asset → factor it into your entryThesis or holdReason.',
    '',
  ];

  for (let i = 0; i < result.headlines.length; i++) {
    const h = result.headlines[i]!;
    const emoji = h.title.match(new RegExp(`\\b(${[...POSITIVE_WORDS].slice(0, 15).join('|')})\\b`, 'i'))
      ? '🟢'
      : h.title.match(new RegExp(`\\b(${[...NEGATIVE_WORDS].slice(0, 15).join('|')})\\b`, 'i'))
        ? '🔴'
        : '⚪';
    lines.push(`${i + 1}. ${emoji} [${h.publisher}, ${ageLabel(h.pubDate)}] ${h.title.slice(0, 150)}`);
  }

  lines.push('');
  lines.push('CROSS-ASSET CORRELATION GUIDE:');
  lines.push('  • Fed/ECB rate decisions → ALL assets (risk-on/off, DXY, gold, crypto)');
  lines.push('  • Geopolitical conflict → oil ↑, gold ↑, risk assets ↓, safe-haven flows');
  lines.push('  • Crypto regulation → BTC/ETH direct impact, correlated alts');
  lines.push('  • AI/semiconductor news → SK Hynix, Nvidia, tech indices direct impact');
  lines.push('  • Inflation/CPI data → gold, silver, FX, rate-sensitive assets');
  lines.push('  • Trade/tariff news → commodities, FX, supply chain stocks');
  lines.push('  • Recession indicators → risk assets ↓, bonds/gold ↑, defensive rotation');

  return lines.join('\n');
}