# {MATS} — Multi Agent Trading System（訊號運算後端）

> **作者**: YC Wong · **版本**: 2.0.870-momentum-direction-attack
> **核心哲學**: 資本保存為絕對第一優先，但必須在安全前提下持續創造盈利
> **定位**: `mats_backend` 係 **`mats_app`（Expo React Native 客戶端）嘅訊號運算系統**——計算 HACP 共識 → 擴展成 1×3 風險矩陣（v2.0.857 moderate-only）→ 寫入 Supabase；客戶端按用戶選擇讀取對應矩陣格並決定執行
> **代碼量**: ~74,500 行 TypeScript（嚴格模式，零類型錯誤）

---

## v2.0.870-sell-seed-accel（2026-08-25）：SELL 樣本加速 + 統一執行路徑完整化

**根因**: SNDK/DRAM/SKHX 連續五筆跌勢開 BUY——shadow-gate 只喺 active path（雙重標準）、F1 對 xyz 動量 mute、LLM 冇 sell 誘因。

- **S0 統一執行路徑完整化**: `applyEntryConvictionGates()` = F1 動量偏置 + shadow-gate（WR+EV block/boost）——active 同所有 trading market 都行同一套（消除「active 先有防禦」）
- **S1 seeding cooldown 參數化**: 跌勢 6 cycle / 非跌勢 24（sell 樣本回流快 4 倍）
- **S2 seeding 條件 +4h 動量**: 短線跌勢都播種（5 支 1h candle）
- **S3 SELL-SEED 提示**: DIRECTION HEALTH 跌勢時顯示「順勢 SELL 播種中」——LLM 有 lean 依據

---
## v2.0.870-momentum-direction-attack（2026-08-25）：攻擊輪硬化 + robust 動量

- **V1/V2 攻擊硬化**: side 參數污染 → 中性;|mom|>100% 污染值 → 中性（1e308 唔可以操控 gate 方向）
- **G3 robust 動量**（`robustMomentumPct()`）: median per-candle return × 窗口數（24h=25 支 / 4h fallback=5 支）——單支 outlier spike 唔再扭爆方向判決（raw ratio 會被 1 支 +15% 由 -5% 扭成 +10%）;clamp ±100 防污染

---
## v2.0.870-momentum-direction（2026-08-25）：動量方向偏置 + 統一執行路徑

**主神指令**: SNDK 24h -8.3% 照開 BUY——「嗰啲時刻其實應該要 Sell」;「multi-symbol path 唔應該存在」——每個 symbol 第一公民。

- **F1 動量方向偏置**（`momentum-directional-bias.ts` 純函數）: 順勢 ×1.05/×1.15、逆勢 ×0.85/×0.70/×0.45、**|24h 動量|≥8% 同向相反 → HARD BLOCK**——counterfactual: SNDK -8.3% 兩單直接封殺、順勢 SKHX 唔誤傷、BUY trending_bear -163% 可避 ~+125~160% EV
- **統一執行路徑**: `applyDirectionalBiasGate()` 共用 helper——active + 所有 trading market 開倉行同一個 F1（per-symbol 各自動量,股票/黃金獨立）——取代「multi-symbol path 補 gate」方案（主神裁決取消）
- **F3 24h→4h fallback**: 1h candle 唔足 25 支時 fallback 4h 動量——數據盲區消除

---

## v2.0.870-sell-decay-attack（2026-08-24）：攻擊輪硬化 + 盈利提升組件

**攻擊輪**: 6 攻 5 命中——未來 ts 凍結（V1 當最舊）、1e308 值污染（V2 cap：n≤1e6、|EV|>1e4→0）、seeded SL/TP Infinity（V3 isFinite）、key 大小寫 miss（V4 細階化）、OLR bins cap。

**G1 Momentum-OLR 衝突 gate**（`momentum-olr-conflict.ts`）：OLR 條件概率對抗 24h 價格分布位置 → 收縮向近期動量（強烈逆勢 ×0.60、強 OLR≥68% ×0.75、中等 ×0.80/×0.90、順勢/噪音 1.0）——DRAM 類「OLR 63% vs 24h -7.3%」被罰，btc 類順勢唔影響。

**G2 Side-Balance Monitor**（`side-balance-monitor.ts`）：最近 20 單 ≥90% 單向且另一側 0 → extreme 警告注入 agent context（20 cycle throttle）——單向失衡 LOUD 化，唔再靜靜 90 單零 SELL 4 日冇人知（真實數據驗證而家即 extreme_buy）。

---

## v2.0.870-sell-decay（2026-08-24）：SELL 24h 時間衰減 + 死亡螺旋解除

**背景**: 近 90 單零 SELL——主神調查發現 sell side 被 all-time 化石統計判死。根因鏈：shadow 訓練數據 10.8:1 BUY:SELL → sell WR 4-17% → OLR sell P(win) 鎖死 8-40% → LLM 唔 lean sell → 冇 sell shadow → 數據餓死（自我強化死循環）。

**四層修復**:
- **shadow stats 24h exp 衰減**（`shadow-trade-engine.ts`）：`statsBySymbolSide` 加 `lastUpdatedTs`，每次記錄前 `×= exp(-Δt/τ)`（τ=`SHADOW_STAT_DECAY_HOURS`=24h，0=回滾）；migration 舊數據一次過衰減至 4×τ 前
- **getStats() 數據源切換**：由「positions/recentResults 重建（易被 drain 成 0）」改為持久化 decayed stats——修復 shadow-gate「想 block 但冇 data」嘅架構缺陷
- **OLR calibration bins 衰減**（`olr-engine.ts`）：feed 前全 bins `×= exp(-Δt/τ)`（`OLR_BIN_DECAY_HOURS`）——SELL P(win) 重獲浮動
- **DIRECTION HEALTH EWMA 主判**（`index.ts`）：🔴 用近期 EWMA，all-time median 降 🟠
- **shadow-gate WR+EV 雙條件**：block 需「decayed Wilson LB < 30% **且** decayed net PnL ≤ 0」——低 WR 高 EV（SKHX sell 14d +22%）唔再誤殺；n<20 冷側交 LLM
- **SELL shadow 播種**（`openSeededShadow()`）：24h 動量 < 0 / trending_bear 時強制開 sell shadow（full OLR weight，24 cycle 限 1）——sell 樣本重新累積

**counterfactual 驗證**: SKHX sell 14d（WR 33% net +22%）新 gate PASS（舊 gate BLOCK）；SILVER/SKHX buy 7d（EV -68%/-26%）被新 gate BLOCK（近期真蝕）；bnb buy（低 WR 高 EV +62%）唔誤殺。

---

## 客戶端生態：mats_app & mats_frontend（v2.0.862）

MATS 有兩個客戶端，都係「訊號消費者」——後端係唯一嘅訊號運算大腦（HACP 共識 → 1×3 矩陣 → Supabase）。

| 客戶端 | 定位 | 執行 | 讀取 |
|:-------|:-----|:-----|:-----|
| **mats_app** | Expo React Native 手機 app（官方客戶端） | 用戶喺 app 揀風險等級 + 持倉狀態 → 對應矩陣格 → paper/real 執行 | Supabase `asset_analyses`（1×3 矩陣） |
| **mats_frontend** | Web 純客戶端（零 AI 運算，獨立 folder `/Users/y.c./Downloads/MATS_Frontend`） | paper = 前端 PaperEngine 計算寫 Supabase；real = 用戶 wallet 自託管簽名（HL API） | Supabase `asset_analyses` + `ui_snapshots`（後端每 cycle clean-snapshot feed，含完整 agent_thoughts）+ 用戶 section（RLS） |

**核心原則**：
- 後端每 cycle：HACP 共識 → `asset_analyses`（矩陣）+ `ui_snapshots`（完整 UI 快照，R6 完整 agent_thoughts）→ Supabase
- 兩個客戶端都唔做任何 LLM/agent 推理——純讀取 + 執行
- `ui_snapshots`（migration 19）：按 section 拆行（status/portfolio/market_state/consensus/agent_thoughts/evolution/misc），後端 `writeUiSnapshot()` 每 cycle INSERT 先行 + DELETE 舊 cycle
- 用戶 section（`portfolios`/`positions`/`trades`/`orders`/`user_risk_prefs`）：RLS select-own，寫入經 security-definer RPC

**詳細建構方案見 `frontend.md`（gitignore 排除——設計草稿，唔入版本庫）。**

## 概述

**MATS**（Multi Agent Trading System）係一個具備自我演化能力嘅多智能體量化訊號系統。核心決策引擎為 **HACP（Hyper-Accelerated Cognition Protocol）**——結構化多 LLM 辯論協議。在 **Hyperliquid（9 perpetual DEXs, 416 assets）** 市場上計算機構級交易訊號。

**架構定位（v2.0.822+ → v2.0.857 moderate-only）**：`mats_backend` 不再係獨立交易系統，而係 **`mats_app` 嘅訊號運算後端**。每個 cycle 後端計算 HACP 共識 → 擴展成 **1×3 Analysis Matrix**（持倉狀態 × 單一 moderate 等級；v2.0.857 由 3×3 縮減）→ 寫入 Supabase `asset_analyses` 表。客戶端（`mats_app`）讀取矩陣，按用戶喺客戶端選擇嘅持倉狀態（`long`/`short`/`flat`）揀選對應矩陣格，再由客戶端決定執行（paper/real）。

**風險等級由客戶端選擇（v2.0.857 更新）**：後端運算單一 moderate 等級嘅訊號（v2.0.857 移除 aggressive/conservative），客戶端 UI（`mats_app` SettingsSheet）讓用戶選 `high`/`mid`/`low`——全部映射到同一 moderate 矩陣格。後端矩陣係 **universal**（per-asset，非 per-user）——所有用戶讀同一格。

### 核心設計原則

| 原則 | 說明 |
|:-----|:-----|
| **資本保存第一** | 所有決策以生存為前提，利潤為次要。任何錯誤預設 HOLD，永遠不倒 |
| **理據驅動** | Meta-Agent 必須提供 entryThesis（`[1h:..] [1d:..]`）才可開倉；Skeptics 絕對否決權 |
| **暗黑心理學** | Meta-Agent 質疑數據是否大戶操縱；Skeptics 驗證 Meta-Agent 自身是否被偏誤 |
| **極限推理** | 冇倉位必須 BUY/SELL（極度不確定先 HOLD）；有倉位 thesis 失效（強制）+ ≥2 其他條件先 CLOSE |
| **自我演化** | 認知演化管線（v2.0.868-P1P2: 15 active + 1 Edge Validation + 1 Q-RL Alpha Discovery + 1 Component Attribution + 1 PAEL Exit-Price Learner + **1 LLM World-Model Layer** + **1 LLM Direction Verifier** + **1 EV Filter** + **1 Close-Decision Calibrator** + **1 Profitability Analyzer** + **1 Entry Quality System**）— OLR + Shadow Trading + First-Passage + EM Cycle Chain + GA + RIL + NA + AttnRes + Combo WR Gate + P(win)×Consensus Discount + Close-Context Learning v2.0.226 + Plan G Dynamic Threshold v2.0.227 + Edge Validation v2.0.833 + Q-RL Alpha Discovery v2.0.835 + Component Attribution v2.0.844 + **Q-RL Direction Signal v2.0.861** + **Shadow Pool Priority Eviction v2.0.861** + **PAEL v2.0.862** + **LLM World-Model v2.0.863** + **LLM Direction Verifier v2.0.864** + **EV Filter v2.0.865** + **Close-Decision Calibrator v2.0.866** + **TG Signal Push + Supabase Trade Writer v2.0.867** + **Profitability Analyzer + 閉環校準 v2.0.868**（Hold-Time EV + Direction Bias + Fee Impact + PAEL threshold 過早率閉環 + reconciliation fill 驗證）+ **Distribution Shape Gate + Convexity Detector v2.0.869-P8**（偏度/峰度門 + Wilson LB 保守 EV）+ **Hybrid Penalty Decay + Runs Test τ 調製 v2.0.870-P16/P17**（三層 OR 混合衰減打斷 Plan G death spiral：score = max(idle floor, time floor, 0.2·dCW+0.4·dTime+0.4·dEdge)；Wald-Wolfowitz 游程檢定 τ 9–18h 自適應；attack2：bypass 升級鏈硬化——plausibility + 新鮮度窗口 + load sanitize）+ **Binance bStocks 平行交易 v2.0.870-P50-P62**（Agentic Wallet 接入 + bStock 數據源 + x402 呼叫 + 自動 swap 執行 + 企業行動風險檢查 + 動態 map + Wallet TVL 觀測；⚠️ **P80-bstocks-hide 已暫停**——主神裁決唔賺錢，交易 call site 已移除，服務層保留）|
  歷史：v2.0.833 移除 4 個 0-inference 組件 + 暫停 active-exploration。v2.0.835 新增 Q-RL + Factor-Tagged Aligned Shadow。v2.0.844-848 新增 Component Attribution + LLM-vs-Stats A/B shadow + Label Cleanliness（量度邊個組件真正加 edge）。v2.0.849-851 將 momentum/exec-lens/confidence SL widening 移植到 live computeSmartSLTP + 修復 TradeRecord.closeReason 資料缺失（RIL + trade-audit 可以分到「SL 太緊」定「thesis 錯」）。v2.0.853 修復 closeTrade dual-mode guard（dual 模式下所有平倉被靜默跳過）+ 3 個缺失 closeReason 標記 + tradingManager.closePosition 用滯後 WS 價格代替實際 HL fill + UI SSE 退避。**v2.0.855 學習管道修復**：aligned shadow 恆開（real-trade cycles 都開，Q-RL 不再餓死）+ shadow_blind OLR 計數器（v2.0.834 承諾但從未 implement）+ thesis-invalidation closeReason 全覆蓋。**v2.0.855-fix**：Q-RL EXP backfill（1072 筆歷史交易 populate Q-table，令 discoverPatterns 即刻有嘢掃）。**v2.0.855-attack**：7 個修復引入嘅漏洞全部修補（OLR counter 字符串/負數消毒、closeReason 白名單、aligned-shadow weightedDirection 用真 LLM lean）。**v2.0.855-attack2**：Q-RL binRegime 邊界同 regimeToOrdinal 完全錯位（6/7 regime 入錯桶，bull/bear 對調）已對齊。**v2.0.856**：Attribution signal 契約修正（SELL 反轉 bug）+ side/symbol guard 補完（normalizeTradeSide，8 call site 強制 coerce 成 SELL 嘅 bug）+ edge-audit 工具。**v2.0.857 移除 aggressive/conservative 風險等級（moderate-only）**：12 個檔案——3×3 矩陣縮減為 1×3、後端 riskProfile 恆為 moderate、Meta-Agent prompt 改 moderate-only（慳 ~4.7KB context/cycle）。**v2.0.858 解鎖 cycle 期間市場選擇**：select-symbol 延遲應用 + throttle coalescing（唔再掉更新）+ symbol-set drift check（唔再淨比 count）。**v2.0.859 移除零消費者組件 + 修復學習管道**：backfill 重複喂飼（Q-RL/OLR persisted flag）+ OLR calibration shrinkage（斬 overconfidence）。**v2.0.860 三因子探索 + adaptive 歸一 + SE operator-conditioned context**（Frontis-MA1/OpenMLE-Evo：`U = 1.0×score + 0.6×progress + 0.3×novelty`，score 對 cell 自己 reward 歷史 min-max 歸一；SE 診斷只對 priority 文件畀全文、其餘 stub）|
| **唔靠過去 P&L** | 過去 drawdown/losses 唔係拒絕交易嘅理由——OLR 持續學習，市況不斷變化 |
| **多資產單循環** | 所有交易市場單一 HACP 循環分析；無持倉市場以 isTradingMarket=true 注入 |
| **風險等級客戶端選擇** | 後端運算單一 moderate 等級嘅訊號矩陣（v2.0.857 移除 aggressive/conservative）；客戶端按用戶選擇讀取對應格（v2.0.822→857）|
| **訊號與執行分離** | 後端計算訊號 + 寫入 Supabase；客戶端讀取 + 決定執行（paper/real）。`ANALYSIS_MODE` 控制後端是否同時執行 |
| **生產級標準** | 完整型別（Zod 驗證）、結構化日誌（Winston）、優雅關閉、指數退避重連 |

---

### v2.0.870-time-decay: Entry Gate 時間衰減全面化（主神指示 2026-08-23）

「距離越遠嘅交易紀錄影響力應該越少——先公平同靈活」。Audit 發現 EV Filter 連 timestamp 都冇、Conditional WR 全部歷史 trade 等權。**Fix T1 EV Filter τ=1d**（`ev-filter.ts`——`samples: {pnlPct, closedAt}[]`, `computeEV` 加權 `w=exp(-Δt/τ)`, **資格與方向分離**: n 原始樣本數防冷啟動 / EV 加權值校準; migrate 舊 number[] 當最舊; env `EV_TIME_DECAY_HOURS`）——實證 bnb|buy +1.44% → -0.58%（BNB 連蝕根因）、silver|buy +0.48% → -3.53%, 6/11 方向翻轉。**Fix T2 Conditional WR τ=14d**（`evolution-utils.ts` `computeVectorConditionalWinRate`——w = similarity × exp(-Δt/τ), records.ts 已有; options `timeDecayHours`; 全部冇 ts → raw path 精確保留）。

### v2.0.870-time-decay-attack: 時間衰減攻擊輪硬化

4 命中全修: ① `closedAt=1e308`/未來 10 年 → `dt=0` **全權重污染** → `TS_TOLERANCE_MS` 5min 時鐘容忍（超過 now+5min 當最舊）; ② null/string 元素 → NaN 傳播; ③ `pnlPct=Infinity` → EV=Infinity——元素級 sanitize（`typeof number && isFinite` guard）。17 攻擊測試全綠。

### v2.0.870-fp-multiplier: FP Multiplier 入 Conviction Gate

**主神問題**: FP shrink 交由邊個 agent 處理?確定影響開倉條件?——追蹤發現 consensus 主開倉路徑只有 LLM 文字軟影響（conviction gate 冇直接 FP 項）。驗證: FP 正 edge 無預測力（WR 47% ≈ 全場 48.5%）→ **只壓制唔 boost**。`fpEdgeMultiplier(edge)` 純函數（`first-passage.ts`）: edge≥0 → ×1.0 中性（shrink teeth——FP 唔再可推高 confidence）/ edge<0 → ×0.7-0.8 壓制（防逆勢）。接駁 conviction gate（`effectiveConfidence × fpEdgeMultiplier`, 方向對應 BUY→LONG edge / SELL→SHORT edge; env `FP_GATE_MULTIPLIER` 回滾; `[fp-gate]` log + audit 記錄）。live 實證 shrink 後 P≥99% = 0; SELL 逆勢 conf 60% × 0.79 → 47.4% 攔截。同時間衰減 τ=1d 獨立（FP 即時 edge, EWMA drift 內建加權）。

### v2.0.870-fp-multiplier-attack: FP Multiplier 攻擊輪

25 攻擊測試全綠（純函數邊界 + 接駁模擬）。Code Review 修復 1 個真實漏洞: **Symbol 錯位污染**——`finalDecision.symbol` 可由 HACP consensus 指向任何 market, 而 `lastFirstPassage` 係 active symbol 專屬 → 會將 BTC 嘅 FP 壓制 SILVER 開倉——加 `pwinSym === normalizeSymbol(activeSymbol)` guard（非 active → ×1.0 中性）。**已知限制**: per-symbol 開倉冇 FP teeth（per-symbol 冇 lastFirstPassage——同 P20-C asymmetry 一致, 留待日後）。

---
### v2.0.870-close-gate-attack: Close Gate 攻擊輪硬化 + 盈利提升

**攻擊輪 3 命中全修**: ① `buildOhlcvTable` t=1e308 → toISOString RangeError（sanitizeCandles 加 t 範圍 2000-2100 驗證 + safe date）；② prompt 無限膨脹（interval cap 4）；③ symbol prompt injection（`sanitizeSymbol` 字符白名單 + `sanitizeText` control chars）。

**盈利提升（數據收窄）**: E2 做——sentinel CLOSE 高信心（≥0.7）skip Skeptics（慳 LLM + 快離場）；E1/E3 取消（實驗無差異/無數據）；E4 做——slTpPenalty 過期清理（防 memory leak）。

---
### v2.0.870-close-gate: Close Gate 層級化整合（Fractal Momentum Sentinel 流水線）

**層級化 close 流水線**（每 consensus close 嘅 LLM call 由 2 個降到最多 1 個）:
```
SL hit → CLOSE（永遠, 0 LLM, market 確認）
虧損倉 → CLOSE（0 LLM, 止血優先——thesis-validation-guard 已喺 hacp 層保護）
MFE 鎖利 → CLOSE（0 LLM, 鎖住俾返晒嘅 gain）
Pre-filter（prefilterTrend 純函數, 4h+1h 雙窗, 0 LLM）:
  雙窗同向支持 → HOLD（pending-close 3 cycle 兜底）
  雙窗同向逆轉 → CLOSE
  中性/垃圾 → Sentinel
Sentinel LLM（唯一 LLM call, 8s timeout）:
  HOLD（暫時回撤,順向機會大）→ hold（pending-close）
  CLOSE（短期已轉趨勢）→ Skeptics 驗證
  UNCERTAIN / 失敗 → 照 consensus close（安全 fallback）
Skeptics（否決權保留）→ CLOSE
```

**Sentinel 判定格式**（主神規定）: 話俾 LLM 知 position 係 BUY/SELL，問「嚟緊順向機會是否大」——暫時回撤 → HOLD；短期已轉趨勢 → CLOSE；判斷唔到 → UNCERTAIN。輸入 = 最近 24 cycle 結構化 OHLCV（主體）+ ASCII chart（輔助），1h/5m 由 candleCache 緩存讀取。

**注意（原 trend-hold 單位 bug）**: `MIN_MOMENTUM_PCT=0.05` 實際係 5%（fraction 單位下）——live momentum（0.02=2%）永遠唔過 → 原 trend-hold live 上形同虛設。prefilter 用正確 fraction 噪音線 0.0005（0.05%）。shouldHoldForTrend 保留（向後兼容測試）。

---
### v2.0.870-buy-bias: 系統性單邊 BUY bias + BNB 連蝕修復（Fractal Momentum Sentinel）

**主神調查（2026-08-23）**: 近 20 個交易全部 BUY 無 SELL；BNB 連蝕都係 BUY。

**根因（220 筆 realTrades 定量驗證）**: ① First-Passage 短窗 drift 高方差 → trending regime 下 LONG P=100% edge +71pp 幻覺（實際 WR 39.1%）——所有 agent 見「必勝」→ 全投 BUY；② breakeven 29%/71% 不對稱 → P=40% 都顯示「+11pp edge」；③ BNB SL 被校準到 -0.83% price → 10/10 次正常波動掃走；④ sl_tp 後 re-entry WR 39.1%。

**Fix 1 — FP drift shrink + P cap**（`first-passage.ts`）: `sanitizeDriftForRegime(drift, regime, volatility?)` 所有 regime |ν|>0.5σ → shrink（drift 唔可以主導 diffusion）；`calculateFirstPassage` P cap 0.85。

**Fix 2 — edge vs 50% 雙參照**（`index.ts` OLR block）: `P(win)=43% (breakeven +14pp | vs50% -7pp)`——負 edge 無所遁形。

**Fix 3 — SL 絕對 floor 1.5%**（`smart-sltp.ts`）: `SL_ABSOLUTE_FLOOR_PCT`（widen-only）——BNB 0.83% → 1.5%。

**Fix 4 — sl_tp 蝕 1 次即 soft penalty**（`index.ts`）: `slTpPenalty` map（12h, +25% conviction, soft 非 block）——`SLTP_REENTRY_PENALTY_HOURS/STRENGTH`。

**Fix 5 — Fractal Momentum Sentinel**（`close-trend-sentinel.ts` 新）: 共識 TP/SL close 前, LLM 睇最近 24 cycle 結構化 OHLCV（`buildOhlcvTable`）+ ASCII chart（`buildCandleBarChart`）判斷趨勢持續性：`continue` → hold（pending-close 確認, 3 cycle 超時兜底）；`reverse`/`uncertain`/LLM 失敗/超時 8s → 照 close（止蝕永遠唔可以被 LLM 掛住）。SL hit（closeStructureConfirmed）永遠唔 apply；重入 guard；Gate Outcome Tracker 量度 hit rate；`_sentinelHolds` 寫入 execution metadata。

---

### v2.0.870-trend-hold-attack: Trend-Hold 攻擊輪 + Gate Outcome Tracker 閉環

**主神指令**: 不擇手段攻擊 Trend-Hold Gate / Gate Outcome Tracker / execution-metadata 周邊，完美修復；量化金融分析師思路提升盈利。

**攻擊輪（紅先 8 命中全修）**: momentum 極大（1e308）/ 極細（1e-9）→ 觸發 hold——加合理範圍 ±100% + 最小閾值 0.05%（噪音唔觸發）；prematureRate 1e308 / samples 1e308 → **reject 唔 clamp**（clamp 會令污染值變成「最強證據」）；record `xyz:GOLD` 但 check `gold` 唔 resolve——symbol normalize（細楷 + 去 xyz: 前綴）；空/空白 gate 名過濾。

**盈利提升（Trend-Hold 閉環校準）**: trend-hold 攔截後接入 Gate Outcome Tracker——量度攔截 hit rate（價格繼續升 = 攔截啱；跌 = 攔截錯）——數據驅動校準 gate 強度。

**驗證**: tsc 零錯誤；80/80 相關測試全綠；全量 3263 pass + 13 pre-existing。

---

### v2.0.870-trend-hold: Trend-Hold Gate（避免 whipsaw 多重 OPEN & CLOSE）

**主神報告**: BNB 連續 4 個 BUY trade 反覆 OPEN & CLOSE——$680.48 開到 $707.84 收，一直持有應該賺 +4.02%，中間進出淨係蝕手續費 + 錯過趨勢。Trade 2（+8.6%）agents 全部投 HOLD 但系統 close 咗，close 後價格繼續升 +2.9%——假 close。

**根因**: close-decision-calibrator 只睇「歷史過早率」（≥60% 先 hold），冇睇「即時趨勢」——4h/1h momentum 仍然支持持倉方向時 close = 逆勢操作。

**實作**: `src/analysis/trend-hold-gate.ts`（新）`shouldHoldForTrend` 純函數——趨勢支持（4h+1h 雙窗）+ 盈利 + 冇 SL/thesis 確認退出 → soft hold（×0.5-0.85，過早率分級）；SL/thesis/虧損永遠唔 hold（死揸防禦）；`index.ts` `holdCloseIfCalibrated` 加 trend-hold 分支——**只對 consensus close 生效**（tp_hit 鎖利設計唔 hold；exit_price_lock 由 calibrator 處理）；pending-close 確認機制（下 cycle 再 close = 確認執行；冇再 close = 取消揸住；3 cycle 超時兜底——唔會死揸）。

**反事實驗證（BNB 4 trade）**: Trade 2（consensus，趨勢支持）→ HOLD；Trade 1/4（SL hit）→ 照常 close；Trade 3（tp_hit）→ 照常 close。

**驗證**: tsc 零錯誤；62/62 測試全綠。

---

### v2.0.870-execution-attack: execution-metadata 攻擊輪 + Gate Outcome Tracker

**主神指令**: 不擇手段攻擊 execution-metadata 代碼（併發/狀態注入/持久化污染），完美修復；量化金融分析師思路提升盈利。

**攻擊輪（紅先 6 命中全修 + 純函數 16 攻擊測試）**: `buildAssetAnalysis` execution 參數——string/array/非 boolean blocked/gates 100 個/gate 名 10000 字直接寫入 metadata（持久化污染）；`sanitizeExecutionReport` 純函數——null/string/number/array → null；blocked 非 boolean → null；gates 垃圾過濾（gate 唔係 string 直接丟）；cap 50；長度 cap；有效 report 原樣保留；`attachExecutionToAnalyses`——垃圾 row/metadata 唔 crash；Skeptics 優先；**跨 cycle 洩漏修復**（flush 開頭清空 skeptics blocks）。

**修復**: `src/services/execution-metadata.ts`（新）純函數（單一 sanitize 入口）；`analysis-matrix.ts` / `supabase-writer.ts` / `index.ts` 三處接駁。

**盈利提升（Gate Outcome Tracker）**: `src/analysis/gate-outcome-tracker.ts`（新）——量化金融分析師思路：**每個 gate 係一個策略，量度 hit rate 先知道信唔信**。攔截時記錄（symbol/gate/direction/price/cycle），之後檢查走勢：攔截 BUY 價格跌 = hit（避免損失）/ 升 = miss（錯過盈利）；Skeptics BLOCKED close 持倉繼續賺 = hit。per-gate hit rate + avg move，持久化 `data/evolution/gate-outcome.json`（sanitize load）。純觀測層——零決策邏輯改動。

**驗證**: tsc 零錯誤；50/50 測試全綠；web `getExecution` 8/8 攻擊驗證。

---

### v2.0.870-execution-metadata: 最終執行結果寫入 asset_analyses（客戶端顯示攔截訊號）

**主神報告**: Skeptics BLOCKED close 等最終攔截 gate 冇顯示喺 mats_web_app——asset_analyses 只記錄 consensus，冇記錄「點解訊號冇執行」——致命。

**主神第二輪指示（前後腳修正）**: 成個 cycle 完成運算後先一次過上載——唔可以 writeCycle 早 + updateExecutionMetadata 遲。

**實作**（零決策邏輯改動）: `types` 加 `ExecutionGate` + `ExecutionReport`（`metadata.execution`）；`buildAssetAnalysis` 加 optional `execution` 參數；`supabase-writer.ts` 新 `updateExecutionMetadata()`；`index.ts` 寫入時序重構——`writeCycle` 延遲到 cycle 尾，Skeptics BLOCKED close 記錄 `_skepticsCloseBlocks` map，所有 gate 完成後 `flushPendingAnalyses()` 一次過 `writeCycle`（單一原子快照）。

**驗證**: tsc 零錯誤；analysis-matrix 12/12 測試綠。

---

### v2.0.870-buy-bias: TG 訊號 timeout 修復(10s → 30s + retry)

**主神報告**: BNB close 訊號冇推送到 group——「pushSignal failed (close): This operation was aborted」。

**根因**: pushSignal fetch timeout 10s 太短——主神網絡去 api.telegram.org 慢(getMe 實測 2.7s),sendMessage 可超 10s → abort → 訊號唔推。

**修復**（src/services/tg-signal.ts pushSignal）: timeout 10s → 30s;失敗 retry 1 次(400 永久錯誤唔 retry);retry log 清晰。

**驗證**: tsc 零錯誤;20/20 測試全綠;實測 sendMessage 成功。

---

