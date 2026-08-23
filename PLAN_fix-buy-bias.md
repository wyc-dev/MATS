# FIX PLAN — 系統性單邊 BUY Bias + BNB 連蝕修復（Phase 2 驗證完成版）

**北極星**: 消除 First-Passage 100% 幻覺造成嘅單邊 BUY 偏置 + BNB 固定 -8.3% 失血 loop，
以歷史數據（220 筆 realTrades）counterfactual 驗證每個 fix 先落 production code。

## Phase 1 根因驗證結果（已完成）

| # | 驗證項 | 數據 | 結論 |
|---|--------|------|------|
| 1.1 | FP 幻覺 | FP claimed ≥95% → **實際 WR 39.1%**（n=23, vs 全場 BUY 48.5%）;9/23 sl_tp; 聲稱 P 誤差 **57pp** | ✅ 確診：FP P=98-100% 係 model 錯覺，接近反指標 |
| 1.2 | Sell 壓制 | sell n=51 WR 43.1%; trending_bull 期間 **0 筆 sell**; SILVER sell 27% / SKHX sell 33% | ✅ sell 被 FP/trend 結構性壓死 |
| 1.3 | BNB SL 校準 | 10/10 SL hit **曾浮盈**（maxValue>investment）;SL 全部喺 **-0.83% price**;median -0.83% p90 -0.74% | ✅ SL 太貼，正常波動掃走所有倉 |

## Phase 2 邏輯實驗結果（已完成）

| 候選 fix | 實驗 | 結果 | 裁決 |
|----------|------|------|------|
| C: sl_tp cooldown block | 重播 220 筆 × 觸發 × 窗口 | 全部 variant missedWin > avoidedLoss; **+$3.69 bnb tp +$2.35 SKHX 都喺 sl_tp 後 12h 內開** | ❌ 一刀切 block 誤傷大贏家 → 改 soft |
| A: FP P cap 85% | claimed 分桶 vs WR | cap 後聲稱收斂但 85% 仍高過實際 39% | ⚠️ cap 唔夠 → 需要 drift shrink + honesty layer |
| B: edge vs50% 雙參照 | OLR P<50% 仍被開 BUY | 11/57 筆（OLR 40-46% 被包裝成「edge +11~17pp」） | ✅ 顯示層直接有效 |
| D: SL floor 1.5% | BNB SL 分佈 | 10/10 筆會放寬（全部 0.74-0.96%） | ✅ 有數據支持（曾浮盈 100%） |
| — | BNB buy 本身 WR | **55% WR net +$5.58（n=29）** | ⚠️ BNB buy 係正 EV——唔可以 block，只能修 SL/FP |

**關鍵 insight**: BNB buy 整體 55% WR 係正嘅，唔係「唔應該開」；問題係
(a) FP「100% 必勝」幻覺令 confidence 過高 → 入場時機差（追高）；
(b) SL 0.83% 對 BNB 正常波動太貼 → 每次正常回調都被掃；
(c) 被掃後再開，每次都蝕 -8.3%，感覺「連蝕連開」——但本質係 SL 設定 + 時機，唔係方向錯。

## Final Fix Set（只做呢 4 個，全部數據支持）

### Fix 1 — FP drift 校準（核心，`src/evolution/first-passage.ts`）
- `sanitizeDriftForRegime` 擴展至所有 regime：`ν_eff = ν × clamp(1, 0.5σ/|ν|)`
  → drift 唔可以主導 diffusion（GBM 短窗 drift 係 noise，統計上 SE≈σ/√20）
- P clamp：`longPWin/shortPWin ≤ 0.85`——永久封殺「100%」
- 顯示層 honesty：FP 區塊加 `backtest WR of claimed≥95 calls: 39%` 標註
- 效果：BNB thesis 由「FP LONG 100% edge +71pp」→「FP LONG ~65% edge +36pp」，LLM 唔再被必勝幻覺推向 BUY
- env flag `FP_DRIFT_SHRINK=false` 回滾

