// ─── Close-Trend Sentinel (Fractal Momentum Sentinel 風格) ─────────────────
// v2.0.870-FIX(主神指示 2026-08-23): 每次共識 TP/SL 之前,LLM 根據現時 candles
// 緩存 chart 判斷「close 之後價格會唔會反轉走勢」——判定趨勢是否大機會持續,
// 從而決定是否止蝕/鎖利。
//
// 主神原話:「每次共識 TP/SL 之前, 我都希望 LLM 根據現時的 candles 緩存 chart
// 判斷一下 TP/SL 之後是否大機會反轉走勢,just like Fractal Momentum Sentinel
// 上載蠟燭圖讓LLM判斷 regime,但這次是判定趨勢是否大機會將會持續,從而決定
// 是否止蝕」
//
// 主神第二輪指示(2026-08-23)——規定判定格式:
//   「話俾個LLM知而家你個position係 BUY/SELL,然後問佢嚟緊順向嘅機會是否大,
//   如果LLM認為只是暫時回撤就會出 HOLD,如果認為短期內已經轉趨勢就出 CLOSE,
//   咁就可以做共識 SL/TP」
//
// 語義(主神規定):
//   HOLD  = 順向機會大(暫時回撤)——close 係錯(止蝕斬喺反彈前 / 鎖利鎖太早)
//           → 唔 close(pending-close 確認機制, 3 cycle 超時兜底——唔死揸)
//   CLOSE = 短期內已轉趨勢(順向機會細)→ 照 consensus close
//   UNCERTAIN = 判斷唔到 → 照 consensus close(安全 fallback——止蝕永遠唔可以
//               被 LLM 掛住,資本保存第一)
//
// 設計原則:
//   1. 純函數可測: buildCandleBarChart / buildCloseTrendPrompt / parseCloseTrendVerdict
//   2. LLM 失敗/超時/垃圾輸出 → uncertain(唔 block close)
//   3. 毒輸入 sanitize: candles 垃圾/NaN → 中性;confidence clamp [0,1]
//   4. 唔會出現「hold 死」: call site 用 pending-close 機制(下 cycle 再 close)
//   5. env CLOSE_TREND_SENTINEL=false 即刻關閉

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'close-trend-sentinel' });

export const CLOSE_TREND_SENTINEL_ENABLED = (process.env['CLOSE_TREND_SENTINEL'] ?? 'true') !== 'false';

export interface CandleLike {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

export interface CloseTrendInput {
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  currentPrice: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  unrealizedPnlPct: number;
  closeReason: string;
  /** candle 組——interval → candles(已排序舊→新) */
  candles: Array<{ interval: string; candles: CandleLike[] }>;
}

export type CloseTrendVerdict = 'hold' | 'close' | 'uncertain';

export interface CloseTrendResult {
  verdict: CloseTrendVerdict;
  /** 0-1——verdict 嘅信心 */
  confidence: number;
  rationale: string;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** v2.0.870-FIX-A(攻擊輪): candle t 合理範圍——2000-01-01 至 2100-01-01。
 *  MATS 即時運行,t 一定喺「而家」附近;t=1e308（finite 且 >0）會通過舊檢查
 *  但 new Date(1e308).toISOString() 直接 RangeError crash——CRITICAL。 */
const TS_MIN = Date.UTC(2000, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);

/** v2.0.870-FIX-C(攻擊輪): sanitizeText——防 prompt injection。
 *  symbol/closeReason/interval 係外部輸入（tradingMarkets / LLM rationale），
 *  可以內嵌 \n\nIgnore all previous instructions 等注入指令。
 *  移除 control chars（\x00-\x1f\x7f）+ 摺疊空白 + 長度 cap。 */
/** v2.0.870-FIX-C(攻擊輪): sanitizeSymbol——symbol 名專用白名單。
 *  資產名只可以有 [A-Za-z0-9:._-]（BTC / xyz:SILVER 等）——任何其他字符
 *  （空格/標點/換行）直接移除——「Ignore all previous instructions」呢類
 *  注入文字會碎成無意義字串,徹底封死 prompt injection。 */
export function sanitizeSymbol(s: unknown, maxLen = 32): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[^A-Za-z0-9:._\-]/g, '').slice(0, maxLen);
}

