# bStocks Module — Binance Agentic Wallet 接入方案

> **版本**: v2.0.870-P51 · **狀態**: 設計 + 骨架（數據源/交易執行待接）
> **用途**: MATS 接入 Binance Agentic Wallet，交易 bStock（代幣化美股），並完成 bStock AI Trading Competition。

---

## 1. 背景

- **bStock** = 1:1 背書嘅代幣化美股（BSC 鏈），24/7 交易，唔受美股開市時間限制。
- **比賽**: bStock AI-Powered PnL Trading Competition（2026-08-17 ~ 09-01 UTC），Top 100 按 Realized PnL 分最多 100,000 USDC。
- **MATS 嘅價值**: MATS 已經 trade 代幣化資產（xyz:SKHX/SILVER/SP500/MU），方向判斷（多 agent 共識）+ 順逆勢閘 + 共識反轉止蝕全部 venue-agnostic，可搬去 bStock。

### Symbol 對齊（同一個 underlying）

| MATS（Hyperliquid xyz:） | bStock（BSC） | Underlying |
|---|---|---|
| `xyz:SKHX` | `SKHYB` | SK Hynix |
| `xyz:SP500` | `SPYB` | S&P 500 ETF |
| `xyz:MU` | `MUB` | Micron |

---

## 2. 安裝（baw CLI）

```bash
# 安裝 Binance Agentic Wallet CLI
npm install -g @binance/agentic-wallet

# 驗證
baw --version
```

> `baw` 係 Node.js CLI，管理 Agentic Wallet 嘅 sign-in / balance / swap / prediction / DeFi 等操作。session 存喺本地（CLI 自己管理，唔使手動存 token）。

---

## 3. 認證流程（Sign in Agentic Wallet）

```
1. baw auth signin --json
   → 返回 { urlForWeb, qrCodeId, pairingCode, expireAt }
2. 打開 urlForWeb（瀏覽器）→ 顯示 QR code
3. 用戶喺 Binance App 確認 pairingCode 一致 + 確認登入
4. baw auth verify --qrCodeId <id> --json
   → 阻塞直到用戶確認（或 5 分鐘 timeout）
5. baw wallet status --json
   → 確認連接（source of truth，唔係睇 App 畫面）
6. baw wallet address --json
   → 攞 wallet address（重要數據，存 env）
```

### 重要數據（存 env）

| 數據 | 來源 | 存邊 |
|---|---|---|
| `BINANCE_AW_ADDRESS` | `baw wallet address --json` | `.env` |
| session | `baw` CLI 本地管理 | 唔使手動存 |

> ⚠️ **session 唔係 token**——`baw` CLI 自己存喺本地（~/.baw 或類似），MATS 只係 drive 個 CLI，唔使攞 token 出嚟。

---

## 4. MATS 後端接入

### 4.1 服務層 `src/services/bstocks-wallet.ts`

```typescript
// 包裝 baw CLI（child_process.exec）
signIn(): Promise<{ urlForWeb, qrCodeId, pairingCode }>
verify(qrCodeId): Promise<{ success, status }>
getStatus(): Promise<{ connected, address }>
saveAddress(address): void  // 寫入 .env
```

### 4.2 API 路由（api-server.ts）

| 路由 | 方法 | 功能 |
|---|---|---|
| `/api/bstocks/connect` | POST | `baw auth signin` → 返回 pairingCode + urlForWeb |
| `/api/bstocks/verify` | POST | `baw auth verify` → 阻塞確認 |
| `/api/bstocks/status` | GET | `baw wallet status` + `address` → 返回連接狀態 + 地址 |

### 4.3 UI（Trading Terminal）

- "Connect" 按鈕 → 觸發 signin → 顯示 pairingCode + 開 urlForWeb
- "Verify" 按鈕 → 觸發 verify → 顯示結果
- 連接後顯示 wallet address

---

## 5. 比賽重點事項（Key Points）

### 5.1 三個硬要求（缺一不可）

| # | 要求 | 詳情 |
|---|---|---|
| 1 | CMC x402 呼叫 ≥3 | 只認 4 個 designated tools（execute_skill / get_crypto_metrics / get_global_metrics_latest / get_upcoming_macro_events） |
| 2 | Agent Studio x402 呼叫 ≥3 | 每次 ~0.1 U，async 兩段式（submit → poll → download report） |
| 3 | Realized PnL ≥ 0 | 結束時必須 ≥ 0，否則淘汰 |

### 5.2 交易規則

- **只 trade 本週 eligible list 嘅 bStock**（每週更新，`type=3` API 攞地址 + eligible list 確認）
- **Payment token 只限 5 種**: BNB / USDT / USDC / U / USD1（其他 token 唔計 PnL）
- **留 BNB 做 gas**（AI 呼叫 gasless，但買賣 bStock 要 BNB gas）
- **買 bStock（suffix B），唔係 Ondo（suffix on）**——兩個唔同系統
- **Realized PnL 只計已平倉部分**（FIFO lot-by-lot，唔係平均價）
- **未平倉 = paper gain ≠ PnL**（結束前唔清倉 = 白做）

### 5.3 槓桿 ETF 風險

Eligible list 可能包含 3X/2X 槓桿 ETF（SOXL/SOXS/TQQQ/KORU）——波動放大 2-3 倍，槓桿衰減，風險極高。

---

## 6. bStocks 交易機制（同現有系統嘅配合——重要）

### 6.1 bStocks 係 Swap，唔係 Order

**bStocks 冇傳統嘅 Buy/Sell order，只有 Swap**（`baw market-order swap`）：

