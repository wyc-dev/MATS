# 🎬 MATS Demo Video — AI Generation Guide

> **用途**:BUIDL_QUESTS 2026 Hackathon Demo Video
> **風格**:電視廣告(爭分奪秒)——1:42 總時長
> **製作方式**:AI Video Generation(每個 Scene 一個 Prompt)+ 實際介面 Cap Screen(Scene 3)
> **語言**:英文旁白(國際 hackathon)——中文字幕

---

## 製作流程

```
1. 用「Runway 專用 Prompt」生成每個 Scene 嘅畫面(除 Scene 3——用實際 Cap Screen)
2. Scene 3(產品展示)——用 MATS 實際介面 Cap Screen(實時 PnL/33 層/5 代理)
3. 剪接:按時間軸組合——加旁白(VO)+ 音樂
4. 輸出:1:42 總時長——1080p——16:9
```

---

## 🎬 Runway 專用 Prompt(直接複製貼上)

> 平台:runwayml.com——模型:Gen-4——時長:5 秒/段——比例:16:9——風格:cinematic
> 負面提示(每段加):blurry, deformed, extra limbs, watermark, text artifacts

### Scene 1(0:00-0:06)——3 段

```
SHOT 1(血眼):
Extreme close-up of bloodshot human eyes reflected in a dark computer monitor, red candlestick charts glowing on screen, moody low-key lighting, shallow depth of field, cinematic film grain, dark commercial aesthetic

SHOT 2(3AM):
A clock showing 3:00 AM in a dark room, cold coffee cup, red trading candles on a dark monitor in background, desaturated cold blue tones, cinematic, film grain

SHOT 3(小朋友畫):
A child's crayon drawing on a desk reading 'Dad come play', warm light from window, shallow focus, emotional contrast against dark room, cinematic
```

### Scene 2(0:06-0:16)——5 段

```
SHOT 4(爆倉):
Red liquidation alert on phone screen, human hands covering face, dark room, dramatic lighting, cinematic, film grain

SHOT 5(FOMO):
Green candle turning red on trading chart, shocked trader expression, fast zoom, high contrast, cinematic

SHOT 6(跟單):
Phone screen showing 'Follow this signal' with PnL screenshot, skeptical eyes, cold blue lighting, cinematic

SHOT 7(家庭晚餐):
Family dinner table, man staring at phone instead of family, wife and child looking at him, warm melancholic lighting, shallow depth, cinematic

SHOT 8(空帳戶):
Empty trading account balance on screen, empty stare, dark background, single spotlight on face, cinematic
```

### Scene 4(1:16-1:28)——3 段

```
SHOT 14(每日 PnL):
Clean data visualization of daily P&L report, every trade listed, wins in green losses in red, minimal design, white text on black, Apple keynote aesthetic, smooth motion graphics

SHOT 15(回測數據):
Animated bar chart comparison, 'Bad entries 27% win rate' vs 'Good entries 82% win rate', precise motion graphics, white on black, Apple keynote aesthetic

SHOT 16(代碼統計):
Numbers counting up on black background, '63000 lines 2280 tests 33 layers', clean typography, subtle glow, Apple keynote aesthetic
```

### Scene 5(1:28-1:38)——3 段

```
SHOT 17(父親陪小朋友):
Father playing with child, no phone in sight, genuine laughter, golden hour sunlight, shallow depth of field, slow motion, warm cinematic

SHOT 18(父母晚餐):
Elderly couple sharing a meal, warm light, no urgency, peaceful atmosphere, soft focus, warm cinematic

SHOT 19(海邊日落):
Sunset over ocean, person standing present and free, silhouette against golden sky, wide shot, serene, warm cinematic
```

### Scene 6(1:38-1:42)——1 段

```
SHOT 20(MATS logo):
MATS logo on black background, white logo with subtle violet glow, clean typography, logo animates in with soft pulse, URL 'mats.trading' appears below, Apple keynote ending, premium
```

---

