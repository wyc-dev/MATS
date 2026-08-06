# Q-RL Direction Signal — Diagnosis & Decision Memory (v2.0.861)

> 建立:2026-08-06 · 來源:Phase 0 診斷(唯讀)+ SILVER 解剖
> 狀態:**1.1/1.2/1.5 已實作並 commit(v2.0.861, cd58054)+ 對抗硬化(v2.0.861-attack, 023c9ac)**——待主神重啟系統生效
> 驗證:tsc 零錯誤、signal 33/33 + attack 32/32、Q-RL 相關 362/362、全 regression 1925/1937(12 pre-existing)

---

## 核心判斷(信心分層 — 主神已確認記住)

| 主張 | 信心 | 依據 |
|---|---|---|
| sell 喺而家 mean_reverting\|calm 狀態係負期望 | ~85% | median+trim 都負、t=-2.8、三條獨立數據流收斂 |
| 市場正喺旋轉(非 noise) | ~80% | 30d→14d→8d 單調:buy +0.29%→+1.51%,sell -0.08%→-0.92% |
| 折讓 sell 能增加盈利(4 週內) | ~60-65% | ex-post 模擬 +0.21 pnlPct/8d;若轉跌市會錯失全期 sell +7.74 edge |
| buy boost 有幫助 | <50% | buy t=+1.0 未顯著——**唔 boost** |

## 修正後事實(8d 正確數據 — 曾犯 duration-vs-timestamp bug,已修正)

- **重災區係 mean_reverting**:8d sell mean_reverting 29筆 avg **-1.42%**;low_volatility 17筆 avg **-0.07%**(打和)
- **Per-symbol 集中**:SILVER sell avg -3.93%(10筆)、GOLD -3.17%;SKHX 只 -0.37%
- **30d buy edge 都喺 mean_reverting**:buy +0.72% vs sell -0.19% → 2.1pp spread
- **Normal-vol bucket 唔 robust**:`mean_rev|normal` sell median +0.01%(mean 負但 median 正)
- **Skew 檢查**:sell 負期望 robust(median 都負),唔係 outlier 驅動
- **Q-RL oracle**:sell pooled mean -0.82% t=-4.6;buy +0.27% t=+1.0;oracle 方向同現實一致

## SILVER「買上買落都係輸」解剖(2026-08-06)

**價格**:58.17(07-15)→ 62.03(08-05),升 6.6%,期間升市。

**SELL 輸(37筆,46% WR,-0.48 USD / pnlPctSum -35.5%)**:
1. OLR SHORT overconfidence:calibration bins 42筆全喺 [0.8,1.0],實際 20W/22L = **47.6% vs 宣稱 >80%**
2. Meta-Agent 收「OLR EDGE +30~40pp FAVOR SELL」→ 一路升市做空
3. 10x 槓桿 + SL ~0.8% → 任何正常波動掃 SL → margin -8%/筆
4. 08-03→08-05 連續 6 筆 sell 全輸(59.46→62.25 之間做空)
5. Combo:silver sell 41% WR 但 pnlPctSum -44%(mean_rev)/-18%(low_vol)——**WR 唔低,expectancy 重傷**

**BUY 輸(9筆,22% WR,-3.25 USD / -9.5%)**:
1. 08-05 兩筆喺 61.8/62.5 **高位追買**(升勢後段),買完回調 → SL 掃(-8.18%/-8.05%)
2. 唯一大贏 07-29 entry 57.45(+2.90%)——升市早段買先贏
3. buy|mean_reverting combo:20% WR n=5 -2.42

**根因鏈(三層疊加)**:
1. **OLR stale + overconfident**:short 樣本 14831 >> long 3790(SILVER 跌市歷史主導)→ 升市照輸出 short 高 P(win)
2. **時序滯後**:buy 出現喺升市後段追高,sell 出現喺升市全程逆勢——無論買賣都「遲到」
3. **Q-RL 訊號冇接上**:SILVER 正正喺 mean_reverting|calm|flat|neutral bucket,Q-RL 話 sell -2.26%(median -0.93%)/buy +3.96%——但冇流向決策

**SL 裁決**:主神確認 GOLD SL 正確——本座撤回 SL 調校。SILVER 問題係方向+時機,唔係 SL 距離。

## 修正方案(定稿,全部 default OFF 等驗證)

- **Phase 1.5(核心)**:`shadowType:'qrl'` shadow A/B——Q-RL 方向 vs LLM aligned shadow 對賭 2-4 週,causal paired-uplift 顯著正先接 live gate。**零 live 風險**
- **Phase 1.1**:Q-RL expectancy block 注入 Meta-Agent(per-bucket、median+trim 穩健統計、樣本飢餓→中性、標註 source)
- **Phase 1.2**:conviction multiplier——**多條件**(n≥20 AND median<0 AND trim<0 AND Q<-0.2% → ×0.5)、**非對稱**(唔 boost buy)、**per-bucket**(只 robust 負期望 bucket)、floor ×0.5(唔 hard-block)、每 dampening 落 audit trail
- **Phase 2.1**:Regime-Rotation Monitor(30/14/8d buy-vs-sell expectancy spread dashboard + flip 警報)

## 其他記錄

- **OLR realSamples 異常**:SILVER SHORT realSamples=11619 vs 實際 real trades 46——疑似歷史積累(舊版本/清倉前)或 per-cycle 重複 feed,待查
- **tradeHistory 6635 筆 100% 有 regime**,但 portfolio real trades 0/193 有 regime——v2.0.819 pipeline 喺 real 持久化層面斷裂
- **trending_bull 得 6 筆、trending_bear 2 筆、high_vol 15 筆**——99.7% 學習喺 low_vol/mean_reverting
- **tools**:`scripts/qrl-audit.ts`(新)+ `scripts/edge-audit.ts`(擴展 per-regime×side)——唯讀,tsc 零錯誤
- **曾犯錯誤**:`now - h.timestamp < cutoff8`(duration vs absolute)——已修正為 `h.timestamp > now - 8*86400000`;教訓:窗口過濾要用 absolute comparison
- **pre-existing 測試腐敗(v2.0.854-attack2-nan-price.test.ts 12 fail)**:`tracker.getBalance is not a function`——PortfolioTracker API 改名後測試未同步,gittest 確認非 v2.0.861 造成,待修
- **v2.0.861-attack(023c9ac)**:10 個攻擊向量中 7 個真漏洞已修——V1 update reward clamp ±1、V1b load values clamp ±1、V2 load rewardHistory cap 30、V3 parseNumEnv trim、V5 multiplier cfg NaN guard(CRITICAL——NaN 令 gate 全 pass)、V7 drainRecentResults source routing(statistical/qrl 全 weight)、V10 minSamples floor guard。已安全:V4/V6/V8/V9(測試證明)
- **運行注意**:main process `tsx src/index.ts`(PID 18635,非 watch)行緊舊 code;另有 `tsx watch src/index.ts`(PID 42572)——疑似兩個 instance,待查
- **生效**:重啟後 1.1/1.2 接入(default true,flag 可關),1.5 shadow A/B 開始累積 uplift 數據(2-4 週後 `causal-reasoner` 睇 qrl uplift)
