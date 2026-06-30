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
  NDX: 'Nasdaq 100', QQQ: 'Nasdaq 100',
  DJI: 'Dow Jones Industrial', DIA: 'Dow Jones Industrial',
  VIX: 'VIX volatility index', UVXY: 'VIX volatility index',
  RUT: 'Russell 2000',
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

function normalizeBaseAsset(symbol: string): string {
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
    blocks.push(lines.join('\n'));
  }
  return `=== NEWS SENTIMENT ===\n${blocks.join('\n---\n')}`;
}