# FIX PLAN — HACP Close Gate 層級化整合（詳盡版 v2）

**作者**: Yuki · **狀態**: 驗證完成，待主神批准實施
**北極星**: 將 close 層 7 個 Gate 整合成「deterministic 先行 → LLM 最後」層級化流水線，
每 consensus close 嘅 LLM call 由 2 個降到最多 1 個，**pre-filter 唔亂 hold、Skeptics 否決權保留、
止蝕永遠唔可以被 LLM 掛住**。

---

## 1. 目標 / 非目標

**目標**：
- close 決策由「2 LLM call 並行」改為「層級化：0-1 LLM call」
- trend-hold gate 升級為 sentinel 嘅零算力 pre-filter（唔刪除）
- Skeptics 絕對否決權保留，只延遲到 sentinel 話 CLOSE 後
- 止蝕安全不變式：SL hit / 虧損 / LLM 失敗 → 永遠 close

**非目標**（避免 scope 蔓延）：
- 唔改 entry gate 堆疊（30+ gate 另一層面）
- 唔改 Skeptics validateCloseDecision 內部邏輯（只改 call 時機）
- 唔改 reversal-point / MFE lock（deterministic 層保留原樣）

---

## 2. 現狀（已 audit）

per-symbol consensus close 路徑 7 個 Gate：
| Gate | 類型 | 算力 | 現狀順序 |
|---|---|---|---|
| SL hit | det | 0 | 永遠 close |
| Skeptics validateCloseDecision | **LLM** | 高 | thesis-backed close 全部 call |
| MFE lock | det | 0 | 鎖利 close |
| Fractal Momentum Sentinel | **LLM** | 高 | 趨勢持續性 HOLD/CLOSE |
| Close-Calibrator hold | det | 0 | 過早率 hold |
| Trend-Hold | det | 0 | 4h/1h soft hold |
| Reversal-point | det | 0 | MAE/MFE 離場 |

**問題**：Skeptics + Sentinel 並行 = 2 LLM call/close；3 個 hold 機制重疊。

---

## 3. 目標架構（層級化流水線）

```
consensus close（盈利倉）:
 1. SL hit                     → CLOSE     (0 LLM, market 確認, 永遠)
 2. 虧損倉                     → CLOSE     (0 LLM, 止血優先)
 3. MFE lock / reversal-point  → CLOSE     (0 LLM, 鎖利/結構)
 4. Pre-filter（trend-hold 升級, 4h+1h 雙窗）:
    - 雙窗同向支持持倉方向      → HOLD      (0 LLM, pending-close 3 cycle 兜底)
    - 雙窗同向逆轉              → CLOSE     (0 LLM)
    - 中性/矛盾/垃圾輸入         → ↓ 5
 5. Sentinel LLM 最後裁決（唯一 LLM call）:
    - HOLD（暫時回撤,順向機會大）  → hold（pending-close）
    - CLOSE（短期已轉趨勢）        → ↓ 6
    - UNCERTAIN / LLM 掛 / 超時 8s → CLOSE（照 consensus, 安全 fallback）
 6. Skeptics 驗證（保留絕對否決權）→ CLOSE
```

---

## 4. 驗證結果（已完成）

| 驗證項 | 數據 | 結論 |
|---|---|---|
| pre-filter 決定率 | trend 明確（bull/bear）只佔盈利 close 12.5%（13/104） | pre-filter 決定率有限,但係結構性 0 LLM |
| pre-filter hold 正價值 | trend 支持時 close 後 re-entry：贏 +$6.35 vs 蝕 -$1.69（n=12） | **淨 +$4.66——唔亂 hold**（細樣本, live 續驗） |
| 中性比例 | 87.5% close 喺 trend 中性 | sentinel 主戰場——LLM 判斷價值所在 |
| LLM call 節省 | 2.0 → ~1.4 call/close（trend 明確時 0 call） | 慳 ~30% + trend 明確場景 0 |
| Skeptics 延遲損失 | block 功能保留,只延遲——零損失（sentinel HOLD 時連 Skeptics 都唔使 call） | 無 |

