# MATS P76 攻擊輪修正方案

> 日期: 2026-08-19
> 攻擊範圍: P73(bStocks 同步)+P75(持久化)+P72(三窗)
> 發現: 3 攻 3 中,全部修復

---

## 攻擊結果

| # | 攻擊 | 結果 | 修復 |
|---|------|:--:|------|
| **W1** | **loadBStockTrades 持久化污染**——buyPrice 係 string/NaN/Infinity/負數直接入 Map | **命中** | `sanitizeBStockTrades()` 純函數逐欄 sanitize |
| W2 | saveBStockTrades 非 atomic write | 低風險(load 有 try/catch+sanitize) | 接受 |
| **W3** | **recordBStockTrade 冇驗證 price**——NaN/Infinity 會污染顯示 | **命中** | sanitize 邏輯(同 W1) |
| **W4** | **syncBStockPositions 併發**——同 maybeSwapBStock 同時 swap 同一 symbol | **命中** | `bStockSwapInFlight` guard |
| W5 | getHLForBStockSymbolSync 垃圾 symbol | 釘(返回 null) | — |

---

## 漏洞細節

### W1: loadBStockTrades 持久化污染

**問題**: `loadBStockTrades` 直接 `JSON.parse` + `new Map(Object.entries(obj))`,冇 sanitize。如果 JSON 入面 buyPrice 係 string("163.83")/NaN/Infinity/負數,會直接入 Map,污染 Trade Incident 顯示。

**修復**: 抽 `sanitizeBStockTrades()` 純函數——逐欄 sanitize:
- bStockSymbol 必須非空 string
- buyPrice/sellPrice 必須 finite 正數,否則 null
- `__proto__`/`constructor`/`prototype` key skip(原型污染防護)

### W4: syncBStockPositions 併發

**問題**: `syncBStockPositions` 每 cycle 尾 call,直接 `this.bStocksWallet.swap()`,冇經 `bStockSwapInFlight` guard。如果同一個 cycle 入面 closeTrade 觸發 maybeSwapBStock('sell') 未完成,sync 又見到 bStock 仲有 → 重複 swap。

**修復**: sync 入面加 `bStockSwapInFlight` guard(finally 釋放)。

---

## 驗證

- 14 攻擊測試全綠
- blast-radius 53 綠
- tsc clean
