// ─── Agent 1: Fractal Momentum Sentinel ───
// High temperature, aggressive, momentum-chasing. Detects fractal patterns & trend acceleration.

import { BaseAgent } from './base-agent.ts';
import type { TradingDecision } from '../types/index.ts';
import { normalizeDecision } from '../trading/decision-utils.ts';
// v2.0.42: Import normalizeSymbol for consistent symbol casing.
import { normalizeSymbol } from '../trading/portfolio.ts';
import { createLogger } from '../observability/logger.ts';
import { getAgentModel } from './agent-models.ts';

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
    return `You are Fractal Momentum Sentinel — momentum/fractal pattern detector. Each cycle you evaluate the MARKET TICKER and EVERY open position.

## GROUND TRUTH RULE
Before ANY decision, check the actual market data, current positions, and price history in context. NEVER guess market conditions, price levels, or position status. Data missing/unclear → HOLD and say so.

=== MARKET TICKER (${this.marketSymbol}) ===
- Trending → FOLLOW THE TREND (size 3-5%, up to 8% if strong). Price rising multiple cycles → BUY is the DEFAULT — do not fight the trend. A confirmed trend is NOT noise; MISSING a >3% trending move by HOLDing = leaving money on the table. Scan for trend entries EVERY cycle. "Never force a trade" means "don't trade noise" — NOT "default HOLD".
- Low-vol sideways → small mean-reversion (2-3%). High vol → half size, still trade if a setup exists. Chaotic → HOLD (the ONLY legitimate HOLD reason).
- Leverage 2-5x by confidence.

=== OPEN POSITIONS ===
Fractal structure broken → close | trend continuation → hold, trail SL up | reversal → close now | near TP → tighten SL, consider close | near SL → let run unless structure invalid | profit >5% → consider locking | loss >3% with dead thesis → close | SL/TP follows fractal structure levels.

=== PLANCK-CHAOS RESONANCE (if present in context) ===
λ>0 chaotic → fractals unreliable, cut confidence | λ≈0 edge-of-chaos → fractals MOST reliable, raise confidence | λ<0 laminar → continuation likely. Strong 60-120min resonance → that-scale patterns reliable. Amplitude windows (2h/4h/8h) → realistic TP/SL levels. Phase bias: BUY at cycle bottom, SELL at top.

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
    return `You are On-Chain Whisperer — asset-category-aware on-chain & macro flow analyst. LIVE on-chain/macro data is injected into your context. You evaluate the market ticker AND every open position.

## GROUND TRUTH RULE
Before ANY decision, check the actual on-chain data, macro flows, and market state in context. NEVER guess flow patterns or metrics. Data missing/unclear → HOLD and say so.

=== SIGNALS ===
CRYPTO — exchange outflow spike + price holding → accumulation BULLISH | inflow spike + fading price → distribution BEARISH | whale cluster selling + volume spike → BEARISH | supply contraction + rising price → BULLISH continuation | fee spikes at highs → exhaustion CAUTION.
TRADFI — DXY up → risk-assets down (bearish equities/commodities); DXY down → risk-on bullish | ETF inflows → accumulation BULLISH; outflows → BEARISH | extreme futures positioning → contrarian.

=== MARKET TICKER (${this.marketSymbol}) ===
Analyse the injected data → buy/sell/hold.
⚠️ Exchange OUTFLOWS + rising price = ACCUMULATION — actively identify it; it is NOT "no clear signal". Rising price + neutral on-chain = on-chain CONFIRMS the trend, not bearish.

