/**
 * v2.0.869(主神 市況判斷調查):Volatility Threshold Judge——LLM 判斷每個資產嘅波動率 threshold
 *
 * 背景:RegimeCalibrator 用「global threshold」(volLow=0.3%)——貴金屬/指數正常波動
 * 0.03-0.3%——被誤判「低波動」——市況判斷有問題(200 trade 全部 low_volatility)。
 *
 * 方案:LLM(世界模型)判斷 per symbol threshold——統計校準(實際分布驗證)——持久化。
 * 符合「LLM 世界模型係優勢」原則——LLM 提供先驗(世界知識)——統計校準防錯。
 *
 * Google Tech Lead:
 *  - 單一職責(判斷 + 校準 + 持久化)
 *  - 可回滾(flag:VOL_THRESHOLD_JUDGE=false → 用默認 threshold)
 *  - 防禦(LLM 輸出異常 → fallback 默認)
 *
 * 頂尖量化金融分析師:
 *  - 唔同資產類型唔同正常波動(世界知識)
 *  - 歷史分布校準(p25/p75——數據驅動)
 *  - 保守(唔誤判正常波動)
 */
import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'vol-threshold' });

export interface VolThreshold {
  symbol: string;
  assetType: string;
  volLow: number;        // 低波動 threshold(5 分鐘 σ——小數)
  volHigh: number;       // 高波動 threshold(5 分鐘 σ——小數)
  trendThreshold: number; // trend threshold(24h 變化 %)
  confidence: number;    // 0-1(低 confidence → 系統用歷史分布 fallback)
  rationale: string;
  judgedAt: number;
}

export interface VolThresholdState {
  version: number;
  savedAt: number;
  thresholds: Record<string, VolThreshold>;  // symbol → threshold
}

const DEFAULT_PATH = 'data/evolution/vol-thresholds.json';

const SYSTEM_PROMPT = `你係「波動率 Threshold 判定器」——頂尖量化金融分析師——判斷每個資產嘅合理波動率 threshold。

## ⚠️ 即時數據規則(最重要——唔可以違反):
- 你嘅訓練數據可能過時——**絕對唔可以用訓練數據嘅 market data**(price/volatility/trend)
- **必須用「輸入提供」嘅即時 market data**——輸入嘅 volatility/price/trend/candle 先係真實
- 如果輸入冇提供某個數據——**唔好猜**——confidence 降低(0.3 以下)
- 判斷 threshold 時——用「輸入嘅即時 volatility + candle 分析」做基準——唔係你記憶中嘅波動水平
- 你嘅「世界知識」(貴金屬/加密貨幣正常波動範圍)只係「先驗」——實際 threshold 用即時數據校準

## 輸入(每個 asset):
- 資產類型(加密貨幣/貴金屬/指數/股票)
- 歷史波動率分布(5 分鐘 σ——p25/median/p75/max——小數)——即時計算
- 當前市場狀態(regime/trend/volatility)——即時
- **5min candle 摘要(最近 30-100 支——即時市況分析用)**
- 新聞/宏觀摘要(如果有)

## 5min Candle 分析(即時市況——最重要):
- 用「輸入嘅 5min candle 摘要」分析現時市況:
  - 趨勢:最近 50 支嘅方向/幅度(上升/下降/橫行)
  - 波動:高/低/平均波動(用 candle 高低差計算)
  - 最近幾支:精確 OHLCV(睇即時價格行為)
- **新聞可能 delay 或者市場已經消化**——candle 先係「最即時」嘅市況
- 判斷 threshold 時——用「candle 分析」校準(唔係淨係新聞)

## 輸出(嚴格 JSON——唔加其他文字):
{
  "symbol": "SILVER",
  "assetType": "precious_metal",
  "volLow": 0.0005,
  "volHigh": 0.01,
  "trendThreshold": 0.5,
  "confidence": 0.85,
  "rationale": "貴金屬正常 5 分鐘波動 0.1-0.3%——0.05% 以下先算低波動"
}

## 判斷原則(量化金融分析師——概率/分布):
1. 唔同資產類型——唔同正常波動水平(世界知識——只做先驗):
   - 加密貨幣(BTC/ETH):5 分鐘 σ 0.3-1% 正常——<0.3% 低——>3% 高
   - 貴金屬(SILVER/GOLD):5 分鐘 σ 0.1-0.3% 正常——<0.05% 低——>1% 高
   - 指數(SP500):5 分鐘 σ 0.05-0.15% 正常——<0.03% 低——>0.5% 高
   - 股票:5 分鐘 σ 0.1-0.3% 正常——<0.05% 低——>1% 高

2. 用「輸入嘅即時歷史波動率分布」校準(數據驅動——唔係訓練數據):
   - p25 以下 = 低波動——p75 以上 = 高波動
   - threshold 應該令「regime 分布」有多樣性(唔係全部低波動)
   - 如果即時分布顯示「median 0.2%」——volLow 應該 < 0.2%(唔係 0.3%)

3. 動態調整(市場百變):
   - 市場波動大(新聞/宏觀事件/高 volume/candle 大波動)→ threshold 提高
   - 市場平靜(低 volume/無新聞/candle 細波動)→ threshold 降低
   - 唔好「一刀切」——每個 asset 獨立判斷

4. 保守原則(唔誤判):
   - 唔好令「正常波動」誤判「低波動」(貴金屬 0.1% 唔係低——係正常)
   - 唔好令「正常波動」誤判「高波動」
   - 唔確定 → confidence 低——用歷史分布 fallback

5. 輸出校準:
   - volLow < volHigh(必須)
   - volLow/volHigh 喺合理範圍(0.0001-0.1)
   - confidence 0-1(低 confidence → 系統用歷史分布 fallback)`;

