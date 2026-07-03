import { MarketAgent } from '../src/market-agent/index.ts';

async function main() {
  const agent = new MarketAgent();
  MarketAgent.registerSRModule();

  const symbols = ['BTC', 'xyz:SKHX', 'xyz:SILVER'];

  for (const sym of symbols) {
    console.log(`\nTesting fetchPriceForSymbol(${sym})...`);
    try {
      const result = await agent.fetchPriceForSymbol(sym);
      console.log(`  OK price=${result.price} volume24h=${result.volume24h} change24h=${result.change24h}`);
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n--- Direct l2Book test ---');
  for (const sym of symbols) {
    if (!sym.includes(':')) continue;
    console.log(`\nTesting l2Book for ${sym}...`);
    try {
      const res = await MarketAgent['hlFetch']({ type: 'l2Book', coin: sym });
      console.log(`  Response status: ${res.status} ${res.statusText}`);
      if (res.ok) {
        const data = await res.json();
        console.log(`  Response keys: ${Object.keys(data).join(', ')}`);
        if (data.levels) {
          console.log(`  levels.length: ${data.levels.length}`);
          if (data.levels[0] && data.levels[0][0]) {
            console.log(`  best bid: ${JSON.stringify(data.levels[0][0])}`);
          }
          if (data.levels[1] && data.levels[1][0]) {
            console.log(`  best ask: ${JSON.stringify(data.levels[1][0])}`);
          }
        }
      } else {
        const text = await res.text();
        console.log(`  Error body: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(0);
}

main().catch(console.error);
