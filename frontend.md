# MATS_Frontend 建構方案

> **狀態**: 方案文件(未實施,未構建)
> **日期**: 2026-07
> **目的**: 將 MATS_Backend 嘅整個網頁端 frontend 完整複製為獨立 folder「MATS_Frontend」,成為**零 AI 運算**嘅純客戶端——所有運算資料只由 Supabase 提供,並由客戶端自行處理 paper & real 獨立下單。

---

## 一、目標同邊界

### 目標

1. **完整複製**現有 `MATS_Backend/ui/`(React + Vite SPA)為獨立 folder `MATS_Frontend`(位於 `/Users/y.c./Downloads/MATS_Frontend`)。
2. **零 AI 運算**:MATS_Frontend 唔會起 HACP cycle、唔會 call LLM、唔會做任何 agent 推理。佢只係一個**讀取 + 顯示 + 下單**嘅客戶端。
3. **資料唯一來源 = Supabase**:MATS_Frontend 顯示嘅**大部分資訊**都直接由 Supabase 讀取;而 Supabase 嘅資訊由 **MATS_Backend 每 cycle feed 入去**(唔再靠 SSE 直推)。
4. **Clean-snapshot 語義**:Supabase 只需保留**最新一組**數據——每 cycle 更新時刪除上一 cycle 嘅舊資料,因為只係 for 顯示今次訊號結果嘅運算過程比用戶睇。
5. **客戶端獨立下單**:Paper(模擬)同 Real(真實 Hyperliquid)下單由 MATS_Frontend 自己處理,唔再經後端 `tradingManager.executeDecision()`。

### 主神裁定記錄(2026-07,18 題)

| # | 問題 | 裁定 |
|:--|:-----|:-----|
| Q1 | 雙系統並存 | **選項 B**:後端照舊(官方基金繼續營運 + 落單),MATS_Frontend 係「另類前台」。官方基金 vs 用戶帳戶係**唔同 HL wallet**,自然分離,無倉位衝突 |
| Q2 | Pause / Shutdown button | **保留按鍵**,功能完全唔同,容後再定義 |
| Q3 | ui_snapshots feed 時機 | **每 cycle 運算完成 feed 一次**;payload 要包括 8 個 agent 對每個資產嘅運算結果、理據、信心指數(會比較大) |
| Q4 | cycle 進行中顯示 | **唔中途 feed**——用戶喺運算期間睇住舊數據(避免混亂) |
| Q5 | polling vs Realtime | 見 §五.5 分析(預設 polling,見下) |
| Q6 | 市場選擇 | **唔俾用戶揀市場**——只 feed 後端已選擇嘅市場 |
| Q7 | Paper engine | **完整移植**(前端計算 → 寫返 Supabase 用戶 section,各自分擔) |
| Q8 | SL/TP | 根據 Supabase 中後端俾嘅 signal 設定——1×3 matrix 落單時已經指示點設 SL/TP |
| Q9 | 風險風格 | 操控桿/按鍵由**客戶自己調節風險風格**,儲存喺 Supabase,再開 Dashboard 直接讀取 |
| Q10 | Real 定價 | MATS_Frontend 自己 call l2Book 定價,做到 market price 下單嗰種即時性 |
| Q11 | Real 簽名 | **唔使用用戶簽名**(體驗更流暢)——即方案 B(薄代理 / 官方代理),見 §六.2 |
| Q12 | HL rate limit | 前端直接 call HL 讀 clearinghouseState 要 throttle + cache |
| Q13 | Agent 面板 | **永遠 show「上一次完成咗嘅 cycle 結果」** |
| Q14 | Settings modal | 內容**完全唔同**,主神稍後再講 |
| Q15 | TradingView | **要** TradingView widget 圖表 |
| Q16 | 歷史資料 | 參考 `mats_app`(手機 app)——每個用戶歷史獨立存 Supabase,混合 paper & real,冇詳細入場/出場理由;攞返方式主神稍後講 |
| Q17 | Supabase Auth | **要有用戶獨立 Auth**——用戶只讀寫自己紀錄 + 閱讀公開嘅上 cycle 運算結果 |
| Q18 | 部署位置 | `/Users/y.c./Downloads`(MATS_Frontend folder 所在地) |

### 主神裁定記錄 2(2026-08-06,7 項補充——MATS_Frontend 執行依據)

