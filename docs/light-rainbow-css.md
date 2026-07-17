# Light Rainbow Gradient — CSS Reference

> 淺色彩虹漸變效果，用於 MATS UI 的標題、邊框、按鈕等裝飾性元素。
> 顏色：粉紅 → 橙 → 黃 → 綠 → 藍 → 紫 → 粉紅

---

## 漸變色定義

```css
/* 7 色淺色彩虹漸變 */
linear-gradient(90deg,
  #ffb3cf,  /* 粉紅 */
  #ffd9b3,  /* 橙 */
  #fff0b3,  /* 黃 */
  #b3ffcc,  /* 綠 */
  #b3e0ff,  /* 藍 */
  #d4b3ff,  /* 紫 */
  #ffb3cf   /* 粉紅 */
)
```

---

## 動畫

```css
@keyframes rgb-text-shimmer {
  0% { background-position: 0% 0; }
  100% { background-position: 200% 0; }
}
```

`background-size: 200% 100%` + `background-position` 動畫 → 漸變色橫向流動。

---

## 應用模式

### 1. 文字漸變（panel-title）

用於 panel header 標題文字。

```css
.panel-title {
  background: linear-gradient(90deg, #ffb3cf, #ffd9b3, #fff0b3, #b3ffcc, #b3e0ff, #d4b3ff, #ffb3cf);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: rgb-text-shimmer 4s linear infinite;
}
```

### 2. 邊框漸變（header icon buttons）

用於 header 右側三粒圓形 icon button（settings / pause / shutdown）。

```css
.header-btn.icon-btn {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 2px solid transparent;
  position: relative;
  background: transparent;
  color: #fff; /* icon 預設白色 */
}

/* ::before pseudo-element 做漸變邊框 */
.header-btn.icon-btn::before {
  content: '';
  position: absolute;
  inset: -2px;               /* 向外延伸 2px = border 厚度 */
  border-radius: 50%;
  padding: 2px;
  background: linear-gradient(90deg, #ffb3cf, #ffd9b3, #fff0b3, #b3ffcc, #b3e0ff, #d4b3ff, #ffb3cf);
  background-size: 200% 100%;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: rgb-text-shimmer 4s linear infinite;
  pointer-events: none;
}

.header-btn.icon-btn:hover {
  color: #fff0b3;
  box-shadow: 0 0 var(--space-8) rgba(255, 179, 207, 0.3);
}
```

**原理**：`::before` 用 CSS mask 技巧 — `content-box` 區域透明（中間鏤空），`padding-box` 區域顯示漸變色，形成只有 border 有顏色的效果。

### 3. 邊框漸變（agent thinking state）

用於 HACP Consciousness 中 agent 正在思考時的卡片邊框。

```css
.agent-card.agent-thinking {
  border: 2px solid transparent;
  position: relative;
}

.agent-card.agent-thinking::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: var(--radius-lg);
  padding: 2px;
  background: linear-gradient(90deg, #ffb3cf, #ffd9b3, #fff0b3, #b3ffcc, #b3e0ff, #d4b3ff, #ffb3cf);
  background-size: 200% 100%;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: rgb-text-shimmer 4s linear infinite;
  pointer-events: none;
  box-shadow: 0 0 var(--space-12) rgba(255, 255, 255, 0.15);
}
```

### 4. 白色呼吸動畫（thinking dot + glow）

用於 agent thinking 時的白色圓點呼吸效果，以及白色 drop shadow 呼吸。

```css
@keyframes white-breathe {
  0%, 100% { box-shadow: 0 0 var(--space-6) rgba(255, 255, 255, 0.1); }
  50% { box-shadow: 0 0 var(--space-12) rgba(255, 255, 255, 0.25); }
}

/* agent 左側圓點 thinking 時變白 + 呼吸 */
.agent-card.agent-thinking .agent-dot {
  opacity: 1;
  background: #fff !important;
  animation: white-breathe 1.5s ease-in-out infinite;
}
```

### 5. SVG inline gradient（brand logo）

用於 header 左上角 logo。

```html
<svg viewBox="0 0 1000 333" class="brand-logo">
  <defs>
    <linearGradient id="brandGradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffb3cf" />
      <stop offset="16%" stop-color="#ffd9b3" />
      <stop offset="33%" stop-color="#fff0b3" />
      <stop offset="50%" stop-color="#b3ffcc" />
      <stop offset="66%" stop-color="#b3e0ff" />
      <stop offset="83%" stop-color="#d4b3ff" />
      <stop offset="100%" stop-color="#ffb3cf" />
    </linearGradient>
  </defs>
  <path d="..." fill="url(#brandGradient)" />
</svg>
```

```css
.brand-logo {
  height: 54px;
  width: auto;
  flex-shrink: 0;
}
```

---

## 使用場景總結

| 元素 | 模式 | 動畫 |
|:-----|:-----|:-----|
| Panel title 文字 | `background-clip: text` | `rgb-text-shimmer` 4s |
| Header icon buttons border | `::before` + CSS mask | `rgb-text-shimmer` 4s |
| Agent thinking card border | `::before` + CSS mask | `rgb-text-shimmer` 4s |
| Agent thinking dot | `background: #fff` + `box-shadow` | `white-breathe` 1.5s |
| Brand logo SVG | `<linearGradient>` inline | 無（靜態） |