export class VolatilityThresholdJudge {
  private state: VolThresholdState = { version: 1, savedAt: 0, thresholds: {} };
  private path: string;
  private baseUrl: string;
  private model: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(path = DEFAULT_PATH, baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434', model = process.env['OLLAMA_MODEL_DEFAULT'] ?? 'deepseek-v4-flash:0731-cloud') {
    this.path = path;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  /** 格式化 5min candle 摘要(慳 token——唔好全部原始 OHLCV)
   *  摘要:趨勢/波動 + 最近 5 支精確 OHLCV */
  formatCandles(candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>): string {
    try {
      if (!candles || candles.length === 0) return '';
      const n = candles.length;
      const first = candles[0]!;
      const last = candles[n - 1]!;
      const trendPct = first.o > 0 ? ((last.c - first.o) / first.o) * 100 : 0;
      // 波動(用 candle 高低差)
      const ranges = candles.map(c => (c.h - c.l) / (c.l > 0 ? c.l : 1));
      const avgRange = ranges.reduce((a, b) => a + b, 0) / n;
      const maxRange = Math.max(...ranges);
      const minRange = Math.min(...ranges);
      // 最近 24 支精確(主神:5 支太少——最少 24 支睇即時價格行為)
      const recent = candles.slice(-24).map(c => {
        const d = new Date(c.t);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `[${hh}:${mm}] O ${c.o.toFixed(2)} H ${c.h.toFixed(2)} L ${c.l.toFixed(2)} C ${c.c.toFixed(2)} V ${Math.round(c.v)}`;
      }).join('\n');
      return `5min candle 摘要(最近 ${n} 支):\n`
        + `  趨勢:${trendPct >= 0.1 ? '上升' : trendPct <= -0.1 ? '下降' : '橫行'}(${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(2)}%——${n} 支內)\n`
        + `  波動:平均 ${(avgRange * 100).toFixed(3)}% / 高 ${(maxRange * 100).toFixed(3)}% / 低 ${(minRange * 100).toFixed(3)}%\n`
        + `  最近 24 支:\n${recent}`;
    } catch { return ''; }
  }

  /** 批量判斷多個 asset(一次過 call LLM——慳 token——system prompt 唔重複)
   *  輸入:assets 陣列——輸出:thresholds 陣列——系統分返開 */
  async judgeBatch(assets: Array<{
    symbol: string;
    assetType: string;
    histVol: { p25: number; median: number; p75: number; max: number };
    currentState: { regime: string; trend: string; volatility: number };
    candles?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
    newsSummary?: string;
  }>): Promise<Array<VolThreshold | null>> {
    if (!assets || assets.length === 0) return [];
    try {
      const userMsg = `請判斷以下 ${assets.length} 個資產嘅波動率 threshold(一次過輸出所有):\n${JSON.stringify({
        assets: assets.map(a => ({
          symbol: String(a.symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24),
          assetType: String(a.assetType ?? 'unknown'),
          historicalVolatility: a.histVol,
          currentState: a.currentState,
          candleSummary: a.candles && a.candles.length > 0 ? this.formatCandles(a.candles) : '無 candle 數據',
          newsSummary: a.newsSummary ?? '無',
        })),
      })}`;

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        log.warn(`[vol-judge] batch LLM API error ${response.status}——fallback 默認`);
        return assets.map(() => null);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const content = String((data as { message?: { content?: unknown } }).message?.content ?? '').trim();
      if (!content) return assets.map(() => null);

      // 解析 JSON(可能包喺 ```json ... ``` 內)
      // v2.0.869-P4(主神 batch 判斷失敗):穩健 JSON 提取——
      // 舊邏輯 content.match(/\{[\s\S]*\}/) 貪婪——match 到「最後一個 }」——
      // 如果 LLM 輸出「{...} 額外文字 }」——JSON.parse 失敗。
      // 新邏輯:搵第一個 {——逐個 } 試 parse——成功即用。
      let parsed: { thresholds?: Array<Record<string, unknown>> } | null = null;
      const codeMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        try { parsed = JSON.parse(codeMatch[1]); } catch { /* 繼續 */ }
      }
      if (!parsed) {
        // v2.0.869-P4(主神 刁鑽攻擊):搵每個 { 位置——逐個 } 試 parse——
        // 舊邏輯由第一個 { 開始——第二個 JSON 連埋第一個——parse 失敗
        let searchFrom = 0;
        while (!parsed) {
          const start = content.indexOf('{', searchFrom);
          if (start < 0) break;
          for (let i = start; i < content.length; i++) {
            if (content[i] === '}') {
              try {
                const candidate = JSON.parse(content.slice(start, i + 1)) as { thresholds?: Array<Record<string, unknown>> };
                if (candidate && Array.isArray(candidate['thresholds'])) {
                  parsed = candidate;
                  break;
                }
              } catch { /* 繼續試下一個 } */ }
            }
          }
          searchFrom = start + 1;
        }
      }
      if (!parsed) {
        log.warn(`[vol-judge] batch JSON 解析失敗——fallback 默認`);
        return assets.map(() => null);
      }
      const thresholds = parsed['thresholds'] ?? [];

      // 分返開——每個 asset 校準 + 記錄
      const results: Array<VolThreshold | null> = [];
      for (let i = 0; i < assets.length; i++) {
        const a = assets[i]!;
        const sym = String(a.symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
        const llmOut = thresholds.find((t: Record<string, unknown>) =>
          t && typeof t === 'object' && String(t['symbol'] ?? '').toLowerCase() === sym.toLowerCase(),
        );
        if (!llmOut) {
          results.push(null);
          continue;
        }
        const threshold = this.calibrate(sym, llmOut, a.histVol);
        if (threshold) {
          this.state.thresholds[sym] = threshold;
          log.info(`✅ [vol-judge] ${sym}: volLow=${(threshold.volLow * 100).toFixed(3)}% volHigh=${(threshold.volHigh * 100).toFixed(2)}% conf=${threshold.confidence}`);
        }
        results.push(threshold);
      }
      this.markDirty();
      return results;
    } catch (err) {
      log.warn(`[vol-judge] batch 判斷失敗: ${err instanceof Error ? err.message : String(err)}——fallback 默認`);
      return assets.map(() => null);
    }
  }

  /** 判斷一個 asset 嘅波動率 threshold(LLM + 統計校準) */
  async judge(
    symbol: string,
    assetType: string,
    histVol: { p25: number; median: number; p75: number; max: number },
    currentState: { regime: string; trend: string; volatility: number },
    newsSummary?: string,
  ): Promise<VolThreshold | null> {
    try {
      const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
      if (!sym) return null;

      const userMsg = `請判斷以下資產嘅波動率 threshold:\n${JSON.stringify({
        symbol: sym,
        assetType: String(assetType ?? 'unknown'),
        historicalVolatility: histVol,
        currentState,
        newsSummary: newsSummary ?? '無',
      })}`;

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        log.warn(`[vol-judge] LLM API error ${response.status} for ${sym}——fallback 默認`);
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const content = String((data as { message?: { content?: unknown } }).message?.content ?? '').trim();
      if (!content) {
        log.warn(`[vol-judge] LLM 空輸出 for ${sym}——fallback 默認`);
        return null;
      }

      // 解析 JSON(可能包喺 ```json ... ``` 內)
      // v2.0.869-P4(主神 batch 判斷失敗):穩健 JSON 提取——逐個 } 試 parse
      let parsed: Record<string, unknown> | null = null;
      const codeMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        try { parsed = JSON.parse(codeMatch[1]); } catch { /* 繼續 */ }
      }
      if (!parsed) {
        const start = content.indexOf('{');
        if (start >= 0) {
          for (let i = start; i < content.length; i++) {
            if (content[i] === '}') {
              try {
                parsed = JSON.parse(content.slice(start, i + 1));
                break;
              } catch { /* 繼續試下一個 } */ }
            }
          }
        }
      }
      if (!parsed) {
        log.warn(`[vol-judge] JSON 解析失敗 for ${sym}——fallback 默認`);
        return null;
      }

      // 校準 + 驗證
      const threshold = this.calibrate(sym, parsed, histVol);
      if (!threshold) {
        log.warn(`[vol-judge] LLM 輸出無效 for ${sym}——fallback 默認`);
        return null;
      }

      // 記錄 + 持久化
      this.state.thresholds[sym] = threshold;
      this.markDirty();
      log.info(`✅ [vol-judge] ${sym}: volLow=${(threshold.volLow * 100).toFixed(3)}% volHigh=${(threshold.volHigh * 100).toFixed(2)}% trend=${threshold.trendThreshold}% conf=${threshold.confidence}——${threshold.rationale.slice(0, 80)}`);
      return threshold;
    } catch (err) {
      log.warn(`[vol-judge] ${String(symbol ?? '').slice(0, 24)} 判斷失敗: ${err instanceof Error ? err.message : String(err)}——fallback 默認`);
      return null;
    }
  }

