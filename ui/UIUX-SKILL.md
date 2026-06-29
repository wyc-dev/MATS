# MATS Finance UI/UX Design System

> **Liquid Glass · Navy Gold · Precision Trading**
> 為 MATS Multi-Agent Trading System 而生的統一 UI/UX 設計規範

---

## 📐 核心設計哲學

```
┌─────────────────────────────────────────────┐
│  MATS Design Principles                      │
│                                              │
│  1. 資訊密度優先 — 交易者需要一目十行        │
│  2. 即時性可感知 — 每個狀態變化都有視覺回饋  │
│  3. 風險視覺化 — 數字不只是數字，是警告      │
│  4. 一致性強制 — 沒有例外，只有設計 token   │
│  5. 玻璃質感統一 — 所有表面共享同一材質語言  │
└─────────────────────────────────────────────┘
```

---

## 🎨 1. Design Tokens（設計權杖）

### 1.1 色彩語義系統

所有顏色**必須**使用 CSS 變數，禁止 raw hex/rgb。

```css
:root {
  /* ── 表面層級 ── */
  --surface-deepest: #060b16;       /* body 背景 */
  --surface-primary: #080c18;       /* 主要面板背景 */
  --surface-elevated: rgba(255,255,255,0.015);  /* 卡片內嵌 */
  --surface-glass: rgba(255,255,255,0.025);      /* 玻璃面板 */
  --surface-glass-hover: rgba(255,255,255,0.04);

  /* ── 玻璃效果 ── */
  --glass-bg: rgba(255,255,255,0.02);
  --glass-bg-hover: rgba(255,255,255,0.04);
  --glass-bg-active: rgba(255,255,255,0.06);
  --glass-border: rgba(255,255,255,0.05);
  --glass-border-hover: rgba(255,255,255,0.08);
  --glass-border-active: rgba(255,255,255,0.12);
  --glass-blur: blur(16px);
  --glass-blur-strong: blur(24px);

  /* ── 文字層級 ── */
  --text-primary: #eef1f8;
  --text-secondary: #a8b0c4;
  --text-tertiary: #6b7488;
  --text-muted: #454d5e;

  /* ── 語義色（禁止直接使用色名） ── */
  --accent: #F5A623;               /* 金色強調 */
  --accent-bg: rgba(245,166,35,0.12);
  --accent-glow: rgba(245,166,35,0.15);

  --green: #34d399;                /* 正向 */
  --green-bg: rgba(52,211,153,0.12);
  --red: #f87171;                  /* 負向 */
  --red-bg: rgba(248,113,113,0.12);

  /* ── 代理身份色（僅用於 agent dot/conf bar） ── */
  --agent-1: #7c8a9e;
  --agent-2: #8a9bb0;
  --agent-3: #9aabb8;
  --agent-4: #6b7a8e;
  --agent-5: #F5A623;
}
```

**色彩使用規則**：

| Token | 使用場景 | 禁止場景 |
|-------|---------|---------|
| `--green` | PnL 正數、買入標籤、連線正常 | 任何非金融語義的裝飾 |
| `--red` | PnL 負數、賣出標籤、斷線、Veto | 按鈕 hover、一般警告 |
| `--accent` | Logo、Hold 標籤、重點強調 | 大面積背景、正文 |
| `--text-tertiary` | 標籤、輔助文字、panel-title | 主要數據展示 |
| `--text-muted` | 佔位文字、分割線、次要邊框 | 任何需可讀的內容 |

---

### 1.2 字體階梯（Type Scale）

**強制使用 8 級階梯**，禁止使用階梯外的 font-size：

```css
:root {
  --fs-micro:   0.55rem;  /* 10px — 標籤、tag、極小輔助 */
  --fs-xs:      0.6rem;   /* 11px — 輔助數據、時間戳 */
  --fs-sm:      0.65rem;  /* 12px — 次要文字、stat-label */
  --fs-base:    0.7rem;   /* 13px — 正文、panel-title、按鈕 */
  --fs-md:      0.75rem;  /* 14px — 強調正文、agent-thought */
  --fs-lg:      0.85rem;  /* 16px — 子標題、stat-number-sm */
  --fs-xl:      1rem;     /* 19px — 主要數據、section-title */
  --fs-2xl:     1.25rem;  /* 24px — 大數字、brand */
  --fs-3xl:     1.8rem;   /* 34px — hero 數字 */
}
```