| # | 問題 | 裁定 | 影響 |
|:--|:-----|:-----|:-----|
| R1 | Real 下單模型(Q11 最終) | **每個用戶用自己 wallet**(方案 A:自託管,用戶簽名) | §六.2 Real Engine 由「薄代理」改為「用戶自託管」——前端 call HL API + `@noble/curves` 簽名(參考 mats_app `src/wallet/`),PK 存設備 SecureStorage,後端永不持有 |
| R2 | Settings modal 內容(Q14) | **之後再補** | 唔 block;user_risk_prefs 先建基本欄位,細節後補 |
| R3 | 歷史資料格式(Q16) | **用大部分 mats_app 格式** | portfolios/positions/trades 表照 mats_app migration 01 結構(見 §五.1) |
| R4 | Auth 方式(Q17) | **passkey 好似 mats_app** | Supabase WebAuthn:`experimental: { passkey: true }` + `signInWithPasskey()`(參考 mats_app supabaseClient.ts + biometric.ts;web 上 device-biometric 只係 gate,真正 auth 係 WebAuthn ceremony) |
| R5 | Pause/Shutdown button(Q2) | **之後再補** | UI 保留按鍵,功能後定 |
| R6 | Agent 面板顯示粒度(Q3) | **完整數據** | ui_snapshots.agent_thoughts 存 8 agent × 每資產完整理據/信心/決策(payload 較大,可接受) |
| R7 | 用戶下單權限 | **之後再分權限** | 先做單一權限(所有用戶同級),權限分級後補 |

### 明確非目標(唔會做)

- 唔做任何 AI/LLM 推理
- 唔改 MATS_Backend 嘅現有運算邏輯(後端照常跑,照常寫 Supabase,官方基金照常落單)
- 唔做後端——MATS_Frontend 係純 static SPA
- 唔做用戶市場選擇(Q6:只顯示後端已選市場)

---

## 二、現有 frontend 解剖(複製前嘅 inventory)

現有 `MATS_Backend/ui/` 構成:

| 檔案 | 用途 | 新 MATS_Frontend 處置 |
|:-----|:-----|:-----|
| `src/App.tsx` (4,447 行) | 主應用:狀態 + 全部面板 | 重構——抽走 AI 依賴,保留 UI 骨架 |
| `src/index.css` (5,727 行) | 全部樣式(glass/neon 主題) | 完整保留 |
| `src/main.tsx` | React 入口 | 保留 |
| `src/types.ts` (APIData 等) | 後端 API 狀態 shape | 大幅刪減——APIData 唔再存在 |
| `src/lib/supabase.ts` | Supabase client + `fetchAssetAnalyses()` | **核心保留 + 擴展** |
| `src/TradingViewChart.tsx` | 圖表 | 保留(改用公開行情源) |
| `src/StarsBackground.tsx` | 背景動畫 | 保留 |
| `vite.config.ts` / `package.json` | 構建 | 保留(proxy `/api` 移除) |

### 現有 UI 嘅資料依賴(inventory)

| 資料 | 現時來源 | 新方案(MATS_Frontend 讀取) |
|:-----|:-----|:-----|
| 分析訊號(market_data/consensus/matrix) | Supabase `asset_analyses`(已接) | ✅ **沿用**——後端每 cycle 已 feed |
| Agent 思考/狀態(8 個 agent × 每資產) | 後端 SSE `/api/events` | ✅ **後端 feed 入 `ui_snapshots.agent_thoughts`**(Q3: 包括每資產運算結果 + 理據 + 信心指數) |
| Portfolio/positions(paper) | 後端 `portfolio`(SSE) | ✅ **用戶自己 section**(Q7: paper engine 前端計算 → 寫 Supabase 用戶 section) |
| Top pairs 市場列表 | 後端 `/market-agent/top-pairs` | ✅ **後端 feed 入 `ui_snapshots.market_agent`**——只顯示後端已選市場(Q6: 用戶唔揀) |
| 價格/24h 變化 | 後端 REST | ✅ `asset_analyses.market_data` + `ui_snapshots` |
| Balance/Equity(paper) | 後端(SSE) | ✅ **Supabase `portfolios`(用戶 section)**——paper engine 計算後寫入 |
| Balance/Equity(real) | 後端(SSE) | ✅ **用戶自己連 HL API**(throttle + cache, Q12) |
| Trading markets(用戶選擇) | 後端 POST `/trading-markets` | ❌ **移除**——Q6: 用戶唔揀市場,只顯示後端已選 |
| Settings/env | 後端 `/settings/env` | ❌ 移除(env 只屬後端;Settings modal 完全唔同,Q14) |
| 演化學習狀態(OLR/Q-RL/attribution) | 後端 SSE | ✅ **後端 feed 入 `ui_snapshots.olr_state/evolution`**——只顯示,唔運算 |
| 演化學習狀態(v2.0.861-862 新增) | 後端 SSE | ✅ **Q-RL Direction(per-symbol bucket/lean)+ PAEL(per-asset MFE/MAE profiles + lock gate)——只顯示,唔運算** |

