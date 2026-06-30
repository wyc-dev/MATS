// Stress test: fire many concurrent + sustained fetch calls to HL API
// to reproduce the "fetch failed" errors seen in production logs.
const start = Date.now();
let ok = 0, fail = 0;
const errors = new Set();
const fire = (i) => {
  fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  }).then(r => { if (r.ok) ok++; else { fail++; errors.add('HTTP ' + r.status); } })
    .catch(e => { fail++; errors.add(e.message); })
    .finally(() => {
      if (i % 5 === 0) console.log(`@${Date.now() - start}ms: ok=${ok} fail=${fail} errs=[${[...errors].join(', ')}]`);
    });
};
// Fire 20 immediately, then 5 every 1s for 10s
for (let i = 0; i < 20; i++) fire(i);
let i = 20;
const iv = setInterval(() => { for (let j = 0; j < 5; j++) fire(i++); }, 1000);
setTimeout(() => {
  clearInterval(iv);
  console.log(`FINAL @${Date.now() - start}ms: ok=${ok} fail=${fail} errs=[${[...errors].join(', ')}]`);
}, 10000);