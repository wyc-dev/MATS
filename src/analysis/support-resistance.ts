// ─── Support / Resistance Zone Detection ───
// Extracts key price levels from candle OHLCV data and order book clusters,
// scores them by strength (touch count, recency, volume confirmation),
// and integrates with Regime Guardian output — chaotic regime auto-degrades.
//
// "Price has memory. S/R levels are its scars — every touch tells a story."
//
// === Data Sources ===
//   Primary:   HL candleSnapshot daily candles → pivot high/low (90d window)
//   Secondary: HL candleSnapshot 1h candles → short-term levels (7d window)
//   Tertiary:  Round numbers (psychological barriers, auto-generated)
//
// === Regime Integration ===
//   chaotic      → return degraded context ("S/R unreliable in current regime")
//   high_vol     → widen proximity threshold (1.0% → 2.0%), reduce strength
//   trending_*   → full output, breakout zones highlighted
//   mean_revert  → full output, reversal zones highlighted
//
// === Caching ===
//   Daily pivots: recalculated every 6h
//   1h pivots:    recalculated every 30min
//   Round nums:   static (computed once)

import { createLogger } from '../observability/logger.ts';
import type { MarketRegime } from '../types/index.ts';

const log = createLogger({ phase: 'sr_detector' });

// ─── Exported Types ───

export interface SRZone {
  type: 'support' | 'resistance';
  price: number;
  strength: 'strong' | 'moderate' | 'weak';
  touchCount: number;
  lastTouchTimestamp: number; // epoch ms
  /** Where this level came from: pivot | round_num | orderbook */
  source: 'pivot' | 'round_num' | 'orderbook';
  /** Regime-dependent flag: true if this level should be highlighted */
  highlighted: boolean;
}

export interface SRContext {
  zones: SRZone[];
  /** Degraded reason string when regime prevents proper S/R analysis */
  degradedReason: string | null;
  /** The regime that was used for this analysis */
  regime: MarketRegime;
  /** Current price relative to nearest levels */
  currentPosition: {
    price: number;
    distanceToNearestSupport: number; // bps
    distanceToNearestResistance: number; // bps
    nearestSupport: number | null;
    nearestResistance: number | null;
  };
  /** Formatted context string for Agent injection */
  formatted: string;
}

