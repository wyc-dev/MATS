#!/usr/bin/env tsx
// ─── MFE-Calibrator Rate-Limit Probe (v2.0.852) ───────────────────────────
// Tests whether fetching 100×1h + 100×5m candles per asset for the MFE
// calibrator (Task B) hits Hyperliquid rate limits when run 3 consecutive
// times across 5 assets — i.e. the worst-case cadence a live cycle could
// produce.
//
// Design:
//   - Uses MarketAgent.hlFetch (the SAME rate-limited path the MFE calibrator
//     will use) so the probe measures realistic queuing + 429 behaviour.
//   - 5 representative assets × 2 intervals (1h, 5m) = 10 requests per pass,
//     × 3 passes = 30 requests total, with a short pause between passes to
//     mimic a live decision cycle.
//   - Logs per-request latency and whether any request hit 429 or retried.
//   - Prints a verdict: PASS if zero 429s / zero hard failures, WARN if the
//     global limiter had to throttle heavily (high latency), FAIL otherwise.
//
// Usage:
//   npx tsx scripts/probe-mfe-rate-limit.ts

import { MarketAgent } from '../src/market-agent/index.ts';

// v2.0.852: Assets representative of the live portfolio (DEX-0 majors + DEX-1-8).
const SYMBOLS = ['btc', 'eth', 'SOL', 'xyz:SKHX', 'xyz:SILVER'];
const INTERVALS: Array<{ interval: string; count: number }> = [
  { interval: '1h', count: 100 },
  { interval: '5m', count: 100 },
];
const PASSES = 3;
const PASS_GAP_MS = 5_000; // ~ one live cycle gap

interface ProbeResult {
  asset: string;
  interval: string;
  candles: number;
  elapsedMs: number;
  status: number;
  retried: boolean;
}

async function fetchCandles(symbol: string, interval: string, count: number): Promise<ProbeResult> {
  const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
  const endTime = Date.now();
  const startTime = endTime - count * (interval === '1h' ? 3_600_000 : 300_000);
  const start = Date.now();
  let status = 200;
  let retried = false;
  let candles = 0;
  try {
    const data = await MarketAgent.hlFetch({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    }) as Array<{ t?: number; h?: string; l?: string; c?: string }> | null;
    candles = Array.isArray(data) ? data.length : 0;
  } catch (err) {
    status = err instanceof Error && /429/.test(err.message) ? 429 : 500;
    retried = /retry/i.test(err instanceof Error ? err.message : '');
  }
  return { asset: symbol, interval, candles, elapsedMs: Date.now() - start, status, retried };
}

async function main(): Promise<void> {
  console.log(`MFE Rate-Limit Probe: ${SYMBOLS.length} assets × ${INTERVALS.length} intervals × ${PASSES} passes`);
  console.log(`Total requests: ${SYMBOLS.length * INTERVALS.length * PASSES}`);
  console.log(`Pass gap: ${PASS_GAP_MS}ms | Interval per asset: ${INTERVALS.map(i => `${i.count}×${i.interval}`).join(' + ')}\n`);

  const allResults: ProbeResult[] = [];
  for (let pass = 1; pass <= PASSES; pass++) {
    if (pass > 1) {
      console.log(`\n--- waiting ${PASS_GAP_MS}ms before pass ${pass} (simulated cycle gap) ---`);
      await new Promise(r => setTimeout(r, PASS_GAP_MS));
    }
    console.log(`\n=== Pass ${pass}/${PASSES} ===`);
    for (const symbol of SYMBOLS) {
      for (const { interval, count } of INTERVALS) {
        const r = await fetchCandles(symbol, interval, count);
        allResults.push(r);
        const flag = r.status !== 200 ? ` ❌ HTTP ${r.status}${r.retried ? ' (retried)' : ''}` : (r.candles === 0 ? ' ⚠️ 0 candles' : '');
        console.log(`  ${r.asset.padEnd(10)} ${interval.padEnd(3)} ${String(r.candles).padStart(3)} candles  ${r.elapsedMs}ms${flag}`);
      }
    }
  }

  // Verdict
  const total = allResults.length;
  const hardFails = allResults.filter(r => r.status === 429 || r.status === 500);
  const zeroCandles = allResults.filter(r => r.candles === 0);
  const maxLatency = Math.max(...allResults.map(r => r.elapsedMs));
  const avgLatency = allResults.reduce((s, r) => s + r.elapsedMs, 0) / Math.max(1, total);
  const totalCandles = allResults.reduce((s, r) => s + r.candles, 0);

  console.log('\n══════════════════════════════════════════');
  console.log('Rate-Limit Probe Summary');
  console.log('══════════════════════════════════════════');
  console.log(`Requests issued     : ${total}`);
  console.log(`429/500 failures    : ${hardFails.length}`);
  console.log(`Zero-candle returns : ${zeroCandles.length}`);
  console.log(`Total candles       : ${totalCandles}`);
  console.log(`Avg latency/request : ${avgLatency.toFixed(0)}ms`);
  console.log(`Max latency/request : ${maxLatency}ms`);

  if (hardFails.length === 0 && zeroCandles.length === 0) {
    console.log('\n✅ PASS — no 429s, no empty returns. MFE calibrator fetch is safe at this cadence.');
  } else if (hardFails.length === 0) {
    console.log(`\n⚠️ WARN — no hard failures but ${zeroCandles.length} empty returns (rate limiter may be shaping responses).`);
  } else {
    console.log(`\n❌ FAIL — ${hardFails.length} hard failures. MFE calibrator MUST cache + reduce request rate.`);
  }
}

main().catch(err => {
  console.error('Probe crashed:', err);
  process.exit(1);
});