### v2.0.870-pnl-title: PNL 標題顯示實際日期/時期範圍

**主神指示**: 財務報表標題「MATS — Daily Cumulative PnL」——Today/Yesterday 顯示「MATS — {21 Aug 2026} Cumulative PnL」(單日);星期/月份顯示「MATS — {15-21 Aug 2026} Cumulative PnL」(時期)。

**實作**（PNL/pnl.html）: 新 `updateTitleDate()` 函數(today/yesterday → 單日;weekly/week2/month1 → 同月「15-21 Aug 2026」/ 跨月/跨年「23 Jul - 21 Aug 2026」/「30 Dec - 5 Jan 2027」（end 帶年份）);`render()` 開頭 call(load 後自動生效);`setPeriod()` 移除固定 label 映射。

**驗證**: 日期邏輯 node 驗證(含跨年邊界);JS 語法檢查通過。

---

### v2.0.870-tg-review-fix: TG 訊號「冇發送」修復（chatId 污染 + 訊號等 LLM deadline）

**主神報告**: 盈利平倉訊號冇發送到 group。

**根因（兩層疊加）**:
1. **測試污染 settings（元兇）**: tests/tg-signal.test.ts T6/T7/T8 用 default path（`data/evolution/tg-signal-settings.json`）→ `updateSettings` save 覆蓋主神真實 chatId（env `TELEGRAM_CHAT_ID` = 5921875209）→ 全部 close 訊號 send 去假 group → 400「chat not found」→ 靜默消失
2. **訊號等 LLM 嘅設計脆弱性**: close 訊號等 postReview 生成——LLM 掛/慢 → 訊號死

**修復**:
- settings chatId 還原 + `POST /api/tg-signal` hot-update 運行中 process（唔使 restart）——sendMessage 實測成功
- 測試 T6/T7/T8 改用獨立 `/tmp` path（default path 唔准再被測試 save）
- 8s deadline（`generatePostReview`——訊號唔可以無限等 LLM，`signalPushed` guard + clearTimeout）
- pushSignal「chat not found」清晰警示

**驗證**: tsc 零錯誤；20/20 測試全綠；sendMessage 實測成功。

---

### v2.0.870-tg-review: TG close 訊號格式改為 Post-Review 主體 + 攻擊輪硬化

**主神指示**: TG group 訊息詳細區塊——「📝 reconciliation / 📄 Entry / 📄 Exit」換成 Post-Review 內容（closeReason 對 group 觀眾冇意義、thesis 太長太技術性）。

**實作**:
- 格式（`src/services/tg-signal.ts`）: postReview 存在 → 只顯示 `✅ Review`（取代 📝 reason + 📄 Entry/Exit）;缺失 → fallback 舊格式（資訊完整）
- 推送時機（`src/index.ts`）: close 訊號改為 postReview 生成完成後先推（`pushCloseSignal()` 新方法）——生成成功 → Review 格式;LLM 失敗 → fallback（訊號永不消失）;dedup 照常
- **攻擊輪**（v2.0.870-tg-review-attack）: 5 命中全修——truncate type guard（postReview 持久化污染 → TypeError crash）、formatOpenSignal symbol undefined crash、`numOrNull()` 統一顯示入口（1e308/NaN/Infinity 污染拒絕——唔再公開「MAE +1e+308%」/「Invalid Date」）、pricePct/MAE/MFE clamp、regime/thesis type guard;周邊 4 漏洞——generatePostReview 重入防護（postReviewInFlight + 已有 review skip）、margin 溢出 guard、holdMin NaN guard、fallback tradeId random suffix

**驗證**: 紅先 5 命中 → 綠後 20/20 全綠（V1-V12 攻擊 + T1-T14 回歸）;tsc clean。

---

### v2.0.870-pnl-range-attack: 30 日期限 + PNL 頂部修正

**實作**:
- 30 日期限: `closedRealTrades` 200 限制 → 30 日保留——垃圾時間保留 + length>200 先 filter（效能）
- PNL 頁面: $ % Refresh Capture 換行；頂部偏右修正（top-block 860px 對齊）

**驗證**: 7/7 攻擊測試；tsc clean；3195 pass + 13 pre-existing。

---

### v2.0.870-pnl-range: PNL 頁面時間範圍 + flip 語義 + post-review 百分比

**實作**:
- PNL 頁面: 1 WEEK/2 WEEK/1 MONTH 時間範圍（後端 week2/month1）；PAPER/REAL 顯示修正；MATS_icon.svg；標題字體 + 「Daily」隨 timeframe；trade records 淨係 %
- flip 語義: BUY End/SELL End（BUY End = BUY trend 終結）；asset_analyses flipEnd；pending 清除時機修正
- post-review: prompt 規定用 %（margin 基準）
- Trade Incident: PnL 淨係 %

**驗證**: tsc clean；vite build 成功；3188 pass + 13 pre-existing。

---

### v2.0.870-flipfix: flip bug 修復（pending flip 意圖 + exploration 檢查）

**主神調查**: 「Position flip」但從來冇開過 sell——bug！8 筆 flip 中 4 筆係 exploration——flip 只 close 冇 open——下 cycle 可能開同側（雙重損失）。

**實作**:
- 方案 A: `pendingFlips` 記住「原本倉位方向」（30 分鐘）——同側 re-entry block；對側允許；過期清除
- 方案 B: exploration 開倉前檢查 per-symbol consensus——相反方向 → 跳過

**驗證**: 10/10 測試；tsc clean；3187 pass + 13 pre-existing。

---

### v2.0.870-FINALEXEC-attack: asset_analyses 最終執行結果攻擊輪

**漏洞 + 修復**:
- A1(HIGH): updatedAt 極大（1e308）→ toISOString RangeError——updateSymbol + writeCycle 加合理範圍檢查（未來 1 年內）
- A2(MEDIUM): entryPrice 0 → stopLoss=0——execPrice <= 0 唔寫入 SL/TP
- A3(MEDIUM): stopLossPct 負數 → SL 高過 entry——clamp [0,1]

**驗證**: 20/20 攻擊測試；tsc clean；3177 pass + 13 pre-existing。

---

### v2.0.870-FINALEXEC: asset_analyses 反映最終執行結果（exploration + gate block）

**主神需求**: 客戶端按 asset_analyses 即時執行——但 asset_analyses 只記錄 consensus，exploration/gate block 令訊號同執行唔一致。

**實作**:
- `SupabaseAnalysisWriter.updateSymbol()`: 單 symbol clean-snapshot 更新（DELETE + INSERT，同 writeCycle 防禦模式）
- `index.ts` execResult 後: 比較最終決策 vs consensus——唔一致（exploration/gate block）→ 更新；一致（正常交易）唔重寫
- metadata `source: 'final-execution'`

**驗證**: tsc clean；3172 pass + 13 pre-existing；15 新測試。

---

### v2.0.870-EMR: Exploration Market Rotation（exploration trade 覆蓋剩餘市場）

**主神洞察**: exploration trade 只對 active symbol（BTC）開——BTC 有倉就唔開、亦唔轉向其他市場 → exploration 集中 BTC。

**實作**:
- `selectExplorationTarget()`: 從用戶 Selected markets（tradingMarkets + activeSymbol）選取「無 position + 最高 24h volume」市場
- 觸發條件: `!hasPosition(activeSymbol)` → `selectExplorationTarget()` 非空
- per-symbol context: `expState`（marketState + fetchPriceForSymbol fallback）替換 `combinedState` 39 處；`srCtx`/`fpCtx` 非 active → null 自然跳過；`fundingRate` per-symbol
- 開倉 symbol → `exploreTargetUpper`

**驗證**: tsc clean；3119 pass + 13 pre-existing。

---

### v2.0.870-ADP: Anti-Deadloop Protocol（防死循環——全 agent system prompt 注入）

**主神洞察**: 開源模型思考死胡同根因——開放式任務冇完成標準、元思考陷阱、冇外部化記憶。解法唔係加協議，係改工作方式：完成標準前置、先產出後優化、信任歷史。

**實作**:
- AGENT_PROMPT.md: UTP 收斂總則 + UTP-1 信任歷史 + UTP-6 收斂規則 + 新增 ADP 章節（死循環定義 + 破解階梯）+ SELF-VERIFICATION deadloop 檢查
- BaseAgent.getAntiDeadloopBlock()（base-agent.ts）: CONVERGE / TRUST CONTEXT / NO OSCILLATION / FIRST-TRY OUTPUT——think() + generateDebateStatement() 拼接——5 sub-agents + Meta-Agent 自動覆蓋
- Skeptics 2 個 inline prompt 手動注入（agents.ts）

**驗證**: tsc clean。純 prompt 附加，零邏輯變更。

---


### v2.0.869: MAE 模式升級方案(重開抑制 + MFE 鎖利 + 宏觀 gate)

**背景**:4 個 trade 重複輸(SILVER BUY ×2 + SKHX SELL ×2——reconciliation close 後重開)——「重開單又重複輸」——SKHX MAE = 0 數據矛盾(HL softUpdate 用 entryPx——pnl = 0——trackMAEMFE 冇追蹤)。

**HL unrealizedPnl 追蹤修復**:`portfolio.ts` softUpdatePosition 加 `hlUnrealizedPnl` 參數——HL 回傳真實 pnl——短持倉 trade MAE/MFE 有真實值——刁鑽攻擊硬化(併發/狀態注入/持久化污染——sanity range 驗證 + min/max sanitize)。

**MAE 模式(Phase 2)**:`entry-quality.ts` getMaePattern()——MAE/MFE ratio 分類(防除零)——差入場(>1.5)→ 重開 ×0.5 / 中性 → ×0.85 / 好入場(≤0.5)→ ×1.0——數據缺失標記(dataMissing——HL pnl 修復前舊樣本)——回測驗證(200 trade——差入場 27% vs 好入場 82%——55pp——n=131——統計顯著)——index.ts 開倉前應用(flag:MAE_PATTERN_GATE)。

**MFE 鎖利(Phase 3)**:`close-decision-calibrator.ts` getMfeLockAdvice()——MFE ≥ 2×ATR 且已回吐 ≥ 30% / MFE ≥ 1.5×ATR 且已回吐 ≥ 50% → 鎖利——consensus close 唔 hold——thesis invalidation close override PROFIT GUARD(第 5 個 trade:MFE 1.29% 觸發——直接 close——唔等 price 反轉)。

**宏觀 gate(Phase 4)**:`profitability-analyzer.ts` getLosingMultiplier()——時間加權蝕錢率(τ=6h——per symbol×side)——weight = exp(-Δt/6h)——加權蝕錢率 > 0.9 → ×0.45 / > 0.8 → ×0.65 / > 0.6 → ×0.85——index.ts 開倉前應用(flag:MACRO_LOSING_GATE)。

**回測 script**:`scripts/mae-pattern-backtest.ts`——讀 Supabase API(200 trade)+ entry-quality profile——分組統計(win rate/EV/偏度/Wilson LB)——驗證結論。

### v2.0.869-P2: LLM 波動率 Threshold 判定器 + Binance 剷除(市況判斷修復)

**背景**:200 個 trade 全部 low_volatility(regimeOrdinal 0.2)——市況判斷有問題——88.5% trade 記錄時 volatility = 0(冷啟動)——貴金屬/指數正常波動 0.03-0.3%——global threshold 0.3% 誤判低波動。

**LLM 波動率 Threshold 判定器**(`volatility-threshold-judge.ts`):
- LLM system prompt(世界知識——唔同資產類型唔同正常波動——加密/貴金屬/指數/股票)
- LLM 判斷 per symbol threshold(volLow/volHigh/trendThreshold/confidence)
- 統計校準(volLow < p25——唔誤判正常波動;volHigh > p75——唔誤判正常波動)
- 即時數據規則(LLM 必須用輸入提供嘅即時 market data——唔可以用訓練數據)
- 5min candle 分析(最近 24 支精確 OHLCV + 摘要——新聞可能 delay——candle 先係最即時)
- judgeBatch(多個 asset 一次過問——慳 token——system prompt 唔重複)
- `MarketStateAggregator` 整合:setSymbolThreshold + calcRegimeForSymbol(per symbol regime)

**Binance WebSocket 剷除**(HL-only mode):
- `binance-websocket.ts` 剷除(704 行——BinanceWebSocketManager 從未連接)
- `market-state.ts`(新檔案)——搬 MarketStateAggregator + RegimeCalibrator
- `multi-exchange-ws.ts`——移除 binance 參數 + 邏輯(detectExchange 全部 hyperliquid)
- Binance REST API(klines)——保留(有用)

**Candle xyz: 前綴修復**:HL DEX 資產需要 xyz: 前綴——`candle-cache.ts` + `support-resistance.ts` + `mfe-calibrator.ts`——try/catch fallback——並行 6 個 asset 測試 6/6 成功。

### v2.0.869-P3: Shadow Trade 升級 + Meta-Agent 暗黑心理學(一擊即中提升)

**背景**:今日交易表現差——主要係「新架構之前」開嘅 trade(S/R bounce 失敗——低波動市場)——Shadow trade 需要升級(追蹤/統計——提升一擊即中)。

**Shadow Trade 升級**(`shadow-trade-engine.ts`):
- recentResults 加 exitReason(sl_tp/force_resolve/evicted)+ pnlPct(盈虧 %)
- cap 50 → 100——getRecentPerformance(100):{ n, winRate, totalPnlPct, avgPnlPct, bySide, byExitReason }
- getSideStats():buy/sell 分別統計——getContext() 加統計(注入 Meta-Agent)
- Shadow 保持「每個 Cycle 都 BUY SELL 開倉」(探索——學「唔同情況下 buy/sell 分別」)

**Meta-Agent System Prompt(暗黑心理學)**:
- SHADOW TRADE STATS 分析(bySide 方向仲裁/byExitReason 陷阱偵測/avgPnl 負偏度/totalPnl regime)
- 暗黑心理學層(質疑 shadow 統計係咪大戶操縱——distribution trap/front-run/force_resolve 陷阱/avgPnl 不對稱/totalPnl regime 真相)

**刁鑽攻擊硬化**(12 個新測試):prototype 污染/null 樣本/prompt 注入/side 異常/併發——修復(null skip + __proto__ 防污染 + symbol sanitize)。

### v2.0.869-P4: Trade 記錄缺失修復 + 對帳機制

**背景**:HL 真實 trade(63,055 Close Short)唔見咗——open position 唔見 + close 冇記錄——UI Trade Incident 冇顯示。

**Root Cause**:onFills closeExchangePosition——close 本地 mirror——但係冇 call recordTrade——trade 唔會寫入 Supabase——UI 冇顯示(主因!)+ recordTrade 寫入失敗唔 retry + 冇監察。

**修復**:
- `index.ts` onFills close 後 call recordTrade(所有 close 路徑都寫入)
- `supabase-trade-writer.ts` recordTrade retry 3 次(指數退避)
- `scripts/reconcile-trades.ts` 對帳機制(realTrades vs Supabase——缺失補寫——包括 entryThesis/exitThesis)
- buildTradeRow side 大小寫不敏感(方向顛倒漏洞修復)

**刁鑽攻擊硬化**(13 個新測試):buildTradeRow 極端值/side 異常/對帳 null/NaN id/超長/併發。

### v2.0.869-P5: vol-judge 修復系列(JSON 解析/遞歸 retry/大小寫/每個 Cycle fetch)

**背景**:vol-judge 判斷 threshold——多個問題(batch JSON 解析失敗/有時 5 個有時 4 個/BTC vs btc 污染/每個 Cycle 先 fetch/change24h 數據唔可靠)。

**修復**:
- JSON 解析多格式(thresholds array/直接 array/assets 包裝/單個 asset object)
- 遞歸 retry(漏咗嘅整批補問——直至攞晒 6 個——max 3 輪)
- 大小寫統一(normalizeSymbol——清理污染 36 → 35)
- 每個 Cycle fetch(移除 1h 過期)
- judgeSyms 用 getTradingMarkets(用戶所選擇嘅市場——唔係 topPairs)
- change24h 移除(filter judgment 唔用——數據唔可靠)
- timeout 180s + save require→import fs

**刁鑽攻擊硬化**(25 個新測試):多格式 JSON 解析/每個 Cycle fetch/judgeSyms 異常/單個 object 解析/遞歸 retry。

### v2.0.869-P6: thesis invalidation 數據鏈修復 + guard 提取

**背景**:主神發現「price moved only 0.00%」+「held 0 min」——thesis invalidation 全部被擋——蝕錢倉唔 close——倒蝕。

**修復**:
- `portfolio.ts` softUpdatePosition:unrealizedPnlPct 用 HL pnl 同步更新(pnl/margin)
- `hacp.ts`:entryTimestamp ?? openedAt fallback + posCtx 用真實 unrealizedPnlPct + openedAt 全鏈 forward
- guard 提取為純函數 `src/cognition/thesis-validation-guard.ts`(shouldAllowThesisValidation——3 條資本保存不變式:賺錢永不 close/蝕 <0.5% 永不 close/持倉 <30min 永不 close + v2.0.832 SL-hit 結構確認 bypass)
- 型別安全:PositionContext 加 openedAt + 移除 (p as any) casts

### v2.0.869-P7: SILVER 正負號反轉修復

**背景**:HACP guard 話 SILVER +4.07% 賺錢,但 Trade Incident UI 顯示 -3.0% 蝕緊——正負號反轉。

**修復**:mark price polling 傳返 HL 真實 unrealizedPnl(從 getUserPositions 攞)——currentPrice 用 l2Book bid(顯示)+ unrealizedPnl/unrealizedPnlPct 用 HL 真實值(決策)——兩者分離。

### v2.0.869-P7-attack: 刁鑽攻擊硬化

**修復**:Infinity stopLossPrice/currentPrice 唔再 bypass structure_confirmed(sanitize 為 finite 正值);normalizeSymbol null/undefined/非 string → ''(唔 crash);fallback map leverage Infinity → 0。

### v2.0.869-P9: Supabase 資料完整性修復 + 資料契約文檔

**背景**:審計 backend 寫入 Supabase 嘅資訊係咪齊全,發現 4 個缺口。

**修復**:
- `writeUiSnapshot` camelCase→snake_case section 映射(agentThoughts/marketState → agent_thoughts/market_state)——之前跌入 misc,frontend AgentMonitor 永遠顯示「未收到 agent_thoughts」(主神 R6 數據丟失)
- `edge_report` 列(migration 21)+ writeCycle 寫入
- `SUPABASE_DATA_CONTRACT.md`(gitignored)——frontend/app agent 讀取 Supabase 嘅完整資料契約

### v2.0.869-P11: DEX 資產價格來源統一

**背景**:主神指正 P7 嘅 SILVER 正負號反轉只係顯示層症狀,真正根因係「根本攞錯 data」——DEX 資產(xyz:SILVER/GOLD)嘅即市價格用咗 l2Book best bid(買方出價),而唔係 HL mark/mid 價。

**修復**:
- 統一用 `candleSnapshot` close 價(同 scanDEX18AssetsInBackground 一致——即市 close ≈ mid)
- 3 處修復:`fetchPricesForSymbols` + `fetchPriceForSymbol` + `pollHLRestPrice`
- 保留 l2Book 嘅地方(非即市 data):order book 深度(SystemGuard)+ 落單 aggressive 價

### v2.0.870-P44-P47: 反轉止蝕精修 + 獨立 close reason(全鏈)

P44:反轉止蝕 close reason `consensus`→`thesis_invalidation`。P45:盈利倉唔觸發反轉止蝕(贏單要跑,交俾 regime_reversal_lock)。P46(ATR-aware SL)驗證死路——127 筆 trending 倉零改善。P47:反轉止蝕獨立 close reason `consensus_reversal`(全鏈 10 處:type/白名單/learning-weight 0.3/分析集/agent prompts)。P47-fix:digester heuristic 保留 consensus_reversal(唔覆蓋)。P47-fix2:LLM digester 都保留(系統確定嘅 close reason 唔俾 LLM 判斷覆蓋)。P49(決策):拒絕 re-entry cooldown——判斷準確性靠學習系統唔靠 block。

### v2.0.870-P50-P62: Binance bStocks 平行交易(Agentic Wallet + 數據源 + x402 + 自動 swap)

> ⚠️ **狀態：已暫停（v2.0.870-P80-bstocks-hide）**——主神裁決 bStocks 交易機制唔賺錢，交易 Cycle call site 已移除、UI 已隱藏；服務層（bstocks-wallet/bstock-data/x402-calls）保留，裝返步驟見 `bStocks_module.md`。以下係歷史記錄。