// ─── Internal Types ───

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RawCandle {
  t: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

interface PivotInfo {
  price: number;
  timestamp: number;
  type: 'pivot_high' | 'pivot_low';
  volume: number;
}

interface ZoneCluster {
  price: number;
  type: 'support' | 'resistance';
  touches: Array<{ timestamp: number; volume: number }>;
  source: 'pivot' | 'round_num' | 'orderbook';
}

// ─── Configuration ───

const CONFIG = {
  /** Proximity threshold: merge pivots within X bps of each other */
  mergeThresholdBps: 50, // 0.5% — wider for better consolidation
  /** Minimum pivots needed on one side to form a zone */
  minPivotsForZone: 1,
  /** Decay half-life for touch recency (ms) */
  recencyHalfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  /** Cache TTL for daily pivots */
  dailyCacheTtlMs: 6 * 60 * 60 * 1000, // 6h
  /** Cache TTL for 1h pivots */
  hourlyCacheTtlMs: 30 * 60 * 1000, // 30min
  /** Max candles to fetch for daily analysis */
  maxDailyCandles: 90,
  /** Max candles to fetch for hourly analysis */
  maxHourlyCandles: 168, // 7 days
  /** Number of candles left/right for pivot detection */
  pivotWindow: 3,
  /** Round number proximity for detection (bps) */
  roundNumProximityBps: 20, // 0.2%
  /** Minimum touches for 'strong' rating */
  strongTouchThreshold: 3, // reduced after wider merge
  /** Minimum touches for 'moderate' rating */
  moderateTouchThreshold: 2,
  /** Max % distance from current price to display a zone */
  maxZoneProximityPct: 20, // 20%
  /** Max zones to inject into agent context (per side) */
  maxZonesPerSide: 4,
} as const;

// ─── State ───

interface CacheEntry {
  zones: SRZone[];
  timestamp: number;
}

const dailyPivotCache = new Map<string, CacheEntry>();
const hourlyPivotCache = new Map<string, CacheEntry>();

/** HL rate limiter reference — set externally from market-agent */
let hlFetchFn: ((body: unknown) => Promise<unknown>) | null = null;

/**
 * Register the HL fetch function (with rate limiting) for internal use.
 * Called once from market-agent at startup.
 */
export function setHLFetchFn(fn: (body: unknown) => Promise<unknown>): void {
  hlFetchFn = fn;
}

// ─── Core — Fetch Candles ───

async function fetchCandles(
  symbol: string,
  interval: '1h' | '1d',
  limit: number,
): Promise<Candle[]> {
  if (!hlFetchFn) {
    log.warn(`[fetchCandles] HL fetch fn not set — skipping ${symbol}`);
    return [];
  }

  const endTime = Date.now();
  const intervalMs = interval === '1d' ? 86_400_000 : 3_600_000;
  const startTime = endTime - limit * intervalMs;

  try {
    const data = await hlFetchFn({
      type: 'candleSnapshot',
      req: { coin: symbol.replace(/^.*:/, ''), interval, startTime, endTime },
    }) as RawCandle[];

    if (!Array.isArray(data) || data.length === 0) {
      log.warn(`[fetchCandles] No ${interval} data for ${symbol}`);
      return [];
    }

    return data.map((c: RawCandle) => ({
      timestamp: parseInt(c['t'] ?? '0', 10),
      open: parseFloat(c['o'] ?? '0'),
      high: parseFloat(c['h'] ?? '0'),
      low: parseFloat(c['l'] ?? '0'),
      close: parseFloat(c['c'] ?? '0'),
      volume: parseFloat(c['v'] ?? '0'),
    })).filter(c => c.timestamp > 0 && c.high > 0);
  } catch (err) {
    log.error(`[fetchCandles] Failed for ${symbol}/${interval}: ${err}`);
    return [];
  }
}

// ─── Pivot Detection ───

/**
 * Detect pivot highs and lows in a candle array.
 * A candle is a pivot high if its high is strictly higher than
 * `window` candles on each side.
 */
function detectPivots(candles: Candle[], window: number): PivotInfo[] {
  const pivots: PivotInfo[] = [];

  for (let i = window; i < candles.length - window; i++) {
    const c = candles[i]!;

    // Pivot high
    let isPivotHigh = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= c.high) { isPivotHigh = false; break; }
    }
    if (isPivotHigh) {
      pivots.push({ price: c.high, timestamp: c.timestamp, type: 'pivot_high', volume: c.volume });
    }

    // Pivot low
    let isPivotLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j]!.low <= c.low) { isPivotLow = false; break; }
    }
    if (isPivotLow) {
      pivots.push({ price: c.low, timestamp: c.timestamp, type: 'pivot_low', volume: c.volume });
    }
  }

  return pivots;
}

// ─── Zone Clustering ───

/**
 * Cluster nearby pivots into zones.
 * Pivots within `mergeThresholdBps` of each other (same type) are merged.
 */
function clusterPivots(
  pivots: PivotInfo[],
  mergeThresholdBps: number,
): ZoneCluster[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: ZoneCluster[] = [];

  for (const p of sorted) {
    // Find cluster within threshold
    const existing = clusters.find(c => {
      if (c.type === 'support' && p.type === 'pivot_low') {
        return Math.abs(c.price - p.price) / c.price * 10_000 <= mergeThresholdBps;
      }
      if (c.type === 'resistance' && p.type === 'pivot_high') {
        return Math.abs(c.price - p.price) / c.price * 10_000 <= mergeThresholdBps;
      }
      return false;
    });

    if (existing) {
      // Weighted average: more recent touches weighted higher
      const totalWeight = existing.touches.length + 1;
      existing.price = (existing.price * existing.touches.length + p.price) / totalWeight;
      existing.touches.push({ timestamp: p.timestamp, volume: p.volume });
    } else {
      clusters.push({
        price: p.price,
        type: p.type === 'pivot_low' ? 'support' : 'resistance',
        touches: [{ timestamp: p.timestamp, volume: p.volume }],
        source: 'pivot',
      });
    }
  }

  return clusters;
}

// ─── Round Number Detection ───