**核心洞察**:MATS_Frontend 顯示嘅資料分三類——① 公開分析(asset_analyses + ui_snapshots,後端 feed)② 用戶私密資料(portfolios/positions/trades,用戶 section)③ Real 帳戶(用戶自己連 HL API)。

---
---

## 三、新架構總覽

```
┌─────────────────────────────────────────────────────────────┐
│                    MATS_Backend(照常運行)                     │
│   HACP cycle → 每資產計算 consensus                            │
│   └─ cycle 完成後 feed 兩組數據入 Supabase:                   │
│       ① asset_analyses(每資產矩陣)                           │
│       ② ui_snapshots(完整 UI 狀態:status/portfolio/           │
│          consensus/agentThoughts/olrState/evolution ...)     │
└──────────────────────────┬──────────────────────────────────┘
                           │ service_role(寫,DELETE 舊 + INSERT 新)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│      Supabase(唯一資料中樞,只保留最新一組 clean-snapshot)      │
│   asset_analyses(分析訊號,已有)                              │
│   ui_snapshots(UI 顯示狀態,新表)                             │
│   portfolios/positions/trades(用戶 section,沿用 mats_app)    │
│   user_risk_prefs(風險風格,新表) + orders(落單記錄,新表)      │
└──────────────────────────┬──────────────────────────────────┘
                           │ anon key(讀)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  MATS_Frontend(零 AI 運算 SPA)               │
│   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  │
│   │  Signal View │   │ Market Select│   │  Trading Desk │  │
│   │  (matrix)    │   │  (pairs)     │   │  (paper/real) │  │
│   └──────┬───────┘   └──────┬───────┘   └───────┬───────┘  │
│          └──────┬───────────┴──────────┬─────────┘         │
│                 ▼                      ▼                   │
│          Supabase 讀取             Real: 直接 call HL API   │
│          (asset_analyses +         (clearinghouseState /   │
│           ui_snapshots +            userFills / placeOrder)│
│           orders + paper 表)                                │
└─────────────────────────────────────────────────────────────┘
```

**原則**:MATS_Frontend 只做三件事——**讀**(Supabase + HL API for real)、**顯示**(訊號)、**執行**(下單)。零推理、零學習、零後端依賴。

---

## 四、folder 結構(MATS_Frontend)

```
MATS_Frontend/
├── index.html
├── package.json          # 依賴: @supabase/supabase-js, @supabase/auth-ui-react, @nktkas/hyperliquid(方案 B: 薄代理則唔需要), recharts
├── vite.config.ts        # 無 proxy;純 static build
├── .env.example          # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
├── src/
│   ├── main.tsx
│   ├── App.tsx           # 重構後主應用(見 §七)
│   ├── index.css         # 完整保留
│   ├── types.ts          # 新 shape(ui_snapshots + AssetAnalysisRow + 用戶 section 為主)
│   ├── StarsBackground.tsx
│   ├── TradingViewChart.tsx  # 保留,改用 TradingView widget(公開)
│   ├── lib/
│   │   ├── supabase.ts       # 擴展:ui_snapshots 讀 + 用戶 section(portfolios/positions/trades)CRUD
│   │   ├── paper-engine.ts   # 客戶端紙交易引擎(完整移植後端 portfolio.ts 邏輯,Q7)
│   │   ├── hl-client.ts      # 客戶端 Hyperliquid client(讀 clearinghouseState, throttle+cache,Q12)
│   │   └── market-data.ts    # 公開行情源(fallback 價格顯示)
│   ├── auth/
│   │   └── AuthGate.tsx      # Supabase Auth 登入/註冊(Q17: 用戶獨立 Auth)
│   └── components/
│       ├── SignalMatrix.tsx      # 讀 Supabase matrix → 顯示(1×3)
│       ├── TradingDesk.tsx       # paper/real 下單面板(風險風格 slider 存 Supabase,Q9)
│       ├── PositionsPanel.tsx    # 倉位(paper=Supabase section / real=HL API)
│       ├── BalanceBar.tsx        # 餘額(paper=Supabase portfolios / real=HL API)
│       ├── AgentMonitor.tsx      # 8 個 agent 上 cycle 運算結果(讀 ui_snapshots,Q13)
│       ├── EvolutionStats.tsx    # 演化 stats(讀 ui_snapshots,只顯示)
│       └── SettingsPanel.tsx     # Settings modal(內容待主神定義,Q14)
├── supabase/
│   └── migrations/
│       └── 00000000000020_mats_frontend.sql  # ui_snapshots 表 + 用戶風險風格表(新)
└── README.md
```