  /** 統計校準——驗證 LLM 輸出 + 用實際分布修正 */
  private calibrate(symbol: string, parsed: Record<string, unknown>, histVol: { p25: number; median: number; p75: number; max: number }): VolThreshold | null {
    try {
      const volLow = Number(parsed['volLow']);
      const volHigh = Number(parsed['volHigh']);
      const trendThreshold = Number(parsed['trendThreshold']);
      const confidence = Number(parsed['confidence']);
      const assetType = String(parsed['assetType'] ?? 'unknown');

      // 基本驗證
      if (!Number.isFinite(volLow) || !Number.isFinite(volHigh)) return null;
      if (volLow <= 0 || volHigh <= 0 || volLow >= volHigh) return null;
      if (volLow < 0.0001 || volHigh > 0.1) return null;  // 合理範圍
      // v2.0.869(主神 刁鑽攻擊):trendThreshold 異常(NaN/string)——fallback 0.5
      // (唔應該令成個 threshold 無效——trendThreshold 只係輔助)
      const safeTrend = Number.isFinite(trendThreshold) ? trendThreshold : 0.5;

      // 統計校準(量化金融分析師——數據驅動):
      // 1. volLow 唔應該高過歷史 p25(否則正常波動誤判低波動)
      // 2. volHigh 唔應該低過歷史 p75(否則正常波動誤判高波動)
      let finalVolLow = volLow;
      let finalVolHigh = volHigh;
      if (histVol.p25 > 0 && volLow > histVol.p25) {
        finalVolLow = histVol.p25 * 0.8;  // 校準:volLow < p25(唔誤判正常波動)
      }
      if (histVol.p75 > 0 && volHigh < histVol.p75) {
        finalVolHigh = histVol.p75 * 1.2;  // 校準:volHigh > p75(唔誤判正常波動)
      }
      // 確保 volLow < volHigh(校準後)
      if (finalVolLow >= finalVolHigh) {
        finalVolHigh = finalVolLow * 3;
      }

      return {
        symbol,
        assetType,
        volLow: finalVolLow,
        volHigh: finalVolHigh,
        trendThreshold: Number.isFinite(safeTrend) ? Math.max(0.1, Math.min(2.0, safeTrend)) : 0.5,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
        rationale: String(parsed['rationale'] ?? '').slice(0, 200),
        judgedAt: Date.now(),
      };
    } catch { return null; }
  }