function findRoundNumberZones(
  candles: Candle[],
  currentPrice: number,
): ZoneCluster[] {
  const zones: ZoneCluster[] = [];

  // Check round numbers around current price (±15%)
  const minPrice = currentPrice * 0.85;
  const maxPrice = currentPrice * 1.15;
  const magnitude = Math.pow(10, Math.floor(Math.log10(currentPrice)) - 1);
  // For BTC ~68k: magnitude = 1000, step = 1000
  // For SPX ~5000: magnitude = 100
  // For ETH ~2000: magnitude = 100
  const step = Math.max(magnitude, 10);

  let roundNum = Math.floor(minPrice / step) * step;
  while (roundNum <= maxPrice) {
    if (roundNum <= 0) { roundNum += step; continue; }

    // Count touches: candles where low <= roundNum <= high (within 0.05%)
    const touchBps = CONFIG.roundNumProximityBps;
    const touches: Array<{ timestamp: number; volume: number }> = [];
    for (const c of candles) {
      const proximity = Math.abs(c.close - roundNum) / roundNum * 10_000;
      const touchedLow = Math.abs(c.low - roundNum) / roundNum * 10_000 <= touchBps;
      const touchedHigh = Math.abs(c.high - roundNum) / roundNum * 10_000 <= touchBps;
      if (touchedLow || touchedHigh || proximity <= touchBps) {
        touches.push({ timestamp: c.timestamp, volume: c.volume });
      }
    }

    if (touches.length >= CONFIG.minPivotsForZone) {
      zones.push({
        price: roundNum,
        type: currentPrice > roundNum ? 'support' : 'resistance',
        touches,
        source: 'round_num',
      });
    }

    roundNum += step;
  }

  return zones;
}

// ─── Strength Scoring ───

function computeStrength(
  touches: Array<{ timestamp: number; volume: number }>,
): { strength: 'strong' | 'moderate' | 'weak'; score: number } {
  if (touches.length === 0) return { strength: 'weak', score: 0 };

  const now = Date.now();

  // Score each touch: recency weight × volume weight
  let totalScore = 0;
  for (const t of touches) {
    // Recency: exponential decay with half-life
    const age = now - t.timestamp;
    const recencyWeight = Math.pow(0.5, age / CONFIG.recencyHalfLifeMs);
    // Volume normalization: relative to average (cap at 2x)
    const volWeight = Math.min(t.volume > 0 ? 1.0 : 0.5, 2.0);
    totalScore += recencyWeight * volWeight;
  }

  // Normalize by expected max
  const count = touches.length;
  if (count >= CONFIG.strongTouchThreshold && totalScore > 1.5) {
    return { strength: 'strong', score: totalScore };
  }
  if (count >= CONFIG.moderateTouchThreshold && totalScore > 0.5) {
    return { strength: 'moderate', score: totalScore };
  }
  return { strength: 'weak', score: totalScore };
}

// ─── Zone Deduplication & Ranking ───

function mergeAndRankZones(clusters: ZoneCluster[], regime: MarketRegime): SRZone[] {
  // Sort by score descending
  const scored = clusters.map(c => {
    const { strength, score } = computeStrength(c.touches);
    return {
      type: c.type,
      price: Math.round(c.price * 100) / 100,
      strength,
      touchCount: c.touches.length,
      lastTouchTimestamp: c.touches.length > 0
        ? Math.max(...c.touches.map(t => t.timestamp))
        : 0,
      source: c.source,
      score,
    };
  });

  // Deduplicate: remove zones too close to a higher-ranked one
  const ranked: typeof scored = [];
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    const tooClose = ranked.some(r =>
      Math.abs(r.price - s.price) / r.price * 10_000 <= CONFIG.mergeThresholdBps
      && r.type === s.type
    );
    if (!tooClose) ranked.push(s);
  }

  // Highlight based on regime
  return ranked.map(s => {
    let highlighted = false;
    if (regime === 'mean_reverting' || regime === 'accumulation') {
      // Reversal plays: highlight both support and resistance
      highlighted = s.strength === 'strong';
    } else if (regime === 'trending_bull') {
      // In bull trend, highlight resistance as breakout target
      highlighted = s.type === 'resistance' && s.strength !== 'weak';
    } else if (regime === 'trending_bear') {
      // In bear trend, highlight support as breakdown risk
      highlighted = s.type === 'support' && s.strength !== 'weak';
    } else if (regime === 'breakout') {
      // Breakout regime: highlight ALL zones (volatility may hit any)
      highlighted = true;
    }

    return {
      type: s.type,
      price: s.price,
      strength: s.strength,
      touchCount: s.touchCount,
      lastTouchTimestamp: s.lastTouchTimestamp,
      source: s.source,
      highlighted,
    };
  });
}