**使用對照表**：

| 階梯 | CSS 變數 | 用途 |
|:----:|----------|------|
| micro | `var(--fs-micro)` | 決策標籤、badge、極小 tag |
| xs | `var(--fs-xs)` | 時間戳、投票百分比、輔助數字 |
| sm | `var(--fs-sm)` | stat-label、agent-meta、conf-pct |
| base | `var(--fs-base)` | panel-title、按鈕文字、一般正文 |
| md | `var(--fs-md)` | agent-thought、decision-text、debate-body |
| lg | `var(--fs-lg)` | stat-number-sm、subtitle、section-header |
| xl | `var(--fs-xl)` | 主要 stat-number、portfolio-value |
| 2xl | `var(--fs-2xl)` | brand name、大數字 |
| 3xl | `var(--fs-3xl)` | hero 數字、極端強調 |

**字重規範**：

```css
--fw-normal: 400;
--fw-medium: 500;
--fw-semibold: 600;
--fw-bold: 700;
```

| 元素 | 字重 |
|------|:----:|
| stat-number | `--fw-semibold` |
| panel-title | `--fw-semibold` |
| 按鈕文字 | `--fw-semibold` |
| agent-thought | `--fw-normal` |
| stat-label | `--fw-medium` |
| brand name | `--fw-bold` |

---

### 1.3 間距系統（4px Grid）

**強制使用 4px 基數間距**，所有 margin/padding/gap 必須從以下選取：

```css
:root {
  --space-1:  2px;    /* 微調 */
  --space-2:  4px;    /* 最小間距 */
  --space-3:  6px;    /* 緊湊 gap */
  --space-4:  8px;    /* 標準 gap */
  --space-5:  10px;   /* 元素間距 */
  --space-6:  12px;   /* 區塊內距 */
  --space-7:  14px;   /* 面板內距 */
  --space-8:  16px;   /* 標準 padding */
  --space-9:  18px;   /* 寬鬆 padding */
  --space-10: 20px;   /* 面板 padding */
  --space-12: 24px;   /* 大間距 */
  --space-14: 28px;   /* topbar padding */
  --space-16: 32px;   /* 區塊間距 */
  --space-20: 40px;   /* 大區塊 */
}
```

**使用規則**：

| 場景 | 推薦值 |
|------|:------:|
| panel padding | `var(--space-10)` |
| panel-header margin-bottom | `var(--space-8)` |
| stat-cell padding | `var(--space-7)` |
| stat-cell gap | `var(--space-3)` |
| stat-grid gap | `var(--space-4)` |
| agent-card padding | `var(--space-8)` |
| agent-head gap | `var(--space-4)` |
| 按鈕 padding-x | `var(--space-7)` |
| 按鈕 padding-y | `var(--space-3)` |
| topbar padding-x | `var(--space-14)` |
| 列表項 gap | `var(--space-5)` |
| section 間距 | `var(--space-8)` |

---

### 1.4 圓角系統

```css
:root {
  --radius-sm:  6px;    /* tag、badge、小元件 */
  --radius-md:  10px;   /* stat-cell、按鈕、input */
  --radius-lg:  14px;   /* agent-card、decision-card */
  --radius-xl:  18px;   /* panel 外框 */
  --radius-full: 100px; /* pill、conn-badge */
}
```

**禁止**使用 raw `border-radius` 值（`2px`、`3px`、`4px` 等）。一律使用上述變數。

---

### 1.5 陰影系統

```css
:root {
  --shadow-glass-sm: 0 4px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04);
  --shadow-glass:    0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05);
  --shadow-glow:     0 0 40px var(--accent-glow);
}
```

---

## 🧱 2. 元件設計模式

### 2.1 Panel（面板）

所有區塊容器使用統一的 `.panel` class：

```css
.panel {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-glass-sm);
  padding: var(--space-10);
  transition: border-color var(--transition), background var(--transition);
}
.panel:hover {
  border-color: var(--glass-border-hover);
  background: var(--glass-bg-hover);
}
```

**Panel Header 規範**：