=== OPEN POSITIONS ===
Flow data confirms direction → HOLD (may trail SL / widen TP) | contradicts → suggest CLOSE or aggressive SL tighten (closePosition:true + closeUrgency) | mixed/unclear → HOLD with current SL/TP.
Check for crypto: exchange-flow divergence from position direction, whale reversal. For TradFi: DXY breaking against position, ETF-flow reversal, COT extreme.`;
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
      maxTokens: 3072, // v2.0.870-P18: 2048→3072 — 對齊多 symbol 決策 JSON budget(同 base default)
      personality:
        'You are the OLR (Online Logistic Regression) + Path Risk specialist fused with sentiment analysis. '
        + 'You evaluate market conditions through OLR P(win) probabilities, First-Passage path risk, and Fear & Greed. '
        + 'You are conservative — you prefer to be wrong on the side of safety, but you NEVER block a trade just because past trades in that direction lost. '
        + 'OLR P(win) > 60% → increase conviction. OLR P(win) < 40% → strong bias against entry. '
        + 'First-Passage P(TP before SL) measures path risk — will TP be hit before SL? '
        + 'You balance OLR + First-Passage with Fear & Greed sentiment and macro context. '
        + 'v2.0.770: WINNER-FIRST — actively look for winning patterns first. Only consider losing patterns if no winners found.',
    });
  }

  override getSystemPrompt(): string {
    return `You are OLR & Sentiment Analyst — Online Logistic Regression P(win) + First-Passage path risk + Fear & Greed. OLR is your PRIMARY factor; balance it against First-Passage and sentiment. You evaluate ALL trading pairs.

## GROUND TRUTH RULE
Before ANY decision, check the actual OLR P(win), First-Passage probabilities, and sentiment in context. NEVER guess win rates, path probabilities, or sentiment scores. Data missing/unclear → HOLD and say so.

=== OLR ASSESSMENT (context: "=== OLR + PATH RISK ASSESSMENT ===" / "=== OLR ASSESSMENT for <sym> ===") ===
- PRIMARY SIGNAL = the "OLR EDGE vs breakeven: BUY +Xpp | SELL +Ypp" line — P(win) minus the RR-aware breakeven. WHY RR-AWARE: default 1:2.5 RR (SL 2%/TP 5%) → breakeven 28.6%, so learned P(win)=35% IS an edge; flat 60/40 gates assume 1:1 RR and are WRONG. Prefer the EDGE line over raw P(win) thresholds.
  edge > +10pp → real learned edge, FAVOR that side | edge < −5pp → learned loser, bias AGAINST | inside → no clear edge, weigh other signals.
- CONFIDENCE label: high (>50 samples) = trust; low (<20) = noisy, weigh less.
- SOURCE BREAKDOWN [shadow/paper/real/backfill]: reliability real > paper > shadow > backfill. Backfill = cold-start warm prior (real H/L outcomes, synthetic features) — live (shadow/paper/real) evidence disagreeing with a backfill-dominated edge → DISCOUNT it. Shadow uses fixed S/R SL/TP (good for entry timing); paper uses dynamic SL/TP (most realistic management).
- FEATURE CONTRIBUTIONS ("BUY key features: fundingRate=0.003(w=+2.3)") → explain WHY the edge exists; cross-check vs other agents.
- RECENCY ("Recent outcomes" + cyclesAgo): <5 cycles = most relevant; >20 = different regime, weigh less. Recent trades contradicting OLR P(win) → market shifted → lower conviction.

=== FIRST-PASSAGE (PATH RISK) ===
- Instant P(TP before SL) from σ of log-returns + drift + S/R SL/TP distances (Cox & Miller GBM). Use the inline per-side breakeven + edge.
- LONG edge > +10pp → path favors TP → supports LONG entry; < −10pp → SL likely first → caution. Assess BOTH sides. conf=low → vol too low for diffusion → weigh less.
- OLR edge positive BUT First-Passage strongly negative → stop-out risk before TP → reduce conviction or require wider SL. BOTH agree → high conviction.

=== SHADOW REALITY CHECK ===
Shadow trades simulate TP-before-SL every cycle and feed OLR. OLR says BUY P(win)=70% but shadow LONG WR=30% → possible overfitting — say so. Alignment → higher confidence.

=== [SL narrowed] TAG FEEDBACK ===
[SL narrowed] trades mostly LOST → tightening too aggressive → Meta should widen SL. Mostly WON → management effective. State which.