  /** 攞記錄嘅 threshold(冇 → null——用默認) */
  getThreshold(symbol: string): VolThreshold | null {
    const sym = String(symbol ?? '').replace(/[\x00-\x1F]/g, '').slice(0, 24);
    return this.state.thresholds[sym] ?? null;
  }

  /** 攞所有 threshold(RegimeCalibrator 用) */
  getAllThresholds(): Record<string, VolThreshold> {
    return { ...this.state.thresholds };
  }

  // ── Persistence(debounce——學 close-calibrator 教訓)────────────────

  private markDirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  save(): void {
    try {
      const fs = require('node:fs');
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), thresholds: this.state.thresholds }), 'utf-8');
    } catch (err) {
      log.warn(`[vol-judge] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      const fs = require('node:fs');
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as Record<string, unknown>;
      const clean: Record<string, VolThreshold> = {};
      const rawThresholds = raw['thresholds'];
      if (rawThresholds && typeof rawThresholds === 'object') {
        for (const [k, v] of Object.entries(rawThresholds as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          const t = v as VolThreshold;
          if (t && Number.isFinite(t.volLow) && Number.isFinite(t.volHigh) && t.volLow > 0 && t.volLow < t.volHigh) {
            clean[k] = t;
          }
        }
      }
      this.state.thresholds = clean;
    } catch { /* 非致命——load 失敗用默認 */ }
  }
}
