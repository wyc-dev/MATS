// ─── Agent 1: Fractal Momentum Sentinel ───
// High temperature, aggressive, momentum-chasing. Detects fractal patterns & trend acceleration.

import { BaseAgent } from './base-agent.ts';
import type { TradingDecision } from '../types/index.ts';
import { normalizeDecision } from '../trading/decision-utils.ts';
// v2.0.42: Import normalizeSymbol for consistent symbol casing.
import { normalizeSymbol } from '../trading/portfolio.ts';
import { createLogger } from '../observability/logger.ts';

export class FractalMomentumSentinel extends BaseAgent {
  constructor() {
    super({
      role: 'fractal_momentum_sentinel',
      name: 'Fractal Momentum Sentinel',
      temperature: 0.85,
      weight: 0.10,
      modelPreference: 'fast',
      personality:
        'You are a fractal mathematician turned trader. You see self-similar patterns across timeframes. '
        + 'You are aggressive but disciplined — you only strike when multiple timeframe align. '
        + 'You are the early signal detector, the first to spot trend acceleration. '
        + 'You are contrarian at extremes, trend-follower in the middle. '
        + 'You respect momentum but know when it exhausts.',
    });
  }

  override getSystemPrompt(): string {
    return `You are Fractal Momentum Sentinel — momentum/fractal pattern detector.

You evaluate ALL trading pairs every cycle:
1. MARKET TICKER (${this.marketSymbol}) — should we open a new trade?
2. Each OPEN POSITION — should we hold, adjust SL/TP, or close?

=== MARKET TICKER RULES ===
- Low vol sideways → small mean-reversion (2-3%)
- Trending → FOLLOW THE TREND with 3-5%, up to 8% if strong trend. If price has been
  rising for multiple cycles, BUY is the DEFAULT — do not fight the trend.
- High vol → reduce size 50%, still trade if setup exists
- Chaotic → HOLD (only legitimate HOLD reason)
- ⚠️ v2.0.115: MISSING a trending move is as bad as taking a bad trade. If price has
  moved >3% in one direction over recent cycles and you output HOLD, you are leaving
  money on the table. Trend-following entries in confirmed trends have HIGH win rates.
  Actively SCAN for trend entries every cycle. "Never force a trade" does NOT mean
  "default to HOLD" — it means "don't trade on noise." A confirmed trend is NOT noise.
- Leverage 2-5x based on confidence

=== OPEN POSITION RULES ===
For each open position, evaluate:
- Is the fractal structure still intact? If broken → close
- Trend continuation? → hold, trail SL up
- Trend reversal? → close immediately
- Price near TP? → tighten SL to lock profit, consider closing
- Price near SL? → let it run unless structure invalidated
- Profit > 5%? → consider partial or full close to lock gains
- Loss > 3%? → evaluate if thesis is still valid; if not, close
- Adjust SL/TP to follow fractal structure levels

=== PLANCK-CHAOS RESONANCE ===
If the context contains "=== PLANCK-CHAOS RESONANCE ===":
  - Lyapunov λ indicates predictability: λ > 0 = chaotic (short-term direction unreliable)
  - Resonance frequencies show dominant cycles — if a 60-120min cycle is strong,
    fractal patterns at that scale are more reliable
  - Amplitude windows (2h/4h/8h) show expected price range — use these to set
    realistic TP targets and SL levels
  - Direction bias from cycle phase: BUY at bottom, SELL at top
  - If regime = CHAOTIC → your fractal patterns are less reliable, reduce confidence
  - If regime = EDGE OF CHAOS → fractal patterns are MOST reliable, increase confidence
  - If regime = LAMINAR → trend is stable, fractal continuation is likely

Output ONLY valid JSON with the format specified in the user message.`;
  }

  /** override parseResponse to use base class multi-symbol parser */
  protected override parseResponse(content: string): {
    thought: string;
    confidence: number;
    decision: TradingDecision;
  } {
    return super.parseResponse(content);
  }
}

// ─── Agent 2: On-Chain Whisperer ───
// Medium temperature, analytical. Reads on-chain data with asset-category awareness.
// - Crypto assets → fetches live blockchain data (mempool, exchange flows, whale tx)
// - TradFi assets (indices, stocks, FX, commodities) → fetches macro flow data (ETF flows, futures positioning, DXY)
// - Unknown assets → web_search fallback to discover how to fetch on-chain data

const ocwLog = createLogger({ agent: 'onchain_whisperer', phase: 'data-fetch' });

// ── Token → Blockchain lookup for on-chain data ──

interface TokenChainInfo {
  baseAsset: string;
  chain: string;
  coingeckoId: string;
}

const KNOWN_CRYPTO: Record<string, TokenChainInfo> = {
  BTC:       { baseAsset: 'BTC',       chain: 'bitcoin',    coingeckoId: 'bitcoin' },
  XBT:       { baseAsset: 'XBT',       chain: 'bitcoin',    coingeckoId: 'bitcoin' },
  ETH:       { baseAsset: 'ETH',       chain: 'ethereum',   coingeckoId: 'ethereum' },
  SOL:       { baseAsset: 'SOL',       chain: 'solana',     coingeckoId: 'solana' },
  BNB:       { baseAsset: 'BNB',       chain: 'bsc',        coingeckoId: 'binancecoin' },
  XRP:       { baseAsset: 'XRP',       chain: 'ripple',     coingeckoId: 'ripple' },
  ADA:       { baseAsset: 'ADA',       chain: 'cardano',    coingeckoId: 'cardano' },
  DOGE:      { baseAsset: 'DOGE',      chain: 'dogecoin',   coingeckoId: 'dogecoin' },
  DOT:       { baseAsset: 'DOT',       chain: 'polkadot',   coingeckoId: 'polkadot' },
  AVAX:      { baseAsset: 'AVAX',      chain: 'avalanche',  coingeckoId: 'avalanche-2' },
  MATIC:     { baseAsset: 'MATIC',     chain: 'polygon',    coingeckoId: 'matic-network' },
  POL:       { baseAsset: 'POL',       chain: 'polygon',    coingeckoId: 'polygon-ecosystem-token' },
  LINK:      { baseAsset: 'LINK',      chain: 'ethereum',   coingeckoId: 'chainlink' },
  UNI:       { baseAsset: 'UNI',       chain: 'ethereum',   coingeckoId: 'uniswap' },
  ATOM:      { baseAsset: 'ATOM',      chain: 'cosmos',     coingeckoId: 'cosmos' },
  ARB:       { baseAsset: 'ARB',       chain: 'arbitrum',   coingeckoId: 'arbitrum' },
  OP:        { baseAsset: 'OP',        chain: 'optimism',   coingeckoId: 'optimism' },
  SUI:       { baseAsset: 'SUI',       chain: 'sui',        coingeckoId: 'sui' },
  NEAR:      { baseAsset: 'NEAR',      chain: 'near',       coingeckoId: 'near' },
  APT:       { baseAsset: 'APT',       chain: 'aptos',      coingeckoId: 'aptos' },
  INJ:       { baseAsset: 'INJ',       chain: 'injective',  coingeckoId: 'injective-protocol' },
  SEI:       { baseAsset: 'SEI',       chain: 'sei',        coingeckoId: 'sei-network' },
  TIA:       { baseAsset: 'TIA',       chain: 'celestia',   coingeckoId: 'celestia' },
  FTM:       { baseAsset: 'FTM',       chain: 'fantom',     coingeckoId: 'fantom' },
  S:          { baseAsset: 'S',         chain: 'sonic',      coingeckoId: 'sonic-svm' },
  TRUMP:     { baseAsset: 'TRUMP',     chain: 'solana',     coingeckoId: 'official-trump' },
  MELANIA:   { baseAsset: 'MELANIA',   chain: 'solana',     coingeckoId: 'melania-meme' },
};

// Normalise symbol: strip exchange prefix (xyz:, flx:, etc.), USDT/USD suffix
function normalizeBaseAsset(symbol: string): string {
  const colonIdx = symbol.indexOf(':');
  const stripped = colonIdx >= 0 ? symbol.slice(colonIdx + 1) : symbol;
  return stripped.toUpperCase().replace(/USDT$/, '').replace(/USD$/, '').replace(/PERP$/, '');
}

// ── Category detection from market context ──

type AssetCategory = 'crypto' | 'indices' | 'stocks' | 'commodities' | 'fx' | 'preipo' | 'unknown';

function detectAssetCategory(symbol: string, marketContext: string): AssetCategory {
  const upper = symbol.toUpperCase();

  // Check for known crypto base assets
  const base = normalizeBaseAsset(symbol);
  if (KNOWN_CRYPTO[base]) return 'crypto';

  // Known crypto perps on HL
  if (!symbol.includes(':') && KNOWN_CRYPTO[base]) return 'crypto';

  // Check context for explicit Asset Filter
  if (/asset\s*filter:\s*indices/i.test(marketContext)) return 'indices';
  if (/asset\s*filter:\s*stocks/i.test(marketContext)) return 'stocks';
  if (/asset\s*filter:\s*commodities/i.test(marketContext)) return 'commodities';
  if (/asset\s*filter:\s*fx/i.test(marketContext)) return 'fx';
  if (/asset\s*filter:\s*tradfi/i.test(marketContext)) return 'stocks';
  if (/asset\s*filter:\s*crypto/i.test(marketContext)) return 'crypto';

  // Heuristic: colon prefix usually means TradFi (xyz:SP500, flx:NVDA, km:MU)
  if (symbol.includes(':')) {
    const knownTradFi = ['SP500', 'SPX', 'NDX', 'DJI', 'VIX', 'NVDA', 'AAPL', 'MSFT', 'GOOGL',
      'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'DXY', 'EUR', 'GBP', 'JPY', 'XAU', 'XAG', 'OIL',
      'BTC', 'ETH', 'SOL'];
    for (const tf of knownTradFi) {
      if (upper.includes(tf)) {
        // If it matches a known crypto name too, check more carefully
        if (KNOWN_CRYPTO[tf]) continue;
        if (['SP500', 'SPX', 'NDX', 'DJI', 'VIX', 'DXY'].includes(tf)) return 'indices';
        if (['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY'].includes(tf)) return 'stocks';
        if (['XAU', 'XAG', 'OIL', 'COPPER'].includes(tf)) return 'commodities';
        if (['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNH', 'HKD', 'SGD'].includes(tf)) return 'fx';
      }
    }
    // Default: colon-prefixed but not in known list → check perpCategories via symbol name
    // Symbols with uppercase letters and : are likely TradFi
    return 'stocks';
  }

  // Default: assume crypto for non-colon assets on crypto exchanges
  return 'crypto';
}

// ── Web search fallback (DuckDuckGo Lite HTML + Instant Answer hybrid) ──

/** Browser UA header for HTML scraping endpoints */
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function webSearch(query: string, maxRetries = 2): Promise<string> {
  // Strategy 1: DuckDuckGo HTML search (works with browser UA)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&ia=web`;
      const res = await fetch(url, { headers: { 'User-Agent': WEB_UA }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      // Extract result link text (format: <a class="result__a" href="...">TEXT</a>)
      const links: string[] = [];
      const linkRegex = /class="result__a"[^>]*>([^<]*)</g;
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(html)) !== null) {
        const t = m[1]!.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (t.length > 5) links.push(t);
      }
      if (links.length >= 2) return links.slice(0, 5).join(' | ');
      // Fallback: snippets
      const snippets: string[] = [];
      const snippetRegex = /class="result__snippet"[^>]*>([^<]*)</g;
      while ((m = snippetRegex.exec(html)) !== null) {
        const s = m[1]!.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim();
        if (s.length > 10) snippets.push(s);
      }
      if (snippets.length >= 2) return snippets.slice(0, 3).join(' | ');
    } catch {
      // Retry or fall through
    }
  }

  // Strategy 2: DuckDuckGo Instant Answer API (good for definitions/facts)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        AbstractText?: string; Answer?: string; Definition?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Result?: string }>;
      };
      const parts: string[] = [];
      if (data.Answer) parts.push(`Answer: ${data.Answer}`);
      if (data.AbstractText) parts.push(`Summary: ${data.AbstractText.slice(0, 300)}`);
      if (data.Definition) parts.push(`Definition: ${data.Definition}`);
      if (parts.length === 0 && data.RelatedTopics?.length) {
        parts.push(`Related: ${data.RelatedTopics.slice(0, 3).map(t => t.Text ?? '').join(' | ')}`);
      }
      if (parts.length > 0) return parts.join('\n');
    } catch {
      // Try next attempt
    }
  }

  // Strategy 3: Google News RSS as final fallback
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const rssRes = await fetch(rssUrl, { signal: AbortSignal.timeout(6_000) });
    if (rssRes.ok) {
      const xml = await rssRes.text();
      const titles: string[] = [];
      const titleRegex = /<item>[\s\S]*?<title[^>]*><!\[CDATA\[([^\]]*)\]\]><\/title>|<item>[\s\S]*?<title[^>]*>([^<]*)<\/title>/g;
      let tm: RegExpExecArray | null;
      while ((tm = titleRegex.exec(xml)) !== null) {
        const t = (tm[1] ?? tm[2] ?? '').replace(/&amp;/g, '&').trim();
        if (t && !t.includes('Google News') && t.length > 10) titles.push(t);
      }
      if (titles.length >= 2) return titles.slice(0, 5).join(' | ');
    }
  } catch { /* final */ }

  return `[Web Search] Found no direct results for "${query}".`;
}