> **參考**:`mats_app`(手機 app)已有完整 per-user Supabase 架構(portfolios/positions/trades + RLS auth.uid() 隔離)——MATS_Frontend 直接複用呢個模式(Q16/Q17),唔使自己發明。

---

## 五、Supabase schema

> **核心原則(Q17)**:用戶獨立 Auth——每用戶只讀寫自己紀錄 + 閱讀公開嘅上 cycle 運算結果。`mats_app` 已建立 per-user 模型(RLS `auth.uid() = user_id`),MATS_Frontend 直接沿用,只新增 `ui_snapshots` + 用戶風險風格表。

### 5.1 沿用 mats_app 現有表(per-user,RLS 已設)

| 表 | 用途 | RLS |
|:--|:--|:--|
| `portfolios` | 用戶 paper 帳戶(balance/equity/pnl,`ensure_portfolio()` RPC seed) | select/update own |
| `positions` | 開倉(user_id 隔離;`buy_reason`/`sell_reason` jsonb 記錄入場/出場理據 snapshot) | select/insert/update/delete own |
| `trades` | 平倉歷史(混合 paper & real;buy_time/sell_time/price/pnl) | select/insert/update own |
| `ai_analyses` | per-user AI 分析(後端 service_role 寫,用戶 anon 讀自己) | select own |
| `asset_analyses` | 公開每資產分析矩陣(後端每 cycle feed) | select all(公開) |

### 5.2 新增: `ui_snapshots` — 公開上 cycle 運算結果(核心)

MATS_Backend 每 cycle 完成後將**完整 UI payload** 寫入此表(Q3)。Clean-snapshot:每 cycle DELETE 全部 + INSERT 一組。**公開讀取**(所有用戶可睇上 cycle 運算過程)。

```sql
create table if not exists public.ui_snapshots (
  id            bigint primary key,          -- cycle_id
  created_at    timestamptz not null default now(),
  status        jsonb not null default '{}'::jsonb,    -- cycles/balance/equity/positions/wsConnected...
  portfolio     jsonb not null default '{}'::jsonb,    -- 後端 feed 嘅顯示用 portfolio(參考)
  market_state  jsonb not null default '{}'::jsonb,
  consensus     jsonb not null default '{}'::jsonb,
  agent_thoughts jsonb not null default '[]'::jsonb,   -- Q3: 8 個 agent × 每資產運算結果 + 理據 + 信心指數
  agent_statuses jsonb not null default '[]'::jsonb,
  cycle_progress jsonb not null default '{}'::jsonb,
  olr_state     jsonb not null default '{}'::jsonb,
  evolution     jsonb not null default '{}'::jsonb,
  market_agent  jsonb not null default '{}'::jsonb,    -- 後端已選市場(Q6)
  thesis_rejections jsonb not null default '[]'::jsonb,
  decision_audit jsonb not null default '[]'::jsonb,
  news_headlines jsonb not null default '[]'::jsonb,
  meta          jsonb not null default '{}'::jsonb
);

create index if not exists idx_ui_snapshots_created on public.ui_snapshots (created_at desc);
alter table public.ui_snapshots enable row level security;
create policy "read ui_snapshots" on public.ui_snapshots for select using (true);  -- 公開讀
-- 寫: 後端 service_role(RLS bypass)
```

### 5.3 新增: `user_risk_prefs` — 用戶風險風格(Q9)

用戶自己調節風險風格(操控桿/按鍵)→ 存 Supabase → 再開 Dashboard 直接讀取。

```sql
create table if not exists public.user_risk_prefs (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  position_size_pct numeric not null default 0.10,   -- 倉位大小 %
  max_portion_pct   numeric not null default 0.20,   -- 最大比例
  leverage          numeric not null default 10,     -- 槓桿
  trade_mode        text not null default 'paper' check (trade_mode in ('paper','real')),
  updated_at        timestamptz not null default now()
);

alter table public.user_risk_prefs enable row level security;
create policy "own risk prefs" on public.user_risk_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

### 5.4 新增: `orders` — 落單記錄(paper + real,per-user)

mats_app 嘅 `trades` 表係「平倉歷史」;MATS_Frontend 落單過程(含 signal 來源)由 `orders` 記錄,平倉後寫入 `trades`。

```sql
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  mode          text not null check (mode in ('paper','real')),
  symbol        text not null,
  side          text not null check (side in ('buy','sell')),
  order_type    text not null default 'market',
  quantity      numeric not null,
  price         numeric,
  status        text not null default 'pending',      -- pending/filled/failed/canceled
  signal_cycle  bigint,                               -- 觸發呢單嘅 cycle_id
  signal_action text,                                 -- matrix cell action
  signal_conf   numeric,                              -- confidence
  sl_price      numeric,                              -- Q8: SL(由 signal 設定)
  tp_price      numeric,                              -- Q8: TP(由 signal 設定)
  meta          jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.orders enable row level security;