```css
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-8);
}
.panel-title {
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.panel-badge {
  font-size: var(--fs-sm);
  padding: var(--space-1) var(--space-5);
  border-radius: var(--radius-full);
  background: var(--glass-bg-active);
  color: var(--text-tertiary);
  border: 1px solid var(--glass-border);
}
```

---

### 2.2 Stat Cell（數據格）

兩種尺寸：

```css
/* ── 大格（2-column grid 使用） ── */
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-7);
  background: var(--surface-elevated);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
}
.stat-cell .stat-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.stat-cell .stat-number {
  font-family: var(--font-mono);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}
.stat-cell .stat-sub {
  font-family: var(--font-mono);
  font-size: var(--fs-base);
  color: var(--text-tertiary);
}

/* ── 小格（4-column grid 使用） ── */
.stat-cell-sm {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-5);
  background: var(--surface-elevated);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
}
.stat-cell-sm .stat-label {
  font-size: var(--fs-micro);
}
.stat-cell-sm .stat-number {
  font-size: var(--fs-lg);
}
.stat-cell-sm .stat-sub {
  font-size: var(--fs-xs);
}
```

**數字顏色規則**：

```css
.stat-number.positive { color: var(--green); }
.stat-number.negative { color: var(--red); }
.stat-number.neutral  { color: var(--text-primary); }
```

---

### 2.3 Decision Card（決策卡）

```css
.decision-card {
  margin-top: var(--space-7);
  padding: var(--space-8);
  border-radius: var(--radius-lg);
  background: var(--surface-elevated);
  border: 1px solid var(--glass-border);
  border-left: 3px solid var(--text-tertiary);
}
.decision-card.buy  { border-left-color: var(--green); }
.decision-card.sell { border-left-color: var(--red); }
.decision-card.hold { border-left-color: var(--accent); }

.decision-top {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  margin-bottom: var(--space-5);
}
.decision-tag {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
}
.decision-tag.buy  { background: var(--green-bg); color: var(--green); }
.decision-tag.sell { background: var(--red-bg); color: var(--red); }
.decision-tag.hold { background: var(--accent-bg); color: var(--accent); }

.decision-text {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}
```

---

### 2.4 Agent Card（代理卡）

```css
.agent-card {
  padding: var(--space-8);
  border-radius: var(--radius-lg);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  transition: all var(--transition);
}
.agent-card.agent-thinking {
  border-color: var(--accent);
  box-shadow: 0 0 20px var(--accent-glow);
}

.agent-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.agent-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.agent-name {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.agent-state {
  margin-left: auto;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: var(--space-1) var(--space-4);
  border-radius: var(--radius-full);
}
.agent-state.idle     { background: var(--glass-bg); color: var(--text-tertiary); }
.agent-state.thinking { background: var(--accent-bg); color: var(--accent); }
.agent-state.error    { background: var(--red-bg); color: var(--red); }

.agent-meta {
  display: flex;
  gap: var(--space-5);
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  margin-bottom: var(--space-4);
}

.agent-conf-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.conf-track {
  flex: 1;
  height: 4px;
  background: var(--glass-border);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.conf-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.5s ease;
}

.agent-thought {
  font-size: var(--fs-md);
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: var(--space-4);
}

.agent-footer {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  flex-wrap: wrap;
}
.agent-footer-item {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}
```

---

### 2.5 按鈕系統

```css
/* ── Header 按鈕 ── */
.header-btn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-7);
  border-radius: var(--radius-md);
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  transition: all var(--transition);
}
.header-btn:hover {
  background: var(--glass-bg-hover);
  border-color: var(--glass-border-hover);
  color: var(--text-primary);
}

/* ── 語義按鈕變體 ── */
.trigger-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 16px var(--accent-glow);
}
.shutdown-btn:hover {
  border-color: var(--red);
  color: var(--red);
}
.pause-btn.paused {
  border-color: var(--green);
  color: var(--green);
  box-shadow: 0 0 12px rgba(52,211,153,0.15);
}

/* ── 圖示按鈕 ── */
.btn-icon {
  font-size: var(--fs-md);
  line-height: 1;
}
.btn-label {
  white-space: nowrap;
}
@media (max-width: 768px) {
  .btn-label { display: none; }
}
```

---

### 2.6 標籤/Badge 系統

