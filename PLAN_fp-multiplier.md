# FIX PLAN — FP Multiplier 入 Conviction Gate（詳盡版）

**北極星**: 令 FP shrink/P cap 有硬 teeth——FP「100% 必勝」幻覺唔可以再推高開倉 confidence（不靠 LLM 自覺），同時防禦逆勢開倉。**驗證通過先落 production code。**

---

## 1. 驗證結果（220 筆 realTrades）

| 驗證項 | 結果 | 意義 |
|---|---|---|
| FP edge 預測力 | edge>0 trade WR 47% ≈ 全場 48.5% | **FP 正 edge 無獨立預測力——唔應該 boost** |
| thesis FP 可靠性 | BUY 寫 LONG 100%、SELL 寫 SHORT 100% | **thesis 只寫有利方向（雙向幻覺）——歷史反事實不可靠** |
| breakeven 不對稱 | LONG be 29% vs SHORT be 71% | SELL 容易被「edge vs breakeven」誤壓——設計必須方向對應 |

**誠實限制**：歷史 trade 嘅 thesis FP 係「雙向 100% 幻覺」+ 冇開倉時 price history 重算 shrink 後 FP → **無法直接反事實「shrink 後會攔截邊啲 trade」**。成效靠：
1. **結構性正確**（邏輯推導——FP 唔再可推高 confidence）
2. **live 監察**（每次 apply 有 log + Gate Outcome Tracker）

---

## 2. 設計（quant 思維——數據驅動）

### 純函數 `fpEdgeMultiplier(edge)`（`first-passage.ts`）

```typescript
export function fpEdgeMultiplier(edge: number): number {
  if (!Number.isFinite(edge)) return 1.0;      // 垃圾/冷啟動 → 中性
  if (edge >= 0) return 1.0;                    // 正 edge → 中性（FP 無預測力,唔 boost——shrink 嘅 teeth）
  return 1 + 0.5 * Math.max(-0.4, edge);       // 負 edge → 壓制（×0.8@-0.4, ×0.7@-0.6）
}
```

- **正 edge（shrink 後常見）→ ×1.0 中性**——以前「FP +71pp → LLM boost」，而家**硬性唔 boost**（唔靠 LLM 自覺）
- **負 edge（FP 明確逆持倉方向）→ 壓制**——防逆勢開倉
- **方向對應**：開 BUY 用 `longPWin − breakevenPLong`；開 SELL 用 `shortPWin − breakevenPShort`

### 接駁（`index.ts` conviction gate 堆疊）

```
effectiveConfidence = calibratedConsensus × OLR-P(win) × ... × FP-multiplier × penaltyFactor
```

- active symbol 用 `lastFirstPassage`（已有）+ 開倉方向對應 side 計 edge
- env `FP_GATE_MULTIPLIER=false` 回滾
- 每次 apply log：`[fp-gate] BUY xyz:edge=+36pp → ×1.0 (中性)` / `[fp-gate] SELL edge=-41pp → ×0.79 (壓制)`

### 成效（邏輯推導）

| 場景 | 以前 | 之後 |
|---|---|---|
| FP 100% edge +71pp（幻覺） | LLM 文字 boost（靠 LLM 自覺） | **×1.0 硬性中性** |
| FP 65% edge +36pp（shrink 後） | LLM 文字 | ×1.0 中性（正確——FP 無預測力） |
| FP 30% edge -41pp（SHORT 弱） | LLM 文字 | **×0.79 硬壓制**（防逆勢） |

---

## 3. 實施步驟

| Step | 文件 | 改動 |
|---|---|---|
| 1 | `first-passage.ts` | `fpEdgeMultiplier()` 純函數 |
| 2 | `index.ts` | conviction gate 堆疊加 FP multiplier（方向對應 + env flag + log） |
| 3 | 測試 | `fp-edge-multiplier.test.ts`（純函數 + gate 堆疊 + 方向對應 + 毒輸入） |
| 4 | 攻擊輪 | edge NaN/1e308/方向錯位/冷啟動/併發 |
| 5 | 文檔 | CHANGELOG + ARCHITECTURE + AGENT_PROMPT |

## 4. 驗證門

- [ ] `fpEdgeMultiplier` 純函數測試（正 edge 1.0 / 負 edge 壓制 / NaN 1.0 / -0.4 clamp）
- [ ] gate 堆疊測試（BUY 用 LONG edge、SELL 用 SHORT edge——方向錯位防禦）
- [ ] 攻擊輪全綠
- [ ] 全量零 regress + tsc clean
- [ ] live 監察：每次 apply log + Gate Outcome Tracker 數據

## 5. 風險與回滾

| 風險 | 緩解 |
|---|---|
| FP SHORT edge 負 → 壓制 SELL（加重單邊） | 方向對應 + shrink 後 SHORT edge 收窄（-71pp → -41pp,壓制 ×0.65 → ×0.79 溫和）;真 SELL edge（bear 市場）唔壓制 |
| FP 冷啟動/垃圾 → 亂乘 | NaN/無數據 → ×1.0 中性 |
| 歷史無法反事實 | 結構性正確 + live log/監察 |

**回滾**：`FP_GATE_MULTIPLIER=false` 即刻還原。
