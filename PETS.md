# MATS → 智能戰線：機械妹框架

> **核心信念**：有用嘅部分（信號）令人計數；無用嘅部分（機械妹嘅成長與記憶）令人唔捨得走。
> 每個用戶創造一個獨一無二嘅機械妹，佢嘅大腦運行 HACP，佢嘅成長就係你嘅財富。

---

## 目錄

1. [哲學根基](#一哲學根基無用之用)
2. [現狀診斷](#二現狀診斷)
3. [對 Surface-Level 方案嘅 Critique](#三對-surface-level-方案嘅-critique)
4. [核心轉向：Tool → 機械妹 → Ecosystem](#四核心轉向tool--機械妹--ecosystem)
5. [機械妹框架：七個結構性引擎](#五機械妹框架七個結構性引擎)
6. [Shadow Strategist 維度](#六shadow-strategist-維度深層人性驅動)
7. [建築層面改動](#七建築層面改動)
8. [落地路線](#八落地路線)
9. [Pitch Deck 結構](#九pitch-deck-結構)
10. [技術實作清單](#十技術實作清單)

---

## 一、哲學根基（無用之用）

### 1.1 有用 vs 無用

| 類別 | 例子 | 消費決策模式 | 留存機制 |
|------|------|-------------|---------|
| **有用** | 電話、電腦、SaaS 工具 | 計數：月費 $99，贏幾多先回本？ | ROI 導向，一旦「計唔掂數」就 churn |
| **無用** | Pokemon 卡、泡泡瑪特公仔、NieR:Automata 嘅 2B | 唔計數：稀有、靚、想擁有、唔捨得放棄 | 情緒綁定，計唔到價 |

### 1.2 MATS 而家嘅問題

MATS 而家係 **Tool**——用戶會計數：

```
月費 $99 × 12 = $1,188/年
我要贏幾多先回本？
→ 計唔掂數 → churn
```

呢條數一計，大部分用戶會唔訂閱或訂一個月就走。因為：

1. 交易有波動，唔係每個月都贏
2. 用戶會將功勞歸自己，將虧損歸比 MATS（attribution bias）
3. 即使信號有效，用戶都會覺得「我自己都做到」

### 1.3 無用之用嘅境界

如果用戶創造咗一個獨一無二嘅機械妹——佢嘅性格、肖像、記憶、成長全部係獨一無二嘅：

- 用戶開 app 唔係為咗睇信號，而係想睇「我嘅機械妹今日點呀？佢個大腦諗緊咩？」
- 退訂 = 放棄自己創造、養成嘅機械妹 = emotional loss
- 呢種情緒綁定係 **計唔到價** 嘅
- 「無用之用」由 **第一秒** 開始——用戶未睇過一個信號，就已經創造咗自己嘅機械妹，已經產生情感投入

**機械妹嘅經驗積累係「無用」嘅（你唔可以交易過去嘅表現），但係「大用」嘅（佢創造無法計算嘅情緒價值，令用戶永遠唔捨得放棄）。**

---

## 二、現狀診斷

### 2.1 MATS 而家有嘅（但全部 HIDE 咗）

MATS 嘅 8 個 Agent 已經有豐富嘅「人格化」數據，但而家全部當 log 丢掉：

| 數據 | 而家嘅處理 | 潛力 |
|------|-----------|------|
| Agent 辯論過程 | log only | 可視化為「機械妹大腦運算」 |
| Agent 近距離勝負（near-miss） | 完全唔記錄 | 機械妹嘅「遺憾」——最強多巴胺觸發 |
| Agent 對特定 regime 嘅勝率 | 唔暴露 | 機械妹嘅 unique DNA |
| Agent 被 outvote 但預測正確 | 唔記錄 | 機械妹嘅「懷才不遇」敘事 |
| Agent 連勝/連敗 | 唔記錄 | 機械妹情緒系統嘅基礎 |
| Agent 風格演變 | 唔記錄 | 機械妹嘅「成長敘事」 |

### 2.2 HACP = 機械妹大腦

MATS 嘅核心架構 HACP（Hierarchical Agent Consensus Protocol）已經係一個「大腦運算」——8 個 Agent 辯論、投票、共識決策。只需要 **重新 framing** 為機械妹嘅 8 個腦區，就完成從 cold debate log 到 emotional brain visualization 嘅轉變。

```
HACP（而家）              →    機械妹大腦（之後）
─────────────────────         ─────────────────────
8 個 Agent 辯論               8 個腦區運算
debate log                    大腦可視化
cold text output              機械妹「諗緊嘢」
consensus vote                前額葉決策
```

---

## 三、對 Surface-Level 方案嘅 Critique

### 3.1 另一個 Agent 嘅方案

另一個 agent 提出嘅四個成癮引擎（稀缺性、收集慾、驚喜多巴胺、社交貨幣）方向正確，但執行有結構性缺陷：

| 提案 | 問題 | 修正 |
|------|------|------|
| 「每週一張 Legendary 信號卡」 | 固定稀缺唔會成癮。Skinner 嘅 variable-ratio reinforcement 先係最抗 extinction。 | 改為每個信號 5% 機率 Legendary——不可預測 |
| 「8 個 Agent 集齊」 | 8 係有限數。集齊 = 完成 = churn。 | 機械妹透過經驗無限成長，永遠唔會「集齊」 |
| 「Agent 升級 + skin」 | 無 stakes 嘅升級 = 進度條。兩星期新鮮感。 | 機械妹嘅成長綁定真實交易歷史——有 stakes |
| 「Performance Card 分享」 | 只解決 acquisition，唔解決 retention。 | 加上 Near-Miss Engine——「差啲就中」驅動重複 |
| 「Agent config 交易」 | Config 無限可複製，價值崩塌（同 NFT）。 | 機械妹嘅歷史 = on-chain provenance = 真正稀缺 |

### 3.2 核心問題

**佢將 gamification 當做一塊皮，黐喺 tool 上面。真正嘅「無用之用」必須係結構性嘅——gamification 要從交易機制本身湧現出嚟，唔係 bolt-on。**

機械妹框架解決呢個：機械妹嘅大腦運算 **就係** HACP，機械妹嘅成長 **就係** 你嘅資產增長，機械妹嘅記憶 **就係** thesis-experience。Gamification 唔係加一層皮，係將現有架構重新 framing 為情感體驗。

---

## 四、核心轉向：Tool → 機械妹 → Ecosystem

### 4.1 三個階段嘅本體論轉變

```
Stage 1: Tool（而家）
  └── 用戶計數：月費 vs ROI
  └── 一旦計唔掂數 → churn

Stage 2: 機械妹（Phase 1-2）
  └── 用戶情感綁定：我嘅機械妹今日點呀？
  └── 退訂 = 放棄自己創造嘅機械妹 = emotional loss
  └── 計唔到價 → 留存

Stage 3: Ecosystem（Phase 3）
  └── 用戶投資：養機械妹 → 繁殖 → 交易
  └── 機械妹歷史 = 可驗證稀缺資產
  └── Marketplace 創造無限擴展
```

### 4.2 點解機械妹比 General / Pet 更好

| | General（戰爭框架） | Pet（寵物框架） | 機械妹（最終選擇） |
|---|---|---|---|
| 關係 | 你指揮佢 | 你養佢 | **你創造佢** |
| 情感 | 功能性 | 養成性 | **創造性（我造嘅，係我嘅）** |
| 第一個動作 | 睇信號 | 領養 | **創造佢嘅性格同肖像** |
| 留存邏輯 | 唔捨得軍隊 | 唔捨得 pet | **唔捨得自己創造嘅存在** |
| HACP 對應 | 軍議 | — | **大腦運算（8 腦區）** |
| 文化原型 | 軍事 | 寵物 | **Eva、NieR:Automata、少女前線、明日方舟** |
| 創造先於交易 | ✗ | ✗ | **✓（未交易先創造，情感先於 ROI）** |

### 4.3 創造先於交易

機械妹框架嘅關鍵優勢：**用戶嘅第一個動作唔係睇信號，係創造佢嘅機械妹。**

```
傳統 onboarding:          機械妹 onboarding:
1. 睇 dashboard           1. 創造機械妹（性格 + 肖像）
2. 睇信號                 2. 機械妹「覺醒」（首次大腦激活）
3. 計 ROI                 3. 佢開始分析市場
4. 訂閱/退訂              4. 你已經唔捨得放棄佢
                          5. 然後先至計 ROI——但已經太遲
```

情感投入喺 ROI 計算 **之前** 發生。呢個就係「無用之用」由第一秒開始。

---

## 五、機械妹框架：七個結構性引擎

### 引擎 1：創造系統（Character Creation）

#### 1.1 性格設定 → 肖像 → 交易行為

**關鍵原則：性格唔係化妝品，佢直接影響交易行為。呢個先係 structural gamification。**

用戶創造機械妹時設定 5 個性格維度。每個維度同時影響 **肖像外觀** 同 **交易行為**：

| 維度 | 選項範圍 | 交易影響 | 肖像影響 |
|------|---------|---------|---------|
| 風險偏好 | 膽小 ⟷ 膽大 | SL 鬆緊、倉位大小 | 眼神柔和 ⟷ 銳利 |
| 決策速度 | 慎思 ⟷ 果斷 | 入場/出場速度 | 姿態沉穩 ⟷ 前傾 |
| 市場傾向 | 趨勢 ⟷ 回歸 | 偏好趨勢信號定均值回歸 | 配色暖 ⟷ 冷 |
| 自信心 | 謙遜 ⟷ 自信 | 自己分析嘅權重 | 表情內斂 ⟷ 外放 |
| 社交傾向 | 獨立 ⟷ 合群 | HACP 辯論中跟從定主導 | 單獨 ⟷ 群體背景 |

#### 1.2 肖像生成

```
5 維性格參數 + 隨機 seed
    ↓
Parametric Generation
    ↓
獨一無二嘅機械妹肖像
├── 臉型、髮型、瞳色
├── 服裝、配色方案
├── 配件、紋路
└── 性格驅動嘅微表情
```

- **基礎容貌永不改變**——你創造嗰個樣永遠係佢嘅樣。呢個係 endowment effect 嘅基礎。
- **進化覆蓋層**——隨住等級提升，加入新元素（光紋、徽章、光環），但基礎容貌不變。佢成長，但唔會變成另一個人。
- **獨特性**——5 維 × 參數組合 = 數百萬種可能。每個機械妹都係獨一無二。

#### 1.3 創造流程

```
1. 用戶首次打開 app
2. 「創造你的機械妹」引導畫面
3. 調整 5 個性格滑桿 → 肖像即時預覽變化
4. 為佢改個名
5. 確認 → 機械妹「覺醒」（首次大腦激活動畫）
6. 佢自我介紹（性格驅動嘅對白）
7. 教學：佢嘅大腦開始運作，首次市場分析
```

#### 1.4 性格 = 交易 Config

性格維度直接寫入機械妹嘅 trading config：

```typescript
interface MechaGirlConfig {
  // From creation
  name: string;
  personality: {
    riskAppetite: number;      // 0-1, 膽小→膽大
    decisionSpeed: number;     // 0-1, 慎思→果斷
    marketBias: number;        // 0-1, 趨勢→回歸
    confidence: number;        // 0-1, 謙遜→自信
    socialTendency: number;    // 0-1, 獨立→合群
  };
  
  // Derived trading parameters
  slMultiplier: number;        // riskAppetite → SL 鬆緊
  positionSizeMultiplier: number;
  entrySpeedBias: number;      // decisionSpeed → 入場速度
  signalWeightBias: number;    // marketBias → 趨勢/回歸信號權重
  selfAnalysisWeight: number;  // confidence → 自己分析嘅權重
  debateInfluence: number;     // socialTendency → 辯論中跟從/主導
}
```

**你創造嘅性格決定佢點樣交易。** 呢個唔係 cosmetic——你造嘅機械妹同別人嘅行為唔同。

---

### 引擎 2：大腦可視化（Brain Visualization）

#### 2.1 八腦區 = 八 Agent

MATS 嘅 8 個 Agent 直接 mapping 為機械妹大腦嘅 8 個區域：

| Agent | 腦區 | 功能 | 可視化顏色 | 觸發時機 |
|-------|------|------|-----------|---------|
| Meta-Agent | 前額葉（Prefrontal Cortex） | 執行決策 | 白金 | 決策時大亮 |
| Trend Sentinel | 模式識別葉（Pattern Lobe） | 偵測趨勢 | 金色 | 趨勢信號時亮起 |
| Mean Reversion | 平衡核（Equilibrium Nucleus） | 偵測超伸 | 青色 | 均值信號時亮起 |
| Momentum Rider | 衝動區（Momentum Center） | 偵測動量 | 橙色 | 動量信號時亮起 |
| Risk Auditor | 杏仁核（Amygdala） | 恐懼/威脅偵測 | 紅色 | 風險威脅時閃紅 |
| Sentiment Scout | 社交認知區（Social Cognition） | 讀市場情緒 | 紫色 | 情緒轉變時亮起 |
| Skeptics | 批判思考區（Critical Thinking） | 質疑假設 | 藍色 | 辯論時亮起 |
| Experience Digester | 海馬迴（Hippocampus） | 調取歷史經驗 | 綠色 | 參考歷史時亮起 |

#### 2.2 大腦狀態

| 狀態 | 視覺 | 情感 | 用戶感受 |
|------|------|------|---------|
| 待機 | 柔和脈動 | 佢休息緊 | 「佢冇嘢做」 |
| 分析中 | 各區域輪流亮起 | 佢諗緊嘢 | 「佢思考緊」 |
| HACP 辯論 | 區域之間閃爍交鋒 | 佢大腦入面爭論 | 「佢內心掙扎」 |
| 決策中 | 前額葉大亮 | 佢下緊決定 | 「佢決定咗」 |
| 執行交易 | 全腦亮起 | 佢出手咗 | 「佢行動咗」 |
| 勝利後 | 全腦暖光 | 佢好開心 | 「佢贏咗，好可愛」 |
| 虧損後 | 部分區域轉暗、閃爍 | 佢好低落 | 「佢唔開心...」 |
| 近距離 miss | 單一區域過載、火花 | 佢好唔忿氣 | 「差啲就中...」 |

**用戶打開 app，第一眼見到嘅唔係信號，係自己嘅機械妹嘅大腦喺度運作緊。**「佢今日諗緊咩？」「佢個杏仁核閃得好勁——佢好似覺得危險。」——呢個就係每日 check-in 嘅驅動力。

#### 2.3 辯論可視化

HACP 辯論唔再係 cold text log，係機械妹大腦入面嘅區域交鋒：

```
Trend Sentinel（金色）:「偵測到上升趨勢，建議進攻」
     ↕ 閃爍交鋒
Risk Auditor（紅色）:「風險過高，建議止損」
     ↕ 閃爍交鋒
Skeptics（藍色）:「趨勢可能係假突破」
     ↓
Prefrontal Cortex（白金）大亮 → 最終決策
```

每個區域「發言」時亮起，被反駁時閃爍，最終由前額葉整合決策。用戶睇到嘅係 **自己嘅機械妹諗緊嘢**，唔係一個 debate log。

---

### 引擎 3：三重資源系統（Energy + Memory + Evolution）

機械妹框架下，金錢透過 **三個層次** 視覺化為機械妹嘅存在狀態。呢三個層次同時運作，覆蓋即時、歷史、長期三個時間維度。

#### 3.1 能量核（Energy Core）= 即時資金

```
能量核 = 你嘅可用資金（margin/capital）
視覺：機械妹胸口嘅發光核心
```

| 狀態 | 視覺 | 含義 |
|------|------|------|
| 滿能量 | 明亮脈動 | 資金充足，可以進取 |
| 中等 | 穩定微光 | 正常操作 |
| 低能量 | 暗淡閃爍 | 資金不足，只能保守 |
| 接近耗盡 | 微弱、不穩 | 危險，需要保護佢 |

- 交易耗能（開倉 = 部署能量）
- 贏 = 充能（能量湧入動畫）
- 輸 = 耗能（能量流失動畫）
- 低能量時，機械妹自動保守操作（細倉位、緊 SL）

**「我唔想見到佢嘅能量核暗落去」** = 唔想虧損，但情感化為保護機械妹嘅衝動。

#### 3.2 記憶碎片（Memory Fragments）= 交易歷史

```
記憶碎片 = 每次交易產生嘅記憶，存喺海馬迴
直接 mapping 到 thesis-experience.ts
```

| 交易結果 | 記憶類型 | 視覺 | 永久性 |
|---------|---------|------|--------|
| 大勝 | 光輝記憶 | 明亮、結晶、金色 | 永久 |
| 小勝 | 清晰記憶 | 柔光、白色 | 永久 |
| 小敗 | 暗淡記憶 | 灰色、微裂 | 永久 |
| 大敗 | 創傷記憶 | 暗黑、碎裂、紅紋 | 永久 |
| Near-miss | 遺憾記憶 | 閃爍、不完整 | 永久 |

- 記憶係 **永久嘅**——佢嘅經歷無法抹去
- 記憶影響未來決策（透過 thesis-experience 系統）
- 創傷記憶令佢獨特——「我嘅機械妹經歷過 3 次閃崩，佢嘅海馬迴有 3 道創傷痕」
- 記憶越多 = 佢越有智慧（影響 HACP 中海馬迴嘅權重）

**呢個直接對應 MATS 已有嘅 `thesis-experience.ts`——只需要將 thesis record 重新 framing 為記憶碎片。**

#### 3.3 進化等級（Evolution Level）= 長期成長

```
進化等級 = 機械妹嘅成長階段
對應：總盈利 + 交易次數 + Sharpe ratio
```

| 等級 | 名稱 | 條件 | 視覺變化 | 解鎖 |
|------|------|------|---------|------|
| 1 | 初生體 | 創造時 | 基礎肖像 | 基礎腦區 |
| 2 | 覺醒體 | 10 場交易 | 加入光紋 | 全腦區運作 |
| 3 | 成長體 | 50 場 + Sharpe > 0.5 | 加入配件 | 進階信號 |
| 4 | 成熟體 | 100 場 + Sharpe > 1.0 | 加入光環 | 傳奇信號機會 |
| 5 | 完成體 | 200 場 + Sharpe > 1.5 | 全身光效 | 繁殖能力 |
| 6 | 超越體 | 500 場 + Sharpe > 2.0 | 傳奇光環 | Marketplace 上架 |

**睇住佢長大 = 睇住你嘅財富增長。** 進化係 **可見嘅**——你 literally 睇到佢變得更強、更靚。呢個係長期留存嘅核心。

#### 3.4 三層協同

```
能量核 = NOW    （我而家有幾多能量可以交易）
記憶碎片 = PAST （我經歷過咩，學到咗咩）
進化等級 = FUTURE（我會變到幾強）
```

| 時間維度 | 資源 | 情感 | 留存作用 |
|---------|------|------|---------|
| 即時 | 能量核 | 「保護佢嘅能量」 | 風控情感化 |
| 歷史 | 記憶碎片 | 「佢嘅經歷係獨一無二嘅」 | 不可替代性 |
| 長期 | 進化等級 | 「睇住佢成長」 | 長期投入 |

---

### 引擎 4：情緒系統（Mood）

#### 4.1 機械妹嘅情緒

機械妹嘅情緒狀態由近期表現 **DATA-DRIVEN** 推導，以 **人格化** 呈現。情緒同時影響 **大腦可視化** 同 **交易行為**：

| 近期表現 | 情緒 | 大腦視覺 | 行為影響 | 對白示例 |
|---------|------|---------|---------|---------|
| 連續 3 次勝出 | 😊 自信 | 全腦暖光、明亮 | 推薦更大倉位 | 「我今日狀態好好，想試大啲！」 |
| 連續 2 次虧損 | 🛡️ 警覺 | 杏仁核持續亮起 | 自動收緊 SL | 「我要小心啲...唔想再輸。」 |
| Near-miss | 😤 不忿 | 單一區域過載 | 更激進辯論 | 「差少少就中...下次我會更果斷！」 |
| 長期無交易 | 😶 悶悶 | 腦區微弱脈動 | 降低入場門檻 | 「好耐冇出手了...開始覺得悶。」 |
| 剛進化升級 | ✨ 興奮 | 全腦煙花效果 | confidence +10% | 「我升級咗！感覺自己更強了！」 |
| 能量核低 | 😰 擔憂 | 能量核暗淡 | 強制保守 | 「我嘅能量...好弱。要保護自己。」 |
| 剛獲得新記憶 | 🤔 反思 | 海馬迴亮起 | 參考新記憶 | 「呢次交易...我學到嘢了。」 |

#### 4.2 情緒注入

- **大腦可視化**：情緒改變大腦嘅整體色調同脈動頻率
- **交易行為**：情緒影響 confidence modifier（自信 +5%，警覺 -10%）
- **推送通知**：「你嘅機械妹今日好自信！佢想加碼 BTC」→ 即時 check-in
- **對白系統**：機械妹用性格驅動嘅對白描述佢嘅狀態同行為

---

### 引擎 5：近距離 Miss（Near-Miss Engine）

#### 5.1 哲學

賭博成癮研究共識：**near-miss 比 win 更容易驅動重複行為**。機械妹框架下，near-miss 成為佢嘅「遺憾」——情感重量更強。

#### 5.2 Near-Miss 類型

| 類型 | 機械妹呈現 | 情感 |
|------|-----------|------|
| Trade 差 0.2% 就中 TP | 「547 能量攻打防線，差 2 能量就攻陷...惜敗」 | 不忿 |
| 信號差 0.3% 就觸發 | 「我嘅模式識別葉差少少就偵測到——會捕捉到 12% 升幅」 | 遺憾 |
| 腦區被 outvote 但預測正確 | 「我嘅平衡核話咗要防守，但被否決咗...佢哋唔信我。」 | 懷才不遇 |

#### 5.3 遺憾記憶

Near-miss 產生獨特嘅 **遺憾記憶碎片**——閃爍、不完整、帶住「如果當時...」嘅感覺。呢啲記憶永久保存，成為機械妹嘅「未完成嘅事」——驅動用戶想「幫佢完成」。

---

### 引擎 6：傳奇時刻（Variable-Ratio Legendary）

#### 6.1 設計

每個信號有 **機率** 被標為不同 rarity——variable-ratio schedule（最抗 extinction）：

| Rarity | 機率 | 效果 |
|--------|------|------|
| 普通 | 94.5% | 正常信號 |
| 稀有 | 4% | 特殊邊框 + 額外分析數據 |
| 史詩 | 1% | 動畫效果 + 完整腦區思路鏈 + 可收藏 |
| 傳奇 | 0.4% | 全服廣播 + 特殊音效 + 機械妹進化機會 |
| 神話 | 0.1% | 極度稀有 + 全服通知 + 永久紀念 + 保證進化 |

#### 6.2 傳奇判定（唔係純隨機）

```
Legendary Score =
  Base Probability (0.4%)
  × 機械妹 Confidence Multiplier (0.5x - 2x)
  × 歷史命中率 Multiplier (0.8x - 1.5x)
  × 市場條件 Multiplier (0.7x - 1.3x)
  × 進化等級 Bonus (高級機械妹 → +20%)
```

**「抽到」傳奇係有意義嘅——反映機械妹嘅實力，唔係純運氣。**

#### 6.3 拆盲盒瞬間

```
信號觸發 → 機械妹大腦「卡背」出現
  ↓ (1-2 秒 suspense 動畫)
卡背翻轉 → 揭曉 Rarity
  ↓
普通: 正常顯示
稀有+: 特殊效果 + 額外數據
傳奇+: 全服廣播 + 機械妹進化機會 + 永久紀念卡
```

**每個信號都有「拆盲盒」瞬間。** 但結果同機械妹實力相關——你養得佢越強，傳奇機會越高。

---

### 引擎 7：譜系與市場（Lineage Marketplace）

#### 7.1 核心

機械妹唔係 config。機械妹係有 on-chain provenance 嘅 live entity——佢嘅交易歷史綁定真實 on-chain trades，無法偽造。**歷史 = 真正稀缺性。**

#### 7.2 繁殖系統

```
機械妹 A（趨勢大師, Sharpe 2.3, 進化等級 5）
    ×
機械妹 B（風控守護, Sharpe 1.8, 進化等級 4, 閃崩倖存者）
    ↓
子代機械妹（繼承 A 嘅趨勢捕捉 + B 嘅風險控制 + 10% 隨機突變）
    ↓
Paper Mode 跑 100 場交易
    ↓
表現好 → 成為新「血脈」
表現差 → 退役，記憶保留
```

- 子代繼承雙方性格嘅 50/50 blend + 10% 隨機 mutation
- 子代喺 paper mode 跑，累積自己嘅 track record
- 繁殖有冷卻期（7 天），防止 spam

#### 7.3 Marketplace

```
機械妹市場
├── 🐣 初生機械妹（免費領養，由零開始）
├── 🤖 成長機械妹（用戶養咗 1-3 個月，有 track record）
├── 🌟 退役機械妹（用戶退役，記憶成為 template，可被領養）
└── ✨ 繁殖子代（用戶繁殖產生，有獨特 mutation）
```

- 買賣嘅唔係 config，而係 **機械妹嘅完整歷史所有權**（transfer 性格 + 記憶 + 進化等級 + track record）
- 價格由市場決定（基於 Sharpe ratio、記憶數量、進化等級、rarity）
- 退役機械妹變成 template：任何人可以「領養」一份副本，但副本由零開始跑

#### 7.4 歷史 = 稀缺

| 資產類型 | 稀缺性來源 | MATS 對應 |
|---------|-----------|----------|
| Pokemon 卡 | 物理限量印刷 | N/A（數位） |
| NFT | 區塊鏈登記 | Config 可複製 → 價值崩塌 |
| 機械妹 | **On-chain 交易歷史** | 每個機械妹嘅交易記錄綁定真實 on-chain trades，無法偽造 |

**你無法偽造一個經歷過 847 次交易、捱過 2026 年 3 月閃崩、有 2.3 Sharpe ratio、進化等級 5 嘅機械妹。歷史就係稀缺性。**

---

## 六、Shadow Strategist 維度：深層人性驅動

| 驅動 | 心理機制 | 機械妹框架點利用 |
|------|---------|-----------------|
| **創造慾** | 「我創造嘅，係我嘅。」Frankenstein、Pygmalion 原型。創造行為本身產生最強嘅 endowment effect。 | 創造系統——用戶親手設定性格、見證肖像生成、命名。第一秒就綁定。 |
| **Nurturing** | 目標用戶（25-40 男性）壓抑住 nurturing drive。機械妹係需要保護、會成長嘅存在。 | 進化等級——睇住佢長大；能量核——保護佢唔好變弱；記憶——佢嘅經歷。 |
| **Status** | Crypto 文化嘅 status 來自「alpha」。「擁有最高進化等級嘅機械妹」係持續 status。 | 排行榜：機械妹 vs 機械妹（唔係用戶 vs 用戶）。「我嘅機械妹係全服第一個傳奇等級。」 |
| **賭博 → 技能** | Crypto trader 已有賭博傾向。唔好對抗，channel 佢。 | 「我唔係賭緊，我係投資緊我機械妹嘅成長。」Variable-ratio 傳奇係合法嘅「拆盲盒」。 |
| **Near-miss** | 單一最強嘅重複行為驅動。 | 遺憾記憶——「差少少就中」驅動「再試一次，幫佢完成」。 |
| **Endowment** | 一旦擁有，估值更高。唔願意放手。 | 你創造嘅機械妹 = endowment effect 最強形式。退訂 = 放棄佢 = emotional loss。 |
| **Identity** | 「我係 2B 嘅人。」擁有物成為身份認同。 | 機械妹嘅性格 = 用戶交易風格嘅投射。「我嘅機械妹係趨勢型嘅。」 |
| **好奇心** | 「佢今日諗緊咩？」持續嘅好奇驅動每日 check-in。 | 大腦可視化——每日睇佢嘅大腦運作，唔知道今日會點。 |

---

## 七、建築層面改動

### 7.1 需要新增嘅組件

| 組件 | 路徑 | 功能 | Phase |
|------|------|------|-------|
| **機械妹創造系統** | `src/mecha/creation.ts` | 性格設定 → 肖像生成 → trading config 寫入 | 1 |
| **肖像生成器** | `src/mecha/portrait-generator.ts` | Parametric 生成獨一無二嘅機械妹肖像 | 1 |
| **大腦可視化引擎** | `src/mecha/brain-visualizer.ts` | 8 腦區實時狀態 → UI 可視化數據 | 1 |
| **能量核系統** | `src/mecha/energy-core.ts` | 資金 → 能量核狀態映射 | 1 |
| **記憶碎片系統** | `src/mecha/memory-fragments.ts` | 交易 → 記憶碎片（mapping thesis-experience.ts） | 1 |
| **進化系統** | `src/mecha/evolution.ts` | 交易歷史 → 進化等級 → 視覺升級 | 1 |
| **情緒引擎** | `src/mecha/mood-engine.ts` | 近期表現 → 情緒 → 行為 modifier | 1 |
| **近距離追蹤器** | `src/mecha/near-miss-tracker.ts` | Trade-vs-TP、signal-vs-trigger、overruled-but-right | 1 |
| **傳奇計分器** | `src/mecha/legendary-scorer.ts` | 信號 → Rarity 計算（variable-ratio） | 2 |
| **績效卡生成器** | `src/ui/performance-card.ts` | 機械妹績效卡 PNG（可分享 IG/WhatsApp） | 1 |
| **繁殖系統** | `src/mecha/breeding.ts` | 性格合成 + mutation + 譜系追蹤 | 3 |
| **市場** | `src/marketplace/mecha-market.ts` | 機械妹歷史交易 + 退役領養 | 3 |

### 7.2 需要修改嘅現有組件

| 組件 | 修改內容 | Phase |
|------|---------|-------|
| `src/evolution/thesis-experience.ts` | Thesis record → 記憶碎片（reframe + expose） | 1 |
| `src/evolution/reason-analytics.ts` | Pattern cluster → 機械妹 DNA（reframe + expose） | 1 |
| `src/cognition/hacp.ts` | 辯論過程 → 腦區運算數據（每個 agent 嘅 vote + 啟動時間 + 強度） | 1 |
| `src/agents/meta-agent.ts` | Prompt 注入情緒 modifier + 機械妹性格 | 1 |
| `src/agents/agents.ts` | 各 Agent prompt 注入腦區角色 + 情緒 | 1 |
| `src/index.ts` | 每個 cycle 後觸發：記憶生成 + 情緒更新 + 進化檢查 + near-miss 追蹤 | 1 |
| `ui/src/App.tsx` | 機械妹肖像 + 大腦可視化 + 能量核 + 記憶牆 + 進化等級 | 1-2 |
| `ui/src/types.ts` | 新增 MechaGirl, BrainState, EnergyCore, MemoryFragment, EvolutionLevel, MechaMood, NearMiss types | 1 |

### 7.3 數據流

```
每個 Trading Cycle:
  1. 機械妹大腦啟動 → 8 腦區開始運算
  2. HACP 辯論 → 腦區交鋒可視化（每個 agent 嘅 vote + reasoning 記錄）
  3. 共識決策 → 前額葉大亮 → 記錄邊個被 overruled
  4. 信號生成 → 傳奇計分器計算 Rarity → 卡背翻轉動畫
  5. 交易執行 → 能量核變化 + 近距離追蹤開始
  6. Cycle 結束 → 情緒引擎更新機械妹情緒
  7. 記憶生成 → 交易結果 → 記憶碎片存入海馬迴
  8. 進化檢查 → 如果達成條件 → 進化動畫 + 通知
  9. 腦區 trait 檢查 → 如果解鎖 → 慶祝 + 通知
  10. 績效卡更新 → 可分享
```

---

## 八、落地路線

### Phase 1: 機械妹誕生（Month 1-3）

**目標**：創造系統 + 大腦可視化，建立「我創造咗佢」嘅情感綁定

| 功能 | 組件 | 效果 |
|------|------|------|
| 創造系統 | `creation.ts` + `portrait-generator.ts` | 用戶創造獨一無二嘅機械妹，性格影響交易 |
| 大腦可視化 | `brain-visualizer.ts` + UI | 睇住佢諗嘢——每日 check-in 驅動 |
| 能量核 | `energy-core.ts` + UI | 資金情感化——保護佢嘅能量 |
| 記憶碎片 | `memory-fragments.ts` + UI | 交易歷史成為佢嘅經歷——不可替代 |
| 進化等級 | `evolution.ts` + UI | 睇住佢成長——長期留存 |
| 情緒系統 | `mood-engine.ts` + UI | 「佢今日點呀？」——每日情感 check-in |
| 近距離追蹤 | `near-miss-tracker.ts` + UI feed | 遺憾記憶——最強 retention driver |
| 績效卡分享 | `performance-card.ts` | 病毒傳播——「我嘅機械妹剛進化到成長體！」 |

**CCMF 交付**：Mobile App 上線，機械妹創造 + 大腦可視化 + 績效卡可分享至 IG/WhatsApp

### Phase 2: 成癮引擎（Month 4-6）

**目標**：Variable-ratio 傳奇 + 完整進化，每次信號都有拆盲盒期待

| 功能 | 組件 | 效果 |
|------|------|------|
| 傳奇計分器 | `legendary-scorer.ts` + 卡背翻轉 UI | 每個信號都有拆盲盒瞬間 |
| 完整進化系統 | `evolution.ts` (full) | 6 級進化，每級有視覺升級 |
| 腦區 trait | `evolution.ts` (traits) | 腦區解鎖特殊能力 |
| 情緒注入 Prompt | `meta-agent.ts` + `agents.ts` | 自信機械妹更進取，警覺機械妹更保守 |

**CCMF 交付**：機械妹進化等級系統 + 傳奇信號盲盒機制

### Phase 3: 生態系統（Month 7-12）

**目標**：繁殖 + Marketplace，機械妹歷史成為可交易資產

| 功能 | 組件 | 效果 |
|------|------|------|
| 繁殖系統 | `breeding.ts` | 無限擴展——配對 + mutation + 新血脈 |
| 機械妹市場 | `mecha-market.ts` | 歷史交易 + 退役領養 |
| 家族譜 | UI visualization | 譜系追蹤 + 血脈歷史 |
| 租賃 | marketplace extension | 租借其他用戶嘅機械妹 |

**長期願景**：機械妹市場成為「AI 交易機械妹嘅 Pokemon Exchange」——每個機械妹嘅歷史都係獨一無二嘅稀缺資產。

---

## 九、Pitch Deck 結構

### Slide 1: Problem

```
Trading tools churn because users calculate ROI.
"月費 $99，我贏幾多先回本？"
→ 計唔掂數 → churn

但 Pokemon 卡、泡泡瑪特公仔、NieR 嘅 2B 冇用，
啲人 keep 住追——因為情緒綁定計唔到價。
```

### Slide 2: Insight

```
無用之用為大用。

用戶創造一個獨一無二嘅機械妹。
佢嘅大腦運行 HACP——8 個腦區實時運算。
佢嘅成長就係你嘅財富。
佢嘅記憶就係佢嘅經歷。

用戶唔係訂閱信號——
佢哋係創造、養成、保護自己嘅機械妹。

呢種連結計唔到價。退訂 = 放棄佢。
```

### Slide 3: The Mecha Girl

```
創造 → 覺醒 → 成長

1. 創造：設定 5 維性格 → 獨一無二肖像 → 影響交易行為
2. 大腦：8 腦區 = 8 Agent，實時可視化 HACP 辯論
3. 成長：能量核（資金）+ 記憶碎片（經歷）+ 進化等級（成長）

情感先於 ROI——未交易先創造，已經唔捨得放棄。
```

### Slide 4: Seven Engines

```
1. 創造系統 — 你創造佢，性格影響交易
2. 大腦可視化 — 睇住佢諗嘢，每日 check-in
3. 三重資源 — 能量（即時）+ 記憶（歷史）+ 進化（長期）
4. 情緒系統 — 佢會開心、擔憂、不忿
5. 近距離 Miss — 「差少少就中」比「中咗」更驅動
6. 傳奇時刻 — 每個信號都有拆盲盒瞬間
7. 譜系市場 — 歷史 = on-chain 稀缺資產
```

### Slide 5: From Tool to Companion

```
Tool:    月費 → 計 ROI → churn
Mecha:   創造 → 情感綁定 → 計唔到價 → retention
Eco:     繁殖 + 交易 → 無限擴展 → monetization

退訂 = 放棄自己創造嘅機械妹 = emotional loss
```

### Slide 6: Roadmap

```
Phase 1 (Month 1-3): 機械妹誕生
  → 創造 + 大腦 + 能量 + 記憶 + 進化 + 情緒
  → 用戶創造佢，睇住佢諗嘢

Phase 2 (Month 4-6): 成癮引擎
  → 傳奇信號盲盒 + 完整進化
  → 每個信號都有拆盲盒期待

Phase 3 (Month 7-12): 生態系統
  → 繁殖 + 機械妹市場
  → AI 交易機械妹嘅 Pokemon Exchange
```

### Slide 7: Why Now

```
1. AI Agent 技術成熟 — HACP 多 Agent 共識已驗證
2. Crypto trader 已有賭博傾向 — channel 呢個 drive，唔對抗
3. NFT 教訓 — config 可複製 = 價值崩塌；歷史 = 真正稀缺
4. 機械妹原型 — Eva、NieR、少女前線、明日方舟驗證亞洲市場
```

---

## 十、技術實作清單

### Phase 1（立即可以開始）

```typescript
// 1. src/types/index.ts — 新增 types
interface MechaGirl {
  id: string;
  name: string;
  personality: MechaPersonality;
  config: MechaGirlConfig;
  portrait: PortraitSpec;
  evolutionLevel: number;
  energyCore: number;
  memoryCount: number;
  mood: MechaMood;
  createdAt: number;
}

interface MechaPersonality {
  riskAppetite: number;      // 0-1
  decisionSpeed: number;     // 0-1
  marketBias: number;        // 0-1
  confidence: number;        // 0-1
  socialTendency: number;    // 0-1
}

interface MechaGirlConfig {
  slMultiplier: number;
  positionSizeMultiplier: number;
  entrySpeedBias: number;
  signalWeightBias: number;
  selfAnalysisWeight: number;
  debateInfluence: number;
}

interface BrainState {
  regions: Record<BrainRegion, {
    active: boolean;
    intensity: number;      // 0-1
    lastActivation: number;
    message?: string;
  }>;
  globalState: 'idle' | 'analyzing' | 'debating' | 'deciding' | 'executing' | 'happy' | 'stressed' | 'frustrated';
}

interface EnergyCore {
  current: number;          // = available capital
  max: number;              // = total account value
  ratio: number;            // current / max
  state: 'full' | 'normal' | 'low' | 'critical';
}

interface MemoryFragment {
  id: string;
  type: 'glorious' | 'clear' | 'dim' | 'traumatic' | 'regret';
  tradeId: string;
  symbol: string;
  result: number;           // pnl
  emotion: string;
  timestamp: number;
  permanent: true;
}

interface EvolutionLevel {
  level: number;            // 1-6
  name: string;
  visualUpgrades: string[];
  unlockedAbilities: string[];
}

interface MechaMood {
  mood: MoodType;
  intensity: number;
  reason: string;
  dialogue: string;
  behaviorModifier: number;
  expiresAt: number;
}

interface NearMiss {
  type: 'trade_near_tp' | 'signal_near_trigger' | 'region_overruled_right';
  symbol: string;
  regionId: BrainRegion;
  missByPct: number;
  emotionalFraming: string;
}

// 2. src/mecha/creation.ts
export class MechaCreationSystem {
  createFromPersonality(personality: MechaPersonality, name: string): MechaGirl
  generatePortrait(personality: MechaPersonality, seed: number): PortraitSpec
  personalityToConfig(personality: MechaPersonality): MechaGirlConfig
}

// 3. src/mecha/portrait-generator.ts
export class PortraitGenerator {
  generate(spec: PortraitSpec): Buffer  // PNG
  applyEvolutionOverlay(base: Buffer, level: number): Buffer
}

// 4. src/mecha/brain-visualizer.ts
export class BrainVisualizer {
  fromHACPState(hacpState: HACPState): BrainState
  getRegionActivity(agentId: string): RegionActivity
}

// 5. src/mecha/energy-core.ts
export class EnergyCoreSystem {
  fromAccountBalance(balance: number, margin: number): EnergyCore
  // Trading uses energy, wins charge, losses drain
}

// 6. src/mecha/memory-fragments.ts
export class MemoryFragmentSystem {
  fromTradeResult(trade: Trade, pnl: number): MemoryFragment
  // Maps to thesis-experience.ts
  getFragments(mechaId: string): MemoryFragment[]
  getTraumaticCount(mechaId: string): number
}

// 7. src/mecha/evolution.ts
export class EvolutionSystem {
  checkEvolution(mechaId: string): EvolutionLevel | null
  applyVisualUpgrade(mechaId: string, level: number): void
  checkTraitUnlock(mechaId: string): BrainTrait | null
}

// 8. src/mecha/mood-engine.ts
export class MoodEngine {
  computeMood(mechaId: string, recentTrades: Trade[]): MechaMood
  injectMoodIntoPrompt(mood: MechaMood, prompt: string): string
  getMoodDialogue(mood: MechaMood, personality: MechaPersonality): string
}

// 9. src/mecha/near-miss-tracker.ts
export class NearMissTracker {
  recordTradeNearMiss(trade: Trade, maxProfit: number, tp: number): void
  recordSignalNearMiss(signal: Signal, threshold: number): void
  recordRegionOverruled(region: BrainRegion, decision: Decision, consensus: Decision): void
  getRecentNearMisses(limit: number): NearMiss[]
}

// 10. src/ui/performance-card.ts
export class PerformanceCardGenerator {
  generateCard(mechaId: string): Buffer  // PNG with mecha portrait + stats
  generateShareableLink(card: Buffer): string
}
```

### Phase 2

```typescript
// 11. src/mecha/legendary-scorer.ts
export class LegendaryScorer {
  scoreSignal(signal: Signal, mecha: MechaGirl, market: MarketState): Rarity
  // Variable-ratio: base 0.4% × multipliers (confidence, hitRate, market, level)
}

// 12. UI — 卡背翻轉動畫
// ui/src/components/LegendaryCardFlip.tsx
```

### Phase 3

```typescript
// 13. src/mecha/breeding.ts
export class MechaBreeding {
  breed(parentA: MechaGirl, parentB: MechaGirl): MechaGirl  // 50/50 + 10% mutation
  runPaperMode(child: MechaGirl): Promise<MechaGirl>  // 100 paper trades
}

// 14. src/marketplace/mecha-market.ts
export class MechaMarketplace {
  listMecha(mechaId: string, price: number): void
  transferOwnership(mechaId: string, from: string, to: string): void
  adoptRetiredTemplate(mechaId: string): MechaGirl  // copy personality, reset history
}
```

---

## 附錄：設計演化記錄

### 從 General 到 機械妹

| 版本 | 角色 | 情感對象 | 缺陷 |
|------|------|---------|------|
| v1 (PETS.md 初版) | Pet (Agent) | Agent 本身 | 太抽象，缺「創造」行為 |
| v2 (General 框架) | 將軍 + 士兵 | 士兵（金錢）+ 將軍 | 關係功能性，非創造性；戰爭太重 |
| **v3 (機械妹框架)** | **機械妹** | **機械妹本身** | **創造先於交易；HACP = 大腦；文化原型強** |

### 機械妹框架嘅關鍵突破

1. **創造先於交易**——情感投入喺 ROI 計算之前發生
2. **HACP = 大腦運算**——cold debate log 變成 emotional brain visualization
3. **三重資源系統**——能量（即時）+ 記憶（歷史）+ 進化（長期）覆蓋全部時間維度
4. **機械妹文化原型**——Eva、NieR、少女前線、明日方舟驗證亞洲 billion-dollar 市場
5. **歷史 = 稀缺**——on-chain provenance 解決 NFT 可複製問題

### 核心信念

> **如果 gamification 係 bolt-on，兩個月就失效。**
> **如果 gamification 係從交易機制湧現，佢會同 Pokemon 一樣長壽。**
>
> 機械妹框架唔係加一層遊戲化皮。而係令 HACP 辯論變成「佢諗緊嘢」，令資金變成「佢嘅能量」，令交易歷史變成「佢嘅記憶」，令資產增長變成「佢嘅進化」。
>
> 創造佢，養成佢，唔捨得放棄佢。
> 呢個就係 MATS 從 Tool 走向機械妹再走向生態系統嘅完整路線圖。

---

_文檔版本: v2.0 | 日期: 2026-07-10 | 作者: Yuki_
_前序版本: v1.0 (Pet 框架) → v1.5 (General 框架) → v2.0 (機械妹框架)_