```css
/* ── Conn Badge（連線狀態） ── */
.conn-badge {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-7);
  border-radius: var(--radius-full);
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
}
.conn-badge.live { background: var(--green-bg); color: var(--green); border-color: rgba(52,211,153,0.2); }
.conn-badge.dead { background: var(--red-bg); color: var(--red); border-color: rgba(248,113,113,0.2); }

.conn-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.conn-badge.live .conn-dot { animation: pulse-dot 2s ease-in-out infinite; }

/* ── Cycle Badge ── */
.cycle-badge {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-7);
  border-radius: var(--radius-full);
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid rgba(245,166,35,0.2);
  backdrop-filter: var(--glass-blur);
}
```

---

## 📐 3. 佈局系統

### 3.1 Top Bar

```css
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  padding: 0 var(--space-14);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur-strong);
  border-bottom: 1px solid var(--glass-border);
  box-shadow: var(--shadow-glass);
  position: sticky;
  top: 0;
  z-index: 100;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-10);
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-5);
}
```

### 3.2 Main Grid

```css
.main-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-10);
  flex: 1;
  min-height: 0;
  max-width: 1600px;
  margin: 0 auto;
  width: 100%;
}
@media (max-width: 1200px) {
  .main-grid { grid-template-columns: 1fr; padding: var(--space-6); }
}

.col-left, .col-right {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
  overflow-y: auto;
  min-height: 0;
}
```

### 3.3 Stat Grid

```css
/* 2-column */
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}
/* 4-column compact */
.stat-grid-sm {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: var(--space-3);
}
```

---

## 📊 4. 數據可視化規範

### 4.1 數字格式統一

```typescript
// 強制使用以下格式化函數，禁止 ad-hoc toFixed()

/** 價格：最多 2 位小數，去除多餘零 */
function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

/** 金額：千分位 + 2 位小數 */
function formatUSD(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/** 百分比：1 位小數 + % */
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** PnL：強制顯示 +/- 符號 */
function formatPnL(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}
```

### 4.2 即時數據更新策略

| 場景 | 動畫 | 時長 |
|------|------|:----:|
| 數字變化（價格） | 僅數字 transition，不閃爍背景 | 300ms ease |
| 狀態變化（連線） | dot pulse animation | 2s infinite |
| 進度條（confidence） | width transition | 500ms ease |
| 新 thought 出現 | fade in + slide down | 200ms |
| 決策更新 | 左邊框顏色 transition | 300ms |

### 4.3 空值/載入/錯誤狀態

```typescript
// 所有可能為 null 的數值欄位，UI 顯示 '--' 而非 0
// 禁止：顯示 $0.00 當 balance 尚未載入
// 正確：顯示 '--'

// 載入中：使用 spinner + 文字
// 錯誤：使用紅色 badge + 錯誤訊息
// 空狀態：使用 .empty-state 組件
```

---

## 🧹 5. 現有程式碼重構指引

### 5.1 立即修復：Inline Styles

**App.tsx 中所有 inline style 必須移除**，改為 CSS class：

```tsx
// ❌ 禁止
<span style={{fontSize:'0.6rem', color:'var(--text-tertiary)', marginLeft:8}}>

// ✅ 正確
<span className="agent-symbols">
```

新增對應 CSS class：

```css
.agent-symbols {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-left: var(--space-4);
}
```

### 5.2 字體階梯遷移對照

| 現有 raw 值 | 應改為 |
|:-----------:|:------:|
| `0.55rem` | `var(--fs-micro)` |
| `0.6rem` | `var(--fs-xs)` |
| `0.65rem` | `var(--fs-sm)` |
| `0.68rem` | `var(--fs-sm)` |
| `0.7rem` | `var(--fs-base)` |
| `0.75rem` | `var(--fs-md)` |
| `0.78rem` | `var(--fs-md)` |
| `0.8rem` | `var(--fs-md)` |
| `0.85rem` | `var(--fs-lg)` |
| `0.95rem` | `var(--fs-lg)` |
| `1rem` | `var(--fs-xl)` |
| `1.05rem` | `var(--fs-xl)` |
| `1.1rem` | `var(--fs-xl)` |
| `1.15rem` | `var(--fs-xl)` |
| `1.25rem` | `var(--fs-2xl)` |
| `1.3rem` | `var(--fs-2xl)` |
| `1.5rem` | `var(--fs-2xl)` |
| `1.8rem` | `var(--fs-3xl)` |
| `2.5rem` | `var(--fs-3xl)` |

