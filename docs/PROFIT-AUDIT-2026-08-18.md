# MATS 超額盈利審計報告 — 2026-08-18(v2.0.870-P20-C 之上)

**性質**：調查 + 實測 + 修正方案（未執行任何交易邏輯改動）。執行與否、順序，全部由主神裁決。
**數據**：最後 200 閉倉實單（`/api/trades`)+ `data/evolution/*` 學習器狀態 + 源碼追蹤。

---

## A. 硬證據（全部實測、全部可重現）

| # | 發現 | 量度 |
|---|---|---|
| A1 | **槓桿係 100% symbol 硬編碼混淆** — SKHX/MU=5x,其餘全部=10x。「5x 贏 10x 蝕」唔係槓桿效應，係 **symbol 選股效應**(SKHX 一隻貢獻 +$11.02/58 單；其餘市場合計負) | `symbol×leverage` 全正交 |
| A2 | **負 EV 病區全部行緊 10x**:GOLD 雙向 n=30 −$5.04、SILVER:sell n=16 25%WR、bnb:buy n=20 −$0.40——合計 **−$8.65/200單**,同時呢組全部行 10x → 用最大槓桿放大最弱嘅策略 | EV 表 |
| A3 | **<15 分鐘極短持倉 = 手續費絞肉機**:n=19,WR 26%,合計 **−$4.47**(平均單均 −$0.235) | hold-time 分桶 |
| A4 | **Close-Decision Calibrator(Layer 36,v2.0.866)出世至今零營養**:stats/pending/windowStats 全空、backfillDone=false。根因結構性：200 閉倉只有 **20 單**(12 consensus + 8 exit_price_lock）攜帶可校準 closeReason;`inferCloseReason()` 對普通 consensus close 返回 `'reconciliation'`(88/200!),**唔喺** `CLOSE_REASONS_TO_CALIBRATE` → 設計上 90% 嘅自主平倉俾過濾掉 | realTrades closeReason 分布:{reconciliation:88, sl_tp:42, none:39, consensus:12, tp_hit:11, exit_price_lock:8} |
| A5 | **xyz 家族同方向長期重疊持倉**:104 個 buy pair-overlaps + 35 個 sell pair-overlaps(GOLD/SILVER/SKHX/MU/SP500 同時同向)——金屬股關聯度高，同向重倉 = 單一 macro move 一次抹走多日 EV | overlap 計數 |
| A6 | **連蝕聚類統計顯著**:交易流 runs test z=−2.40(<−1.96)——虧損唔係獨立白噪聲，而係 regime 持續段；代表「市況辨認 + 降檔」有真實 alpha 空間（P17 runs-τ 已部分食到呢個，但只作用於 penalty decay) | runs z |
| A7 | **歷史 MAE/MFE 序列全面污染**(median MAE −900%、giveback −898% = 物理唔可能）——v2.0.868 key-mapping bug(P19' 已修 restore）嘅歷史屍體仍在 data 裡面。**後果**:PAEL/MFE-lock/close-calibrator 嘅歷史回測基於呢批數皆不可信；只有 v2.0.869 起嘅新數據可用（`dataMissing` 標記機制已涵蓋部分） | giveback 分析作廢，據此聲明 |
| A8 | **SKHX 依賴集中度**:58/200 單、+$11.02,接近全組合淨盈利 1.6×。SKHX alpha 一旦消失，系統轉負 | EV 表 |

## B. 方案（按 P×E/(σ×τ) 排序）

### P22-A | Close-Calibrator 飢餓修復（基礎設施，確定性價值）
- **做法**:① 所有 agent 驅動平倉路徑統一顯式 tag `'consensus'`(legacy 路徑已 tag,per-symbol decision close 路徑要查實）;② calibrator 接納擴充：加入 `computeLearningWeight` 語義一致嘅白名單審查 + 觀測計數（recorded/filtered/verified——P20-C 同款「飢餓有聲」);③ backfill from realTrades(persisted backfillDone)。
- **預期**:Layer 36 由永久 ×1.0 → 真實 premature 率 → Phase B hold gate 開始攔截「見好即收」（直接打 A3 嘅 <15m churn)
- **風險**:低（觀測先行）。**工時**:~1-2h。**信心**:95%(同 P19'/P20-C 同類 starvation)

### P22-B | EV 條件槓桿上限（A2 直擊，量化上限最大）
- **現實**:負 EV 桶行 10x = 放大虧損；同桶減半槓桿 → 虧損約減半（10x→5x 邊際 pnlPct 線性縮放 + 滑價變好）。
- **做法**（軟性、唔違反主神主權原則——設計為 **advisory + 可選 auto-cap**):
  - per symbol×side 用 EV Filter 已有 300-cap pnlPct 分布計 Wilson LB(95%) of EV;
  - n≥15 且 WLB(EV)<0 且 payoff<1 → leverage cap ×0.5(10x→5x;5x→2.5x floor 1x);
  - 反之 WLB(EV)>0 且 n≥20 → 唔郁（槓桿永遠唔加——只減唔加）;
  - env:`EV_LEVERAGE_CAP_ENABLED`（預設 true)+ advisory log,UI 顯示「EV 降檔中」。
