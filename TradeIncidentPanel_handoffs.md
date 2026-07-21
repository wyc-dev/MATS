# Trade Incident Panel — Handoff Document

> Created: 2026-07-13
> Status: Phase 1 (UI framework) — not yet started
> Parent file: TERMINAL_AGENT.md (reference for conventions)

## 🎯 Goal

Replace Portfolio panel's "Trade Records" + "Positions" sections with a unified "Trade Incident" panel. Each trade (paper or real, open or closed) is displayed as a card in a 1×6 vertical grid with up/down pagination.

## 📋 User Requirements

1. **Remove** Positions table + Trade Records history from Portfolio panel
2. **Replace** with "Trade Incident" — unified card-based view
3. **Card layout**: 1 column × 6 rows per page, "▲ 上" / "▼ 下" buttons for pagination
4. **Card display**: Summary on card face (symbol, side, status, PnL). Click to expand full details.
5. **Sort**: Newest first (most recent trade at top of page 1)
6. **Paper + Real**: Mixed in same list, each card tagged PAPER or REAL
7. **Data source**: Existing `tradeRecords` from API + `positions` from portfolio. New fields (min/max, exit thesis, post-review) are TODO — show "Pending" until backend adds them.

## 📊 Card Fields

### Summary (always visible on card face)
| Field | Source | Notes |
|-------|--------|-------|
| Symbol | `t.symbol` | e.g. BTC, xyz:SILVER |
| Side | `t.side` | BUY (green) / SELL (red) |
| Status | `t.status` | OPEN (gold border) / CLOSED (normal) |
| PAPER/REAL tag | `t.agentId` | `hyperliquid-real` → REAL, else PAPER |
| PnL | `t.pnl` | Closed: realized PnL. Open: unrealized PnL |
| Entry → Exit | `t.entryPrice`, `t.exitPrice` | Open: Entry only |

### Expanded (click card to expand)
| Field | Source | Status |
|-------|--------|--------|
| Direction | `t.side` | ✅ available |
| Entry Price | `t.entryPrice` | ✅ available |
| Exit Price | `t.exitPrice` | ✅ available (closed only) |
| Min Value Reached | TODO backend | ⏳ Pending — track during position lifetime |
| Max Value Reached | TODO backend | ⏳ Pending — track during position lifetime |
| Entry Thesis | `t.entryThesis` or `pos.entryThesis` | ✅ available (some trades) |
| Exit Thesis | TODO backend | ⏳ Pending — generated on close |
| Post-Review (如何賺多啲/蝕少啲) | TODO backend LLM | ⏳ Pending — LLM auto-generate on close, user-editable later |
| Leverage | `t.leverage` | ✅ available |
| Investment | `t.investment` | ✅ available |
| Opened At | `t.openedAt` | ✅ available |
| Closed At | `t.closedAt` | ✅ available (closed only) |

## 🏗️ Component Structure

```
PortfolioPanel
  ├── Balance / Equity (keep)
  └── TradeIncidentPanel (NEW — replaces Positions table + HistoryPanel)
      ├── Header: "Trade Incident" + count badge + PAPER/REAL filter (optional)
      ├── 1×6 card grid (current page)
      │   └── TradeIncidentCard (×6)
      │       ├── Summary face (symbol, side, status, PnL, PAPER/REAL tag)
      │       └── Expanded details (click to toggle)
      └── Pagination: "▲ 上" / "▼ 下" + page indicator
```

## 🎨 Card Visual Design

- **OPEN positions**: Gold border + subtle gold glow background
- **CLOSED trades**: Normal glass border
- **PAPER tag**: Blue/gray badge
- **REAL tag**: Green badge
- **BUY side**: Green text
- **SELL side**: Red text
- **Positive PnL**: Green
- **Negative PnL**: Red
- **Pending fields**: Italic gray "Pending — backend not yet implemented"
- **Card size**: Full width, compact height when collapsed (~60-80px), auto-expand when clicked

## 📐 Pagination

- 6 cards per page (1 column × 6 rows)
- "▲ 上" button at top (disabled on page 1)
- "▼ 下" button at bottom (disabled on last page)
- Page indicator: "Page 1/4" between buttons or in header
- Sort: newest first

## 🔧 Backend TODO (Phase 2)

### Min/Max Value Tracking
- Track `minValueReached` and `maxValueReached` for each open position
- Update on every price tick (in portfolio.ts or paper-engine.ts)
- Persist to portfolio-state.json
- Include in tradeRecords API response

### Exit Thesis
- Generate when position closes (Meta-Agent or Skeptics already produces close rationale)
- Store in trade record as `exitThesis`
- Include in tradeRecords API response

### Post-Review LLM Auto-Generation
- On position close, trigger LLM call (DeepSeek V4 Flash) to generate post-trade review
- Prompt: "Given this trade (entry/exit/PnL/thesis), how could more profit have been made or less loss incurred?"
- Store as `postReview` in trade record
- User can edit later via UI (Phase 3)

### API Changes
- `tradeRecords` response needs: `minValueReached`, `maxValueReached`, `exitThesis`, `postReview`, `agentId` (for PAPER/REAL distinction)
- Open positions need same fields (min/max tracked live)

## 📁 Files to Modify

### Phase 1 (UI — this session)
- `ui/src/App.tsx` — Remove Positions table + HistoryPanel, add TradeIncidentPanel + TradeIncidentCard
- `ui/src/index.css` — Card styles, pagination styles

### Phase 2 (Backend — future)
- `src/trading/portfolio.ts` — Min/max tracking, exit thesis storage, post-review storage
- `src/trading/paper-engine.ts` — Min/max tracking on price updates
- `src/index.ts` — LLM post-review on close, include new fields in API response
- `src/api-server.ts` — API response format changes
- `src/types/index.ts` — New TradeRecord fields

## 📊 Data Flow

```
Backend (tradeRecords API)
  ↓
Frontend (data.tradeRecords)
  ↓
TradeIncidentPanel
  ├── Merge open positions + closed trades into unified list
  ├── Sort by timestamp (newest first)
  ├── Paginate (6 per page)
  └── Render TradeIncidentCard for each
      ├── Collapsed: summary (symbol, side, status, PnL, PAPER/REAL)
      └── Expanded: all fields (entry/exit/min/max/thesis/exit thesis/post-review)
```

## 🚫 What NOT to Do

- Don't remove the Balance/Equity display from Portfolio panel
- Don't remove the TradingView chart from Portfolio panel (keep for position chart viewing)
- Don't modify backend trade record structure in Phase 1 (use existing fields, show "Pending" for missing)
- Don't remove the manual close button functionality (it's in Selected Market Pairs now, not Portfolio)