**P50**:Trading Terminal UI 加 Wallet TVL cell + Binance bStocks On/Off switch。**P51**:Agentic Wallet 接入(`src/services/bstocks-wallet.ts` 包裝 `baw` CLI——signIn/verify/getStatus;UUID 驗證 + execSync timeout + 防禦式 parse;唔 log token)+ `/api/bstocks/connect|verify|status` + UI Connect 流程 + `bStocks_module.md`。**P52**:交易機制確認(swap 冇 SL/TP、long-only、BUY→swap USDT→bStock)+ UI symbol 右方橙色 bStock 標籤。**P53**:自動 swap 執行(`maybeSwapBStock`——BUY→USDT→bStock / SELL→bStock→USDT,下注 = Wallet TVL × positionSizePct,Leverage 唔理)+ Wallet TVL + 自動存地址 + env `BSTOCKS_ENABLED`。**P54**:bStock 數據源(`src/services/bstock-data.ts`——type=3 list API 緩存 10min + Binance spot price 緩存 30s)+ x402 呼叫(`src/services/x402-calls.ts`——402→preview→sign→replay;CMC 4 designated tools + Agent Studio async 兩段式)。**P55**:企業行動風險檢查(API 4 `isTradable`——TRADING/openState=true 先可 swap;ASSET_PAUSED/LIMITED/MARKET_CLOSED skip;fail-open 唔 hard-block)。**P56**:Trade Incident 顯示 bStocks 平行交易(symbol 右方橙色括弧 + Entry/Exit Price 橙色 bStock 價)。**P57**:重啟後自動檢查 Agent Wallet 連接狀態(mount 時 fetch status)。**P58**:bStocks connected state(橙色 border + switch 未連接時 disabled)。**P59**:動態 bStock map(67 隻由 type=3 API 動態攞,ticker 例外表 SKHX→SKHY / SP500→SPY,新 symbol 自動 map;移除 hardcode)。**P60**:Wallet TVL refresh button + 每 cycle 1 次 CMC + 1 次 Agent Studio x402(3 次後永久停,計數持久化 `data/bstocks-x402-count.json`)。**P61**:Hyperliquid trading mode indicator(#97fce4 + gray,paper/real switch)+ bStocks Live/Pause badge(橙色,localStorage 持久化)+ 移除 Trade Mode buttons + 主色 Hyperliquid green + bStocks connected 時 3 條 slider 綠→橙漸變。**P62**:Position Size slider 漸變 + console/TG 每 cycle show Wallet 餘額。

### v2.0.870-P63: OPEX 唔再一刀切 veto(LLM 判斷突破定突破唔到)

主神裁決:「到期可以照不要veto,LLM 判斷而家到底係突破定還是突破唔到」——OPEX 前 3 日一刀切 veto 令美股盤前搶唔到先機,八個市場半日冇 trade。根因:SPX/SKHX options 2026-08-21 到期 = 2 日後,`daysToExp <= 3 → eventRisk='opex'` → playbook「Stand Aside」→ vetoNewPositions=true → 兩層 block(agents 全部投 HOLD + deterministic veto 強制 HOLD)。

**修復**:`getRegimePlaybook` 嘅 `hasEventRisk` 只計 earnings/fomc/high(OPEX 唔再觸發 Stand Aside veto);`formatForAgentContext` OPEX → 「informational (NOT a veto): LLM judges breakout vs failure」;`eventRiskTolerance` 'none'→'opex';deterministic veto 加 env `OPTIONS_PLAYBOOK_VETO`(false 可完全關閉)。驗證:SKHX playbook = Standard Directional(vetoNewPositions=false),agents 改為根據 OLR edge/S-R/momentum 判斷。

### v2.0.870-P64: bStocks BNB gas 保留 + USDT 餘額檢查(比賽規則落地)

Binance bStock PnL contest 規則:「Keep BNB for gas: every trade is an on-chain transaction that consumes gas. Do not convert all funds to stablecoins or bStock, or the first transaction will fail for lack of gas」+「Compliant jurisdiction: bStock is only open to permitted-jurisdiction qualified users」。

**落地**:`getBalance()` 加 `bnbBalance`/`bnbValue`(從 tokens 搵 BNB);`maybeSwapBStock` swap 前檢查 BNB ≥ 0.01(≈$6,BSC gas 每次 <$0.1;唔夠 → skip + ⛽ warning)+ 買 bStock 前檢查 USDT > 0;`bStocks_module.md` 5.2 補齊 gas 硬要求 + jurisdiction 規則。實證:Wallet 只有 USDT $99.40、0 BNB——新檢查會 skip 直到主神入 BNB。

### v2.0.870-P65: TradingView 圖表即時顯示(candle cache + SPCX fallback + error 重試 + chart override)

主神報告:撳 symbol 圖表要等好耐(全黑);「No candle data for xyz:SPCX」;select-symbol deferred 時 UI 冇反饋。根因:`/api/candles` 冇 cache(每次撳 + 每 cycle reload 都 fetch HL API);`xyz:SPCX` 唔喺 HL meta(232 coins 冇)→ HL 返回 0 支;前端 refreshKey=cycles 每 cycle destroy+recreate 成個 chart。

**修復**:`/api/candles` 加 30s TTL cache(同一 symbol+interval 即時返);HL 返回 0 支時 fallback 去 Binance spot(bStock cs 交易對,例如 SPCXBUSDT);前端成功後唔再每 cycle reload、error 時下個 cycle 自動重試、撳 symbol 立即本地切換 chart(`chartSymbolOverride`)+ 「⏳ Wait till cycle complete…」badge。實測:SPCX 169 支蠟燭、cache hit 0.0009s。

### v2.0.870-P65-attack: 刁鑽攻擊輪(8 攻全修)+ 盈利提升

**A1(HIGH)** BNB gas null bypass(getBalance 失敗 → 唔 skip → 冇 gas 照 swap)→ `checkBStockSwapPreconditions` fail-closed(null/NaN/負數都 skip)。**A2** BNB NaN fail-closed。**A3** USDT 餘額檢查抽做純函數。**A4** maybeSwapBStock 併發 guard(`bStockSwapInFlight` Set)。**A5** candle cache 上限 200 entries。**A6** candle cache inflight dedup。**A7** SPCX fallback <10 支都 fallback。**A8** eventRisk case-insensitive。

**盈利提升**:E1 OPEX 波動率調整止損(`computeSmartSLTP` 加 `eventRisk` 參數,OPEX 期間 SL 加闊 ×1.5 widen-only cap 5% TP 唔郁——P43 實證:闊 SL 91% 贏單保留);E2 bStock swap 最低下注 $5(避免 gas/手續費侵蝕)。

### v2.0.870-P66: bStocks live → pause 強制平倉 + 確認 modal 顏色分家

主神指令:bStocks switch live → pause 時,如果持有 bStocks,先確認「是否全部平倉」(just like Hyperliquid paper/real switch),確認後全部平倉,先可以 pause。

**落地**:`findBStockTokens()` 純函數(symbol 以 B 結尾 + 排除 payment tokens)+ `closeAll()`(逐個 swap bStock → USDT,串行避免 rate limit,失敗唔中斷,保留 gas token)+ `/api/bstocks/close-all` route + UI 確認 modal(`handleBStocksToggle` → check 有冇持有 bStock → 有就確認 → `confirmBStocksCloseAll` → 完成後先 pause)。顏色分家:HL mode switch 確認用綠色(var(--accent) #97fce4)、Binance live/pause 用橙色(var(--gold) #F5A623)。

### v2.0.870-P67: BNB price $0 bug 修復(fetchPriceForSymbol 大小寫)

主神報告:八個市場半日冇 trade——檢查發現 BNB price stale($0.00),agents 判斷「Price data is stale」完全唔 trade BNB。根因:`fetchPriceForSymbol` 對 bare symbol 用 `u.name === symbol` 原樣比較——HL universe 係大寫 `'BNB'`,但 tradingMarkets 有 `'bnb'`(細階)→ 搵唔到 → 返回 0。由 v1.9.4 initial commit 就存在(git blame 確認);之前冇爆係因為 dex0CtxsCache 成日 hit(cache 用 `toUpperCase()` 冇問題),cache miss 先會行到有 bug 嘅分支。修復:`u.name === symbol.toUpperCase()`(case-insensitive)。驗證:BNB 而家 agents 見到「Trending bull but price is mid-range (40.5bps above demand)」。

### v2.0.870-P43: 闊 SL + 加強版共識反轉止蝕

SKHX whipsaw 案例(方向啱但 SL 太貼 → 5 次進出蝕 -$1.62)。反事實回測:只闊 SL(TP 唔郁)= 91% 贏單保留、58% 輸單防住;trailing stop/raw trend 反轉均驗證死路。組件 1 `regimeSLWidth`(trending → SL 2%);組件 2 `shouldExitOnReversal`(四條件:反轉+確認+信心+趨勢互證,用 HACP 共識唔用 raw trend)。兩者 hard code + env 回滾。

### v2.0.870-P35-attack: 攻擊輪 7 攻 1 中

A1 fixed:`getTrendRegimeSnapshot` σ 口徑統一(candle σ 優先,同 getState)——修 gate 錯位決策風險。其餘 pins:uppercase 中性/污 trend 白名單/惡意 symbol null/TTL 中性/單信號中性/observe-side-effect-free。

### v2.0.870-P35: 順逆勢 soft gate(trend-alignment-gate)

「最近瘋狂蝕錢」根因:開倉嗰刻 trend/regime 已 bearish/trending_bear 但系統照 buy(逆勢信號冇 any 閘)。`trendAlignmentMultiplier()` 純函數:雙重一致先乘,鏡像方向(trending_bear+sell ×1.2 / buy ×0.5 等);soft,env 回滾;A7 免觀測 getter(`getTrendRegimeSnapshot`)。插入 soft-multiplier 堆疊(entry-gate/mae-pattern 同款)。

### v2.0.870-P34: 公開層最小化(lite app 私隱架構)

主神洞察:公開 lite app 唔可以見到帳戶倉位/結餘;審計發現 ui_snapshots 帶 public-read policy(任何 anon 讀到 status/portfolio)。Migration 22:ui_snapshots → authenticated-only;`signals_lite` 視圖(security_invoker)係公開 app 唯一讀取面(thesis 剔除);edge_report 列冚冚聲。架構:一張公開表(asset_analyses/signals_lite)+ 內部表(ui_snapshots);backend 零改動(照上載)。

### v2.0.870-P33: xyz 倉位 currentPrice 由 xyz dex allMids 更新

v2.0.869-P2 嘅 allMids 修復只覆蓋主 dex(實證 948 symbol 零 xyz)——xyz 資產 currentPrice 永遠 = entryPx(TG entry=cur 再現 + SL/TP 永不觸發)。修:逐 dex(PERP_DEX_NAMES)攞 allMids 合併。+1 紅先測試。

### v2.0.870-P31+P32: 新聞源 rate-policy 紀律

P31: GDELT host pacer(全域 promise-chain,1 req/5.5s,reserve-on-enqueue,失敗唔斷鏈)——實證 GDELT IP 級硬限 1 req/5s,6 symbol 並發必中 429 循環 cooldown。**P32(主神裁決):GDELT 預設停運**(`NEWS_GDELT=1` 翻身),news 主力 = google-news + bing RSS;breaker backstop 不變。

### v2.0.870-P29-attack2: cycle-history key 完整性(validator 認自家 canonical + side-word 閘)

兩層:(1) `isValidSymbolKey` 放行 A-Z——normKey 只細階化冒號前 prefix(canonical 係 `xyz:SILVER`),之前每次啟動誤棄 6 隻 xyz: AttnRes 記憶;(2) `isUsableSymbolKey` = charset ∧ 唔係 side-word(buy/sell/hold),閘三 runtime 入口 + load 清理——欄位錯位化石(`decision.symbol='buy'`,cycles 10706/10799)永久封殺;`'0g'` 合法資產保留。化石檔已清。

### v2.0.870-P29-attack: P29 攻擊輪(4/6 命中全修)

V-3a 分桶白名單(`__proto__`/`constructor` 歸 unknown);**V-1 假 normal 修復**——`volumeData` 顯式標記,中性預設≠真量數據(V-1 係量條件 edge 可讀性嘅根基);V-3 ratio clamp [0,100];C-3 巨針盾(單支偏離入場價 ±100% 跳過,真 +5% 插針照過——唔 over-block)。歷史 fixture 升級 volumeData 語義。

### v2.0.870-P29-S1+S3: Shadow 量標籤 + 量條件勝率

S1:量維度(volumeRatio5m/vol4hRatio/thin/strong flags,中性=1.0)經單一 helper 流入 blind/aligned/statistical 三條開倉路徑——記錄唔閘(探索不可被 bias)。S3:判決時量標籤持久化 + `getVolumeConditionedStats()` 四桶觀測,SSE/ui_snapshots 加 `volumeConditioned`。盲影雙向結構性 ~50% WR,aligned 單邊先係訊號。

### v2.0.870-P29-S2: Shadow 判決路徑真實度(tick 盲區修復)

shadow TP/SL 判決由 tick high/low(100 格)升級做 **tick ∪ 5m 蠟燭路徑**(每倉位 `openTimestamp−300s` 窗選;壞支盾;未來時鐘污染拒收;同日穿雙邊維持 SL-first 保守)。非 active 市場(REST 1 tick/cycle)嘅 cycle 內插針由全盲變全覆蓋;單一緩存池零成本。**Label-shift**:shadow 勝率新舊唔直接可比(resolution 修正記賬)。+8 紅先測試。

### v2.0.870-P28: 真市況 → LLM + 學習層完美接入

主神質詢落地:A=agents context 注入動量/量值 block,每行帶來源聲明(per-symbol 絕對量度,跨 symbol 比較 INVALID);B=`entryMarketFeatures.momentumShort/Long` 死維度(寫死 0)復活——數據源換做蠟燭動量(m15m/m4h→fraction),四條活路接入 + shadow 蠟燭優先/tick 降級;C=vol-judge prompt per-symbol guardrail。副作用紀律:全部行免觀測 `getMomentumSnapshot()`。

### v2.0.870-P26-attack: 動量層攻擊硬化(8 向量 6 命中全修)

紅先攻擊輪覆蓋 P26/P26.5:A1 分類器重複防禦(非 finite 窗口歸 null) · A3 future-ts TTL 繞過 clamp · A4 符號長度閘(>64 拒) · A5 vol-judge caller 垃圾 computedVolume 形狀校驗+自計回退 · **A6(HIGH)candle fetch 掛死凍結 trend 層 → per-symbol `withTimeout` 8s** · **A7 觀測者效應:momentum wiring 經 getState() 逐 symbol 多觸發 `calibrator.observe` → 校準分布被測量行為位移 → 免副作用 `getVolatilityForTrend()`**(spy 測試釘死零觸發)· A8/A9 既有盾牌釘回歸。

### v2.0.870-P26.5: vol-judge × 蠟燭量核對(P2/P5 棄用量嘅救贖)

主神洞察:P2/P5 因 REST 量不可靠棄用,今用 candleCache 同源定量量值補返——`MomentumSnapshot.vol4hRatio`(48 支收市量 ÷ 前 48 支,窗口對窗口);**vol-judge 自計保證**(caller 唔傳就自己由同一蠟燭算,唔可能漏);SYSTEM_PROMPT 核對規則(定性 vs 計算,矛盾以計算為準;vol4hRatio>1.5 量能擴張/<0.7 萎縮=假突破風險)。**OHLCV 單一緩存池確認**:P26 嘅 per-cycle momentum 更新即 candleCache pool warmer,LLM kline/ATR/S-R/vol-judge 全部同池 cache-hit,每 cycle 每 symbol+interval 至多 1 fetch。

### v2.0.870-P26: Local Momentum Trend(趨勢盲修復)

**根因**:WS tick 每 tick 將 `priceChangePercent` 覆蓋做 0 → calcTrend 永遠 sideways → regime 永世 mean_reverting → 「趨勢明顯都開唔到單」+ 慢性 MR 標籤教出 SILVER:sell 逆勢失血桶。

**解法**(`src/analysis/momentum-trend.ts` 純函數):棄用 24h REST 欄位(主神定調),trend 由本機 candleCache 蠟燭動量(5m/15m/1h/4h)+ 5m volume 確認驅動;**4h 主方向 × 1h 時機確認雙窗同向**先判 trending_bull/bear;窗口線性縮放閾值(τ4h=τ24/6 floor 0.05%、τ1h=τ24/24 floor 0.03%);`MarketStateAggregator` 10min TTL 新鮮動量優先、過期降級 legacy;analysis-matrix/UI 卡位由 24h% 改顯示 4h 動量(舊行 fallback)。Live 驗證:SILVER 首 cycle trending_bull。

### v2.0.870-P24: Deployment-Version Awareness(trade-audit 時序誤判根除)

**問題**:trade-audit LLM 指「Trade #17(SKHX −11.3%)係 P21 部署後新發生」——實際該單早於 P21 落地 43 分鐘。根因:prompt 只知「fix 存在」唔知「幾時落地」;dataLine 連 close 時間都冇。

**解法**(`src/services/deployment-timeline.ts`):
- `getDeploymentTimeline()`:git log → 每版本 first-landing 時間(346 版本實測);commit time ≈ live time,滯後方向保守(寧願多判 pre-fix);10min TTL cache;失敗 → UNKNOWN 宣告唔阻塞
- `postFixVersionsFor()`:每筆 trade 預計算 postFix 清單,注入 dataLine(`closed=<ISO> postFix=[...]`)——**NEW/STALE 判斷從「LLM 估時序」變「讀清單」,結構性唔可能再錯**
- `alias` 保留完整後綴(P18-attack2 唔縮做 attack2)
- TEMPORAL GROUND RULE:postFix 清單冇嘅 fix = PRE-FIX by definition;STALE severity cap warning

### v2.0.870-P23-fix: Supabase Schema-Drift 韌性(DB 0 靜默死局修復)

**實測根因**:v2.0.869-P9 嘅 insert 加咗 `edge_report` 欄,但 migration 21 從未喺 live DB 執行 → 每 cycle 撞 `PGRST204 column missing` 全失敗 → `asset_analyses` 長期 0 行 → UI 全部卡回退 placeholder(HOLD 58%)→「awaiting analysis / next cycle」徽章。後台分析其實一直正常,死嘅只有 write 層,而且完全無聲(console-only log)。

**修復**:`writeCycle` 撞 PGRST204 → 剝走缺失列(通則:任何列,唔單止 edge_report)重試一次;`lastWriteError` + `getWriteStatus()` expose 到 `/api/supabase-writer`;PostgrestError 係 plain object 嘅 error-text 陷阱(String(err)='[object Object]')順手修。**上線 1 cycle live 驗證 6 行寫入成功。**

### v2.0.870-P22-attack: P22 攻擊輪(觀測持久化 + healer 加固)

4 實證漏洞全修:verifier/calibrator 觀測計數 load() 白名單重建**唔抄** stats/pipeline(restart 歸零 + 注入 string 可級聯污染磁碟)→ 逐欄 sanitize 還原;healer 加 `healInFlight` 重入守衛;`maeMfeNeedsHeal` 加 side 白名單(垃圾 side 會被當 buy 方向性錯寫)。

### v2.0.870-P22: Close-Calibrator 觀測 + MAE/MFE Healer(審計落地 A & G)

**P22-A**:Close-Decision Calibrator 自 v2.0.866 出世零輸入(可校準 close 全部 pre-deploy)——非壞,係 behavioral。落地「飢餓有聲」觀測:`state.pipeline`(closesSeen/recorded/filteredReason/invalidInput/deduped/verified/droppedNoPrice)+ tradeId dedup + `/api/close-calibration`。`verifyPending` 到期無價 → 棄置而非 fake neutral。

**P22-G**:歷史 realTrades min/maxValueReached 混合量度 + sanitize reset 全毀(`median MAE=−900%` artifact)。Healer 用 HL candleSnapshot 權威價格史按 [openedAt, closedAt] 窗口重算 margin-basis equity value(canonical:v2.0.143 init 語義),每筆標記 `maeMfeHealed`。Batch 8/次 per-cycle fire-and-forget,唔阻塞交易。**自測捉住 sell-side adverse/favorable 方向相反 bug**(sell 的最差價係高價,唔係低價——若上線會寫反 min/max)。

### v2.0.870-P20-C: Direction Verifier 飢餓修復(Layer 34 全覆蓋)

**實證**:state `direction=0 / pending=0 / windowStats=0`,`outcome=18 keys / tradeIds=1037` —— C 層(平倉結果)正常,B 層(方向驗證)出世至今零樣本。

**根源兩層**
1. `recordJudgment` 只喺 **activeSymbol buy/sell gate 分支**(index.ts)——其餘 6 個 trading markets 嘅入場決策(perSymbolConsensus 路徑 = 大部分交易量)從未記錄亦從未被 dirTrust 校準。
2. 記錄錨價用 `getMarkPriceForSymbol` 嘅 **latestMarkPrice fallback** —— 非 active symbol 攞到另一 symbol 嘅價做錨點(同 v2.0.864-fix 喺 verify 層發現嘅毒同款,record 層冇修)。

**修復**
- 全覆蓋:perSymbolConsensus 每個 buy/sell 決策(positionSizePct>0)記錄 judgment + dirTrust 乘入 `psc.confidence`(軟乘,clamp [0.80,1.05])。
- `getMarkPriceStrict()`:normalizeSymbol 一致先畀價,唔啱 → null(判斷照記,verify 棄置並計數)。
- **Pipeline 觀測計數**(P19' 教訓:飢餓要有聲):recorded / noEntryPrice / quickVerified / windowVerified / outcomeRecorded / droppedNoPrice / droppedStale48h / keptNoCurrentPrice —— persist 落 state + `/api/direction` 直出。
- Offline replay 驗證(200 實倉行 production 路徑):recorded 200 → quickVerified 200 → 19 direction keys;trust 落地值有意義(`SILVER|1h-down ×0.89`,正正係 24% WR 失血桶)。

**已知結構留意(未郁)**:per-symbol gate 與 activeSymbol gate 校準層唔齊(conviction calibrator / OLR pwinBlend / boost 等仍只在 activeSymbol 分支)。

### v2.0.870-P21: 8·18 SKHX 虧損驗屍三連修(-11.3% 事件)

8·18 06:24 BUY xyz:SKHX $1238.5 → 37 分鐘 -11.3% 收場。驗屍拆解:計劃 SL -0.98% vs 實現 -1.34% = **2.31× 計劃風險**,三大出血點:trailing 收窄 -0.48 / **stop-market 滑價 -0.87**(最大出血點且當時全盲)/ 入口追價 +0.18%。

**P21-A — First-Passage 模型錯配修復**:`sanitizeDriftForRegime()` —— mean_reverting regime 下 GBM drift 係 mirage(實例:SKHX sideways 下 FP 報 P(TP)=100%,實質 edge +71pp 幻覺)。改為 zero-drift limit P = a/(a+b)。重播證明:同交易幾何 drift +0.5% 時 P=0.82,zero 後 P=0.35。

**P21-B — Stop-Slippage SL Floor**:`ExecutionTracker.recordStopExit()` 記錄實測滑價(signed/adverse bps,EWMA+cap20,persist `data/evolution/stop-slippage.json`)→ `SmartSLTP` 以 2× 實測滑價(cap 4%)加闊 SL floor(widen-only,hard-floor invariant 唔郁);final enforcement clamp 喺 leverage stage 之後(第一版被覆寫 → 修)。

**P21-C** = 觀測層(見 P21-B recordStopExit)。**P21-D(prod 唔行 tsx watch)= 暫緩,見 CHANGELOG 暫緩議程。

**副作用披露**:SL 加闊但 TP 冇郁 → RR 跌(重播 1.25→0.68);TP 幾何 = P20-B 議程。

### v2.0.870-P19': Conviction Calibrator Pipeline 修復(Layer 33 閉環)

實計發現 **P19 冗餘**——v2.0.863 `LLMConvictionCalibrator` 已實現 P19 核心機制(5 bin shrinkage,`0.5 + (empiricalWR-0.5)·shrink`)。真正問題 = **數據管線飢餓**:persisted bins 為空,0/200 closed trades 有 `entryConsensusConfidence`。

**雙根源**:(1) entryDataPayload 只喺 `pre`(precomputed features)命中時 build → real-mode 系統性缺;(2) restore helpers 係 allowlist rebuild → 重啟每次剝走新欄位。

**修復**:payload 恒 build(pre features optional)+ spread-first restore(`restoreClosedRealTradeRecord` / `restoreRealPositionRecord`,sanitizer 喺 spread 後行)+ `getCalibrationReport()`(ECE + per-bin gap)+ `/api/calibration` route。順手捉住自 v2.0.868 出世就壞嘅 sanitizeMinMax key-mapping bug({min,max} spread 到錯嘅欄位名)。

**行為披露**:pipeline 修復會**激活** dormant gate 元件(bins ≥20 trades 後開始 remap)→ env `LLM_CONVICTION_CALIBRATION=false` 即時回退。

### v2.0.870-P18-attack2: P18 刁鑽攻擊第三輪(Layer 33 → LLM 穩健性)

5 紅測試實證 5 漏洞全修(glm-5 已退役 chain tail / 截斷尾 JSON 修復器 / fallback body 缺 num_predict+think / Skeptics LLM 回覆型別守衛 / empty content warn-next)。

### v2.0.870-P18: Agent System Prompt 全面重構(主神指令:更精準 × 更慳 token × 完美 output 格式)

**覆核發現嘅重大結構漏洞(P0)**:base default maxTokens=1024 裝唔落 5-symbol 決策 JSON → 結構性截斷 → parse fallback → 全 HOLD 失血。修:base 3072 / Meta 6144 / OLR 3072 + decision-first schema(決策排前,thought 排尾——截斷只切分析)+ omit-null + rationale ≤2句。

**Meta-Agent 67.3KB → 12.5KB(−81%)**:CLOSE 規則曾 4 處寬嚴不一(17 次「≥2」重述、margin 只出現 1 次)、「5 checks」實為 8、版本考古入 prompt、HARD GATE/暗黑心理學重複。重構為單一權威源——語義 parity(thesis gate / 8 checks / FLIP / cond-WR / momentum catalyst / Q-RL / noise-gate 誠實 / News passthrough 全保留),每條規則只定義一次。

**Skeptics ×4:21.5KB → 7.8KB(−64%)**,S1 新增顯式 output schema keys。**Sub-agents:OLR −56% / News −41%(timing matrix 保留)/ RA −51% / Fractal −37% / OnChain −34%**。

**P4 provider JSON mode**:ollama-provider 主路徑 + 503 fallback 加 `format:'json'`(實測 flash done_reason=stop)。**實彈 smoke**:新 Meta prompt 經真 LLM + 真 parser → zero-truncation、合規 action/thesis。

**Guard tests**:`tests/prompt-rearchitecture.test.ts`(體積預算 + 行為錨點 + decision-first + budget 一致性)。每 cycle system prompt ~27k → ~9k tokens(−67%),≈慳 6.5M tokens/日。

### v2.0.870-P16 + P16-attack2 + P17: Hybrid Penalty Decay(混合衰減)+ 攻擊硬化 + Runs Test τ 調製

**背景**:Plan G(v2.0.227)penalty 只喺 idle(冇交易)時衰減(`decayMultiplier = max(0, 1 − idleCycles/30)`)——系統蝕緊錢時 → penalty 高 → 壓制 trade → 繼續蝕(但唔 idle)→ penalty 永遠唔衰減 → death spiral(penaltyFactor 永久卡 floor 0.70)。

**P16 主神方案 20/40/40 權重**(cycle+win / time / edge),三個結構修正:
1. **Time floor**:時間係保底唔係普通加權項(pure weighting 下 48h 只得 38%)
2. **Edge hard-bypass**:極強 edge 完全豁免(唔係只豁免 40%)
3. **Idle floor(回測驅動)**:純加權令 idle-complete 只剩 20% 貢獻(burden +442% 退化)

最終結構 **三層 OR**:`score = max(idleFloor, timeFloor, 0.2·dCW + 0.4·dTime + 0.4·dEdge)`——兩個 floor 保任何單一充分證據完成釋放(嚴格支配舊規則:score ≥ dIdle = 舊 decay),加權項令 wins/edge 喺 floors 未起時率先加速(2 贏 + 中強 edge = 55%)。

**Hard bypass**(極強 edge 唔壓制):wilsonLB ≥ 0.70 + n ∈ [25, 5000] + median > 0(skew trap 守衛)+ EWMA > 0(新鮮度)+ 新鮮窗口 ≤1000 cycles。Graduated edge:wilsonLB 0.55→0.70 線性 0→1,median 缺失/≤0 → ×0.5 保守。

**P16-attack2(刁鑽攻擊第二輪,6 紅測試實證 5 漏洞全修復轉綠)**:
- **V1 CRITICAL**:污染 `combo-win-rates.json`(wins 通脹 100,000/2)→ wilsonLB≈1 → bypass 完全豁免 penalty,spiral 防護永久解除。修:F1 load() sanitize(wins/losses 必須 finite 非負整數 cap 50,000)+ F2 hybrid plausibility(wilsonLB ≤ maxLB(n)=1/(1+z²/n)+0.01、n ≤ 5000 否則成個 edge 通道歸零、|median/ewma| ≤ 300%)
- **V2 HIGH**:EWMA write-only decay → 休眠 combo 嘅陳舊強 edge 喺新 regime 繼續 bypass。修:F3 `ComboWRResult.lastCycle` 暴露,bypass 要求 `currentCycle − lastCycle ≤ 1000`(`PLAN_G_EDGE_STALE_CYCLES`,≈2× EWMA 半衰期);缺 cycle 資訊 → 唔 bypass(保守)
- **V3 HIGH**:`1e999`/負數/小數/字串 wins/losses → wilsonLB=NaN。修:同 F1
- **V4 MEDIUM**:DTC idle hysteresis 全局單例 vs per-symbol idleCycles 輸入(v2.0.228 未收尾)→ 熱/凍 symbol 交替時狀態乒乓,永不到穩態 ±2。修:F4 per-symbol `perSymbolIdleScores` Map(其他 4 factor 輸入係全局指標,共享正確)
- **V5 MEDIUM**:edge lookup 用全局 `combinedState.regime` 查 gateSymbol cell。修:F5 per-symbol regime(`marketState.getState(gateSymbol)`)
- **V6 LOW**:close 雙管道重放雙計。修:F6 `recordEvent(... , tradeId)` + LRU ring(cap 500)

**P17: Runs Test τ 調製(Wald-Wolfowitz 游程檢定)**——時間衰減嘅職責係「證據過時」,過時速度取決於證據係 regime 持續定隨機噪聲:per-symbol outcome ring(cap 30,持久化)→ runs z-score;z ≤ −1.96(連蝕成串 = regime 未完)→ τ_eff = τ × 1.5;|z| < 1.96(運氣)→ τ;z ≥ +1.96(乒乓 = 噪聲)→ τ × 0.75;全蝕(方差零)→ ×1.5;全贏 → ×0.75;n < 15 → ×1.0 冷啟動中性。penalty 對 serial correlation 反應,唔係對運氣反應。

**τ 預設 24h → 12h(主神裁決)**——runs test 調製後實效 9–18h 自適應。

**回測驗證(200 真實 trades / 580h)**:burden −24.9% @τ=12h(180.3 → 135.5 burden-hours;離線 edge/runs=0 保守下界);恢復率不變;synthetic spiral 舊規則 decay 永遠 ≤23% vs hybrid 86%@24h / 95%@36h。

**Env flags**:`PLAN_G_HYBRID_DECAY`(default true,可回滾舊 idle-only)· `PLAN_G_DECAY_TAU_HOURS=12` · `PLAN_G_EDGE_BYPASS_WILSON=0.70` · `PLAN_G_EDGE_BYPASS_SAMPLES=25` · `PLAN_G_EDGE_MIN_SAMPLES=15` · `PLAN_G_EDGE_STALE_CYCLES=1000`

### Files
- `src/analysis/hybrid-penalty-decay.ts` — computeHybridDecayScore 純函數 + computeRunsTestTauMultiplier(P17)+ HybridPenaltyDecayTracker 持久化(`data/evolution/plan-g-decay-state.json`,v2 含 outcome ring)
- `src/analysis/dynamic-threshold.ts` — `setHybridDecayConfig` + `hybridDecay` 輸入(NaN shield legacy fallback)+ F4 per-symbol idle hysteresis
- `src/evolution/combo-win-rate-tracker.ts` — F1 load() sanitize + `ComboWRResult.lastCycle`(F3)
- `src/index.ts` — tracker init/load、`onPositionClosedLearning` recordEvent(trade.id,F6 dedup)、gate edge lookup per-symbol regime(F5)+ freshness cycles + tauMultiplier
- `scripts/plan-g-decay-backtest.ts` — 真實數據回測 + 合成 death spiral 壓力測試(捉到純加權設計缺陷 → 三層 OR 修正)
- `tests/hybrid-penalty-decay.test.ts`(44 測試)+ `tests/hybrid-penalty-decay-attack.test.ts`(12)+ `tests/hybrid-penalty-decay-attack2.test.ts`(6 紅轉綠)
- 全量:2598 pass + 13 pre-existing(gitignored,無新失敗);`tsc --noEmit` 零錯誤

### v2.0.869-P15-attack: RegimeWinRateLearner 攻擊硬化

**背景**:刁鑽攻擊(併發/狀態注入/持久化污染)P15 嘅 RegimeWinRateLearner,發現未來 closedAt 漏洞。

**修復**:
- `getWinRate` clamp dt 到非負——未來 closedAt 唔再令 weight > 1(單一 trade 主導 win rate)
- `recordTrade` + `load` clamp closedAt 到 now——未來 closedAt 唔會入 state

### v2.0.869-P15: Regime-Reversal Profit Lock(組合信號鎖利)

**背景**:盈利倉喺 regime 反轉時鎖利,避免「贏變蝕」。回測驗證:MFE proxy 淨效果 +214%,組合信號(MFE AND regime 反轉)副作用接近 0 → 淨效果接近 +292.70%。

**組件 1:RegimeWinRateLearner**:
- 記錄 (entryRegime, closeRegime, side, symbol, pnl, closedAt) 喺平倉時
- 時間加權混合 win rate:單 symbol 80% + 跨 symbol 20% + weight = exp(−Δt/24h)
- 冷啟動:樣本 < 10 → null(唔鎖);單 symbol 冇數據 → 跨 symbol 兜底

**組件 2:runRegimeReversalLockGate**:
- 組合信號:MFE ≥ 1.5×ATR(峰值)AND P(win) < 0.5(regime 反轉)
- 獨立 gate(唔改 thesis invalidation pre-check),同 PAEL/MFE Lock 並排
- closeReason = 'regime_reversal_lock'(whitelisted + learning weight 0.5)

### v2.0.869-P14: Regime Win-Rate Matrix(開倉×平倉市況)

**背景**:隔 12-24 小時嘅 trade,開倉 regime 同平倉 regime 可以完全唔同。系統之前只捕獲開倉 regime,冇捕獲平倉 regime——學唔到「開倉 regime × 平倉 regime」嘅完整 win rate 矩陣。

**階段 1(捕獲 closeRegime)**:
- `Position` + `TradeRecord` 加 `closeRegime` 字段
- `setCloseRegime()` 方法 + `closeTrade`/`onFills` 平倉路徑 call
- 純加法,零改動,完美兼容現有 agent/落單系統

**階段 2(7×7 win rate 矩陣)**:
- `computeRegimeWinRateMatrix` 純函數——完整 7×7 條件 win rate 矩陣 P(win | entryRegime × closeRegime) + 邊際 win rate + winRateSpread

**階段 3(回測驗證)**:
- `scripts/regime-persistence-backtest.ts`——判斷 winRateSpread 係咪顯著(>20pp 且 n≥10)
- 有顯著 spread → 實施階段 4;冇 → 唔做(避免過度擬合)

### v2.0.869-P13: env 安全加固

**背景**:env 儲存緊 private key,令 env file 參數更安全。

**修復**:
- `chmod 600 .env`(修 world-readable 644)
- config 加 `!command` 支援——private key 可存 OS 安全儲存(macOS Keychain / Windows Credential Manager / Linux Secret Service),唔使明文
- `resolveCommandValues` sanitize 輸出(只攞第一行——去除內部換行)
- `.env.example` 文檔化跨平台方案

### v2.0.869-P12: Macro Gate 持久化修復

**背景**:刁鑽攻擊 MAE 模式升級方案,發現 `profitability-analyzer.ts` 嘅 `load()` 冇載入 `recentPnl`。

**修復**:
- `load()` 加載 `recentPnl`(時間加權蝕錢率 τ=6h)——restart 後 Macro Gate 唔再 reset
- 降權效果透過「新 trade 到來」衰減(唔係純時間)——蝕錢率高持續降權,開始賺錢自動解除

### v2.0.869-P10: MAE 模式持久化污染修復

**背景**:刁鑽攻擊(併發/狀態注入/持久化污染)MAE 模式升級方案,發現 2 個漏洞。

**修復**:
- `load()` 保留 `dataMissing` flag——restart 後 HL pnl 修復前舊樣本(MAE=0/MFE=0)唔再被誤判 'good'
- `load()` 過濾腐敗 mfePct(>MAX_SANITY=300)——1e308 唔再 → ratio=0 → 'good'
- `getMaePattern` filter 加 `Number.isFinite(mfePct)`(防禦性)
- `maxSanity` 提升為 module-level `MAX_SANITY`

### v2.0.869-P8: Distribution Shape Gate + Convexity/Asymmetry Detector

**背景**:以量化金融分析師思路創建超額盈利組件(Kelly Sizing 完全唔需要——主神裁決)。

**組件 1:Distribution Shape Gate(偏度/峰度門)**:
- 樣本偏度(adjusted Fisher-Pearson)+ 超額峰度
- 偵測「肥尾蝕錢」(skew<-0.5 且 kurt>1 = 撿鋼鏰陷阱)→ ×0.75;負偏 → ×0.85;正偏 → ×1.05
- 冷啟動 n<30 → ×1.0

**組件 2:Convexity/Asymmetry Detector(凸性偵測)**:
- Wilson LB(win rate 95% CI 下界)+ 保守 EV(Wilson LB win rate 取代點估計)
- 點 EV 可能 >0 但唔顯著 → 降權;conservativeEV>0 → boost ×[1.0,1.15];<0 → 降權 ×[0.8,1.0]
- 冷啟動 n<20 → ×1.0

**整合**:effectiveConfidence × shapeMultiplier × convexityMultiplier(conviction gate 內)。

## 帳戶模型：Paper（模擬）vs Real（Hyperliquid 真實）⚠️ 前文後理

> **重要**：MATS 有兩套完全獨立嘅帳戶，數據來源唔同，**唔可以混淆**。診斷真實盈虧一定要用 Real 帳戶數據。

| 維度 | Paper 帳戶（模擬） | Real 帳戶（Hyperliquid 真實） |
|:-----|:------------------|:------------------------------|
| **金錢性質** | 虛擬餘額，唔係真錢 | 真實 USDC，HL 鏈上 |
| **初始值** | `config.paper.initialBalance`（`PAPER_INITIAL_BALANCE`, 預設 1000） | HL 錢包持有量（系統無記錄初始值，用 accountValue 睇現值） |
| **數據來源** | `PortfolioTracker`（portfolio.ts）本機計算 | HL API `clearinghouseState`（hyperliquid-engine.ts `getBalance()`） |
| **儲存位置** | `portfolio-state.json` 嘅 `balance` / `totalEquity` / `totalPnl` 欄位 | **唔儲存**——每次啟動重新 fetch（`cachedExchangeBalance`） |
| **變動機制** | Paper 開倉/平倉嘅 margin + fee 加減 | HL 真實撮合、funding、手續費 |
| **未實現 PnL** | 計入 paper `totalEquity`（僅 paper 倉位） | 已包含喺 HL `accountValue`（= free + marginUsed） |
| **已實現 PnL** | paper `totalPnl` | **冇單一數字**——要睇 HL 帳戶自己嘅 accounting |
| **UI 顯示** | Paper mode 先顯示 | Real mode：Genuine Balance / Equity 直接用 HL 值（`serializePortfolio` displayBalance/displayEquity） |

### 關鍵規則

1. **`portfolio-state.json` 嘅 balance 係 paper 值**——診斷真實盈虧用佢係錯嘅。真實盈虧睇 HL `accountValue`（UI「Genuine Balance」）。
2. **Real 倉位從不影響 paper balance/equity**——`recalculateEquity()` 只 loop `portfolio.positions`（paper），`realPositions` 完全唔計。呢個係設計（v2.0.72），唔係 bug。
3. **`realTrades`（closedRealTrades）只含已平倉交易**——未平倉嘅 4 倉位嘅盈利存喺 `realPositions.unrealizedPnl`，未入歷史記錄。
4. **HL `accountValue` 包含未實現 PnL**——`total = free + marginUsed`，所以佢反映「而家」嘅真實權益，包括開倉中嘅浮盈。
5. **Real 帳戶嘅初始值唔追蹤**——系統無記錄 HL 入金量；判斷盈虧要用 accountValue 同主神自己記得嘅入金量對比。

---

## 系統架構（訊號運算後端 + 客戶端執行）

```
┌──────────────────────────────────────────────────────────────┐
│   mats_app（Expo React Native 客戶端）— 執行 + 風險選擇         │
│   • 用戶喺 SettingsSheet 選擇風險等級（high/mid/low → 同一 moderate 格，v2.0.857）│
│   • useAssetAnalyses hook 讀取 Supabase asset_analyses 表       │
│   • useAutoTrade hook 按風險等級 + 持倉狀態揀矩陣格 → 執行      │
│   • Paper mode：寫入 Supabase positions 表（模擬）              │
│   • Real mode：Pro + PK stored → 簽名 + 提交 Hyperliquid        │
│   • 自託管：PK 存喺設備 SecureStorage，後端永不持有             │
│   • trade-bridge：HL WS 市場數據 + on-chain reconciliation      │
└──────────────────────────────────────────────────────────────┘
                            ↑ 讀取
                            │
┌──────────────────────────────────────────────────────────────┐
│   Supabase（asset_analyses 表 — universal per-asset 矩陣）      │
│   • 每個 cycle 後端 DELETE + INSERT 乾淨快照                    │
│   • 一行一 asset，含 1×3 matrix + consensus + marketData        │
│   • RLS：anon/authenticated 可讀；service_role 寫入             │
└──────────────────────────────────────────────────────────────┘
                            ↑ 寫入（service_role）
                            │
┌──────────────────────────────────────────────────────────────┐
│   mats_backend（本系統 — 訊號運算引擎）                         │
│                                                                │
│   Layer 1: 戰略層 (Terminal Agent)                              │
│   • Terminal Agent：用戶自然語言偏好 → Root Command Prompt      │
│   • Cycle 前置規則檢查 + 後置決策核實                           │
├──────────────────────────────────────────────────────────────┤
│   Layer 2: 認知層 (TypeScript + Ollama)                        │
│   • HACP 多模型平行推理（僅關鍵決策點觸發 LLM）                 │
│   • 6 智能體 + Meta-Agent 仲裁 + Skeptics 邏輯審查             │
│   • Entry Thesis System + 暗黑心理學 + 結構化辯論 + 加權投票    │
│   • 認知演化管線（v2.0.868-P1P2: 15 active + Edge Validation + Q-RL Alpha Discovery + Component Attribution + PAEL + LLM World-Model + LLM Direction Verifier + EV Filter + Close-Decision Calibrator + Profitability Analyzer + Entry Quality System；4 組件已移除；v2.0.857 風險等級 moderate-only）│
│   • Plan G Dynamic Threshold [45-55%] + 乘法 Penalty 衰減       │
│   • SystemGuard（5 層系統級保護）                               │
├──────────────────────────────────────────────────────────────┤
│   Layer 3: 訊號輸出層 (Analysis Matrix Builder + Supabase)     │
│   • buildAssetAnalysis()：共識 → 1×3 矩陣（v2.0.857）           │
│   • SupabaseAnalysisWriter：每 cycle 寫入 asset_analyses 表     │
│   • ANALYSIS_MODE：true=僅訊號 / dual=訊號+執行 / false=僅執行  │
├──────────────────────────────────────────────────────────────┤
│   Layer 4: 執行層（dual mode 時啟用，TypeScript Runtime）       │
│   • Hyperliquid WebSocket（l2Book + trades + userFills）+ REST  │
│   • 風險引擎（毫秒級，無需 LLM）· Paper/Real Trading Manager    │
│   • 倉位追蹤 & SL/TP · Position Reconciliation                 │
│   • 數據管道 & 持久化 & 可觀測性                                │
└──────────────────────────────────────────────────────────────┘
```

**`ANALYSIS_MODE` 環境變數**（`src/index.ts` line ~255）：
- `'true'` — 僅計算訊號 + 寫入 Supabase，唔下單（純訊號後端模式）
- `'dual'` — 同時計算訊號 + 寫入 Supabase + 執行交易（paper/real）
- `'false'` — 僅執行交易，唔寫入 Supabase（legacy 獨立交易模式）

---

## 專案結構

```
src/
├── agents/                  # 8 agents + Meta-Agent（訊號運算用）
│   ├── base-agent.ts        # LLM call + retry + confidence
│   ├── meta-agent.ts        # 仲裁 + entryThesis 生成
│   ├── skeptics.ts          # 邏輯審查 + thesis 驗證（Phase 0.5/1.5/1.8）
│   └── agents.ts            # 5 sub-agents
├── cognition/
│   ├── hacp.ts              # HACP 協議（Phase 0-5）
│   └── a2a-utils.ts         # A2A 信號交換
├── llm/                     # LLM 抽象層（provider + circuit breaker + concurrency 4）
├── trading/                 # portfolio · paper-engine · trading-manager · hyperliquid-engine · position-utils · cost-model
│   │   v2.0.172: real-trading-manager → trading-manager, hyperliquid-real-engine → hyperliquid-engine
│   │   v2.0.173: position-utils.ts 共享 helper（computeSLTP, recomputePnL, trackMAEMFE）
│   │   v2.0.143: executeTrade() / closeTrade() 統一路由
├── risk/                    # 風險引擎 + correlation-budget
├── system-guard/            # 5 層保護閘門
├── evolution/               # 自我演化（認知演化管線：OLR + Shadow + First-Passage + EM + GA + RIL + EXP + NA + AttnRes + Anti-Pattern + Combo WR + P(win) Discount + Close-Context Learning v2.0.226 + Plan G v2.0.227 + Q-RL Alpha Discovery v2.0.835。v2.0.833 移除 temporal-attention/cross-symbol/reward-shaping/world-model；暫停 active-exploration）
│   ├── embeddings.ts        # Transformers.js MiniLM 384-d 向量（in-process, singleton v2.0.216）
│   ├── thesis-experience.ts # EXP 理據組合歷史勝率（方向過濾 + lesson persistence v2.0.207 #E）
│   ├── experience-digester.ts # A2A 經驗消化（per-direction winRate + LessonStatement v2.0.207）
│   ├── cycle-summary.ts     # EM Cycle Chain（market continuity, dual-channel v2.0.206 #6）
│   ├── numeric-autoencoder.ts # Numeric Autoencoder（11→16→8 learned embedding, v2.0.204+v2.0.223 anti-collapse）
│   ├── combo-win-rate-tracker.ts # (symbol×side×regime) WR tracker（Wilson LB, v2.0.221）
│   ├── cycle-history-retrieval.ts # AttnRes Cycle-History（dual pseudo-query, v2.0.211-v2.0.212）
│   ├── attnres-trade-embedder.ts # AttnRes trade embedder（anti-collapse v2.0.217）
│   ├── anti-pattern-tracker.ts # Anti-Pattern clustering（failure lessons, v2.0.207 #F）
│   ├── replay-buffer.ts     # Experience Replay Buffer（PER, mini-batch retrain, v2.0.219）
│   ├── bayesian-olr.ts     # Bayesian OLR wrapper（MC Dropout uncertainty, v2.0.219；paused w/ exploration v2.0.833）
│   ├── active-exploration.ts # Active Exploration（UCB + info gain, v2.0.219；PAUSED v2.0.833: ACTIVE_EXPLORATION_ENABLED=false）
│   ├── reason-analytics.ts  # RIL（per-direction win rates + direction-filtered similar trades v2.0.176）
│   ├── evolution-utils.ts   # 共享 utils（safeNum v2.0.218, wilsonScore, computeVectorConditionalWinRate + rmsNormKeys + softmaxWeightedWR v2.0.211）
│   ├── q-rl-table.ts       # Q-RL Alpha Discovery（270-cell Q-table, ε-greedy, BH-FDR, v2.0.835）
│   ├── ann-index.ts        # ANN Index for EXP（IVF + spherical k-means, 10k records, v2.0.843）
│   ├── meta-learner.ts     # Meta-Learner（adaptive α + asset-aware feature weights, v2.0.840+843）
│   ├── self-improver.ts    # Self-Improver（Thompson Sampling bandit + OLS gradient, v2.0.838）
│   ├── causal-reasoner.ts  # Causal Reasoner（paired shadow uplift + permutation importance, v2.0.839）
│   ├── meta-calibrator.ts  # Meta-Cognitive Calibrator（Brier score + ECE, per-regime, v2.0.837）
│   │   # v2.0.833 REMOVED + v2.0.862 DELETED: temporal-attention.ts, cross-symbol-backbone.ts, reward-shaping.ts, world-model.ts
│   ├── direction-audit.ts   # LLM 交易記錄審計（v2.0.180）
│   └── system-engineer.ts   # 自主代碼工程師 Agent（v2.0.182）
├── analysis/                # sentiment · S/R · ATR（momentum-adaptive SL v2.0.207 #C）· planck-chaos · options · news
├── market-agent/            # 自動 pair 選擇（9 DEX, 416 assets, 類別過濾）
├── data/                    # Hyperliquid + Binance WebSocket
├── services/                # v2.0.822: Analysis Matrix + Supabase writer
│   ├── analysis-matrix.ts   # buildAssetAnalysis()：共識 → 1×3 風險矩陣（v2.0.857）+ edgeReport 注入（v2.0.833）
│   ├── supabase-writer.ts   # SupabaseAnalysisWriter：每 cycle 寫入 asset_analyses 表（v2.0.822+823）
│   ├── bstocks-wallet.ts    # v2.0.870-P51: Binance Agentic Wallet（baw CLI 包裝：signIn/verify/getStatus/swap/getBalance/saveAddress）
│   ├── bstock-data.ts       # v2.0.870-P54: bStock 數據源（type=3 list + Binance spot price + API 4 isTradable）
│   └── x402-calls.ts        # v2.0.870-P54: x402 呼叫（CMC 4 designated tools + Agent Studio async）
├── edge/                    # v2.0.833: Edge Validation Layer（alpha 測謊機）
│   ├── edge-config.ts       # Zod env var：threshold + weight + sample cap 10000
│   ├── edge-calculator.ts   # Task 1A：5-component regime-weighted edgeScore
│   ├── execution-tracker.ts # Task 1B：slippage + funding → 可實現 PnL 校準
│   ├── stability-monitor.ts  # Task 1C：perturbation + cross-time 穩定性
│   ├── backtest-validation.ts # Sharpe/Sortino/Calmar/PF/bootstrap/DSR/walk-forward
├── api-server.ts            # REST + SSE (:3456) + static UI（legacy）
└── index.ts                 # 系統 orchestrator（決策循環 + 矩陣寫入 ~line 9458）
ui/                          # Legacy React + Vite dashboard（已由 mats_app 取代）
data/evolution/              # olr-state · shadow-state · patterns · GA state · em-state · na-model · cycle-history · anti-patterns
tests/                       # vitest（~3,000 tests / 186 suites，gitignored；3035 pass / 13 pre-existing）
supabase/migrations/         # 00000000000018_asset_analyses_matrix.sql（v2.0.822）
```

## Analysis Matrix + 風險設定架構（v2.0.822）

**核心設計**：後端每個 cycle 為每個 asset 計算一個 HACP 共識，然後擴展成 **1×3 推薦矩陣**（v2.0.857 由 3×3 縮減——moderate-only），寫入 Supabase `asset_analyses` 表。客戶端讀取矩陣，按用戶當前持倉狀態揀選對應格。

### 1×3 矩陣結構（v2.0.857 moderate-only）

```
              │  long（已持多）  │  short（已持空）  │  flat（無倉位）
─────────────┼────────────────┼─────────────────┼────────────────
moderate     │  baseline（已校準）│  baseline         │  baseline
```

**風險等級對應**（客戶端 `mats_app` `useAutoTrade.ts` `mapRiskProfile()`）：
| 客戶端 UI（SettingsSheet）| 後端矩陣 key | conviction 縮放 | 校準狀態 |
|:-------------------------|:------------|:----------------|:--------|
| `high` | `moderate`（v2.0.857 單一）| ×1.0（baseline）| `calibrated: true`（live consensus）|
| `mid` | `moderate` | ×1.0（baseline）| `calibrated: true`（live consensus）|
| `low` | `moderate` | ×1.0（baseline）| `calibrated: true`（live consensus）|

> ⚠️ v2.0.857：後端只運算 moderate 一行。客戶端 high/mid/low 全部映射到同一 moderate 格——真正嘅風險控制係客戶端自己嘅 Position Size / Max Portion / Leverage sliders，唔係矩陣。

**矩陣格 action**（`mapAction()` 按 rawAction + closePosition + posState 推導）：
| 持倉狀態 │ buy 共識 → │ sell 共識 → │ hold/close → │
|:--------|:-----------|:------------|:-------------|
| `flat` | `buy` | `sell` | `hold` |
| `long` | `hold` | `flip` | `hold`（或 `close` 若 closePosition）|
| `short` | `flip` | `hold` | `hold`（或 `close` 若 closePosition）|

**`moderate` = 已校準 baseline**：使用 live consensus 機制（conviction gate、OLR blend、combo WR override）。v2.0.857 後 aggressive/conservative placeholder 已移除——`buildProfileCell()` 只輸出 moderate 格，conviction 係 live consensus 原值。

### 寫入路徑（`src/index.ts` ~line 9458）

```
HACP consensus result
  ↓
for each symbol in (activeSymbol ∪ tradingMarkets ∪ pscList):
  ↓
  buildAssetAnalysis(symbol, psc, marketState, cycleId, pwin, agentsAligned, agentsTotal)
    ↓
    mapAction() → per (posState) cell
    buildProfileCell() → moderate conviction（live consensus，無縮放）
    buildMatrix() → 1×3 AnalysisMatrix（v2.0.857）
    ↓
    AssetAnalysis { symbol, cycleId, marketData, consensus, matrix, metadata }
  ↓
analysisWriter.writeCycle(analyses[])
  ↓
SupabaseAnalysisWriter：DELETE all rows → INSERT fresh batch（clean-snapshot）
  ↓
asset_analyses 表（RLS：anon 可讀，service_role 寫入）
```

### 客戶端讀取路徑（`mats_app`）

```
useAssetAnalyses(cycleMinutes) → fetchAssetAnalyses() → Supabase asset_analyses
  ↓
useAutoTrade(analyses, settings, user, positions)
  ↓
  mapRiskProfile(settings.riskProfile)  // high/mid/low → 全部 moderate（v2.0.857 單一 row）
  inferPositionState(symbol, positions) // long/short/flat
  getRecommendedAction(analysis, posState) → matrix.moderate[state]
  ↓
  action: buy/sell/hold/close/flip + conviction + rationale
  ↓
  Paper mode → 寫入 Supabase positions 表
  Real mode（Pro + PK）→ 簽名 + 提交 Hyperliquid
```

### Supabase 表結構（`supabase/migrations/00000000000018_asset_analyses_matrix.sql`）

```sql
create table public.asset_analyses (
  symbol      text primary key,           -- 一行一 asset
  cycle_id    bigint not null,
  updated_at  timestamptz not null default now(),
  market_data jsonb not null,  -- { price, volatility, regime, change24h, volume24h }
  consensus   jsonb not null,  -- { action, confidence, thesis, pwin, agentsAligned, agentsTotal, stopLoss, takeProfit, suggestedLeverage }
  matrix      jsonb not null,  -- 1×3: { moderate: { long|short|flat: { action, conviction, rationale, calibrated } } }（v2.0.857）
  metadata    jsonb not null
);
-- RLS：anon/authenticated 可讀（universal market intelligence）；service_role 寫入
```

---

## 後端帳戶風險設定（v2.0.822+ → ⚠️ v2.0.857 moderate-only — Backend Account Risk Profile）

**與客戶端風險等級嘅分別**：呢個係兩個獨立概念。
- **客戶端風險等級**（`mats_app` `TradingSettings.riskProfile`）：仍然存在（high/mid/low），但 v2.0.857 後全部映射到同一 moderate 矩陣格——真正嘅風險控制係客戶端自己嘅 Position Size / Max Portion / Leverage sliders。
- **後端帳戶風險設定**（`MarketAgentConfig.riskProfile`）：**v2.0.857 移除 aggressive/conservative——恆為 `moderate`**。`setRiskProfile()` 將任何非 moderate 值 coerce 成 moderate（warn）；`getRiskProfile()` 永遠返回 `'moderate'`。後端以 moderate 校準執行交易，唔再做 per-profile 區別。

### 單一風險等級（v2.0.857）

| 等級 | UI 顯示 | Threshold 倍率 | Conviction 校準 | 倉位大小傾向 | 平倉敏感度 |
|:-----|:--------|:--------------:|:----------------|:------------|:-----------|
| `moderate` | Mode | × 1.00（baseline，無 profile multiplier） | 誠實輸出 | 分析支持嘅大小 | 標準（thesis 失效 + ≥2 條件） |

### 三層執行機制（v2.0.857 更新）

```
Layer 1: Prompt 層（Meta-Agent system prompt）
  ─ getMarketDescription() 注入 "Risk Profile: MODERATE" 行
  ─ 所有 7 個 agent 見到（5 sub-agents + Skeptics + Meta-Agent）
  ─ Meta-Agent system prompt 有 moderate-only RISK PROFILE CALIBRATION 段落（v2.0.857：
    3-profile 段落移除，慳 ~4.7KB context/cycle）
  ─ 核心原則：風險等級調整 RISK APPETITE，唔調整 ANALYTICAL RIGOR

Layer 2: Code 層（Plan G conviction gate，src/index.ts）
  ─ adjustedThreshold = clamp(effectiveThreshold, 0.30, 0.70)
  ─ v2.0.857：NO profile multiplier（aggressive ×0.85 / conservative ×1.15 已移除）
  ─ clamp [0.30, 0.70] 保留作為 safety net——唔會魯莽，唔會癱瘓

Layer 3: Multi-symbol 路徑（src/index.ts）
  ─ 同樣無 multiplier——pscAdjustedThreshold = clamp(pscFilter.getConvictionThreshold(), 0.30, 0.70)
```

### API + 持久化（v2.0.857 更新）

| 層 | 檔案/位置 | 說明 |
|:---|:---------|:-----|
| Type | `src/types/index.ts` `MarketAgentConfig.riskProfile` | `RiskProfile` type（v2.0.857 deprecated——只係爲 backward-compat READING 保留）|
| Config | `src/market-agent/index.ts` | `setRiskProfile()` coerce 到 moderate + warn；`getRiskProfile()` 永遠返回 `'moderate'` |
| Persistence | `src/evolution/persistence.ts` | load 時 coerce 歷史 aggressive/conservative → moderate |
| API | `POST /api/market-agent/risk-profile` | 只接受 `'moderate'`（其他值 400 + clear message）|
| Callback | `src/index.ts` `setMarketAgentSetRiskProfileHandler` | `marketAgent.setRiskProfile()` + `pushToAPI()` |
| UI | `ui/src/App.tsx` | v2.0.857 移除 3-segment slider（Position Size / Max Portion / Leverage 保留）|
| Agent context | `src/market-agent/index.ts` `getMarketDescription()` | 注入 `Risk Profile:` 行到所有 agent |
| Meta-Agent prompt | `src/agents/meta-agent.ts` `getSystemPrompt()` | moderate-only `RISK PROFILE CALIBRATION` 段落 |

### 向後兼容

舊 `market-agent-config.json` 冇 `riskProfile` → 預設 `'moderate'`。歷史持久化狀態（component-attribution.json / rp-edge-store.json）可能帶 aggressive/conservative 值——read-tolerant（load 唔 crash），永不重新寫入。

### System Engineer Agent（v2.0.201）

第 9 個 agent — 自主代碼工程師。每 2 個 cycle 運行一次。

### `runSystemEngineer()` 方法（v2.0.201 兩階段審計）

```
┌─────────────────────────────────────────────────────────────────────┐
│  runSystemEngineer(records: ThesisExperienceRecord[])               │
│                                                                     │
│  ┌─ 並發保護 ─────────────────────────────────────────────────────┐ │
│  │ if (engineerRunning) → skip（防止重疊運行）                      │ │
│  │ engineerRunning = true（module-level lock）                      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 載入上下文 ───────────────────────────────────────────────────┐ │
│  │ • SystemEngineer.md（操作手冊，截取前 2000 字）                   │ │
│  │ • ARCHITECTURE.md（系統架構，截取前 2000 字）                     │ │
│  │ • CHANGELOG.md（最近 3 個版本）                                   │ │
│  │ • loop-engineering-memory.md（已知 bug，截取前 1500 字）          │ │
│  │ • 最近 20 筆交易記錄摘要（side/symbol/outcome/pnl/hold/regime/   │ │
│  │   marketFeatures/olrPWin/shadowWinRate/entryThesis）              │ │
│  │ • Per-Symbol Direction Summary（BUY/SELL 各自勝率）               │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ Phase 1: 診斷（Diagnosis）────────────────────────────────────┐ │
│  │ • readFileSummaries()：10 個關鍵文件各取前 50 行 + test 文件列表  │ │
│  │ • LLM 收到：上下文 + 交易摘要 + 文件摘要 + Known Good Code 警告   │ │
│  │ • LLM 回傳 JSON：{ title, rootCause, affectedFile, diagnosis }   │ │
│  │ • 溫度 0.2 · timeout 60s · model = terminal_agent                │ │
│  │ • 無 actionable issue → return null                              │ │
│  │ • 失敗記憶檢查：同 file+title 1 小時內失敗過 → skip              │ │
│  │ • 範圍驗證：isFileAllowed() → 不在 ALLOWED_PREFIXES → REJECT     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ Phase 2: 精確修復（Exact Fix）────────────────────────────────┐ │
│  │ • 讀取目標文件完整內容（全部行數，不截斷）                        │ │
│  │ • LLM 收到：Phase 1 診斷結果 + 完整源代碼                        │ │
│  │ • LLM 回傳 JSON：{ proposedFix: { oldCode, newCode, reason },    │ │
│  │   testUpdate: { file, oldCode, newCode }, changelogEntry }       │ │
│  │ • 溫度 0.1（更精確）· timeout 60s                                │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ oldCode 匹配（三層防幻覺）─────────────────────────────────────┐ │
│  │ 1. 精確匹配：originalContent.includes(oldCode)                   │ │
│  │ 2. 模糊匹配（v2.0.201）：trim + collapse whitespace →            │ │
│  │    逐行 trimmed 比較找到精確位置 → 用文件實際文本替換 oldCode     │ │
│  │ 3. 全部失敗 → 標記 "hallucination detected" → return null        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 應用修改 ─────────────────────────────────────────────────────┐ │
│  │ • writeFileSync(targetFile, newContent)                          │ │
│  │ • 如有 testUpdate → 同樣精確匹配 + 寫入測試文件                   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 安全網驗證 ───────────────────────────────────────────────────┐ │
│  │ 1. tsc --noEmit（timeout 30s）                                   │ │
│  │    → 失敗：捕獲 stdout/stderr 錯誤輸出（v2.0.199）                │ │
│  │ 2. npm test（timeout 60s，僅在 tsc 通過後運行）                   │ │
│  │    → 解析 vitest 摘要行 "Tests  X passed (Y)"（v2.0.201）         │ │
│  │    → 舊邏輯 !output.includes('failed') 會被 log 警告誤判          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 決策分支 ─────────────────────────────────────────────────────┐ │
│  │ tsc ✓ + test ✓ → SUCCESS:                                       │ │
│  │   • updateChangelog(changelogEntry)                              │ │
│  │   • updateArchitecture(architectureUpdate)（如有）                │ │
│  │   • git add -A && git commit                                     │ │
│  │   • appendRecommendation(result, true)                           │ │
│  │   • process.exit(42) → engineer-loop.sh 重啟進程                  │ │
│  │                                                                   │ │
│  │ tsc ✗ 或 test ✗ → ROLLBACK:                                     │ │
│  │   • 恢復原始文件內容（writeFileSync 原始內容）                     │ │
│  │   • 恢復原始測試文件內容                                          │ │
│  │   • failedFixes.set(key, timestamp) → 1 小時冷卻                 │ │
│  │   • appendRecommendation(result, false)                           │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 鎖釋放 ───────────────────────────────────────────────────────┐ │
│  │ finally: engineerRunning = false（雙層 try/finally 保證釋放）    │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**關鍵設計決策**：

| 決策 | 原因 |
|:-----|:-----|
| **兩階段而非單階段** | 單階段只展示 150 行/文件，LLM 看不到 line 472 的 `recordClose` → 幻覺 oldCode。Phase 1 用 50 行摘要診斷，Phase 2 發送完整文件生成精確 oldCode |
| **模糊 oldCode 匹配** | LLM 常把縮排/空格弄錯但代碼正確。trim + collapse whitespace 後逐行 trimmed 比較，找到精確位置後用文件實際文本替換 |
| **vitest 摘要行解析** | 舊邏輯 `!output.includes('failed')` 被 log 警告（"digestTrade LLM failed"）誤判為測試失敗。改為解析 `Tests  X passed (Y)` 摘要行 |
| **失敗記憶 1h 冷卻** | 同一 file+title 修復失敗後 1 小時內不重試，避免無限循環 |
| **雙層 try/finally** | 外層 finally 保證 `engineerRunning = false` 即使 `process.exit(42)` 也能釋放鎖 |
| **溫度 Phase 1 = 0.2 / Phase 2 = 0.1** | 診斷需要些許創意，精確修復需要高度確定性 |

**可修改範圍**：`src/evolution/` + `src/cognition/` + `src/analysis/` + `src/agents/` + `tests/`
**禁止修改**：`src/trading/` + `src/config/` + `src/index.ts` + `.env` + `src/api-server.ts` + `src/data/`
**安全網**：tsc --noEmit + npm test 必須全部通過，否則自動 rollback
**模型**：GLM-5.2（預設）
**並發保護**：module-level `engineerRunning` lock，防止重疊運行
**失敗冷卻**：同一修復失敗後 1 小時內不重試（`FAILED_FIX_TTL_MS = 3600_000`）

---

## 智能體系統

| # | Agent | 溫度 | 權重 | 角色描述 |
|:-:|:------|:----:|:----:|:---------|
| 0 | **Terminal Agent** | 0.30 | — | 用戶自然語言偏好入口。接受交易偏好指令 → LLM 整合 → Root Command Prompt。Cycle 開始前檢查規則（時間/條件/資產），不符合即 abort cycle。Meta-Agent 決策後核實是否符合 Root Command Prompt。預設 DeepSeek V4 Flash。**註**：v2.0.822+ 風險等級（high/mid/low）由客戶端 `mats_app` SettingsSheet 選擇；v2.0.857 後端只運算 moderate 矩陣。 |
| 1 | **Trading Setup** | — | — | 交易配置管理（非 LLM agent）。Trade Mode、Cycle Period（1-10m）、Position Size、Max Portion、Leverage、Asset Type、Available Pairs、Selected Market Pairs。UI 控件直接連接後端。 |
| 2 | **Fractal Momentum Sentinel** | 0.85 | 0.10 | 多時間框架碎形自相似模式檢測。趨勢加速早期信號。極端逆向，中間趨勢追隨。預設 Kimi K2.6。 |
| 3 | **On-Chain Whisperer** | 0.50 | 0.10 | 類別感知鏈上分析。Crypto: mempool/flows/supply。TradFi: DXY/COT/商品/COT 持倉。5 分鐘緩存。預設 Kimi K2.6。 |
| 4 | **OLR & Sentiment Analyst** | 0.25 | 0.10 | OLR P(win) per side + First-Passage path-risk + Fear & Greed。RR-aware：P(win) 對 breakevenP 計 edge。PRIMARY factor。預設 Kimi K2.6。 |
| 5 | **News Reporter** | 0.40 | 0.20 | **Institutional Narrative Decoder**。5 部分框架：信息不對稱先驗、價格-新聞時機矩陣、6 桶動機分類、權力圖、淨機構調整信號。L3 Meta-Agent 決定性權重。預設 DeepSeek V4 Flash。 |
| 6 | **Independent Risk Auditor** | 0.10 | 0.25 | **advisory-only（不可 veto）**。TP/SL/size 建議 + 硬性代碼限制。預設 DeepSeek V4 Flash。 |
| 7 | **Skeptics** | 0.30 | 0.00 | 邏輯審計員 + 壓力測試員。**Approve-First**。Phase 1.5 審查 5 sub-agents；Phase 1.8 驗證 entryThesis；Phase 0.5 每循環重新驗證持倉 thesis。預設 DeepSeek V4 Flash。 |
| 8 | **Meta-Agent** | 0.45 | 0.00 | 仲裁主席。偵探模式。生成 entryThesis。使用 Confidence Calibration Framework。權重 0.00（理據系統控制，唔靠投票）。預設 DeepSeek V4 Flash。 |
| 9 | **System Engineer** | 0.20 | — | 自主代碼工程師。每 2 個 cycle 審查交易記錄 + 源代碼，檢測學習系統漏洞，自動修復並通過 tsc+test 安全網。v2.0.201 兩階段審計：Phase 1 診斷（文件摘要 50 行 + 交易數據 → LLM 識別 file+issue），Phase 2 精確修復（完整文件內容 → LLM 生成 exact oldCode/newCode）。模糊 oldCode 匹配（trim + collapse whitespace）。vitest 摘要行解析測試結果。讀取 SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md。可修改 src/evolution/ + src/cognition/ + src/analysis/ + src/agents/ + tests/。禁止觸碰 src/trading/ + src/config/。預設 GLM-5.2。 |

> **權重說明**：Meta-Agent + Skeptics 權重 0.00 — 佢哋透過 thesis 系統控制決策，唔參與投票。5 個 sub-agent 加權投票，consensus threshold 50%（由 Evolution 動態調整，floor 0.49）。Terminal Agent 不參與投票，只做規則檢查 + 決策核實。System Engineer 不參與投票，只做代碼審查 + 自主修復。Trading Setup 不是 LLM agent，是 UI 配置管理。

---

## HACP 高速認知協議

每 **1-10 分鐘**（用戶可調整 Cycle Period）觸發一次決策循環。

```
PHASE -1  Terminal Agent 規則檢查（Cycle 開始前）
          • 載入 Root Command Prompt → 逐條評估規則（時間/條件/資產/方向）
          • 任一規則失敗 → abort cycle（不跑任何 agent，不花 token）
          • 全部通過 → 注入 Root Command Prompt directive 到所有 agent context
PHASE 0   Trading Setup 市場選擇 + Position Reconciliation
          • 選取最高 volume pair · real mode 同步 exchange 倉位
          • v2.0.858: 市場選擇喺 cycle 期間完全開放（唔再 block）——
            snapshot 於 cycle 開始時凍結 allSymbols/_additionalMarkets，
            中途新增資產自動由 post-cycle symbol-set drift check 觸發
            immediate follow-up cycle，唔使等 300s
PHASE 0.5 Skeptics 入場理據重新驗證（每個持倉）
          • thesis 失效 → 強制平倉
PHASE 1   平行思考（5 sub-agents, 60s deadline race, staggered 6s）
          • 每個 agent 收到 Root Command Prompt directive（行為約束 + 風格調整）
PHASE 1.5 Skeptics 邏輯審查（逐一審查 5 sub-agent 決策）
          • 參考每個 Agent 歷史 track record · Approve-First
PHASE 1.75 Meta-Agent 仲裁
          • 生成 entryThesis / holdReason / closePosition
          • 接收 RIL reference data
          • 使用 Confidence Calibration Framework
PHASE 1.8 Skeptics 驗證 Meta-Agent entryThesis
          • 拒絕即 HOLD
PHASE 2-4 結構化辯論（1-3 rounds，unanimous 可跳過）
PHASE 5   加權投票共識（50% threshold，動態調整）+ 執行
PHASE 6   Terminal Agent 決策核實（Meta-Agent 決策後）
          • 核實決策是否符合 Root Command Prompt 要求
          • 核實是否符合用戶指定的交易風格
          • 不符合 → 覆蓋為 HOLD（不執行）
```

**Terminal Agent 雙重角色**：
1. **Cycle 前置**（Phase -1）：檢查 Root Command Prompt 規則，不符合 abort
2. **Cycle 後置**（Phase 6）：核實 Meta-Agent 決策是否符合用戶偏好

**Root Command Prompt**：用戶透過 Terminal Agent UI 輸入自然語言交易偏好，LLM（DeepSeek V4 Flash）整合成結構化指令。只接受行為指令（決策風格、交易偏好、時間規則），不接受 config 設定（position size、leverage 等由 Trading Setup 管理）。

**時間預算**：Phase 1 平行 ~60s · Skeptics ~10s · Meta-Agent ~10s · 辯論 ~30s · 120s hard timeout → HOLD。

**共識閾值動態調整**：idle（連續 HOLD）→ 降閾值鼓勵交易；loss streak → 降閾值但配合減倉；regime=chaotic → 升閾值。

---

## Entry Thesis System + Skeptics

**Entry Thesis**：Meta-Agent 開倉時必須提供 `entryThesis = "[1h: <短線原因>] [1d: <中線原因>]"`。Skeptics Phase 1.8 驗證：強而有力、數據驅動、暗黑心理學審查（大戶操縱？）、事實扭曲檢查。拒絕即 HOLD。

**Thesis 凍結**：`entryThesis` 喺開倉時凍結為「原始理據」，之後永不覆寫。`holdReason` 保留為 live 每循環 reasoning（可自由更新）。

**Thesis 重新驗證（Phase 0.5）**：每循環 Skeptics 重新驗證所有持倉嘅 entryThesis。失效條件：catalyst 已耗、結構破壞、方向 contradicted、1h timeframe 過期。失效 → 強制平倉。

**平倉規則**：CLOSE 必須 thesis 失效（強制）+ ≥2 其他條件。Thesis 仍有效 → HOLD，無例外。

**提早平倉防護**：Meta-Agent CLOSE 決策前強制 5 重檢查：
1. PRICE LEVEL — 是否真正突破 S/R？
2. SL/TP CHECK — 是否已觸發？
3. TIME CHECK — 持倉 ≥15min？
4. EXPERIENCE DIGEST — 高 premature 率 → 格外保守
5. DIRECTION — OLR 仍支持 → HOLD

Skeptics 預設改為 VALID / BLOCK（when in doubt, keep open）。

**Skeptics Approve-First**：預設 APPROVE，只係喺搵到具體、會導致輸錢嘅 material flaw 時先 REJECT。唔因「low confidence」「could be manipulation」等弱理由 reject。Error fallback = APPROVE。

---

## RIL — Reason Intelligence Layer

> 核心哲學：**俾 Meta-Agent 數據去 reason，唔係幫佢 decide。**

RIL 提供三層結構化 reference data，令 Meta-Agent 可以極限運用歷史經驗做出最趨利避蝕嘅最優判斷。

### 三層參考數據

```
Layer 1: RIL（primary）— 結構化 reference data
  ─ PatternClusterManager：greedy cosine clustering of rationale texts（MiniLM 384-d）
    → 每個 entry pattern 嘅 WR/PnL/count，injected 做 ENTRY PATTERN PERFORMANCE
    → v2.0.143：recordClose 後即時 addTrade() 更新 cluster（之前只在 startup rebuild）
  ─ CloseReasonAggregator：pure math GROUP BY exitType+origin
    → 每個 close reason 嘅 WR/PnL/count，injected 做 CLOSE REASON PERFORMANCE
    → v2.0.143：使用真實 exitType（sl_tp/consensus/manual/thesis_invalidation）而非 'unknown'
  ─ SimilarTradeRetriever：top-N similar trade retrieval by combination similarity
    → v2.0.143：在 EXP gate 後、Skeptics 驗證前注入 candidate 的相似歷史交易
  ─ SubtleDiffAnalyzer：1 LLM call per cycle for subtle differences analysis
    → v2.0.143：比較候選交易 vs 相似歷史贏家/輸家嘅微妙差異（volume/RSI/regime/S/R）

Layer 2: EXP（supplementary reference）— 向量相似度 reference
  ─ checkThesisHistory() 保留，但 inject 做 reference block，唔係 binary gate
  ─ Meta-Agent 見到 EXP verdict + Dual-Channel Fusion 結果，自己 decide

Layer 3: A2A Digester（supplementary reference）— LLM 角度 supplementary analysis
  ─ getDigestSummary() 保留，inject 做 supplementary text block
  ─ 提供 LLM-based root cause + exit quality analysis
```

### Confidence Calibration Framework

Meta-Agent 同 Skeptics 使用完整 confidence calibration framework：

```
Step 1: BASE confidence = pattern WR（from ENTRY PATTERN MAP）
Step 2: Adjust for close reason context（from CLOSE REASON STATS）
         ─ 如果 losses 係 premature → 方向可能啱，confidence UP
         ─ 如果 losses 係 correct_sl → 方向錯，confidence DOWN
Step 3: Adjust for subtle differences（from SIMILAR TRADES）
         ─ Count strengthening vs weakening factors
         ─ Net positive → confidence +5-15%
         ─ Net negative → confidence -5-15%
Step 4: FINAL confidence → decision

FINAL CONFIDENCE:
  >= 70% → ENTER standard size, SL at S/R, TP at S/R
  50-69% → ENTER reduced size (50-75%), wider SL (1.5-2x)
  30-49% → ENTER minimal (25%) OR HOLD
  < 30%  → HOLD
```

### 核心檔案

| 檔案 | 說明 |
|:-----|:-----|
| `src/evolution/reason-analytics.ts` | RIL core：PatternClusterManager + CloseReasonAggregator + SimilarTradeRetriever + SubtleDiffAnalyzer |
| `src/evolution/embeddings.ts` | Transformers.js MiniLM 384-d embedding provider + vector math |
| `src/evolution/thesis-experience.ts` | EXP vector memory（reference data source，非 gate） |
| `src/evolution/experience-digester.ts` | A2A LLM digestion（supplementary analysis） |

---

## 自我演化系統

MATS 嘅核心競爭力係**認知演化管線**（v2.0.868-P1P2: 15 active + 1 Edge Validation + 1 Q-RL Alpha Discovery + 1 Component Attribution + 1 PAEL Exit-Price Learner + 1 LLM World-Model Layer + 1 LLM Direction Verifier + 1 EV Filter + 1 Close-Decision Calibrator + 1 Profitability Analyzer + 1 Entry Quality System）——每筆交易結果都會餵回學習系統，系統唔係固定規則，而係一個會進化嘅認知引擎。v2.0.833 移除咗 4 個 0-inference 組件（temporal-attention / cross-symbol / reward-shaping / world-model）同暫停 active-exploration。v2.0.835 新增 Q-RL Alpha Discovery（首個可以發現新 alpha 嘅組件）+ Factor-Tagged Aligned Shadow。**v2.0.857 移除風險等級區別化（moderate-only）**——矩陣 3×3 → 1×3。**v2.0.858 解鎖 cycle 期間市場選擇**。**v2.0.859 移除零消費者組件 + 修復 Q-RL/OLR backfill 重複喂飼 + OLR calibration shrinkage**。**v2.0.860 三因子探索 + adaptive 歸一 + SE operator-conditioned context**（Frontis-MA1/OpenMLE-Evo）。**v2.0.870-P16/P17 Hybrid Penalty Decay + Runs Test τ 調製**（三層 OR 混合衰減打斷 death spiral + Wald-Wolfowitz 游程檢定 τ 9–18h 自適應）。**v2.0.870-P50-P77 Binance bStocks 平行交易系列**（Agentic Wallet + 數據源 + x402 + 自動 swap + 企業行動風險 + 動態 map + 倉位同步 + 攻擊硬化 + 本地儲存預設；⚠️ **P80-bstocks-hide 已暫停**——交易 call site 移除、UI 隱藏，服務層保留）。**v2.0.870-P78 方案 B 預測反轉點**（`reversal-point.ts` 即時市場結構判斷入場反轉風險——ATH/ATL 距離 U 形 + EntryTiming + 大陽燭後回落 + 蠟燭形態 + 動量減速 + S/R + 15m 分歧；soft gate high ×0.5；SKHX -14.7% 案例 score 0.75 HIGH、誤傷贏單 0/6；buildOLRBlock 誠實信心修復——backfill-only 標明 NO LIVE DATA；**E1 反轉點離場——MAE/MFE 原版**（主神洞察：MAE/MFE 係 per-symbol 即時結果，比 ATH/ATL 通用閾值準 8 倍；**主神裁決回滾收窄版**——收窄冇好處，避免少 17% 誤傷一樣 0）——`closeReason='reversal_point'` 全鏈 8 處、SL 止血（s1 0.8×mae + s2 1.5×mfe + s3 冇動能、holdMin ≥ 15 全局必要）+ TP 提早鎖利（MFE ≥ 0.5% + 回吐 ≥ 30%）、反事實 SL 避免 228.1% / 誤傷 0% + TP 改善 25.4% / 錯過 0%（200 筆 realTrades）；**E3 edge 行誠實標明**；攻擊輪 6 漏洞全修 + 攻擊輪 2（E1 MAE/MFE 毒輸入 4 漏洞全修——負數 mfePct/-Infinity pnl/Infinity mfePct/持久化污染，mfeValid guard）。**v2.0.870-P79 四窗驗證機制**（`checkFourWindowAlignment` 純函數——**4h+1h = 方向 gate**（大方向順先入）+ **15m+5m = 時機確認**——死貓彈（5m順+15m逆）& 兩窗都逆 → hard block / 兩窗都順 ×1.1 / 順勢回調 ×1.0；防止「TP 後 re-entry 倒蝕」——BTC 案例 TP +18.4% → 追高入場 → E1 平倉 -5.2%；驗證 2 批次重複——死貓彈/兩窗都逆 WR 33%/0% 都差；方向分清楚（buy/sell 鏡像）；env `MOMENTUM_ALIGN_GATE`；攻擊輪 15 測試全綠——冇漏洞；**P79-fix TradingView chart 每 cycle 全黑修復**——React cleanup destroy 後 guard return 嘅 bug——Effect 1 依賴改 `[timeframe, symbol]` + Effect 2 error 重試；**P79-fix2 closeReason reconciliation 覆蓋 bug**——onFills 時序競態——檢查 exitThesis 已設 → skip）。**v2.0.870-P81 per-symbol MAE/MFE SL/TP 校準**（`mae-mfe-sltp.ts` 純函數——主神洞察「Shadow 加 per-symbol MAE/MFE 必然更準」——驗證 SL 噪音止蝕 61%→20%（MAE p95 cap 6%）/ TP 可達性 29%→57%（MFE p50×0.8）；Shadow 整合（openShadowTrades 用 PAEL 校準）+ 真實交易整合（computeSmartSLTP 加 maeMfeP95——widen-only floor——主神批准影響所有真實交易 SL/TP）；攻擊輪 1 漏洞全修——mfeP50 極大 tpPct clamp 50%；**P81-fix System Pause button 修正**——UI 本地更新 systemPaused 即時切換 Play/Pause——log 文字「RBC engine」→「learning engines」；**P81-ui-green UI 橙色全面轉 Hyperliquid 綠色**——`--gold` #F5A623→#97fce4 + 硬編碼金色 rgba→綠色）。 **v2.0.870-P82 盈利提升系列**（**P82-backfill-fix** backfill 假成功 bug 修復——`backfillFingerprint` count+latestClosedAt+version——200 筆歷史即刻入 stats——vol_expansion ×0.7 降權即刻生效；**P82-time-decay** success-pattern 時間衰減——`recent` ring + 時間加權中位數——breakout 點估計 +2.37% boost 但時間加權 -2.07% 降權——最近 breakout 全蝕；**P82-reversal-e1e2** reversal-point 離場校準——`perSymbolMaeP50` s1 閾值 p50×2 cap 20% + `trendAligned` 趨勢支持 ×1.5——BTC/SKHX 唔再被誤傷；**P82-pael-real** PAEL 只計 real——shadow MAE=0 污染消除 + 時間衰減 τ=7 日 + weight cap 100；**P82-e1e3** per-symbol MFE 鎖利校準 + rolling window；**P82-combo-ev** Combo EV Gate——`avgEwmaPnlPct` = 0.5×avg + 0.5×ewma——正 → 唔降權、負 → 降權——EWMA half-life 120 cycles 10 個鐘——拒絕污染值——舊 Wilson LB 誤傷 7 個低 WR 高回報組合）。 **P82-cap40** Plan G Penalty Cap 0.30 → 0.40——11 個強負期望值組合 comboPenalty 0.50 更強壓制 ×0.60——netPenalty clamp 非負 + decayMultiplier clamp [0,1]——污染值防禦）。**v2.0.870-P80 成功類型分類**（`success-pattern.ts` + `success-pattern-tracker.ts`——主神洞察「認準成功 pattern 增大盈利」——順勢突破 +2.92% boost ×1.1 vs 低波動擴張/新聞/動量確認 -1.47% 到 -2.42% 降權 ×0.7；完整閉環——close → record → 統計（持久化 success-patterns.json）→ 入場 gate getMultiplier（soft）+ **HACP 接駁**（buildSuccessPatternBlock 注入 Meta-Agent & Skeptics context）；驗證校準後 +0.19pp；攻擊輪 3 漏洞全修；**P80-backfill 歷史數據初始化**——200 筆 realTrades 乘數即刻生效——idempotent backfillDone flag；**P80-bstocks-hide bStocks 全面隱藏**——主神裁決唔賺錢——移除交易 Cycle call site + UI 隱藏（Wallet TVL/Binance 區塊/橙色 tag/fetch/grid 3→2格）——服務層保留 + bStocks_module.md 更新——效能確認唔拖慢；**P80-pnl-fix PNL 報告「冇資料」修復**——預設 mode real + localStorage 持久化）。以下逐層詳述：

### OLR — Online Logistic Regression（`olr-engine.ts`）

Per-symbol, per-side online logistic regression 從 shadow + paper + real + backfill 嘅 TP-before-SL 結果學習 P(win)。每個 feature 獨立計數，缺失 feature 返回中性 z=0。Source-weighted SGD updates（real=4, paper=2, shadow=1, backfill=0.3）。Confidence: high(≥50) / medium(≥20) / low(<20) samples。

**v2.0.143 來源追蹤**：每個 OLR model 記錄 `shadowSamples` / `paperSamples` / `realSamples` 三個獨立計數器。Agent context 顯示數據構成：`BUY P(win)=60% (30 samples, medium | shadow=15 paper=10 real=5)`。如果 model 主要由 shadow samples 訓練（固定 SL/TP），agent 可降低信任度。

### Shadow Trading（`shadow-trade-engine.ts`）

每個 cycle 為每個 trading market 開模擬 LONG + SHORT，S/R-aligned SL/TP。Intra-cycle high/low 追蹤（正確判定 TP-before-SL）。學 TP-before-SL（真實可盈利性），唔係 5 分鐘價格方向。

**完整結構（v2.0.855-audit）**：

| 元件 | 位置 | 作用 |
|:-----|:-----|:-----|
| `ShadowPosition` | interface | `side` / `entryPrice` / `stopLossPrice` / `takeProfitPrice` / `highSinceOpen` / `lowSinceOpen` / `mfePct` / `maePct` / `shadowType` / `factorTag` |
| `SHADOW_CONFIG` | constant | `maxOpenPerSymbol=10` / `maxTotalOpen=60` / `maxAgeCycles=12`(60min force-resolve) / `staleLearningWeight=0.3` |
| `openShadowTrades()` | blind | 每 cycle 為每個 trading market 開 LONG+SHORT 兩邊（cold-start prior，OLR weight 0.1×） |
| `openAlignedShadow()` | aligned | 跟 LLM 共識方向 + factor tag（v2.0.834）。v2.0.855：real-trade cycles 都開（counterfactual） |
| `openStatisticalShadow()` | statistical | 純統計方向（OLR+Combo WR+Causal），同 LLM 對照（v2.0.846 A/B） |
| `checkPositions()` | resolution | 用 `highSinceOpen`/`lowSinceOpen` 判定 SL/TP 命中（path-based，唔係 close price）→ feed OLR |
| `drainRecentResults()` | 學習出口 | index.ts 每次 cycle drain，feed OLR + Q-RL + MetaLearner + CausalReasoner |
| `pruneStaleSymbols()` | 維護 | 清理已移除 symbol 嘅 stale positions |

**index.ts 整合點（v2.0.855-audit）**：`checkPositions` 喺 active symbol + 每個 trading market 都跑（line ~7804/7826）；`drainRecentResults` 每 cycle feed 去 OLR/Q-RL（line ~7848）；shadow 開倉喺 multi-symbol loop（line ~8093/8114）。**Shadow → OLR → Q-RL 係完整學習管道**。

**v2.0.143 改進**：
- **MAE/MFE path-risk 追蹤**：每筆 shadow trade 記錄 Maximum Adverse/Favorable Excursion。Agent context 顯示 `avg MFE=3.2% avg MAE=1.8%`，讓 agent 看到「trades 平均先賺 3% 再虧到 SL」= 方向對但 exit timing 有問題。
- **Per-symbol funding rate**：非 active symbol 不再用 active symbol 的 funding rate，改用 per-symbol HL WS mark price cache。
- **Shadow soft gate**：當 shadow samples ≥ 10 且 win rate < 25%，override 為 HOLD（方向根本性錯誤）。
- **OLR 來源標記**：shadow outcomes 餵入 OLR 時標記 `source='shadow'`，不再與 paper/real 混在一起無法區分。

**現有 A/B 基礎（可擴展做退出策略驗證）**：`shadowType: 'blind' | 'aligned' | 'statistical'` 已經係天然嘅 A/B 分組機制——同一市況開唔同策略嘅 shadow，比較 outcome。**退出策略 A/B（standard vs trailing）可以完全複用呢個機制**：喺 `ShadowPosition` 加 `exitStrategy` 字段，`checkPositions()` 按策略分支。

### First-Passage Path Risk（`first-passage.ts`）

即時 P(TP before SL) from σ（log-returns std）+ ν（log-drift EWMA）+ per-side SL/TP distances。Cox & Miller (1965) GBM formula。RR-aware：P(win) 對 breakevenP 計 edge。

### Cold-Start Backfill（`olr-backfill.ts`）

首次 cycle per market：non-blocking replay 186 歷史 HL M5 candles 入 OLR 作 backfill source。Idempotent。

### EM Cycle Chain（`cycle-summary.ts`）

Meta-Agent 每循環蒸餾結構化 `CycleSummary`（E-step）；previous summaries 注入下循環 context（M-step）。Skeptics cross-check insight vs 實際價格（convergence audit）。Tiered memory：hot(12) + warm(288) + cold(48 epochs ≈ 48 days)。持久化到 `em-state.json`。

### Trade Pattern Classifier（`trade-pattern-classifier.ts`）

監督式 KNN pattern DB。8D feature space + regime（categorical）。Wilson score 95% confidence lower bound。Time-weighted win/loss（half-life 7 days）。

### Sigmoid·GA Sentiment Engine（`sentiment-engine.ts`）

GA 演化 sigmoid 函數將 raw sentiment score → 0-1 conviction。Volume ratio + sentiment + conviction 注入 OLR features。

### Numeric Autoencoder（`numeric-autoencoder.ts`，v2.0.204+v2.0.222+v2.0.223）

純 TypeScript MLP（11→16→8 encoder + 8→16→11 decoder），學習 market-condition 嘅非線性 representation。Reconstruction loss + contrastive loss（同 outcome 拉近/唔同推開）+ diversity penalty。Adam optimizer（自實現）+ gradient clip + weight clip + LR decay + seeded RNG + replay buffer + time-weighted sampling（v2.0.205, 30-day half-life）。

**v2.0.222：Replay 持久化**。Replay buffer 存入 `NAModelState`，重啟後 `restoreReplay()` 處理腐敗/NaN/截斷等 edge cases，即時 re-validate。

**v2.0.223：訓練品質修復（4 個盲點）**。(1) Diversity collapse symmetry trap — variance-from-mean 梯度喺塌縮時=0，改用 pairwise repulsion + margin。(2) 線性層零初始化 → bottleneck 死亡，改用 small He init。(3) diversityLossWeight 0.01→0.1。(4) Validation thresholds 放寬：mse<1.5, acc≥55%。Backfill 後 trainEpochs(50) + early stop。

**冷啟動 → 學習切換**：sampleCount < 50 → min-max fallback；50-200 → 訓練中仍用 min-max；≥200 + validation pass（MSE<1.5, acc>55%, diversity>0.01）→ `isReady()=true` → learned 8-d cosine 取代 min-max。

**整合**：`computeVectorConditionalWinRate` 嘅 `embeddingProvider` option；`trade-pattern-classifier.ts` `computeSimilarity`；`cycle-summary.ts` dual-channel retrieval；`agent-evolution.ts` agent 權重。

### AttnRes Cycle-History Retrieval（`cycle-history-retrieval.ts`，v2.0.211-v2.0.212）

Kimi K3 Attention Residuals transfer（arXiv 2603.15031）。K3 layer-depth ≡ MATS cycle-history depth。

**核心**：conditional WR 嘅 candidate 從 current snapshot 變成 **softmax-weighted blend over cycle history + entry-time state**。Entry-time regime 持續保留權重（K3 embedding persistence — Fig 8）。

**Block AttnRes（#2）**：80-cycle history → 8 blocks of 10 cycles。Intra-block mean，inter-block softmax attention over block summaries + entry state。Memory O(80d)→O(8d)。

**RMSNorm keys（#3）**+ per-feature Welford z-score：解決 feature-scale collapse（srDistanceBps 50-900 vs volatility 0.1-0.8）。Competition on direction not magnitude。

**Softmax mixture（#4）**：win rate = Σ softmax(sim/τ)·[win]。High-similarity records weight more（K3: softmax > sigmoid）。

**Online learning**：reward-weighted key direction（Peters & Schaal 2008），NOT REINFORCE（後者喺 deterministic softmax blend 係 identically zero）。Fixed recency prior 打破 uniform-policy deadlock。

**#7 Pre-Decision vs Pre-Execution Specialization（v2.0.212）**：兩個 pseudo-query：
- **wDecision**（broad, base recency 0.5）→ conditional WR + Meta-Agent thesis。Reward = PnL。
- **wExecution**（sharp, recency × 2.0 = 1.0）→ SL/TP survival context。Reward = SL/TP 放置質量（SL hit → 負，TP hit → 正，僅 closeReason='sl_tp'）。
- Execution-lens block 注入 Skeptics context，顯示 recent regime through SL/TP survival lens。
- 冷啟動：兩個 w 都 zero-init → 分別用 recency prior 產生 broad vs sharp blend。Selectivity 係 EARNED through outcomes。

**攻擊測試**：21 tests（Q7.1-Q7.5：numerical/state/cold-start/concurrency/injection）全通過。4 個實施時發現嘅漏洞已修復（REINFORCE deadlock → recency prior；feature-scale collapse → z-score；block-mean smoothing → block size = regime timescale；null injection → explicit guard）。

### Anti-Pattern Tracker（`anti-pattern-tracker.ts`，v2.0.207 #F）

聚類失敗 LessonStatement（cosine 0.78, min 2 members）。`matchCandidate(thesis)` 返回 matching classes + count + avgPnl。Skeptics 見到 "你咁樣輸過 N 次，avg -X%"。持久化到 `anti-patterns.json`。

### Conditional WR Soft Gate（`index.ts`，v2.0.209）

Code-level conviction penalty：condWR < 20% → +35% conviction penalty；< 30% → +25%；< 40% → +15%。使用 AttnRes h_blend + NA embedding + RMSNorm keys + softmax mixture。minSamples=5 guard。軟門控（懲罰，永不 hard block）。

### Combo WR Gate（`index.ts`，v2.0.221）

三層 soft gate 疊加：`netPenalty = lossPenalty + condPenalty + comboPenalty`。ComboWinRateTracker 追蹤 (symbol × side × regime) 組合 WR，Wilson score lower bound 信心。WR<25% & n≥5 → 0.50 penalty；< 35% → 0.30；< 45% → 0.15。注入 Meta-Agent marketDesc PRE-thesis。永不 hard block。

### OLR P(win) × Consensus Confidence Multiplicative Discount（`index.ts`，v2.0.224）

**偵測→實施斷裂修復**。v2.0.224 之前：OLR 正確偵測到 29% P(win)，但信念懲罰只加高門檻（additive 50%→85%），90% agent 共識仍可跨過 → 仍然交易。修復後 OLR P(win) 直接折扣共識 confidence（multiplicative）：

```
effectiveConfidence = consensusConfidence × blendFactor
blendFactor = pwinFloor + (1 - pwinFloor) × P(win)   // OLR has data
blendFactor = 1.0                                     // cold-start
pwinFloor = 0.3
```

P(win)=29% × 90%共識 = 45% < 85% → HOLD ✓。雙重防禦：加法（加高門檻 catch 中等過度自信）+ 乘法（折扣 confidence catch 極端過度自信）。冷啟動安全：OLR confidence='low' 或 nSamples<10 → blendFactor=1.0（唔折扣）。

---

## 風險管理引擎

| 關注點 | 嚴重性 | 觸發 | 緩解 |
|:-------|:------:|:-----|:-----|
| 回撤 ≥ 20% | 🔴 | 平倉所有 | 保持現金 |
| 日虧損 ≥ 5% | 🔴 | 當日禁止新交易 | — |
| 倉位 > 20% | 🟠 | 降至 20% | hard clamp |
| 波動率 > 3% | 🟠 | 倉位減半 | 止損放寬 |
| 相關性曝險 > 30% | 🟡 | 對沖或減倉 | — |

**倉位計算**：
```
volatilityFactor = vol > 3% ? 0.5 : vol > 2% ? 0.75 : 1.0
confidenceFactor = 0.5 + (confidence × 0.5)    # [0,1] → [0.5,1.0], 單次應用
riskPct = maxPositionSizePct × volatilityFactor × confidenceFactor
quantity = (equity × riskPct) / (entryPrice × priceRisk)
```

**TP/SL 設定於入場時，入場後永不修改（v2.0.225）**：入場後不再收窄。Trailing stop、MFE giveback、TP narrowing、per-symbol consensus SL/TP 全部停用——入場後收窄導致提前止蝕 + UI/交易所 SL desync。兩層退出保護：(1) 初始 SL/TP 交易所層面觸發，(2) LLM thesis invalidation（Skeptics Phase 0.5 強制平倉）。Portfolio 安全層：no-widen + not-too-tight（SL ≥ 1%, TP ≥ 1.5%）+ min-gap 2%。

**Smart SL/TP（v2.0.832）**：機構級 SL/TP 計算——優先級：S/R zones → 50-candle 頂底 → ATR floor。`computeSmartSLTP()`（`src/analysis/smart-sltp.ts`）取代舊嘅 ATR-first 邏輯。

```
SL 優先級：                          TP 優先級：
1. S/R support zone（最精準）         1. S/R resistance zone（最精準）
2. 50-candle ATL（次精準）            2. 50-candle ATH（次精準）
3. 1.5×ATR（fallback）               3. config default（fallback）
4. config default（最後）             4. config default（最後）

ATR 只用嚟防止 SL 太窄（SL ≥ 1.5×ATR），唔用嚟推 TP。
唔強制 R:R——如果 TP 近過 SL，照設。賺少都係賺。
S/R buffer 按強度加權：strong 0.2%, moderate 0.3%, weak 0.5%。
Per-profile caps（v2.0.836 → ⚠️ v2.0.857 moderate-only）：moderate SL 5% / TP 10% / TP min 0.3%（aggressive/conservative caps 已移除）。
```

**Leverage-Aware SL Floor（v2.0.852 fix #A）**：結構性 S/R SL 可以好貼 entry（例如 0.81%）。喺 10x 倉位，0.81% 逆向價格移動會抹走 ~8% margin——正常噪音就可以喺 thesis 兌現前止蝕（SILVER SELL 缺陷：entry $56.82, SL $57.28 = +0.81%，被例行噪音止蝕）。`computeSmartSLTP` 依家接受 `leverage` 參數，將 MINIMUM SL 距離按槓桿放大：`levFactor = 1.0 + (leverage - 1) × 0.15`（1x→1.0, 5x→1.6, 10x→2.35, 20x→3.85），`levFloorPct = min(0.05, max(slFloorPct, 0.01 × levFactor))`。只係 FLOOR——永遠唔會收窄結構性 SL，下游 momentum/exec-lens widening 仍然疊加。槓桿 clamp [1, 50]。

**MFE-Calibrated TP/SL（v2.0.852 fix #D）**：`computeSmartSLTP` 接受 `mfeCalibration`（由 `src/analysis/mfe-calibrator.ts` 從真實 1h/5m 蠟燭分佈計算，免疫被污染嘅 TradeRecord.MFE 欄位）：
1. TP target ← 中位數有利 1h extension ×0.8（現實盈利目標，唔係觸及唔到嘅 5× MFE）。只喺結構性 S/R TP 瞄得太遠時收窄（「TP 設太遠 → giveback」失敗）。
2. TP cap ← 90th-percentile extension（數據驅動上限，取代固定 10% 上限——只喺數據話價格好少行得更遠時生效；固定 cap 仍然係絕對 backstop）。
3. SL floor ← 95th-percentile adverse 5m excursion（噪音 floor，高槓桿倉位唔會被例行噪音止蝕）。
方向感知：BUY 用 `tpTargetLongPct`/`tpCapLongPct`/`slFloorLongPct`；SELL 用 `*ShortPct`。全部係 FLOOR/CEILING——唔會移除結構性 S/R 放置，只修正過度樂觀/過度緊嘅值。Caller 提供嘅值 clamp 到 sane bounds（tpTarget ∈ [0.003, 0.20], tpCap ∈ [0.005, 0.30], slFloor ∈ [0.005, 0.15]）。TP 永遠唔可以 cross SL（R:R ≥ 0，v2.0.852 attack fix #4）。

**Momentum + Execution-Lens + Confidence SL Widening（v2.0.849）**：呢啲保護原本只喺 dead code `computeATRSLTP`（trading-manager 從未 call），而家移植到 live `computeSmartSLTP`：

```
兩階段 pipeline（v2.0.849-fix）：
1. Confidence 設定 BASE ATR floor 乘數：
   P(win) > 0.8 → 2.5×ATR；< 0.5 → 1.2×ATR；否則 1.5×ATR
2. Momentum + Execution-Lens 之後作為無條件 hard floor（Math.max）：
   - Raw adverse momentum floor（v2.0.207 #C）：SL ≥ 2.5×adverseMomentum
   - Execution-lens adverse momentum（v2.0.213 #7）：stop-out-trained
   - Execution-lens vol scaling：vol > 1.5× implied → 加寬最多 +40%
   - High-entropy dampening：唔確定 lens → 收窄 50%
   所有 widening 都係 FLOOR（唔會窄過 ATR floor），再由 per-profile caps 封頂
   （v2.0.857 moderate-only：SL cap 5% / TP cap 10%）
```

**語義不變式**（v2.0.849-fix）：低信心（P<0.5）淨係收窄 BASE ATR 乘數，**唔會剝奪** momentum/exec-lens 保護。BUY side momentum 方向已修正（`BUY adverse = max(0, -momentum)`，`SELL adverse = max(0, +momentum)`），OLR P(win) confidence 由 entryData payload 讀取（唔係 decision object）。

**累計 Margin 上限 20%**：所有持倉 margin 總和 ≤ 20% balance（基於 margin 而非 notional）。

---

## Entry-Time Data Pipeline（v2.0.819）

**核心洞察**：所有學習系統（OLR / EXP / Pattern Classifier / RIL / AttnRes）需要入場時嘅真實 market features + OLR P(win) + shadow WR，而唔係 close 時 recompute。v2.0.777-818 嘅 12 次 patch 嘗試全部失敗，根因係 `closePosition()` / `closeExchangePosition()` 重建 closed TradeRecord 時 **冇 copy** position 上面嘅 `entryMarketFeatures` / `entryOlrPWin` / `entryShadowWinRate` / `regime`——patch 設喺 position 上但 close 時靜默丟棄，導致 100% real trade 顯示 NO_OLR / NO_SHADOW / NO_MARKET_DATA。

**修復**：
- `Position` + `TradeRecord` interface 正式宣告 `entryMarketFeatures` / `entryOlrPWin` / `entryShadowWinRate` / `regime`（取代 `PatchedTradeRecord` duck-typing）。
- `openPosition(order, entryPrice, leverage, entryThesis, entryData?)` 同 `importExchangePosition(..., entryData?)` 喺 construction 時同步設定（Position object literal）。
- `closePosition` / `closeExchangePosition` 喺 closed TradeRecord **copy** 呢四個 field。
- `entryData` 由 `executeTrade` 從 precomputed features map 構建，threading through `paperEngine.executeDecision` → `executeOrder` → `openPosition`，同 `tradingManager.executeDecision` → `importExchangePosition`。
- Fallback `injectPrecomputedEntryFeatures` 保留 for sync/reimport 路徑，而家佢嘅 patch 亦會 flow through 到 TradeRecord。

## Close-Context-Aware Learning（v2.0.226）

**核心洞察**：點樣平倉 / 用乜嘢形式平倉係蝕錢嘅重要因素。之前所有學習系統只收到 binary win/loss，冇概念知道點解蝕。Tight-SL loss（SL 被 trailing stop 收窄後被正常波動觸發）被當成「呢個情況入市=蝕」，污染 OLR / AttnRes / Combo WR / Anti-Pattern。

**`computeLearningWeight(closeReason, slNarrowed, isWin)`** — 純函數，按平倉 context 計算學習權重 [0.3, 1.0]：

| 平倉情況 | 權重 | 原因 |
|:---------|:----:|:-----|
| 贏（任何方式） | 1.0 | 市場確認咗入場論點，正面信號唔應折扣 |
| SL 觸發 @ 原始闊 SL | 1.0 | 真正嘅市場 loss — 價格真正逆向論點 |
| SL 觸發 @ 被收窄 SL | 0.3 | 執行 loss — 入場可能冇問題，SL 太緊 |
| Thesis 無效 | 0.3 | 系統 LLM 決定，唔係純市場信號 |
| 手動平倉 | 0.5 | 用戶決定，部分市場信號 |
| 共識平倉 | 0.5 | Agent 投票，部分信號 |
| Reconciliation / Exchange closed | 1.0 | 極端市場事件 |

**TradeRecord 捕捉平倉 context**：`originalStopLossPrice`（入場時 SL）+ `finalStopLossPrice`（平倉時 SL）+ `slNarrowed`（兩者唔同=true）。兩條 close path（paper `closePosition` + real `closeExchangePosition`）都從 position 捕捉。

**OLR `feedTrade` 加權**：第 7 參 `slNarrowed` + 第 9 參 `weightMultiplier` 正確傳入。`srcWeight = sourceWeight × weightMultiplier`，梯度更新按權重縮放。Tight-SL loss 只貢獻 30% 梯度。

**Combo WR 跳過執行 loss**：`comboTracker.trackTrade()` 只喺 `isWin || learningWeight ≥ 0.5` 時調用。Tight-SL loss + thesis invalidation loss（weight=0.3）被排除，唔拖低 (symbol×side×regime) 嘅 combo WR。

**Advanced learning PnL 縮放**：`feedAdvancedLearning` 嘅 `pnl` + `pnlPct` 乘以 `learningWeight`。AttnRes reward-weighted regression 按 weight 學習。（v2.0.833: temporal attention / cross-symbol / world model 已移除，`feedAdvancedLearning` 而家只 feed replay buffer。）

## TradeRecord.closeReason 資料完整性（v2.0.851）

**背景**：v2.0.226 嘅 `computeLearningWeight(closeReason, ...)` 一直依賴 `trade.closeReason`，但 v2.0.851 之前每個 closed trade 持久化後 `closeReason` 都係 `undefined` — 三個環節斷裂：
1. `closePosition` / `closeExchangePosition` 建立 TradeRecord 時冇設 `closeReason`。
2. `onPositionClosedLearning` 計算咗本地 `closeReason` 但冇寫返 trade。
3. `savePortfolio` + restore path 序列化時冇存 `closeReason`/`exitType`。

**結果**：RIL CloseReasonAggregator、trade-audit、`computeLearningWeight` 全部睇到 `closeReason=undefined` → 每個平倉都 fallback 做 `'sl_tp'`。Tight-SL loss 被當 full-weight（應 0.3×），「premature SL」warning 永遠唔觸發，分唔到「SL 太緊」定「thesis 錯」。

**`inferCloseReason(side, exitPrice, stopLoss, takeProfit)`**（`portfolio.ts`）— 確定性推斷：
- exit 觸及/越過 SL 或 TP → `'sl_tp'`
- exit 喺 SL/TP 之間 或 冇設 SL/TP → `'reconciliation'`
- 非 finite exitPrice（NaN/Infinity/≤0）→ `'reconciliation'`（數據錯誤，唔應分類為 sl_tp）
- null/NaN/0 嘅 SL/TP 當無設

**完整數據流**：
```
closePosition / closeExchangePosition
  → inferCloseReason() 推斷 或 caller 顯式傳入（consensus/manual/reconciliation/thesis_invalidation）
  → trade.closeReason 設好
  → onPositionClosedLearning 寫回（thesis_invalidation override）
  → savePortfolio 持久化 closeReason + exitType
  → 重啟後 restore 還原
```

**Agent-driven close 顯式標記**（`index.ts`）：consensus close / per-symbol flip / active-symbol flip / legacy agent-vote 全部傳 `'consensus'`；manual close / close-all / manual flip 傳 `'manual'`；reconciliation close 傳 `'reconciliation'`。SL/TP 自動平倉傳 `'sl_tp'`。Thesis-invalidation 由 `thesisInvalidatedCloseSymbols` set 喺 `onPositionClosedLearning` override。

## closeTrade dual-mode guard + fill-price accuracy（v2.0.853）

**v2.0.853-fix1**：`closeTrade()` 嘅 analysis-mode guard 缺少 `!this.dualMode` 檢查。`ANALYSIS_MODE='dual'`（生產預設）時 `analysisMode=true` → `closeTrade()` 靜默返回 `true` 而唔平倉。所有平倉路徑（SL/TP、consensus、thesis-invalidation、manual、flip）全部斷裂。修復：加 `&& !this.dualMode`，與 `executeTrade()` 嘅 guard 一致。

**v2.0.853-fix2**：3 個 `closeTrade()` call site 缺少顯式 `closeReason`：close-all（Trade Mode 切換前）→ `'manual'`；manual flip（UI）→ `'manual'`；reconciliation close → `'reconciliation'`。同 v2.0.851-fix 同類 bug。

**v2.0.853-fix3+fix4**：`tradingManager.closePosition()` 用 `pos.currentPrice`（滯後 WS 價格）作為 `exitPrice`，傳 `undefined` 作為 `hlRealizedPnl`。修復：平倉後從 `getRecentFills()` 揾到實際成交 fill，用 `fill.price` + `fill.closedPnl`。Retry 2 次 × 500ms + `clearCaches()` bust fills cache。Fill fetch 失敗時 fallback 到 `pos.currentPrice`（同 pre-fix 行為一致）。

**v2.0.853-fix5**：UI SSE 重連加指數退避（2s → 4s → 8s → 15s capped），`ollama-plan` fetch 加 `res.ok` guard，`all-symbols` useEffect 加 `data` gate + dedup ref。防止後端 down 時 ECONNRESET/ECONNREFUSED spam。

**v2.0.853-fix6**：Fill-fetch retry 從 3×1s=3s 減到 2×500ms=1s，避免阻塞 decision cycle（阻塞期間其他倉位嘅 SL/TP 唔被監控）。

**v2.0.853-fix7**：`closeTrade()` 用 `symbol.includes(':') ? symbol : symbol.toLowerCase()` 而唔係 `normalizeSymbol()`。對於大寫前綴嘅 colon symbol（例如 `XYZ:SKHX`），返回原始 symbol 而唔係 normalized form（`xyz:SKHX`）。雖然所有下游方法都 call `normalizeSymbol` 所以唔會 crash，但 log 顯示唔一致嘅 symbol casing，且如果下游方法將來唔再 call `normalizeSymbol` 就會出 bug。修復：改用 `normalizeSymbol(symbol)`。

---

## Architecture 藍圖審計 — 5 個 loss/crash 向量修復（v2.0.854）

對照 ARCHITECTURE.md 藍圖與實際代碼嘅對抗審計，搵到並修復 **5 個真實生產 bug**（2 個 memory leak、2 個金融指標扭曲、1 個 garbage-order 向量）：

**v2.0.854-fix1：`computeSmartSLTP` 嘅 `safeDcs` 冇 clamp 到 [0,1]**（`smart-sltp.ts`）。舊代碼只 check `>= 0`，未 check `<= 1`。Untrusted DCS=5 → `slMultiplier=2.5`、`tpMultiplier=3.5`，喺 cap-clamping 前已經扭曲 SL/TP。`dcs-calculator.ts` 同 `analysis-matrix.ts` 都 clamp，呢個係不一致嗰個。修復：`safeDcs = Math.min(1, Math.max(0, safeDcs))`。

**v2.0.854-fix2：`recentlyClosedSyms` dedup map 無界 memory leak**（`portfolio.ts`）。Entry 只喺 `importExchangePosition`（dedup-bypass）時移除。長期運行每 `(symbol:entryPrice)` 累積一條。更嚴重：close 爆發時全部 key 都「fresh」，淨靠 expiry purge 永遠唔觸發。修復：size > 512 時 (a) purge 過期 key + (b) FIFO 逐出最舊——硬 bound。

**v2.0.854-fix3：`perSymbolIdleCycles` map 無界增長**（`dynamic-threshold.ts`）。Symbol 透過 `incrementIdleCycles(allKnownSymbols)` 加入但永不逐出。修復：idle 超過 `2 × PENALTY_DECAY_CYCLES`（60）就逐出——此時 penalty 已完全衰減，返回時喺 global-idle fallback 重新註冊。

**v2.0.854-fix4：real 倉位 `pnlPct` 用 full notional 而唔係 margin**（`portfolio.ts`）。`closeExchangePosition` 用 `margin = entryPrice × quantity`（冇 `/leverage`），而 `closePosition`（paper）同 `recalculateEquity` 用 `notional / lev`。10x real 倉位顯示 1/10 真實 margin return——令 consume `pnlPct` 嘅 OLR/EXP/RIL 低估 real-trade edge。修復：`margin = (entryPrice × quantity) / leverage`。

**v2.0.854-fix5：real-trade entry-price guard 漏咗 NaN/Infinity + position delete 用 raw symbol**（`trading-manager.ts` + `portfolio.ts`）。(A) `executeTrade` 嘅 `price <= 0` guard 對 NaN 失效（`NaN <= 0` = false）→ 腐敗 entry price 產生 `quantity=NaN` 到達交易所。修復：`!Number.isFinite(price) || price <= 0`。(B) `closePosition`/`closeExchangePosition` 用 raw `symbol` delete，而 position 存喺 `normalizeSymbol` 下——casing mismatch 留 ghost position + 重複 PnL。修復：三個 close path 都用 normalized symbol delete。(C) exchange fill price 可 NaN/0 → garbage SL/TP。修復：非 finite/≤0 時 fallback 已驗證 decision price，leverage clamp [1,50]。

**Attack tests**：`tests/v2.0.854-architecture-audit-fix.test.ts`（13 tests）——DCS clamp（dcs=5 ≡ dcs=1、負→0、NaN→0）、per-symbol eviction + 近期交易唔逐出、NaN/Infinity entry 拒絕、raw-casing caller 都正常 close、margin 上嘅 leveraged pnlPct、dedup map bounded ≤512。Regression：相關套件 111/111 通過，`tsc --noEmit` 零錯誤。

---

## Leverage division-by-zero + safeLeverage hardening（v2.0.854-attack — CRITICAL）

對 v2.0.854 修復嘅對抗攻擊搵到一個 **critical 資金污染 bug**——正正喺啱啱改嘅 code 度，加上成個系統性 division-by-zero 隱患。

### ATTACK-fix1：`leverage=0` / NaN → Infinity balance 永久污染（CRITICAL）

**漏洞**：`openPosition` 做 `margin = notional / leverage` 完全冇 guard。Caller 傳 `leverage=0` → `margin = notional/0 = Infinity` → `balance -= Infinity = -Infinity`，paper balance 永久損毀。同一類 bug 散佈喺 `closeExchangePosition`（v2.0.854-fix4）、`recomputePnL`、`trackMAEMFE`、`recalculateEquity`、`trading-manager` margin check、`hyperliquid-engine`——全部都做 `/ (leverage ?? 1)`，而 `0 ?? 1 === 0`（所以 `?? 1` fallback **永遠唔會 catch `0`**）。

**關鍵洞察**：`(x ?? 1)` 唔係 NaN/zero guard！佢只 catch `undefined`/`null`。`0 ?? 1 = 0`、`NaN ?? 1 = NaN`——啱啱係會搞壞 division 嘅值。

**修復**：新增 `safeLeverage()`（`position-utils.ts`），reject `0`、`NaN`、`Infinity`、負數、`>50`、非 number → fallback `1`。喺**存儲點**（`openPosition` + `importExchangePosition`）應用令所有下游自動安全，再加埋直接 call site：`closePosition`、`closeExchangePosition`、`recomputePnL`、`trackMAEMFE`、`recalculateEquity`、`trading-manager` margin cap check、`hyperliquid-engine`、4 個 `index.ts` margin calc。

### 防禦原則

```
margin = notional / safeLeverage(leverage)   // 永遠
never:   margin = notional / leverage         // 可 Infinity/NaN
never:   margin = notional / (leverage ?? 1)  // ?? 只 catch undefined/null，唔 catch 0/NaN
```

### 驗證（26 tests）

| 向量 | 結果 |
|:------|:------|
| `leverage=0` openPosition | ✅ balance 保持 finite（原本 `-Infinity`） |
| `leverage=0` closeExchangePosition | ✅ pnlPct finite（原本 Infinity） |
| `leverage=NaN/Infinity/負/>50` | ✅ → 1 |
| `leverage` Proxy getter-bomb | ✅ → 1，冇 throw |
| `leverage` string type | ✅ reject → 1 |
| DCS Proxy getter-bomb / `-0` / `"5"` | ✅ 正確 clamp |
| 1000 distinct symbol close | ✅ dedup map ≤512 |
| per-symbol idle eviction（1000 symbols）| ✅ 正確逐出 |
| raw-casing closePosition delete | ✅ 冇 ghost position |

**Tests**：`tests/v2.0.854-architecture-fix-attack.test.ts`（26 tests）+ `tests/v2.0.854-architecture-audit-fix.test.ts`（13 tests）。Regression：169 相關測試通過。`tsc --noEmit` 零錯誤。

---

## recomputePnL / trackMAEMFE / computeSLTP / recalculateEquity NaN 防禦（v2.0.854-attack3）

對 v2.0.854-attack2 嘅對抗攻擊搵到共享 helper 冇 defense-in-depth——`updatePosition`/`softUpdatePosition` 有 guard，但 helper 本身接受 NaN/Infinity/0/negative。

**ATTACK3-fix1：`recomputePnL` NaN currentPrice → NaN equity（CRITICAL）**。`recomputePnL(pos, NaN)` → `unrealizedPnl = NaN` → `recalculateEquity` 加 NaN → `totalEquity = NaN` → 整個 portfolio 崩潰。修復：`recomputePnL` 用 `safePrice(currentPrice)` sanitize。

**ATTACK3-fix2：`trackMAEMFE` NaN unrealizedPnl → NaN MAE/MFE**。腐敗 restore 載入 NaN `unrealizedPnl` → `posValue = NaN` → `minValueReached = NaN` → 學習系統食 NaN。修復：guard `Number.isFinite(unrealizedPnl)` + skip non-finite `posValue`。

**ATTACK3-fix3：`computeSLTP` NaN entry → NaN SL/TP → 無止損開倉**。`computeSLTP(NaN, 'buy')` → `sl = NaN` → 交易引擎收到 NaN 止損 = 無止損。修復：`computeSLTP` 用 `safePrice(entry)` sanitize。

**ATTACK3-fix4：`recalculateEquity` NaN unrealizedPnl → NaN totalEquity**。單一 NaN position 令 `totalEquity = NaN` → 所有下游 risk check（max drawdown、daily loss、position sizing）崩潰。修復：guard 每個 `unrealizedPnl` 用 `Number.isFinite`（→ 0 fallback）。

**Tests**：`tests/v2.0.854-attack3-recompute-equity.test.ts`（12 tests）。Regression：162 相關測試通過。`tsc --noEmit` 零錯誤。

---

## Plan G — 動態 Threshold [45-55%] + 乘法 Penalty 衰減（v2.0.227）

### 問題：Penalty 死循環

 conviction gate 有一個複合懲罰設計缺陷：
- **加法 threshold 提升**：3 個 penalty gate（loss-streak、conditional WR、combo WR）疊加到 threshold（50% + 30% = 80%）
- **乘法 confidence 折扣**：P(win) × consensus（65% × 0.685 = 44.5%）
- **結果**：44.5% vs 80% = 35.5pp 差距 → 數學上不可能交易 → 冇新交易 → penalty 永遠唔 reset → 永久 STUCK

SILVER SELL 實測被卡 6+ 小時就係呢個死循環。

### 解決方案：統一乘法模型

```
effectiveConfidence = consensus × pwinBlendFactor × penaltyFactor × boostFactor
dynamicThreshold = 50% + (totalScore × 0.5%)  →  [45%, 55%]

if effectiveConfidence ≥ dynamicThreshold → TRADE
if effectiveConfidence < dynamicThreshold → HOLD

// v2.0.819 WINNER-FIRST:
//   pwinBlendFactor = max(olrBlendFactor, comboBlendFactor)
//   comboBlendFactor = 0.3 + 0.7 × comboWilsonLB   (only when n ≥ 20 AND Wilson LB ≥ 0.55)
//   boostFactor = 1.0 + min(winnerBoost, 0.20)      (lossStreakTracker winner pattern)
```

### `DynamicThresholdCalculator`（`src/analysis/dynamic-threshold.ts`）

**5 因素 hysteresis 計分**（每個因素 [-2, +2] 分，hysteresis 防止邊界跳動）：

| 因素 | -2 分（放鬆） | 0 分（中性） | +2 分（收緊） | 樣本要求 |
|:-----|:-------------|:-------------|:-------------|:--------:|
| Rolling WR | ≥55% | 40-55% | <35% | ≥10 筆 |
| Idle cycles | ≥20 cycles | 5-20 cycles | <2 cycles | — |
| Drawdown | <3% | 3-10% | >15% | — |
| Rolling Sharpe | >1.5 | 0-1.0 | <-1.0 | ≥10 筆 |
| Regime | trending | normal/mr | chaotic | — |

- `totalScore = WR分 + Idle分 + Drawdown分 + Sharpe分 + Regime分`，capped at [-10, +10]
- `threshold = 50% + totalScore × 0.5%` → 數學保證 [45%, 55%]

**Penalty 衰減**：`penaltyFactor = 1.0 - min(decayedPenalty, 0.30)`，其中 `decayedPenalty = netPenalty × max(0, 1 - cyclesIdle/30)`。30 cycles idle（2.5 小時）後 penalty 完全歸零 → 系統自我恢復。

**P(win) blendFactor**（v2.0.224 保留 + v2.0.819 WINNER-FIRST 擴展）：`pwinBlendFactor = max(olrBlendFactor, comboBlendFactor)`。`olrBlendFactor = 0.3 + 0.7 × P(win)`，cold-start 時 = 1.0。`comboBlendFactor = 0.3 + 0.7 × comboWilsonLB`，僅當 combo (symbol×side×regime) 達 n ≥ 20 AND Wilson 95% LB ≥ 0.55 時先 applicable——令統計上強烈嘅 winner（例如 BTC buy/low_vol 77% WR, 556W/164L）可以 override OLR 嘅乘法否決。之前 combo WR 只可以 penalty 輸家，永遠唔可以 boost 贏家，導致 BTC 被 OLR P(win)=6.6% 否決 4 日。

**BoostFactor**（v2.0.819 WINNER-FIRST）：`boostFactor = 1.0 + min(winnerBoost, 0.20)`。`winnerBoost` 來自 lossStreakTracker 嘅 checkWinnerPattern（8–15%）。之前 boost 被編碼為負數 `_lossStreakPenalty` 並被 `Math.max(0, netPenalty)` 靜默裁剪為 0——WINNER-FIRST directive 從未到達閘門。

### 6 重公正保障

1. **多因素平衡** — 5 個因素各自獨立，每個最多 ±1%，冇單一因素可以主導
2. **對稱設計** — 好同差嘅影響力相同（±2 分對稱）
3. **樣本數要求** — WR + Sharpe 要 ≥10 筆先計分，唔夠 = 中性（0 分）
4. **Hysteresis** — 每個因素有 buffer zone，唔會因為 49.9% vs 50.1% 來回跳
5. **Hard cap** — totalScore capped [-10, +10] → threshold [45%, 55%]，數學保證
6. **事實驅動** — 全部用已發生嘅事實（WR = 已結算勝率、Idle = 計時器、Drawdown = 已實現回撤、Sharpe = 已計算、Regime = 已觀測）

### SILVER SELL 模擬

```
舊系統（死循環）：
  threshold = 50% + 30% penalty = 80%
  confidence = 65% × 0.685 = 44.5%
  44.5% < 80% → 差 35.5pp → HOLD（不可能）

Plan G（6 小時 idle 後）：
  WR=27% → +2 分, Idle=36 cycles → -2 分, Sharpe<0 → +1 分
  totalScore = +1 → threshold = 50.5%
  penalty 衰減到 0（36 > 30 cycles）→ penaltyFactor = 1.0

  P(win)=55% + consensus=65% → 44.5% < 50.5% → HOLD（接近，差 6pp）
  P(win)=79% + consensus=65% → 55.4% ≥ 50.5% → TRADE ✓
  consensus=75% + P(win)=55% → 51.4% ≥ 50.5% → TRADE ✓
  → 強信號永遠有路過，中等信號要更高共識先過 = 公正
```

### 設計原則

- **Penalty 乘法唔加法**：懲罰折扣 confidence（乘法），唔提升 threshold（加法）。消除雙重懲罰。
- **Idle 衰減打破死循環**：越耐冇交易，penalty 越細。30 cycles 後歸零。系統永遠可以自我恢復。
- **Threshold 動態但有 cap**：用實際表現驅動（WR、Idle、Drawdown、Sharpe、Regime），但 capped [45%, 55%]。表現好時放鬆（入多啲），表現差時收緊（保護），但永遠唔會卡死。
- **強信號永遠有路過**：P(win)=79% + consensus=65% = 55.4% ≥ 50.5% → 即使系統表現差，強信號仍然可以入場。

### 整合

- `DynamicThresholdCalculator` 喺 conviction gate（`index.ts` line ~11662）取代舊嘅 `convictionThreshold + lossStreakPenalty`（加法）路徑
- `_lossStreakPenalty`（loss + cond + combo 三 gate 嘅 net penalty）改為傳入 calculator 嘅 `netPenalty`，計算 `penaltyFactor`（乘法）
- HACP `getCyclesWithoutTrade()` 提供 idle cycle 數
- Portfolio `currentDrawdownPct` 提供 drawdown
- TradeHistory `getRecent(20)` 計算 rolling WR + Sharpe
- `combinedState.regime` 提供 regime

---

## Paper Trading 模擬層（dual/execution mode）

**註**：v2.0.822+ 訊號運算模式（`ANALYSIS_MODE=true`）下，後端唔執行交易——執行由客戶端 `mats_app` `useAutoTrade` hook 處理。以下僅適用於 `dual` 或 `false` 模式。

- 槓桿感知 P&L：notional-based 雙邊手續費扣除
- 每個 price update 自動檢查 SL/TP + 追蹤 MAE/MFE（部位價值 = margin + unrealized PnL）
- Position Reconciliation：偵測 exchange 已平倉 → 同步 local mirror
- Real Trading Manager：HL exchange 下單 + 本地 mirror（phantom agent signing via `@noble/curves`）
- **v2.0.143 統一交易路由**：`executeTrade()` 按 tradeMode 路由 — paper 直接走 paperEngine，real 走 realTradingManager。`closeTrade()` 按 agentId 路由 — paper 走 portfolio.closePosition()，real 走 tradingManager.closePosition()。不再所有交易都經過 RealTradingManager。v2.0.853: `closeTrade()` 嘅 analysis-mode guard 必須檢查 `!this.dualMode`（同 `executeTrade()` 一致），否則 dual 模式下所有平倉被靜默跳過。`tradingManager.closePosition()` 必須從 `getRecentFills()` 揾到實際 HL fill price + PnL，唔好用滯後 `pos.currentPrice`。
- **v2.0.143 entryThesis 修復**：執行成功後才調用 `setEntryThesis()`，確保 thesis 在 position 存在時才寫入。syncExchangePositions 的 close+reimport 路徑保留 entryThesis + MAE/MFE。
- placeOrder 價格源：LIVE `l2Book`（best bid/ask）做 aggressive price 主源，`allMids` REST 做 fallback

**客戶端執行路徑**（`mats_app` `useAutoTrade.ts`，訊號模式）：
- Paper mode：寫入 Supabase `positions` 表（模擬倉位）
- Real mode：Pro tier + PK stored → `HlRestClient` 簽名 + 提交 Hyperliquid
- SL/TP 從用戶 settings 應用；Max position % 強制；manual mode 永不執行
- One trade per symbol per cycle（dedup by cycleId）

---

## Trade Incident Panel

取代舊版 Positions table + Trade Records，統一顯示每筆交易（paper + real，open + closed）為可展開卡片。

**卡片欄位**：
| 欄位 | 說明 |
|:-----|:-----|
| Symbol / Side / Status | 基本資訊（BUY/SELL、OPEN/CLOSED、PAPER/REAL tag）|
| PnL | 已實現（closed）或未實現（open）盈虧 |
| Entry / Exit Price | 進出場價格 |
| Min/Max Value Reached | MAE/MFE — 部位價值的最低/最高點（margin + unrealized PnL）|
| Entry Thesis | Meta-Agent 的進場理據（凍結在開倉時）|
| Exit Thesis | 平倉理據（v2.0.225：SL/TP 不再收窄，只記錄平倉原因）|
| Post-Review | LLM 自動生成的賽後檢討（如何賺多啲/蝕少啲）|
| Leverage / Investment / Opened / Closed | 交易參數 |

**Exit Thesis**：平倉理據記錄平倉原因（SL 觸發 / TP 觸發 / thesis invalidation / 手動平倉）。v2.0.225 起 SL/TP 入場後不再收窄，不再有 narrowing 分析。

**Post-Review LLM**：每筆交易關閉後，fire-and-forget 調用 DeepSeek V4 Flash 生成 2-4 句賽後檢討，分析 MAE/MFE + entry/exit thesis + close reason，提出如何改善。

**持久化**：所有新欄位（entryThesis, exitThesis, postReview, minValueReached, maxValueReached, originalStopLossPrice, originalTakeProfitPrice）持久化到 `portfolio-state.json`，重啟不丟失。

---

## Edge Validation Layer（v2.0.833 — alpha 測謊機）

**核心定位**：Edge 系統唔係 alpha 嘅來源，係 alpha 嘅測謊機。佢唔會製造盈利，佢會令系統知道「有冇 edge、邊度有 edge」。盈利 = alpha × 執行 × 穩定性；Edge 層只量化 alpha + 強制穩定性。

**5 個組件**（`src/edge/`）：

| 組件 | 檔案 | 作用 |
|:-----|:-----|:-----|
| Edge Config | `edge-config.ts` | 所有 threshold + weight 經 Zod env var。Regime-aware 5-component 加權。Sample cap 10000。與 `src/config/` 分離（edge 控制訊號質量量度，risk 控制後端帳戶） |
| Edge Calculator (1A) | `edge-calculator.ts` | 5-component regime-weighted edgeScore：directionalEdge（shadow WR）+ learnedEdge（OLR 校準）+ comboEdge（Wilson LB）+ pathEdge（First-Passage）+ realizedEdge（WR×Sharpe）。Confidence label 按最少 sample。低 confidence 永遠唔可以 `trade`（最多 `caution`）。`Object.hasOwn` 防原型污染。`skipEdgeReport` 返回 `caution`（唔係 `skip`）—冷啟動唔可以 block |
| Execution Tracker (1B) | `execution-tracker.ts` | 記錄真實 slippage + funding per (symbol, side)。`calibratePnlLabel()` 將理論 PnL → 可實現 PnL。Cold-start passthrough（<20 sample 唔校準）。Ring buffer bounded。Side-aware slippage（buy: fill>signal=bad；sell: fill<signal=bad） |
| Stability Monitor (1C) | `stability-monitor.ts` | ±5% perturbation test + cross-time consistency。Stability factor [0.5, 1.0] 乘 conviction。純數學，毫秒級 |
| Backtest Validation | `backtest-validation.ts` | 計量金融標準：Sharpe / Sortino / Calmar / Profit Factor / Expectancy / Max Drawdown / Information Ratio vs buy-and-hold。統計顯著性：stationary bootstrap p-value（Politis & Romano 1994）+ Deflated Sharpe Ratio（Bailey & López de Prado 2014，修正 multiple testing）+ walk-forward 70/30 IS/OOS split |

**整合**：`buildAssetAnalysis()` 接受 `edgeReport`（風險中性）。`MatrixCell.edge?` + `AssetAnalysis.edgeReport?` 加入 types。`skip` recommendation 強制 cell action = `hold`（client 唔執行無 edge 訊號）。`caution` 唔強制 hold（系統可以 bootstrap）。

**冷啟動安全**：零 sample → `edgeScore=0.5`（中性）+ `recommendation=caution`（唔係 skip）。全新系統可以交易去累積 sample。無知 ≠ 無 edge 嘅證據。

**安全修復（94 attack tests）**：原型污染（`Object.hasOwn`）、冷啟動死鎖（`skipEdgeReport=caution`）、confidence bypass（低 confidence 永遠唔 trade）、ExecutionTracker DoS（bounded `recent.length`）、store 原型污染（load 驗證）。

**v2.0.833 移除嘅組件**（training wired 但 0 inference call site，grep 證實）：

| 組件 | 移除原因 |
|:-----|:---------|
| `world-model.ts` | `addSample` 用 close-time features 同時做 current + next → identity transition model → 0 預測能力。`predict`/`rollout` 0 call |
| `reward-shaping.ts` | `shape()` 0 call。`learningWeight`（v2.0.226）已覆蓋關鍵 case（執行損失降權） |
| `cross-symbol-backbone.ts` | `query()` 0 call。OLR backfill 已解決 cold-start |
| `temporal-attention.ts` | `retrieve()` 0 call。同 AttnRes cycle-history 重疊，保留更成熟嘅 AttnRes |

**v2.0.833 暫停**：`active-exploration`（`ACTIVE_EXPLORATION_ENABLED=false`）。盲目 UCB 探索喺冇 edge 驗證下危險。等 Edge Report 證明 baseline 有 edge 先重啟。

**Sample cap 提升至 10000**：`trade-history` 5000→10000、`replay-buffer` 5000→10000、`pattern-tag` 500→5000、`shadow-recent` 50→200、`olr-recent` 20→100、`audit-recent` 20→100、`em-insight` 500→5000、`EXP_MAX_RECORDS` 1000→10000。全部經 `edgeConfig` env var。

---

## Q-RL Alpha Discovery（v2.0.835 — 首個可以發現新 alpha 嘅組件）

**核心定位**：Edge Validation Layer 係 alpha 嘅「測謊機」——量化現有 edge。Q-RL Alpha Discovery 係首個可以**發現新 alpha**嘅組件——透過 ε-greedy 探索，嘗試 LLM 唔會選擇嘅 action，從 Aligned Shadow 嘅 reward 學習。

### Q-RL Q-Table（`src/evolution/q-rl-table.ts`）

**270 cells** = 5 regime × 3 vol × 3 momentum × 3 funding × 2 action。每個 cell 儲存 Q-value（預期 PnL%）、visit count、reward history。

| 元件 | 說明 |
|:-----|:-----|
| ε-greedy 探索 | ε 由 1.0（100% 探索）線性衰減到 0.05，over 500 cycles。Cold-start（Q=0）→ follow LLM（同現有行為一致） |
| EWMA Q-value 更新 | `α = 1/(1+visits)` diminishing learning rate。`newQ = (1-α)×oldQ + α×reward` |
| Discovery 掃描 | 每 5 cycles 掃描 Q-table。Candidate: Q \u003e 0.2% + n ≥ 10。Probable: Q \u003e 0.3% + Wilson LB \u003e 50% + n ≥ 20。Confirmed: Q \u003e 0.5% + Wilson LB \u003e 55% + BH-FDR pass + n ≥ 30 |
| Stationary bootstrap p-value | Politis & Romano 1994，block size √n，H0-centered（v2.0.835 fix: center data under H0，否則全部相同 reward → p-value=1.0） |
| Benjamini-Hochberg FDR | 多重檢定修正。失敗嘅 confirmed → downgraded to probable |
| HACP 注入 | `qrlDiscoveryBlock` 注入 Meta-Agent prompt。Confirmed → conviction +5%，Probable → +2%，Candidate → note only |
| 持久化 | `q-rl-table.json`（atomic save/load），save 返回 deep copy（防 mutation） |

**Cold-start 安全**：所有 Q=0 → follow LLM（同現有行為完全一致）。冇 GPU，冇 backprop，冇神經網絡——純 TypeScript EWMA + Wilson score。

### Factor-Tagged Aligned Shadow（`src/evolution/shadow-trade-engine.ts`）

**問題**：Blind shadow 喺所有市場條件下開模擬倉，但真實交易只喺 LLM 選擇嘅條件下執行 → distribution shift → OLR 學習錯誤分佈。

**解決方案**：Aligned Shadow 跟隨 LLM 共識方向，帶 agent vote metadata（factor tagging）。

| 元件 | 說明 |
|:-----|:-----|
| `shadowType: 'blind' \| 'aligned'` | ShadowPosition 新增欄位 |
| `openAlignedShadow()` | 跟隨 LLM 共識方向，接受外部 SL/TP 參數 + agentVotes + primaryDriver |
| `hasAlignedShadow()` | Blind skip check（避免重複 shadow） |
| OLR source routing | `checkPositions` 按 `shadowType` 路由：aligned → 'shadow'（weight 1），blind → 'shadow_blind'（weight 0.1） |

**OLR source weights**：`shadow=1, shadow_blind=0.1, paper=2, real=4, backfill=0.1`。Blind shadow downweighted 10×（distribution shift）。

### 安全修復（v2.0.835: 20 vulnerabilities, 242 attack tests）

5 輪對抗測試發現並修復 20 個漏洞：

| 輪次 | 目標 | 測試數 | 漏洞 |
|:---|:---|:---:|:---:|
| Round 1 | Q-RL 基礎 | 52 | 2（null features crash, action case sensitivity） |
| Round 2 | Q-RL 深度 | +48 → 100 | 3（save reference leak, load config restore, bootstrap centering） |
| Round 3 | CHANGELOG 10 功能 | 142 | 8（NaN entryPrice, serialize leak, getter bomb, bootstrap centering, 等） |
| Round 4 | 創意/意想不到 | 113 | 3（MAX_VALUE overflow, serialize recent leak, Object.entries getter bomb） |
| Round 5 | Q-RL 創意 | 69 | 4（makeKey getter bomb, Proxy throw, getBestDiscovery getter） |
| **總計** | | **242** | **20** |

最嚴重嘅漏洞：
1. **Q-RL bootstrapPValue centering**（R2-3）——全部相同 reward → p-value=1.0 → confirmed discovery 永遠唔會發生 → Alpha Discovery 系統名存實亡
2. **smart-sltp.ts NaN entryPrice**（V1）——SL/TP 全部 NaN → 交易引擎收到 NaN 止損 = 無止損開倉
3. **Q-RL getter bomb**（Q1-Q4）——`makeKey` 嘅 `features['regimeOrdinal']` 觸發 getter → crash 整個 decision cycle

### 學習管道修復（v2.0.855 — 三條斷裂嘅血管重新接駁）

Adversarial audit（v2.0.855 系列）對照真實持久化狀態（`shadow-state.json`、`q-rl-table.json`、`olr-state.json`）發現三個疊加斷點令 Q-RL 由開局至今**永遠冇數據**（`values: {}` after 79 cycles）——而唔係「冷啟動安全」：

| 版本 | 修復 | 斷點 |
|:-----|:-----|:-----|
| v2.0.855 | Aligned shadow 恆開 | `if (didTradeExecute) continue;` 令 real-trade cycles（最多決策信號嘅 cycles）跳過 aligned shadow → Q-RL 唯一 live feed 餓死 |
| v2.0.855 | shadow_blind OLR 計數器 | v2.0.834 承諾「tracked separately」但 feedTrade 從未 increment → BTC long `shadowSamples=0` 而 54k paper samples 淹沒模型 |
| v2.0.855 | thesis-invalidation closeReason 全覆蓋 | 2 個 force-close call site 缺顯式 reason → 72/167 筆 real close 被誤標為 'sl_tp' |
| v2.0.855-fix | **Q-RL EXP backfill** | `backfillFromExpRecords()` 餵咗 OLR/NA/AttnRes/Cluster/CHR/Combo/MetaLearner/Causal/Attribution 但**從未餵 Q-RL** → 加 `qrlTable.update(features, side, pnlPct)`（1072/1674 筆有 marketFeatures） |
| v2.0.855-attack | 7 個修復引入嘅漏洞 | OLR counter `?? 0` 擋唔住字符串/負數；closeReason 空字符串/typo 穿透（`'' ?? x === ''`）令學習權重爆 3.3×；aligned-shadow weightedDirection 用咗 Q-RL 探索 action |
| v2.0.855-attack2 | **binRegime 對齊** | `binRegime()` 邊界同 `regimeToOrdinal()` **完全錯位**（6/7 regime 入錯桶，bull/bear 對調）→ 每個 Q-RL cell 標籤錯誤 |

**Q-RL 而家三通道完整**：live aligned shadow（修好）+ EXP backfill（新加）+ 正確 regime 分桶（修好）——`discoverPatterns()` 即刻有嘢掃。

---

## Q-RL Direction Signal（v2.0.861 — regime-conditioned expectancy oracle 接入決策）

**背景（Phase 0 診斷）**：四條獨立數據流（Q-RL oracle / tradeHistory ground truth / attribution live / combo WR）證實「sell 喺現有 dominant regimes 係負期望」——30d→14d→8d 單調惡化（buy +0.29%→+1.51%，sell -0.08%→-0.92%）。ShadowPosition 冇 regime 維度 → edge-calculator 用 overall WR 誤導升市決策。

**三階段接入**（`src/evolution/q-rl-table.ts` + `src/index.ts` + `src/evolution/shadow-trade-engine.ts`）：

| 階段 | 功能 | 機制 |
|---|---|---|
| **1.1** | Meta-Agent prompt 注入 | `buildOLRBlock` 尾部加 `=== Q-RL EXPECTANCY (state bucket: ...) ===`——BUY/SELL Q-value + n + **median（skew-robust）**；樣本飢餓 bucket → 明確「NO directional claim」 |
| **1.2** | Conviction multiplier | `qrlExpectancyMultiplier()`（pure，多條件：visits≥20 AND median<0 AND trim<0 AND Q<-0.2% → ×0.5）；非對稱（positive boost 只喺 t≥2，default OFF）；per-bucket；floor ×0.5 唔 hard-block（保留跌市 sell edge） |
| **1.5** | Shadow A/B 驗證 | `shadowType:'qrl'` + `openQRLShadow()`——**獨立開倉 arm**（每 cycle × 每 trading market，唔理 LLM 投票），同 aligned shadow 對賭，causal paired-uplift 驗證方向訊號係咪真係加 edge |

**QRLTable Expectancy API**：`getCellExpectancy()`（median/10% trimmed-mean/t-stat/Wilson）+ `getDirectionLean()`（sample-guarded）+ `qrlExpectancyMultiplier()`（pure function，可單元測試）。7 個 env flags（`QRL_DIRECTION_LEAN_ENABLED` / `QRL_EXPECTANCY_GATE` / `QRL_MIN_SAMPLES` / `QRL_NEG_THRESHOLD` / `QRL_DAMPEN_FACTOR` / `QRL_BOOST_FACTOR` / `QRL_DIRECTION_MIN_SPREAD`）。

## Shadow Pool Priority Eviction（v2.0.861 — blind 讓位俾真統計 A/B 臂）

**問題**：blind shadows（0.1× cold-start prior，兩邊開，2%/5% SL/TP 喺低波動市況好少 resolve）壟斷 60-slot pool（實測 59/60），令 statistical（v2.0.846）+ qrl（v2.0.861）A/B 臂同 aligned arm（Q-RL 唯一 live feed）冇位開。

**修復**（`src/evolution/shadow-trade-engine.ts`）：`evictOldestBlindForRoom()`——pool 滿時 evict **最舊**、**未觸發 SL/TP barrier** 嘅 open blind（最接近 force-resolve、價值最低；已觸發 barrier 嘅保留等自然 resolve + feed OLR）。接入 3 個真統計 open 方法（aligned/statistical/qrl）。**aligned 補上 global total cap**（之前只有 per-symbol cap——latent unbounded-growth）。evict = **discard**（splice → 永不會 double-process；唔入 recentResults、唔 feed OLR）。Env：`SHADOW_EVICT_BLIND` / `SHADOW_EVICT_MAX_PER_CALL`。

## PAEL — Per-Asset Exit-Price Learner（v2.0.862 — 數據驅動離場價位）

**主神洞察**：好多交易觸碰唔到 TP → 賺唔到最盡 → giveback 反蝕（實測 35/195 = 18%）。TradeRecord.Max/Min Value Reached（MFE/MAE）100% 記錄，但從未逆向用嚟定離場位。

**Phase A — 學習器**（`src/analysis/exit-price-learner.ts`，學習層零執行影響）：
- **Per-asset × per-direction MFE/MAE 分佈**：MFE p50/p75/p90 + MAE p95——percentile-based（robust，outlier 免疫，**唔係 sigmoid/mean**）
- **轉換**：position-value → price excursion = margin%/safeLeverage；clamp [0, 0.5]；NaN/Inf → null（驗證門 96.1% 對照通過）
- **RECENT 保證**：60 日時間窗（`maxAgeDays`）+ rolling cap 100 筆 + backfill 顯式時間排序
- **加權**：real=1.0 · shadow=0.5（固定 SL/TP 截斷 = lower-bound）· paper=0.3
- **持久化**：exit-price-state.json（atomic，corrupt-tolerant）

**Phase B — 歷史模擬**（`scripts/exit-price-backtest.ts`，expanding-window 防 look-ahead）：

| 場景 | blended expectancy | 判定 |
|---|---|---|
| A（實際） | 0.0200 | 基準 |
| **B（⑥ 鎖利：MFE≥p75×0.8）** | **0.0284（+42%）**，PF 1.11，轉換 26 筆 | ✅ **通過**（sign test 弱 19v17） |
| C（① TP 定位：p50×0.8） | 0.0007（更差） | ❌ 未過——唔改 TP 距離 |

**Phase C — Exit-Price Lock Gate**（`src/index.ts`，TP-side one-vote exit）：
- **主神指令**：TP 側一票通過離場（鎖利），SL 保留噪音震動空間
- `runExitPriceLockGate()`（deterministic，每 cycle 喺 thesis-invalidation 前）：MFE price% ≥ 閾值（非 trending p75×0.8；trending p90 保守）AND 當前 profit > 0 AND 持倉 ≥ 15min → `closeTrade('exit_price_lock')`
- **大小資金兼顧**：閾值 + per-symbol×side 實測滑點（avgSlippageBps）——大資金喺薄 book fill 差自動保守；MFE% 係 scale-invariant（百分比同資金無關）
- **SL 永不觸碰**——gate 只 close（鎖利），唔會收緊止損
- closeReason `exit_price_lock`：白名單 + learning weight 0.5（系統決策）
- MFE CHECK soft block（per-position context）+ Meta-Agent 第 6 重「EXIT-PRICE MFE CHECK」
- Env：`EXIT_PRICE_CLOSE_ENABLED` / `EXIT_PRICE_LOCK_MIN_HOLD_MIN`

**工具**：`scripts/exit-price-audit.ts`（per-asset 分佈 + giveback 指標）· `scripts/exit-price-backtest.ts`（三場景模擬）· `scripts/qrl-audit.ts`（Q-RL oracle 審計）。

## LLM World-Model Layer（v2.0.863 — 讀圖 + 數據可靠性 + 真駁通）

**主神哲學**:「如果淨係統計判定 EV,使乜 LLM?——要用 LLM 本身嘅世界模型成為系統優勢」。LLM 唔係被統計 gate——佢係方向來源 + 世界事件來源;統計做歷史校準。

**Phase 0 驗證(謹慎)**:
```
news(新聞/宏觀):  median -0.52%(負 alpha——新聞已 price in)
chart(圖表/趨勢):  median -0.04%(打和——遠好過新聞 0.48pp)
dataQuality:       0(系統從未做過——全新領域)
```

**組件**(`src/analysis/` + `src/data/`):
| 組件 | 作用 |
|---|---|
| `kline-structure.ts` | 純函數:蠟燭 → 趨勢/形態/突破/成交量摘要(EMA+一致性、HH/LL、3 支破 20 支、baseline σ volume) |
| `data-quality.ts` | 純函數:funding/volume/spread/staleness σ 異常偵測 → qualityScore 0-1 |
| `chart-conviction.ts` | 純函數:conviction 校準——K-LINE 趨勢 vs LLM 方向(反向+無 catalyst ×0.75)、1h/5m 分歧(×0.85)、數據不可靠(×0.85)、catalyst 可 override(×1.0) |
| `thesis-catalyst.ts` | 純函數:thesis → catalyst 分類(strong/weak/none)——新聞/宏觀/數據事件/K 線結構(ASCII word-boundary lookaround——CJK 兼容) |
| `candle-cache.ts` | **Lazy Cache Pool**——1h+5m 蠟燭共享(fetch ≥100 支防 count 餓死、inflight dedup、fail cooldown、LRU bounded、依賴注入可測試) |

**真駁通**(conviction gate 內硬性乘法):
```
1h+5m 蠟燭 → cache → K-LINE 結構(雙時間框架)→ LLM 讀圖(thesis)
  → K-LINE 反向 + 無 catalyst → ×0.75
  → 1h/5m 分歧(大方向對但時機未到)→ ×0.85
  → 數據不可靠 → ×0.85
  → Q-RL 期望值 × causal × calibration → effectiveConfidence → trade/HOLD
```

**雙時間框架**(主神要求):1h 大方向 + 5m 入場時機——雙重分析——同向 = 雙重確認,分歧 = 校準。**LLM 讀圖支數(明確)**:1h 最近 **30 支**(30 小時趨勢)+ 5m 最近 **60 支**(5 小時時機)——cache 照 fetch ≥100(同 ATR/momentum 共享,防 count 餓死),但 buildKlineBlock 明確 slice 到設計支數,LLM 知自己睇幾多。

**Env flags**:`KLINE_BLOCK_ENABLED` / `DATA_QUALITY_BLOCK_ENABLED` / `CHART_AWARE_CONVICTION`。

---

## LLM Direction Verifier（v2.0.864 — 方向預測驗證）

每 cycle 記錄 LLM 判斷(含 HOLD)+ 雙層驗證窗口(quick/accurate 校準)+ 平倉結果 C(by tradeId idempotent)。三層 fallback(symbol×trend-type → trend-type 全局 → neutral)。錯判教訓注入 next cycle prompt。**用途**:統計 LLM 方向預測嘅歷史準確率——判斷層信任校準。

## EV Filter（v2.0.865 — 期望值濾波）

per (symbol×side) 真實 pnlPct(已含費)分布 → EV = pWin×avgWin − (1−pWin)×avgLoss。gate ×[0.75, 1.25](正 EV boost 判斷層、負 EV 軟性降)。**Kelly 建議完全移除**(主神:size 由用戶決定——Kelly 無用)。

## Close-Decision Calibrator（v2.0.866 — 平倉判斷校準）

- **Phase A 路徑感知驗證**:close 後追蹤 MFE/MAE 極值——net = MFE − MAE——premature_high(>1%)/premature_low(>0.5%)/correct(<−0.5%)/neutral——捕捉「中間錯失 + 最終避開」
- **Phase B 二次確認 Hold Gate**:過早率高情境嘅 close 決定 hold 一 cycle 再確認(3 cycle 超時兜底);SL/thesis/manual 永不 hold(死揸防禦)
- **v2.0.868 閉環**:persist(debounce save)+ PAEL threshold 校準(getLockThresholdMultiplier——過早率 >0.4 → 鎖利門檻 ×(1+(rate−0.4)),cap ×1.5)+ aggregate fallback(趨勢免疫——trend 變化唔令閉環失效)

## TG Signal Push + Supabase Trade Writer（v2.0.867 — 商品化訊號層）

- open/close 訊號推送 TG group(`@mats_trading`)——商業財務英語點列、profitOnlyClose、tradeId dedup
- close 事件 → Supabase `trade_records`(migration 20——trade_id unique + upsert idempotent——舊 trades 表結構唔 match 寫入失敗已修)
- `/api/trades` 返回 realTrades(UI Trade Incident 數據源)

## Profitability Analyzer（v2.0.868 — 量化分析器 + 閉環校準）

以概率/分布量化金融分析師思路——**「數據層/判斷層」組件——唔控制任何操作**(唔設時間限制、size 用戶決定、唔碰 SL):

| 功能 | 描述 |
|---|---|
| **Hold-Time EV** | per symbol×side,EV by hold bucket(<15m/15m-1h/1-4h/>4h)——最佳持倉區間提示(實証:<15m 負 EV -0.545% vs 15m-1h +0.505%) |
| **Direction Bias** | per symbol×side WR/EV/median——極端偏差 ⚠️ 標記(MU\|buy -51.7% 等) |
| **Fee Impact** | 累計手續費 vs trades(透明——fee 侵蝕量化) |

**閉環管道**:close 事件 → recordTrade(正確 trend1h/side lowercase)→ 過早率累積 → PAEL threshold 校準 + Meta-Agent 雙 side advice 注入(LLM 世界模型主導——統計校準)。

## Entry Quality System（v2.0.868-P1P2 — 入場質素——負偏度解藥）

**背景**:數據證明「輸贏喺入場嗰 5 分鐘決定」——蝕錢 trade 入場後立即逆向(MAE -5~-7.7% margin)、賺錢 trade 入場後立即順行(MAE -0.4~-2.4%)——負偏度(win rate 62% 但 avgLoss/avgWin = 1.9x)。

| 組件 | 描述 |
|---|---|
| **P1 Confirmation Gate** | 3 訊號:Price 位置(離開 zone——相對計算)/Momentum(1h 趨勢同向)/Noise(SL ≥0.8% 合理)——≥2 確認正常、1 → ×0.85、0 → ×0.7(判斷層——唔 hard block) |
| **P2 Entry MAE Profile** | rolling 30 日 window——全部 close 類型——過濾污染——保守 EV(Wilson LB + median)——soft multiplier(下限 0.75) |
| **Skew Analyzer** | avgLoss/avgWin ratio > 1.49 = 負偏度 trap——「win rate 高但贏細輸大」警告 |

**方向審計**(主神全面審計——「需要方向但冇分辨」嘅 function 全部修復):
- Close-Decision Calibrator:contextKey/windowKey/全部查詢加 side——BUY/SELL 過早率分開(之前混埋——PAEL 校準用污染數據)
- Thesis-Catalyst:sentiment(bullish/bearish/neutral)——chart-conviction 矛盾偵測(BUY + bearish → ×0.85)
- Side 大小寫全鏈:isBuySide(buy/long)/isSellSide(sell/short)——16 處統一(HL 'BUY'/'SELL' 大寫零顛倒)

**幻影 Reconciliation Close 修復**(「TG 賺 / UI 蝕」root cause):
- N 次確認(連續 2 sync 唔見先 close)+ 大小寫比較(全小寫)+ **fill 驗證**(close 前 confirmClosed callback——HL fills 有 closing fill 先 close——冇 → 系統 hold——**系統自己檢查,唔叫用戶核實**)
- `PNL/pnl.html` Dashboard:WEEKLY/YESTERDAY/TODAY + PAPER/REAL + $/% 三 switch、折線圖、Daily Trade Summary、Trade Records(最新最頂)、Capture PNG/PDF、Footer 3 QR codes

**Rate limit 防護**:所有 candle 經 `candleCache`(global limiter 2.5 req/s + TTL 120s + 每 cycle 1h+5m 各 1 次/active symbol)——4-5 次重複 fetch → 1 次。

## LLM Direction Verifier（v2.0.864 — 每 cycle 判斷記錄 + 雙層驗證 + 平倉結果 + 窗口校準）

**主神問題**:「有沒有記錄每次執行的時候 LLM 所給予的判斷和建議,來給予日後的 LLM 判斷之前對於相關資產和相關走勢的判斷是否正確?」

**核心**(`src/analysis/llm-direction-verifier.ts`):LLM 判斷品質嘅「預測層」校準——同 Conviction Calibrator(信心層)並排,都係 gate 乘數,直接左右決策但唔同權重(避免 double-count)。

```
每 cycle 記錄:recordJudgment(symbol, direction, trend-type, 判斷時 price)
  ——conviction gate 內執行,包括 HOLD/冇落單——樣本 = cycles(上萬級)
每 cycle 驗證:quick(下 cycle 現價 vs 判斷時價——即時回饋)
  + accurate(到 scheduledVerifyAt——較準窗口)——乘數用 accurate
平倉時:recordOutcome(trade 最終賺/蝕)——by tradeId idempotent
準確率:blend = (1-β)×accurate + β×平倉結果(β=0.3 當 C 有樣本)
三層 fallback:symbol×trend-type(≥10)→ trend-type 全局(≥20)→ 中性
  ——主神要求:新市場參考其他走勢
gate 乘數:accuracy → ×[0.80, 1.05] + shrink——永遠唔 hard block
```

**窗口自動校準(v2.0.864-accurate)**——「較準」功能:
```
per trend-type × 5 候選窗口(15m/30m/1h/2h/4h)
  → 每窗口累計準確率 → 自動揀「準確率最高 + 樣本夠」嗰個
  → 窗口隨歷史漂移(EWMA + 樣本懲罰)——唔好嘅窗口自然淘汰
→ 解決「5 分鐘即時驗證對 1h 趨勢判斷唔公平」——判斷後回調但判斷其實啱
```

**錯判教訓**:錯判次數注入 Meta-Agent block(「你對呢類判斷錯咗 N 次——方向與價格走勢一致先好堅持」)——LLM 自我改善。

**gate 鏈(v2.0.864 完整)**:
```
effectiveConfidence = calibratedConsensus(Conviction 校準,大範圍)
                   × OLR P(win) × causal × qrlExpectancy × chartMultiplier
                   × llmDirectionTrust(×0.80-1.05,方向層微調)
                   × calibrationTrust
```

**Env**:`LLM_DIRECTION_VERIFIER`。**攻擊硬化(v2.0.864-attack)**:`__proto__`/`constructor`/`prototype` keys prototype pollution 修復(UNSAFE_KEYS skip);`|` key 碰撞、null-price pending(56h stale)、窗口時間極端、double-call guard、毒 state——全部驗證安全。

## EV Filter（v2.0.865 — 期望值過濾器,量化金融分析師核心）

**主神數據**:30 日 757 fills net -$10,手續費 $9.75 為主——「手續費絞肉機」。
**Quant 思維**:win rate 高唔等於賺錢——55% win rate 但 avgWin 0.3% vs avgLoss 0.5%(+ 手續費)→ 負 EV——系統開太多「期望值 ≈ 手續費」嘅低質素單。

**組件**(`src/analysis/ev-filter.ts`):
```
每筆 trade close → recordTrade(symbol, side, pnlPct)——實際 PnL(已含費)
per (symbol × side) 分布(cap 300)
EV = pWin×avgWin − (1−pWin)×avgLoss
gate 乘數:EV ≥ 0 → 輕 boost(×[1.0, 1.25]——判斷層,fix7b 還原——
  effectiveConfidence 唔直接寫入 positionSizePct,size 用戶 slider + Meta-Agent 決定);
  EV < 0 → ×[0.75, 0.98] 線性壓抑(例:EV=-0.5% → ×0.875——判斷力,soft)
冷啟動(<20 樣本)→ ×1.0(唔 block 新市場)
注入 Meta-Agent:「EV FILTER」block——EV/pWin/avgWin/avgLoss/n
  (fix7d:Kelly 建議完全移除——size 用戶決定,建議無用)
EXP backfill(idempotent persisted backfillDone)
```

**size 決定權分工(主神裁決 v2.0.865-fix7b/d)**:
```
負 EV 降權 = 判斷力(系統唔慫恿開蝕錢單——用戶仍可開,soft)
正 EV boost = 判斷層(更有信心開正 EV 單——effectiveConfidence 唔寫入
  positionSizePct——size 永遠由用戶 Position Size slider + Meta-Agent 決定)
Kelly 建議 = 已完全移除(冇用,塞 LLM 浪費 context)
```

**gate 鏈(v2.0.865 完整)**:
```
effectiveConfidence = calibratedConsensus × OLR P(win) × causal × qrlExpectancy
                   × chartMultiplier × llmDirectionTrust × evMultiplier
                   × calibrationTrust
```

**Env**:`EV_FILTER`。**攻擊硬化**:`__proto__`/`constructor`/`prototype` 毒 key skip、NaN/Infinity/garbage sanitize、cap 300。

**修復 v2.0.864-fix2**:markPriceMap key 大小寫統一——WS set 大寫 'BTC' vs 查詢 lowercase → key miss → latest fallback → strict-price 全 null → B 驗證死亡——set 時 key 同 get 一致(lowercase bare / ':' 原樣)。

## Close-Decision Calibrator（v2.0.866 — 平倉判斷校準 + 二次確認 Hold Gate）

**主神問題**:連續 4 次 BUY BNB over-trade 蝕手續費——根因:consensus close 太快(1.5 分鐘 close 方向正確嘅倉——「見好即收」)。主神指引:「優化平倉判斷,而唔係設定規矩限制操作」。

**核心邏輯**(反事實代理):close 唔影響市場——「close 後價格走勢」=「如果冇 close 繼續持有嘅結果」——close 後繼續原方向 = 過早(錯失利潤)、反轉 = 啱(避開回吐)。

**Phase A(記錄 + 路徑感知驗證)**(`src/analysis/close-decision-calibrator.ts`):
```
記錄:只 consensus/thesis_invalidation(SL/PAEL/manual/reconciliation 排除——污染防護)
路徑感知:pending 追蹤 close 後極端價(min/max since close)
判斷:net = MFE − MAE(錯失 vs 避開)
  SELL:MFE=(close−min)/close;MAE=(max−close)/close
  net ≥1% premature_high、≥0.5% premature_low、≤−0.5% correct、之間 neutral
  (主神 edge case:SELL 跌 15min 再升返——單點驗證 miss——極端捕捉)
```

**Phase B(二次確認 Hold Gate)**——主神:「真係可以 hold 到平倉決定」:
```
過早率高(≥60%)+ 盈利 + consensus close:
  → pending-close(唔立即執行)
  → 下 cycle:再次 close = 確認執行;冇再 close = HOLD 取消(揸住);
     3 cycle 超時 = 兜底執行
  → SL/thesis/PAEL 永遠唔 hold(非 consensus reason)
  → 虧損 close 唔 hold(止血)、冷啟動唔 hold
  → 「有腦咁 hold」:只擋見好即收,唔會死揸(三重自動平倉永不 block)
```

**注入**:CLOSE-DECISION CALIBRATION prompt block(active position 時)+ legacy/per-symbol consensus close 兩處 gate + cycle 尾超時處理。

**攻擊硬化**:closePrice=0 division-by-zero(load skip + verify guard)、verifyWindowSec 秒/毫秒單位(V13)、毒 min/max、超大窗口 stale 兜底、`__proto__` sanitize、idempotent(by closeId)、**SL hit 用結構判斷 exempt(V14——唔用 rationale 文字——agents 措辭唔影響止蝕)、thesis_invalidation 永遠唔 hold(V26——判斷失效=趨勢反轉證據——只 hold 純 consensus)**。

**Env**:`CLOSE_DECISION_CALIBRATION`。

## Self-Aware Evolution（v2.0.843-848 — Meta-Cognition + Self-Improving + Causal Reasoning + Meta-Learning + Component Attribution）

v2.0.842 新增三大進化組件 + 混合數據源架構。v2.0.843 新增 ANN index + asset-aware Meta-Learner + Skeptics evolution block fix。v2.0.844-848 新增 Component Attribution + LLM-vs-Stats A/B shadow + Label Cleanliness（見下方專節）。系統唔再只係從交易結果學習，而係知道自己幾準（元認知）、自動調整自己嘅 hyperparameters（自我改善）、區分因果同相關（因果推理）、學點樣學得更快（元學習）、量度邊個組件真正加 edge（歸因）。

### Meta-Cognitive Calibrator（`src/evolution/meta-calibrator.ts`，v2.0.837）

系統知道自己嘅 P(win) 預測整體準唔準。每筆 trade close 時記錄 `(predictedPWin, conviction, regime, outcome)`，計算 Brier score + ECE。Per-regime Brier 追蹤。`getCalibrationBlock()` → HACP `setMetaCalibrationBlock()` → 注入 `rilEnhancedMarketDesc`。

### Self-Improver（`src/evolution/self-improver.ts`，v2.0.838）

系統自動調整自己嘅 hyperparameters：Thompson Sampling bandit（`explorationStrategy`）+ OLS gradient（`convictionGateThreshold` [0.40, 0.60]、`dcsTimeDecayHalfLife` [100, 400]）。v2.0.857 移除 dead `aggressiveSlCap` [0.05, 0.09] + `conservativeSlCap` [0.02, 0.04]（風險等級已移除，`dcsSlCap()` 永遠返回 5%）——bandit 唔再浪費運算 tune 冇 consumer 嘅參數。Hard bounds 限制。`runTuningCycle()` apply all recommendations with audit logging。

### Causal Reasoner（`src/evolution/causal-reasoner.ts`，v2.0.839）

區分因果同相關。

**Paired shadow uplift**：每開一筆 aligned shadow，同時記錄「如果冇交易」嘅 counterfactual。

$$\text{Uplift} = \text{tradedPnl} - \text{holdPnl}$$

- Uplift > 0 = 交易有因果效果（有 alpha）
- Uplift ≈ 0 = 交易冇因果效果（只係跟市場）
- Uplift < 0 = 交易有負面因果效果（SL hit 但市場冇郁）

**Permutation causal feature importance**：打亂每個 feature 嘅值，睇 PnL 預測跌幾多。跌好多 = causal。唔跌 = spurious correlation。

**`recordAuditConfounder()`**：trade-audit 發現嘅 confounder 標記到 feature importance。

**HACP block**：uplift warning（≈0 = no alpha）+ feature importance + confounder detection。

### Meta-Learner（`src/evolution/meta-learner.ts`，v2.0.840+843）

系統學點樣學得更快。

| 機制 | 作用 | 範圍 | 數據源 |
|:---|:---|:---|:---|
| **Adaptive α** | 高 reward variance → 低 learning rate | [0.1, 2.0] × | Q-RL ✅ |
| **Feature weight** | 高 predictive power → 高 weight | [0.1, 3.0] | Shadow ✅ |
| **Curriculum** | Fast-learning regime → 優先探索 | [0, 1] priority | Q-RL ✅ |

**`recordAuditFeatureAdjustment()`**：trade-audit 發現 thesis 矛盾 → 降 thesis feature 嘅 predictive power → weight 自動降。

**v2.0.843 Asset-aware feature weighting**：3-level hierarchy（symbol → category → global）。每個 asset 學自己嘅 pattern（SILVER 可以學到「OB imbalance works for me」而唔俾 BTC 拖低）。`deriveAssetMetadata()` 分類：crypto（唔按 vol 拆分）、commodity、forex、equity、other。低 volume ≠ 唔可靠——每個 asset 有自己嘅 pattern，weight 來自數據唔來自 volume 假設。`getAssetAwareFeatureWeights()` 做 3-level blend，warmup at 30 samples。

### 混合數據源架構（Hybrid Data Source）

| 組件 | 數據源 | 原因 | 速度 |
|:---|:---|:---|:---|
| Self-Improving (config bandit) | Shadow ✅ | explorationStrategy 直接影響 shadow | 10-50× |
| Self-Improving (param tuning) | Real ❌ | convictionGate / SL caps 影響真金白銀 | 必須 real |
| Causal Reasoning (uplift) | Shadow ✅ | counterfactual 只可能用 paired shadow | 天然 |
| Meta-Learning (adaptive α) | Q-RL ✅ | 已經係 Q-value change rate | 已最快 |
| Meta-Learning (feature weight) | Shadow ✅ | Shadow resolution 快 10-50× | 10-50× |
| Meta-Learning (curriculum) | Q-RL ✅ | regime learning speed = Q-value 變化 | 已最快 |

### Trade-Audit → Evolution 路由（`feedAuditToEvolution()`）

Trade-audit LLM 每 2 個 cycle 發現 incidents，而家會路由到進化組件：

| Audit category | 灌入 | 效果 |
|:---|:---|:---|
| `direction-repetition-loss` | SelfImprover | 負 reward → bandit 降 config alpha |
| `low-conditional-win-rate-ignored` | SelfImprover | 負 reward → conviction gate push |
| `premature-exit-mfe-mismatch` | SelfImprover | SL cap push |
| `sl-too-tight-for-volatility` | SelfImprover | SL cap push |
| `overtrading` | SelfImprover | conviction gate push（降頻率） |
| `thesis-contradicts-action` | MetaLearner | thesis feature 降 predictive power |
| `thesis-quality-issue` | MetaLearner | thesis feature 降權 |
| `market-condition-pattern` | MetaLearner | regime feature 降權 |
| `data-quality-issue` | CausalReasoner | 標記為 confounder |
| `default` | SelfImprover | 弱負信號 |

**Severity weighting**：critical ×1.0，warning ×0.5，info ×0.25。

### Backfill 機制

`backfillFromExpRecords()` 喺系統重啟時讀取 1640 條 EXP 記錄（1038 條有 marketFeatures），灌入三個新組件：

| 組件 | Backfill 量 | 效果 |
|:---|:---|:---|
| MetaLearner | ~10K feature observations | adaptive feature weights 即時生效 |
| CausalReasoner | ~1038 paired shadows | uplift + feature importance 即時計算 |
| SelfImprover | ~50 performance windows | config bandit + param tuning 即時啟動 |
| ComponentAttribution (v2.0.848) | 全部 EXP records | 歸因 dashboard cold-start 唔空（Causal 除外——EXP 冇 per-symbol data） |

---

## Component Attribution + LLM-vs-Stats A/B（v2.0.844-848 — 邊個組件真正加 edge？）

Verification-first 基礎設施：系統唔再假設每個進化組件都有價值，而係量度每筆 trade 每個組件嘅實際 contribution。Attribution 係 cost-benefit 分析，唔係 prediction——佢答「邊個組件加 edge」，唔答「市場會唔會升」。

### Component Attribution Store（`src/evolution/component-attribution.ts`，v2.0.844）

| 元件 | 說明 |
|:-----|:-----|
| **Proxy credit assignment** | `contribution = (agreement − 0.5) × 2 × sign(pnlPct)`。組件同意咗贏錢嗰邊 → 正 credit |
| **Cold-start safe** | `< MIN_SAMPLES (10)` → neutral stats，永遠唔會過早 prune |
| **Idempotent** | per `(tradeId, componentId)`——backfill + live 唔會 double-count |
| **Bounded** | ring buffer MAX_RECORDS = 10k，rolling eviction |
| **Hardened (v2.0.845)** | sanitize undefined/null symbol + empty regime；load purge evicted seenKeys（無 stale-token leak） |
| **`getCleanlinessOverview(lookbackMs)`** | label-quality summary：per-regime clean/polluted rate，由 `computeLearningWeight` 推導（v2.0.846 Phase 1b） |
| **`getComponentStats()`/`getAllStats()`** | per-component expectancy、contribution、samples、confidence |
| **Persistence** | `component-attribution.json`（atomic save/load） |

**⚠️ 真實數據審計（v2.0.855-audit，`component-attribution.json`）**：

| 發現 | 數據 | 含義 |
|:-----|:-----|:-----|
| **97% 係 backfill** | 1026 records 中 992 係 cycleId=0（歷史 EXP backfill），得 34 筆 live | Attribution 統計主要反映歷史，唔係現時系統行為 |
| **Live OLR contribution 係負數** | 34 筆 live：`olr` contribution = **-4.586**（19 筆）；`causal-uplift` = -0.031（15 筆） | **OLR 信號喺真實交易上實際係「減低 edge」**，同文檔宣稱嘅「PRIMARY factor」相反——需要調查點解 |
| **Regime 極度集中** | low_volatility 891/1026 (87%)；mean_reverting 127；trending_bull 8 | 絕大多數學習發生喺單一 regime，其他 regime 樣本極少 |
| **OLR agreement 差異微弱** | 贏時 avg agreement 0.505 vs 蝕時 0.494（差 0.011） | OLR signal 嘅預測力好弱，接近 random |

**結論**：Component Attribution 框架存在，但**數據主體係 backfill（97%），live 樣本太少（34）且顯示 OLR 係負貢獻**。喺累積足夠 live 樣本之前，唔可以根據 attribution 數據做組件增刪決定——但佢指出一個需要調查嘅方向：**OLR 信號可能唔係淨加 edge**。

### ⚠️ 更深層發現（v2.0.856 audit）：兩個疊加嘅測量謬誤

**謬誤 1：signal contract bug——causal-uplift 對 SELL 信號被錯誤反轉（已修 v2.0.856）**

`recordAttribution()` 嘅契約係「signal > 0.5 = bullish, store 對 SELL 反轉」。但 causal-uplift caller 傳嘅係 direction-agnostic 嘅 `0.5+uplift`（uplift>0 = 呢筆 trade 有正 alpha，唔係市場向上）——對 SELL 交易被 store 反轉 → 正 alpha 記錄成負 contribution。**OLR caller 僥倖正確**（caller 反轉 `1-P(win|sell)` + store 再反轉 = 雙重反轉 cancel），但 causal 冇 caller 反轉 → 單次反轉錯。Live causal-uplift contribution = -0.031 主要就係來自呢個反轉（16 筆中 14 筆 SELL）。

**修復（v2.0.856）**：統一 signal 契約——caller 全部傳 raw bullish degree（>0.5 = 睇升），direction-agnostic 指標（causal uplift）必須由 caller 轉換：`buy → sig, sell → 1-sig`。更新 store 註解講清楚契約。11 個測試鎖定。

**謬誤 2：OLR 極端信號污染統計（未修，需進一步調查）**

OLR live attribution 記錄中 9/20 係極端 agreement（>0.9 或 <0.1，即 P(win) 99%+），而其中 5/9 係錯（overconfident）。Calibration bins 揭示根源：BTC long 65814 樣本中絕大多數集中喺 [0.6-0.8) bin（594W/208L，實際 WR 74%）——**OLR 成日輸出高 P(win)，而呢啲「高信心」預測喺真實交易時一半錯**。呢個係 selection bias：系統傾向喺 OLR 話高勝率時先開倉，但「高信心」唔保證「高準確」。

**對 Edge 審計嘅影響**：v2.0.856 前嘅 attribution 數據（尤其 causal SELL + OLR 極端信號）不可信。判讀組件 edge 應以 v2.0.856 後新累積嘅 live 記錄為準。可用 `npx tsx scripts/edge-audit.ts` 做唯讀審計。

### ⚠️ Attack 系列（v2.0.856-attack/attack2/attack3）：side/symbol 維度嘅 guard 補完

| 版本 | 漏洞 | 修復 |
|:-----|:-----|:-----|
| v2.0.856-attack | **V8 side 不對稱**：caller `=== 'buy'` vs store `=== 'sell'`——garbage side（'SELL' 大寫/undefined/'long'）令 caller 反轉而 store 唔反轉 → contribution 反轉。**V9** edge-audit 對 malformed records crash。**V10** store 存 raw garbage side | 加 `normalizeTradeSide()` helper（component-attribution.ts）——caller 同 store 共用，garbage → 'unknown' → 兩邊都唔反轉（中性，永不捏造方向）。12 測試 |
| v2.0.856-attack2 | **V11 side fabricate**：`trade.side === 'buy' ? 'buy' : 'sell'` 喺 8 個 call site 將 undefined/'BUY'/'long' 靜默當 sell → 污染 bySide 統計 + 方向標籤。**V12** uplift 未 sanitize（NaN/string）。**V13** boxed String 驗證安全 | `onPositionClosedLearning` 開頭統一 guard：side 唔 canonical → skip 成個 learning block（保護 8 個下游 consumer）。Attribution block skip unknown side。`ComponentAttribution.side` type 拓寬至 `'buy'\|'sell'\|'unknown'`。`safeNum(uplift)`。4 測試 |
| v2.0.856-attack3 | **E2/E3 symbol crash**：restore 路徑 `symbol: t.symbol` 無 runtime guard——undefined symbol + valid side 通過 side guard → `olrEngine.feedTrade(undefined)` → `undefined.toLowerCase()` TypeError crash | Guard 同時驗證 symbol：`safeSymbol = typeof trade.symbol === 'string' && trade.symbol.length > 0`。side 或 symbol 任何一個唔 valid → 完全隔離 corrupt record。4 測試 |

**核心防禦原則（v2.0.856-attack 系列）**：一個 corrupt trade record 而家係「完全隔離」——無論 side/symbol/uplift 邊個字段壞，統一 guard 都會 skip 成個 learning 記錄，唔會用錯誤方向/錯誤 symbol 污染任何 learning 系統，亦唔會 crash 到 `feedTrade`/`normalizeSymbol`。

### Phase 1a：LLM vs 純統計 A/B Shadow（`shadow-trade-engine.ts`，v2.0.846）

新 `shadowType: 'statistical'`——方向**淨**由統計組件（OLR P(win) + Combo WR + Causal uplift）計算嘅 shadow，`openStatisticalShadow()` + `hasStatisticalShadow()`（per symbol+side+cycle dedup）。

**點解**：Aligned shadow 跟 LLM 共識，blind shadow 跟 noise——但都冇對照組去隔離「LLM 共識本身」有冇加 edge。Statistical shadow 係同一個市場條件下嘅受控 A/B：LLM 驅動嘅 aligned shadow vs 純統計 shadow 對賭，隔離 LLM 嘅邊際價值。

**OLR source routing**：`statistical` → `'shadow'`（full weight，真實統計信號），`blind` → `'shadow_blind'`（0.1×）。

### Phase 2a：Causal-Grounded Entry Gate（`index.ts`，v2.0.844）

`computeCausalConvictionMultiplier()`——negative causal uplift → 乘法 conviction 折讓 `[0.5, 1.0]`。Soft gate，永遠唔 hard-block（owner P1）。只有 aligned shadow 顯示 positive causal alpha 先俾 full size。Cold-start safe（insufficient samples → 1.0）。

### Phase 2b：Meta-Calibrator → Dynamic Trust（`index.ts`，v2.0.844）

`computeCalibrationTrustMultiplier(regime)`——per-regime Brier：差過 random（Brier > 0.25）→ ×<1.0，良好校准（Brier < 0.20）→ ×>1.0。委託現有 `getConfidenceAdjustment()`。Clamped `[0.5, 1.5]`。insufficient data → 1.0。

### Attribution 錄製（`onPositionClosedLearning`）

- OLR signal（`entryOlrPWin`）+ Causal uplift signal → `componentAttribution.recordAttribution`
- Cleanliness 由 `computeLearningWeight`（close-context-aware）推導
- `normalizeSymbol` 對 undefined symbol 加 guard（legacy/corrupt trade records——之前係 crash vector）

### v2.0.847：Fix `computeStatisticalLean` cross-symbol contamination

**BUG**：`computeStatisticalLean` 無條件用 `this.lastFirstPassage`，但 first-passage 淨係為 active symbol 計算。Aligned-shadow A/B loop 為**所有** trading symbols 開 statistical shadow——所以非 active symbols 被餵咗 active symbol 嘅 path-risk 數據，污染咗 LLM-vs-stats 比較。

**FIX**：加 `isActive` guard——first-passage 淨係喺 symbol 係 active symbol 時先 contribution。非 active symbols 只用 OLR + Combo WR + Causal uplift。另外 guard undefined/empty symbol + non-object features。

### v2.0.848：Backfill Component Attribution

`backfillFromExpRecords()` 為每條 EXP record 餵 `componentAttribution.recordAttribution`——`attrFed` counter、OLR signal 由 `rec.olrPWinAtEntry`、cleanliness 由 `computeLearningWeight`、regime 由 `rec.regime`。每次 cold-start 執行，令 dashboard 唔空。Causal uplift 跳過（EXP 冇 per-symbol historical data——by design 冷啟動）。

### API 暴露（`advancedLearning`）+ UI

- API：`componentAttribution`（size / components / per-component stats）+ `labelCleanliness`（records / avgCleanliness / cleanRate / pollutedRate / byRegime）
- UI：`ComponentAttributionSection`，格式與 OLR/Experience/EM/RIL 對齊（`evo-section-header`/`evo-section-accent`/`evo-section-toggle`），systemsTotal 15 → 18

**驗證**：41/41 attack tests（`v2.0.844-attribution-attack.test.ts` + `v2.0.846-stat-shadow-attack.test.ts`），91/91 stat-shadow + attribution + evolution，`tsc --noEmit` zero errors。

---

## 其他子系統

### S/R Zone Detection（`support-resistance.ts`）
SNR-based 支撐阻力區間。輸出 nearestSupport/Resistance + distanceBps。用於 SL/TP 定位 + OLR `srDistanceBps` feature + First-Passage SL/TP distances。

### SystemGuard（5 層）
| Guard | 功能 |
|:------|:-----|
| A — Calendar | 經濟日曆事件（高波動時段降倉） |
| B — Drawdown | 回撤 ≥ 20% → 平倉所有 |
| C — Data Freshness | 數據過時 → HOLD |
| D — Agent Track | Agent 響應追蹤（circuit breaker 3 failures → 30s fail-fast） |
| E — Liquidity | 流動性不足 → veto |

### LLM 抽象層（`llm/`）
Provider interface + Ollama provider（circuit breaker + concurrency 4 + 指數退避）。支援 local + Pro cloud models。`OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:0731-cloud`。

### 數據管道（`data/`）
Hyperliquid WebSocket（l2Book + trades + activeAssetCtx + clearinghouseState + userFills）+ REST fallback。Binance WebSocket（輔助）。Global HL rate limiter（single queue, 429 retry）。WS infinite reconnect + REST polling backoff。

### 永續儲存（`persistence.ts`）
`lockedWrite()` atomic write。State files: `olr-state.json` · `shadow-state.json` · `trade-patterns.json` · `evolution-state.json` · `portfolio-state.json` · `market-agent-config.json` · `debate-history.json` · `em-state.json` · `na-model.json` · `cycle-history.json` · `anti-patterns.json` · `root-command-prompt.json` · `loop-engineering-memory.json` · `exp-embeddings.json`。

---

## 配置與環境變數

```bash
# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:0731-cloud

# ═════════════════════════════════════════════════════════════
# ANALYSIS MODE — 訊號運算模式（v2.0.822+，核心架構開關）
# ═════════════════════════════════════════════════════════════
# 'true'  — 僅計算訊號 + 寫入 Supabase，唔下單（純訊號後端）
# 'dual'  — 訊號 + 執行（寫 Supabase + paper/real 交易）← 生產預設
# 'false' — 僅執行，唔寫 Supabase（legacy 獨立交易模式）
ANALYSIS_MODE=dual

# ═════════════════════════════════════════════════════════════
# SUPABASE — 訊號輸出目標（v2.0.822+）
# ═════════════════════════════════════════════════════════════
# 後端用 service_role 寫入 asset_analyses 表；客戶端用 anon key 讀取
# 缺少時 → analysis writer disabled（local-only mode，僅 log 輸出）
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=          # ⚠️ service_role — 永不 ship 到客戶端

# Hyperliquid (optional, real trading — dual/execution mode)
HYPERLIQUID_WALLET_ADDRESS=
HYPERLIQUID_PRIVATE_KEY=             # ⚠️ RADIOACTIVE — 永不 commit

# Paper Trading
PAPER_INITIAL_BALANCE=1000
PAPER_MAX_POSITION_SIZE_PCT=0.20
PAPER_MAX_DRAWDOWN_PCT=0.20
PAPER_DAILY_LOSS_LIMIT_PCT=0.05

# Risk
RISK_MAX_LEVERAGE=1.0
RISK_STOP_LOSS_PCT=0.02
RISK_TAKE_PROFIT_PCT=0.05
RISK_TRAILING_STOP_PCT=0.015

# HACP
HACP_PARALLEL_THINKING_TIMEOUT_MS=15000
HACP_MAX_DEBATE_ROUNDS=1
HACP_CONSENSUS_THRESHOLD=0.50
HACP_TOTAL_TIMEOUT_MS=120000
HACP_STAGGER_DELAY_MS=6000

# System
DECISION_INTERVAL_MS=300000           # 5 min
API_PORT=3456
LOG_LEVEL=info

# RIL (Reason Intelligence Layer)
RIL_ENABLED=true
RIL_CLUSTER_THRESHOLD=0.75
RIL_MIN_CLUSTER_SIZE=3
RIL_MAX_PATTERNS_DISPLAY=10
RIL_SIMILAR_TRADE_COUNT=5
RIL_SUBTLE_DIFF_ENABLED=true
```

所有環境變數啟動時經 **Zod schema** 驗證。失敗 → 立即退出 + 詳細錯誤訊息。

**`ANALYSIS_MODE` 行為矩陣**：
| 設定 | 訊號計算 | 寫入 Supabase | 執行交易 | 適用場景 |
|:-----|:--------:|:------------:|:--------:|:--------|
| `true` | ✓ | ✓ | ✗ | 純訊號後端（mats_app 客戶端執行）|
| `dual` | ✓ | ✓ | ✓ | 訊號 + 後端執行（生產預設）|
| `false` | ✓ | ✗ | ✓ | Legacy 獨立交易模式 |

---

## 技術棧

| Category | Technology |
|:---------|:-----------|
| Language | TypeScript 5.6（嚴格模式，`noPropertyAccessFromIndexSignature`，零類型錯誤） |
| Runtime | Node.js 22+ |
| LLM | Ollama（local + Pro cloud）/ OpenAI-compatible |
| Market Data | Hyperliquid WebSocket + REST（9 perpetual DEXs） |
| 訊號輸出 | Supabase `asset_analyses` 表（service_role 寫入，anon 讀取）|
| 客戶端 | **`mats_app`**（Expo React Native + Reanimated + Three.js）— 風險選擇 + 執行 |
| 客戶端錢包 | `mats_app` `src/wallet/`（自託管，SecureStorage，`@noble/curves` 簽名）|
| 客戶端數據 | `mats_app/trade-bridge`（HL WS 市場數據 + on-chain reconciliation，永不簽名）|
| Legacy UI | `ui/`（React 18 + Vite — 已由 mats_app 取代，保留作 local dashboard）|
| Config | Zod schema validation |
| Logging | Winston（structured + file rotation） |
| Testing | vitest（~3,000 tests / 186 suites，gitignored；3035 pass / 13 pre-existing；4 attack suites: q-rl-attack, changelog-features-attack, creative-attacks, q-rl-creative-attacks）|
| Crypto | `@noble/curves`（HL phantom agent signing） |
| Vector Embedding | Transformers.js MiniLM L6 v2（384-dim, in-process, CPU） |
| Pattern Clustering | Greedy cosine clustering（RIL Reason Intelligence Layer） |

---

## 啟動

```bash
npm run engineer    # 自主進化模式：訊號運算 + System Engineer 自主修復 + 修復後自動重啟
npm run dev         # 開發模式：API :3456 + legacy UI :5173（concurrently）
```
API: **http://localhost:3456/api/status** · Legacy Dashboard: **http://localhost:5173/**

**訊號運算模式**（`ANALYSIS_MODE=true`，配合 `mats_app`）：
1. 後端每個 cycle 計算 HACP 共識 → 擴展成 1×3 矩陣（v2.0.857 moderate-only）→ 寫入 Supabase `asset_analyses`
2. 客戶端 `mats_app` 用戶選擇風險等級（high/mid/low）→ 讀取對應矩陣格 → 決定執行
3. 後端唔下單——純訊號輸出。執行由客戶端 `useAutoTrade` hook 處理

**Dual 模式**（`ANALYSIS_MODE=dual`，生產預設）：
1. 後端同時計算訊號 + 寫入 Supabase + 執行交易（paper/real）
2. 客戶端同時可讀取矩陣做手動/自動執行

**`npm run engineer` 自主進化模式**：
1. `engineer-loop.sh` 啟動 `tsx src/index.ts`（`SYSTEM_ENGINEER_ENABLED=true`）
2. 訊號系統正常運行，每 2 個 cycle（cycle period ≥ 5 min 時）觸發 System Engineer
3. System Engineer 審查交易記錄 + 源代碼 → 生成修復 → `tsc --noEmit` + `npm test` 驗證
4. 全部通過 → git commit → `process.exit(42)` → `engineer-loop.sh` 偵測 exit code 42 → 重啟進程
5. 任何失敗 → 自動 rollback（恢復原始文件）→ 繼續運行
6. 重啟後加載新代碼 → 繼續運算 → 2 個 cycle 後再檢查 → 循環

**安全設計**：
- System Engineer 只可修改 `src/evolution/` + `src/cognition/` + `src/analysis/` + `src/agents/` + `tests/`
- 禁止觸碰 `src/trading/`（下單/SL/TP/簽名）+ `src/config/`（風險設置）+ `src/index.ts` + `.env`
- tsc + test 安全網：任何失敗 → 自動 rollback，不會應用未驗證的代碼
- Dual/execution 模式時，重啟期間持倉由 HL 交易所的 SL/TP trigger orders 保護，不依賴本地進程

---

> 完整版本歷史請見 [CHANGELOG.md](CHANGELOG.md)。

---

## v2.0.227: Plan G — Dynamic Threshold [45-55%] + Multiplicative Penalty with Decay

### Problem: Death Spiral

The conviction gate had a compound punishment design:
- **Additive threshold raise**: 3 penalty gates (loss-streak, conditional WR, combo WR) added to the threshold (50% + 30% = 80%)
- **Multiplicative confidence discount**: P(win) × consensus (65% × 0.685 = 44.5%)
- **Result**: 44.5% vs 80% = 35.5pp gap → trading mathematically impossible → no new trades → penalty never resets → permanent STUCK

### Solution: Plan G — Unified Multiplicative Model

```
effectiveConfidence = consensus × pwinBlendFactor × penaltyFactor
dynamicThreshold     = 50% + (totalScore × 0.5%)  →  [45%, 55%]

if effectiveConfidence ≥ dynamicThreshold → TRADE
if effectiveConfidence < dynamicThreshold → HOLD
```

**5-factor dynamic threshold** (each factor [-2, +2] with hysteresis):
| Factor | -2 (relax) | 0 (neutral) | +2 (tighten) | Sample req |
|--------|-----------|-------------|-------------|------------|
| Rolling WR | ≥55% | 40-55% | <35% | ≥10 |
| Idle cycles | ≥20 | 5-20 | <2 | — |
| Drawdown | <3% | 3-10% | >15% | — |
| Rolling Sharpe | >1.5 | 0-1.0 | <-1.0 | ≥10 |
| Regime | trending | normal/mr | chaotic | — |

**Penalty decay**: `penaltyFactor = 1.0 - min(decayedPenalty, 0.30)` where `decayedPenalty = netPenalty × max(0, 1 - cyclesIdle/30)`. After 30 idle cycles (2.5h), penalty fully decays → system self-recovers.

**6 fairness guarantees**:
1. Multi-factor balance — no single factor dominates (each ±1%)
2. Symmetric design — good = bad influence
3. Sample-size requirement — WR/Sharpe need ≥10 trades, else neutral
4. Hysteresis — buffer zones prevent boundary oscillation
5. Hard cap — threshold [45%, 55%], mathematical guarantee
6. Fact-driven — all inputs are measured, settled outcomes

**SILVER SELL simulation**:
- Old system: threshold=80%, confidence=44.5% → gap=35.5pp → HOLD (impossible)
- Plan G (idle 36 cycles): threshold=50.5%, penaltyFactor=1.0 (decayed)
  - P(win)=55%, consensus=65% → 44.5% < 50.5% → HOLD (close, 6pp gap)
  - P(win)=79%, consensus=65% → 55.4% ≥ 50.5% → TRADE ✓ (strong signal always passes)

### Files
- `src/analysis/dynamic-threshold.ts` — DynamicThresholdCalculator (5-factor hysteresis + penalty decay)
- `src/index.ts` — Conviction gate replaced: additive → multiplicative + dynamic threshold
- `src/cognition/hacp.ts` — Added `getCyclesWithoutTrade()` getter
- `tests/dynamic-threshold-attack.test.ts` — 36 attack tests
