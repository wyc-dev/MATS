// 測試:並行攞多個 asset 嘅 5m candle——check 係咪成功
import { candleCache } from '/Users/y.c./Downloads/mats_backend/src/data/candle-cache.ts';

async function main(): Promise<void> {
  const symbols = ['btc', 'eth', 'silver', 'skhx', 'gold', 'sp500'];
  console.log('══════════════════════════════════════════════════════');
  console.log('並行攞 5m candle 測試(6 個 asset)');
  console.log('══════════════════════════════════════════════════════');
  const start = Date.now();
  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      const cc = await candleCache.getCandles(sym, '5m', 50);
      return { sym, ok: !!cc && cc.length > 0, n: cc?.length ?? 0, first: cc?.[0], last: cc?.[cc.length - 1] };
    } catch (e) {
      return { sym, ok: false, n: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }));
  const elapsed = Date.now() - start;
  console.log(`總時間: ${elapsed}ms`);
  console.log('');
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✅ ${r.sym.padEnd(8)} n=${r.n} 最近:${r.last ? `${r.last.c.toFixed(2)} @ ${new Date(r.last.t).toLocaleTimeString()}` : '?'}`);
    } else {
      console.log(`  ❌ ${r.sym.padEnd(8)} 失敗: ${(r as any).error ?? 'no data'}`);
    }
  }
  console.log('');
  const okCount = results.filter(r => r.ok).length;
  console.log(`成功: ${okCount}/${symbols.length}`);
  if (okCount === symbols.length) {
    console.log('✅ 並行攞 candle 成功——全部 asset 攞到');
  } else {
    console.log(`⚠️ ${symbols.length - okCount} 個失敗——check 原因`);
  }
}

main();