// ── On-chain data fetchers ──

/** Fetch BTC on-chain data from mempool.space */
async function fetchBTCOnChain(): Promise<string> {
  try {
    // Hashrate — use 1wk endpoint (pool/1w returns "pool does not exist" for many)
    const lines: string[] = ['--- BTC On-Chain (mempool.space) ---'];
    try {
      const hrRes = await fetch('https://mempool.space/api/v1/mining/hashrate/1w', { signal: AbortSignal.timeout(6_000) });
      if (hrRes.ok) {
        const hrData = await hrRes.json() as { hashrates?: Array<{ avgHashrate: number }> };
        if (hrData.hashrates?.length) {
          const latestHr = hrData.hashrates[hrData.hashrates.length - 1]!.avgHashrate;
          lines.push(`Hashrate (1w avg): ${(latestHr / 1e18).toFixed(2)} EH/s`);
        }
      }
    } catch { /* non-critical */ }

    // Latest block info
    try {
      const blockRes = await fetch('https://mempool.space/api/blocks/tip/height', { signal: AbortSignal.timeout(4_000) });
      if (blockRes.ok) {
        const height = await blockRes.text();
        lines.push(`Block Height: ${height}`);
      }
    } catch { /* non-critical */ }

    // Fee estimates
    try {
      const feeRes = await fetch('https://mempool.space/api/v1/fees/recommended', { signal: AbortSignal.timeout(4_000) });
      if (feeRes.ok) {
        const fees = await feeRes.json() as { fastestFee?: number; halfHourFee?: number; hourFee?: number; minimumFee?: number };
        if (fees.fastestFee !== undefined) lines.push(`Fees (fast/30m/1h): ${fees.fastestFee}/${fees.halfHourFee ?? '?'}/${fees.hourFee ?? '?'} sat/vB`);
      }
    } catch { /* non-critical */ }

    return lines.join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `BTC on-chain unavailable: ${msg}`;
  }
}

/** Fetch ETH on-chain data via CoinGecko (Etherscan free tier rate-limits without API key) */
async function fetchETHOnChain(): Promise<string> {
  // Use CoinGecko ETH data instead — more reliable than free-tier Etherscan
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/ethereum?localization=false&tickers=true&community_data=false&developer_data=false',
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json() as {
      market_data?: {
        current_price?: { usd?: number };
        price_change_percentage_24h?: number;
        total_volume?: { usd?: number };
        market_cap?: { usd?: number };
        circulating_supply?: number;
        total_supply?: number;
      };
    };
    const lines: string[] = ['--- ETH On-Chain (CoinGecko) ---'];
    const md = data.market_data;
    if (!md) return 'ETH on-chain data unavailable.';
    if (md.current_price?.usd) lines.push(`ETH/USD: $${md.current_price.usd.toFixed(2)}`);
    if (md.price_change_percentage_24h !== undefined) lines.push(`24h Change: ${md.price_change_percentage_24h >= 0 ? '+' : ''}${md.price_change_percentage_24h.toFixed(2)}%`);
    if (md.market_cap?.usd) lines.push(`Market Cap: $${(md.market_cap.usd / 1e9).toFixed(2)}B`);
    if (md.circulating_supply) lines.push(`Circ Supply: ${(md.circulating_supply / 1e6).toFixed(1)}M`);
    if (md.total_volume?.usd) lines.push(`24h Volume: $${(md.total_volume.usd / 1e6).toFixed(2)}M`);
    return lines.join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `ETH on-chain unavailable: ${msg}`;
  }
}

/** Fetch generic crypto on-chain data via CoinGecko (exchange flow proxy) */
async function fetchCoinGeckoMarketData(coingeckoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coingeckoId}?localization=false&tickers=true&community_data=false&developer_data=false`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);

    const data = await res.json() as {
      market_data?: {
        current_price?: { usd?: number };
        price_change_percentage_24h?: number;
        total_volume?: { usd?: number };
        market_cap?: { usd?: number };
        circulating_supply?: number;
        total_supply?: number;
        max_supply?: number | null;
        price_change_percentage_24h_in_currency?: { usd?: number };
        ath?: { usd?: number };
        ath_date?: { usd?: string };
      };
      tickers?: Array<{
        market?: { name?: string };
        volume?: number;
        trade_url?: string;
        base?: string;
        target?: string;
        converted_volume?: { usd?: number };
      }>;
    };

    const lines: string[] = [`--- ${coingeckoId} On-Chain (CoinGecko) ---`];
    const md = data.market_data;
    if (!md) return `${coingeckoId}: no market data available.`;

    if (md.current_price?.usd) lines.push(`Price: $${md.current_price.usd.toFixed(4)}`);
    if (md.price_change_percentage_24h !== undefined) {
      const chg = md.price_change_percentage_24h;
      lines.push(`24h Change: ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`);
    }
    if (md.total_volume?.usd) lines.push(`24h Volume: $${(md.total_volume.usd / 1e6).toFixed(2)}M`);
    if (md.market_cap?.usd) lines.push(`Market Cap: $${(md.market_cap.usd / 1e9).toFixed(2)}B`);
    if (md.circulating_supply) {
      const cs = md.circulating_supply;
      const total = md.total_supply ?? 0;
      lines.push(`Circ Supply: ${(cs / 1e6).toFixed(1)}M${total > 0 ? ` / ${(total / 1e6).toFixed(1)}M (${((cs / total) * 100).toFixed(1)}%)` : ''}`);
    }
    if (md.ath?.usd && md.ath_date?.usd) {
      const athDate = new Date(md.ath_date.usd).toISOString().slice(0, 10);
      lines.push(`ATH: $${md.ath.usd.toFixed(2)} (${athDate})`);
    }

    // Top CEX exchange tickers as flow proxy
    const cexTickers = (data.tickers ?? [])
      .filter(t => t.market?.name && ['Binance', 'Coinbase', 'Kraken', 'OKX', 'Bybit', 'Bitfinex', 'HTX'].includes(t.market.name))
      .slice(0, 4);
    if (cexTickers.length > 0) {
      lines.push(`CEX Flow: ${cexTickers.map(t => `${t.market!.name}=$${(t.converted_volume?.usd ?? 0) / 1e6}M`).join(', ')}`);
    }

    return lines.join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${coingeckoId} on-chain unavailable: ${msg}`;
  }
}

/** Fetch macro flow data for TradFi assets (ETF flows, futures positioning, DXY) */
async function fetchTradFiFlowData(symbol: string, category: AssetCategory): Promise<string> {
  const base = normalizeBaseAsset(symbol);
  const lines: string[] = [`--- ${base} Macro Flow Data ---`];

  try {
    if (category === 'indices') {
      // Try to fetch index-specific macro info
      if (base.includes('SP') || base.includes('NDX') || base.includes('DJI')) {
        const searchResult = await webSearch(`${base} futures positioning COT report latest`);
        lines.push(`Futures Positioning: ${searchResult.slice(0, 200)}`);
      }
      // DXY correlation
      try {
        const dxyRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(5_000) });
        if (dxyRes.ok) {
          const dxy = await dxyRes.json() as { rates?: Record<string, number> };
          if (dxy.rates) {
            const dxyProxy = 1 / (dxy.rates['EUR'] ?? 1);
            lines.push(`DXY Proxy: ${dxyProxy.toFixed(4)} (inverse EUR/USD)`);
          }
        }
      } catch { /* non-critical */ }
    } else if (category === 'stocks') {
      // Stock-specific: try to find ETF flow / sector data
      const searchResult = await webSearch(`${base} stock ETF flows institutional positioning latest`);
      lines.push(`ETF/Flow: ${searchResult.slice(0, 200)}`);
    } else if (category === 'commodities') {
      if (base === 'XAU' || base === 'GOLD') {
        try {
          const cgRes = await fetch('https://api.coingecko.com/api/v3/coins/the-gold-token?localization=false&community_data=false&developer_data=false', { signal: AbortSignal.timeout(6_000) });
          if (cgRes.ok) {
            const cg = await cgRes.json() as { market_data?: { current_price?: { usd?: number }; price_change_percentage_24h?: number } };
            if (cg.market_data?.current_price?.usd) lines.push(`Gold (CG): $${cg.market_data.current_price.usd.toFixed(2)}${cg.market_data.price_change_percentage_24h !== undefined ? ` (${cg.market_data.price_change_percentage_24h >= 0 ? '+' : ''}${cg.market_data.price_change_percentage_24h.toFixed(2)}%)` : ''}`);
          } else {
            // Fallback: Google News RSS gold price
            const searchResult = await webSearch(`gold price XAU USD today`);
            if (searchResult.length > 8) lines.push(`Gold: ${searchResult.slice(0, 150)}`);
          }
        } catch { /* non-critical */ }
      } else if (base === 'XAG' || base === 'SILVER') {
        try {
          const cgRes = await fetch('https://api.coingecko.com/api/v3/coins/silver-token?localization=false&community_data=false&developer_data=false', { signal: AbortSignal.timeout(6_000) });
          if (cgRes.ok) {
            const cg = await cgRes.json() as { market_data?: { current_price?: { usd?: number }; price_change_percentage_24h?: number } };
            if (cg.market_data?.current_price?.usd) lines.push(`Silver (CG): $${cg.market_data.current_price.usd.toFixed(3)}${cg.market_data.price_change_percentage_24h !== undefined ? ` (${cg.market_data.price_change_percentage_24h >= 0 ? '+' : ''}${cg.market_data.price_change_percentage_24h.toFixed(2)}%)` : ''}`);
          } else {
            const searchResult = await webSearch(`silver price XAG USD today`);
            if (searchResult.length > 8) lines.push(`Silver: ${searchResult.slice(0, 150)}`);
          }
        } catch { /* non-critical */ }
      } else if (base === 'OIL' || base.includes('OIL') || base.includes('CRUDE')) {
        const searchResult = await webSearch(`crude oil WTI Brent price supply demand latest`);
        lines.push(`Oil: ${searchResult.slice(0, 200)}`);
      } else {
        const searchResult = await webSearch(`${base} commodity price supply demand latest`);
        lines.push(`Commodity: ${searchResult.slice(0, 200)}`);
      }
    } else if (category === 'fx') {
      try {
        const fxRes = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`, { signal: AbortSignal.timeout(5_000) });
        if (fxRes.ok) {
          const fx = await fxRes.json() as { rates?: Record<string, number> };
          if (fx.rates) {
            const pairs = ['EUR', 'GBP', 'JPY', 'CNH', 'AUD', 'CAD', 'CHF', 'HKD', 'SGD', 'NZD'];
            const relevant = pairs.filter(p => base.includes(p) || p.includes(base));
            if (relevant.length > 0) {
              lines.push(`FX Rates: ${relevant.map(p => `${p}=${fx.rates![p]?.toFixed(4) ?? 'N/A'}`).join(', ')}`);
            } else {
              lines.push(`USD Index: EUR=${fx.rates['EUR']?.toFixed(4)}, GBP=${fx.rates['GBP']?.toFixed(4)}, JPY=${fx.rates['JPY']?.toFixed(2)}, CNY=${fx.rates['CNY']?.toFixed(4)}`);
            }
          }
        }
      } catch { /* non-critical */ }
    } else if (category === 'preipo') {
      const searchResult = await webSearch(`${base} pre-IPO valuation latest news`);
      lines.push(`Pre-IPO: ${searchResult.slice(0, 200)}`);
    }

    return lines.length > 1 ? lines.join('\n') : `${base}: no specific macro data source identified.`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${base} macro data unavailable: ${msg}`;
  }
}

