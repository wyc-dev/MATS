// Capture the full error object from fetch failures
const start = Date.now();
let ok = 0, fail = 0;
const errors = {};
const fire = () => {
  fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  }).then(r => { if (r.ok) ok++; else { fail++; } })
    .catch(e => {
      fail++;
      const key = e.cause?.code || e.cause?.message || e.message || 'unknown';
      errors[key] = (errors[key] || 0) + 1;
      if (fail === 1) {
        console.log('First error full object:', JSON.stringify({
          message: e.message,
          cause: e.cause ? { code: e.cause.code, message: e.cause.message, errno: e.cause.errno, syscall: e.cause.syscall } : null,
        }, null, 2));
      }
    });
};
for (let i = 0; i < 100; i++) fire();
const iv = setInterval(() => { for (let i = 0; i < 10; i++) fire(); }, 500);
setTimeout(() => {
  clearInterval(iv);
  console.log('30s test: ok=' + ok + ' fail=' + fail + ' @ ' + (Date.now() - start) + 'ms');
  console.log('errors:', JSON.stringify(errors, null, 2));
}, 30000);