## 🎬 SCENE 1 — THE HOOK(0:00-0:06)——6 秒

### AI Video Prompt

```
Cinematic dark commercial opening, 6 seconds, 24fps, 16:9.

Three rapid cuts (1.5s each):
1. Extreme close-up of bloodshot human eyes reflected in a dark computer monitor, 
   faint red candlestick charts glowing on the screen, moody low-key lighting, 
   shallow depth of field, film grain.
2. A clock showing 3:00 AM, cold coffee cup, red trading candles on a dark 
   monitor in the background, desaturated cold blue tones, cinematic.
3. A child's crayon drawing on a desk reading "Dad, come play", warm light 
   from a window, shallow focus, emotional contrast against the dark room.

Style: Apple product film aesthetic, dark and intimate, high contrast, 
cinematic color grading (cold blue shadows, warm highlights), film grain, 
no text overlay. Sound: single heartbeat at start, then silence.
```

### 旁白(VO)

```
"Your time. Your dreams.
What if your money worked — so you didn't have to?"
```

---

## 🎬 SCENE 2 — THE PAIN(0:06-0:16)——10 秒

### AI Video Prompt

```
Fast-paced commercial montage, 10 seconds, 24fps, 16:9.

Five rapid cuts (2s each), harsh staccato editing:
1. Red liquidation alert notification on a phone, human hands covering face, 
   dark room, dramatic lighting.
2. FOMO buy at the top — green candle turns red, trader's shocked expression, 
   fast zoom, high contrast.
3. A phone screen showing "Follow this signal" with a stranger's PnL screenshot, 
   skeptical eyes, cold blue lighting.
4. Family dinner table — a man staring at his phone instead of his family, 
   wife and child looking at him, warm but melancholic lighting, shallow depth.
5. Empty trading account balance, empty stare, dark background, single 
   spotlight on the face, cinematic.

Style: gritty realistic commercial, fast cuts, desaturated colors with 
selective red accents, film grain, handheld camera shake for tension. 
Sound: harsh digital glitches, phone notification sounds, rising tension.
```

### 旁白(VO)

```
"Watching. Chasing. Following.
Trading isn't supposed to feel like this."
```

---

## 🎬 SCENE 3 — THE PRODUCT(0:16-1:16)——60 秒(用實際 Cap Screen)

### 製作方式

```
⚠️ 呢個 Scene 用「MATS 實際介面 Cap Screen」——唔係 AI 生成:
  1. MATS Dashboard(33 層 pipeline 動畫)
  2. 5 個代理辯論介面(Fractal/On-Chain/OLR/News/Risk)
  3. LLM 世界模型層(圖表 + 新聞分析)
  4. 自我演化(Q-RL/Shadow trade)
  5. 實盤帳戶(Hyperliquid——實時 PnL)
```

### Cap Screen 拍攝指引

```
SHOT 9(0:16-0:28)——12 秒:
  拍攝:MATS Dashboard 全屏——33 層 pipeline 動畫(由下而上)
  動作:慢鏡頭推近——highlight 每一層
  旁白:"This is MATS. Not a bot. A brain that evolves."

SHOT 10(0:28-0:40)——12 秒:
  拍攝:5 個代理介面——辯論過程(thoughts 滾動)
  動作:每個代理 highlight 一次——最後 consensus 顯示
  旁白:"Five AI agents debate — before every trade..."

SHOT 11(0:40-0:52)——12 秒:
  拍攝:LLM 世界模型層——圖表 + 新聞分析(實時)
  動作:highlight LLM 讀圖——新聞標題浮現
  旁白:"An LLM world-model. It understands the world..."

SHOT 12(0:52-1:04)——12 秒:
  拍攝:Q-RL/Shadow trade 介面——學習過程
  動作:highlight 演化——蝕錢 fade——賺錢 glow
  旁白:"It evolves. Every trade teaches it..."

SHOT 13(1:04-1:16)——12 秒:
  拍攝:實盤帳戶(Hyperliquid)——實時 PnL
  動作:highlight 實時 PnL——balance 跳動
  旁白:"Live on Hyperliquid. Real money. Not a simulation."
```