create policy "own orders" on public.orders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

---

## 五.5 Polling vs Supabase Realtime(Q5 分析)

| 維度 | Polling | Supabase Realtime |
|:--|:--|:--|
| 機制 | 每 N 秒 `SELECT * FROM ui_snapshots` | Postgres WAL → WebSocket push |
| 延遲 | N/2 秒平均(設 10s → 平均 5s) | 近即時(<1s) |
| 複雜度 | 極簡單(一個 setInterval + fetch) | 需 `REPLICA IDENTITY FULL` + subscription 管理 |
| 資源 | 每 10s 一次小 query,可忽略 | WebSocket 常駐連接 |
| 適合度 | ✅ 訊號每 cycle(5 分鐘)先變一次 | 過度設計 |

**裁定(預設)**:Polling(10s 間隔)——訊號本身每 cycle 先更新,唔需要毫秒級;static host 無 WebSocket server 問題;少一個 failure point。若日後想要「cycle 完成即時通知」可加 Supabase Realtime 做 enhancement(低優先)。

---

## 六、客戶端下單系統(核心設計)

### 6.1 Paper Engine(完整移植,Q7)

**完整移植**後端 `portfolio.ts` 嘅紙交易邏輯到前端:margin 扣除(notional/leverage)、槓桿 sanitize、mark-to-market、funding rate、liquidation 檢查——前端計算完 → 寫返 Supabase **用戶 section**(`portfolios`/`positions`/`trades`/`orders`),各自分擔 data。

```
用戶撳「BUY」→ PaperEngine.placeOrder(symbol, side, qty)
  ├─ 價格來源: asset_analyses.market_data.price(最新 cycle)/ HL 公開 API fallback
  ├─ 讀 user_risk_prefs(Q9): position_size_pct / max_portion_pct / leverage
  ├─ 檢查: portfolios.balance 足夠(margin = notional / leverage)
  ├─ upsert positions(user_id 隔離,寫 buy_reason snapshot)
  ├─ 計 equity = balance + Σ unrealized PnL(最新價 mark-to-market)
  ├─ 寫 portfolios(balance/equity/realized_pnl)
  └─ 寫 orders(mode='paper', status='filled', sl_price/tp_price)
```

**Close**:按當前價平倉 → realized PnL 入 balance → 寫 trades(平倉歷史)+ 更新 orders。

### 6.2 Real Engine(方案 B: 薄代理,唔用用戶簽名,Q11)

**主神裁定(Q11)**:唔使用用戶簽名(體驗更流暢)→ **方案 B(薄代理 / 官方代理)**。

```
MATS_Frontend 撳「BUY」
  ├─ 讀 HL 帳戶(clearinghouseState, throttle + cache, Q12)
  ├─ l2Book 定價(Q10): best bid/ask ± 滑點 → aggressive price(做到 market price 即時性)
  ├─ 送落單請求 → 薄代理(只做 HL 簽名 + 落單,零 AI)
  ├─ 薄代理 → HL API → 確認 fill
  ├─ 寫 orders(mode='real', status='filled', fill price)
  └─ UI positions 由 HL API 讀取(唔存本地)
```

**薄代理設計**(後續細化):極輕量 Node server(只有 HL 簽名 + 落單 + 讀帳戶),private key 唔落 browser、唔入 Supabase;MATS_Frontend 經 HTTPS call。**主神需確認**:薄代理由官方營運(官方 wallet)?定每個用戶自己 wallet?——呢個影響「官方基金 vs 用戶帳戶」嘅分離模型(Q1 關聯)。

### 6.3 SL/TP 設定(Q8)

**由 Supabase 中後端俾嘅 signal 設定**——1×3 matrix(risk profile × position state)落單時已經指示當前情況 + 應該點設 SL/TP:

- 落單時:讀 `asset_analyses.matrix.moderate[state]` 對應格 → 取 `suggestedStopLoss` / `suggestedTakeProfit`(後端 smart-sltp 已計算)
- 寫入 `orders.sl_price` / `orders.tp_price`
- Paper:本地 trigger(價到自動平)
- Real:薄代理掛 HL trigger order(需要簽名)

### 6.4 風險風格(Q9)