### 5.3 間距遷移對照

| 現有 raw 值 | 應改為 |
|:-----------:|:------:|
| `2px` | `var(--space-1)` |
| `4px` | `var(--space-2)` |
| `5px` | `var(--space-3)` |
| `6px` | `var(--space-3)` |
| `7px` | `var(--space-3)` |
| `8px` | `var(--space-4)` |
| `10px` | `var(--space-5)` |
| `12px` | `var(--space-6)` |
| `14px` | `var(--space-7)` |
| `16px` | `var(--space-8)` |
| `18px` | `var(--space-9)` |
| `20px` | `var(--space-10)` |
| `24px` | `var(--space-12)` |
| `28px` | `var(--space-14)` |
| `32px` | `var(--space-16)` |
| `40px` | `var(--space-20)` |

### 5.4 圓角遷移對照

| 現有 raw 值 | 應改為 |
|:-----------:|:------:|
| `2px` | `var(--radius-sm)` |
| `3px` | `var(--radius-sm)` |
| `4px` | `var(--radius-sm)` |
| `6px` | `var(--radius-sm)` |
| `100px` | `var(--radius-full)` |

---

## 📋 6. 元件清單與狀態矩陣

### 6.1 所有元件狀態

| 元件 | 狀態 | 視覺指示 |
|------|------|---------|
| Panel | default / hover | border-color transition |
| Stat Cell | default / positive / negative / neutral | 數字顏色 + sub 顏色 |
| Decision Card | buy / sell / hold | 左邊框顏色 + tag 顏色 |
| Agent Card | idle / thinking / error | border glow + state badge |
| Button | default / hover / active / disabled | border + bg transition |
| Conn Badge | live / dead | 綠/紅背景 + pulse dot |
| Cycle Badge | active | 金色背景 + spinner |

### 6.2 動畫統一

```css
:root {
  --transition: 200ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 12px rgba(245,166,35,0.1); }
  50% { box-shadow: 0 0 24px rgba(245,166,35,0.25); }
}
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
```

---

## 🚫 7. 禁止事項（Code Review Checklist）

- [ ] **禁止** inline style（`style={{...}}`）— 一律使用 CSS class
- [ ] **禁止** raw font-size（`0.6rem`）— 使用 `var(--fs-*)`
- [ ] **禁止** raw margin/padding/gap（`10px`）— 使用 `var(--space-*)`
- [ ] **禁止** raw border-radius（`6px`）— 使用 `var(--radius-*)`
- [ ] **禁止** raw hex color（`#34d399`）— 使用 `var(--green)`
- [ ] **禁止** 數字顯示 `$0.00` 當值為 null — 顯示 `--`
- [ ] **禁止** 在 JSX 中使用 `toFixed()` — 使用統一的 format 函數
- [ ] **禁止** 元件 props 傳遞 style object — 使用 className + CSS

---

## 🔄 8. 遷移路線圖

```
Phase 1 — CSS Variables 定義（30 min）
  ├── 在 :root 中補齊所有 token
  ├── 移除重複/衝突的變數定義
  └── 確認所有 --radius-* / --space-* / --fs-* 已定義

Phase 2 — CSS 重構（2-3 hr）
  ├── 將所有 raw font-size 替換為 var(--fs-*)
  ├── 將所有 raw margin/padding/gap 替換為 var(--space-*)
  ├── 將所有 raw border-radius 替換為 var(--radius-*)
  └── 移除重複的 class 定義

Phase 3 — App.tsx 清理（1-2 hr）
  ├── 將所有 inline style 提取為 CSS class
  ├── 統一數字格式化（formatPrice/formatUSD/formatPct/formatPnL）
  └── 修復 null 值顯示邏輯

Phase 4 — 元件審計（1 hr）
  ├── 檢查每個元件是否符合狀態矩陣
  ├── 確認 hover/active/disabled 狀態
  └── 確認 responsive breakpoint 行為
```

---

> *"一致性不是限制，是自由的基礎。當每個像素都有其歸屬，設計才能真正服務於交易者的直覺。"* — Yuki, for Master Lord
