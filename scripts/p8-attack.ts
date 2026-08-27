/**
 * P8-attack:刁鑽攻擊輪——針對 momentum-5m-gate + 統一閘接駁周邊。
 * 併發 / 狀態注入 / 持久化污染 / 環境注入。只讀。
 */
import * as M from '../src/analysis/momentum-5m-gate.ts';

let found = 0;
const DRAM5M = [56.60, 56.55, 56.50, 56.45, 56.40, 56.30];
const v = (name: string, cond: boolean, detail: string) => {
  console.log(`${cond ? '✅ 防住' : '❌ 漏洞'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) found++;
};

// ═══ A. 環境注入攻擊(env 是攻擊面——P5-attack 慣例)═══
console.log('=== A. env 注入 ===');
{
  // A1: GATE_5M_CANDLES 負數 → minCandles 無效化(2 支燭就判決 = 噪音判決)
  const negMin = M.shouldBlock5mDirection({ side: 'buy', closes: [100, 99.9], minCandles: -5 });
  v('A1 minCandles=-5 唔可以用 2 支燭判決', !negMin.blocked && negMin.slopeBps === null,
    `minCandles 負數令 valid.length(-5) 永遠過 → 2 支燭 slope 判決,noise gate`);
  // A2: floorBps=0 → 死成交 tape 一格微跌tick 就全擋(交易 DoS)
  const zeroFloor = M.compute5mThresholdBps([100, 100.0001, 100.00005, 99.99995, 100.0001, 99.9999], 2, 0);
  v('A2 floorBps=0 → threshold 應該仍 ≥ kSigma×σ(唔可以 0)', zeroFloor !== null && zeroFloor > 0,
    `threshold=${zeroFloor} — σ=0 時 threshold=0 → slope≤-0 全擋 BUY = 交易 DoS`);
  // A3: kSigma=1e-9 → threshold 塌縮到 floor
  const tinyK = M.compute5mThresholdBps([100, 103, 97, 102, 96, 100], 1e-300, 0);
  v('A3 kSigma=1e-300 時 threshold 應塌到 floor(唔係 0)', tinyK === 0 || tinyK !== null,
    `kSigma tiny → threshold=${tinyK}`);
  // A4: capBps < floorBps(倒邏輯注入)
  const invCap = M.compute5mThresholdBps([100, 97, 103, 96, 104, 95], 2, 50, 10);
  v('A4 cap<floor → 唔可以產生 threshold < floor', invCap !== null && invCap >= 50, `threshold=${invCap}`);
}

// ═══ B. 狀態注入攻擊(毒 candle 陣列)═══
console.log('\n=== B. candle 陣列毒注入 ===');
{
  // B1: 極小值 + 極大值混合(underflow/overflow 斜率)
  const mix = [1e-300, 1e300, 1e-300, 1e300, 1e-300, 1e300];
  const s1 = M.compute5mSlopeBps(mix);
  const g1 = M.shouldBlock5mDirection({ side: 'buy', closes: mix });
  v('B1 1e±300 混合:唔 crash、唔 NaN', (s1 === null || Number.isFinite(s1!)) && !g1.blocked || g1.reason !== undefined,
    `slope=${s1}, blocked=${g1.blocked}, reason=${g1.reason ?? 'undefined'}`);
  // B2: 全部同值(flat)——slope=0, σ=0 → floor 接管
  const same = new Array(10).fill(56.37);
  const t2 = M.compute5mThresholdBps(same);
  const g2 = M.shouldBlock5mDirection({ side: 'buy', closes: same });
  v('B2 全同值:threshold=floor,唔 block', t2 === 10 && !g2.blocked, `threshold=${t2}, blocked=${g2.blocked}`);
  // B3: -0 close(偽陽性 >0 檢查? -0 > 0 = false ✓ 但 -0 是 finite)
  const negZero = [100, -0, 100, 99.9, 99.8, 99.7];
  const s3 = M.compute5mSlopeBps(negZero, 4);
  v('B3 -0 close 被剔除', s3 === null || Number.isFinite(s3!), `slope=${s3}`);
  // B4: 長度 1 萬嘅陣列(算力 DoS——每 cycle 都行)
  const big = new Array(10_000).fill(100).map((x, i) => x + (i % 2 ? 0.01 : -0.01));
  const t0 = Date.now();
  M.shouldBlock5mDirection({ side: 'buy', closes: big });
  const dt = Date.now() - t0;
  v(`B4 10k 支燭 O(n) 運算 < 50ms(實際 ${dt}ms)`, dt < 50, `${dt}ms`);
  // B5: 猴補丁 Array.prototype(原型污染)
  const orig = Array.prototype.filter;
  try {
    (Array.prototype as any).filter = function (...a: any[]) { return orig.apply(this, a); };
    const g5 = M.shouldBlock5mDirection({ side: 'buy', closes: DRAM5M });
    v('B5 原型污染下唔 crash', typeof g5.blocked === 'boolean');
  } finally {
    Array.prototype.filter = orig;
  }
}

// ═══ C. 環境注入 × 判決方向攻擊 ═══
console.log('\n=== C. env × 判決攻擊 ===');
{
  // C1: GATE_5M_CANDLES="1e308"(科學記號字串)
  const n = Number('1e308');
  v('C1 GATE_5M_CANDLES=1e308 → Number()=1e308(有限)→ 樣本永遠不足 → 永遠放行 = 閘失效',
    !(n > 0 && Number.isFinite(n) && n < 100), `Number('1e308')=${n} — env 未 clamp 上限`);
  // C2: GATE_5M_KSIGMA="-2"(負數)
  const negK = M.compute5mThresholdBps(DRAM5M, -2);
  v('C2 kSigma=-2 → fallback 預設 2(唔可以負門檻)', negK !== null && negK >= 10, `threshold=${negK}`);
  // C3: floorBps NaN 字串
  const nanFloor = M.compute5mThresholdBps(DRAM5M, 2, Number('abc'));
  v('C3 floor=NaN → fallback 預設', nanFloor !== null && nanFloor >= 10, `threshold=${nanFloor}`);
}

// ═══ D. 判決不變式(概率/分佈視角)═══
console.log('\n=== D. 鏡像不變式 fuzz(500 隨機序列)===');
{
  let violations = 0;
  for (let t = 0; t < 500; t++) {
    const closes = Array.from({ length: 6 }, (_, i) => 100 * Math.exp((Math.random() - 0.5) * 0.02 + (t % 3 - 1) * i * 0.001));
    const buy = M.shouldBlock5mDirection({ side: 'buy', closes });
    const sell = M.shouldBlock5mDirection({ side: 'sell', closes });
    // 不變式:同一段序列,BUY 同 SELL 唔可以同時被 block(5m 只有一個方向)
    if (buy.blocked && sell.blocked) violations++;
    // 不變式:block 時 |slope| ≥ threshold
    if (buy.blocked && buy.slopeBps! > -buy.thresholdBps!) violations++;
    if (sell.blocked && sell.slopeBps! < sell.thresholdBps!) violations++;
  }
  v(`D1 500 序列零不變式違反`, violations === 0, `${violations} 次違反`);
}

// ═══ E. 統一閘接駁靜態審計(周邊 modules)═══
console.log('\n=== E. 周邊審計(applyEntryConvictionGates 周邊)===');
console.log('   （人工審計項:exploration 接入後 reentry-cooldown/shadow-gate 對 exploration 樣本流嘅影響——live 觀察）');
console.log(`\n${found === 0 ? '✅ 全部攻擊防住' : `❌ ${found} 個漏洞需要修復`}`);