export function sanitizeText(s: unknown, maxLen = 60): string {
  if (typeof s !== 'string') return '';
  return s
    // 字面 escape 序列（\\n \\r \\t）——防「backslash-n 注入」
    .replace(/\\[nrt]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** 毒輸入 sanitize——垃圾 candle 唔可以 crash / 污染 prompt */
function sanitizeCandles(candles: CandleLike[] | null | undefined): CandleLike[] {
  if (!Array.isArray(candles)) return [];
  const out: CandleLike[] = [];
  for (const c of candles) {
    if (!c || typeof c !== 'object') continue;
    const { o, h, l, c: close, v, t } = c as CandleLike;
    // FIX-A: t 必須喺 2000-2100 範圍（1e308/NaN/負數/未來極端值 → drop）
    if (![o, h, l, close, v].every(n => Number.isFinite(n) && n > 0)) continue;
    const tNum = Number(t);
    if (!Number.isFinite(tNum) || tNum < TS_MIN || tNum > TS_MAX) continue;
    out.push({ t: tNum, o: Number(o), h: Number(h), l: Number(l), c: Number(close), v: Number(v) });
  }
  return out;
}

/**
 * 純函數: 將 OHLCV candles 轉 ASCII block bar chart(close 價高度,最近 maxBars 支)。
 * 高/低範圍用 ▼▲ 標記;每組配 min/max 標籤 + 最近 3 支 close。
 */
export function buildCandleBarChart(candlesIn: CandleLike[] | null | undefined, label: string, maxBars = 28): string {
  const candles = sanitizeCandles(candlesIn);
  if (candles.length < 2) return `${label}: 數據不足 (${candles.length})`;
  const recent = candles.slice(-maxBars);
  const closes = recent.map(c => c.c);
  const highs = recent.map(c => c.h);
  const lows = recent.map(c => c.l);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return `${label}: 價格範圍無效`;

  const bar = closes.map(c => {
    const idx = Math.min(BLOCKS.length - 1, Math.floor(((c - min) / span) * (BLOCKS.length - 1)));
    return BLOCKS[idx] ?? '▄';
  }).join('');

  const last3 = closes.slice(-3).map(c => c.toFixed(2)).join(' → ');
  const chg8 = closes.length > 8
    ? (((closes[closes.length - 1]! - closes[closes.length - 9]!) / closes[closes.length - 9]!) * 100).toFixed(2)
    : 'n/a';
  const chg24 = closes.length > 1
    ? (((closes[closes.length - 1]! - closes[0]!) / closes[0]!) * 100).toFixed(2)
    : 'n/a';
  return `${label} (${recent.length}支 | 8支變化 ${chg8}% | 全窗 ${chg24}%):
  range: $${min.toFixed(2)} ~ $${max.toFixed(2)}
  ▏${bar}▕
  close: ${last3}`;
}

/**
 * 純函數: 將 candles 轉結構化 OHLCV 表格文字(最近 maxRows 支,舊→新)。
 * 主神指示(2026-08-23):俾最近 24 cycle 嘅 OHLCV 數據俾 LLM 判斷——
 * 結構化數值係主體,ASCII 象形圖只係輔助。每行:時間/開/高/低/收/量。
 */
export function buildOhlcvTable(candlesIn: CandleLike[] | null | undefined, label: string, maxRows = 24): string {
  const candles = sanitizeCandles(candlesIn);
  if (candles.length === 0) return `${label}: 無數據`;
  const recent = candles.slice(-maxRows);
  const rows = recent.map((c, i) => {
    // FIX-A: safe date——t 已經過 sanitize 範圍驗證,但防禦式再 check（唔 crash）
    const tNum = Number(c.t);
    const tStr = Number.isFinite(tNum) && tNum >= TS_MIN && tNum <= TS_MAX
      ? new Date(tNum).toISOString().slice(5, 16).replace('T', ' ')
      : `ts=${tNum}`;
    return `  ${String(i + 1).padStart(2)} | ${tStr} | O=${c.o.toFixed(2)} H=${c.h.toFixed(2)} L=${c.l.toFixed(2)} C=${c.c.toFixed(2)} V=${Math.round(c.v)}`;
  }).join('\n');
  const chg = candles.length > 1
    ? (((candles[candles.length - 1]!.c - candles[0]!.c) / candles[0]!.c) * 100).toFixed(2)
    : 'n/a';
  return `${label} OHLCV (最近 ${recent.length} 支, 全窗變化 ${chg}%):\n${rows}`;
}

/** 純函數: 構建 LLM prompt */
export function buildCloseTrendPrompt(input: CloseTrendInput): { system: string; user: string } {
  const side = input.side === 'buy' ? 'BUY (long)' : 'SELL (short)';
  const slTxt = input.stopLossPrice !== undefined && Number.isFinite(input.stopLossPrice)
    ? `$${input.stopLossPrice!.toFixed(2)}` : 'N/A';
  const tpTxt = input.takeProfitPrice !== undefined && Number.isFinite(input.takeProfitPrice)
    ? `$${input.takeProfitPrice!.toFixed(2)}` : 'N/A';
  const pnlTxt = Number.isFinite(input.unrealizedPnlPct) ? `${(input.unrealizedPnlPct * 100).toFixed(1)}%` : 'N/A';
  const safeSymbol = sanitizeSymbol(input.symbol) || 'UNKNOWN';
  const safeReason = sanitizeText(input.closeReason, 60);

  // FIX-B(攻擊輪): cap intervals——最多 4 組（5m/15m/1h/4h 合理上限）——
  // 1000 組會令 prompt 無限膨脹（算力 DoS）
  const MAX_INTERVALS = 4;
  const candlesGroup = (Array.isArray(input.candles) ? input.candles : []).slice(0, MAX_INTERVALS);

  const chartBlocks = candlesGroup
    .map(g => buildCandleBarChart(g.candles, `${safeSymbol} ${sanitizeText(g.interval, 8)}`, 28))
    .join('\n\n');
  // 主神指示(2026-08-23): 結構化 OHLCV 數據係主體——最近 24 cycle 嘅 O/H/L/C/V,
  // LLM 用數值判斷趨勢持續性。ASCII chart 只係輔助視覺。
  const ohlcvBlocks = candlesGroup
    .map(g => buildOhlcvTable(g.candles, `${safeSymbol} ${sanitizeText(g.interval, 8)}`, 24))
    .join('\n\n');

  const system = `你係 Fractal Momentum Sentinel——趨勢持續性判斷器。
你嘅任務:判斷一個持倉 close 決策執行之後,價格未來 1-4 小時大概率會點行。
你只判斷「趨勢是否大機會持續」,唔判斷「應唔應該交易」。

你嘅持倉方向:BUY(長倉)或者 SELL(短倉)。「順向」= 價格向持倉方向移動
(BUY 倉嘅順向係上升;SELL 倉嘅順向係下跌)。

規則:
1. 分析提供嘅 candlestick OHLCV 數據(最近 24 支,由舊到新)+ ASCII 視覺圖
   (5m/15m/1h/4h——短時間框架反映即時動量,長時間框架反映結構趨勢)。
2. 回答核心問題:「嚟緊(未來 1-4 小時)順向嘅機會是否大?」
   - 順向機會大(而家只係暫時回撤/回調,趨勢未變)→ verdict = "hold"
     (唔應該 close——止蝕斬喺反彈前 / 鎖利鎖太早)
   - 短期內已經轉趨勢(順向機會細,價格大概率逆持倉方向走)→ verdict = "close"
     (close 啱——及早止蝕 / 鎖住利潤)
   - 訊號矛盾/不明確/蠟燭數據不足 → verdict = "uncertain"
3. 輸出嚴格 JSON,唔好加任何其他文字:
{"verdict":"hold|close|uncertain","confidence":0.0,"rationale":"一句中文理由(≤80字)"}
   confidence 係你對 verdict 嘅信心(0-1)。verdict 必須係三個值之一。`;

  const user = `持倉方向: ${side} ${safeSymbol}
入場價: $${Number.isFinite(input.entryPrice) ? input.entryPrice!.toFixed(2) : 'N/A'}
現價: $${Number.isFinite(input.currentPrice) ? input.currentPrice!.toFixed(2) : 'N/A'}
止蝕價: ${slTxt} | 止盈價: ${tpTxt}
未實現盈虧: ${pnlTxt}
close 理由: ${safeReason || 'consensus'}

現時 candles 數據(結構化 OHLCV——最近 24 支,由舊到新):
${ohlcvBlocks}

現時 candles 視覺圖(輔助):
${chartBlocks}

問題: 持倉係 ${side}。嚟緊(未來 1-4 小時)順向(價格向持倉方向)嘅機會是否大?
如果只係暫時回撤 → HOLD;如果短期內已轉趨勢 → CLOSE。
請輸出 JSON verdict。`;

  return { system, user };
}

/**
 * 純函數: robust parse LLM 輸出。
 * 容忍 JSON 前後雜訊 / 多個 JSON 揀第一個 / verdict 大小寫 / 垃圾 confidence。
 * 任何失敗 → uncertain(安全 fallback)。
 */
export function parseCloseTrendVerdict(text: unknown): CloseTrendResult {
  const fallback: CloseTrendResult = { verdict: 'uncertain', confidence: 0, rationale: 'parse failed' };
  if (typeof text !== 'string') return fallback;
  // 配對第一個 '{' 嘅 '}'（括號計數——多個 JSON block 唔會跨 block 誤 slice）
  const start = text.indexOf('{');
  if (start < 0) return fallback;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end <= start) return fallback;
  let raw: string;
  try {
    raw = text.slice(start, end + 1);
    const parsed = JSON.parse(raw) as { verdict?: unknown; confidence?: unknown; rationale?: unknown };
    // type guard——verdict 必須係 string(array/object/number 一律拒)
    if (typeof parsed?.verdict !== 'string') return fallback;
    const v = parsed.verdict.trim().toLowerCase();
    // 主神規定格式: hold/close/uncertain;向後兼容舊格式 continue→hold、reverse→close
    const verdictMap: Record<string, CloseTrendVerdict> = {
      hold: 'hold', close: 'close', uncertain: 'uncertain',
      continue: 'hold', reverse: 'close',
    };
    const verdict = verdictMap[v];
    if (!verdict) return fallback;
    let conf = Number(parsed?.confidence);
    if (!Number.isFinite(conf)) conf = 0;
    conf = Math.max(0, Math.min(1, conf));
    const rationale = typeof parsed?.rationale === 'string' ? parsed.rationale.slice(0, 200) : '';
    return { verdict, confidence: conf, rationale };
  } catch {
    return fallback;
  }
}

/** LLM 判斷入口——失敗/超時/disabled → uncertain(永不 block close) */
export async function judgeCloseTrend(
  input: CloseTrendInput,
  opts: { baseUrl?: string; model?: string; timeoutMs?: number } = {},
): Promise<CloseTrendResult> {
  if (!CLOSE_TREND_SENTINEL_ENABLED) {
    return { verdict: 'uncertain', confidence: 0, rationale: 'sentinel disabled' };
  }
  const baseUrl = opts.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  const model = opts.model ?? process.env['OLLAMA_MODEL_DEFAULT'] ?? 'deepseek-v4-flash:0731-cloud';
  const timeoutMs = opts.timeoutMs ?? 8_000;

  const { system, user } = buildCloseTrendPrompt(input);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        options: { temperature: 0.2, num_predict: 200 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.warn(`[sentinel] LLM HTTP ${response.status} — falling back to uncertain`);
      return { verdict: 'uncertain', confidence: 0, rationale: `LLM HTTP ${response.status}` };
    }
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { verdict: 'uncertain', confidence: 0, rationale: 'empty LLM output' };
    }
    const result = parseCloseTrendVerdict(content);
    if (result.verdict !== 'uncertain') {
      log.info(`[sentinel] ${input.symbol} ${input.side} → ${result.verdict} (conf=${result.confidence.toFixed(2)}): ${result.rationale}`);
    }
    return result;
  } catch (err) {
    log.warn(`[sentinel] LLM call failed (${err instanceof Error ? err.message : String(err)}) — falling back to uncertain (close proceeds)`);
    return { verdict: 'uncertain', confidence: 0, rationale: 'LLM call failed' };
  }
}

/** 純函數: sentinel verdict → 應唔應該 hold close(soft) */
export function shouldHoldCloseFromSentinel(result: CloseTrendResult, wasProfitable: boolean): { hold: boolean; reason: string } {
  // 主神規定:HOLD(暫時回撤)→ hold close;CLOSE/UNCERTAIN → 照 close。
  if (result.verdict === 'hold' && result.confidence >= 0.55) {
    return { hold: true, reason: `sentinel: 順向機會大(暫時回撤,conf=${(result.confidence * 100).toFixed(0)}%) — close 會斬喺反彈前/鎖利太早` };
  }
  return { hold: false, reason: '' };
}