- TradingDesk 有操控桿/按鍵(position size / max portion / leverage / trade mode)
- 用戶調節 → 存 `user_risk_prefs`(Supabase,per-user)
- 再開 Dashboard → 直接讀取(跨裝置一致)

### 6.5 訊號 → 下單銜接

- MATS_Frontend 每 10s poll Supabase `ui_snapshots` + `asset_analyses`(Q5)
- 顯示後端已選市場(Q6)嘅 matrix 推薦(action/conviction/rationale/SL/TP)
- 用戶**手動確認**先落單(唔自動執行)
- orders 表記錄 signal_cycle/signal_action,可 audit 訊號準唔準

---

## 七、UI 模組重構(App.tsx 拆分)

現有 App.tsx(4,447 行)重構為:

| 新模組 | 內容 | 來源 |
|:-----|:-----|:-----|
| `AuthGate.tsx` | Supabase Auth 登入/註冊(Q17) | 新寫(`@supabase/auth-ui-react` 或自訂) |
| `SignalMatrix.tsx` | 每個 symbol 嘅 1×3 matrix 顯示(action/conviction/rationale/SL/TP) | 由 `renderAnalysisMatrix` 抽離 |
| `TradingDesk.tsx` | paper/real toggle、下單按鈕、風險風格 slider(position size/leverage→存 Supabase,Q9)、確認流程 | 新寫 + 沿用現有 sliders |
| `PositionsPanel.tsx` | 倉位卡片(paper:Supabase section / real:HL API) | 由 SMP position rows 改造 |
| `BalanceBar.tsx` | 餘額/equity(paper:Supabase portfolios / real:HL API) | 由 StatCell 改造 |
| `AgentMonitor.tsx` | **8 個 agent 上 cycle 運算結果**(讀 `ui_snapshots.agent_thoughts`,Q3/Q13) | 由 AgentCard 改造——顯示上一個完成 cycle 嘅結果 |
| `EvolutionStats.tsx` | OLR/Q-RL/attribution stats(讀 ui_snapshots,只顯示) | 由 evolution stats 改造 |
| `TradingViewPanel.tsx` | TradingView widget 圖表(Q15) | 新寫(widget 公開 embed) |
| `SettingsPanel.tsx` | Settings modal——內容**完全唔同**,待主神定義(Q14) | 佔位,唔照搬現有 |

**按鍵(Q2)**:Pause / Shutdown **保留按鍵**,但功能完全唔同——容後再加(純前端語義,唔控制後端)。

**移除**:
- MarketPicker / 市場選擇(Q6: 用戶唔揀市場,只顯示後端已選)
- Models 管理、Root Command Prompt、env settings(後端設定)
- 後端控制(pause/resume/cycle trigger/backtest/shutdown 舊語義)

**保留(改由 Supabase 讀取)**:
- 全套 index.css(glass/neon 主題)
- StarsBackground、TradingViewChart(widget 公開 embed)
- 「📊 DB {n}」Supabase 狀態顯示
- Agent 面板、Skeptics audit、Evolution stats——讀 `ui_snapshots` 快照

---

## 八、行情數據源

**分析訊號**(主要):由 Supabase 提供——`asset_analyses.market_data`(price/volatility/regime/change24h/volume24h)+ `ui_snapshots` 各 section。

**TradingView 圖表**(可選額外):直接連 TradingView widget 公開行情(`https://s.tradingview.com/widgetembed/`),零後端。

**價格 fallback**(下單時):HL 公開 REST `https://api.hyperliquid.xyz/info`(POST `{"type":"allMids"}`)——純公開數據,無需 key,無 CORS 問題(HL API 允許跨域)。

**Real 帳戶**:MATS_Frontend 直接 call HL API——`clearinghouseState`(balance/equity/positions)、`userFills`(成交記錄)、`placeOrder`(落單),全部唔經 Supabase。

---

## 八.5 後端 feed 機制(新——MATS_Backend 需要加嘅嘢)

MATS_Backend 現時 `pushToAPI()` 每 cycle 組裝完整 UI payload 推 SSE。新架構唔改 payload 組裝邏輯,只加一個**額外輸出**:

```
runDecisionCycle() 完成後(或 pushToAPI() 內部):
  → supabaseWriter.writeUiSnapshot(apiData)   # 新方法
     ├─ DELETE FROM ui_snapshots              # 清舊(clean-snapshot)
     └─ INSERT 一組(拆欄位:status/portfolio/market_state/consensus/agent_thoughts/...)
```