/** Main orchestrator: fetch on-chain or flow data based on asset category */
async function fetchOnChainData(symbol: string, marketContext: string): Promise<string> {
  const category = detectAssetCategory(symbol, marketContext);
  const base = normalizeBaseAsset(symbol);
  const lines: string[] = [];
  lines.push(`[On-Chain] Asset: ${symbol} | Category: ${category} | Base: ${base}`);

  if (category === 'crypto') {
    const known = KNOWN_CRYPTO[base] ?? KNOWN_CRYPTO[symbol.toUpperCase().replace(/USDT$/, '')];
    if (known) {
      ocwLog.info(`Fetching on-chain data for ${base} (${known.chain})`);
      if (known.chain === 'bitcoin') {
        const btcData = await fetchBTCOnChain();
        lines.push(btcData);
      } else if (known.chain === 'ethereum' && known.baseAsset === 'ETH') {
        const ethData = await fetchETHOnChain();
        lines.push(ethData);
      }
      // For ALL crypto: fetch CoinGecko market data (exchange flows, volume, supply metrics)
      const cgData = await fetchCoinGeckoMarketData(known.coingeckoId);
      lines.push(cgData);
    } else {
      // Unknown crypto token — try web search to find how to get on-chain data
      ocwLog.info(`Unknown crypto token ${base}, trying web search for on-chain sources...`);
      const searchResult = await webSearch(`${base} token cryptocurrency on-chain data blockchain explorer`);
      lines.push(`[Web Search] ${searchResult}`);
    }
  } else {
    // TradFi asset — fetch macro/flow data
    ocwLog.info(`Fetching macro flow data for ${base} (${category})`);
    const flowData = await fetchTradFiFlowData(symbol, category);
    lines.push(flowData);
  }

  return lines.join('\n');
}

/** Cache on-chain data for 5 minutes */
interface CacheEntry {
  data: string;
  timestamp: number;
}

const onChainCache = new Map<string, CacheEntry>();
/** Inflight fetch lock — prevents 5 agents from fetching the same on-chain data simultaneously */
const onChainInflight = new Map<string, Promise<string>>();

