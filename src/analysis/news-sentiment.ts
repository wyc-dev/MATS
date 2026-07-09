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

async function fetchGDELT(query: string, limit = 10): Promise<NewsHeadline[]> {
  // GDELT doc API: mode=ArtList returns { articles: [...] }
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${limit * 2}&format=json&sort=datedesc`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
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

/** Classify a single headline's angle via the same lexicon as `lexiconHint`. */
function classifyAngle(title: string): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
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
  if (candles.length < 5 || headlines.length === 0) return null;
  const sorted = [...candles].sort((a, b) => a.t - b.t);
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
  const validDates = headlines
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

/** Format the price-news timing block for agent context (the 📊 section). */
export function formatPriceNewsTiming(pt: PriceNewsTiming): string {
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const lines = [
    `  📊 PRICE-NEWS TIMING:`,
    `     Recent move: 1h ${pct(pt.change1h)} | 4h ${pct(pt.change4h)} | 24h ${pct(pt.change24h)} | 3d ${pct(pt.change3d)}`,
  ];
  if (pt.movedBeforeNews) {
    lines.push(`     ⚡ Price MOVED ${pt.preNewsMoveDir.toUpperCase()} ${(Math.abs(pt.preNewsMovePct) * 100).toFixed(1)}% BEFORE the news cluster → institutions likely PRE-POSITIONED (front-run tell)`);
  } else {
    lines.push(`     No meaningful pre-news move (${pct(pt.preNewsMovePct)} over the pre-news window) → news not obviously front-run`);
  }
  lines.push(`     Headline cadence: ${pt.headlineCadence.toFixed(1)}/day (${pt.cadenceLevel}) | Source clustering: ${(pt.sourceClustering * 100).toFixed(0)}% (${pt.clusteringLevel}, dominant=${pt.dominantAngle})`);
  return lines.join('\n');
}

// ─── 5-minute in-memory cache (per symbol) ───

interface CacheEntry { result: NewsSentimentResult; ts: number; }
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

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
  const [gRes, gdeltRes, bingRes] = await Promise.allSettled([
    fetchGoogleNewsRSS(query),
    fetchGDELT(query),
    fetchBingNewsRSS(query),
  ]);

  // Merge ALL source results into one pool (dedup happens later).
  // Track which tier served so we can report it, but always merge for max coverage.
  const mergedPool: NewsHeadline[] = [];
  let source = 'none';
  if (gRes.status === 'fulfilled') { mergedPool.push(...gRes.value); if (gRes.value.length > 0) source = 'google-news-rss'; }
  if (gdeltRes.status === 'fulfilled') { mergedPool.push(...gdeltRes.value); if (source === 'none' && gdeltRes.value.length > 0) source = 'gdelt'; }
  if (bingRes.status === 'fulfilled') { mergedPool.push(...bingRes.value); if (source === 'none' && bingRes.value.length > 0) source = 'bing-news-rss'; }
  if (mergedPool.length > 1 && (gRes.status === 'fulfilled' || gdeltRes.status === 'fulfilled' || bingRes.status === 'fulfilled')) source = 'merged';

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

const MULTI_SYMBOL_CAP = 5;  // max symbols to fetch per cycle (active + 4 others)

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
  const results = await Promise.all(unique.map((s) =>
    fetchNewsSentiment(s, _marketContext).catch(() => null),
  ));
  return results;
}

// ─── Formatter: builds the "=== NEWS SENTIMENT ===" block for agents ───
// Label matches the News Reporter system prompt trigger exactly.

function ageLabel(pubDate: Date | null): string {
  if (!pubDate) return '?';
  const mins = Math.round((Date.now() - pubDate.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function formatNewsForAgent(result: NewsSentimentResult | null): string {
  if (!result || result.headlineCount === 0) {
    // Still emit the trigger label so the News Reporter knows news was
    // attempted but unavailable — it should output NEUTRAL/HOLD per its
    // prompt ("Do NOT trade based on news alone — news is slow").
    return `=== NEWS SENTIMENT ===\n${result?.symbol ?? '?'}: no recent news — NEUTRAL (no data)`;
  }
  const lines: string[] = [
    `=== NEWS SENTIMENT ===`,
    `${result.symbol}: ${result.headlineCount} headlines (last ${result.windowHours}h), lexicon hint: ${result.lexiconHint} (${result.lexiconScore >= 0 ? '+' : ''}${result.lexiconScore.toFixed(2)}) — source: ${result.source}`,
  ];
  for (const h of result.headlines.slice(0, 8)) {
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
  if (results.length === 0) return '';
  const blocks: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
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
    if (r.priceNewsTiming) {
      lines.push(formatPriceNewsTiming(r.priceNewsTiming));
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