---

## 5. 行為矩陣（12 場景——實施後必須全綠）

| # | 場景 | 期望 |
|---|---|---|
| 1 | SL hit（price ≤ SL） | CLOSE（永遠, 唔 call LLM） |
| 2 | 虧損倉 consensus close | CLOSE（止血, 唔 call LLM） |
| 3 | MFE lock 觸發 | CLOSE（鎖利, 唔 call LLM） |
| 4 | trend 雙窗明確支持 + 盈利 | HOLD（0 LLM, pending-close） |
| 5 | trend 雙窗明確逆轉 + 盈利 | CLOSE（0 LLM） |
| 6 | trend 中性 + sentinel HOLD(conf≥0.55) | HOLD（pending-close） |
| 7 | trend 中性 + sentinel CLOSE | CLOSE（→ Skeptics 驗證） |
| 8 | trend 中性 + sentinel UNCERTAIN | CLOSE（照 consensus） |
| 9 | trend 中性 + LLM 掛/超時 | CLOSE（安全 fallback） |
| 10 | trend 中性 + sentinel HOLD(conf<0.55) | CLOSE（軟 gate） |
| 11 | Skeptics block（sentinel CLOSE 後） | 唔 close（否決權保留） |
| 12 | pending-close 3 cycle 超時 | 兜底 CLOSE（唔死揸） |

---

## 6. 實施步驟

| Step | 文件 | 改動 |
|---|---|---|
| 1 | `trend-hold-gate.ts` | 新增 `prefilterTrend()` 純函數（三態 verdict, 垃圾輸入→neutral）——向後兼容保留 shouldHoldForTrend |
| 2 | `close-trend-sentinel.ts` | verdict 格式 HOLD/CLOSE/UNCERTAIN（**已完成** ✅） |
| 3 | `index.ts` | close 路徑重構為層級化流水線（pre-filter → sentinel → Skeptics 延遲） |
| 4 | `index.ts` | sentinel HOLD → registerPendingClose（已有）+ Gate Outcome Tracker（已有） |
| 5 | 測試 | `prefilter-trend.test.ts` + 行為矩陣 12 場景測試 |
| 6 | 攻擊輪 | 垃圾 momentum/1e308/NaN/side 異常/重入 |
| 7 | 文檔 | CHANGELOG + ARCHITECTURE 更新 |

**Env flags 回滾**：`CLOSE_TREND_SENTINEL`（關 sentinel）/ `CLOSE_PREFILTER`（關 pre-filter，退回舊 behavior）

---

## 7. 驗證門（全部通過先算完成）

- [ ] 行為矩陣 12/12 綠（新測試）
- [ ] prefilterTrend 攻擊輪（垃圾輸入）全綠
- [ ] 現有 trend-hold / sentinel / close-calibrator 測試零 regress
- [ ] 全量測試（3306+）零新增失敗
- [ ] tsc 零錯誤
- [ ] Gate Outcome Tracker 記錄 pre-filter + sentinel 攔截（live 數據驅動校準）

---

## 8. 風險與回滾

| 風險 | 緩解 |
|---|---|
| pre-filter 雙窗逆轉誤判 → 提前 close 大趨勢倉 | 雙窗確認（4h+1h 同向先算數）+ Gate Outcome Tracker 量度 hit rate |
| sentinel 判斷慢（8s）拖慢 close 路徑 | timeout 8s + 唔 block（UNCERTAIN → close）；close 路徑本身非高頻 |
| 樣本細（n=12 pre-filter hold 驗證） | live Gate Outcome Tracker 持續累積，hit rate < 50% 可調 threshold/關閉 |
| Skeptics 延遲令 block 時機後移 | block 功能不變（sentinel CLOSE 後照 block）；sentinel HOLD 本身已係「唔 close」 |

**回滾**：`CLOSE_TREND_SENTINEL=false` / `CLOSE_PREFILTER=false` 即時還原舊 close 路徑。