| 動作 | baw 命令 |
|---|---|
| **買 bStock**（long） | `baw market-order swap --fromToken USDT --toToken <bStock地址>` |
| **賣 bStock**（close long） | `baw market-order swap --fromToken <bStock地址> --toToken USDT` |

### 6.2 冇原生 SL/TP

bStocks 係 swap，**冇原生 SL/TP order**。SL/TP 要：
- `baw limit-order sell`（限價單，喺目標價賣出 bStock）
- 或 MATS 自己監控價格，到 SL/TP 價位觸發 swap

### 6.3 Long-only（唔可以 short）

bStocks 係 1:1 背書嘅代幣化美股，**只可以揸（long），唔可以沽空（short）**。

### 6.4 同 MATS 現有系統嘅 mapping

| MATS 訊號 | bStocks 動作 | 備註 |
|---|---|---|
| **BUY** | swap USDT → bStock（買入） | 若已揸住就 skip |
| **SELL** | swap bStock → USDT（賣出/平倉） | 若冇揸住就 skip（唔可以 short） |
| **SL** | limit-order sell @ SL 價 | 或 MATS 監控觸發 swap |
| **TP** | limit-order sell @ TP 價 | 或 MATS 監控觸發 swap |

### 6.5 關鍵差異（同 Hyperliquid xyz: 對比）

| 維度 | Hyperliquid xyz: | bStocks |
|---|---|---|
| 方向 | long + short | **long only** |
| SL/TP | 原生 order | **冇原生，要 limit-order 或監控** |
| 執行 | 交易所 order | **swap（on-chain）** |
| 槓桿 | 有 | **冇（1:1）** |

> ⚠️ **結論**: bStocks 只係「買入揸住 + 到價賣出」嘅 long-only 模式。MATS 嘅 SELL（short）訊號喺 bStocks 度**唔適用**——只可以「平倉」（賣出已揸嘅 bStock）。SL/TP 要靠 limit-order 或 MATS 監控。

---

## 7. 比賽 vs MATS 嘅核心矛盾

```
MATS 設計 = 穩定盈利（soft gate、保守 sizing、TP>>SL）
比賽設計 = 最大 PnL（激進、集中、高槓桿）
```

**建議**: 一套大腦（方向判斷共用），兩副手（xyz: 穩定模式 + bStock 比賽模式）。唔好為咗比賽改壞 MATS 主系統。

---

## 8. 已完成（P51）

- [x] `baw` CLI 安裝（`npm install -g @binance/agentic-wallet`，v1.8.0）
- [x] 服務層 `src/services/bstocks-wallet.ts`（signIn / verify / getStatus，防禦式 parse + UUID 驗證 + timeout）
- [x] API 路由 `/api/bstocks/connect` / `/verify` / `/status`
- [x] UI Connect 按鈕（signin → 顯示 pairingCode + 開 urlForWeb → verify → 顯示地址）
- [x] env allowlist 加 `BINANCE_AW_ADDRESS`

## 9. 已完成（P51-P54）

- [x] `baw` CLI 安裝（v1.8.0）
- [x] 服務層 `bstocks-wallet.ts`（signIn/verify/getStatus/swap/getBalance/saveAddress）
- [x] API 路由 connect/verify/status/balance/swap/prices/cmc-call/agent-studio
- [x] UI Connect 按鈕 + Wallet TVL + bStocks switch 持久化
- [x] 自動存 `BINANCE_AW_ADDRESS` 到 .env
- [x] Wallet TVL（`baw wallet balance`）
- [x] bStocks 自動 swap（BUY→USDT→bStock；SELL→bStock→USDT；下注=TVL×10%）
- [x] bStock 數據源（`bstock-data.ts`：type=3 list + Binance spot price）
- [x] x402 呼叫（`x402-calls.ts`：CMC 4 tools + Agent Studio async）

## 10. binance-tokenized-securities-info skill(有用,已實證)

**來源**: https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-tokenized-securities-info

**實證**:API 5(RWA Dynamic V2)對 bStock(MUB)work——on-chain price 930.97、P/E 22.64、divYield 0.05%、52w 113.46-1255.00、status TRADING。

**6 個 API**(全部 public,冇 key,`User-Agent: binance-web3/1.1 (Skill)`):

| API | 功能 | 對 MATS 嘅價值 |
|---|---|---|
| 1 Token Symbol List | 列出代幣化股票(type=1 Ondo / type=3 bStock) | 已有(P54) |
| 2 RWA Meta | 公司資料 + attestation report | 低 |
| 3 Market Status | 整體市場開/關 | 中 |
| **4 Asset Market Status** | **per-asset 交易狀態 + 企業行動(earnings/dividend/split/merger)** | **高——swap 前風險檢查** |
| **5 RWA Dynamic V2** | **on-chain price + 美股基本面(P/E/divYield/52w)** | **高——on-chain 價 + 基本面** |
| **6 Token K-Line** | **蠟燭圖(on-chain token price)** | **高——bStock 蠟燭** |

**關鍵概念**:`referencePrice = tokenInfo.price ÷ sharesMultiplier`(multiplier 唔係 1,股息累積調整)。

**需要接入**:
1. **API 4(企業行動風險檢查)**——auto-swap 前 check bStock 係咪 paused(earnings/dividend/split),paused 就 skip swap
2. **API 5(on-chain price)**——用 on-chain token price 取代 Binance spot price(更準)
3. **API 6(K-Line)**——用 on-chain 蠟燭取代 Binance spot klines

## 11. 待接（下一步）

- [ ] 接入 API 4(企業行動風險檢查)+ API 5(on-chain price)+ API 6(K-Line)
- [ ] 比賽模式 sizing（激進，同 MATS 穩定模式分開）
- [ ] x402 呼叫嘅 UI 觸發按鈕