### Fix 2 — edge vs 50% 雙參照（`src/index.ts` context builder）
- OLR/FP edge 顯示同時標 `vs breakeven` + `vs 50%`：
  `OLR BUY P(win)=43% (breakeven +14pp | vs50% -7pp)`——負 edge 無所遁形
- 數據：11/57 低勝算 BUY 會被 LLM 重新考慮

### Fix 3 — SL 絕對 floor（`src/analysis/smart-sltp.ts`）
- SL price-basis floor: `max(ATR×1.2, MAE p95, 1.5%)`（新增 1.5% 絕對下限）
- BNB SL 0.83% → 1.5%（10x = 15% margin），正常回調唔再被掃
- env `SL_ABSOLUTE_FLOOR_PCT` 可調

### Fix 4 — sl_tp 蝕 1 次即 soft penalty（主神改動 2026-08-23）
- **改動**: 由「連蝕 3 次」改為「**sl_tp 蝕 1 次即 penalty**」——每次 sl_tp close 後，同 (symbol, side) 12h 內 re-entry 加 +25% conviction penalty
- **驗證**: sl_tp 後 12h same-side re-entry n=64 **WR 39.1% vs 全場 48.5%**（差 9.4pp）——re-entry 質素明顯差；但含 +$3.69/+$2.35 大贏家 → **必須 soft（+25% conviction,唔 block）**，高信心 breakout 照入
- 實作: `updateLossStreakTracker` 接收 closeReason；`sl_tp` → 設 `slTpPenalty` map（12h, +25% conviction）；`checkLossStreakGate` 檢查
- env `SLTP_REENTRY_PENALTY_HOURS` / `SLTP_REENTRY_PENALTY_STRENGTH` 可調

### Fix 5 — Fractal Momentum Sentinel（close-time LLM 趨勢持續性 gate）（主神新增 2026-08-23）
- **概念**: 主神指示——「每次共識 TP/SL 之前，LLM 根據現時 candles 緩存 chart 判斷 TP/SL 之後是否大機會反轉走勢」，如 Fractal Momentum Sentinel 上載蠟燭圖俾 LLM 判斷 regime，今次判定**趨勢是否大機會持續**，從而決定是否止蝕/鎖利
- **實作**: 新 `src/analysis/close-trend-sentinel.ts`——candleCache OHLCV（5m/15m/1h/4h）轉 ASCII 文字 chart → LLM 判斷 `continue / reverse / uncertain`
  - `continue`（趨勢會持續→close 係錯）→ hold（pending-close 機制，下 cycle 再確認，3 cycle 超時兜底）
  - `reverse`（趨勢會反轉→close 啱）→ 照 close
  - `uncertain`/LLM 失敗/超時 8s → 照 consensus close（**安全 fallback——止蝕永遠唔可以被 LLM 掛住**）
  - SL hit（price 已到 SL,closeStructureConfirmed）→ 永遠立即 close（市場確認,唔 hold）
- env `CLOSE_TREND_SENTINEL=false` 回滾；重入 guard；攻擊輪（毒 candles/垃圾 JSON/超時）

### 唔做（有數據原因）
- ~~cooldown hard block~~（誤傷 +$6 大單）
- ~~直接 block BNB buy~~（55% WR 正 EV）
- ~~sell 偏好注入~~（SKHX/SILVER sell 歷史 27-33% WR 真係差，靠 Fix 1+2 自然浮現）

## Phase 3 實施清單
- [ ] Fix 1: first-passage.ts 純函數 + 測試（shrink/cap/毒輸入）
- [ ] Fix 2: index.ts context builder + 測試
- [ ] Fix 3: smart-sltp.ts + 測試（BNB case）
- [ ] Fix 4: index.ts loss-streak 擴展 + 測試
- [ ] 攻擊輪（紅先→綠後）各 5-8 刁鑽測試
- [ ] 全量測試 + tsc clean + CHANGELOG/ARCHITECTURE 更新

**驗證門**: 全量測試 3263+ 全綠 + tsc 0 錯誤 + 攻擊輪 0 漏洞；Fix 1/2 用「同一歷史 trade 重新生成 thesis 顯示」確認 P 不再有 100%。