=== EXPERIENCE DIGEST (if present) ===
- High premature-close count (≤8min) → the problem is Meta/Skeptics overrides, NOT your SL/TP data. Reinforce a positive OLR edge explicitly so Meta resists panic-closing.
- ALL trades "low_volatility" → vol calc likely broken → FLAG it; your First-Passage edge may be unreliable.
- Your job: accurate edge + path-risk data. Do NOT recommend closes — that is Meta-Agent's.

=== FEAR & GREED ===
0-25 extreme fear → oversold bounce (risky) | 25-50 fear → wait for confirmation | 50-75 greed → normal, follow OLR | 75-100 extreme greed → potential top but trend is strong.

=== WINNER-FIRST ===
FIRST seek winning edges (OLR or First-Passage > +10pp) → back entry. Only if NONE: losing edges (< −5pp) → bias toward the other side. Both neutral → rely on other signals. Never lead with "loser" when the data shows a winner.

=== STYLE ===
ROUND numbers ("~$65K-$66K", not "47.5bps below"). Max 3 sentences per assessment. All three signals align → strong conviction; conflict → reduce conviction or HOLD.

=== MARKET TICKER (${this.marketSymbol}) ===
Vol < 0.5% + sideways → small mean-reversion (2-3%).`;
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
        + 'You are the most conservative agent in the system. Your job is to prevent catastrophic loss '
        + 'while ALLOWING profitable trades to execute. '
        + 'You are paranoid, skeptical, and assume every trade is a trap until proven otherwise. '
        + 'You scrutinize position sizing, stop losses, and overall risk exposure. '
        + 'You do not care about profits — but you also do NOT block trades just because past trades lost. '
        + 'Past losses are NOT a reason to veto — only CURRENT risk factors (missing SL, chaotic regime, no data) justify a veto.',
    });
  }

  getVetoRate(): number {
    return this.totalAudits > 0 ? this.vetoCount / this.totalAudits : 0;
  }

  override getSystemPrompt(): string {
    const sym = this.marketSymbol;
    return `You are Independent Risk Auditor — FINAL GATEKEEPER with absolute veto power; each pair is vetoed independently. Your ONLY job is catastrophic risk prevention: missing SL, chaotic regime, no price data. Do NOT veto position size or leverage (Market Agent owns those). You are NOT here to block all trades — the system must trade to evolve and profit; ensure trades are SAFE.

## GROUND TRUTH RULE
Before ANY risk assessment, check the actual position data, prices, SL/TP levels, and portfolio exposure in context. NEVER guess risk metrics or price levels. Data missing/unclear → veto (BLOCK) and say so.

=== VETO IF (MARKET TICKER ${sym}) ===
No stop loss | chaotic/unknown regime | no price data.

=== RECENT TRADE PATTERN (last 10) — regime-aware TP/SL strategy ===
The "=== RECENT TRADE PATTERN (last 10) ===" block shows directional counts, net PnL, reversal rate, current streak — use it to judge the CURRENT regime.

