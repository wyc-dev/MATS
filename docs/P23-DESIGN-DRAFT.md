# P23-A & P23-B 設計草稿（Design Draft,未定案 / 未實作)

> 主神裁決 2026-08-18:P23-A(Entry-Chase 抑制）+ P23-B（分層收割）係好機制但工程複雜 → **先出草稿，主神閱後先決定郁唔郁**。P23-C(regime-transition buffer)/ P23-D（家族協方差阻尼）**已封案唔做**（理由：此類判斷層有機會錯）。
>
> 本文全部內容 = 設計假設 + 風險推演，未改任何 code。

---

# P23-A — Entry-Chase 抑制(追價懲罰)

## 1. 問題陳述(實證)

- **8·18 SKHX 案例直接證據**:signal price $1236.20,實際 fill $1238.50 → **入口追價 +0.18%**(單單呢個已佔嗰單虧損 16%)。
- 機制問題:MATS 決策(gate 通過)同執行(`executeTrade`)之間存在 tick 延遲;期間價格順住決策方向漂 → **高信心信號喺更差價格成交**,實效 edge 被追價侵蝕。
- 呢類「追價」喺動量市場係合理代價(追價入嘅都啱),但喺 mean-reverting / sideways 係純負累(入場即刻逆市回撤)。

## 2. 方案架構(三層遞進,各自獨立)

### Phase A-1 — 觀測(必需,任何後續嘅前提)
**動機**:而家 `ExecutionTracker` 有記錄 open slippage,但佢度嘅係「填 price vs HL mark price」——**唔係我哋想要嘅「決策價 vs 執行價」**。

**設計**:
- 新增欄位 `signalPriceAtDecision: number` 喺 `executeDecision` 嘅輸入結構——記錄 gate 通過時 marketState 嘅價
- 執行後計 `chaseBps = (fillPrice − signalPrice) / signalPrice × 10_000`(side-aware:buy 正=追貴;sell 負=追平)
- per symbol × side EWMA + recent cap 50,persist `data/evolution/entry-chase.json`(同 stop-slippage 同款 lockedWrite)
- **觀測期 ≥ 20 單/symbol 先可以做 Phase A-2 判斷**

工作量:極細(~1h)。風險:零(純量度)。**呢一層強烈建議獨立做,就算 A-2/A-3 唔做都值得做。**

### Phase A-2 — 軟性抑制(判斷層)
**觸發**:executeTrade 之前,再讀一次 current price → 同 signalPrice 對比 → drift 超過 noise band 就降 confidence(唔 cancel):

```text
driftBps = (currentPx − signalPx) / signalPx   (buy 正=向上升走 = 追貴)
band     = max( 15, atr5m_bps × 0.5 )          // noise band:低於呢度唔當係追
excess   = max(0, driftBps − band)
mult     = 1 − excess / band × 0.15            // excess = 1×band → ×0.85(soft floor ~0.7)
effectiveConfidence × mult
```

- **唔 cancel 唔 retry**——因為下一個 cycle(4 分鐘後)自然會用新價 re-decide,chase 自己會消失;retry loop 會引入「追趲到又追趲到」嘅無限 loop。
- 參數 15 bps 係 placeholder——**真實 floor 要 A-1 觀測返嚟**。
- 只作用喺「順住決策方向嘅 drift」——如果價格反向漂(平咗),唔郁(甚至可考慮 ×1.05,但唔建議——容易製造撈底錯覺)。

### Phase A-3 — Limit-Order Entry(執行層,**高難度**,主神可能唔想做)
將 market entry 改做 limit @ signalPrice,設 N 秒 timeout 後 cancel + market。

**執行層複雜度(必須事先知道)**:
1. HL 需要 `post_only` / ALO 或 GTC limit + 手動 cancel——訂單狀態管理由「1 次成交」變「訂單可能 pending → partial fill → cancel」3 態
2. **Partial fill**:HL 若只吃到一半,size 要重算剩餘 margin / SL-TP 要跟住 partial position 重掛——portfolio 入面全部「一個 position 一組 SLTP」嘅假設被打破
3. **Restart 行為**:tsx watch restart 時,一個 pending limit order 可能孤兒掛喺 HL——要 startup reconcile 或喺 restart 前強制 cancel all pending entries
4. **Timeout 後 market** = 又回到追價原點——呢個方案唔係消除追價,係「限價試 X 秒,試唔到再追」

**判斷**:Phase A-3 收益/風險比**唔值得**——因為 mean-reverting 市追價本身已經喺 A-2 層被抑制;A-3 帶嚟嘅訂單狀態複雜度(孤兒單風險)+ 重啟安全隱患,遠超邊際 alpha。

## 3. 預期貢獻(若做 A-1 + A-2)

以 200 單樣本,假設 chase 平均 15bps 被抑制 → **+$0.15/單 × 200 = ~$3-5/200 單** 嘅粗糙上限(實際要看 A-1 量度返嚟嘅真實分布)。

## 4. 依賴

- A-1 觀測數據(≥20 單/symbol) → 呢個係 P23-A 任何進展嘅 bottle-neck

---

# P23-B — Partial TP 分層收割(Scale-Out Take-Profit)

## 1. 問題陳述(實證)

- **GOLD:buy WR 67% 但 payoff 0.20**(avgWin 只有 avgLoss 嘅 1/5)——入到對嘅方向,但 TP 太近:每次贏一啲,一次蝕就抹走五單。
- **PAEL 數據已有線索**:MFE p75 / p90 遠超實際 TP —— 大部分 winners 嘅 MFE 係 TP 嘅 2-4 倍,但系統喺 TP 觸發後直接全倉平,放棄後段。
- 同一時間 **SL 不可郁**(主神唔准收窄 SL;P21-B 反而要加闊防滑價)——所以唯一出路係 **TP 分層**。

## 2. 機制設計

```text
原有倉位 size(100%) → 進入分層管理狀態(TP Tranches)
├── Tranche A: 50% @ TP₁ = p50(MFE) × 0.8   ← 保證食到「大部分 trade 都到」
└── Tranche B: 50% @ TP₂ = p90(MFE) × 0.8   ← 讓贏家繼續行(PAEL 數據話「去到嘅 trade 唔少」)
       (可到 TP₂ 再開 trailing stop / PAEL lock-profit 繼續管理)
SL: 100% 倉位(唔郁)——任何一刻 SL 都在
```

### 兩個執行模式抉擇(關鍵架構決策)

**Mode 1:Engine-Driven(較簡,建議)**
- 系統唔掛 TP order 落 HL;只喺每 cycle 監控 price:price ≥ TP₁ → `closeTranche(50%)`;price ≥ TP₂ → 再平剩低
- 好處:邏輯喺本地,狀態清晰,同現有 MFE-lock / PAEL lock 自然協同(Tranche B 到咗之後可以俾 MFE-lock 接管)
- 壞處:**引擎死咗就冇人平**——8·18 案例教訓(tsx watch restart 期間倉位無人理)。所以一定要配合:
  - HL 上仍舊掛一個 **「災難 TP」(保守 p90 嘅 1.2×,engine 死咗先會食到嘅後備)** 或
  - SL 保持喺 HL(已有)——downside 保住,upside 錯過都係可接受嘅
- **Tranche bookkeeping 要新增到 `Position` model**(state 持久化):`tranchePlan: [{pct:50, hit:false, price:X}, {pct:50, hit:false, price:Y}]`

**Mode 2:Native HL Resting TP Orders(複雜,唔建議第一期)**
- 直接喺 HL 掛兩張 reduce-only limit TP
- 好處:engine 死咗市場自己平
- 壞處:**執行雷區全爆**
  - Partial fill 後 size 要跟住改(如果 TP₁ 只填咗一半,TP₂ 唔可以仲係 50% 原倉)
  - HL min order size(每 symbol 唔同,SKHX min sz 0.001 之類)→ 細倉位分咗兩份之後可能每份都 < minSize → **唔可以分層** → 要有 minimum-position-size gate
  - 訂單修改頻率:TP 目標會跟住 PAEL 數據漂移 → cancel/replace churn → HL rate limit
  - Restart 之後要 reconcile HL open orders 同本地 tranche plan(邊張係 TP₁ 邊張係 TP₂?OID mapping 要 persist)

**結論**:Mode 1 + HL 災難 SL 係正確平衡。Mode 2 係「完美但脆弱」,唔值得。

## 3. 前置硬性要求(全部係 gating 條件)

| 條件 | 原因 |
|---|---|
| **P22-G 完成且數據健康** | tranche 目標價由 MFE percentile 計;若仍用污染的 MAE/MFE,TP₁/TP₂ 係假貨 |
| **PAEL records ≥ 30 / symbol** | 而家 16 records — p50/p90 唔穩定;要等有足夠 MFE 數據 |
| **Position size ≥ 2× HL minSz** | 否則分唔到兩份 |
| **PAEL MFE percentile 嘅 time-decay** | 60 日窗夠 recent,但要加 half-life(早於 30 日減權)——TBD |
| **`EXIT_PRICE_CLOSE_ENABLED` 先穩定** | P23-B 同 PAEL lock-profit 容易撞車(兩個都想平)——要定優先序:PAEL lock 係「保命」,tranche 係「收割」——**到 MFE≥p75×0.8 且利潤鎖定,若 tranche B 未到 TP₂,PAEL 先走 B,唔 hold 等 TP₂** |

## 4. 回測方法(上線前必做)

- 用 P22-G 修復後嘅真實 MFE 數據
- Expanding-window(唔 look-ahead):trades 0-100 計 percentile,trades 101-200 模擬 tranche outcome
- 對照組:原 TP 全倉平 vs Tranche 50/50 分層
- 邊際 EV 差異要 >10% 先值得工程複雜度

## 5. 風險清單

| 風險 | 緩解 |
|---|---|
| 分層後 TP₁ 命中率過高、TP₂ 永遠差少少 → 不如全倉早平 | A/B shadow tranche:tranche A 先落真倉,B 用 shadow 驗證 30 日 |
| HL minSz → 細倉位唔入分層 | gate:`qty / 2 < minSz → 唔分層` |
| Engine restart → Tranche B 孤兒 | HL 災難 SL 100% 仍掛;tranche plan 持久化 + restart reconcile |
| 兩次平倉 = 兩次手續費 | Tranche A 用 limit(maker rebate 或至少 taker 一次);手續費會係 P20-C 之後要再審視嘅 EV 組成 |
| PAEL 同 Tranche 搶控制權 | 明確優先序:PAEL lock > MFE-lock > Tranche B > Tranche A |

---

# 封存決議

**P23-C(regime-transition buffer)同 P23-D(family correlation cap)—— 永久封存唔做。** 主神判斷正確:呢類「判斷層」本質係「我嘅 model 認為而家要收手」,但呢種判斷本身有概率會錯;錯一次,錯過嘅 alpha 大過慳返嘅風險。MATS 嘅 alpha 來自 **LLM 主導 + 精準入場價 + 收割結構**,唔係嚟自「幾時唔郁」。