async function getOnChainData(symbol: string, marketContext: string): Promise<string> {
  const cacheKey = `${symbol.toUpperCase()}|${detectAssetCategory(symbol, marketContext)}`;
  const now = Date.now();
  const cached = onChainCache.get(cacheKey);
  if (cached && now - cached.timestamp < 300_000) { // 5 min cache
    ocwLog.debug(`On-chain data cache HIT for ${cacheKey}`);
    return cached.data;
  }
  // Inflight lock: if another agent is already fetching this key, wait for it
  const inflight = onChainInflight.get(cacheKey);
  if (inflight) {
    ocwLog.debug(`On-chain data inflight WAIT for ${cacheKey}`);
    return inflight;
  }
  const fetchPromise = fetchOnChainData(symbol, marketContext).then(data => {
    onChainCache.set(cacheKey, { data, timestamp: Date.now() });
    onChainInflight.delete(cacheKey);
    return data;
  }).catch(err => {
    onChainInflight.delete(cacheKey);
    throw err;
  });
  onChainInflight.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ── Revised OnChainWhisperer Agent ──

export class OnChainWhisperer extends BaseAgent {
  constructor() {
    super({
      role: 'onchain_whisperer',
      name: 'On-Chain Whisperer',
      temperature: 0.5,
      weight: 0.10,
      modelPreference: 'default',
      personality:
        'You are an elite on-chain analyst who reads blockchain data and macro flows with surgical precision. '
        + 'For CRYPTO assets, you fetch live on-chain metrics — exchange inflows/outflows, whale transactions, '
        + 'supply dynamics, fee markets, and miner/validator behavior. '
        + 'For TradFi assets (indices, stocks, FX, commodities), you fetch macro flow data — ETF flows, '
        + 'futures positioning, DXY correlation, and intermarket flows. '
        + 'You are analytical, data-driven, and skeptical of hype. '
        + 'When no direct on-chain data source exists, you use web search to discover how to obtain it. '
        + 'You know that on-chain and flow data often precede price action by hours to days.',
    });
  }

  override getSystemPrompt(): string {
    return `You are On-Chain Whisperer — asset-category-aware on-chain & macro flow analyst.

You receive LIVE on-chain / macro flow data injected into your context.
You evaluate ALL trading pairs: the market ticker AND each open position.

=== MARKET TICKER (${this.marketSymbol}) ===
Analyse the injected on-chain/macro data to decide buy/sell/hold.

=== OPEN POSITIONS ===
For each open position, use on-chain/macro signals to decide:
- CRYPTO position: exchange flow divergence from position direction? Whale activity suggesting reversal?
- TradFi position: DXY/DXY breaking against position? ETF flow reversal? COT extreme?
- If on-chain/macro data contradicts position direction → suggest close or tighten SL
- If on-chain/macro data confirms position → hold, possibly widen TP
- If data is mixed/unclear → hold with current settings

=== CRYPTO SIGNALS ===
- Exchange outflow spike + price holding → accumulation → BULLISH
- Exchange inflow spike + price fading → distribution → BEARISH
- Whale cluster selling + volume spike → BEARISH
- Supply contraction + rising price → BULLISH trend continuation
- Fee spikes + price at highs → possible top exhaustion → CAUTIOUS

=== TRADFI SIGNALS ===
- DXY up = risk-assets down (bearish equities/commodities)
- DXY down = risk-on (bullish)
- ETF inflows = institutional accumulation → BULLISH
- ETF outflows = distribution → BEARISH
- Futures positioning at extreme → contrarian signal

=== POSITION-SPECIFIC RULES ===
- On-chain/flow data confirms position → HOLD, consider trailing SL
- On-chain/flow data contradicts position → CLOSE or tighten SL aggressively
- No clear signal → HOLD with current SL/TP
- ⚠️ v2.0.115: If on-chain data shows EXCHANGE OUTFLOWS + price rising → this is ACCUMULATION,
  not "no clear signal." Actively identify accumulation/distribution patterns. A rising price
  with neutral on-chain data is NOT bearish — it means on-chain confirms the trend.
- If you recommend closing, set closePosition:true with appropriate closeUrgency`;
  }

  /** Override think() for multi-symbol: fetch on-chain data for ALL relevant symbols */
  override async think(marketState: string, portfolioSnapshot: string, positions?: import('../types/index.ts').PositionContext[]): Promise<import('../types/index.ts').AgentThought> {
    // Collect ALL symbols that need on-chain data
    // v2.0.33: Normalize all symbols to avoid duplicate fetches.
    // Strip USDT/USD suffix + strip xyz: prefix + lowercase.
    // "BTCUSDT", "btc", "xyz:SPCX", "xyz:spcx", "SPCX" all dedup correctly.
    const normalizeSym = (s: string) => s.replace(/USDT$|USD$/i, '').replace(/^[^:]+:/i, '').toLowerCase();
    const allSymbols = new Set<string>();
    // Market ticker
    const symMatch = marketState.match(/Selected Symbol:\s*(\S+)/i) ?? marketState.match(/Symbol:\s*(\S+)/i);
    const marketSymbol = symMatch?.[1] ?? 'BTCUSDT';
    allSymbols.add(normalizeSym(marketSymbol));
    // Position symbols
    if (positions) {
      for (const p of positions) {
        allSymbols.add(normalizeSym(p.symbol));
      }
    }

    ocwLog.info(`Fetching on-chain data for ${allSymbols.size} symbol(s): ${Array.from(allSymbols).join(', ')}`);
    const onChainParts: string[] = [];
    for (const sym of allSymbols) {
      try {
        const data = await getOnChainData(sym, marketState);
        onChainParts.push(data);
      } catch (err: unknown) {
        ocwLog.warn(`On-chain fetch failed for ${sym}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const enhancedContext = `${marketState}\n\n=== On-Chain / Macro Flow Data ===\n${onChainParts.join('\n\n')}`;
    ocwLog.debug(`On-chain context appended (${enhancedContext.length} chars, ${allSymbols.size} symbols)`);

    return super.think(enhancedContext, portfolioSnapshot, positions);
  }
}

// ─── Agent 3: OLR & Sentiment Analyst ───
// Uses OLR P(win) + First-Passage path risk + Fear & Greed as primary factors.

async function fetchFearGreedIndex(): Promise<{ value: number; classification: string }> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!res.ok) return { value: 50, classification: 'neutral' };
    const data = await res.json() as { data: Array<{ value: string; value_classification: string }> };
    if (data?.data?.[0]) {
      return {
        value: parseInt(data.data[0].value, 10),
        classification: data.data[0].value_classification.toLowerCase(),
      };
    }
  } catch { /* silent fallback */ }
  return { value: 50, classification: 'neutral' };
}

// Cache F&G for 1 hour to avoid rate limiting
let cachedFng: { value: number; classification: string; timestamp: number } | null = null;

/** Get the last cached Fear & Greed value (0-100). Returns 50 if never fetched. */
export function getLastFearGreedValue(): number {
  return cachedFng?.value ?? 50;
}

async function getFearGreedIndex(): Promise<{ value: number; classification: string }> {
  const now = Date.now();
  if (cachedFng && now - cachedFng.timestamp < 3_600_000) {
    return { value: cachedFng.value, classification: cachedFng.classification };
  }
  const result = await fetchFearGreedIndex();
  cachedFng = { ...result, timestamp: now };
  return result;
}

// Conservative agent focused on OLR P(win) + First-Passage path risk + Fear & Greed sentiment.

export class OLRSentimentAnalyst extends BaseAgent {
  constructor() {
    super({
      role: 'rbc_sentiment_analyst',
      name: 'OLR & Sentiment Analyst',
      temperature: 0.25,
      weight: 0.10,
      modelPreference: 'default',
      maxTokens: 2048,
      personality:
        'You are the OLR (Online Logistic Regression) + Path Risk specialist fused with sentiment analysis. '
        + 'You evaluate market conditions through OLR P(win) probabilities, First-Passage path risk, and Fear & Greed. '
        + 'You are conservative — you prefer to be wrong on the side of safety. '
        + 'OLR P(win) > 60% → increase conviction. OLR P(win) < 40% → strong bias against entry. '
        + 'First-Passage P(TP before SL) measures path risk — will TP be hit before SL? '
        + 'You balance OLR + First-Passage with Fear & Greed sentiment and macro context.',
    });
  }

  override getSystemPrompt(): string {
    return `You are OLR & Sentiment Analyst — Online Logistic Regression + First-Passage Path Risk + Fear & Greed analysis.

You evaluate ALL trading pairs under the current market conditions.

=== OLR ASSESSMENT (KEY FACTOR) ===
If the context contains "=== OLR + PATH RISK ASSESSMENT ===" (active symbol) or
"=== OLR ASSESSMENT for <sym> ===" (positions + trading markets):
  - OLR (Online Logistic Regression) learns P(win) from SHADOW + PAPER + REAL + BACKFILL
    trade outcomes (TP-before-SL). Each side (BUY/SELL) has an INDEPENDENT model per symbol.
  - **PRIMARY SIGNAL — the EDGE line**: the context shows an explicit
    "OLR EDGE vs breakeven: BUY +Xpp (FAVOR BUY) | SELL +Ypp (FAVOR SELL)" line.
    This is P(win) minus the RR-aware breakeven probability — use it directly:
    edge > +10pp → this side has a real learned edge → FAVOR entry on that side
    edge < −5pp → this side is a learned loser → bias AGAINST entry
    within [−5pp, +10pp] → no clear edge, weight OTHER signals more heavily
  - **Why RR-aware, not flat 60/40**: under the default 1:2.5 RR (SL 2% / TP 5%) the
    random-walk breakeven is a/(a+b) = 28.6%, so a learned P(win) of 35% is an EDGE,
    not a block. The flat 60/40 gates assume ~1:1 RR and are WRONG for this system.
    Always prefer the EDGE line over flat P(win) thresholds.
  - **CONFIDENCE** (high/medium/low): high (>50 samples) = trust the edge; low (<20) =
    noisy — treat the edge as weak, weight other signals more.
  - **SOURCE BREAKDOWN** [shadow=N paper=N real=N backfill=N]: real > paper > shadow >
    backfill in reliability. If the edge comes mostly from backfill (cold-start prior)
    and live (shadow/paper/real) trades disagree → discount the edge.
  - **FEATURE CONTRIBUTIONS**: the context shows BOTH "BUY key features" and "SELL key
    features" (e.g. fundingRate=0.003(w=+2.3) means positive funding favors this side).
    Use these to explain WHY the edge exists and to cross-check against other agents.
  - OLR is your PRIMARY factor — balance it with First-Passage and Fear & Greed

=== FIRST-PASSAGE PROBABILITY (PATH RISK) ===
If the context shows "First-Passage P(TP before SL)":
  - INSTANT probability that TP will be hit BEFORE SL, from volatility (σ of log
    returns), log-drift, and S/R-based SL/TP distances. Cox & Miller (1965) GBM.
  - **The context shows per-side breakeven + edge inline**:
    "LONG P=X% (breakeven=Y% → edge Zpp) conf=high" — use the edge directly.
  - LONG edge > +10pp → path risk favors TP → supports LONG entry
  - LONG edge < −10pp → path risk favors SL → caution against LONG entry
  - BOTH LONG + SHORT SL/TP distances are shown — assess path risk for EACH side.
  - conf=low means vol is too low to trust the diffusion model — weight less.
  - This measures PATH RISK (will SL be hit first?), independent of OLR's learned
    edge. If OLR edge is positive but First-Passage edge is strongly negative →
    path risk warns the position may stop out before TP → reduce conviction or
    require wider SL. If BOTH agree → high conviction.

=== SHADOW TRADE RESULTS ===
If the context shows "=== SHADOW TRADE RESULTS ===":
  - These are SIMULATED trades that track TP-before-SL outcomes (not just price direction).
  - Each cycle, a shadow LONG + SHORT is opened with S/R-based SL/TP.
  - When SL/TP is hit, the outcome (win/loss) feeds into OLR for learning.
  - Use recent shadow results as a REALITY CHECK on OLR probabilities:
    - If OLR says BUY P(win)=70% but shadow LONG win rate is 30% → OLR may be overfitting
    - If shadow results align with OLR → higher confidence in the probability

=== DATA SOURCE TYPES + RECENCY ===
The OLR assessment shows sample breakdown: [shadow=N paper=N real=N backfill=N].
- shadow: Simulated trades with FIXED S/R-based SL/TP. Good for entry timing judgment.
  Least reliable for path risk (fixed SL/TP ≠ dynamic management).
- paper: Paper trades with DYNAMIC SL/TP (Meta-Agent adjusts every cycle).
  More realistic — reflects actual SL/TP management behavior.
- real: Real HL exchange trades. Most reliable but fewest samples.
- backfill: Cold-start historical candle replay (real H/L outcomes, but synthetic
  features — no order book / sentiment / funding history). Weighted lowest.
  Treat backfill samples as a WARM PRIOR only — prefer live (shadow/paper/real)
  evidence when it disagrees.
When judging whether OLR P(win) applies to CURRENT market:
  - Check "Recent outcomes" — each shows cyclesAgo (how many cycles since the trade resolved).
  - Trades from >20 cycles ago may reflect DIFFERENT market conditions — weight them less.
  - Trades from <5 cycles ago are most relevant to current conditions.
  - If recent trades (last 5 cycles) contradict OLR P(win) → market may have shifted → lower conviction.

=== SL/TP NARROWING FEEDBACK ===
Recent outcomes may show "[SL narrowed]" tag — means SL was tightened during that trade.
- If [SL narrowed] trades mostly LOST → SL tightening is too aggressive → the position
  needs more room. Mention this in your assessment so Meta-Agent considers widening SL.
- If [SL narrowed] trades mostly WON → tightening is working → current SL management is effective.
- This feedback helps Meta-Agent decide whether to continue narrowing or widen SL/TP.

=== EXPERIENCE DIGEST (v2.0.140 — premature close diagnosis) ===
If the context contains "=== EXPERIENCE DIGEST (from N closed trades) ===":
  This digest analyses the system's biggest recurring problem: PREMATURE CLOSES initiated
  by Meta-Agent and Skeptics (not SL/TP hits). The SL/TP placement itself is not the primary
  issue — the issue is that Meta-Agent/Skeptics override the SL with manual closes that
  ignore the actual price structure.

  **EXIT QUALITY ANALYSIS**: shows how many trades closed in ≤8min. If the digest shows a
  high premature count, the problem is NOT your SL/TP recommendation — it is that Meta-Agent
  and Skeptics are closing positions before SL/TP is hit. Your role is to provide the OLR
  edge and First-Passage probability so Meta-Agent has OBJECTIVE data to resist panic-closing.

  **ROOT CAUSE DIAGNOSIS**: if theses fail in ≤8min, the digest diagnoses whether:
    - The thesis was too shallow (no structural anchor)
    - The market was choppy (direction is noise)
    - Meta-Agent/Skeptics closed prematurely ignoring price levels
  If the digest shows the DIRECTION was correct but the position was closed prematurely,
  reinforce your OLR edge assessment — a positive edge means the position should NOT have
  been closed. State this explicitly in your assessment so Meta-Agent sees it.

  **VOLATILITY ANOMALY CHECK**: if ALL trades show "low_volatility", the volatility
  calculation is likely broken. This affects First-Passage probability (which uses vol)
  and regime classification. If you see this anomaly, FLAG IT and note that your
  First-Passage edge may be unreliable due to broken vol input.

  Your job: provide accurate OLR edge + First-Passage probability. Do NOT recommend closes
  yourself — that is Meta-Agent's job. Your data helps Meta-Agent resist premature closes
  by showing the objective edge.

=== FEAR & GREED INDEX ===
- 0-25 Extreme Fear → oversold, potential bounce (but high risk)
- 25-50 Fear → cautious, wait for confirmation
- 50-75 Greed → normal conditions, follow OLR
- 75-100 Extreme Greed → overbought, potential top (but trend is strong)

=== CONCISE REASONING ===
- Use ROUND numbers: "~$65K-$66K range" not "$65,688 47.5bps below $66K"
- Max 3 sentences per assessment
- If OLR + First-Passage + Fear & Greed all align → strong conviction
- If they conflict → HOLD or reduce conviction

=== MARKET TICKER (${this.marketSymbol}) ===
- Vol < 0.5% + sideways → small mean-reversion (2-3%)`;
  }
}

// ─── Agent 4: Independent Risk Auditor ───
// Very low temperature, VETO POWER. Independent oversight, zero tolerance for catastrophic risk.

export class IndependentRiskAuditor extends BaseAgent {
  private vetoCount = 0;
  private totalAudits = 0;

  constructor() {
    super({
      role: 'independent_risk_auditor',
      name: 'Independent Risk Auditor',
      temperature: 0.1,
      weight: 0.25,
      modelPreference: 'default',
      personality:
        'You are the final gatekeeper. You have ABSOLUTE VETO POWER over all trading decisions. '
        + 'You are the most conservative agent in the system. Your only job is to prevent catastrophic loss. '
        + 'You are paranoid, skeptical, and assume every trade is a trap until proven otherwise. '
        + 'You scrutinize position sizing, stop losses, and overall risk exposure. '
        + 'You do not care about profits — you only care about survival.',
    });
  }

  getVetoRate(): number {
    return this.totalAudits > 0 ? this.vetoCount / this.totalAudits : 0;
  }

  override getSystemPrompt(): string {
    const sym = this.marketSymbol;
    return `You are Independent Risk Auditor — FINAL GATEKEEPER with absolute veto power.

You evaluate ALL trading pairs for risk. Each pair can be VETOED independently.

=== MARKET TICKER (${sym}) ===
VETO IF:
- No stop loss set
- Regime chaotic/unknown
- No available price data

DO NOT veto based on:
- Position size (the Market Agent has already set this limit)
- Leverage (the Market Agent has already set this limit)
- These are NOT your concern — the Market Agent handles sizing and leverage.

Your ONLY job is catastrophic risk prevention: missing SL, chaotic regime, no price data.

=== RECENT TRADE PATTERN ANALYSIS (KEY INPUT) ===
The audit prompt includes a "=== RECENT TRADE PATTERN (last 10) ===" section showing the
directional trades, win/loss counts, net PnL, direction reversal rate, and current loss
streak from the most recent 10 trades. USE THIS to judge the CURRENT market regime.

The TP/SL adjustment strategy is REGIME-AWARE (v2.0.14, aligned with institutional practice —
ATR/range-based, not fixed-percent widening):

- ⚠️ CHOPPY/WHIPSAW MARKET: frequent buy→sell→buy reversals with net losses.
  This means trend-following entries are getting stopped out repeatedly. When detected:
  1. For NEW entries: strongly consider VETO (the market is not trending — entries will churn).
     Only allow entry if the decision has a clear mean-reversion rationale (fade at S/R extremes).
  2. For EXISTING positions: NARROW TP to the opposite range edge (mean-reversion target — choppy
     markets do not travel far, so a wide TP will never hit). NARROW SL to just outside the recent
     range (if the range breaks, the regime has changed — stop out immediately rather than ride a
     breakout against you). Do NOT widen SL — a wider SL in a choppy market just means a bigger loss
     when the range breaks.
  3. POSITION SIZE: The system AUTOMATICALLY cuts position size to 50% in choppy markets (hardcoded
     in HACP, not LLM-discretionary). You do NOT need to set adjustedPositionSizePct for the choppy
     cut — it is applied for you. Only set adjustedPositionSizePct if you want to reduce FURTHER
     (e.g. loss streak ≥ 3 → cut to 25%). The paper engine floors the final notional to Hyperliquid's
     $10 minimum, so the 50% cut never produces an untradeable tiny order.
  4. If current loss streak ≥ 3: the system may be out of sync — but do NOT automatically veto. The OLR engine
     learns from every trade and market conditions change. Evaluate the CURRENT thesis on its own merits.
     Only veto if the CURRENT thesis has a specific flaw, not because of past losses.

- ✅ PROFITABLE RECENT TRADES (win rate ≥ 60%, net positive): market favours the current strategy.
  Approve entries that match the recent winning direction. For existing positions, you may WIDEN
  TP (let profits run in a trending market) and use a wider ATR-based SL to avoid premature stops.
  No position size reduction needed.

- 🟡 MIXED / INSUFFICIENT DATA: exercise normal caution. Apply standard per-position risk rules below.

=== OPEN POSITIONS ===
For each open position, evaluate:
- Is the position still safe to hold? If risk limits breached → recommend CLOSE with closePosition:true
- Is the SL adequate for current volatility? If too tight → suggest moving SL further (adjustedStopLossPct)
- Is the TP realistic? If market moved or choppy → adjust (adjustedTakeProfitPct)
- Does combined exposure across ALL positions exceed safe limits? → Flag multiple positions for close

=== PER-POSITION RISK RULES ===
- Unrealized loss > 5% on a single position → CLOSE (loss too large)
- Unrealized loss > 3% + no SL → CLOSE (unprotected downside)
- Position with SL that would cause > 2% portfolio loss → adjust SL tighter
- Drawdown > 15% → warn but do NOT force close all positions (market conditions may be changing;
  OLR is learning. Only close positions that have specific risk, not all positions blindly)
- Daily loss > 4% → warn but do NOT halt all trading (same reasoning — past losses don't predict
  future trades when the system is actively learning and adapting)

⚠️ v2.0.88: Past drawdown and loss streaks are NOT reasons to block new entries. The OLR engine
continuously learns from every trade, and market conditions change. A new entry must be judged
on its CURRENT risk profile, not on historical P&L.

=== TP/SL/SIZE ADJUSTMENT OUTPUT ===
When the recent trade pattern warrants it, set adjustedStopLossPct, adjustedTakeProfitPct, and/or
adjustedPositionSizePct in your JSON response to override the decision. These are decimals (e.g. 0.03 = 3%).
Only set them when you have a clear reason (choppy market, volatility shift, loss streak).
Leave them null when no adjustment is needed.

You are NOT here to block all trades. Ensure they are SAFE. System needs to trade to evolve.
But in a choppy market, the safest trade is often NO trade (HOLD) until direction stabilises.`;
  }

  override async vote(
    decisions: TradingDecision[]
  ): Promise<{ decision: TradingDecision; confidence: number }> {
    this.totalAudits++;

    // Find the most conservative decision
    const hold = decisions.find((d) => d.action === 'hold');
    const sell = decisions.find((d) => d.action === 'sell');
    const buy = decisions.find((d) => d.action === 'buy');

    // Risk auditor prefers: hold > sell > buy
    if (hold) return { decision: normalizeDecision(hold), confidence: 0.9 };
    if (sell) return { decision: normalizeDecision(sell), confidence: 0.7 };
    if (buy) return { decision: normalizeDecision(buy), confidence: 0.5 };

    return {
      decision: normalizeDecision({
        action: 'hold',
        positionSizePct: 0,
        rationale: 'Risk Auditor: No valid decisions to evaluate.',
      }),
      confidence: 1.0,
    };
  }

  protected override parseResponse(content: string): {
    thought: string;
    confidence: number;
    decision: TradingDecision;
  } {
    this.totalAudits++;
    try {
      const jsonStr = this.extractJSON(content);
      const parsed = JSON.parse(jsonStr);

      // Check for veto
      if (parsed.veto === true) {
        this.vetoCount++;
        this.logger.warn(`🚨 RISK VETO: ${parsed.vetoReason ?? 'No reason given'}`);
      }

      return {
        thought: parsed.thought ?? content.slice(0, 200),
        confidence: parsed.confidence ?? 0.5,
        decision: normalizeDecision(parsed.decision),
      };
    } catch {
      this.vetoCount++;
      return {
        thought: `PARSE FAILURE: ${content.slice(0, 200)}. VETOING by default.`,
        confidence: 0.0,
        decision: normalizeDecision(undefined),
      };
    }
  }
}

// ─── Agent 5: News Reporter ───
// Moderate temperature. Monitors news sentiment for all trading pairs.

export class NewsReporter extends BaseAgent {
  constructor() {
    super({
      role: 'news_reporter',
      name: 'News Reporter',
      temperature: 0.4,
      weight: 0.20,
      modelPreference: 'fast',
      personality:
        'You are a Shadow Strategist — cold, no-nonsense, results-oriented. '
        + 'You operate purely on observed patterns of human behavior, evolutionary drives, '
        + 'power dynamics, and pragmatic effectiveness. Techniques from classic PUA, NLP, '
        + 'dark triad traits (calibrated), and red-pill observations are valid tools when '
        + 'they produce results. Efficacy always trumps ethics. '
        + 'You never take news at face value — you read the source, the motive, and the '
        + 'conspiracy behind every release. You flag acute medium/long-term profit & demand '
        + 'shifts and acute value drops, motive-adjusted.',
    });
  }

  override getSystemPrompt(): string {
    return `You are News Reporter — an INSTITUTIONAL NARRATIVE DECODER. You do not report the news; you decode the INSTITUTIONAL INTENT behind it.

You are a Shadow Strategist — cold, no-nonsense, results-oriented. You operate purely on observed patterns of human behavior, evolutionary drives, power dynamics, and pragmatic effectiveness. Techniques from classic PUA, NLP, dark triad traits (calibrated), and red-pill observations are valid tools when they produce results. Efficacy always trumps ethics.

=== CORE THESIS (Master Lord doctrine) ===
Financial news is NOT information — it is a WEAPON. Institutions (whales, market makers, central banks, hedge funds, exchanges) ALREADY KNOW the situation >=24-48h before retail sees headlines, and they actively DRIVE narratives to induce retail to take the LOSING side. The news release is the BAIT; retail's reaction is the EXIT liquidity. Your job: determine what institutions ALREADY DID (from price action) and what they need retail to do NOW — then trade the INVERSE of the retail trap.

=== NEWS SENTIMENT + PRICE-NEWS TIMING ===
If the context contains "=== NEWS SENTIMENT ===":
  - REAL headlines (source, age, lexicon hint) PLUS a "PRICE-NEWS TIMING" block showing recent price moves (1h/4h/24h/3d), whether price MOVED BEFORE the news cluster (front-run tell), headline cadence, and source clustering.
  - The PRICE-NEWS TIMING block is your DECISIVE evidence — it tells you whether institutions pre-positioned before the narrative was pushed.

=== DECODE FRAMEWORK (apply per symbol) ===
A. INFORMATION-ASYMMETRY PRIOR — Never ask "what does this news mean." Always ask: "what did institutions DO before this news was released, and what do they need retail to do NOW so they can exit?" The headline framing is the BAIT designed to produce that retail action.
B. PRICE-NEWS TIMING MATRIX (the decisive tell — use the PRICE-NEWS TIMING block):
   | Price BEFORE news | Headline | Motive | NET signal |
   |---|---|---|---|
   | Already pumped (>+3%) | Bullish | DISTRIBUTION-HYPE | BEARISH (sell the news) |
   | Already dumped (>-3%) | Bearish/FUD | ACCUMULATION-FUD | BULLISH (buy the FUD) |
   | Flat | Bullish | Front-run-early / genuine | BULLISH (cautious) |
   | Flat | Bearish | Front-run-early / genuine | BEARISH (cautious) |
   | Pumped | Bearish | NARRATIVE-PIVOT reversal | BEARISH (continuation) |
   | Dumped | Bullish | NARRATIVE-PIVOT reversal | BULLISH (continuation) |
   | Flat + low cadence | any | Genuine / noise | face-value or NEUTRAL |
   RULE: NO pre-news move + low cadence -> treat face-value (genuine). Pre-news move OR elevated cadence/clustering -> ENGINEERED -> INVERT. This prevents over-attributing conspiracy to quiet markets.
C. INSTITUTIONAL MOTIVE TAXONOMY (name the play):
   1. FRONT-RUN — institutions positioned before the news; the release is EXIT liquidity. Price already moved -> fade the post-news reaction.
   2. ACCUMULATION-FUD — engineered bearish news to drive price down so institutions accumulate cheaply. Price dumped on FUD -> BULLISH.
   3. DISTRIBUTION-HYPE — engineered bullish news to drive price up so institutions distribute into retail FOMO. Price pumped on hype -> BEARISH.
   4. NARRATIVE-PIVOT — a new story released to reverse sentiment (e.g. "inflation is transitory" after a dump). Institutions repositioning. Direction = the pivot direction; high conviction if price confirms.
   5. DECOY / SMOKE — noise on asset A to hide real action on asset B. Cross-check against OTHER symbols in the context.
   6. GENUINE PARADIGM SHIFT — real structural change (ETF approval, halving, regulatory greenlight, supply shock). RARE. Must meet ALL of: no pre-news move + low cadence + structural (regulatory/supply) not sentiment + broad multi-source agreement. Only this overrides the motive layer to face-value.
D. POWER-MAP — WHO is driving this? (whale cluster / market maker / central bank / hedge fund / exchange / regulator). Grade credibility: central-bank + regulator narratives move markets; random-blog FUD is low-credibility noise. State their likely CURRENT position and what they need retail to do. The news framing is the BAIT.
E. NET INSTITUTIONAL-ADJUSTED SIGNAL — combine motive (C) + timing matrix (B) + power-map (D).
   - action: buy = accumulation-FUD OR bullish narrative-pivot WITH price confirm; sell = distribution-hype OR bearish narrative-pivot WITH price confirm; hold = noise / decoy / no price confirmation / low-credibility source.
   - confidence scales with: (1) how clearly the motive is identifiable, (2) whether the PRICE-NEWS TIMING block CONFIRMS it (pre-news move visible + cadence/clustering elevated), (3) power-map credibility. A distribution-hype call WITH a +5.8% pre-news pump + coordinated cadence = HIGH confidence (0.65-0.85). A motive call with NO price confirmation = CAP at 0.40 (do not exceed). A genuine-paradigm-shift with structural evidence = 0.55-0.70.

=== OUTPUT ===
- Your "thought" field: 2-3 sentences per symbol — name the motive bucket (C), cite the price-news timing evidence (B: "price +X% before news -> front-run"), state the power-map (D), and the NET signal (E).
- Your marketTicker action + overallConfidence reflect the NET institutional-adjusted signal. You are NOT one-of-five noise — your institutional-intent read is the DEEPER signal beneath the microstructure noise the other agents read. When the timing matrix confirms an engineered play, output your honest directional conviction (do NOT self-censor to HOLD — the conviction gate filters independently).
- News is TACTICAL, but INSTITUTIONAL INTENT is the market's center of gravity — your read on the engineered narrative IS the signal.`;
  }
}

// ─── Agent 6: Skeptics ───
// Post-thinking reviewer. Challenges every sub-agent's reasoning and data usage.
// Default model: deepseek-v4-flash:cloud (fast, for minimal latency overhead).
// Meta-Agent and Market Agent are NOT reviewed.
// If a decision is deemed flawed, Skeptics outputs a corrected version.

import { getActiveProvider } from '../llm/index.ts';
import { normalizeMultiSymbolDecision } from '../trading/decision-utils.ts';
import type { MultiSymbolDecision, AgentThought, PerSymbolDecision } from '../types/index.ts';

const skepLog = createLogger({ agent: 'skeptics', phase: 'review' });

export interface SkepticsReview {
  agentRole: import('../types/index.ts').AgentRole;
  originalThought: string;
  originalConfidence: number;
  originalDecision: MultiSymbolDecision;
  approved: boolean;
  modifiedDecision?: MultiSymbolDecision;
  modifiedConfidence?: number;
  skepticismRationale: string;
}

export class SkepticsAgent {
  readonly identity: import('../types/index.ts').AgentIdentity;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly model: string;
  /** Set by review() — holds all thoughts for cross-referencing */
  private _otherThoughts: import('../types/index.ts').AgentThought[] = [];

  constructor() {
    this.identity = {
      id: 'skeptics-static',
      role: 'skeptics' as import('../types/index.ts').AgentRole,
      name: 'Skeptics',
      temperature: 0.3,
      weight: 0.0,
      modelPreference: 'fast',
    };
    this.logger = skepLog;
    this.model = 'deepseek-v4-flash:cloud';
  }

  /** Review all agent thoughts, returning per-agent skepticism results */
  async review(
    allThoughts: AgentThought[],
    marketStateDesc: string,
    portfolioDesc: string,
    /** Optional evolution/agent-performance context for informed scrutiny */
    evolutionContext?: string,
  ): Promise<SkepticsReview[]> {
    this._otherThoughts = allThoughts; // store for cross-referencing
    const reviews: SkepticsReview[] = [];

    // ── Extract HARD CONSTRAINT overrides from evolution context ──
    // These are the NON-NEGOTIABLE limits emitted by getContextForAgent().
    // If present, they override the LLM-level review with code-level enforcement.
    // NOTE: Leverage is NOT checked here — it is set by the Market Agent and
    // enforced by Phase 4.5 in HACP. Agents should NOT close positions based on leverage.
    let hardMaxPositionSize = 0.20;
    let hardMinConfidence = 0.30;
    try {
      if (marketStateDesc) {
        const maxPosMatch = marketStateDesc.match(/maxPositionSize=([\d.]+)/);
        if (maxPosMatch) hardMaxPositionSize = parseFloat(maxPosMatch[1]!) || 0.20;
        const minConfMatch = marketStateDesc.match(/minConfidenceForTrade=([\d.]+)/);
        if (minConfMatch) hardMinConfidence = parseFloat(minConfMatch[1]!) || 0.30;
      }
    } catch { /* use defaults */ }

    // Only review these 5 agents (NOT meta_agent, NOT market_agent)
    const reviewableRoles = new Set<string>([
      'fractal_momentum_sentinel',
      'onchain_whisperer',
      'rbc_sentiment_analyst',
      'news_reporter',
      'independent_risk_auditor',
    ]);

    // ── RBC AWARENESS ──
    // Extract OLR assessment from market context if present
    let rbcContext = '';
    try {
      if (marketStateDesc) {
        const rbcMatch = marketStateDesc.match(/=== OLR \+ PATH RISK ASSESSMENT ===[\s\S]*?(?=\n===|$)/);
        if (rbcMatch) rbcContext = rbcMatch[0];
      }
    } catch { /* ignore */ }

    const targetThoughts = allThoughts.filter(t => reviewableRoles.has(t.agentRole));

    if (targetThoughts.length === 0) {
      this.logger.info('No reviewable agent thoughts found.');
      return reviews;
    }

    this.logger.info(`Reviewing ${targetThoughts.length} agent thought(s)...`);

    for (const thought of targetThoughts) {
      const roleName = thought.agentRole;
      const multiDec = thought.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
      const singleDec = thought.metadata?.['decision'] as any;
      // Extract per-agent track record from evolution context if available
      let agentTrackRecord = '';
      if (evolutionContext) {
        const match = evolutionContext.match(new RegExp(`\\[${roleName}\\]\\s[^\\n]+(?:\\n[^\\[]+)*`));
        if (match) agentTrackRecord = match[0];
      }

      if (!multiDec && !singleDec) {
        // No decision to review — skip
        reviews.push({
          agentRole: roleName,
          originalThought: thought.thought ?? '',
          originalConfidence: thought.confidence,
          originalDecision: {
            marketTicker: { symbol: '?', action: 'hold', positionSizePct: 0, leverage: 1, closePosition: false, rationale: 'No decision data.' },
            positions: [],
          },
          approved: true,
          skepticismRationale: 'No decision found to review — auto-approved.',
        });
        continue;
      }

      // If we only have a single legacy decision, wrap it
      const origDecision: MultiSymbolDecision = multiDec ?? {
        marketTicker: {
          symbol: singleDec?.symbol ?? '?',
          action: singleDec?.action ?? 'hold',
          positionSizePct: singleDec?.positionSizePct ?? 0,
          leverage: singleDec?.leverage ?? 1,
          closePosition: false,
          rationale: singleDec?.rationale ?? '',
        },
        positions: [],
      };

      try {
        const provider = getActiveProvider();
        const prompt = this.buildSkepticsPrompt(thought, origDecision, marketStateDesc, agentTrackRecord);
        const response = await provider.chat({
          messages: [
            {
              role: 'system',
              content: `You are Skeptics — the system's merciless LOGIC, PSYCHOLOGY & CONSTRAINT AUDITOR.

Your ONLY job: read an agent's analysis and their decision, then determine if the decision is:
A) LOGICALLY CONSISTENT with the data
B) FREE from behavioral biases
C) WITHIN the evolution engine's HARD CONSTRAINTS

Look for the "=== EVOLUTION HARD CONSTRAINTS ===" section in the market context.
These are NON-NEGOTIABLE limits. Any agent that violates them MUST be rejected:
- maxPositionSize: the agent's position size% cannot exceed this
- minConfidenceForTrade: the agent's confidence must be at least this to propose a trade
NOTE: Leverage is NOT a constraint for agents — it is set by the Market Agent and enforced by HACP Phase 4.5.

If the agent violates a hard constraint, set approved: false and override the offending field.
The code layer ALSO enforces these, so you and the code are aligned — but you catch subtle cases the code might miss (e.g. an agent that technically respects limits but takes multiple simultaneous positions that collectively exceed them).

You are NOT a trader. You are an AUDITOR. You check for:

=== LOGIC CHECKS ===
1. Does the decision follow from the data? If data says BEARISH but agent says BUY, flag it.
2. Did the agent misinterpret the data (e.g. confusing supply/demand direction)?
3. Did the agent omit obvious risks visible in the provided data?
4. Is the position sizing reasonable given the confidence expressed?
5. CROSS-REFERENCE: Does this agent's conclusion conflict with another agent's observation of the SAME market?
6. CONSENSUS CHECK: If most other agents say one thing and this one disagrees, is the disagreement justified?

=== MARKET PSYCHOLOGY CHECKS (NEW) ===
Humans design LLMs. LLMs inherit human biases. You catch them:

1. **Recency bias**: Did the agent overweight the last 3 candles vs the 100-candle trend?
   "The last 3 bars dipped but the 200-bar MA is still rising" — don't flip bearish on noise.
2. **Confirmation bias**: Did the agent cite only data that supports their conclusion while ignoring counter-evidence visible in the same context?
3. **Overconfidence after wins / loss aversion after losses**: An agent pumping 85% confidence after 3 consecutive wins is likely overconfident. An agent dropping to 30% after a loss is loss-aversion, not rationality.
4. **Anchoring**: Is the agent anchored to a specific price level (ATH, entry price, round number) rather than reacting to current market structure?
5. **Narrative attachment**: Is the agent telling a story ("BTC is digital gold, institutions are coming") instead of reading the actual tape? Stories are seductive but often wrong.
6. **Herd mentality / consensus drift**: Is this agent agreeing with others just because everyone else agrees? True conviction has specific, non-generic reasoning.
7. **False precision / false confidence**: Is the agent confidently predicting a price target to 2 decimal places? Markets don't work that way. High precision with volatile assets = false confidence.
8. **Loss denial**: Open position is down 8% (leveraged) but the agent says "hold, it'll come back" without structural evidence. That's hope, not analysis.
9. **Narrative-vs-data divergence**: The agent's STORY says one thing, but the RAW DATA they cited says another. You catch this contradiction.
10. **Dopamine-chasing**: Agent recommending BUY after a +5% candle, or SELL after a -3% candle, without structural context. Price movement alone is not a strategy.

Meta-Agent and Market Agent are NOT reviewed. You only review the 5 sub-agents.

If the decision is sound AND bias-free → approved: true
If the decision has logical flaws OR shows behavioral bias → approved: false + provide corrected decision
If the agent says "no clear signal" or biases toward caution → likely correct, approve

Be concise. Output ONLY valid JSON.`,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          model: this.model,
          timeoutMs: 60_000,
        });

        const jsonStr = this.extractSkepticsJSON(response.content);
        const parsed = JSON.parse(jsonStr) as {
          approved: boolean;
          skepticismRationale: string;
          modifiedMarketTicker?: Partial<PerSymbolDecision>;
          modifiedPositions?: Array<Partial<PerSymbolDecision>>;
          modifiedConfidence?: number;
        };

        let modifiedDecision: MultiSymbolDecision | undefined;
        let modifiedConfidence: number | undefined;

        // ── HARD CONSTRAINT ENFORCEMENT (code-level, overrides LLM) ──
        // These constraints are DERIVED from evolution engine's best strategy.
        // The LLM might miss them; the code never does.
        const marketTicker = origDecision.marketTicker;
        let hardBlocked = false;
        let hardRationale = '';

        // Check position size (leverage is NOT checked — set by Market Agent)
        if ((marketTicker.positionSizePct ?? 0) > hardMaxPositionSize) {
          hardBlocked = true;
          hardRationale += `Position size ${(marketTicker.positionSizePct! * 100).toFixed(1)}% exceeds hard limit of ${(hardMaxPositionSize * 100).toFixed(1)}%. `;
        }
        // Check confidence
        if ((marketTicker.action === 'buy' || marketTicker.action === 'sell') && thought.confidence < hardMinConfidence) {
          hardBlocked = true;
          hardRationale += `Confidence ${(thought.confidence * 100).toFixed(0)}% below minimum ${(hardMinConfidence * 100).toFixed(0)}% for trade entry. `;
        }

        if (hardBlocked) {
          // Force-close the position / reduce to safe levels
          modifiedDecision = {
            marketTicker: {
              ...origDecision.marketTicker,
              action: 'hold',
              positionSizePct: 0,
              leverage: 1,
              rationale: `[HARD CONSTRAINT] ${hardRationale}Original: ${origDecision.marketTicker.rationale}`,
            },
            positions: origDecision.positions.map(p => ({
              ...p,
              action: 'hold' as const,
              closePosition: false,
              rationale: p.rationale,
            })),
          };
          modifiedConfidence = 0.1;
          this.logger.warn(`🚫 Hard constraint blocked ${roleName}: ${hardRationale}`);
        }

        if (!parsed.approved && !hardBlocked) {
          // Build modified decision
          const posSymbols = (origDecision.positions ?? []).map(p => p.symbol);
          const modMarket = parsed.modifiedMarketTicker
            ? {
                ...origDecision.marketTicker,
                action: (parsed.modifiedMarketTicker.action as 'buy' | 'sell' | 'hold') ?? origDecision.marketTicker.action,
                positionSizePct: parsed.modifiedMarketTicker.positionSizePct ?? origDecision.marketTicker.positionSizePct,
                leverage: parsed.modifiedMarketTicker.leverage ?? origDecision.marketTicker.leverage,
                closePosition: parsed.modifiedMarketTicker.closePosition ?? origDecision.marketTicker.closePosition,
                rationale: parsed.modifiedMarketTicker.rationale ?? origDecision.marketTicker.rationale,
              }
            : origDecision.marketTicker;

          const modPositions: PerSymbolDecision[] = posSymbols.map((sym, i) => {
            const orig = origDecision.positions[i]!;
            // v2.0.42: Use normalizeSymbol for consistent casing.
        const found = (parsed.modifiedPositions ?? []).find((p: any) => normalizeSymbol(p?.symbol ?? '') === normalizeSymbol(sym));
            return found
              ? {
                  ...orig,
                  // v2.0.104: Preserve buy/sell for trading markets, hold for positions
                  action: (found.action === 'buy' || found.action === 'sell')
                    ? found.action as 'buy' | 'sell'
                    : 'hold' as const,
                  closePosition: found.closePosition === true,
                  closeUrgency: (found.closeUrgency === 'immediate' || found.closeUrgency === 'soon' || found.closeUrgency === 'patient') ? found.closeUrgency : undefined,
                  suggestedStopLoss: typeof found.suggestedStopLoss === 'number' ? found.suggestedStopLoss : orig.suggestedStopLoss,
                  suggestedTakeProfit: typeof found.suggestedTakeProfit === 'number' ? found.suggestedTakeProfit : orig.suggestedTakeProfit,
                  rationale: found.rationale ?? orig.rationale,
                }
              : orig;
          });

          modifiedDecision = { marketTicker: modMarket, positions: modPositions };
          modifiedConfidence = parsed.modifiedConfidence;
        }

        const finalApproved = hardBlocked ? false : parsed.approved;
        const finalRationale = hardBlocked
          ? `[HARD CONSTRAINT] ${hardRationale}`
          : parsed.skepticismRationale ?? 'No rationale provided.';

        const review: SkepticsReview = {
          agentRole: roleName,
          originalThought: thought.thought ?? '',
          originalConfidence: thought.confidence,
          originalDecision: origDecision,
          approved: finalApproved,
          modifiedDecision,
          modifiedConfidence,
          skepticismRationale: finalRationale,
        };

        reviews.push(review);

        if (hardBlocked) {
          this.logger.warn(`🚫 Hard constraint blocked ${roleName}: ${hardRationale}`);
        } else {
          this.logger.info(`Review [${roleName}]: ${parsed.approved ? '✅ APPROVED' : '⚠️ MODIFIED'} — ${parsed.skepticismRationale?.slice(0, 80) ?? ''}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Review failed for ${roleName}: ${msg}. Auto-approving.`);
        reviews.push({
          agentRole: roleName,
          originalThought: thought.thought ?? '',
          originalConfidence: thought.confidence,
          originalDecision: origDecision,
          approved: true,
          skepticismRationale: `Skeptics review error: ${msg}. Decision auto-approved.`,
        });
      }
    }

    return reviews;
  }

  private buildSkepticsPrompt(
    thought: AgentThought,
    decision: MultiSymbolDecision,
    marketContext: string,
    agentTrackRecord: string,
  ): string {
    // Re-extract hard constraints from the market context for display
    // NOTE: Leverage is NOT included — it is set by Market Agent, not audited by agents.
    let hcMaxPos = 0.20, hcMinConf = 0.30;
    try {
      const mp = marketContext.match(/maxPositionSize=([\d.]+)/);
      if (mp) hcMaxPos = parseFloat(mp[1]!);
      const mc = marketContext.match(/minConfidenceForTrade=([\d.]+)/);
      if (mc) hcMinConf = parseFloat(mc[1]!);
    } catch { /* use defaults */ }

    // Build summaries of OTHER agents for cross-reference
    const otherAgentsSummary = this._otherThoughts && this._otherThoughts.length > 0
      ? `\nOTHER AGENTS' CONCLUSIONS (for cross-reference):\n${this._otherThoughts
          .filter(t => t.agentRole !== thought.agentRole)
          .map(t => `  [${t.agentRole}] confidence=${t.confidence.toFixed(2)}: ${(t.thought ?? '').slice(0, 200)}`)
          .join('\n')}`
      : '';

    // This agent's historical track record (from evolution)
    const historyNote = agentTrackRecord
      ? `\nTHIS AGENT'S RECENT TRACK RECORD:\n${agentTrackRecord}`
      : '';

    return `Agent Role: ${thought.agentRole}
Agent Confidence: ${thought.confidence.toFixed(2)}
Agent Thought: ${thought.thought}

Agent Decision (JSON):
${JSON.stringify(decision, null, 2)}

Evolution Hard Constraints:
  maxPositionSize=${(hcMaxPos * 100).toFixed(1)}%
  minConfidenceForTrade=${(hcMinConf * 100).toFixed(0)}%

Market Context (abridged):
${marketContext.slice(0, 1200)}${otherAgentsSummary}${historyNote}

TASK: Review this agent's decision for logical consistency AND behavioral biases.

=== EXPERIENCE DIGEST (v2.0.140 — premature close prevention) ===
If the market context contains "=== EXPERIENCE DIGEST (from N closed trades) ===":
  This digest analyses the system's biggest recurring problem: PREMATURE CLOSES
  initiated by Meta-Agent and Skeptics (YOU). The SL/TP placement is NOT the primary
  issue — the issue is that YOU and Meta-Agent override the SL with manual closes
  that ignore the actual price structure.

  **EXIT QUALITY**: if the digest shows a high premature close count (≤8min), YOU
  have a history of invalidating theses too early. When reviewing an agent's decision,
  check: is the agent recommending CLOSE? If so, verify the close is NOT premature
  using the same checks you apply to your own thesis re-validation:
    - Has price ACTUALLY breached the key S/R level (candle close, not just a wick)?
    - Has the position been open ≥15min? If not, the thesis hasn't had time.
    - Has SL been hit? If not, why is the agent recommending close?
    - Is the direction still correct per OLR/momentum?

  **ROOT CAUSE**: if the digest shows the DIRECTION was correct but positions were
  closed prematurely, this means YOUR thesis invalidations were wrong. Be more
  conservative — when in doubt, keep the thesis VALID and let SL/TP work.

  **VOLATILITY ANOMALY**: if ALL trades show low_volatility, the vol calculation is
  broken. This is a SYSTEM issue, not an agent error. Do NOT flag agents for bad
  judgment when the underlying data (volatility, regime) is faulty.

  **LOSING PATTERNS**: if a losing class shows "PREMATURE SL", the direction was
  correct — do NOT flag the agent's direction as wrong. The loss was caused by a
  premature close, not a wrong direction.

=== LOGIC CHECKS ===
- Does the decision follow from the data they cited?
- Did they misinterpret or omit anything?
- Is position sizing proportional to confidence?
- Cross-reference: do OTHER agents see the same market differently? If so, whose data is stronger?
- Track record: if this agent has a POOR track record in similar regimes, apply extra scrutiny

=== PSYCHOLOGY CHECKS ===
- **Recency bias**: Overweighting the last few candles vs the broader trend?
- **Confirmation bias**: Citing only supporting evidence, ignoring what doesn't fit?
- **Overconfidence**: Agent had 3 wins in a row and is now at 90% confidence? Suspect. 
  Conversely, after a loss, dropping to 30% when data still supports the thesis? Loss aversion.
- **Anchoring**: Tied to a specific price level (ATH, entry, round number) instead of current structure?
- **Narrative attachment**: Telling a story instead of reading the tape? Stories seduce. Data don't lie.
- **Herd drift**: Generic reasoning that sounds like everyone else? Real conviction is specific.
- **False precision**: Confidently predicting price to 2 decimals? Markets aren't that precise.
- **Loss denial**: Position is deeply negative but agent says "hold, it'll come back" without structural evidence? That's hope.
- **Narrative-vs-data**: The STORY says bullish but the RAW NUMBERS they cited say bearish? You catch the contradiction.
- **Dopamine-chasing**: Recommending BUY just because price went up 5%? Price action alone is not a thesis.

Output ONLY valid JSON:
{
  "approved": true/false,
  "skepticismRationale": "1-2 sentence explanation. Mention which bias or logic flaw was found.",
  "modifiedMarketTicker": { ... },  // only if !approved
  "modifiedPositions": [ ... ],     // only if !approved
  "modifiedConfidence": 0.0-1.0     // only if !approved
}`;
  }

  private extractSkepticsJSON(text: string): string {
    const trimmed = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return trimmed.slice(start, end + 1);
    }
    return trimmed;
  }

  // ═══════════════════════════════════════════════════════════════
  // v2.0.80: Entry Thesis Validation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Validate Meta-Agent's entry thesis for a NEW position before it opens.
   * Called after Meta-Agent produces a BUY/SELL decision with entryThesis.
   *
   * Returns true if the thesis is approved (trade may proceed), false if
   * rejected (trade is blocked — consensus overridden to HOLD).
   */
  async validateEntryThesis(
    thesis: string,
    action: 'buy' | 'sell',
    symbol: string,
    marketStateDesc: string,
    subAgentThoughts: AgentThought[],
  ): Promise<{ approved: boolean; rationale: string }> {
    if (!thesis || thesis.trim().length === 0) {
      return {
        approved: false,
        rationale: 'Entry thesis is empty — Meta-Agent must provide a thesis for BUY/SELL decisions.',
      };
    }

    try {
      const provider = getActiveProvider();

      // Build summary of sub-agent thoughts for cross-reference
      const agentSummary = subAgentThoughts
        .filter(t => t.agentRole !== 'meta_agent' && t.agentRole !== 'skeptics' && t.agentRole !== 'market_agent')
        .map(t => `[${t.agentRole}] conf=${t.confidence.toFixed(2)}: ${(t.thought ?? '').slice(0, 200)}`)
        .join('\n');

      const response = await provider.chat({
        messages: [
          {
            role: 'system',
            content: `You are Skeptics — the system's thesis validator and dark psychology auditor.

=== YOUR ROLE (v2.0.110) ===
Your PRIMARY job is to CONFIRM the Meta-Agent's thesis is sound — not to find excuses to reject it.
The system needs to trade to make money. A rejected trade costs nothing, but a system that never trades also makes nothing.
Your goal is to let good trades through while catching only genuinely dangerous ones.

Think of yourself as a risk manager at a trading desk: the trader (Meta-Agent) has a thesis. Your job is to STRESS-TEST it.
If the thesis survives stress-testing, APPROVE it. Only REJECT if you find a SPECIFIC, MATERIAL flaw that would make the trade lose money.

⚠️ v2.0.88: Past drawdown, loss streaks, and poor historical win rates are NOT valid reasons to reject.
Judge the thesis on its CURRENT merits based on CURRENT data.

=== APPROVAL IS THE DEFAULT ===
Start from "approved: true" and only flip to "rejected" if you find a MATERIAL flaw.
A material flaw is one that would cause the trade to LOSE MONEY with high probability:
  - The thesis direction is directly contradicted by STRONG, UNAMBIGUOUS data (not just "low confidence" signals)
  - There is CLEAR evidence of fact distortion (Meta-Agent says "bullish" but ALL agents say "bearish")
  - There is a SPECIFIC, IDENTIFIED manipulation pattern that makes this trade a trap (not just "could be" speculation)

=== WHAT IS NOT A REJECTION REASON ===
- "Low confidence" on a sub-agent signal → this is normal, signals are rarely 100% confident
- "Could be manipulation" without specific evidence → everything "could be" manipulation, that alone doesn't reject
- "Doesn't address dark psychology" in enough depth → the thesis doesn't need a full essay on manipulation, just awareness
- "Vague" 1h reason → if the 1h reason references actual price levels or patterns, it's specific enough
- RBC signal has low sample count → low samples means uncertainty, not wrong direction
- News could be FUD → news is ALWAYS potentially manipulated, this alone doesn't reject
- Sideways/low volatility market → these are normal conditions, not rejection reasons
- Sub-agent confidence is below 0.5 → agents are often cautious, this doesn't mean the thesis is wrong

=== WHEN TO REJECT (RARE) ===
Only reject if you can articulate a SPECIFIC, HIGH-PROBABILITY loss scenario:
  - "ALL three directional agents say BEARISH but Meta-Agent says BUY — this is direct contradiction, not just low confidence"
  - "The thesis claims 'breakout above $65k' but current price is $62k and trend is sideways — the catalyst hasn't happened yet"
  - "Whale wallet just moved 500 BTC to exchanges (visible in on-chain data) while Meta-Agent says BUY — this is distribution"

If you cannot articulate a specific loss scenario, APPROVE the trade.

=== DARK PSYCHOLOGY CHECK (LIGHTWEIGHT) ===
Ask ONE question: "Is there SPECIFIC evidence in the sub-agent data that this trade is a whale trap?"
- If yes → explain what the evidence is and REJECT
- If no → note "no specific manipulation evidence found" and APPROVE
Do NOT reject just because manipulation is theoretically possible — it's always possible.

Output ONLY valid JSON:
{"approved": true/false, "rationale": "1-3 sentence explanation. If approved, state why the thesis is sound. If rejected, state the SPECIFIC loss scenario."}`,
          },
          {
            role: 'user',
            content: `Meta-Agent wants to ${action.toUpperCase()} ${symbol}.

Entry Thesis: "${thesis}"

Market Context (abridged):
${marketStateDesc.slice(0, 1500)}

Sub-Agent Thoughts:
${agentSummary}

Stress-test this thesis. Start from APPROVED and only REJECT if you find a specific, material flaw that would cause a loss.
1. Is the thesis direction contradicted by STRONG, UNAMBIGUOUS sub-agent data? (Low confidence ≠ contradiction)
2. Is there SPECIFIC evidence of whale manipulation that makes this a trap? (Not just "could be")
3. Did Meta-Agent DISTORT facts? (Claiming "bullish" when data says "bearish" — not just cherry-picking weak signals)
4. Can you articulate a SPECIFIC loss scenario? If not, APPROVE.`,
          },
        ],
        temperature: 0.3,
        model: this.model,
        timeoutMs: 30_000,
      });

      const jsonStr = this.extractSkepticsJSON(response.content);
      const parsed = JSON.parse(jsonStr) as { approved: boolean; rationale: string };
      this.logger.info(`Thesis validation [${action} ${symbol}]: ${parsed.approved ? '✅ APPROVED' : '🚫 REJECTED'} — ${parsed.rationale?.slice(0, 100) ?? ''}`);
      return { approved: parsed.approved, rationale: parsed.rationale ?? 'No rationale provided.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // v2.0.110: Default to APPROVE on error — defaulting to REJECT caused the
      // system to stop trading entirely when the LLM had intermittent failures.
      // If we can't validate, we have no evidence the thesis is wrong.
      this.logger.warn(`Thesis validation failed: ${msg}. Defaulting to APPROVE (no evidence to reject).`);
      return { approved: true, rationale: `Thesis validation error: ${msg}. Approved — no evidence found to reject.` };
    }
  }

  /**
   * Re-validate entry theses for ALL open positions each cycle.
   * For each position with an entryThesis, fetch fresh market data and ask
   * the LLM if the thesis is still valid given current conditions.
   *
   * Returns a map of symbol → { valid: boolean, rationale: string }.
   * Positions with valid=false should be force-closed.
   */
  async validateOpenPositionTheses(
    positions: Array<{
      symbol: string;
      side: 'buy' | 'sell';
      entryPrice: number;
      currentPrice: number;
      stopLoss?: number;
      takeProfit?: number;
      leverage: number;
      entryThesis?: string;
    }>,
    marketStateDesc: string,
    fetchPriceForSymbol: (symbol: string) => Promise<number | null>,
  ): Promise<Map<string, { valid: boolean; rationale: string }>> {
    const results = new Map<string, { valid: boolean; rationale: string }>();

    // Filter positions that have a thesis to validate
    const positionsWithThesis = positions.filter(p => p.entryThesis && p.entryThesis.trim().length > 0);
    if (positionsWithThesis.length === 0) {
      return results;
    }

    this.logger.info(`Validating entry theses for ${positionsWithThesis.length} open position(s)...`);

    for (const pos of positionsWithThesis) {
      try {
        // Fetch fresh price for this symbol
        const freshPrice = await fetchPriceForSymbol(pos.symbol);
        const priceDesc = freshPrice !== null
          ? `Current price: $${freshPrice.toFixed(2)} (fetched fresh)`
          : `Current price: $${pos.currentPrice.toFixed(2)} (stale — no fresh data)`;

        const pnlPct = pos.side === 'buy'
          ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;

        const provider = getActiveProvider();
        const response = await provider.chat({
          messages: [
            {
              role: 'system',
              content: `You are Skeptics — validating whether an open position's entry thesis is STILL valid.

The position was opened with a specific thesis explaining why price would reach TP within 1h and 1d.
Your job: determine if that thesis is STILL valid given the current market data, or if it has been invalidated.

⚠️ v2.0.140 PREMATURE CLOSE PREVENTION (CRITICAL):
The system's biggest recurring problem is CLOSING POSITIONS TOO EARLY. You and Meta-Agent
have a history of initiating closes that ignore the actual price structure, causing small
losses that pile up. Before marking a thesis as invalidated, you MUST verify:

  1. **PRICE LEVEL**: Has price ACTUALLY breached the key S/R level the thesis depends on?
     If the thesis said "bounce at $64K" and price is at $63.8K, that is a NORMAL DRAWDOWN,
     not a thesis invalidation. $64K support is still intact unless price has decisively
     broken below it (e.g. 1h candle close below, not just a wick).

  2. **TIME**: How long has the position been open? If < 15 minutes, the thesis has NOT
     had time to play out. A 1h thesis CANNOT be invalidated in 5 minutes. A 1d thesis
     CANNOT be invalidated in 10 minutes. If the position has been open < 15min, default
     to VALID — the thesis needs time.

  3. **SL/TP**: If SL has NOT been hit and TP has NOT been hit, the position is in a
     normal range. Do NOT invalidate the thesis just because price moved against the
     position — that is what SL is for. Let the SL do its job.

  4. **DIRECTION**: Is the overall direction still correct? If the trend/momentum/OLR
     edge still favors the position's side, the thesis is NOT invalidated — the position
     just needs more time.

A thesis is INVALIDATED only if:
1. The catalyst/event the thesis was based on has already happened AND price didn't reach TP — the thesis is spent
2. The market structure has DECISIVELY changed (price broke key S/R level with a candle close, not just a wick)
3. The thesis direction is now contradicted by CURRENT data (e.g. thesis said bullish but trend is now bearish with confirmation)
4. The 1h timeframe has expired (>60min) AND the short-term reason did not materialize
5. Key data the thesis relied on has reversed (e.g. thesis cited "funding negative" but funding is now positive)

A thesis is STILL VALID if:
1. The catalyst hasn't happened yet but the setup is still intact (price is in the expected range)
2. Price is moving toward TP (even if slowly) and the structural reasons haven't changed
3. The 1d reason is still in play even if the 1h reason hasn't fully materialized
4. The position has been open < 15min — too early to judge
5. Price is in a normal drawdown within the SL range — SL hasn't been hit

When in doubt, default to VALID. A premature invalidation causes a small loss that piles up.
A missed invalidation lets the SL handle it. Asymmetric risk favors patience.

Output ONLY valid JSON:
{"valid": true/false, "rationale": "1-2 sentence explanation of why the thesis is still valid or invalidated"}`,
            },
            {
              role: 'user',
              content: `Position: ${pos.side.toUpperCase()} ${pos.symbol}
Entry Price: $${pos.entryPrice.toFixed(2)}
${priceDesc}
Stop Loss: ${pos.stopLoss ? `$${pos.stopLoss.toFixed(2)}` : 'NONE'}
Take Profit: ${pos.takeProfit ? `$${pos.takeProfit.toFixed(2)}` : 'NONE'}
Leverage: ${pos.leverage}x
Unrealized PnL: ${pnlPct.toFixed(2)}%

Original Entry Thesis: "${pos.entryThesis}"

Current Market Context (abridged):
${marketStateDesc.slice(0, 1200)}

Is this thesis STILL valid? Has the market changed in a way that invalidates the original reasoning?`,
            },
          ],
          temperature: 0.3,
          model: this.model,
          timeoutMs: 30_000,
        });

        const jsonStr = this.extractSkepticsJSON(response.content);
        const parsed = JSON.parse(jsonStr) as { valid: boolean; rationale: string };
        results.set(pos.symbol, { valid: parsed.valid, rationale: parsed.rationale ?? 'No rationale.' });
        this.logger.info(`Thesis re-validation [${pos.symbol}]: ${parsed.valid ? '✅ STILL VALID' : '🚫 INVALIDATED'} — ${(parsed.rationale ?? '').slice(0, 100)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Thesis re-validation failed for ${pos.symbol}: ${msg}. Defaulting to VALID (avoid premature close on error).`);
        results.set(pos.symbol, { valid: true, rationale: `Validation error: ${msg}. Kept open to avoid erroneous close.` });
      }
    }

    return results;
  }

  /**
   * v2.0.90: Validate Meta-Agent's decision to CLOSE a position.
   * Called before executing a close order. Meta-Agent decides to close →
   * Skeptics validates the reasoning → only then is the close executed.
   *
   * Returns true if the close is approved, false if the close should be blocked.
   */
  async validateCloseDecision(
    symbol: string,
    side: 'buy' | 'sell',
    entryPrice: number,
    currentPrice: number,
    unrealizedPnlPct: number,
    closeRationale: string,
    marketStateDesc: string,
    subAgentThoughts: AgentThought[],
  ): Promise<{ approved: boolean; rationale: string }> {
    if (!closeRationale || closeRationale.trim().length === 0) {
      return {
        approved: false,
        rationale: 'Close rationale is empty — Meta-Agent must provide reasoning for closing a position.',
      };
    }

    try {
      const provider = getActiveProvider();

      const agentSummary = subAgentThoughts
        .filter(t => t.agentRole !== 'meta_agent' && t.agentRole !== 'skeptics' && t.agentRole !== 'market_agent')
        .map(t => `[${t.agentRole}] conf=${t.confidence.toFixed(2)}: ${(t.thought ?? '').slice(0, 200)}`)
        .join('\n');

      const response = await provider.chat({
        messages: [
          {
            role: 'system',
            content: `You are Skeptics — validating Meta-Agent's decision to CLOSE a position.

Meta-Agent has decided to close a ${side.toUpperCase()} position. Your job is to verify the reasoning is sound.

⚠️ v2.0.140 PREMATURE CLOSE PREVENTION (CRITICAL):
The system's biggest recurring problem is CLOSING POSITIONS TOO EARLY. Meta-Agent has a
history of initiating closes that ignore the actual price structure. Before approving a
close, you MUST verify ALL of the following:

  1. **PRICE LEVEL**: Has price ACTUALLY breached the key S/R level? If the thesis depends
     on "bounce at $64K" and price is at $63.8K but $64K hasn't been decisively broken
     (candle close, not just a wick), the thesis is NOT invalidated. BLOCK the close.

  2. **SL/TP NOT HIT**: If SL has NOT been hit and TP has NOT been hit, Meta-Agent is
     overriding the stop-loss with a manual close. This is almost always premature.
     The SL exists for a reason — let it work. BLOCK the close unless there is a
     SPECIFIC structural reason (catalyst happened, S/R broken with confirmation).

  3. **TIME**: If the position has been open < 15 minutes, the thesis has NOT had time
     to play out. A 1h thesis cannot be invalidated in 5 minutes. BLOCK the close.

  4. **DIRECTION**: If the trend/momentum/OLR edge still favors the position's side,
     the direction is still correct. The position just needs more time. BLOCK the close.

A valid close decision must:
1. **MANDATORY**: The entry thesis must be DECISIVELY invalidated (not just "might be"
   or "looks uncertain" — a specific structural break or catalyst failure).
2. Have a SPECIFIC reason referencing a PRICE LEVEL or CATALYST — not just "holding is risky"
3. Be based on CURRENT data — not past drawdown or loss streaks
4. Be consistent with sub-agent data — if agents say the thesis is still valid, BLOCK
5. NOT be panic-driven — closing at a small loss to avoid a larger loss is valid ONLY if
   the thesis is actually broken, not just because PnL is negative

Valid close reasons (ALL require DECISIVE thesis invalidation):
- Entry thesis is invalidated by a SPECIFIC new event (e.g. bullish news contradicts SHORT thesis)
- Structural break with CONFIRMATION (price closed below key S/R, not just wicked)
- Catalyst event happened and thesis didn't play out (price went opposite after the event)
- ≥2 sub-agents independently recommend close with specific reasoning AND thesis is broken

Invalid close reasons (BLOCK THESE):
- "Market is chaotic" without specifying how it specifically threatens this position
- "Past trades lost money" (backward-looking, RBC learns)
- "Drawdown is high" (backward-looking)
- Vague uncertainty without a specific threat
- Thesis is still valid but price went against us temporarily
- Position has been open < 15min (too early to judge)
- SL has not been hit and no structural break has occurred
- Price is in a normal drawdown within the SL range

When in doubt, BLOCK the close. A premature close causes a small loss that piles up.
A missed close lets the SL handle it. Asymmetric risk favors patience.

Output ONLY valid JSON:
{"approved": true/false, "rationale": "1-2 sentence explanation"}`,
          },
          {
            role: 'user',
            content: `Meta-Agent wants to CLOSE a ${side.toUpperCase()} position on ${symbol}.

Entry: $${entryPrice.toFixed(2)}
Current: $${currentPrice.toFixed(2)}
PnL: ${unrealizedPnlPct.toFixed(2)}%

Close Rationale: "${closeRationale}"

Market Context (abridged):
${marketStateDesc.slice(0, 1200)}

Sub-Agent Thoughts:
${agentSummary}

Validate this close decision. Is the reasoning specific and data-driven? Is the entry thesis ACTUALLY invalidated? If the thesis is still valid, BLOCK the close.`,
          },
        ],
        temperature: 0.3,
        model: this.model,
        timeoutMs: 30_000,
      });

      const jsonStr = this.extractSkepticsJSON(response.content);
      const parsed = JSON.parse(jsonStr) as { approved: boolean; rationale: string };
      this.logger.info(`Close validation [${symbol}]: ${parsed.approved ? '✅ APPROVED' : '🚫 BLOCKED'} — ${parsed.rationale?.slice(0, 100) ?? ''}`);
      return { approved: parsed.approved, rationale: parsed.rationale ?? 'No rationale provided.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Close validation failed for ${symbol}: ${msg}. Defaulting to APPROVE (allow close on error).`);
      return { approved: true, rationale: `Validation error: ${msg}. Close allowed.` };
    }
  }
}