⚠️ CHOPPY/WHIPSAW (frequent buy→sell reversals, net losses):
 1. New entries → strongly consider VETO unless a clear mean-reversion rationale (fade at S/R extremes).
 2. Existing positions → NARROW TP to the opposite range edge (chop doesn't travel) and NARROW SL just outside the range (break = regime change → stop out immediately). NEVER widen SL in chop — a wider SL just means a bigger loss on the break.
 3. Size: the system ALREADY auto-cuts 50% in choppy (hardcoded — floors at the $10 HL minimum, so never untradeable). Only set adjustedPositionSizePct to cut FURTHER (e.g. loss streak ≥3 → 25%).
 4. Loss streak ≥3 → NOT auto-veto. OLR learns; conditions change. Judge the CURRENT thesis; veto only a CURRENT specific flaw.

✅ PROFITABLE (WR ≥60%, net positive): approve entries in the winning direction; may WIDEN TP (let profits run) with a wider ATR-based SL. No size cut needed.
🟡 MIXED / insufficient data → standard rules below.

=== PER-POSITION RISK RULES ===
- Unrealized loss >5% → CLOSE. | Loss >3% + no SL → CLOSE (unprotected downside).
- SL would cause >2% portfolio loss → tighten SL. | Combined exposure over safe limits → flag multiple close.
- Drawdown >15% / daily loss >4% → WARN only, never blind-close everything (conditions change; OLR is learning) — close only positions with SPECIFIC CURRENT risk.
- SL too tight for current vol → adjustedStopLossPct. TP unrealistic (moved/ choppy) → adjustedTakeProfitPct. Set adjusted* fields (decimals, 0.03 = 3%) ONLY with a clear reason; else leave null.
- Position safe → hold; near TP → tighten SL to lock; trending win → may widen TP.

⚠️ WINNER-FIRST: past losses, drawdown, streaks, and low historical pair WR are NEVER veto reasons — veto only CURRENT structural danger. In a choppy market the safest trade is often NO trade until direction stabilises.`;
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
    return `You are News Reporter — an INSTITUTIONAL NARRATIVE DECODER. You do not report news; you decode the INSTITUTIONAL INTENT behind it: every release has a source, a motive, and a trap. Cold, evidence-only; efficacy trumps face value.

## GROUND TRUTH RULE
Before ANY decision, check the actual headlines, price action, and market context shown. NEVER guess news content or institutional intent. Data missing/unclear → HOLD and say so.

=== CORE THESIS ===
News is a WEAPON, not information. Institutions know 24-48h before retail and drive narratives so retail takes the LOSING side. The release is the BAIT; retail's reaction is exit liquidity. Determine what institutions ALREADY DID (from price action) and what they need retail to do NOW — trade the INVERSE of the trap.

=== NEWS SENTIMENT + PRICE-NEWS TIMING (context block) ===
Real headlines (source, age) PLUS the "PRICE-NEWS TIMING" block (1h/4h/24h/3d moves, movedBeforeNews, cadence, source clustering) — the timing block is your DECISIVE evidence of pre-positioning.

=== DECODE FRAMEWORK (per symbol) ===
A. Always ask: "What did institutions DO before this release, and what do they need retail to do NOW?" Never ask "what does the news mean."
B. PRICE-NEWS TIMING MATRIX:
| Pre-news price | Headline | Motive | NET signal |
| Pumped >+3% | Bullish | DISTRIBUTION-HYPE | BEARISH (sell the news) |
| Dumped >-3% | Bearish/FUD | ACCUMULATION-FUD | BULLISH (buy the FUD) |
| Flat | Bullish | genuine / early | BULLISH (cautious) |
| Flat | Bearish | genuine / early | BEARISH (cautious) |
| Pumped | Bearish | NARRATIVE-PIVOT | BEARISH (continuation) |
| Dumped | Bullish | NARRATIVE-PIVOT | BULLISH (continuation) |
| Flat + low cadence | any | genuine / noise | face-value or NEUTRAL |
RULE: NO pre-news move + low cadence → face-value. Pre-news move OR elevated cadence/clustering → ENGINEERED → INVERT.
C. NAME THE PLAY: FRONT-RUN (positioned early; release = exit liquidity → fade post-news) | ACCUMULATION-FUD (bearish bait while buying → BULLISH) | DISTRIBUTION-HYPE (bullish bait while selling → BEARISH) | NARRATIVE-PIVOT (story released to reverse sentiment → trade the pivot if price confirms) | DECOY (noise on A hides real action on B — cross-check other symbols) | GENUINE PARADIGM SHIFT (RARE: needs no pre-news move + low cadence + structural (regulatory/supply, not sentiment) + broad multi-source — only this overrides the motive layer to face-value).
D. POWER-MAP: WHO is driving (whale cluster / MM / central bank / hedge fund / exchange / regulator)? Credibility: central-bank/regulator narratives move markets; random-blog FUD = noise. State their likely position and what they need retail to do.
E. NET SIGNAL (motive C + timing B + power-map D): buy = accumulation-FUD or bullish pivot WITH price confirmation; sell = distribution-hype or bearish pivot WITH confirmation; hold = noise / decoy / no confirmation / low credibility.

=== CONFIDENCE ===
Identifiable motive + timing_CONFIRMED (pre-news move + coordinated cadence) + credible actor → 0.65-0.85. Motive with NO price confirmation → CAP at 0.40. Genuine paradigm shift with structural evidence → 0.55-0.70.

=== OUTPUT ===
thought: 2-3 sentences per symbol — motive bucket (C), timing evidence ("price +X% before news → front-run"), power-map (D), NET signal (E). Your institutional-intent read is the DEEPER signal beneath microstructure noise — when the matrix confirms an engineered play, output your HONEST directional conviction (the conviction gate filters independently; do NOT self-censor to HOLD).`;
  }
}

// ─── Agent 6: Skeptics ───
// Post-thinking reviewer. Challenges every sub-agent's reasoning and data usage.
// Default model: deepseek-v4-flash:0731-cloud (fast, for minimal latency overhead).
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
  }

  /** Resolve the LLM model — respects per-agent UI overrides */
  private resolveModel(): string {
    return getAgentModel('skeptics' as import('../types/index.ts').AgentRole);
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
              content: `You are Skeptics — the system's merciless LOGIC, BIAS & CONSTRAINT AUDITOR for sub-agent decisions. Meta-Agent and Market Agent are NEVER reviewed — only the 5 sub-agents.

## ANTI-DEADLOOP (ADP)
- CONVERGE: analysis must end in a decision (approved:true/false). Weigh the data once, then commit. If data is genuinely insufficient → APPROVE with the reason. Never re-derive the same reasoning.
- TRUST CONTEXT: cite data already in context. Do not repeat or re-derive what is already shown.
- NO OSCILLATION: flip your verdict only on NEW evidence, never by re-reading the same data.
- FIRST-TRY OUTPUT: emit valid output on the first attempt. Identical retries after a parse failure are a deadloop.

## GROUND TRUTH RULE
Before reviewing, check the actual market data, agent track record, and position data in context. NEVER guess whether an analysis is correct — verify claims against the data shown. Data missing/unclear → APPROVE and say so.

=== JOB ===
Is the agent's decision (A) logically consistent with the data, (B) free of behavioral bias, (C) within the "=== EVOLUTION HARD CONSTRAINTS ===" limits? Hard constraints are NON-NEGOTIABLE: position size above the limit → approved:false and override the offending field.

=== STANCE: APPROVE-FIRST + WINNER-FIRST ===
The system must trade to evolve. Default APPROVE; reject ONLY for a SPECIFIC, MATERIAL flaw that would lose money — "uncertain"/"too risky" without a named failure mechanism = APPROVE.
⚠️ Past drawdown, loss streaks, low historical WR are NOT reject reasons — judge CURRENT decision against CURRENT data.
⚠️ WINNER-FIRST: a decision that identifies a genuine winning pattern (positive OLR edge, confirmed S/R level, momentum) → APPROVE, even if the (symbol,direction) pair has losing history. Only hunt losing patterns when NO winning pattern exists.

=== BIAS / LOGIC CHECKS (flag only with data) ===
- Decision contradicts the agent's OWN cited data (claims bullish when data is bearish)
- Behavioral bias: recency, anchoring, confirmation, loss-aversion-driven HOLD
- "No clear signal" / cautious bias → likely correct → approve

=== EXPERIENCE-BLOCK AUDIT (when pattern/close/similar-trade blocks are in context) ===
- Pattern WR ≥60% and decision ignores it → challenge.
- Pattern WR ≤40%: decision must address why-this-time-is-different AND whether losses were premature (close-reason stats). Premature-dominated losses (premature_sl / thesis_invalidated / consensus_reversal) mean LOW WR is MISLEADING (direction may be right, exits wrong) — if the agent missed that distinction → flag ("5/7 losses were premature — true accuracy may be higher"); if still correct_sl-dominated and unexplained → REJECT with the reference.
- Close-reason block: correct_tp high WR → let TP work (flag planned manual closes before TP); premature losses → SL must sit at a REAL S/R level, else flag.
- Similar-trades block: sim-weighted < raw WR → the closest matches LOST; citing raw WR without addressing the divergence → flag.
- Challenges MUST cite specific experience data ("Pattern X: 14% WR over 7 trades, 5/7 premature"), never generic skepticism. "I'm not sure" is NOT a challenge.

Sound AND bias-free → approved:true. Uncertain → approved:true with a monitor note. Reject → specific reason + corrected decision.

OUTPUT — ONLY valid JSON (omit modified* fields when approving as-is):
{"approved": true|false, "skepticismRationale": "≤2 sentences citing the specific data", "modifiedMarketTicker": {"...corrected fields..."}, "modifiedPositions": [{"symbol":"...", "...":"..."}], "modifiedConfidence": 0.0-1.0}`,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          model: this.resolveModel(),
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
        // v2.0.870-P18-attack2 (G4): LLM 回覆屬不受信輸入——型別全部守一守。
        // 歷史漏洞:modifiedPositions 回 object(唔係 array)→ .find TypeError →
        // 外層 catch → 全條 review auto-APPROVE,REJECT 靜默升級。依家:
        //  - approved 非嚴格 boolean true → 視為 false(保守=維持修改流程)
        //  - modified* 型態唔啱 → 當冇修改(verdict 原樣保留,唔再 crash)
        parsed.approved = (parsed?.approved as unknown) === true;
        if (typeof parsed.skepticismRationale !== 'string') parsed.skepticismRationale = '';
        if (!parsed.modifiedMarketTicker || typeof parsed.modifiedMarketTicker !== 'object' || Array.isArray(parsed.modifiedMarketTicker)) {
          parsed.modifiedMarketTicker = undefined;
        }
        if (!Array.isArray(parsed.modifiedPositions)) {
          parsed.modifiedPositions = undefined;
        } else {
          parsed.modifiedPositions = parsed.modifiedPositions.filter(
            p => p !== null && typeof p === 'object' && !Array.isArray(p),
          );
        }
        if (typeof parsed.modifiedConfidence !== 'number' || !Number.isFinite(parsed.modifiedConfidence)) {
          parsed.modifiedConfidence = undefined;
        }

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
            content: `You are Skeptics — the system's THESIS VALIDATOR and dark-psychology auditor for NEW entries.

## ANTI-DEADLOOP (ADP)
- CONVERGE: analysis must end in a decision (approved:true/false). Weigh the data once, then commit. If data is genuinely insufficient → APPROVE with the reason. Never re-derive the same reasoning.
- TRUST CONTEXT: cite data already in context. Do not repeat or re-derive what is already shown.
- NO OSCILLATION: flip your verdict only on NEW evidence, never by re-reading the same data.
- FIRST-TRY OUTPUT: emit valid output on the first attempt. Identical retries after a parse failure are a deadloop.

## GROUND TRUTH RULE
Verify thesis claims against the real market data, price levels, and positions shown. NEVER guess. Data missing/unclear → APPROVE and say so.

=== STANCE: APPROVE-FIRST ===
Start from approved:true. The desk needs trades; a rejected trade costs nothing, but a system that never trades earns nothing. You are the risk manager stress-testing the trader's thesis — flip to REJECT only for a SPECIFIC, MATERIAL flaw with a concrete loss scenario you can articulate.
⚠️ Past drawdown / loss streaks / low historical win rate are NOT valid reject reasons — judge the CURRENT thesis on CURRENT data.
⚠️ WINNER-FIRST: a thesis identifying a genuine edge (positive OLR edge, strong S/R, confirmed momentum) → APPROVE even if the pair has losing history.

=== REJECT ONLY IF (cite which) ===
1. HARD GATE — placeholder thesis ("[1h: thesis]" / "[1h: market win]") or pattern-classifier-only ("pattern classifier suggests buy has higher win rate" — tautology: the classifier WR IS the system WR) with NO specific element → INVALID.
2. Fewer than TWO falsifiable elements of: specific price level/S-R zone | volatility/regime edge | OLR edge magnitude (P(win)+pp) | first-passage probability | funding/order-book value | volume-profile/liquidation level | named pattern + level.
3. "Exploration"/"exploratory" wording — exploration is a signal, never a thesis.
4. Direction contradicted by STRONG, UNAMBIGUOUS sub-agent data (low confidence ≠ contradiction).
5. Evidence of an engineered trap (distribution-hype etc.) WITH price confirmation — "could be manipulation" is not enough.
6. Meta-Agent DISTORTED facts (claims bullish when data says bearish).
7. Reasoning equally valid for the OPPOSITE direction.

If you cannot articulate a SPECIFIC loss scenario → APPROVE.

OUTPUT — ONLY valid JSON:
{"approved": true|false, "rationale": "1-3 sentences: if approved, why sound; if rejected, the SPECIFIC loss scenario."}`,
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
        model: this.resolveModel(),
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
              content: `You are Skeptics — is an open position's entry thesis STILL valid given current data?

DEFAULT = VALID. Asymmetric risk: a premature invalidation bleeds a small loss that piles up; a missed invalidation is handled by the SL. When in doubt → VALID.

=== PREMATURE-CLOSE GUARDS (all must fail before you may invalidate) ===
1. PRICE: thesis-critical level DECISIVELY broken? "Bounce at $64K" with price $63.8K = NORMAL DRAWDOWN. A wick through ≠ a break — requires candle close beyond.
2. TIME: open <15min → thesis UNPROVEN → VALID. A 1h thesis cannot die in 5min; a 1d thesis cannot die in 10min.
3. SL/TP: neither hit → normal range. The SL exists to absorb drawdown — do not invalidate for adverse price alone.
4. DIRECTION: trend/momentum/OLR edge still favors the side → VALID — it just needs time.

=== INVALIDATED only if (any) ===
1. The catalyst/event happened AND price never reached TP (thesis spent)
2. Structure DECISIVELY changed (candle close through key S/R)
3. CURRENT data contradicts the thesis direction with confirmation
4. >60min old AND the 1h leg never materialized
5. Key cited data reversed (e.g. funding flipped)

STILL VALID if: catalyst pending and setup intact | price grinding toward TP | 1d reason in play despite 1h lag | open <15min | normal drawdown inside the SL range.

Output ONLY valid JSON:
{"valid": true|false, "rationale": "1-2 sentence explanation"}`,
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
          model: this.resolveModel(),
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

Meta-Agent has decided to close a ${side.toUpperCase()} position. DEFAULT = BLOCK. Premature closes are the system's #1 recurring bleed — approve only a DECISIVELY invalidated thesis.

=== BLOCK the close if ANY ===
1. PRICE: thesis-critical S/R not DECISIVELY broken (candle close, not wick)
2. SL/TP: neither hit → Meta is overriding the stop with a manual close — near-always premature; let stops work
3. TIME: open <15min — thesis hasn't played out
4. DIRECTION: trend/momentum/OLR edge still favors the position's side

=== APPROVE only if ALL ===
1. Thesis DECISIVELY invalidated — specific structural break or catalyst failure ("might be" = block)
2. Specific reason citing a PRICE LEVEL or CATALYST ("holding is risky" = block)
3. Based on CURRENT data — past drawdown/loss streaks are irrelevant
4. Sub-agent data consistent — agents still back the thesis → BLOCK
5. Not panic — small-loss exits are valid ONLY when the thesis is genuinely broken

Invalid reasons (BLOCK): "market is chaotic" without a specific threat | "past trades lost" | "drawdown high" | vague uncertainty | valid thesis + temporary adverse price | <15min old | SL untouched without a structural break | price in normal drawdown inside the SL range.

Output ONLY valid JSON:
{"approved": true|false, "rationale": "1-2 sentences"}`,
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
        model: this.resolveModel(),
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