**實作考量**:
- `supabase-writer.ts` 新增 `writeUiSnapshot(payload)` 方法,同 `writeCycle()` 一樣用 service_role、失敗只 log 唔 block cycle
- 可將 apiData 組裝抽成獨立函數,`pushToAPI()` 同 feed 共用(避免兩份組裝邏輯 drift)
- 寫入頻率 = 每 cycle 一次(唔係每 SSE push 一次),符合「保留最新一組」
- Real mode 嘅 exchange balance:後端 feed 照寫(顯示用);MATS_Frontend real 模式優先讀 HL API 覆蓋顯示

---

## 九、實施步驟(獲批後執行)

**✅ 執行狀態(2026-08-06)**:
- **階段 1(後端 feed)**:✅ 完成——`writeUiSnapshot()` + migration 19 已 apply(ui_snapshots/user_risk_prefs/orders 表已建)
- **階段 2(Auth + 骨架)**:✅ 完成——MATS_Frontend folder 建立(copy ui/ 基礎)+ AuthGate(passkey, R4)+ 零 /api proxy
- **階段 3(資料層)**:✅ 完成——supabase.ts(passkey auth + 三資料流讀取)+ paper-engine.ts(純邏輯, 15 vitest tests)+ hl-client.ts(HL 讀取 + 簽名骨架)
- **階段 4(UI 重構)**:✅ 完成——SignalMatrix(訊號 + 落單 + 風險滑桿 Q9)+ PositionsPanel(paper + real HL)+ AgentMonitor(agent_thoughts 完整 R6)+ EvolutionStats;TradingViewChart copy(用 lightweight-charts v5)
- **階段 5(Real 自託管)**:⏳ 部分——l2Book 定價 ✓、wallet 存儲骨架 ✓;@noble/curves 完整簽名 + 提交待 stage 5
- **階段 6(打磨)**:⏳ 待 R2(R5/R7 後補)——Settings modal、權限分級、Pause/Shutdown 功能

## 九、實施步驟(獲批後執行)

```
[階段 1] 後端 feed 機制(≤2h)
  Step 1.1: supabase-writer 新增 writeUiSnapshot()(clean-snapshot DELETE+INSERT)
  Step 1.2: apiData 組裝抽成共用函數;runDecisionCycle 完成後 call writeUiSnapshot
  Step 1.3: Supabase migration 建 ui_snapshots + user_risk_prefs + orders 表
  ✓ 驗證: 後端跑一個 cycle → ui_snapshots 得最新一組,agent_thoughts 有 8 個 agent × 每資產

[階段 2] Auth + 骨架(≤2h)
  Step 2.1: Supabase Auth 啟用(Email + 第三方)
  Step 2.2: mkdir MATS_Frontend → copy ui/ 全部檔案(除 .bak)
  Step 2.3: package.json 改依賴 + vite.config 移除 /api proxy
  Step 2.4: AuthGate + RLS 驗證(登入後只讀到自己 section)
  ✓ 驗證: vite build 成功;兩個用戶互相睇唔到對方 positions

[階段 3] 資料層(≤3h)
  Step 3.1: lib/supabase.ts 擴展(ui_snapshots 讀 + 用戶 section CRUD)
  Step 3.2: 新增 lib/paper-engine.ts(完整移植 portfolio.ts 邏輯,Q7)
  Step 3.3: 新增 lib/hl-client.ts(讀 clearinghouseState, throttle+cache,Q12)
  ✓ 驗證: paper-engine 單元測試(開/平倉/保證金/mark-to-market/SL-TP)

[階段 4] UI 重構(≤4h)
  Step 4.1: 抽 SignalMatrix / TradingDesk(風險風格存 Supabase,Q9)
  Step 4.2: 抽 PositionsPanel / BalanceBar(paper=Supabase / real=HL API)
  Step 4.3: AgentMonitor(讀 ui_snapshots.agent_thoughts,Q13)+ EvolutionStats
  Step 4.4: TradingView widget(Q15);刪除 MarketPicker/後端控制
  ✓ 驗證: 手動測試 paper 全流程(登入→開倉→顯示→平倉→PnL)

[階段 5] Real 薄代理(≤3h,待 Q11 確認)
  Step 5.1: l2Book 定價(Q10)+ 薄代理落單
  Step 5.2: fill 確認 + orders 表記錄
  Step 5.3: 安全 review(private key 只喺薄代理)
  ✓ 驗證: 小額 real 測試單

[階段 6] 打磨(≤2h)
  Step 6.1: Polling 10s(Q5)+ error/loading/empty states
  Step 6.2: Settings modal(Q14 待主神定義後實作)
  Step 6.3: README + frontend.md 更新
  ✓ 驗證: 全套手動測試 + 安全 review
```