### 背景音樂

```
低頻 pulse 漸強(科技感)——每 SHOT 一個 beat——最後 SHOT 13 到達高潮
```

---

## 🎬 SCENE 4 — THE PROOF(1:16-1:28)——12 秒

### AI Video Prompt

```
Clean data-driven commercial segment, 12 seconds, 24fps, 16:9.

Three precise cuts (4s each), white text on black background:
1. Daily P&L report interface — every trade listed — wins in green, losses 
   in red — clean typography, minimal design, data visualization.
2. Backtest data visualization — "Bad entries: 27% win rate" vs 
   "Good entries: 82% win rate" — animated bar chart comparison, 
   precise motion graphics, white on black.
3. Code statistics — "63,000 lines. 2,280 tests. 33 layers." — 
   numbers counting up, clean typography, subtle glow.

Style: Apple keynote aesthetic, minimal, precise, white text on black, 
smooth motion graphics, no clutter. Sound: subtle data ticks, 
soft electronic pulse.
```

### 旁白(VO)

```
"Every trade — published. Wins. Losses.
Transparency is trust.

We don't claim. We prove.
The system learned when to enter — and when to walk away.

63,000 lines. 2,280 tests. Production-grade."
```

---

## 🎬 SCENE 5 — THE PAYOFF(1:28-1:38)——10 秒

### AI Video Prompt

```
Warm emotional commercial ending, 10 seconds, 24fps, 16:9.

Three slow-motion shots (3.3s each), warm golden light:
1. A father playing with his child — no phone in sight — genuine laughter, 
   golden hour sunlight, shallow depth of field, cinematic slow motion.
2. An elderly couple sharing a meal — warm light, no urgency, peaceful 
   atmosphere, soft focus.
3. Sunset over the ocean — a person standing, present, free — silhouette 
   against golden sky, wide shot, serene.

Style: emotional commercial, warm color grading (golden/amber), slow motion, 
soft focus, film grain, no text. Sound: warm ambient music resolving, 
gentle strings, soft piano.
```

### 旁白(VO)

```
"MATS doesn't just make money.
It buys back your time. Your family. Your freedom."
```

---

## 🎬 SCENE 6 — THE CALL(1:38-1:42)——4 秒

### AI Video Prompt

```
Bold brand ending, 4 seconds, 24fps, 16:9.

MATS logo appears on black background — white logo with subtle violet glow, 
clean typography, logo animates in with a soft pulse, then URL "mats.trading" 
appears below. Minimal, premium, confident.

Style: Apple keynote ending, black background, white logo, subtle glow, 
clean. Sound: final warm chord resolving, soft fade.
```

### 旁白(VO)

```
"Let trading work for you. MATS."
```

---

## 📋 製作 Checklist

```
1. Scene 1-2:AI Video Generation(用 Prompt)
2. Scene 3:MATS 實際介面 Cap Screen(5 個 SHOT——每 12 秒)
3. Scene 4-6:AI Video Generation(用 Prompt)
4. 旁白:英文 VO(低沉自信——每句 ≤ 8 字)
5. 音樂:開頭心跳 → 痛點刺耳 → 產品 pulse → 願景溫暖 → CTA 收尾
6. 字幕:中文字幕(國際 hackathon——英文旁白 + 中文字幕)
7. 輸出:1:42 總時長——1080p——16:9
```

---

## 🎯 時間軸總覽

```
0:00-0:06  Scene 1 Hook(慾望——時間/夢想)
0:06-0:16  Scene 2 痛點(盯盤/情緒/跟單)
0:16-1:16  Scene 3 產品(33 層/5 代理/LLM/演化/實盤——Cap Screen)
1:16-1:28  Scene 4 證明(透明度/回測/代碼)
1:28-1:38  Scene 5 願景(家人/時間/自由)
1:38-1:42  Scene 6 CTA(MATS)
```