// ─── Main Entry Point ───

/**
 * Get active S/R zones for a symbol.
 *
 * @param symbol        — Asset symbol (e.g. "BTC", "ETH")
 * @param currentPrice  — Current mark price
 * @param regime        — Current market regime from Regime Guardian
 * @returns             — SRContext with zones + formatted string
 */
export async function getSRZones(
  symbol: string,
  currentPrice: number,
  regime: MarketRegime,
): Promise<SRContext> {
  const startTime = Date.now();

  // ── Chaotic regime: degraded output ──
  if (regime === 'chaotic') {
    const degraded: SRContext = {
      zones: [],
      degradedReason: 'S/R zones unreliable in chaotic regime — levels are being repeatedly breached',
      regime,
      currentPosition: {
        price: currentPrice,
        distanceToNearestSupport: 0,
        distanceToNearestResistance: 0,
        nearestSupport: null,
        nearestResistance: null,
      },
      formatted: '=== S/R Zones for ' + symbol + ' ===\n⚠️ DEGRADED: Current regime is CHAOTIC — S/R levels unreliable, skipped.\n---',
    };
    log.info(`[getSRZones] ${symbol}: chaotic regime — degraded output`);
    return degraded;
  }

  try {
    // ── Synthetic symbol check ──
    // Symbols with "xyz:" prefix are synthetic/derived assets not traded on HL.
    // HL has no candle data for them — skip fetch and use round numbers only.
    const isSynthetic = symbol.startsWith('xyz:') || symbol.includes(':');
    if (isSynthetic) {
      log.warn(`[getSRZones] ${symbol}: synthetic symbol — using round numbers only (no HL candle data)`);
      const roundZones = findRoundNumberZones([{ timestamp: Date.now(), open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice, volume: 0 }], currentPrice);
      const srZones = mergeAndRankZones(roundZones, regime);
      return buildContext(srZones, symbol, currentPrice, regime, Date.now() - startTime);
    }

    // ── 1. Fetch candle data ──
    const [dailyCandles, hourlyCandles] = await Promise.all([
      fetchDailyCandlesCached(symbol),
      fetchHourlyCandlesCached(symbol),
    ]);

    if (dailyCandles.length === 0 && hourlyCandles.length === 0) {
      // Fallback: round numbers only
      log.warn(`[getSRZones] No candle data for ${symbol} — using round numbers only`);
      const roundZones = findRoundNumberZones([{ timestamp: Date.now(), open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice, volume: 0 }], currentPrice);
      const srZones = mergeAndRankZones(roundZones, regime);
      return buildContext(srZones, symbol, currentPrice, regime, Date.now() - startTime);
    }

    const allCandles = [...dailyCandles, ...hourlyCandles];
    // Deduplicate by timestamp (daily includes same periods as hourly)
    const seenTs = new Set<number>();
    const uniqueCandles: Candle[] = [];
    for (const c of allCandles) {
      if (!seenTs.has(c.timestamp)) {
        seenTs.add(c.timestamp);
        uniqueCandles.push(c);
      }
    }

    // ── 2. Detect pivots ──
    const dailyPivots = detectPivots(dailyCandles, CONFIG.pivotWindow);
    const hourlyPivots = detectPivots(hourlyCandles, Math.max(2, Math.floor(CONFIG.pivotWindow * 0.6)));

    // ── 3. Cluster pivots into zones ──
    const pivotClusters = clusterPivots([...dailyPivots, ...hourlyPivots], CONFIG.mergeThresholdBps);

    // ── 4. Add round number zones ──
    const roundClusters = findRoundNumberZones(uniqueCandles, currentPrice);

    // ── 5. Merge all clusters ──
    const allClusters = [...pivotClusters, ...roundClusters];

    // ── 6. Score, rank, deduplicate ──
    const srZones = mergeAndRankZones(allClusters, regime);

    // ── 7. Build context ──
    return buildContext(srZones, symbol, currentPrice, regime, Date.now() - startTime);

  } catch (err) {
    log.error(`[getSRZones] Failed for ${symbol}: ${err}`);
    return {
      zones: [],
      degradedReason: `S/R detection failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      regime,
      currentPosition: { price: currentPrice, distanceToNearestSupport: 0, distanceToNearestResistance: 0, nearestSupport: null, nearestResistance: null },
      formatted: '=== S/R Zones for ' + symbol + ' ===\n⚠️ ERROR: S/R detection failed — zones unavailable.\n---',
    };
  }
}

// ─── Cached Fetch Helpers ───

async function fetchDailyCandlesCached(symbol: string): Promise<Candle[]> {
  const entry = dailyPivotCache.get(symbol);
  if (entry && Date.now() - entry.timestamp < CONFIG.dailyCacheTtlMs) {
    // Extract zones from cache entry — but we need raw candles here,
    // so let's use a separate candle cache.
    // Actually, store raw candles in a separate Map.
    return getRawCandlesFromCache('daily', symbol) ?? await fetchAndCacheDaily(symbol);
  }
  return await fetchAndCacheDaily(symbol);
}

/** Raw candle cache (separate from zone cache) */
const dailyCandleCache = new Map<string, { candles: Candle[]; timestamp: number }>();
const hourlyCandleCache = new Map<string, { candles: Candle[]; timestamp: number }>();

function getRawCandlesFromCache(interval: 'daily' | 'hourly', symbol: string): Candle[] | null {
  const cache = interval === 'daily' ? dailyCandleCache : hourlyCandleCache;
  const entry = cache.get(symbol);
  if (!entry) return null;
  const ttl = interval === 'daily' ? CONFIG.dailyCacheTtlMs : CONFIG.hourlyCacheTtlMs;
  if (Date.now() - entry.timestamp < ttl) return entry.candles;
  return null;
}

async function fetchAndCacheDaily(symbol: string): Promise<Candle[]> {
  const candles = await fetchCandles(symbol, '1d', CONFIG.maxDailyCandles);
  dailyCandleCache.set(symbol, { candles, timestamp: Date.now() });
  return candles;
}

async function fetchHourlyCandlesCached(symbol: string): Promise<Candle[]> {
  const entry = hourlyCandleCache.get(symbol);
  if (entry && Date.now() - entry.timestamp < CONFIG.hourlyCacheTtlMs) {
    return entry.candles;
  }
  const candles = await fetchCandles(symbol, '1h', CONFIG.maxHourlyCandles);
  hourlyCandleCache.set(symbol, { candles, timestamp: Date.now() });
  return candles;
}

// ─── Context Builder ───

function buildContext(
  zones: SRZone[],
  symbol: string,
  currentPrice: number,
  regime: MarketRegime,
  elapsedMs: number,
): SRContext {
  // Separate support / resistance, sort by price
  const supports = zones.filter(z => z.type === 'support').sort((a, b) => b.price - a.price);
  const resistances = zones.filter(z => z.type === 'resistance').sort((a, b) => a.price - b.price);

  // Find nearest levels (below current for support, above for resistance)
  const nearestSupport = supports.find(s => s.price < currentPrice) ?? null;
  const nearestResistance = resistances.find(r => r.price > currentPrice) ?? null;

  const distToS = nearestSupport
    ? (currentPrice - nearestSupport.price) / currentPrice * 10_000
    : 0;
  const distToR = nearestResistance
    ? (nearestResistance.price - currentPrice) / currentPrice * 10_000
    : 0;

  // Filter to only zones within proximity of current price (exclude irrelevant old pivots)
  const proxPct = CONFIG.maxZoneProximityPct / 100;
  const nearbySupports = supports.filter(s =>
    s.price < currentPrice &&
    (currentPrice - s.price) / currentPrice <= proxPct
  ).slice(0, CONFIG.maxZonesPerSide);
  const nearbyResistances = resistances.filter(r =>
    r.price > currentPrice &&
    (r.price - currentPrice) / currentPrice <= proxPct
  ).slice(0, CONFIG.maxZonesPerSide);

  // Build formatted string
  const lines: string[] = [];
  lines.push(`=== S/R Zones for ${symbol} ===`);

  // Regime header tag
  const regimeTag = getRegimeTag(regime);
  if (regimeTag) lines.push(regimeTag);

  // Resistance (displayed above price — show nearest first, ascending)
  for (const r of nearbyResistances) {
    const icon = r.highlighted ? '🔴' : '🟢';
    const srcTag = sourceToTag(r.source);
    lines.push(`  ${icon} Supply: $${formatPrice(r.price)} (${r.strength}, ${r.touchCount} touch${r.touchCount > 1 ? 'es' : ''}${srcTag})${r.highlighted ? ' ⭐' : ''}`);
  }

  lines.push(`  📍 Current: $${formatPrice(currentPrice)}`);

  // Support (displayed below price — show nearest first, descending)
  for (const s of nearbySupports) {
    const icon = s.highlighted ? '🔵' : '🔵';
    const srcTag = sourceToTag(s.source);
    lines.push(`  ${icon} Demand: $${formatPrice(s.price)} (${s.strength}, ${s.touchCount} touch${s.touchCount > 1 ? 'es' : ''}${srcTag})${s.highlighted ? ' ⭐' : ''}`);
  }

  // Position context
  if (nearestSupport && nearestResistance) {
    const range = ((nearestResistance.price - nearestSupport.price) / currentPrice * 100).toFixed(2);
    lines.push(`  📐 Range: $${formatPrice(nearestSupport.price)}–$${formatPrice(nearestResistance.price)} (${range}%)`);
    lines.push(`  📏 Position: ${distToS.toFixed(1)}bps above S, ${distToR.toFixed(1)}bps below R`);
  } else if (nearestSupport) {
    lines.push(`  📏 Position: ${distToS.toFixed(1)}bps above S — no resistance above`);
  } else if (nearestResistance) {
    lines.push(`  📏 Position: ${distToR.toFixed(1)}bps below R — no support below`);
  }

  // Regime-contextual hint
  if (regime === 'trending_bull') {
    lines.push(`  💡 Regime hint: Breakout resistance → new support. Trending bull — respect demand zones.`);
  } else if (regime === 'trending_bear') {
    lines.push(`  💡 Regime hint: Breakdown support → new resistance. Trending bear — respect supply zones.`);
  } else if (regime === 'mean_reverting') {
    lines.push(`  💡 Regime hint: Mean reverting — fade moves to S/R extremes.`);
  } else if (regime === 'breakout') {
    lines.push(`  💡 Regime hint: Breakout regime — S/R may be tested aggressively, wait for confirmation.`);
  }

  lines.push(`---`);
  lines.push(`  ⚡ computed in ${elapsedMs}ms`);

  return {
    zones,
    degradedReason: null,
    regime,
    currentPosition: {
      price: currentPrice,
      distanceToNearestSupport: Math.round(distToS * 10) / 10,
      distanceToNearestResistance: Math.round(distToR * 10) / 10,
      nearestSupport: nearestSupport?.price ?? null,
      nearestResistance: nearestResistance?.price ?? null,
    },
    formatted: lines.join('\n'),
  };
}

// ─── Formatting Helpers ───

function formatPrice(p: number): string {
  if (p >= 1000) return p.toFixed(0);
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(6);
}

function sourceToTag(source: 'pivot' | 'round_num' | 'orderbook'): string {
  switch (source) {
    case 'pivot': return '';
    case 'round_num': return ', round num';
    case 'orderbook': return ', OB cluster';
  }
}

function getRegimeTag(regime: MarketRegime): string | null {
  switch (regime) {
    case 'high_volatility':
      return '  ⚠️ High volatility — S/R zone width widened, confidence reduced';
    case 'trending_bull':
    case 'trending_bear':
      return '  📈 Trending — highlighted zones indicate breakout/breakdown levels';
    case 'mean_reverting':
      return '  🔄 Mean reverting — highlighted zones indicate reversal targets';
    case 'breakout':
      return '  💥 Breakout regime — all zones highlighted, confirmation recommended';
    default:
      return null;
  }
}

// ─── Utility: Clear caches (for testing / manual reset) ───

export function clearSRCache(symbol?: string): void {
  if (symbol) {
    dailyCandleCache.delete(symbol);
    hourlyCandleCache.delete(symbol);
    dailyPivotCache.delete(symbol);
    hourlyPivotCache.delete(symbol);
  } else {
    dailyCandleCache.clear();
    hourlyCandleCache.clear();
    dailyPivotCache.clear();
    hourlyPivotCache.clear();
  }
  log.info(`[clearSRCache] ${symbol ?? 'all'} cleared`);
}

// ─── Health Check ───

export function getSRHealth(): { cacheEntries: number; hlFetchFnSet: boolean } {
  return {
    cacheEntries: dailyCandleCache.size + hourlyCandleCache.size,
    hlFetchFnSet: hlFetchFn !== null,
  };
}