---

## 十、風險同注意事項

| 風險 | 等級 | 緩解 |
|:-----|:-----|:-----|
| **private key 存 browser(XSS 風險)** | 🔴 HIGH | 方案 A 嚴格限制:唔上傳、唔入 Supabase、可選 pin lock、建議獨立 browser profile;或改方案 B 薄代理 |
| 訊號延遲(polling vs 後端 SSE) | 🟡 MED | Supabase Realtime subscription 可達近即時;訊號本身係每 cycle 更新,唔需要毫秒級 |
| Paper vs Real 唔一致(客戶端各自維護) | 🟡 MED | orders 表統一記錄;paper 用 HL 真實價 mark;real 以交易所為唯一真相 |
| Supabase RLS 過度開放 | 🟡 MED | 單用戶階段公開;上線前加 auth + owner policy |
| 誤撳自動下單 | 🟢 LOW | 所有下單需手動確認;orders 表保留 signal_cycle 可追溯 |

---

## 十.5 v2.0.861-862 Evolution Engine UI 變更記錄(對 MATS_Frontend 構建有參考)

MATS_Backend `ui/`(legacy dashboard)嘅 Evolution Engine 面板喺 v2.0.861-862 有以下變更——MATS_Frontend 構建時應該沿用呢個「顯示 vs 移除」準則:

| 變更 | 內容 | MATS_Frontend 啟示 |
|:-----|:-----|:-----|
| **新增 Q-RL Direction section** | SystemStatusGrid +「OLR + Bayesian + Q-RL Direction」section 加 `=== Q-RL EXPECTANCY ===` 子塊——per-trading-symbol 顯示當前 state bucket、BUY/SELL Q-value + **median(skew-robust)** + 樣本數 + lean 判定(BUY/SELL/中性/⚠️ 樣本飢餓) | 只顯示後端 feed 嘅 `advancedLearning.qrlDirection`(per-symbol lean)——**前端零運算** |
| **新增 PAEL section** | per-asset×direction MFE p50/p75/p90 + MAE p95 + 樣本數 + 🔒 lock @ p75×0.8 + lock gate 觸發總數 | 顯示 `advancedLearning.pael`(profiles + lockCount)——**離場價位係數據驅動,前端只顯示** |
| **移除 RP Edge Store** | v2.0.859 已移除 MiniLM edge-store(zero decision consumers),但 UI 未同步 → 永久紅燈。已清理 4 處死引用(UI vars + system push + systemsReady count + types) | **構建時檢查:每個顯示嘅 system 必須有 live backend 數據源**——死組件唔准顯示 |
| **修復 NA 顯示** | 275266 samples 但 validation FAILED 時,舊 UI 顯示「/200」誤導(暗示差 200)。新 UI 顯示「275266 samples, val ✗ (reason)」+ disabled 狀態 | **數字要配真實狀態**——樣本數大但 validation fail = 卡住,唔係「差少少」 |
| **systemsTotal 18 → 20** | + Q-RL Dir + PAEL(全部有 live 數據) | systems 數同 backend 組件數必須一致 |

**準則**:Evolution Engine 任何 system 格必須滿足「backend 有實體 + API 有數據 + UI 有顯示」三點——缺一點就係死組件,唔准出現喺面板(避免「永遠紅燈」)。

## 十一、同 MATS_Backend 嘅關係(最終狀態)

```
MATS_Backend(獨立運行,照常):
  • HACP cycle → 寫 Supabase asset_analyses + ui_snapshots(每 cycle clean-snapshot)
  • 官方基金照常自動落單(選項 B,Q1)——官方 wallet
  • 係「運算大腦」+「訊號 feed 源」+「官方基金執行端」

MATS_Frontend(獨立部署,零 AI):
  • Supabase Auth 登入(Q17)→ 讀 ui_snapshots + asset_analyses(公開)+ 自己 section
  • 用戶手動下單(paper = 前端計算寫 Supabase / real = 薄代理落單,唔用用戶簽名)
  • 係「另類前台」(Q1)——用戶自己嘅交易體驗

共同依賴: Supabase(資料中樞,只保留最新一組 + 用戶 per-user section)
```

**已裁定(2026-08-06,見「主神裁定記錄 2」)**:Real = 每個用戶自己 wallet(自託管簽名)· Settings modal = 後補 · 歷史格式 = mats_app · Auth = passkey(WebAuthn)· Pause/Shutdown = 後補 · Agent 面板 = 完整數據 · 權限 = 後分

**仍待主神補充**:
1. **Settings modal 細節**(R2 後補後再講)
2. **權限分級細節**(R7 後補後再講)