- **預期**:counterfactual，若 GOLD/SILVER/bnb 負桶半槓桿 → **約 +$4.3/200 單** 淨改善（線性假設；實際可能更好因滑價減少）
- **風險**:中（改變倉位名義值 → 需對 size 邏輯全鏈路測試；P20-A 上線後兩者可能重疊 → 乘法去重）。**工時**:~3-4h。**信心**:80%

### P22-C | 手續費感知入場抑壓（A3 直擊）
- **做法**：入場前估算 round-trip 成本（taker fee×2 + 中位滑價 from execution-tracker)→ 若 planned TP 距離 < **k×成本**(k≈2.5，即期望毛利覆蓋唔到成本 2.5 倍）→ confidence ×0.8 軟抑；同時 Meta prompt 注入「TP 距離未能覆蓋成本」一句。
- **預期**:<15m 桶 −$4.47 大部分屬「期望跳動細過成本」結構；保守假設切走一半 → **+$2.2/200 單**
- **風險**:低（純進場端軟乘）；需用真 fee 率常數。**工時**:~2h。**信心**:75%

### P22-D | P20-A EV-Trust 軟乘數（已立議程，照推）
- **做法**:per symbol×direction 實績 EV(Wilson shrink,n≥15)→ ×[0.80,1.15] 軟乘 effectiveConfidence——殺「WR 高但 payoff 崩」盲點（GOLD:buy WR67% payoff 0.20)。
- **預期**:perfect-foresight 上限 +$12.5/200 單；軟乘現實捕獲一部分。**風險**:低中。**工時**:~2h(EV Filter 已有分布，複用）。**信心**:85%

### P22-E | 家族協方差敞口阻尼（A5，尾部風險防禦）
- **做法**:xyz-family同向持倉名義值合計 > 25% equity → 新的同向 xyz 入場 ×0.85(每多一倉再叠 ×0.92,floor ×0.65)；唔阻擋、只降置信。同時計入 SKHX 依賴警示（A8):SKHX 單一 symbol 市值 >30% equity → 同 symbol 新倉 ×0.9。
- **預期**:防禦性（期望值小幅改善 + 回撤尾部大幅削——MDD 改善為主）。**風險**:低。**工時**:~1.5h。**信心**:70%

### P22-F | Regime×Symbol EV 自適應表（A6,**數據依賴——排最後**)
- **前提**:P19' 之後 regime 開始持久化；需儲 ≥30-50 單/regime 格先有意義。
- **做法**:per (symbol × regime) EV 表 → regime-conditional multiplier;連蝕段（A6 z=−2.40 證有聚類）於 mean_reverting/chaotic 降檔 0.85-0.9。
- **工時**:~2h 實作 + **2-4 週數據累積**。**信心**:候補，唔係而家郁

### P22-G | 歷史 MAE/MFE 遷移（A7 清污，enable 未來回測）
- **做法**：一次性 migration script:realTrades 每單用 candle 重算區間 min/max price → 重寫 min/maxValueReached;fail 則標 dataMissing。**作用**:unlock PAEL/MFE-lock/close-calibrator/P20-B(TP 幾何）嘅可靠歷史回測。
- **風險**：只寫歷史數據，必先備份。**工時**:~2-3h。**信心**:90%（資料工程）

## C. 建議執行次序（主神裁決）

1. **A（calibrator starvation)** → 觀測第一，Layer 36 復活
2. **G（MAE/MFE 清污）** → 解鎖一切歷史回測（B/D/F 嘅驗證都靠佢）
3. **D(EV-Trust)** → 最乾淨嘅進場端 alpha 改善
4. **B(EV 槓桿 cap)** → 等 D 觀察 1-2 日後上，避免雙乘數疊加
5. **C（手續費抑壓）** → 與 A 嘅 calibrator 數據互補
6. **E（家族阻尼）** → 尾部防禦，隨時可上
7. **F(regime 自適應）** → 等數據

**一句講晒**：系統而家唔係「冇 alpha」——SKHX @5x 每單 +$0.19、bnb/btc/SP500 都有正區；真正嘅出血係**用 10x 行負 EV 桶（−$8.65)+ 超短持倉費用絞肉（−$4.47)+ 一個出世至今餓死嘅 close 校準器**。三個都係可以被實證、被軟性修復嘅工程問題。
