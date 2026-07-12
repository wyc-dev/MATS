import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { Settings, Pause, Play, Power } from 'lucide-react'
import type { APIData, AgentModelConfig, ModelDefinition, EMInsightStats } from './types'
import { AGENT_META, AGENT_ROLES } from './types'
import TradingViewChart from './TradingViewChart'

const API_BASE = '/api'

/* ── Helpers ── */
function formatHKTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'Asia/Hong_Kong',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/* ── Sub-components ── */

function StatCell({ label, value, cls = 'neutral', sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="stat-cell">
      <span className="stat-label">{label}</span>
      <span className={`stat-number ${cls}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}

function SystemStatusPanel({ data }: { data: APIData | null }) {
  const s = data?.status
  if (!s) return <div className="panel"><div className="panel-title">System Status</div><span className="text-tertiary">Waiting...</span></div>

  const decision = data?.consensus?.decision
  const vetoed = data?.consensus?.metaAgentOverridden
  // totalPnl / drawdownPct / balance / equity are null in real-trade mode
  // (before first exchange balance fetch) — UI shows '--'.
  const totalPnl: number | null = s.totalPnl ?? null
  const drawdownPct: number | null = s.drawdownPct ?? null
  const balance: number | null = s.balance ?? null
  const equity: number | null = s.equity ?? null
  const progress = data?.cycleProgress
  const phaseLabel = progress?.phase === 'thinking' ? '💭 Agents Thinking'
    : progress?.phase === 'debating' ? `🗣️ Debate Round ${progress.round}/${progress.totalRounds}`
    : progress?.phase === 'voting' ? '🗳️ Consensus Voting'
    : progress?.phase === 'auditing' ? '🔍 Risk Audit'
    : ''

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">System Status</span>
        <span className="panel-badge">v1.0</span>
      </div>
      <div className="stat-grid-sm">
        <StatCell label="Cycles" value={String(s.cycles ?? 0)} />
        <StatCell label="Balance" value={balance === null ? '--' : `$${balance.toFixed(0)}`} />
        <StatCell label="Equity" value={equity === null ? '--' : `$${equity.toFixed(0)}`} cls={totalPnl === null ? 'neutral' : (totalPnl >= 0 ? 'positive' : 'negative')} />
        <StatCell label="Drawdown" value={drawdownPct === null ? '--' : `${(drawdownPct * 100).toFixed(1)}%`} cls={drawdownPct === null ? 'neutral' : (drawdownPct > 0.1 ? 'negative' : 'neutral')} />
        <StatCell label="Trades" value={String(s.tradeCount ?? 0)} sub={`W:${s.winCount ?? 0} L:${s.lossCount ?? 0}`} />
        <StatCell label="Positions" value={String(s.positions ?? 0)} />
        <StatCell label="WS" value={s.wsConnected ? 'Connected' : 'Disconnected'} cls={s.wsConnected ? 'positive' : 'negative'} />
        <StatCell label="Total PnL" value={totalPnl === null ? '--' : `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`} cls={totalPnl === null ? 'neutral' : (totalPnl >= 0 ? 'positive' : 'negative')} />
      </div>

      {s.cycleInProgress && (
        <div className="cycle-spinner cycle-spinner-top">
          <span className="spinner" />
          <span>{phaseLabel || 'Decision cycle in progress...'}</span>
        </div>
      )}
    </div>
  )
}

function AgentCard({ role, thought, status, progress, models, assignments, onModelChange, activeSymbol, newsHeadlines, ollamaPlan, isExpanded, onToggleExpand }: {
  role: string; thought: any; status: any; progress?: any;
  models: ModelDefinition[]; assignments: AgentModelConfig[]; onModelChange: (role: string, model: string) => void; activeSymbol?: string
  newsHeadlines?: Array<{ symbol: string; headlines: Array<{ title: string; publisher: string; url?: string; pubDate: number | null }> }>
  ollamaPlan?: string
  isExpanded: boolean
  onToggleExpand: () => void
}) {
  const meta = AGENT_META[role]
  const [thoughtExpanded, setThoughtExpanded] = useState(false)
  const [expandedRationales, setExpandedRationales] = useState<Set<string>>(new Set())
  const [expandedRejections, setExpandedRejections] = useState<Set<string>>(new Set())
  if (!meta) return null

  const toggleRationale = (symbol: string) => {
    setExpandedRationales(prev => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })
  }

  // Extract which symbols this agent analyzed
  const analyzingSymbols: string[] = []
  if (thought?.metadata?.multiSymbolDecision) {
    const msd = thought.metadata.multiSymbolDecision
    // Primary market ticker symbol
    if (msd.marketTicker?.symbol) analyzingSymbols.push(msd.marketTicker.symbol)
    // Position + trading market symbols (v2.0.104: includes trading markets without position)
    if (msd.positions?.length) {
      for (const p of msd.positions) {
        if (p.symbol && !analyzingSymbols.includes(p.symbol)) analyzingSymbols.push(p.symbol)
      }
    }
  } else if (activeSymbol) {
    analyzingSymbols.push(activeSymbol)
  }

  // Live progress overrides static data when cycle is running
  const liveProgress = progress
  const isLive = liveProgress?.status === 'thinking' || liveProgress?.status === 'done'

  const agentState = isLive
    ? (liveProgress.status === 'thinking' ? 'thinking' : liveProgress.status === 'done' ? 'idle' : status?.state ?? 'idle')
    : (status?.state ?? 'idle')

  const confidence = isLive ? (liveProgress.confidence ?? 0) : (thought?.confidence ?? 0)
  const displayThought = isLive && liveProgress.thought
    ? liveProgress.thought
    : (thought?.thought ?? null)
  const decision = isLive ? liveProgress.decision : thought?.metadata?.decision
  const latency = isLive ? liveProgress.latencyMs : thought?.metadata?.latency

  // Collect all per-symbol decisions from multiSymbolDecision (deduped by normalized symbol)
  const allDecisions: { symbol: string; action: string; positionSizePct: number; closePosition?: boolean; confidence?: number; holdReason?: string; entryThesis?: string; rationale?: string }[] = []
  if (thought?.metadata?.multiSymbolDecision) {
    const msd = thought.metadata.multiSymbolDecision
    const seenSyms = new Set<string>()
    // marketTicker first, then positions — skip if symbol already seen
    if (msd.marketTicker) {
      const symNorm = msd.marketTicker.symbol.replace(/^xyz:/i, '').toLowerCase()
      allDecisions.push({
        symbol: msd.marketTicker.symbol,
        action: msd.marketTicker.action,
        positionSizePct: msd.marketTicker.positionSizePct,
        confidence: msd.marketTicker.confidence,
        holdReason: msd.marketTicker.holdReason,
        entryThesis: msd.marketTicker.entryThesis,
        rationale: msd.marketTicker.rationale,
      })
      seenSyms.add(symNorm)
    }
    if (msd.positions?.length) {
      for (const p of msd.positions) {
        const symNorm = p.symbol.replace(/^xyz:/i, '').toLowerCase()
        if (seenSyms.has(symNorm)) continue
        seenSyms.add(symNorm)
        allDecisions.push({
          symbol: p.symbol,
          action: p.action,
          positionSizePct: p.positionSizePct,
          closePosition: p.closePosition,
          confidence: p.confidence,
          holdReason: p.holdReason,
          entryThesis: p.entryThesis,
          rationale: p.rationale,
        })
      }
    }
  } else if (decision && decision.symbol !== 'UNKNOWN') {
    // Skip Skeptics' placeholder decision (symbol: 'UNKNOWN') — it's an auditor, not a trader
    allDecisions.push({
      symbol: decision.symbol ?? activeSymbol ?? '',
      action: decision.action,
      positionSizePct: decision.positionSizePct,
      holdReason: decision.holdReason,
      entryThesis: decision.entryThesis,
      rationale: decision.rationale,
    })
  }

  // For Skeptics: extract per-symbol audit results
  const skepticsAudit: { symbol: string; approved: number; modified: number; details: string[] }[] =
    thought?.metadata?.perSymbolAudit ?? []
  // v2.0.105: Extract thesis rejections (Phase 1.8 full rationale) for Skeptics UI
  const thesisRejections: { symbol: string; action: string; rationale: string }[] =
    thought?.metadata?.thesisRejections ?? []

  // News headlines only shown for News Reporter
  const isNewsReporter = role === 'news_reporter'

  const currentAssignment = assignments.find((a: AgentModelConfig) => a.role === role)
  const currentModel = currentAssignment?.model ?? ''

  return (
    <div className={`agent-card ${isLive && liveProgress.status === 'thinking' ? 'agent-thinking' : ''} ${isExpanded ? 'agent-card-expanded' : 'agent-card-collapsed'}`}>
      <div className="agent-head" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
        <div className="agent-name-row">
          <span className="agent-dot" style={{ background: meta.color }} />
          <span className="agent-name">{meta.name}</span>
          {isLive && liveProgress.status === 'thinking' && <span className="live-dot" />}
        </div>
        {analyzingSymbols.length > 0 && (
          <div className="agent-symbols">
            {analyzingSymbols.join(' , ')}
          </div>
        )}
        <span className={`agent-state ${agentState}`}>
          {isLive && liveProgress.status === 'thinking' ? '💭 thinking' : agentState}
        </span>
        <span className="agent-expand-chevron">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {/* Collapsed summary: description + latency + model */}
      {!isExpanded && (
        <>
          <div className="agent-description-collapsed">{meta.description}</div>
          <div className="agent-footer agent-footer-collapsed">
            {latency != null && (
              <span className="agent-footer-item">⏱ {(latency / 1000).toFixed(1)}s</span>
            )}
            {thought?.metadata?.model && !isLive && (
              <span className="agent-footer-item">📋 {thought.metadata.model.split('/').pop()?.slice(0, 16)}</span>
            )}
            {isLive && liveProgress.status === 'thinking' && (
              <span className="agent-footer-item thinking-pulse">⟳ thinking...</span>
            )}
            {thought?.metadata?.fallback && !isLive && (
              <span className="agent-footer-item agent-footer-fallback">⚠️ Fallback</span>
            )}
          </div>
        </>
      )}
      {/* Expanded content: thought + model row + per-symbol section */}
      {isExpanded && (
        <>
      {displayThought ? (
        <>
          <div className={`agent-thought ${thoughtExpanded ? 'agent-thought-expanded' : 'agent-thought-collapsed'}`}>
            {displayThought}
          </div>
          <div className="agent-footer">
            {latency != null && (
              <span className="agent-footer-item">⏱ {(latency / 1000).toFixed(1)}s</span>
            )}
            {thought?.metadata?.model && !isLive && (
              <span className="agent-footer-item">📋 {thought.metadata.model.split('/').pop()?.slice(0, 16)}</span>
            )}
            {isLive && liveProgress.status === 'thinking' && (
              <span className="agent-footer-item thinking-pulse">⟳ thinking...</span>
            )}
            {thought?.metadata?.fallback && !isLive && (
              <span className="agent-footer-item agent-footer-fallback">⚠️ Fallback</span>
            )}
          </div>
        </>
      ) : (
        <div className="agent-empty">
          {isLive && liveProgress.status === 'thinking' ? '⟳ Thinking...' : 'Waiting for first thought...'}
        </div>
      )}
      {/* Expand/Copy buttons + Model selector on same row */}
      <div className="agent-card-model-row">
        {displayThought && (
          <>
            <button
              className="agent-thought-toggle-btn"
              onClick={() => setThoughtExpanded(v => !v)}
              title={thoughtExpanded ? 'Collapse' : 'Expand'}
            >
              {thoughtExpanded ? '▲ Collapse' : '▼ Expand'}
            </button>
            <button
              className="agent-thought-copy-btn"
              onClick={() => navigator.clipboard.writeText(displayThought)}
              title="Copy thought"
            >
              📋 Copy
            </button>
          </>
        )}
        <select
          className="model-select model-select-wide"
          value={currentModel}
          onChange={e => onModelChange(role, e.target.value)}
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
      {/* Per-symbol section: decision tag + news headlines (News Reporter only) */}
      {/* For Skeptics: per-symbol audit results + thesis rejections instead of decisions */}
      {skepticsAudit.length > 0 || thesisRejections.length > 0 ? (
        <div className="agent-per-symbol-section">
          {skepticsAudit.map((a, i) => {
            // Check if there's a thesis rejection for this symbol
            const rejection = thesisRejections.find(r => r.symbol === a.symbol)
            const rejKey = `skeptics-${a.symbol}`
            const rejExpanded = expandedRejections.has(rejKey)
            return (
              <div key={i} className="agent-per-symbol-group">
                <div className="agent-per-symbol-header">
                  <span className="agent-decision-symbol">{a.symbol}</span>
                  <span className={`decision-tag ${a.modified > 0 ? 'sell' : 'hold'} decision-tag-inner`}>
                    {a.modified > 0 ? `⚠ ${a.modified} MOD` : `✓ ${a.approved} OK`}
                  </span>
                </div>
                {rejection && (
                  <>
                    <button
                      className="agent-rationale-toggle"
                      onClick={() => {
                        setExpandedRejections(prev => {
                          const next = new Set(prev)
                          if (next.has(rejKey)) next.delete(rejKey)
                          else next.add(rejKey)
                          return next
                        })
                      }}
                      title={rejExpanded ? 'Collapse' : 'Expand'}
                    >
                      {rejExpanded ? '▲ Rejection' : '▼ Rejection'}
                    </button>
                    <div className={`agent-per-symbol-rationale ${rejExpanded ? 'agent-rationale-expanded' : 'agent-rationale-collapsed'}`} style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--red)' }}>
                      🚫 REJECTED {rejection.action.toUpperCase()}: {rejection.rationale}
                    </div>
                  </>
                )}
              </div>
            )
          })}
          {/* Show thesis rejections that don't have a matching perSymbolAudit entry */}
          {thesisRejections.filter(r => !skepticsAudit.some(a => a.symbol === r.symbol)).map((r, i) => (
            <div key={`rej-${i}`} className="agent-per-symbol-group">
              <div className="agent-per-symbol-header">
                <span className="agent-decision-symbol">{r.symbol}</span>
                <span className="decision-tag sell decision-tag-inner">🚫 REJ</span>
              </div>
              <div className="agent-per-symbol-rationale agent-rationale-expanded" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--red)' }}>
                {r.rationale}
              </div>
            </div>
          ))}
        </div>
      ) : allDecisions.length > 0 ? (
        <div className="agent-per-symbol-section">
          {allDecisions.map((d, i) => {
            // Match news headlines to this symbol — only for News Reporter
            const dSymNorm = d.symbol.replace(/^xyz:/i, '').toLowerCase()
            const ns = isNewsReporter ? newsHeadlines?.find(n => {
              const nSymNorm = n.symbol.replace(/^xyz:/i, '').toLowerCase()
              return nSymNorm === dSymNorm
            }) : undefined
            return (
              <div key={i} className="agent-per-symbol-group">
                <div className="agent-per-symbol-header">
                  <span className="agent-decision-symbol">{d.symbol}</span>
                  {(() => {
                    const isSubAgent = role !== 'meta_agent' && role !== 'news_reporter'
                    const actionLabel = d.closePosition ? 'CLOSE' : d.action.toUpperCase()
                    if (isSubAgent && d.rationale) {
                      const rExp = expandedRationales.has(d.symbol)
                      return (
                        <button
                          className={`decision-reason-btn ${d.action}`}
                          onClick={() => toggleRationale(d.symbol)}
                          title={rExp ? 'Collapse rationale' : 'Expand rationale'}
                        >
                          {rExp ? '▲' : '▼'} {actionLabel} Reason
                        </button>
                      )
                    }
                    return (
                      <span className={`decision-tag ${d.action} decision-tag-inner`}>
                        {actionLabel}
                      </span>
                    )
                  })()}
                  {d.positionSizePct > 0 && <span className="agent-decision-size">{(d.positionSizePct * 100).toFixed(1)}%</span>}
                  {/* Per-symbol confidence bar — v2.0.84: hidden for Meta-Agent (weight=0, confidence is meaningless) */}
                  {role !== 'meta_agent' && (() => {
                    const symConf = d.confidence ?? confidence
                    // v2.0.86: Dynamic color based on confidence — smooth gradient red→orange→yellow→green
                    // HSL hue: 0% conf = 0° (red), 50% = 60° (yellow), 100% = 120° (green)
                    const confHue = symConf * 120
                    const confColor = `hsl(${confHue}, 70%, 50%)`
                    return (
                      <span className="agent-per-symbol-conf">
                        <span className="conf-track conf-track-inline">
                          <span className={`conf-fill ${isLive && liveProgress.status === 'thinking' ? 'conf-animate' : ''}`}
                            style={{ width: `${symConf * 100}%`, background: confColor }} />
                        </span>
                        <span className="conf-pct conf-pct-inline" style={{ color: confColor }}>{(symConf * 100).toFixed(0)}%</span>
                      </span>
                    )
                  })()}
                </div>
                {/* v2.0.84: Per-symbol rationale display logic:
                    - Meta-Agent: show holdReason (HOLD) or entryThesis (BUY/SELL) — these ARE the rationale, don't also show rationale
                    - News Reporter: always show rationale expanded
                    - Other sub-agents: show rationale behind ▼ Reason toggle */}
                {(() => {
                  const isMetaOrNews = role === 'meta_agent' || role === 'news_reporter'
                  const rationaleExpanded = expandedRationales.has(d.symbol)
                  
                  if (role === 'meta_agent') {
                    // Meta-Agent: holdReason/entryThesis IS the rationale — don't duplicate
                    // v2.0.94: Always expanded for Meta-Agent — user needs to see full reasoning
                    if (d.action === 'hold' && d.holdReason) {
                      return (
                        <div className="agent-hold-reason agent-hold-reason-expanded" title={d.holdReason}>
                          {d.holdReason}
                        </div>
                      )
                    }
                    if ((d.action === 'buy' || d.action === 'sell') && d.entryThesis) {
                      return (
                        <div className="agent-entry-thesis agent-entry-thesis-expanded" title={d.entryThesis}>
                          📝 {d.entryThesis}
                        </div>
                      )
                    }
                    // Meta-Agent fallback: show rationale if no holdReason/entryThesis
                    if (d.rationale) {
                      return (
                        <div className="agent-per-symbol-rationale agent-rationale-expanded" title={d.rationale}>
                          {d.rationale}
                        </div>
                      )
                    }
                    return null
                  }
                  
                  if (isMetaOrNews) {
                    // News Reporter: always show rationale expanded
                    return d.rationale ? (
                      <div className="agent-per-symbol-rationale agent-rationale-expanded" title={d.rationale}>
                        {d.rationale}
                      </div>
                    ) : null
                  }
                  
                  // Other sub-agents: rationale div only — toggle is now the decision-reason-btn in header
                  if (!d.rationale) return null
                  return (
                    <div className={`agent-per-symbol-rationale ${rationaleExpanded ? 'agent-rationale-expanded' : 'agent-rationale-collapsed'}`} title={d.rationale}>
                      {d.rationale}
                    </div>
                  )
                })()}
                {ns && ns.headlines.length > 0 && (
                  <div className="agent-news-items">
                    {ns.headlines.map((h, hi) => (
                      <div key={hi} className="agent-news-item">
                        {h.url
                          ? <a href={h.url} target="_blank" rel="noopener noreferrer" className="agent-news-link" title={h.title}>{h.title}</a>
                          : <span className="agent-news-title" title={h.title}>{h.title}</span>
                        }
                        <span className="agent-news-source">{h.publisher}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {/* Show news for symbols that have headlines but no decision — News Reporter only */}
          {isNewsReporter && newsHeadlines?.filter(ns => {
            const nSymNorm = ns.symbol.replace(/^xyz:/i, '').toLowerCase()
            return !allDecisions.some(d => d.symbol.replace(/^xyz:/i, '').toLowerCase() === nSymNorm)
          }).map((ns, ni) => (
            <div key={`extra-${ni}`} className="agent-per-symbol-group">
              <div className="agent-per-symbol-header">
                <span className="agent-decision-symbol">{ns.symbol}</span>
              </div>
              <div className="agent-news-items">
                {ns.headlines.map((h, hi) => (
                  <div key={hi} className="agent-news-item">
                    {h.url
                      ? <a href={h.url} target="_blank" rel="noopener noreferrer" className="agent-news-link" title={h.title}>{h.title}</a>
                      : <span className="agent-news-title" title={h.title}>{h.title}</span>
                    }
                    <span className="agent-news-source">{h.publisher}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
        </>
      )}
    </div>
  )
}

/* ── Terminal Agent card — framework for terminal-side execution analysis ── */

function TerminalAgentCard({ data, isExpanded, onToggleExpand }: { data: APIData | null; isExpanded: boolean; onToggleExpand: () => void }) {
  const meta = AGENT_META['terminal_agent']
  if (!meta) return null

  // Extract selected market pairs (positions + trading markets)
  const config = data?.marketAgent?.config
  const isRealMode = config?.tradeMode === 'real'
  const allPortfolioPositions = Object.values(data?.portfolio?.positions ?? {}) as any[]
  const openPositions = isRealMode
    ? allPortfolioPositions.filter((pos) => pos.agentId === 'hyperliquid-real')
    : allPortfolioPositions.filter((pos) => pos.agentId !== 'hyperliquid-real')
  const positionMap = new Map<string, 'buy' | 'sell'>()
  for (const pos of openPositions) {
    positionMap.set(pos.symbol, pos.side)
  }
  const normSym = (s: string) => s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()

  const TRADING_MARKETS_KEY = 'amacrf:tradingMarkets'
  const [tradingMarkets] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(TRADING_MARKETS_KEY)
      const arr = raw ? JSON.parse(raw) : null
      if (!Array.isArray(arr)) return []
      const norm = (s: string) => s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()
      const seen = new Set<string>()
      const deduped: string[] = []
      for (const s of arr) {
        if (typeof s !== 'string') continue
        const n = norm(s)
        if (!seen.has(n)) { seen.add(n); deduped.push(s) }
      }
      return deduped.slice(0, 3)
    } catch { return [] }
  })

  const allSelectedSyms = [
    ...Array.from(positionMap.keys()),
    ...tradingMarkets.filter(sym => !Array.from(positionMap.keys()).some(p => normSym(p) === normSym(sym))),
  ]

  return (
    <div className={`agent-card ${isExpanded ? 'agent-card-expanded' : 'agent-card-collapsed'}`}>
      <div className="agent-head" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
        <div className="agent-name-row">
          <span className="agent-dot" style={{ background: meta.color }} />
          <span className="agent-name">{meta.name}</span>
        </div>
        {allSelectedSyms.length > 0 && (
          <div className="agent-symbols">{allSelectedSyms.join(' , ')}</div>
        )}
        <span className="agent-state idle">idle</span>
        <span className="agent-expand-chevron">{isExpanded ? '▲' : '▼'}</span>
      </div>
      {!isExpanded && (
        <>
          <div className="agent-description-collapsed">{meta.description}</div>
          <div className="agent-footer agent-footer-collapsed">
            <span className="agent-footer-item">⏱ —</span>
            <span className="agent-footer-item">📋 pending</span>
          </div>
        </>
      )}
      {isExpanded && (
        <>
          <div className="agent-thought agent-thought-expanded">
            Terminal Agent framework initialized. Analyzing {allSelectedSyms.length} selected market pair(s): {allSelectedSyms.join(', ') || 'none'}.
            <br /><br />
            Functionality to be added — this agent will process terminal-side execution signals for all Selected Market Pairs.
          </div>
          <div className="agent-footer">
            <span className="agent-footer-item">⏱ —</span>
            <span className="agent-footer-item">📋 pending</span>
          </div>
          <div className="agent-card-model-row">
            <select className="model-select model-select-wide" disabled>
              <option>Terminal Agent (no model)</option>
            </select>
          </div>
          {allSelectedSyms.length > 0 && (
            <div className="agent-per-symbol-section">
              {allSelectedSyms.map((sym, i) => {
                const side = positionMap.get(sym)
                return (
                  <div key={i} className="agent-per-symbol-group">
                    <div className="agent-per-symbol-header">
                      <span className="agent-decision-symbol">{sym}</span>
                      <span className={`decision-tag ${side ? (side === 'buy' ? 'buy' : 'sell') : 'hold'} decision-tag-inner`}>
                        {side ? side.toUpperCase() : 'HOLD'}
                      </span>
                    </div>
                    <div className="agent-per-symbol-rationale agent-rationale-expanded">
                      Pending — Terminal Agent analysis not yet implemented for {sym}.
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ── Market Agent card — embedded inside Agent Cognition ── */

function MarketAgentCard({ data }: { data: APIData | null }) {
  const s = data?.status
  const m = data?.marketState
  const ma = data?.marketAgent
  // v2.0.117: Warning when switching to Real mode without wallet/private key
  const [realModeWarning, setRealModeWarning] = useState('')
  const config = ma?.config
  const topPairs = ma?.topPairs ?? []
  const pairsReady = ma?.pairsReady ?? false

  // v2.0.79: Get open positions for position pills (green=BUY, red=SELL)
  const isRealMode = config?.tradeMode === 'real'
  const allPortfolioPositions = Object.values(data?.portfolio?.positions ?? {}) as any[]
  const openPositions = isRealMode
    ? allPortfolioPositions.filter((pos) => pos.agentId === 'hyperliquid-real')
    : allPortfolioPositions.filter((pos) => pos.agentId !== 'hyperliquid-real')
  // Build a map of symbol → side for position pills
  const positionMap = new Map<string, 'buy' | 'sell'>()
  for (const pos of openPositions) {
    positionMap.set(pos.symbol, pos.side)
  }
  // Normalize symbol for comparison (lowercase prefix for colon symbols)
  const normSym = (s: string) => s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()

  const [selectedTradeMode, setSelectedTradeMode] = useState(config?.tradeMode ?? 'paper')
  // Exchange is now fixed to hyperliquid
  // v2.0.112: Exchange is fixed to Hyperliquid — no dropdown shown
  const exchange = 'hyperliquid'
  const [selectedAssetType, setSelectedAssetType] = useState(config?.hyperliquidAssetType ?? 'crypto_perps')
  const [statusMsg, setStatusMsg] = useState('')
  const [statusVisible, setStatusVisible] = useState(false)
  const [positionSizePct, setPositionSizePct] = useState(config?.positionSizePct ?? 0.10)
  const [maxPortionPct, setMaxPortionPct] = useState(config?.maxPortionPct ?? 0.20)
  const [leverage, setLeverage] = useState(config?.leverage ?? 10)
  const [assetSearch, setAssetSearch] = useState('')
  const [cyclePeriod, setCyclePeriod] = useState(config?.cyclePeriodMinutes ?? 5)
  const [closeConfirmSym, setCloseConfirmSym] = useState<string | null>(null)
  const [closingSym, setClosingSym] = useState<string | null>(null)
  const [pairsLoading, setPairsLoading] = useState(false)

  // Cross-asset-type pair cache: persists volume/price data across Asset Type switches
  // so Selected Market Pairs can show data even when the pair isn't in the current topPairs.
  const pairCacheRef = useRef<Map<string, { volume24h: number; volume5m?: number; price: number; priceChangePercent: number }>>(new Map())
  useEffect(() => {
    for (const p of topPairs) {
      pairCacheRef.current.set(normSym(p.symbol), { volume24h: p.volume24h, volume5m: p.volume5m, price: p.price, priceChangePercent: p.priceChangePercent })
    }
    // Clear loading state when backend signals pairs are ready (background scan done)
    if (pairsReady) {
      setPairsLoading(false)
    }
  }, [topPairs, pairsReady])
  const getCachedPair = (sym: string) => pairCacheRef.current.get(normSym(sym))

  // ── Persistent "Trading Markets" pills (max 3).
  // When user clicks a Top Volume Pair, it gets added as a pill.
  // Deduped — same symbol only appears once. Persisted to localStorage
  // with a single key so it survives Trade Mode / Asset Type switches.
  // v2.0.79: Also synced to backend so agents analyze these symbols.
  const TRADING_MARKETS_KEY = 'amacrf:tradingMarkets'
  const [tradingMarkets, setTradingMarkets] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(TRADING_MARKETS_KEY)
      const arr = raw ? JSON.parse(raw) : null
      if (!Array.isArray(arr)) return []
      // v2.0.79: Dedup by normalized symbol on load — prevents BTC + btc coexisting
      const norm = (s: string) => s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()
      const seen = new Set<string>()
      const deduped: string[] = []
      for (const s of arr) {
        if (typeof s !== 'string') continue
        const n = norm(s)
        if (!seen.has(n)) {
          seen.add(n)
          deduped.push(s)
        }
      }
      return deduped.slice(0, 3)
    } catch { return [] }
  })

  // Sync trading markets to backend whenever they change.
  // v2.0.79: Use a ref to avoid duplicate POSTs on initial render.
  // v2.0.112: Add debounce to prevent rapid-fire POSTs when state oscillates.
  // v2.0.113: UI is the SOLE source of truth for tradingMarkets. Backend
  // never pushes markets to UI. The merge effect that caused the infinite
  // POST loop has been completely removed.
  const lastPostedMarkets = useRef<string>('')
  const postMarketsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const json = JSON.stringify(tradingMarkets)
    if (json === lastPostedMarkets.current) return // skip if unchanged
    lastPostedMarkets.current = json
    try { localStorage.setItem(TRADING_MARKETS_KEY, json) } catch { /* ignore */ }
    // Debounce POST — if state changes again within 500ms, cancel the previous
    // POST and only send the latest.
    if (postMarketsTimer.current) clearTimeout(postMarketsTimer.current)
    postMarketsTimer.current = setTimeout(() => {
      postMarketsTimer.current = null
      fetch(`${API_BASE}/market-agent/trading-markets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markets: tradingMarkets }),
      }).catch(() => { /* ignore */ })
    }, 500)
  }, [tradingMarkets])

  // v2.0.113: REMOVED backend→UI merge effect entirely.
  // This was the root cause of the infinite POST loop:
  //   merge effect adds backend markets → UI state changes → POST effect fires
  //   → backend changes → pushToAPI → data.tradingMarkets changes → merge
  //   effect fires again → infinite loop.
  // The UI is the sole source of truth. localStorage persists the user's
  // selection across page reloads. Backend only receives, never pushes.

  const addTradingMarket = async (symbol: string) => {
    // v2.0.79: Normalize symbol before adding — prevents BTC + btc coexistence.
    const norm = (s: string) => s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()
    const normalizedSymbol = norm(symbol)
    const positionCount = positionMap.size
    setTradingMarkets(prev => {
      if (prev.some(s => norm(s) === normalizedSymbol)) return prev
      for (const [posSym] of positionMap) {
        if (norm(posSym) === normalizedSymbol) return prev
      }
      if (prev.length + positionCount >= 3) return prev
      return [...prev, normalizedSymbol]
    })
    // Also select the symbol as active for chart display
    try {
      await fetch(`${API_BASE}/market-agent/select-symbol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
    } catch { /* ignore */ }
  }

  const removeTradingMarket = (symbol: string) => {
    setTradingMarkets(prev => prev.filter(s => s !== symbol))
  }

  useEffect(() => {
    if (config) {
      setSelectedTradeMode(config.tradeMode)
      if (config.hyperliquidAssetType) setSelectedAssetType(config.hyperliquidAssetType)
      // v2.0.XX: Only sync slider values from config when they actually change.
      // Previously this ran on every tradeMode/assetType change and reset the
      // sliders to whatever config had — even if the user just adjusted them.
      // Now each slider only updates from config when its specific value changes.
      setPositionSizePct(prev => Math.abs(prev - config.positionSizePct) > 0.001 ? config.positionSizePct : prev)
      setMaxPortionPct(prev => Math.abs(prev - (config.maxPortionPct ?? 0.20)) > 0.001 ? (config.maxPortionPct ?? 0.20) : prev)
      setLeverage(prev => prev !== config.leverage ? config.leverage : prev)
      if (config.cyclePeriodMinutes) setCyclePeriod(prev => prev !== config.cyclePeriodMinutes ? config.cyclePeriodMinutes! : prev)
    }
  }, [config?.tradeMode, config?.hyperliquidAssetType, config?.positionSizePct, config?.maxPortionPct, config?.leverage, config?.cyclePeriodMinutes])

  const showStatus = (msg: string) => {
    setStatusMsg(msg)
    setStatusVisible(true)
    setTimeout(() => setStatusVisible(false), 2000)
  }

  const handleTradeModeChange = async (mode: string) => {
    setSelectedTradeMode(mode as any)
    try {
      const res = await fetch(`${API_BASE}/market-agent/trade-mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
      if ((await res.json()).success) showStatus(`✓ ${mode}`)
    } catch { showStatus('✗ Failed') }
  }

  const handleAssetTypeChange = async (assetType: string) => {
    setSelectedAssetType(assetType as any)
    setPairsLoading(true)
    try {
      const res = await fetch(`${API_BASE}/market-agent/asset-type`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetType }) })
      if ((await res.json()).success) showStatus(`✓ ${assetType}`)
    } catch { showStatus('✗ Failed') }
  }
  // Exchange is fixed to hyperliquid — no-op handler for the dropdown
  const handleExchangeChange = async (_exchange: string) => {
    // no-op: exchange is fixed
  }

  const activeSymbol = config?.selectedSymbol ?? ''
  // Chart symbol: prefer the first selected market pair (position or trading market),
  // not the backend's auto-selected top pair which changes on Asset Type switch.
  const allSelectedSyms = [
    ...Array.from(positionMap.keys()),
    ...tradingMarkets.filter(sym => !Array.from(positionMap.keys()).some(p => normSym(p) === normSym(sym))),
  ]
  const chartSymbol = allSelectedSyms[0] ?? activeSymbol
  // Use live market state price (updates every cycle) instead of topPairs snapshot
  const livePrice = s?.currentPrice ?? m?.currentPrice ?? 0
  const liveVol24h = m?.volume24h ?? 0
  const liveChange24h = m?.priceChange24h ?? 0
  const currentPair = topPairs.find(p => p.symbol === chartSymbol)
  const price = activeSymbol && livePrice > 0 ? livePrice : (currentPair?.price ?? 0)
  const volume24h = liveVol24h > 0 ? liveVol24h : (currentPair?.volume24h ?? 0)
  const change24h = liveChange24h !== 0 ? liveChange24h : (currentPair?.priceChangePercent ?? 0)
  const meta = AGENT_META['market_agent']

  // Build trade markers for the active symbol so the main TradingView chart
  // shows the current position's entry point + live SL/TP (v2.0.16).
  // v2.0.21: only show the CURRENT open position (cycle=0). Historical trades
  // are shown in the Portfolio panel's chart (where the user clicks a
  // position row) — the Market Agent chart should show a single current
  // entry marker, not every past sell/buy which cluttered the chart with
  // multiple stale arrows.
  const portfolioPositions = (Object.values(data?.portfolio?.positions ?? {}) as any[])
  const activePos = portfolioPositions.find((p: any) => p.symbol === chartSymbol)
  const mainChartTrades: Array<{ time: number; action: 'buy' | 'sell'; price: number; sl?: number; tp?: number; cycle: number }> = []
  // Current position's live entry + SL/TP (cycle=0 = current)
  if (activePos) {
    mainChartTrades.push({
      time: Math.floor((activePos.openedAt ?? Date.now()) / 1000),
      action: activePos.side === 'buy' ? 'buy' : 'sell',
      price: activePos.averageEntryPrice ?? activePos.currentPrice ?? price,
      sl: activePos.stopLossPrice,
      tp: activePos.takeProfitPrice,
      cycle: 0,
    })
  }

  return (
    <div className="agent-card">
      <div className="agent-head">
        <div className="agent-name-row">
          <span className="agent-dot" style={{ background: meta?.color }} />
          <span className="agent-name">{meta?.name ?? 'Market Agent'}</span>
        </div>
        <span className="agent-state idle">{exchange.toUpperCase()} · {config?.tradeMode?.toUpperCase()}</span>
      </div>

      {/* Trade Mode + Cycle Period */}
      <div className="market-control-group">
        <div className="market-control-col">
          <div className="market-control-label">Trade Mode</div>
          <div className="market-agent-selector-btns">
            <button className={`year-btn year-btn-wide ${selectedTradeMode === 'paper' ? 'active' : ''}`} onClick={() => handleTradeModeChange('paper')}>Paper</button>
            <button className={`year-btn year-btn-wide ${selectedTradeMode === 'real' ? 'active' : ''}`} onClick={async () => {
              // v2.0.117: Check wallet + private key before switching to Real mode
              try {
                const res = await fetch(`${API_BASE}/settings/env`)
                const json = await res.json()
                if (json.success) {
                  const settings = json.settings as Record<string, string>
                  const wallet = settings['HYPERLIQUID_WALLET_ADDRESS'] ?? ''
                  const privKey = settings['HYPERLIQUID_PRIVATE_KEY'] ?? ''
                  if (!wallet || !privKey || wallet.includes('••••') && !privKey.includes('••••')) {
                    // Has wallet but no private key (or vice versa)
                    if (!wallet || !privKey) {
                      setRealModeWarning('⚠️ Hyperliquid wallet address and/or private key not configured. Go to Settings ⚙️ to set them before trading in Real mode.')
                      return
                    }
                  }
                  // Both exist (even if masked) — allow switch
                  setRealModeWarning('')
                }
              } catch { /* ignore — allow switch if fetch fails */ }
              handleTradeModeChange('real')
            }}>Real</button>
          </div>
          {realModeWarning && <div className="trade-mode-warning">{realModeWarning}</div>}
        </div>
        <div className="market-control-col">
          <div className="market-control-label">
            Cycle Period: <strong style={{ color: cyclePeriod <= 4 ? 'var(--red)' : 'var(--gold)' }}>{cyclePeriod}m</strong>
            {cyclePeriod <= 4 && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', marginLeft: 'var(--space-3)' }}>⚠ High token cost</span>}
          </div>
          <div className="slider-row">
            <input
              type="range" min="1" max="10" value={cyclePeriod}
              onChange={async (e) => {
                const m = parseInt(e.target.value)
                setCyclePeriod(m)
                try {
                  await fetch(`${API_BASE}/market-agent/cycle-period`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ minutes: m }),
                  })
                } catch { /* ignore */ }
              }}
              style={{ flex: 1, height: 4, accentColor: cyclePeriod <= 4 ? 'var(--red)' : 'var(--gold)' }}
            />
            <span className="slider-value" style={{ color: cyclePeriod <= 4 ? 'var(--red)' : 'var(--gold)' }}>{cyclePeriod}m</span>
          </div>
        </div>
      </div>

      {(s?.cycles ?? 0) === 0 && cyclePeriod <= 4 && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', marginTop: 'var(--space-2)', lineHeight: 1.4, textAlign: 'center' }}>
          ⚠ If HACP can't finish within {cyclePeriod}m would be causing back-to-back cycles.
        </div>
      )}

      {/* Position Size & Max Portion & Leverage Controls */}
      <div className="market-control-group">
        <div className="market-control-col">
          <div className="market-control-label">
            Position Size: <strong>{(positionSizePct * 100).toFixed(0)}%</strong>
          </div>
          <div className="slider-row">
            <input
              type="range" min="1" max={Math.round(maxPortionPct * 100)} value={Math.round(positionSizePct * 100)}
              onChange={async (e) => {
                const pct = parseInt(e.target.value) / 100
                setPositionSizePct(pct)
                try {
                  const res = await fetch(`${API_BASE}/market-agent/position-size`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct }) })
                  if ((await res.json()).success) showStatus(`✓ ${(pct * 100).toFixed(0)}%`)
                } catch { showStatus('✗ Failed') }
              }}
              style={{ flex: 1, height: 4, accentColor: 'var(--accent)' }}
            />
            <span className="slider-value">{Math.round(positionSizePct * 100)}%</span>
          </div>
        </div>
        <div className="market-control-col">
          <div className="market-control-label">
            Max Portion: <strong>{(maxPortionPct * 100).toFixed(0)}%</strong>
          </div>
          <div className="slider-row">
            <input
              type="range" min="10" max="50" value={Math.round(maxPortionPct * 100)}
              onChange={async (e) => {
                const pct = parseInt(e.target.value) / 100
                setMaxPortionPct(pct)
                // If position size exceeds new max, clamp it down
                if (positionSizePct > pct) setPositionSizePct(pct)
                try {
                  const res = await fetch(`${API_BASE}/market-agent/max-portion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct }) })
                  if ((await res.json()).success) showStatus(`✓ Max ${(pct * 100).toFixed(0)}%`)
                } catch { showStatus('✗ Failed') }
              }}
              style={{ flex: 1, height: 4, accentColor: 'var(--accent)' }}
            />
            <span className="slider-value">{Math.round(maxPortionPct * 100)}%</span>
          </div>
        </div>
        <div className="market-control-col">
          <div className="market-control-label">
            Leverage: <strong>{leverage}x</strong>
          </div>
          <div className="slider-row">
            <input
              type="range" min="1" max="10" value={leverage}
              onChange={async (e) => {
                const lev = parseInt(e.target.value)
                setLeverage(lev)
                try {
                  const res = await fetch(`${API_BASE}/market-agent/leverage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leverage: lev }) })
                  if ((await res.json()).success) showStatus(`✓ ${lev}x`)
                } catch { showStatus('✗ Failed') }
              }}
              style={{ flex: 1, height: 4, accentColor: 'var(--accent)' }}
            />
            <span className="slider-value">{leverage}x</span>
          </div>
        </div>
      </div>

      {/* Status msg */}
      <div className={`model-status model-status-compact ${statusVisible ? '' : 'hidden'}`}>{statusMsg}</div>

      {/* Asset Type + Search bar — side by side */}
      <div className="market-control-group">
        <div className="market-control-col">
          <div className="market-control-label">Asset Type</div>
          <div className="market-control-btns-row">
            <select className="model-select model-select-wide" value={selectedAssetType} onChange={e => handleAssetTypeChange(e.target.value)}>
              <option value="crypto_perps">Crypto Perps</option>
              <option value="indices">Indices</option>
              <option value="stocks">Stocks</option>
              <option value="commodities">Commodities</option>
              <option value="fx">FX / Forex</option>
              <option value="tradfi">All TradFi</option>
            </select>
          </div>
        </div>
        <div className="market-control-col" style={{ flex: 1, minWidth: 0 }}>
          <div className="market-control-label">Custom Search</div>
          <input
            type="text"
            className="market-search-input"
            placeholder="Search symbol..."
            value={assetSearch}
            onChange={e => setAssetSearch(e.target.value)}
            style={{ margin: 0, width: '100%' }}
          />
        </div>
      </div>

      {/* Available Pairs — below Asset Type, click to add (disabled during cycle) */}
      <div className="market-pairs-header">
        <div className="market-pairs-header-label" style={pairsLoading ? { color: 'var(--gold)' } : s?.cycleInProgress ? { color: 'var(--red)' } : undefined}>
          {pairsLoading
            ? `Loading ${selectedAssetType.replace(/_/g, ' ')} Top 30 Volume Markets ...`
            : s?.cycleInProgress
            ? 'Select asset after this cycle of calculations is completed:'
            : 'Available Pairs (click to add asset to "Selected Markets"):'}
        </div>
        <div className="top-pairs-list" style={{ position: 'relative', overflow: pairsLoading ? 'hidden' : 'auto', ...(s?.cycleInProgress ? { pointerEvents: 'none', opacity: 0.4, background: 'rgba(248, 113, 113, 0.25)' } : {}) }}>
          {pairsLoading && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', borderRadius: 'var(--radius-md)', zIndex: 10 }}>
              <span className="spinner" style={{ width: '24px', height: '24px', borderWidth: '3px' }} />
            </div>
          )}
          {topPairs
            .filter(pair => {
              if (!assetSearch.trim()) return true
              return pair.symbol.toLowerCase().includes(assetSearch.toLowerCase())
            })
            .map((pair, i) => {
              const isAdded = tradingMarkets.some(s => normSym(s) === normSym(pair.symbol)) ||
                Array.from(positionMap.keys()).some(s => normSym(s) === normSym(pair.symbol))
              // Count unique symbols across tradingMarkets + positionMap (deduped)
              const uniqueSymbols = new Set<string>()
              for (const s of tradingMarkets) uniqueSymbols.add(normSym(s))
              for (const s of positionMap.keys()) uniqueSymbols.add(normSym(s))
              const full = uniqueSymbols.size >= 3
              return (
                <div
                  key={pair.symbol}
                  className={`top-pair-row top-pair-row-inline ${isAdded ? 'pair-added' : ''}`}
                  onClick={() => { if (!isAdded && !full) addTradingMarket(pair.symbol) }}
                  style={isAdded
                    ? { opacity: 1, cursor: 'default', background: 'rgba(52, 211, 153, 0.12)', boxShadow: '0 0 8px rgba(52, 211, 153, 0.3)' }
                    : { opacity: full ? 0.4 : 1, cursor: full ? 'default' : 'pointer' }}
                  onMouseEnter={(e) => { if (!isAdded && !full) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                  onMouseLeave={(e) => { if (!isAdded) e.currentTarget.style.background = ''; }}
                >
                  <span className="top-pair-rank top-pair-cell">#{i + 1}</span>
                  <span className="top-pair-symbol top-pair-cell-bold">{pair.symbol}</span>
                  <span className="top-pair-vol top-pair-cell">{pair.volume24h > 0 ? `$${(pair.volume24h / 1_000_000).toFixed(1)}M` : 'N/A'}</span>
                  <span className="top-pair-vol top-pair-cell-tertiary">{pair.volume5m != null && pair.volume5m > 0 ? `${(pair.volume5m / 1000).toFixed(0)}K` : '-'}</span>
                  <span className={`top-pair-chg top-pair-cell ${pair.priceChangePercent >= 0 ? 'positive' : 'negative'}`}>
                    {pair.volume24h > 0 ? `${pair.priceChangePercent >= 0 ? '+' : ''}${pair.priceChangePercent.toFixed(2)}%` : 'N/A'}
                  </span>
                  <span className="top-pair-spacer" />
                  {isAdded && <span style={{ fontSize: '24px', color: 'var(--green)', fontWeight: 'var(--fw-bold)', lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}>✓</span>}
                </div>
              )
            })}
          {topPairs.filter(pair => !assetSearch.trim() || pair.symbol.toLowerCase().includes(assetSearch.toLowerCase())).length === 0 && (
            <div className="market-slot-empty" style={{ padding: 'var(--space-4) 0' }}>
              {assetSearch.trim() ? `No pairs match "${assetSearch}"` : 'Initiating market and assets ...'}
            </div>
          )}
        </div>
      </div>

      {/* Selected Market Pairs — directly below Available Pairs */}
      <div className="market-pairs-header" style={{ position: 'relative' }}>
        <div className="market-pairs-header-label">
          Selected Market Pairs ({(() => { const u = new Set<string>(); for (const s of tradingMarkets) u.add(normSym(s)); for (const s of positionMap.keys()) u.add(normSym(s)); return u.size })()}/3):
        </div>
        <div className="top-pairs-list">
          {/* Position rows — BUY/SELL tag + ✕ for manual close confirmation */}
          {Array.from(positionMap.entries()).map(([sym, side]) => {
            const pair = topPairs.find(p => normSym(p.symbol) === normSym(sym))
            const cached = getCachedPair(sym)
            const vol24 = pair?.volume24h ?? cached?.volume24h ?? 0
            const vol5m = pair?.volume5m ?? cached?.volume5m
            const chg = pair?.priceChangePercent ?? cached?.priceChangePercent ?? 0
            return (
              <div
                key={`pos-row-${sym}`}
                className={`top-pair-row top-pair-row-inline ${normSym(sym) === normSym(activeSymbol) ? 'active-pair' : ''}`}
                onClick={() => {
                  fetch(`${API_BASE}/market-agent/select-symbol`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ symbol: sym }),
                  }).catch(() => {})
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
              >
                <span className="top-pair-rank top-pair-cell" style={{ color: side === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: 'var(--fw-bold)' }}>{side === 'buy' ? 'BUY' : 'SELL'}</span>
                <span className="top-pair-symbol top-pair-cell-bold">{sym}</span>
                <span className="top-pair-vol top-pair-cell">{vol24 > 0 ? `$${(vol24 / 1_000_000).toFixed(1)}M` : '—'}</span>
                <span className="top-pair-vol top-pair-cell-tertiary">{vol5m != null && vol5m > 0 ? `${(vol5m / 1000).toFixed(0)}K` : '—'}</span>
                <span className={`top-pair-chg top-pair-cell ${chg >= 0 ? 'positive' : 'negative'}`}>
                  {vol24 > 0 ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—'}
                </span>
                <span className="top-pair-spacer" />
                <span
                  className="top-pair-rank top-pair-cell"
                  style={{ cursor: 'pointer', color: 'var(--red)', fontWeight: 'var(--fw-bold)' }}
                  onClick={(e) => { e.stopPropagation(); setCloseConfirmSym(sym) }}
                  title={`Close position: ${sym}`}
                >✕</span>
              </div>
            )
          })}
          {/* Trading market rows — HOLD tag + ✕ to remove from selected markets */}
          {tradingMarkets
            .filter(sym => {
              for (const [posSym] of positionMap) {
                if (normSym(posSym) === normSym(sym)) return false
              }
              return true
            })
            .map(sym => {
              const pair = topPairs.find(p => normSym(p.symbol) === normSym(sym))
              const cached = getCachedPair(sym)
              const vol24 = pair?.volume24h ?? cached?.volume24h ?? 0
              const vol5m = pair?.volume5m ?? cached?.volume5m
              const chg = pair?.priceChangePercent ?? cached?.priceChangePercent ?? 0
              return (
                <div
                  key={`tm-row-${sym}`}
                  className={`top-pair-row top-pair-row-inline ${normSym(sym) === normSym(activeSymbol) ? 'active-pair' : ''}`}
                  onClick={() => {
                    fetch(`${API_BASE}/market-agent/select-symbol`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ symbol: sym }),
                    }).catch(() => {})
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                >
                  <span className="top-pair-rank top-pair-cell" style={{ color: 'var(--gold)', fontWeight: 'var(--fw-bold)' }}>HOLD</span>
                  <span className="top-pair-symbol top-pair-cell-bold">{sym}</span>
                  <span className="top-pair-vol top-pair-cell">{vol24 > 0 ? `$${(vol24 / 1_000_000).toFixed(1)}M` : '—'}</span>
                  <span className="top-pair-vol top-pair-cell-tertiary">{vol5m != null && vol5m > 0 ? `${(vol5m / 1000).toFixed(0)}K` : '—'}</span>
                  <span className={`top-pair-chg top-pair-cell ${chg >= 0 ? 'positive' : 'negative'}`}>
                    {vol24 > 0 ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—'}
                  </span>
                  <span className="top-pair-spacer" />
                  <span
                    className="top-pair-rank top-pair-cell"
                    style={{ cursor: 'pointer', color: 'var(--text-tertiary)' }}
                    onClick={(e) => { e.stopPropagation(); removeTradingMarket(sym) }}
                    title={`Remove ${sym} from selected markets`}
                  >✕</span>
                </div>
              )
            })}
          {tradingMarkets.length === 0 && positionMap.size === 0 && (
            <div className="market-slot-empty" style={{ padding: 'var(--space-4) 0' }}>No markets selected — pick from the list above</div>
          )}
        </div>

      {/* Close position confirmation — overlays the Selected Market Pairs section */}
      {closeConfirmSym && (
        <div onClick={() => setCloseConfirmSym(null)} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, borderRadius: 'var(--radius-md)' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#00000088', backdropFilter: 'var(--glass-blur-strong)', WebkitBackdropFilter: 'var(--glass-blur-strong)', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-9)', maxWidth: '380px', width: '90%', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 20px rgba(248, 113, 113, 0.2)' }}>
            <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-bold)', marginBottom: 'var(--space-4)', color: 'var(--red)' }}>
              Close Position: {closeConfirmSym}
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-6)', lineHeight: 1.5 }}>
              This will manually close the position on the exchange. The close thesis will record this as a user-initiated manual close.
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-4)', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setCloseConfirmSym(null)}
                style={{ padding: 'var(--space-3) var(--space-6)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--glass-border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 'var(--fs-base)' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setClosingSym(closeConfirmSym)
                  try {
                    const res = await fetch(`${API_BASE}/positions/close`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ symbol: closeConfirmSym }),
                    })
                    const result = await res.json()
                    if (result.success) {
                      setCloseConfirmSym(null)
                    } else {
                      alert(`Failed to close ${closeConfirmSym}: ${result.error ?? result.message ?? 'Unknown error'}`)
                    }
                  } catch (err) {
                    alert(`Failed to close ${closeConfirmSym}: ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setClosingSym(null)
                  }
                }}
                disabled={closingSym === closeConfirmSym}
                style={{ padding: 'var(--space-3) var(--space-6)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--red)', background: 'var(--red-bg)', color: 'var(--red)', cursor: 'pointer', fontSize: 'var(--fs-base)', fontWeight: 'var(--fw-bold)' }}
              >
                {closingSym === closeConfirmSym ? 'Closing...' : '✓ Confirm Close'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Price info + chart */}
      <div className="market-chart-row">
        <div className="market-chart-col">
          {chartSymbol ? (
            <>
              <div className="market-price market-price-top">
                <span className="market-symbol market-symbol-lg">{chartSymbol}</span>
                <span className="market-value market-value-sm">${price.toFixed(2)}</span>
                <span className={`market-change market-change-sm ${change24h >= 0 ? 'text-green' : 'text-red'}`}>
                  {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}
                </span>
              </div>
              {/* Mini TradingView chart for the selected market — refreshes every cycle. */}
              <div className="market-vol-row">
                <TradingViewChart symbol={chartSymbol} currentPrice={price} trades={mainChartTrades} refreshKey={s?.cycles ?? 0} />
              </div>
            </>
          ) : (
            <div className="empty-state empty-state-compact">
              <div className="empty-text empty-text-sm">Waiting for market data...</div>
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

function PreferencePanel({ data }: { data: APIData | null }) {
  return (
    <div className="panel panel-rgb-border">
      <div className="panel-header">
        <span className="panel-title">Preference</span>
      </div>
      <div className="agent-list">
        <MarketAgentCard data={data} />
      </div>
    </div>
  )
}

function AgentPanel({ data, ollamaPlan }: { data: APIData | null; ollamaPlan?: string }) {
  const thoughts = data?.agentThoughts ?? []
  const statuses = data?.agentStatuses ?? []
  const progress = data?.cycleProgress
  const models = data?.agentModels?.available ?? []
  const assignments = data?.agentModels?.assignments ?? []
  const activeSymbol = data?.marketAgent?.config?.selectedSymbol
  const progressMap = new Map<string, any>()
  if (progress?.agentProgress) {
    for (const p of progress.agentProgress) progressMap.set(p.agentRole, p)
  }
  const thoughtMap = new Map<string, any>()
  for (const t of thoughts) thoughtMap.set(t.agentRole, t)
  const statusMap = new Map<string, any>()
  for (const s of statuses) statusMap.set(s.role, s)

  // Accordion state: only one agent expanded at a time
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)

  const handleModelChange = async (role: string, modelId: string) => {
    try {
      await fetch(`${API_BASE}/models/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, model: modelId }),
      })
    } catch { /* ignore */ }
  }

  return (
    <div className="panel panel-rgb-border">
      <div className="panel-header">
        <span className="panel-title">Agent Cognition</span>
        <span className="panel-badge">
          {progress ? `Phase: ${progress.phase}` : ''}
        </span>
      </div>
      <div className="agent-list">
        {ollamaPlan === 'None' && (
          <div className="ollama-warning-banner">
            <span className="ollama-warning-icon">⚠️</span>
            <span className="ollama-warning-text">
              <strong>Ollama not connected.</strong> The trading system is paused. Please open the Ollama desktop app or enter an API key in <strong>Settings ⚙️</strong> to start trading.
            </span>
          </div>
        )}
        {AGENT_ROLES.map(role => (
          role === 'market_agent'
            ? <TerminalAgentCard key={role} data={data} isExpanded={expandedAgent === 'terminal_agent'} onToggleExpand={() => setExpandedAgent(prev => prev === 'terminal_agent' ? null : 'terminal_agent')} />
            : role === 'terminal_agent'
            ? null
            : <AgentCard
                key={role}
                role={role}
                thought={thoughtMap.get(role)}
                status={statusMap.get(role)}
                progress={progressMap.get(role)}
                models={models}
                assignments={assignments}
                onModelChange={handleModelChange}
                activeSymbol={activeSymbol}
                newsHeadlines={data?.newsHeadlines}
                ollamaPlan={ollamaPlan}
                isExpanded={expandedAgent === role}
                onToggleExpand={() => setExpandedAgent(prev => prev === role ? null : role)}
              />
        ))}
      </div>

    </div>
  )
}

function PortfolioPanel({ data }: { data: APIData | null }) {
  const s = data?.status
  const p = data?.portfolio
  const th = data?.tradeHistory ?? []
  // v2.0.78: Filter positions by trade mode — paper mode shows only paper
  // positions, real mode shows only real (exchange) positions. Prevents
  // cross-mode contamination in the positions table.
  const maConfig = data?.marketAgent?.config
  const isRealMode = maConfig?.tradeMode === 'real'
  const allPositions = Object.values(p?.positions ?? {}) as any[]
  const positions = isRealMode
    ? allPositions.filter((pos) => pos.agentId === 'hyperliquid-real')
    : allPositions.filter((pos) => pos.agentId !== 'hyperliquid-real')
  const [chartSymbol, setChartSymbol] = useState<string | null>(
    positions.length > 0 ? positions[0]?.symbol ?? null : null
  )
  // v2.0.30: Manual close confirmation state
  const [closeConfirmSymbol, setCloseConfirmSymbol] = useState<string | null>(null)
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null)

  // Clear chartSymbol when all positions are closed
  useEffect(() => {
    if (positions.length === 0 && chartSymbol !== null) {
      setChartSymbol(null)
    }
  }, [positions.length])
  if (!s) return null

  // v2.0.30: Manual close position handler
  const handleManualClose = async (symbol: string) => {
    setClosingSymbol(symbol)
    try {
      const res = await fetch(`${API_BASE}/positions/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      const result = await res.json()
      if (result.success) {
        setCloseConfirmSymbol(null)
      } else {
        alert(`Failed to close ${symbol}: ${result.error ?? result.message ?? 'Unknown error'}`)
      }
    } catch (err) {
      alert(`Failed to close ${symbol}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setClosingSymbol(null)
    }
  }

  // v2.0.30: In real mode, balance/equity are null when exchange balance
  // hasn't been fetched yet. Use explicit null check — ?? would fallback
  // from null to status.balance (which might be stale paper data).
  const balance: number | null = isRealMode
    ? (p?.balance !== null && p?.balance !== undefined ? p.balance : (s.balance !== null && s.balance !== undefined ? s.balance : null))
    : (p?.balance ?? s.balance ?? 0)
  const equity: number | null = isRealMode
    ? (p?.totalEquity !== null && p?.totalEquity !== undefined ? p.totalEquity : (s.equity !== null && s.equity !== undefined ? s.equity : null))
    : (p?.totalEquity ?? s.equity ?? 0)
  // totalPnl / drawdownPct are null in real-trade mode (v2.0.17) — UI shows '--'.
  // v2.0.74: Use explicit null check (like balance/equity above) — `??` would
  // fall through null to s.totalPnl (stale paper data), leaking paper PnL
  // (+278.50) into the real-mode UI.
  const totalPnl: number | null = isRealMode
    ? (p?.totalPnl !== null && p?.totalPnl !== undefined ? p.totalPnl : null)
    : (p?.totalPnl ?? s.totalPnl ?? null)
  const drawdownPct: number | null = isRealMode
    ? (p?.maxDrawdownPct !== null && p?.maxDrawdownPct !== undefined ? p.maxDrawdownPct : null)
    : (p?.maxDrawdownPct ?? s.drawdownPct ?? null)
  const initialBalance = p?.initialBalance ?? 1000
  const displaySymbol = chartSymbol ?? ''

  // Get current price for chart symbol from positions or market state
  const selectedPos = positions.find((pos: any) => pos.symbol === displaySymbol)
  const chartPrice = selectedPos?.currentPrice ?? 0

  // v2.0.32: Portfolio chart only shows the CURRENT position marker + live SL/TP.
  // Historical trade markers are NOT shown here (they belong in the Market Agent chart).
  // This prevents multiple buy markers from erroneous/old trade records.
  const tradeMarkers: Array<{ time: number; action: 'buy' | 'sell'; price: number; sl?: number; tp?: number; cycle: number }> = []

  // Add CURRENT position's live SL/TP as a marker (cycle=0 = current)
  if (selectedPos) {
    tradeMarkers.push({
      time: Math.floor((selectedPos.openedAt ?? Date.now()) / 1000),
      action: selectedPos.side === 'buy' ? 'buy' : 'sell',
      price: selectedPos.averageEntryPrice,
      sl: selectedPos.stopLossPrice,
      tp: selectedPos.takeProfitPrice,
      cycle: 0, // 0 = current position
    })
  }

  return (
    <div className="panel panel-rgb-border">
      <div className="panel-header">
        <span className="panel-title">Portfolio</span>
        <span className="panel-badge">{s.positions} positions</span>
      </div>

      {/* TradingView Chart — only shows when user clicks a position row */}
      {displaySymbol ? (
        <div className="portfolio-section-header">
          <div className="portfolio-section-top">
            <span className="portfolio-section-label">
              Chart: {displaySymbol}
              {positions.length > 0 && !chartSymbol && <span className="portfolio-click-hint">(click a position row)</span>}
            </span>
          </div>
          <TradingViewChart
            symbol={displaySymbol}
            currentPrice={chartPrice}
            trades={tradeMarkers}
            refreshKey={s?.cycles ?? 0}
          />
        </div>
      ) : (
        <div className="empty-state chart-empty-state">
          <div className="empty-text empty-text-sm">Click a position row to view chart</div>
        </div>
      )}

      <div className="portfolio-grid">
        <div className="portfolio-cell">
          <span className="stat-label">Balance</span>
          <span className="stat-number neutral">{balance === null ? '--' : `$${balance.toFixed(2)}`}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Equity</span>
          <span className={`stat-number ${equity === null ? 'neutral' : (equity >= initialBalance ? 'positive' : 'negative')}`}>
            {equity === null ? '--' : `$${equity.toFixed(2)}`}
          </span>
        </div>
        {/* v2.0.78: In real mode, hide paper-only stats (Total PnL, Drawdown,
            Win Rate, Trades) — they're paper-trade concepts that don't map to
            the real exchange account. Only Balance + Equity are shown. */}
        {!isRealMode && (
          <div className="portfolio-cell">
            <span className="stat-label">Total PnL</span>
            <span className={`stat-number ${totalPnl === null ? 'neutral' : (totalPnl >= 0 ? 'positive' : 'negative')}`}>
              {totalPnl === null ? '--' : `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`}
            </span>
          </div>
        )}
        {!isRealMode && (
          <div className="portfolio-cell drawdown-cell">
            <div className="drawdown-left">
              <span className="stat-label">Drawdown</span>
              <span className={`stat-number ${drawdownPct === null ? 'neutral' : (drawdownPct > 0.1 ? 'negative' : 'neutral')}`}>
                {drawdownPct === null ? '--' : `${(drawdownPct * 100).toFixed(2)}%`}
              </span>
            </div>
            {/* v2.0.45: Clear Drawdown button — resets drawdown data and relaunches trading.
                When drawdown ≥ 15%, the SystemGuard blocks all cycles. This button
                clears the drawdown so the next cycle can resume. */}
            {drawdownPct !== null && drawdownPct >= 0.15 && (
              <div className="drawdown-right">
                <button
                  onClick={async () => {
                    try {
                      await fetch(`${API_BASE}/clear-drawdown`, { method: 'POST' });
                    } catch (err) {
                      console.error('Failed to clear drawdown:', err);
                    }
                  }}
                  className="clear-drawdown-btn"
                >
                  Clear Drawdown
                </button>
                <span className="stat-sub">
                  Drawdown ≥ 15% — trading halted. Clear to relaunch.
                </span>
              </div>
            )}
          </div>
        )}
        {!isRealMode && (
          <div className="portfolio-cell">
            <span className="stat-label">Win Rate</span>
            <span className="stat-number positive">
              {((s.recent20WinRate ?? 0) * 100).toFixed(1)}%
            </span>
            {/* v2.0.42: Shows win rate from the most recent 20 trades only */}
            <span className="stat-sub">
              (lastest 20 trades)
            </span>
          </div>
        )}
        {!isRealMode && (
          <div className="portfolio-cell">
            <span className="stat-label">Trades</span>
            <span className="stat-number neutral">
              {s.tradeCount}
            </span>
            <span className="stat-sub">W:{s.winCount} L:{s.lossCount}</span>
          </div>
        )}
      </div>

      {positions.length > 0 ? (
        <div className="positions-table-wrap">
          <table className="positions-table">
            <thead>
              <tr>
                <th></th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Value</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Unrealized PnL</th>
                <th>SL</th>
                <th>TP</th>
                <th>Lev</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos: any) => {
                return (
                <>
                <tr key={pos.id} onClick={() => setChartSymbol(pos.symbol)} className={`position-row-clickable ${chartSymbol === pos.symbol ? 'selected-position' : ''}`}>
                  <td className="td-action-cell" onClick={(e) => e.stopPropagation()}>
                    {closeConfirmSymbol === pos.symbol ? (
                      <span className="action-btns-row">
                        <button
                          onClick={() => handleManualClose(pos.symbol)}
                          disabled={closingSymbol === pos.symbol}
                          className="close-btn-action"
                        >
                          {closingSymbol === pos.symbol ? '...' : '✓'}
                        </button>
                        <button
                          onClick={() => setCloseConfirmSymbol(null)}
                          disabled={closingSymbol === pos.symbol}
                          className="close-btn-cancel"
                        >
                          ✗
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setCloseConfirmSymbol(pos.symbol)}
                        title="Close position"
                        className="close-btn-trigger"
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6' }}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                  <td className="td-symbol-cell">{pos.symbol}</td>
                  <td><span className={`side-tag ${pos.side}`}>{pos.side.toUpperCase()}</span></td>
                  <td>{pos.quantity.toFixed(6)}</td>
                  <td className="td-price-cell">
                    ${(pos.quantity * pos.currentPrice).toFixed(2)}
                  </td>
                  <td>${pos.averageEntryPrice.toFixed(2)}</td>
                  <td>${pos.currentPrice.toFixed(2)}</td>
                  <td className={`td-pnl-cell ${pos.unrealizedPnl >= 0 ? 'td-pnl-positive' : 'td-pnl-negative'}`}>
                    ${pos.unrealizedPnl.toFixed(2)} ({(pos.unrealizedPnlPct * 100).toFixed(2)}%)
                  </td>
                  <td>{pos.stopLossPrice ? `$${pos.stopLossPrice.toFixed(2)}` : '-'}</td>
                  <td>{pos.takeProfitPrice ? `$${pos.takeProfitPrice.toFixed(2)}` : '-'}</td>
                  <td>{pos.leverage ?? 1}x</td>
                  <td className="td-time-cell">
                    {formatHKTime(pos.openedAt)}
                  </td>
                </tr>
                {pos.entryThesis && (
                  <tr key={`${pos.id}-thesis`} className="position-thesis-row">
                    <td colSpan={12} className="position-thesis-cell">
                      <div className="position-thesis-content">
                        <span className="position-thesis-label"></span>
                        <span className="position-thesis-text">{pos.entryThesis}</span>
                      </div>
                    </td>
                  </tr>
                )}
                {!pos.entryThesis && pos.holdReason && (
                  <tr key={`${pos.id}-hold`} className="position-thesis-row">
                    <td colSpan={12} className="position-thesis-cell">
                      <div className="position-thesis-content">
                        <span className="position-thesis-label"></span>
                        <span className="position-thesis-text">{pos.holdReason}</span>
                      </div>
                    </td>
                  </tr>
                )}
                </>
              );
            })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">💼</div>
          <div className="empty-text">No Open Positions</div>
          <div className="empty-hint">All capital in cash — capital preservation mode</div>
        </div>
      )}

      {/* History Panel */}
      <div className="trade-history-section">
        <HistoryPanel data={data} />
      </div>
    </div>
  )
}

function HistoryPanel({ data }: { data: APIData | null }) {
  // Show all trade records — both open and closed positions
  const tradeRecords = data?.tradeRecords ?? []
  const [page, setPage] = useState(0)
  const pageSize = 10
  const isRealMode = data?.marketAgent?.config?.tradeMode === 'real'

  // Sort newest first by close/open timestamp
  const sorted = [...tradeRecords].sort((a: any, b: any) => {
    const ta = a.closedAt ?? a.openedAt ?? 0
    const tb = b.closedAt ?? b.openedAt ?? 0
    return tb - ta
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const visible = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize)

  const openCount = sorted.filter((t: any) => t.status === 'open').length
  const closedCount = sorted.filter((t: any) => t.status === 'closed').length

  useEffect(() => { setPage(0) }, [tradeRecords.length])

  const handleResetTrades = async () => {
    if (!confirm('Reset all paper trade records? This clears the trade history and cannot be undone.')) return
    try {
      await fetch(`${API_BASE}/evolution/reset-trade-history`, { method: 'POST' })
      // Also reset paper engine trades via a new endpoint
      await fetch(`${API_BASE}/paper/reset-trades`, { method: 'POST' })
    } catch (err) {
      console.error('Failed to reset trades:', err)
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Trade Records</span>
          <span className="panel-badge">0 trades</span>
        </div>
        <div className="empty-state trade-history-empty">
          <div className="empty-text empty-text-sm">No trades yet</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Trade Records</span>
        <div className="trade-filter-row">
          {!isRealMode && (
            <button className="header-btn trade-reset-btn" onClick={handleResetTrades} title="Reset paper trade records">
              🗑️
            </button>
          )}
          <span className="panel-badge trade-filter-badge">
            {openCount > 0 && <span>{openCount} open</span>}
            {closedCount > 0 && <span>{closedCount} closed</span>}
          </span>
          <div className="trade-filter-btns">
            <button className="header-btn trade-page-btn"
              disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>◀</button>
            <span className="trade-page-sep">
              {safePage + 1}/{totalPages}
            </span>
            <button className="header-btn trade-page-btn"
              disabled={safePage >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>▶</button>
          </div>
        </div>
      </div>
      <div className="trade-list">
        {visible.map((t: any, i: number) => {
          const isOpen = t.status === 'open'
          return (
            <div key={t.id ?? i} className="trade-record-card" style={{
              background: isOpen ? 'rgba(255, 215, 0, 0.04)' : 'var(--surface-elevated)',
              border: isOpen ? '1px solid rgba(255, 215, 0, 0.15)' : '1px solid var(--glass-border)',
            }}>
              <div className="trade-card-row">
                <span className={`side-tag trade-card-side-tag ${t.side}`}>
                  {t.side.toUpperCase()}
                </span>
                <span className="trade-card-symbol">{t.symbol}</span>
                {isOpen && (
                  <span className="trade-badge-open">
                    OPEN
                  </span>
                )}
                {!isOpen && (
                  <span className="trade-badge-closed">
                    CLOSE
                  </span>
                )}
                <span className="trade-card-meta">
                  Invest ${t.investment?.toFixed(2) ?? '—'} × {t.leverage ?? 1}x
                </span>
                <span className="trade-card-meta">
                  {isOpen
                    ? `Entry $${t.entryPrice?.toFixed(2)}`
                    : `Entry $${t.entryPrice?.toFixed(2)} → Exit $${t.exitPrice?.toFixed(2)}`
                  }
                </span>
                {!isOpen && (
                  <span className="trade-pnl-value" style={{
                    color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2) ?? '0.00'} ({(t.pnlPct != null ? (t.pnlPct * 100) : 0).toFixed(1)}%)
                  </span>
                )}
              </div>
              <div className="trade-card-footer">
                <span>Open: {formatHKTime(t.openedAt)}</span>
                {!isOpen && <span>Close: {formatHKTime(t.closedAt)}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DebatePanel({ data }: { data: APIData | null }) {
  const consensus = data?.consensus
  const rounds = data?.debateRounds ?? []
  const cycleNum = data?.status?.cycles ?? 0
  const progress = data?.cycleProgress
  const od = data?.optionsData
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(new Set())

  const toggleRound = (roundNum: number) => {
    setExpandedRounds(prev => {
      const next = new Set(prev)
      if (next.has(roundNum)) {
        next.delete(roundNum)
      } else {
        next.add(roundNum)
      }
      return next
    })
  }

  if (!consensus && rounds.length === 0) {
    return (
      <div className="panel panel-rgb-border">
        <div className="panel-header"><span className="panel-title">HACP Debate</span></div>
        <div className="empty-state">
          <div className="empty-icon">🗣️</div>
          <div className="empty-text">Waiting for first debate cycle...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel panel-rgb-border">
      <div className="panel-header">
        <span className="panel-title">HACP Debate</span>
        {consensus && <span className="panel-badge">Cycle #{cycleNum} · {consensus.roundsUsed} round{consensus.roundsUsed !== 1 ? 's' : ''}</span>}
      </div>

      {progress && progress.phase === 'thinking' && (
        <div className="cycle-spinner evo-cycle-spinner">
          <span className="spinner" />
          <span>💭 Agents Thinking</span>
        </div>
      )}

      {consensus && (
        <div className={`consensus-banner ${consensus.decision.action}`}>
          <div className="consensus-top">
            <span className="consensus-label">Consensus</span>
            <span className={`consensus-action ${consensus.decision.action}`}>
              {consensus.decision.action.toUpperCase()}
            </span>
            <span className="consensus-pct">{(consensus.confidence * 100).toFixed(0)}% confidence</span>
          </div>
          <div className="consensus-text">{consensus.decision.rationale}</div>
          <div className="consensus-meta">
            <span>Rounds: {consensus.roundsUsed}</span>
            <span>Deadlock: {consensus.deadlockResolved ? '⚠️ Resolved' : '✓ None'}</span>
            {consensus.metaAgentOverridden && <span className="veto-tag">🚨 Risk Veto</span>}
          </div>

          {consensus.votes.length > 0 && (
            <div className="votes-grid">
              {consensus.votes.map((v: any) => {
                const meta = AGENT_META[v.agentRole]
                return (
                  <div key={v.agentId} className="vote-chip" style={{borderLeftColor: meta?.color ?? '#666'}}>
                    <span className="vote-agent" style={{color: meta?.color}}>{meta?.short ?? v.agentRole}</span>
                    <span className={`vote-action-tag ${v.decision.action}`}>{v.decision.action.toUpperCase()}</span>
                    <span className="vote-pct">{(v.confidence * 100).toFixed(0)}%</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Per-symbol consensus cards — deduped by normalized symbol */}
          {consensus.perSymbolConsensus?.length > 1 && (() => {
            const normSym = (s: string) => s.replace(/^xyz:/i, '').toLowerCase()
            const seen = new Set<string>()
            const deduped = consensus.perSymbolConsensus.filter((psc: any) => {
              const n = normSym(psc.symbol)
              if (seen.has(n)) return false
              seen.add(n)
              return true
            })
            return (
            <div className="per-symbol-consensus">
              {deduped.map((psc: any) => {
                // v2.0.136: Derive position/market label from the ACTUAL portfolio
                // positions, not psc.hasPosition. The backend's hasPosition field
                // is documented UNRELIABLE (buildConsensus hardcodes false;
                // metaAgentArbitration marks every positions[] entry true, but
                // positions[] also contains injected trading markets with no real
                // position). This caused MU/SILVER to flicker between '● position'
                // and '(market)' cycle-to-cycle depending on which consensus path
                // ran. Use the real portfolio positions as the source of truth.
                const pfPositions = (Object.values(data?.portfolio?.positions ?? {}) as any[])
                const pscSymNorm = psc.symbol.replace(/^xyz:/i, '').toLowerCase()
                const isPosition = pfPositions.some((p: any) =>
                  (p.symbol ?? '').replace(/^xyz:/i, '').toLowerCase() === pscSymNorm)
                const isMkt = !isPosition
                const actionClass = psc.action === 'close' ? 'sell' : psc.action
                const odArr = od ? (Array.isArray(od) ? od : [od]) : []
                const symOd = odArr.find((o: any) => normSym(o.symbol) === normSym(psc.symbol))
                return (
                  <div key={psc.symbol} className={`consensus-banner consensus-banner-compact ${actionClass}`}>
                    <div className="consensus-row">
                      <span className="consensus-symbol">
                        {psc.symbol.toUpperCase()}
                        {isMkt && <span className="consensus-meta-tag">(market)</span>}
                        {isPosition && <span className="consensus-meta-green">● position</span>}
                      </span>
                      <span className={`vote-action-tag ${actionClass}`}>{psc.action.toUpperCase()}</span>
                      <span className="consensus-conf-pct">{(psc.confidence * 100).toFixed(0)}%</span>
                      {psc.closePosition && <span className="consensus-meta-red">🔴 CLOSE</span>}
                      {psc.suggestedStopLoss && <span className="consensus-meta-muted">SL:$${psc.suggestedStopLoss.toFixed(1)}</span>}
                      {psc.suggestedTakeProfit && <span className="consensus-meta-muted">TP:$${psc.suggestedTakeProfit.toFixed(1)}</span>}
                    </div>
                    <div className="consensus-rationale">{psc.rationale}</div>
                    {symOd && symOd.playbook && (
                      <div className="consensus-options-info">
                        📊 {symOd.playbook.playbook} — IV:{(symOd.impliedVolatility * 100).toFixed(0)}% IVR:{symOd.ivRank.toFixed(0)} γ:{symOd.gammaRegime.toUpperCase()} P/C:{symOd.putCallRatio.toFixed(2)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            )
          })()}
        </div>
      )}

      {rounds.map((round: any) => {
        const isExpanded = expandedRounds.has(round.roundNumber)
        return (
          <div key={round.roundNumber} className="round-card">
            <div
              className="round-head debate-toggle-clickable"
              onClick={() => toggleRound(round.roundNumber)}
            >
              <span className="round-num">Round {round.roundNumber}</span>
              <span className={`round-phase-tag ${round.phase}`}>{round.phase.toUpperCase()}</span>
              <span className="round-toggle round-toggle-right">
                {isExpanded ? '▼' : '▶'} {round.statements.length} statement{round.statements.length !== 1 ? 's' : ''}
              </span>
            </div>
            {isExpanded && round.statements.map((stmt: any, i: number) => {
              const meta = AGENT_META[stmt.agentRole]
              return (
                <div key={i} className="statement" style={{borderLeftColor: meta?.color ?? '#666'}}>
                  <div className="statement-head">
                    <span className="statement-agent" style={{color: meta?.color}}>{meta?.name ?? stmt.agentRole}</span>
                    <span className="statement-conf">{(stmt.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <div className="statement-body">{stmt.content}</div>
                </div>
              )
            })}
          </div>
        )
      })}

    </div>
  )
}

/* ── Options Data Layer Panel (v2.0.65) — Stocks/Indices only ── */

function OptionsDataPanel({ data }: { data: APIData | null }) {
  const od = data?.optionsData
  const assetType = data?.marketAgent?.config?.hyperliquidAssetType ?? 'crypto_perps'
  // v2.0.79: Show panel if optionsData exists (backend decides when to fetch)
  // OR if assetType is stocks/indices/tradfi
  const hasTradFiPositions = Object.values(data?.portfolio?.positions ?? {}).some((p: any) => typeof p.symbol === 'string' && p.symbol.includes(':'))
  const isOptionsAsset = assetType === 'stocks' || assetType === 'indices' || assetType === 'tradfi' || hasTradFiPositions || !!od

  if (!isOptionsAsset) return null

  // v2.0.79: Normalize to array — backend may return single object or array
  const odArray = od ? (Array.isArray(od) ? od : [od]) : []

  if (odArray.length === 0) {
    return (
      <div className="panel panel-rgb-border">
        <div className="panel-header">
          <span className="panel-title">Options Data Layer</span>
        </div>
        <div className="empty-state" style={{ padding: '12px 0' }}>
          <div className="empty-text" style={{ fontSize: '0.75rem' }}>Waiting for options data...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel panel-rgb-border">
      <div className="panel-header">
        <span className="panel-title">Options Data Layer</span>
        <span className="panel-badge">{odArray.length} asset{odArray.length > 1 ? 's' : ''}</span>
      </div>

      {/* Multi-asset table */}
      <div className="options-table-wrap">
        <table className="options-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>IV Rank</th>
              <th>IV %ile</th>
              <th>IV</th>
              <th>Imp. Move</th>
              <th>P/C Vol</th>
              <th>P/C OI</th>
              <th>Gamma</th>
              <th>DTE</th>
              <th>Playbook</th>
            </tr>
          </thead>
          <tbody>
            {odArray.map((o, i) => {
              const pcVolTone = o.putCallRatio > 1.2 ? 'negative' : o.putCallRatio < 0.8 ? 'positive' : 'neutral'
              const pcOITone = o.putCallOIRatio > 1.2 ? 'negative' : o.putCallOIRatio < 0.8 ? 'positive' : 'neutral'
              const gammaTone = o.gammaRegime === 'positive' ? 'positive' : o.gammaRegime === 'negative' ? 'negative' : 'neutral'
              return (
                <tr key={i}>
                  <td className="ot-symbol">{o.symbol}</td>
                  <td className={o.ivRank >= 50 ? 'accent' : ''}>{o.ivRank.toFixed(0)}/100</td>
                  <td>{o.ivPercentile.toFixed(0)}%</td>
                  <td>{(o.impliedVolatility * 100).toFixed(1)}%</td>
                  <td>±{(o.impliedMovePct * 100).toFixed(2)}%</td>
                  <td className={pcVolTone}>{o.putCallRatio.toFixed(2)}</td>
                  <td className={pcOITone}>{o.putCallOIRatio.toFixed(2)}</td>
                  <td className={gammaTone}>{o.gammaRegime.toUpperCase()}</td>
                  <td>{o.daysToExpiration}d</td>
                  <td className="ot-playbook">{o.playbook?.playbook ?? '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Evolution Panel — Production Grade ── */

function EvolutionHeader({ generation, symbolCount }: {
  generation: number; symbolCount: number
}) {
  return (
    <div className="evo-header">
      <div className="evo-header-left">
        <span className="evo-title">Evolution</span>
      </div>
      <div className="evo-header-right">
        <span className="evo-badge accent">Gen {generation}</span>
        {symbolCount > 0 && <span className="evo-badge">{symbolCount} sym</span>}
      </div>
    </div>
  )
}

function OLRSection({ olrState, openPositionSymbols, isExpanded, onToggleExpand }: { olrState: any; openPositionSymbols?: Set<string>; isExpanded: boolean; onToggleExpand: () => void }) {
  const hasSymbols = olrState?.symbols?.length > 0
  const hasPending = olrState?.pending?.length > 0
  const hasShadow = olrState?.shadowStats?.length > 0
  const expanded = isExpanded

  return (
    <div className="evo-section">
      <div className="evo-section-header" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
        <div className="evo-section-accent" />
        <span className="evo-section-title">OLR + Path Risk</span>
        {hasSymbols && <span className="evo-badge evo-badge-right">{olrState.symbols.length} symbols</span>}
        <span className="evo-section-toggle">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (!hasSymbols && !hasPending ? (
        <div className="evo-empty">
          <div className="evo-empty-icon">🧬</div>
          <div className="evo-empty-text">Waiting for shadow trade data</div>
          <div className="evo-empty-hint">Shadow trades open every cycle — outcomes feed OLR after SL/TP hit</div>
        </div>
      ) : (
        <>
          {hasShadow && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Shadow Trade Results (TP-before-SL)
              </div>
              {olrState.shadowStats.map((ss: any) => (
                <div key={ss.symbol} style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>{ss.symbol.toUpperCase()}</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{ss.openCount} open</span>
                  <span style={{ fontSize: '0.7rem', color: ss.longWinRate > 0.5 ? 'var(--green)' : 'var(--red)' }}>
                    LONG {ss.longWins}W/{ss.longLosses}L ({(ss.longWinRate * 100).toFixed(0)}%)
                  </span>
                  <span style={{ fontSize: '0.7rem', color: ss.shortWinRate > 0.5 ? 'var(--green)' : 'var(--red)' }}>
                    SHORT {ss.shortWins}W/{ss.shortLosses}L ({(ss.shortWinRate * 100).toFixed(0)}%)
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>avg {ss.avgHoldCycles.toFixed(0)} cycles</span>
                </div>
              ))}
            </div>
          )}

          {hasPending && (
            <div className="evo-pending-section">
              {olrState.pending.map((p: any) => (
                <div key={p.symbol} className="evo-pending-row">
                  <span className="evo-pending-symbol">{p.symbol.toUpperCase()}</span>
                  <div className="evo-pending-track">
                    <div className="evo-pending-fill" style={{ width: `${p.pct}%` }} />
                  </div>
                  <span className="evo-pending-meta">{p.pending}/{p.needed} ({p.pct}%)</span>
                </div>
              ))}
            </div>
          )}

          {hasSymbols && (
            olrState.symbols.map((symState: any) => {
              const hasPosition = openPositionSymbols?.has(symState.symbol.toLowerCase())
              const longIcon = symState.longPWin > 0.6 ? '🟢' : symState.longPWin < 0.4 ? '🔴' : '🟡'
              const shortIcon = symState.shortPWin > 0.6 ? '🟢' : symState.shortPWin < 0.4 ? '🔴' : '🟡'
              return (
                <div key={symState.symbol} className="evo-cluster-symbol">
                  <div className="evo-cluster-symbol-header">
                    <span className="evo-cluster-symbol-name">{symState.symbol.toUpperCase()}</span>
                    {hasPosition && <span className="evo-badge evo-badge-position">POSITION</span>}
                    <span className="evo-badge">{symState.longSamples}L / {symState.shortSamples}S samples</span>
                  </div>
                  <div style={{ padding: '4px 16px 8px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.8rem' }}>
                      {longIcon} BUY P(win)=<b style={{ color: symState.longPWin > 0.6 ? 'var(--green)' : symState.longPWin < 0.4 ? 'var(--red)' : 'var(--text-muted)' }}>{(symState.longPWin * 100).toFixed(0)}%</b>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>({symState.longConfidence})</span>
                    </span>
                    <span style={{ fontSize: '0.8rem' }}>
                      {shortIcon} SELL P(win)=<b style={{ color: symState.shortPWin > 0.6 ? 'var(--green)' : symState.shortPWin < 0.4 ? 'var(--red)' : 'var(--text-muted)' }}>{(symState.shortPWin * 100).toFixed(0)}%</b>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '4px' }}>({symState.shortConfidence})</span>
                    </span>
                  </div>
                  {(symState.longSource || symState.shortSource) && (() => {
                    const ls = symState.longSource ?? { shadow: 0, paper: 0, real: 0, backfill: 0 };
                    const ss = symState.shortSource ?? { shadow: 0, paper: 0, real: 0, backfill: 0 };
                    const srcRow = (label: string, s: { shadow: number; paper: number; real: number; backfill: number }) => (
                      <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                        {label}: <b style={{ color: 'var(--text)' }}>{s.shadow}</b> sh · <b style={{ color: 'var(--text)' }}>{s.paper}</b> pa · <b style={{ color: 'var(--text)' }}>{s.real}</b> re · <b style={{ color: 'var(--accent, #a78bfa)' }}>{s.backfill}</b> bf
                      </span>
                    );
                    return (
                      <div style={{ padding: '0 16px 4px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                        {srcRow('LONG', ls)}
                        {srcRow('SHORT', ss)}
                      </div>
                    );
                  })()}
                  {symState.featureWeights && symState.featureWeights.length > 0 && (
                    <div style={{ padding: '0 16px 8px' }}>
                      {symState.featureWeights.map((fw: any) => {
                        const maxAbs = Math.max(...symState.featureWeights.map((w: any) => Math.max(Math.abs(w.longWeight), Math.abs(w.shortWeight))), 0.1)
                        const longPct = Math.abs(fw.longWeight) / maxAbs * 50
                        const shortPct = Math.abs(fw.shortWeight) / maxAbs * 50
                        return (
                          <div key={fw.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', width: '100px', textAlign: 'right' }}>{fw.name}</span>
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <div style={{ width: `${longPct}%`, height: '6px', background: fw.longWeight > 0 ? 'var(--green)' : 'var(--red)', borderRadius: '2px', opacity: 0.7 }} />
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{fw.longWeight.toFixed(2)}</span>
                            </div>
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '2px', flexDirection: 'row-reverse' }}>
                              <div style={{ width: `${shortPct}%`, height: '6px', background: fw.shortWeight > 0 ? 'var(--green)' : 'var(--red)', borderRadius: '2px', opacity: 0.7 }} />
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{fw.shortWeight.toFixed(2)}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </>
      ))}
    </div>
  )
}

function EvolutionPanel({ data }: { data: APIData | null }) {
  const evo = data?.evolution
  const [expandedSection, setExpandedSection] = useState<string | null>(null)
  const toggleSection = (id: string) => setExpandedSection(prev => prev === id ? null : id)

  if (!evo) {
    return (
      <div className="evo-panel evo-panel-top panel-rgb-border">
        <EvolutionHeader generation={0} symbolCount={0} />
        <div className="evo-empty evo-empty-top">
          <div className="evo-empty-text">Waiting for evolution data...</div>
        </div>
      </div>
    )
  }

  const symbolCount = data?.olrState?.symbols?.length ?? 0

  // Build set of open position symbols (lowercased for matching)
  const openPositionSymbols = new Set<string>()
  const portfolioPositions = data?.portfolio?.positions
  if (portfolioPositions) {
    for (const pos of Object.values(portfolioPositions) as any[]) {
      if (pos.symbol) openPositionSymbols.add(pos.symbol.toLowerCase())
    }
  }

  return (
    <div className="evo-panel evo-panel-top panel-rgb-border">
      <EvolutionHeader
        generation={evo.generation}
        symbolCount={symbolCount}
      />
      <EMCycleDigestionSection emState={data?.emState} isExpanded={expandedSection === 'em'} onToggleExpand={() => toggleSection('em')} />
      <RILSection rilState={data?.rilState} isExpanded={expandedSection === 'ril'} onToggleExpand={() => toggleSection('ril')} />
      <ExperienceDigestionSection expDigest={data?.portfolio?.expDigest} expActions={data?.expActions} isExpanded={expandedSection === 'exp'} onToggleExpand={() => toggleSection('exp')} />
      <OLRSection olrState={data?.olrState} openPositionSymbols={openPositionSymbols} isExpanded={expandedSection === 'olr'} onToggleExpand={() => toggleSection('olr')} />
    </div>
  )
}

/* ── v2.0.140: EM Cycle Digestion Section (v2.0.141: cycle chain only, insight vectors replaced by RIL) ── */

function EMCycleDigestionSection({ emState, isExpanded, onToggleExpand }: { emState?: any; isExpanded: boolean; onToggleExpand: () => void }) {
  if (!emState) return null
  const expanded = isExpanded

  const accuracyPct = emState.convergenceChecks > 0 ? (emState.convergenceAccuracy * 100).toFixed(1) : '—'
  const accuracyColor = emState.convergenceAccuracy > 0.6 ? 'var(--green)' : emState.convergenceAccuracy < 0.4 ? 'var(--red)' : 'var(--text-tertiary)'

  return (
    <div className="evo-section">
      <div className="evo-section-header" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
        <div className="evo-section-accent" />
        <span className="evo-section-title">EM Cycle Chain</span>
        <span className="evo-section-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="exp-digest-content">
          <div className="exp-pipeline-desc" style={{ marginBottom: 'var(--space-4)' }}>
            Market continuity via Meta-Agent cycle summaries · tiered memory (hot/warm/cold)
          </div>

          <div className="exp-stats-grid">
            <div className="exp-stat-card">
              <div className="exp-stat-value">{emState.summaryCount ?? 0}</div>
              <div className="exp-stat-label">Cycle Summaries</div>
            </div>
            <div className="exp-stat-card">
              <div className="exp-stat-value" style={{ color: accuracyColor }}>{accuracyPct}%</div>
              <div className="exp-stat-label">Convergence Acc</div>
            </div>
            <div className="exp-stat-card">
              <div className="exp-stat-value">{emState.convergenceChecks ?? 0}</div>
              <div className="exp-stat-label">Convergence Checks</div>
            </div>
          </div>

          {emState.latestInsight && (
            <div className="exp-digest-section">
              <div className="exp-digest-subtitle">Latest Insight</div>
              <div className="exp-lesson-item">{emState.latestInsight}</div>
              {emState.latestSignal && (
                <div className="exp-lesson-item" style={{ color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
                  Signal: {emState.latestSignal}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── v2.0.141: RIL Reason Intelligence Layer Section ── */

function RILSection({ rilState, isExpanded, onToggleExpand }: { rilState?: any; isExpanded: boolean; onToggleExpand: () => void }) {
  if (!rilState) return null
  const expanded = isExpanded

  return (
    <div className="evo-section">
      <div className="evo-section-header" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
        <div className="evo-section-accent" />
        <span className="evo-section-title">RIL Reason Intelligence</span>
        <span className="evo-section-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="exp-digest-content">
          <div className="exp-pipeline-desc" style={{ marginBottom: 'var(--space-4)' }}>
            Structured entry/close pattern reference data for Meta-Agent · greedy cosine clustering of rationale texts
          </div>

          <div className="exp-stats-grid">
            <div className="exp-stat-card">
              <div className="exp-stat-value">{rilState.patternCount ?? 0}</div>
              <div className="exp-stat-label">Pattern Clusters</div>
            </div>
            <div className="exp-stat-card">
              <div className="exp-stat-value">{rilState.tradeCount ?? 0}</div>
              <div className="exp-stat-label">Trades Analyzed</div>
            </div>
            <div className="exp-stat-card">
              <div className="exp-stat-value" style={{ color: rilState.isBuilt ? 'var(--green)' : 'var(--yellow)' }}>
                {rilState.isBuilt ? 'Active' : 'Building'}
              </div>
              <div className="exp-stat-label">Status</div>
            </div>
          </div>

          <div className="exp-digest-section">
            <div className="exp-digest-subtitle">Architecture</div>
            <div className="exp-lesson-item">
              <b>PatternClusterManager</b> — Greedy cosine clustering of entry rationale texts (MiniLM 384-d) → per-pattern WR/PnL. Injected as <code>ENTRY PATTERN PERFORMANCE</code>.
            </div>
            <div className="exp-lesson-item">
              <b>CloseReasonAggregator</b> — Pure math GROUP BY exitType+decisionOrigin → per-close-reason WR/PnL. Injected as <code>CLOSE REASON PERFORMANCE</code>.
            </div>
            <div className="exp-lesson-item">
              <b>SimilarTradeRetriever</b> — Top-N similar past trades by combination similarity. Injected as <code>SIMILAR TRADES + SUBTLE DIFFERENCES</code>.
            </div>
            <div className="exp-lesson-item" style={{ marginTop: 'var(--space-2)' }}>
              EXP and A2A Digester are kept as supplementary reference sources. Meta-Agent uses a Confidence Calibration Framework: BASE WR → adjust for close context → adjust for subtle differences → FINAL confidence → decision.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── v2.0.140: Experience Digestion Section (v2.0.141: supplementary LLM analysis) ── */

interface ParsedClass {
  count: number; winRate: number; avgHoldMin: number; directionBias: string;
  exitNote: string; lesson: string; symbols: string; netPnl: number;
}
interface ParsedSymbol {
  symbol: string; side: string; wins: number; losses: number; netPnl: number; avgHold: number; isPremature: boolean;
}

function parseDigest(raw: string): {
  streak: number; netPnl: number; total: number; wins: number; losses: number;
  exitQuality: { prematureLossCount: number; prematureLossPnl: number; isMajor: boolean; prematureWinCount: number; prematureWinPnl: number; longWinCount: number; longWinPnl: number };
  rootCause: { quickExitCount: number; quickLosses: number; quickWins: number; dominantRegime: string | null; shallowThesis: boolean; avgThesisLen: number; newsFailed: number; insight: string | null };
  volatilityAnomaly: { lowVolCount: number; total: number; pct: number; isAnomaly: boolean };
  losingClasses: ParsedClass[];
  winningClasses: ParsedClass[];
  perSymbol: ParsedSymbol[];
  closeLessons: string[];
} | null {
  try {
    const lines = raw.split('\n').filter(l => l.trim())
    // Headline is line 1 (line 0 is "=== EXPERIENCE DIGEST (from N closed trades) ===")
    // The W/L stats are on line 1: "🔴 Win rate: 35% (W8 L15) | Net PnL: 0.652 | ..."
    const hl = lines[1] ?? lines[0] ?? ''
    const streakMatch = hl.match(/losing streak:\s*(\d+)/)
    const streak = streakMatch ? parseInt(streakMatch[1]) : 0
    const pnlMatch = hl.match(/Net PnL:\s*(-?[\d.]+)/)
    const netPnl = pnlMatch ? parseFloat(pnlMatch[1]) : 0
    const wMatch = hl.match(/W(\d+)\s+L(\d+)/)
    const wins = wMatch ? parseInt(wMatch[1]) : 0
    const losses = wMatch ? parseInt(wMatch[2]) : 0
    const total = wins + losses

    // Exit quality
    const prematureLossLine = lines.find(l => l.includes('Premature close (≤8min loss)'))
    const prematureLossCount = prematureLossLine ? parseInt(prematureLossLine.match(/(\d+)\s*trades/)?.[1] ?? '0') : 0
    const prematureLossPnl = prematureLossLine ? parseFloat(prematureLossLine.match(/net\s*(-?[\d.]+)/)?.[1] ?? '0') : 0
    const isMajor = prematureLossLine?.includes('MAJOR') ?? false
    const prematureWinLine = lines.find(l => l.includes('Premature close (≤8min win)'))
    const prematureWinCount = prematureWinLine ? parseInt(prematureWinLine.match(/(\d+)\s*trades/)?.[1] ?? '0') : 0
    const prematureWinPnl = prematureWinLine ? parseFloat(prematureWinLine.match(/net\s*(-?[\d.]+)/)?.[1] ?? '0') : 0
    const longWinLine = lines.find(l => l.includes('Long holds (>30min wins)'))
    const longWinCount = longWinLine ? parseInt(longWinLine.match(/(\d+)\s*trades/)?.[1] ?? '0') : 0
    const longWinPnl = longWinLine ? parseFloat(longWinLine.match(/net\s*(-?[\d.]+)/)?.[1] ?? '0') : 0

    // Root cause
    const quickExitLine = lines.find(l => l.includes('Quick exits:'))
    const quickExitCount = quickExitLine ? parseInt(quickExitLine.match(/(\d+)\s*trades/)?.[1] ?? '0') : 0
    const quickLossMatch = quickExitLine?.match(/(\d+)\s*losses/)
    const quickWinsMatch = quickExitLine?.match(/(\d+)\s*wins/)
    const quickLosses = quickLossMatch ? parseInt(quickLossMatch[1]) : 0
    const quickWins = quickWinsMatch ? parseInt(quickWinsMatch[1]) : 0
    const regimeLine = lines.find(l => l.includes('Dominant regime at exit:'))
    const dominantRegime = regimeLine ? regimeLine.match(/at exit:\s*(\S+)/)?.[1]?.replace(/[(),]/g, '') ?? null : null
    const shallowLine = lines.find(l => l.includes('THESIS TOO SHALLOW'))
    const shallowThesis = !!shallowLine
    const avgThesisLen = shallowLine ? parseInt(shallowLine.match(/avg thesis length\s*(\d+)/)?.[1] ?? '0') : 0
    const newsLine = lines.find(l => l.includes('NEWS/MACRO thesis failed'))
    const newsFailed = newsLine ? parseInt(newsLine.match(/(\d+)\s*trades/)?.[1] ?? '0') : 0
    const insightLine = lines.find(l => l.includes('KEY INSIGHT:'))
    const insight = insightLine ? insightLine.replace(/^.*KEY INSIGHT:\s*/, '') : null

    // Volatility anomaly
    const anomalyLine = lines.find(l => l.includes('ANOMALY:') || l.includes('low_volatility'))
    const lowVolMatch = raw.match(/(\d+)\/(\d+)\s*trades.*low_volatility/)
    const lowVolCount = lowVolMatch ? parseInt(lowVolMatch[1]) : 0
    const volTotal = lowVolMatch ? parseInt(lowVolMatch[2]) : total
    const volPct = volTotal > 0 ? lowVolCount / volTotal : 0
    const isAnomaly = volPct > 0.7

    // Losing classes
    const losingClasses: ParsedClass[] = []
    const losingSection = raw.indexOf('LOSING PATTERNS')
    const winningSection = raw.indexOf('WINNING PATTERNS')
    if (losingSection >= 0) {
      const losingText = raw.slice(losingSection, winningSection >= 0 ? winningSection : raw.length)
      const classLines = losingText.split('\n').filter(l => l.trim().startsWith('❌') && l.includes('trades'))
      for (const cl of classLines) {
        const countM = cl.match(/\[(\d+)\s*trades/)
        const winM = cl.match(/win\s*(\d+)%/)
        const holdM = cl.match(/avg\s*(\d+)min/)
        const biasM = cl.match(/,\s*(buy|sell|mixed)\]/)
        const exitNote = cl.includes('PREMATURE') ? 'PREMATURE SL' : cl.includes('SL correct') ? 'SL correct' : ''
        const symbolsM = cl.match(/symbols:\s*([^\n|]+)/)
        const netM = cl.match(/net\s*(-?[\d.]+)/)
        // Lesson is the next non-empty line after the ❌ line
        const idx = losingText.indexOf(cl)
        const afterCl = losingText.slice(idx + cl.length)
        const lessonM = afterCl.match(/^\s*(.+)$/m)
        losingClasses.push({
          count: countM ? parseInt(countM[1]) : 0,
          winRate: winM ? parseInt(winM[1]) / 100 : 0,
          avgHoldMin: holdM ? parseInt(holdM[1]) : 0,
          directionBias: biasM ? biasM[1] : 'mixed',
          exitNote,
          lesson: lessonM ? lessonM[1].trim() : '',
          symbols: symbolsM ? symbolsM[1].trim() : '',
          netPnl: netM ? parseFloat(netM[1]) : 0,
        })
      }
    }

    // Winning classes
    const winningClasses: ParsedClass[] = []
    if (winningSection >= 0) {
      const winningText = raw.slice(winningSection)
      const classLines = winningText.split('\n').filter(l => l.trim().startsWith('✅') && l.includes('trades'))
      for (const cl of classLines) {
        const countM = cl.match(/\[(\d+)\s*trades/)
        const winM = cl.match(/win\s*(\d+)%/)
        const holdM = cl.match(/avg\s*(\d+)min/)
        const biasM = cl.match(/,\s*(buy|sell|mixed)\]/)
        const exitNote = cl.includes('PREMATURE TP') ? 'PREMATURE TP' : cl.includes('TP correct') ? 'TP correct' : ''
        const idx = winningText.indexOf(cl)
        const afterCl = winningText.slice(idx + cl.length)
        const lessonM = afterCl.match(/^\s*(.+)$/m)
        winningClasses.push({
          count: countM ? parseInt(countM[1]) : 0,
          winRate: winM ? parseInt(winM[1]) / 100 : 0,
          avgHoldMin: holdM ? parseInt(holdM[1]) : 0,
          directionBias: biasM ? biasM[1] : 'mixed',
          exitNote,
          lesson: lessonM ? lessonM[1].trim() : '',
          symbols: '',
          netPnl: 0,
        })
      }
    }

    // Per symbol
    const perSymbol: ParsedSymbol[] = []
    const perSymSection = raw.indexOf('PER SYMBOL/SIDE:')
    if (perSymSection >= 0) {
      const perSymText = raw.slice(perSymSection)
      const symLines = perSymText.split('\n').filter(l => l.trim().startsWith('  ') && l.includes(': W') && !l.includes('PATTERNS'))
      for (const sl of symLines) {
        const symM = sl.match(/^\s+(\S+)\s+(BUY|SELL):/)
        const wM = sl.match(/W(\d+)/)
        const lM = sl.match(/L(\d+)/)
        const netM = sl.match(/net\s*([+-]?[\d.]+)/)
        const holdM = sl.match(/avg\s*(\d+)min/)
        perSymbol.push({
          symbol: symM ? symM[1] : '',
          side: symM ? symM[2] : '',
          wins: wM ? parseInt(wM[1]) : 0,
          losses: lM ? parseInt(lM[1]) : 0,
          netPnl: netM ? parseFloat(netM[1]) : 0,
          avgHold: holdM ? parseInt(holdM[1]) : 0,
          isPremature: sl.includes('⚠️'),
        })
      }
    }

    // Close lessons
    const closeLessons: string[] = []
    const closeSection = raw.indexOf('CLOSE DISCIPLINE LESSONS')
    if (closeSection >= 0) {
      const closeText = raw.slice(closeSection)
      const lessonLines = closeText.split('\n').filter(l => l.trim().startsWith('→'))
      for (const ll of lessonLines) {
        closeLessons.push(ll.trim().replace(/^→\s*/, ''))
      }
    }

    return {
      streak, netPnl, total, wins, losses,
      exitQuality: { prematureLossCount, prematureLossPnl, isMajor, prematureWinCount, prematureWinPnl, longWinCount, longWinPnl },
      rootCause: { quickExitCount, quickLosses, quickWins, dominantRegime, shallowThesis, avgThesisLen, newsFailed, insight },
      volatilityAnomaly: { lowVolCount, total: volTotal, pct: volPct, isAnomaly },
      losingClasses, winningClasses, perSymbol, closeLessons,
    }
  } catch { return null }
}

function WinRateBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses
  if (total === 0) return null
  const winPct = (wins / total) * 100
  return (
    <div className="exp-bar-container">
      <div className="exp-bar-wins" style={{ width: `${winPct}%` }} />
      <div className="exp-bar-losses" style={{ width: `${100 - winPct}%` }} />
    </div>
  )
}

function ExitQualityBar({ count, total, color, label, pnl, isMajor }: { count: number; total: number; color: string; label: string; pnl: number; isMajor?: boolean }) {
  if (total === 0) return null
  const pct = (count / total) * 100
  return (
    <div className="exp-eq-row">
      <div className="exp-eq-label">{label}</div>
      <div className="exp-eq-bar-wrap">
        <div className="exp-eq-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="exp-eq-meta">
        <span className="exp-eq-count">{count} trades</span>
        <span className="exp-eq-pnl" style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(3)}</span>
        {isMajor && <span className="exp-eq-major">MAJOR</span>}
      </div>
    </div>
  )
}

function ClassCard({ cls, type }: { cls: ParsedClass; type: 'losing' | 'winning' }) {
  const winPct = (cls.winRate * 100).toFixed(0)
  const isPremature = cls.exitNote.includes('PREMATURE')
  return (
    <div className={`exp-class-card ${type}`}>
      <div className="exp-class-header">
        <span className="exp-class-symbols">{cls.symbols || cls.directionBias.toUpperCase()}</span>
        <span className={`exp-class-exit ${isPremature ? 'premature' : 'correct'}`}>{cls.exitNote}</span>
      </div>
      <div className="exp-class-bar-wrap">
        <div className="exp-class-bar-fill" style={{ width: `${winPct}%`, background: type === 'losing' ? 'var(--red)' : 'var(--green)' }} />
        <span className="exp-class-winrate">{winPct}%</span>
      </div>
      <div className="exp-class-meta">
        <span>{cls.count} trades</span>
        <span>·</span>
        <span>{cls.avgHoldMin}min</span>
        <span>·</span>
        <span>{cls.directionBias}</span>
        {type === 'losing' && <span style={{ color: cls.netPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>· net {cls.netPnl >= 0 ? '+' : ''}{cls.netPnl.toFixed(3)}</span>}
      </div>
      <div className="exp-class-lesson">{cls.lesson}</div>
    </div>
  )
}

/* ── v2.0.140: MiniLM Neural Pipeline visualization ── */

function MiniLMPipeline({ parsed, total }: { parsed: ReturnType<typeof parseDigest>; total: number }) {
  if (!parsed) return null
  const losingCount = parsed.losingClasses.length
  const winningCount = parsed.winningClasses.length
  const totalClasses = losingCount + winningCount
  const digestCount = total
  const embedDim = 384
  const classifyThreshold = 72

  return (
    <div className="exp-pipeline">
      <div className="exp-pipeline-title">MiniLM Neural Pipeline</div>
      <div className="exp-pipeline-desc">all-MiniLM-L6-v2 · 384-dim · in-process · transformers.js</div>

      {/* Pipeline flow */}
      <div className="exp-pipeline-flow">
        {/* Stage 1: Digest */}
        <div className="exp-pipeline-stage">
          <div className="exp-pipeline-node digest">
            <div className="exp-pipeline-node-label">Digest</div>
            <div className="exp-pipeline-node-value">{digestCount}</div>
            <div className="exp-pipeline-node-sub">closed trades</div>
          </div>
          <div className="exp-pipeline-node-desc">LLM extracts root cause + exit type from each trade</div>
        </div>

        {/* Arrow */}
        <div className="exp-pipeline-arrow">
          <div className="exp-pipeline-arrow-line" />
          <div className="exp-pipeline-arrow-head" />
        </div>

        {/* Stage 2: Embed */}
        <div className="exp-pipeline-stage">
          <div className="exp-pipeline-node embed">
            <div className="exp-pipeline-node-label">Embed</div>
            <div className="exp-pipeline-node-value">{embedDim}</div>
            <div className="exp-pipeline-node-sub">dimensions</div>
          </div>
          <div className="exp-pipeline-node-desc">MiniLM compresses lesson into 384-dim vector</div>
        </div>

        {/* Arrow */}
        <div className="exp-pipeline-arrow">
          <div className="exp-pipeline-arrow-line" />
          <div className="exp-pipeline-arrow-head" />
        </div>

        {/* Stage 3: Cluster */}
        <div className="exp-pipeline-stage">
          <div className="exp-pipeline-node cluster">
            <div className="exp-pipeline-node-label">Cluster</div>
            <div className="exp-pipeline-node-value">{totalClasses}</div>
            <div className="exp-pipeline-node-sub">experience</div>
          </div>
          <div className="exp-pipeline-node-desc">Greedy cosine clustering (≥80% similarity)</div>
        </div>

        {/* Arrow */}
        <div className="exp-pipeline-arrow">
          <div className="exp-pipeline-arrow-line" />
          <div className="exp-pipeline-arrow-head" />
        </div>

        {/* Stage 4: Classify */}
        <div className="exp-pipeline-stage">
          <div className="exp-pipeline-node classify">
            <div className="exp-pipeline-node-label">Classify</div>
            <div className="exp-pipeline-node-value">{classifyThreshold}%</div>
            <div className="exp-pipeline-node-sub">threshold</div>
          </div>
          <div className="exp-pipeline-node-desc">New thesis vs class centroids → verdict</div>
        </div>
      </div>

      {/* Neural vector visualization */}
      <div className="exp-neural-viz">
        <div className="exp-neural-label">384-dim lesson vectors → clustered into experience</div>
        <div className="exp-neural-grid">
          {Array.from({ length: 24 }, (_, i) => {
            const isLosing = i < losingCount
            const isWinning = i >= losingCount && i < totalClasses
            const isActive = isLosing || isWinning
            return (
              <div
                key={i}
                className={`exp-neural-cell ${isActive ? (isLosing ? 'losing' : 'winning') : 'dim'}`}
                style={{
                  animationDelay: `${i * 50}ms`,
                }}
              />
            )
          })}
        </div>
        <div className="exp-neural-legend">
          <span className="exp-neural-legend-item"><span className="exp-neural-dot losing" /> Losing class</span>
          <span className="exp-neural-legend-item"><span className="exp-neural-dot winning" /> Winning class</span>
          <span className="exp-neural-legend-item"><span className="exp-neural-dot dim" /> Unclustered</span>
        </div>
      </div>

      {/* Classification verdicts */}
      <div className="exp-verdicts">
        <div className="exp-verdict-row">
          <span className="exp-verdict-label approve">FAST_APPROVE</span>
          <span className="exp-verdict-desc">winning class match + direction aligned</span>
        </div>
        <div className="exp-verdict-row">
          <span className="exp-verdict-label reject">REJECT</span>
          <span className="exp-verdict-desc">losing class match + direction aligned</span>
        </div>
        <div className="exp-verdict-row">
          <span className="exp-verdict-label reverse">REVERSE_DIRECTION</span>
          <span className="exp-verdict-desc">losing class + opposite direction = contrarian edge</span>
        </div>
        <div className="exp-verdict-row">
          <span className="exp-verdict-label passthrough">PASS_OPEN_DIRECTLY</span>
          <span className="exp-verdict-desc">no class match (cold-start) → let it trade & learn</span>
        </div>
      </div>
    </div>
  )
}

function ExperienceDigestionSection({ expDigest, expActions, isExpanded, onToggleExpand }: { expDigest?: string; expActions?: Array<{ symbol: string; side: string; verdict: string; reason: string; cycle: number; ts: number }>; isExpanded: boolean; onToggleExpand: () => void }) {
  if (!expDigest && (!expActions || expActions.length === 0)) return null
  const expanded = isExpanded

  const hasStreakWarning = expDigest?.includes('losing streak:') && !expDigest?.includes('losing streak: 0')
  const parsed = expDigest ? parseDigest(expDigest) : null

  // Build action log lines
  const actionLines: string[] = []
  if (expActions && expActions.length > 0) {
    for (const a of expActions) {
      const sideLabel = a.side === 'buy' ? 'LONG' : 'SHORT'
      if (a.verdict === 'FAST_APPROVE' || a.verdict === 'APPROVE_WITH_NOTE' || a.verdict === 'PASS_OPEN_DIRECTLY') {
        actionLines.push(`根據經驗之後決定落單 ${a.symbol} ${sideLabel} — ${a.reason}`)
      } else if (a.verdict === 'REJECT') {
        actionLines.push(`根據經驗之後決定暫時唔落單 ${a.symbol} ${sideLabel} — ${a.reason}`)
      } else if (a.verdict === 'REVERSE_DIRECTION') {
        actionLines.push(`根據經驗之後決定反方向落單 ${a.symbol} — ${a.reason}`)
      } else if (a.verdict === 'EXP_DISABLED' || a.verdict === 'EXP_ERRORED') {
        actionLines.push(`經驗系統未準備好，暫時唔落單 ${a.symbol} ${sideLabel} — ${a.reason}`)
      }
    }
  }

  return (
    <div className="evo-section">
      <div className="evo-section-header" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
        <div className="evo-section-accent" />
        <span className="evo-section-title">
          Experience Digestion
          {hasStreakWarning && <span className="exp-streak-warning">●</span>}
        </span>
        <span className="evo-section-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="exp-digest-content">
          {/* Action log */}
          {actionLines.length > 0 && (
            <div className="exp-digest-section">
              <div className="exp-digest-subtitle">Experience Decisions</div>
              {actionLines.map((l, i) => (
                <div key={i} className="exp-digest-action">{l}</div>
              ))}
            </div>
          )}

          {parsed && (
            <>
              {/* MiniLM Neural Pipeline visualization */}
              <MiniLMPipeline parsed={parsed} total={parsed.total} />

              {/* Dual-Channel Fusion indicator */}
              <div className="exp-fusion-banner">
                <div className="exp-fusion-channel semantic">
                  <div className="exp-fusion-ch-label">Semantic</div>
                  <div className="exp-fusion-ch-value">MiniLM</div>
                  <div className="exp-fusion-ch-desc">{parsed.total} trades · {parsed.losingClasses.length + parsed.winningClasses.length} classes</div>
                </div>
                <div className="exp-fusion-link" />
                <div className="exp-fusion-channel statistical">
                  <div className="exp-fusion-ch-label">Statistical</div>
                  <div className="exp-fusion-ch-value">OLR + Shadow</div>
                  <div className="exp-fusion-ch-desc">P(win) cross-reference</div>
                </div>
              </div>

              {/* Headline stats grid */}
              <div className="exp-stats-grid">
                <div className="exp-stat-card">
                  <div className="exp-stat-value" style={{ color: parsed.netPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {parsed.netPnl >= 0 ? '+' : ''}{parsed.netPnl.toFixed(3)}
                  </div>
                  <div className="exp-stat-label">Net PnL</div>
                </div>
                <div className="exp-stat-card">
                  <div className="exp-stat-value">{parsed.wins}<span className="exp-stat-sep">/</span>{parsed.losses}</div>
                  <div className="exp-stat-label">W / L</div>
                </div>
                <div className="exp-stat-card">
                  <div className="exp-stat-value">{parsed.total}</div>
                  <div className="exp-stat-label">Trades</div>
                </div>
                <div className="exp-stat-card">
                  <div className={`exp-stat-value ${parsed.streak >= 3 ? 'streak-warn' : ''}`}>
                    {parsed.streak}
                  </div>
                  <div className="exp-stat-label">Streak</div>
                </div>
              </div>

              {/* W/L bar */}
              <div className="exp-wl-bar-section">
                <WinRateBar wins={parsed.wins} losses={parsed.losses} />
                <div className="exp-wl-labels">
                  <span className="exp-wl-win">W {parsed.wins}</span>
                  <span className="exp-wl-loss">L {parsed.losses}</span>
                </div>
              </div>

              {/* Exit quality */}
              <div className="exp-digest-section">
                <div className="exp-digest-subtitle">Exit Quality</div>
                <ExitQualityBar
                  count={parsed.exitQuality.prematureLossCount}
                  total={parsed.losses}
                  color="var(--red)"
                  label="Premature close (loss)"
                  pnl={parsed.exitQuality.prematureLossPnl}
                  isMajor={parsed.exitQuality.isMajor}
                />
                <ExitQualityBar
                  count={parsed.exitQuality.prematureWinCount}
                  total={parsed.wins}
                  color="var(--green)"
                  label="Premature close (win)"
                  pnl={parsed.exitQuality.prematureWinPnl}
                />
                {parsed.exitQuality.longWinCount > 0 && (
                  <ExitQualityBar
                    count={parsed.exitQuality.longWinCount}
                    total={parsed.wins}
                    color="var(--accent)"
                    label="Long holds (win)"
                    pnl={parsed.exitQuality.longWinPnl}
                  />
                )}
              </div>

              {/* Close discipline lessons */}
              {parsed.closeLessons.length > 0 && (
                <div className="exp-digest-section">
                  <div className="exp-digest-subtitle">Close Discipline</div>
                  {parsed.closeLessons.map((l, i) => (
                    <div key={i} className="exp-lesson-item">{l}</div>
                  ))}
                </div>
              )}

              {/* Losing + Winning patterns side by side */}
              <div className="exp-patterns-grid">
                {parsed.losingClasses.length > 0 && (
                  <div className="exp-patterns-col">
                    <div className="exp-digest-subtitle">Losing Patterns</div>
                    {parsed.losingClasses.map((c, i) => <ClassCard key={i} cls={c} type="losing" />)}
                  </div>
                )}
                {parsed.winningClasses.length > 0 && (
                  <div className="exp-patterns-col">
                    <div className="exp-digest-subtitle">Winning Patterns</div>
                    {parsed.winningClasses.map((c, i) => <ClassCard key={i} cls={c} type="winning" />)}
                  </div>
                )}
              </div>

              {/* Per symbol table */}
              {parsed.perSymbol.length > 0 && (
                <div className="exp-digest-section">
                  <div className="exp-digest-subtitle">Per Symbol</div>
                  <div className="exp-symbol-table">
                    {parsed.perSymbol.map((s, i) => {
                      const total = s.wins + s.losses
                      const winPct = total > 0 ? (s.wins / total) * 100 : 0
                      return (
                        <div key={i} className="exp-symbol-row">
                          <span className="exp-sym-name">{s.symbol}</span>
                          <span className={`exp-sym-side ${s.side.toLowerCase()}`}>{s.side}</span>
                          <div className="exp-sym-bar-wrap">
                            <div className="exp-sym-bar-fill" style={{ width: `${winPct}%`, background: s.netPnl >= 0 ? 'var(--green)' : 'var(--red)' }} />
                          </div>
                          <span className="exp-sym-wl">W{s.wins} L{s.losses}</span>
                          <span className="exp-sym-net" style={{ color: s.netPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{s.netPnl >= 0 ? '+' : ''}{s.netPnl.toFixed(3)}</span>
                          <span className="exp-sym-hold">{s.avgHold}min{s.isPremature ? ' !' : ''}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Volatility anomaly */}
              {parsed.volatilityAnomaly.isAnomaly && (
                <div className="exp-anomaly-banner">
                  <div>
                    <div className="exp-anomaly-title">VOLATILITY ANOMALY</div>
                    <div className="exp-anomaly-desc">
                      {parsed.volatilityAnomaly.lowVolCount}/{parsed.volatilityAnomaly.total} trades ({(parsed.volatilityAnomaly.pct * 100).toFixed(0)}%) show low_volatility — NO normal/high.
                      Volatility calculation likely broken.
                    </div>
                  </div>
                </div>
              )}

              {/* Root cause diagnosis */}
              {parsed.rootCause.insight && (
                <div className="exp-digest-section">
                  <div className="exp-digest-subtitle">Root Cause</div>
                  {parsed.rootCause.quickExitCount > 0 && (
                    <div className="exp-lesson-item">
                      Quick exits: {parsed.rootCause.quickExitCount} trades — {parsed.rootCause.quickLosses} losses, {parsed.rootCause.quickWins} wins
                    </div>
                  )}
                  {parsed.rootCause.dominantRegime && (
                    <div className="exp-lesson-item">Dominant regime: {parsed.rootCause.dominantRegime}</div>
                  )}
                  {parsed.rootCause.shallowThesis && (
                    <div className="exp-lesson-item">Thesis too shallow: avg {parsed.rootCause.avgThesisLen} chars — no structural anchor</div>
                  )}
                  {parsed.rootCause.newsFailed > 0 && (
                    <div className="exp-lesson-item">News/macro thesis failed ≤8min: {parsed.rootCause.newsFailed} trades</div>
                  )}
                  <div className="exp-lesson-item exp-lesson-insight">{parsed.rootCause.insight}</div>
                </div>
              )}
            </>
          )}

          {/* Fallback: raw text if parse failed */}
          {!parsed && expDigest && (
            <div className="exp-digest-raw">
              {expDigest.split('\n').filter(l => l.trim()).map((l, i) => (
                <div key={i} className="exp-digest-detail">{l}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ModelConfigPanel({ data, onUpdate }: { data: APIData | null; onUpdate: () => void }) {
  const [statusMsg, setStatusMsg] = useState('')
  const [statusVisible, setStatusVisible] = useState(false)

  const assignments = data?.agentModels?.assignments ?? []
  const available = data?.agentModels?.available ?? []

  const handleChange = async (role: string, modelId: string) => {
    try {
      const res = await fetch(`${API_BASE}/models/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, model: modelId }),
      })
      const result = await res.json()
      if (result.success) {
        setStatusMsg(`✓ ${role} → ${modelId.split('/').pop()}`)
        setStatusVisible(true)
        setTimeout(() => setStatusVisible(false), 2000)
        onUpdate()
      }
    } catch { /* ignore */ }
  }

  const handleReset = async (role: string) => {
    try {
      await fetch(`${API_BASE}/models/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      setStatusMsg(`✓ ${role} reset to default`)
      setStatusVisible(true)
      setTimeout(() => setStatusVisible(false), 2000)
      onUpdate()
    } catch { /* ignore */ }
  }

  return (
    <div className="model-config-panel">
      <div className="panel-header">
        <span className="panel-title">Agent Model Config</span>
      </div>
      {AGENT_ROLES.map(role => {
        const meta = AGENT_META[role]
        const current = assignments.find((a: AgentModelConfig) => a.role === role)
        return (
          <div key={role} className="model-row">
            <div className="model-row-agent">
              <span className="model-row-dot" style={{background: meta?.color}} />
              <span className="model-row-name">{meta?.short ?? role}</span>
            </div>
            <select
              className="model-select"
              value={current?.model ?? ''}
              onChange={e => handleChange(role, e.target.value)}
            >
              {available.map((m: ModelDefinition) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button className="model-reset-btn" onClick={() => handleReset(role)}>Reset</button>
          </div>
        )
      })}
      <div className={`model-status ${statusVisible ? '' : 'hidden'}`}>{statusMsg}</div>
    </div>
  )
}

/* ── Backtest Panel ── */

function BacktestPanel({ data, onRun }: { data: APIData | null; onRun: (years: number, model?: string, interval?: string, reverse?: boolean) => void }) {
  const bt = data?.backtest
  const bp = data?.backtestProgress
  const isRunning = bp != null && bp.phase !== 'complete' && bp.phase !== 'error'
  const isPaused = bp?.phase === 'paused'
  const [selectedYears, setSelectedYears] = useState(3)
  const [selectedInterval, setSelectedInterval] = useState('1h')
  const [selectedModel, setSelectedModel] = useState('kimi-k2.6:cloud')
  const [reverseMode, setReverseMode] = useState(false)

  const availableModels = data?.agentModels?.available ?? []
  const backtestModels = availableModels.filter(m => m.provider === 'ollama')

  const handleRun = async () => {
    onRun(selectedYears, selectedModel, selectedInterval, reverseMode)
  }

  const handlePause = async () => {
    try { await fetch('/api/backtest/pause', { method: 'POST' }) } catch {}
  }

  const handleResume = async () => {
    try { await fetch('/api/backtest/resume', { method: 'POST' }) } catch {}
  }

  const handleStop = async () => {
    try { await fetch('/api/backtest/stop', { method: 'POST' }) } catch {}
  }

  const phaseIcon = bp?.phase === 'fetching' ? '📡' : bp?.phase === 'processing' ? '⚙️' : bp?.phase === 'evolving' ? '🧬' : bp?.phase === 'error' ? '❌' : bp?.phase === 'paused' ? '⏸️' : '▶'

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">📜 Backtest</span>
        {bt && !isRunning && <span className="panel-badge">{bt.years}yr · {bt.interval ?? selectedInterval} · {bt.candlesProcessed} candles{reverseMode ? ' 🔄' : ''}</span>}
        {isRunning && <span className="panel-badge backtest-phase-badge">{phaseIcon} {bp!.phase}</span>}
      </div>

      {/* Controls */}
      <div className="backtest-controls">
        <div className="backtest-year-selector">
          {[1, 3, 5, 7, 10, 12].map(y => (
            <button
              key={y}
              className={`year-btn ${selectedYears === y ? 'active' : ''}`}
              onClick={() => setSelectedYears(y)}
              disabled={isRunning}
            >
              {y}yr
            </button>
          ))}
        </div>
        <select
          className="model-select backtest-year-btn"
          value={selectedInterval}
          onChange={e => setSelectedInterval(e.target.value)}
          disabled={isRunning}
        >
          <option value="5m">5m</option>
          <option value="1h">1h</option>
          <option value="1d">1d</option>
          <option value="1w">1w</option>
        </select>
        <select
          className="model-select backtest-year-btn-wide"
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          disabled={isRunning}
        >
          {backtestModels.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button
          className={`header-btn backtest-run-btn ${reverseMode ? 'shutdown-btn' : ''}`}
          onClick={() => setReverseMode(v => !v)}
          disabled={isRunning}
          title="Reverse mode: process newest → oldest (contrarian analysis)"
        >
          <span className="btn-label">🔄</span>
        </button>
        {isRunning && !isPaused && (
          <button
            className="header-btn backtest-btn-pad"
            onClick={handlePause}
            title="Pause backtest"
          >
            <span className="btn-label">⏸️</span>
          </button>
        )}
        {isRunning && (
          <button
            className="header-btn shutdown-btn backtest-btn-pad"
            onClick={handleStop}
            title="Stop/cancel backtest"
          >
            <span className="btn-label">⏹️</span>
          </button>
        )}
        {isPaused && (
          <button
            className="header-btn trigger-btn backtest-btn-pad"
            onClick={handleResume}
            title="Resume backtest"
          >
            <span className="btn-label">▶️</span>
          </button>
        )}
        <button
          className="header-btn trigger-btn"
          onClick={handleRun}
          disabled={isRunning}
          style={{ opacity: isRunning ? 0.5 : 1 }}
        >
          <span className="btn-icon">{isRunning ? '⟳' : '▶'}</span>
          <span className="btn-label">{isRunning ? 'Running...' : 'Run'}</span>
        </button>
      </div>

      {/* Live Progress Bar */}
      {isRunning && bp && (
        <div className="backtest-progress-wrap">
          <div className="backtest-progress-bar">
            <div
              className="backtest-progress-fill"
              style={{ width: `${bp.progressPct}%` }}
            />
          </div>
          <div className="backtest-progress-info">
            <span className="backtest-progress-phase">{phaseIcon} {bp.phase.toUpperCase()}</span>
            <span className="backtest-progress-text">{bp.message}</span>
            <span className="backtest-progress-pct">{bp.progressPct.toFixed(0)}%</span>
          </div>
          {bp.totalCandles > 0 && (
            <div className="backtest-progress-candles">
              Candles: {bp.candlesProcessed}/{bp.totalCandles}
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {bp?.phase === 'error' && !bt && (
        <div className="empty-state">
          <div className="empty-icon">❌</div>
          <div className="empty-text">Backtest Failed</div>
          <div className="empty-hint">{bp.message}</div>
        </div>
      )}

      {/* Results */}
      {bt ? (
        <>
          {/* Summary metrics */}
          <div className="portfolio-grid portfolio-grid-top">
            <div className="portfolio-cell">
              <span className="stat-label">Total Return</span>
              <span className={`stat-number ${bt.finalReturnPct >= 0 ? 'positive' : 'negative'}`}>
                {bt.finalReturnPct >= 0 ? '+' : ''}{bt.finalReturnPct.toFixed(2)}%
              </span>
            </div>
            <div className="portfolio-cell">
              <span className="stat-label">Max Drawdown</span>
              <span className={`stat-number ${bt.maxDrawdownPct < 15 ? 'neutral' : 'negative'}`}>
                -{bt.maxDrawdownPct.toFixed(2)}%
              </span>
            </div>
            <div className="portfolio-cell">
              <span className="stat-label">Sharpe</span>
              <span className={`stat-number ${bt.sharpeRatio >= 1 ? 'positive' : 'neutral'}`}>
                {bt.sharpeRatio.toFixed(2)}
              </span>
            </div>
            <div className="portfolio-cell">
              <span className="stat-label">Win Rate</span>
              <span className={`stat-number ${bt.winRate >= 0.5 ? 'positive' : 'neutral'}`}>
                {(bt.winRate * 100).toFixed(1)}%
              </span>
            </div>
            <div className="portfolio-cell">
              <span className="stat-label">Total Trades</span>
              <span className="stat-number neutral">{bt.totalTrades}</span>
            </div>
            <div className="portfolio-cell">
              <span className="stat-label">Duration</span>
              <span className="stat-number neutral">{(bt.durationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          {/* Signal distribution */}
          <div className="panel-header signal-header">
            <span className="panel-title signal-title">Signal Distribution</span>
          </div>
          <div className="backtest-signals">
            <div className="signal-bar">
              <div className="signal-segment signal-buy" style={{flex: bt.buySignals}} title={`BUY: ${bt.buySignals}`} />
              <div className="signal-segment signal-sell" style={{flex: bt.sellSignals}} title={`SELL: ${bt.sellSignals}`} />
              <div className="signal-segment signal-hold" style={{flex: bt.holdSignals}} title={`HOLD: ${bt.holdSignals}`} />
            </div>
            <div className="signal-labels">
              <span className="signal-label signal-buy-label">B:{bt.buySignals}</span>
              <span className="signal-label signal-sell-label">S:{bt.sellSignals}</span>
              <span className="signal-label signal-hold-label">H:{bt.holdSignals}</span>
            </div>
          </div>

          {/* Equity curve (simplified sparkline) */}
          {bt.equityCurve && bt.equityCurve.length > 1 && (
            <>
              <div className="panel-header signal-header">
                <span className="panel-title signal-title">Accumulated P&L</span>
                <span className="panel-badge">
                  ${bt.equityCurve[0]?.equity.toFixed(0)} → ${bt.equityCurve[bt.equityCurve.length - 1]?.equity.toFixed(0)}
                </span>
              </div>
              <div className="equity-chart">
                {bt.equityCurve.filter((_, i) => i % Math.max(1, Math.floor(bt.equityCurve.length / 60)) === 0).map((pt, i, arr) => {
                  const min = Math.min(...arr.map(p => p.equity))
                  const max = Math.max(...arr.map(p => p.equity))
                  const range = max - min || 1
                  const height = ((pt.equity - min) / range) * 100
                  const isUp = pt.equity >= (arr[Math.max(0, i - 1)]?.equity ?? pt.equity)
                  return (
                    <div
                      key={i}
                      className="equity-bar"
                      style={{
                        height: `${Math.max(3, height)}%`,
                        background: isUp ? 'var(--green)' : 'var(--red)',
                        opacity: 0.7 + (height / 100) * 0.3,
                      }}
                      title={`${pt.date}: $${pt.equity.toFixed(0)}`}
                    />
                  )
                })}
              </div>
            </>
          )}

          {/* Regime distribution */}
          {Object.keys(bt.regimeDistribution).length > 0 && (
            <>
              <div className="panel-header signal-header">
                <span className="panel-title signal-title">Regime Distribution</span>
              </div>
              <div className="regime-list">
                {Object.entries(bt.regimeDistribution)
                  .sort(([, a], [, b]) => b - a)
                  .map(([regime, count]) => {
                    const total = Object.values(bt.regimeDistribution).reduce((a, b) => a + b, 0)
                    const pct = ((count / total) * 100).toFixed(1)
                    return (
                      <div key={regime} className="regime-row">
                        <span className="regime-name">{regime.replace(/_/g, ' ')}</span>
                        <div className="regime-bar-track">
                          <div className="regime-bar-fill" style={{width: `${pct}%`}} />
                        </div>
                        <span className="regime-pct">{pct}%</span>
                      </div>
                    )
                  })}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">📜</div>
          <div className="empty-text">No backtest data yet</div>
          <div className="empty-hint">Select years above and click "Run Backtest" to analyze historical data</div>
        </div>
      )}
    </div>
  )
}

/* ── Main App ── */

// v2.0.79: Options Data Layer removed — options info integrated into HACP Debate.
// Order: Agent Cognition, HACP Debate, Portfolio, Evolution.
// v2.0.119: DESKTOP_PANELS moved inside App() so it can access ollamaPlan state.

export default function App() {
  const [data, setData] = useState<APIData | null>(null)
  const [connected, setConnected] = useState(false)
  const [activeTab, setActiveTab] = useState<'status' | 'agents' | 'portfolio' | 'debate' | 'evolution' | 'backtest'>('agents')
  const esRef = useRef<EventSource | null>(null)
  // v2.0.78: Masonry — measure all panels, assign to shorter column
  const [colAssignments, setColAssignments] = useState<number[]>([])
  const stagingRef = useRef<HTMLDivElement | null>(null)
  // v2.0.116: Settings modal state
  const [showSettings, setShowSettings] = useState(false)
  const [envSettings, setEnvSettings] = useState<Record<string, string>>({})
  const [envSettingsLoading, setEnvSettingsLoading] = useState(false)
  // v2.0.140: Reset trade history — moved to Settings Danger Zone with 3-step confirmation
  const [resetStatus, setResetStatus] = useState('')
  const [resetStep, setResetStep] = useState(0) // 0=hidden, 1=warning, 2=type confirm, 3=executing
  const [resetConfirmText, setResetConfirmText] = useState('')

  const handleResetTradeHistory = async () => {
    setResetStep(3)
    try {
      const res = await fetch(`${API_BASE}/evolution/reset-trade-history`, { method: 'POST' })
      if ((await res.json()).success) {
        setResetStatus('Reset complete')
        setResetStep(0)
        setResetConfirmText('')
        setTimeout(() => setResetStatus(''), 3000)
      }
    } catch {
      setResetStatus('Reset failed')
      setResetStep(0)
      setResetConfirmText('')
    }
  }
  // v2.0.117: Shutdown confirmation modal state
  const [showShutdown, setShowShutdown] = useState(false)
  const [shutdownLoading, setShutdownLoading] = useState(false)
  // v2.0.117: Ollama plan info
  const [ollamaPlan, setOllamaPlan] = useState<string>('')
  // v2.0.120: Ref for plan polling interval
  const planPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // v2.0.123: Consecutive 'None' plan readings — require 2 in a row before
  // auto-pausing, so a single transient 500/timeout from Ollama (common when
  // 8 agents are hitting it concurrently) doesn't pause the system.
  const nonePlanCountRef = useRef<number>(0)

  // v2.0.119: DESKTOP_PANELS defined inside App() so it can access ollamaPlan
  const DESKTOP_PANELS: Array<(data: APIData | null) => React.ReactNode> = [
    (data) => <PreferencePanel key="preference" data={data} />,
    (data) => <AgentPanel key="agents" data={data} ollamaPlan={ollamaPlan} />,
    (data) => <DebatePanel key="debate" data={data} />,
    (data) => <PortfolioPanel key="portfolio" data={data} />,
    (data) => <EvolutionPanel key="evolution" data={data} />,
  ]

  const connectSSE = useCallback(() => {
    // Close existing connection if any
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    const es = new EventSource(`${API_BASE}/events`)
    esRef.current = es
    es.onopen = async () => {
      setConnected(true)
      // v2.0.117: Fetch Ollama plan info on connect
      try {
        const res = await fetch(`${API_BASE}/settings/ollama-plan`)
        const json = await res.json()
        if (json.success) {
          setOllamaPlan(json.plan)
          // v2.0.123: Require 2 consecutive 'None' readings before auto-pausing.
          // A single transient None (Ollama busy/overloaded) should not pause.
          if (json.plan === 'None') {
            nonePlanCountRef.current += 1
            if (nonePlanCountRef.current >= 2) {
              try { await fetch(`${API_BASE}/pause`, { method: 'POST' }) } catch { /* ignore */ }
            }
          } else {
            nonePlanCountRef.current = 0
          }
        }
      } catch { /* ignore */ }
    }

    // v2.0.120: Poll Ollama plan every 30s to detect disconnection
    const planPoll = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/settings/ollama-plan`)
        const json = await res.json()
        if (json.success) {
          const newPlan = json.plan
          setOllamaPlan(prev => {
            // v2.0.123: Require 2 consecutive 'None' readings before auto-pausing.
            // A transient 500/timeout when Ollama is busy serving 8 agents should
            // not pause the system. Only persistently being signed out pauses.
            if (newPlan === 'None' && prev !== 'None') {
              nonePlanCountRef.current += 1
              if (nonePlanCountRef.current >= 2) {
                fetch(`${API_BASE}/pause`, { method: 'POST' }).catch(() => {})
              }
            } else if (newPlan !== 'None') {
              nonePlanCountRef.current = 0
            }
            return newPlan
          })
        }
      } catch { /* ignore */ }
    }, 30000)
    planPollRef.current = planPoll
    es.onmessage = (event) => {
      try {
        const parsed: APIData = JSON.parse(event.data)
        setData(parsed)
      } catch { /* ignore */ }
    }
    es.onerror = () => {
      setConnected(false)
      // v2.0.120: Clear plan polling interval on disconnect
      if (planPollRef.current) {
        clearInterval(planPollRef.current)
        planPollRef.current = null
      }
      // Auto-reconnect after 2s
      es.close()
      esRef.current = null
      setTimeout(() => connectSSE(), 2000)
    }
  }, [])

  const handleRunCycle = useCallback(async () => {
    // If disconnected, reconnect SSE first
    if (!connected) {
      connectSSE()
      // Wait a moment for connection to establish
      await new Promise(r => setTimeout(r, 500))
    }
    try {
      await fetch(`${API_BASE}/cycle/trigger`, { method: 'POST' })
    } catch { /* ignore */ }
  }, [connected, connectSSE])

  const handleRunBacktest = useCallback(async (years: number, model?: string, interval?: string, reverse?: boolean) => {
    try {
      await fetch(`${API_BASE}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ years, symbol: 'BTCUSDT', interval: interval ?? '1h', maxCandles: 1000, model, reverse }),
      })
    } catch { /* ignore */ }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/models`)
      const models = await res.json()
      if (data) {
        setData({ ...data, agentModels: models })
      }
    } catch { /* ignore */ }
  }, [data])

  useEffect(() => {
    connectSSE()
    return () => {
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }, [connectSSE])

  // v2.0.78: Masonry layout — measure staging panel heights, assign
  // each panel to the shorter column. Recomputes on data change.
  useLayoutEffect(() => {
    const staging = stagingRef.current
    if (!staging) return
    const wrappers = staging.querySelectorAll('[data-panel-idx]')
    if (wrappers.length === 0) return

    const heights = Array.from(wrappers).map(w => w.getBoundingClientRect().height)
    const colHeights = [0, 0]
    const assignments: number[] = []
    for (let i = 0; i < heights.length; i++) {
      const targetCol = colHeights[0] <= colHeights[1] ? 0 : 1
      assignments.push(targetCol)
      colHeights[targetCol] += heights[i]!
    }
    setColAssignments(assignments)
  }, [data])

  const s = data?.status

  return (
    <div className="app">
      {/* Top Bar */}
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-brand">
            <span className="brand-text">{"{"}</span><span className="brand-name">MATS</span><span className="brand-text">{"}"}</span>
            {ollamaPlan && <span className={`brand-plan brand-plan-${ollamaPlan.toLowerCase()}`}>Ollama {ollamaPlan}</span>}
          </div>
          <div className="glow-line" />
        </div>
        <div className="topbar-right">
          <button className="header-btn icon-btn settings-btn" title="Settings" onClick={async () => {
            try {
              const res = await fetch(`${API_BASE}/settings/env`)
              const json = await res.json()
              if (json.success) setEnvSettings(json.settings)
            } catch { /* ignore */ }
            setShowSettings(true)
          }}>
            <Settings size={21} />
          </button>
          <button className={`header-btn icon-btn pause-btn ${data?.systemPaused ? 'paused' : ''}`} onClick={async () => {
            try {
              const isPaused = data?.systemPaused
              if (isPaused) {
                // Resume + trigger immediate cycle
                await fetch(`${API_BASE}/resume`, { method: 'POST' })
                // Also reconnect SSE if needed, then trigger cycle
                if (!connected) {
                  connectSSE()
                  await new Promise(r => setTimeout(r, 500))
                }
                await fetch(`${API_BASE}/cycle/trigger`, { method: 'POST' })
              } else {
                // Pause system
                await fetch(`${API_BASE}/pause`, { method: 'POST' })
              }
            } catch {}
          }} title={data?.systemPaused ? 'Resume system + run cycle' : 'Pause system (RBC only)'}>
            {data?.systemPaused ? <Play size={21} /> : <Pause size={21} />}
          </button>
          <button className="header-btn icon-btn shutdown-btn" title="Shutdown system" onClick={() => setShowShutdown(true)}>
            <Power size={21} />
          </button>
        </div>
      </header>

      {/* Mobile Tab Bar — hidden on desktop */}
      <div className="tab-bar">
        {(['agents','portfolio','debate','evolution'] as const).map(tab => {
          const posCount = tab === 'portfolio' ? (data?.status?.positions ?? 0) : 0
          return (
            <button key={tab} className={`tab-btn ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
              {tab === 'agents' ? 'Agents' : tab === 'portfolio' ? (posCount > 0 ? <><span className="tab-badge">{posCount}</span>Portfolio</> : 'Portfolio') : tab === 'debate' ? 'Debate' : 'Evolution'}
            </button>
          )
        })}
      </div>

      {/* Main Grid — desktop: JS masonry; mobile: tab-based */}
      <div className="main-grid">
        {/* Mobile: original tab-based layout */}
        <div className={`col-left ${activeTab === 'agents' || activeTab === 'debate' ? 'visible' : ''}`}>
          <div className="mobile-only">
            {activeTab === 'agents' && <PreferencePanel data={data} />}
            {activeTab === 'agents' && <AgentPanel data={data} ollamaPlan={ollamaPlan} />}
          </div>
          <div className="mobile-only">
            {activeTab === 'debate' && <DebatePanel data={data} />}
          </div>
        </div>
        <div className={`col-right ${activeTab === 'portfolio' || activeTab === 'evolution' ? 'visible' : ''}`}>
          <div className="mobile-only">
            {activeTab === 'portfolio' && <PortfolioPanel data={data} />}
            {activeTab === 'evolution' && <EvolutionPanel data={data} />}
          </div>
        </div>

        {/* Desktop: JS masonry — panels distributed to shorter column */}
        <div className="desktop-only">
          <div className="masonry-grid">
            <div className="masonry-col">
              {colAssignments.map((col, i) => col === 0 ? DESKTOP_PANELS[i]!(data) : null)}
            </div>
            <div className="masonry-col">
              {colAssignments.map((col, i) => col === 1 ? DESKTOP_PANELS[i]!(data) : null)}
            </div>
          </div>
          {/* Hidden staging area to measure panel heights */}
          <div ref={stagingRef} className="masonry-staging" aria-hidden="true">
            {DESKTOP_PANELS.map((fn, i) => (
              <div key={i} data-panel-idx={i}>{fn(data)}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="footer">
        <span className="footer-brand">{"{"}</span><span className="footer-name">MATS</span><span className="footer-brand">{"}"}</span>
        <span className="footer-motto">Capital Preservation First. Never Blow Up. Continuously Evolve.</span>
        {s && <span>Uptime: {Math.floor(s.cycles * 60 / 60)}h</span>}
      </footer>

      {/* v2.0.116: Settings Modal */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
            <div className="settings-modal-header">
              <span className="settings-modal-title">⚙️ Settings</span>
              <button className="settings-modal-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="settings-modal-body">
              {/* ── Section 1: Real Trade ── */}
              <div className="settings-section">
                <div className="settings-section-title">Real Trade</div>
                {/* HYPERLIQUID_WALLET_ADDRESS */}
                <div className="settings-field">
                  <label className="settings-label">HYPERLIQUID_WALLET_ADDRESS</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={envSettings['HYPERLIQUID_WALLET_ADDRESS'] ?? ''}
                    onChange={e => setEnvSettings(prev => ({ ...prev, HYPERLIQUID_WALLET_ADDRESS: e.target.value }))}
                    placeholder="0x..."
                  />
                  <p className="settings-hint">
                    Your Arbitrum wallet address for Hyperliquid trading. Required for real trading mode + real-time position/fill sync via WebSocket.
                    <br />📍 Get it from <a href="https://app.hyperliquid.xyz" target="_blank" rel="noopener noreferrer" className="settings-link">Hyperliquid</a> → top-right wallet button → copy address.
                  </p>
                </div>
                {/* HYPERLIQUID_PRIVATE_KEY */}
                <div className="settings-field">
                  <label className="settings-label">HYPERLIQUID_PRIVATE_KEY</label>
                  <input
                    type="password"
                    className="settings-input"
                    value={envSettings['HYPERLIQUID_PRIVATE_KEY'] ?? ''}
                    onChange={e => setEnvSettings(prev => ({ ...prev, HYPERLIQUID_PRIVATE_KEY: e.target.value }))}
                    placeholder="64 hex chars (secp256k1)"
                  />
                  <p className="settings-hint">
                    Your wallet's private key (secp256k1, 64 hex chars). Used to sign EIP-712 orders on Hyperliquid.
                    <br />📍 Export from your wallet (MetaMask → Account Details → Show Private Key, or Rabby → Export). ⚠️ Never share this with anyone.
                  </p>
                </div>
              </div>

              {/* ── Section 2: AI Provider ── */}
              <div className="settings-section">
                <div className="settings-section-title">AI Provider</div>
                {/* OLLAMA_API_KEY */}
                <div className="settings-field">
                  <label className="settings-label">OLLAMA_API_KEY</label>
                  <input
                    type="password"
                    className="settings-input"
                    value={envSettings['OLLAMA_API_KEY'] ?? ''}
                    onChange={e => setEnvSettings(prev => ({ ...prev, OLLAMA_API_KEY: e.target.value }))}
                    placeholder="ollama API key (optional)"
                  />
                  <p className="settings-hint">
                    Ollama API key for cloud model access. Without this, the system uses local models only (slower, limited concurrency for personal devices).
                    <br />📍 Get it from <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="settings-link">ollama.com</a> → Settings → API Keys.
                    <br />💡 <strong>Recommended:</strong> Upgrade to <a href="https://ollama.com/pricing" target="_blank" rel="noopener noreferrer" className="settings-link">Ollama Pro</a> ($20/mo) for cloud models like <code>deepseek-v4-flash:cloud</code>, <code>kimi-k2.6:cloud</code>, <code>glm-5.2:cloud</code>. Pro gives faster inference, 8-agent concurrent requests, and no local GPU required — making trading decisions more reliable and timely, directly improving profitability.
                  </p>
                </div>
                {/* MASSIVE_API_KEY */}
                <div className="settings-field">
                  <label className="settings-label">MASSIVE_API_KEY</label>
                  <input
                    type="password"
                    className="settings-input"
                    value={envSettings['MASSIVE_API_KEY'] ?? ''}
                    onChange={e => setEnvSettings(prev => ({ ...prev, MASSIVE_API_KEY: e.target.value }))}
                    placeholder="massive.com API key (optional)"
                  />
                  <p className="settings-hint">
                    Massive.com (Polygon.io compatible) API key for options data. Provides IV Rank, Greeks, Put/Call ratio, Gamma regime, Implied Move — used for Stocks/Indices/Commodities trading to improve win rate and expectancy.
                    <br />📍 Get it from <a href="https://massive.com" target="_blank" rel="noopener noreferrer" className="settings-link">massive.com</a> → API Keys. Optional — system works without it (agents fall back to defaults).
                  </p>
                </div>
                {/* OLLAMA_PLAN */}
                <div className="settings-field">
                  <label className="settings-label">OLLAMA_PLAN</label>
                  <select
                    className="settings-input settings-select"
                    value={envSettings['OLLAMA_PLAN'] ?? 'auto'}
                    onChange={e => setEnvSettings(prev => ({ ...prev, OLLAMA_PLAN: e.target.value }))}
                  >
                    <option value="auto">Auto-detect (defaults to Pro if cloud models found)</option>
                    <option value="Free">Free (local models only)</option>
                    <option value="Pro">Pro (cloud models, standard rate limits)</option>
                    <option value="Max">Max (cloud models, highest rate limits + concurrency)</option>
                  </select>
                  <p className="settings-hint">
                    Your Ollama subscription plan. Used for display in the header badge. Ollama API does not expose plan info, so select manually.
                    <br />💡 If unsure, leave as <strong>Auto-detect</strong> — the system will check if cloud models are available and default to Pro.
                  </p>
                </div>
              </div>

              {/* ── Section 3: Notice ── */}
              <div className="settings-section">
                <div className="settings-section-title">Notice</div>
                {/* TELEGRAM_BOT_API */}
                <div className="settings-field">
                  <label className="settings-label">TELEGRAM_BOT_API</label>
                  <input
                    type="password"
                    className="settings-input"
                    value={envSettings['TELEGRAM_BOT_API'] ?? ''}
                    onChange={e => setEnvSettings(prev => ({ ...prev, TELEGRAM_BOT_API: e.target.value }))}
                    placeholder="Telegram Bot API token"
                  />
                  <p className="settings-hint">
                    Telegram Bot API token for sending IM notifications to the user.
                    <br />📍 Create a bot via <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="settings-link">@BotFather</a> → /newbot → copy the API token.
                  </p>
                </div>
                {/* TELEGRAM_CHAT_ID */}
                <div className="settings-field">
                  <label className="settings-label">TELEGRAM_CHAT_ID</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={envSettings['TELEGRAM_CHAT_ID'] ?? ''}
                    onChange={e => setEnvSettings(prev => ({ ...prev, TELEGRAM_CHAT_ID: e.target.value }))}
                    placeholder="Your Telegram Chat ID"
                  />
                  <p className="settings-hint">
                    Your Telegram Chat ID where the bot will send messages.
                    <br />📍 Get it from <a href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer" className="settings-link">@userinfobot</a> → send /start → copy the ID.
                  </p>
                </div>
              </div>

              {/* v2.0.140: Danger Zone — Reset Trade History (moved from Evolution header) */}
              <div className="settings-section danger-zone">
                <div className="settings-section-title danger">Danger Zone</div>
                <div className="settings-row">
                  <div className="settings-label">
                    <strong>Reset Trade History</strong>
                    <p className="settings-hint">
                      Permanently deletes all closed trade records, EXP memory, and pattern data.
                      Strategy + generation are preserved. This cannot be undone.
                    </p>
                  </div>
                  <div className="danger-zone-actions">
                    {resetStep === 0 && (
                      <button className="danger-btn" onClick={() => setResetStep(1)}>
                        Reset Trade History
                      </button>
                    )}
                    {resetStep === 1 && (
                      <>
                        <p className="danger-warning">
                          This will permanently delete all trade history. Are you sure?
                        </p>
                        <div className="danger-btn-row">
                          <button className="danger-btn-cancel" onClick={() => { setResetStep(0); setResetConfirmText('') }}>Cancel</button>
                          <button className="danger-btn-proceed" onClick={() => setResetStep(2)}>Yes, continue</button>
                        </div>
                      </>
                    )}
                    {resetStep === 2 && (
                      <>
                        <p className="danger-warning">
                          Type <code>RESET</code> to confirm. This action is irreversible.
                        </p>
                        <input
                          type="text"
                          className="danger-input"
                          value={resetConfirmText}
                          onChange={(e) => setResetConfirmText(e.target.value)}
                          placeholder="Type RESET here"
                          autoFocus
                        />
                        <div className="danger-btn-row">
                          <button className="danger-btn-cancel" onClick={() => { setResetStep(0); setResetConfirmText('') }}>Cancel</button>
                          <button
                            className="danger-btn-confirm"
                            disabled={resetConfirmText !== 'RESET'}
                            onClick={handleResetTradeHistory}
                          >
                            Permanently Reset
                          </button>
                        </div>
                      </>
                    )}
                    {resetStep === 3 && (
                      <p className="danger-warning">Resetting... please wait.</p>
                    )}
                    {resetStatus && resetStep === 0 && (
                      <p className="danger-status">{resetStatus}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-modal-footer">
              <button className="settings-btn-cancel" onClick={() => setShowSettings(false)}>Cancel</button>
              <button className="settings-btn-confirm" disabled={envSettingsLoading} onClick={async () => {
                setEnvSettingsLoading(true)
                try {
                  await fetch(`${API_BASE}/settings/env`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ settings: envSettings }),
                  })
                } catch { /* ignore */ }
                setEnvSettingsLoading(false)
                setShowSettings(false)
              }}>{envSettingsLoading ? 'Saving...' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}

      {/* v2.0.117: Shutdown Confirmation Modal */}
      {showShutdown && (
        <div className="settings-overlay" onClick={() => !shutdownLoading && setShowShutdown(false)}>
          <div className="settings-modal shutdown-modal" onClick={e => e.stopPropagation()}>
            <div className="settings-modal-header">
              <span className="settings-modal-title shutdown-title">⚠️ Shutdown System</span>
              <button className="settings-modal-close" onClick={() => !shutdownLoading && setShowShutdown(false)} disabled={shutdownLoading}>✕</button>
            </div>
            <div className="settings-modal-body">
              <p className="shutdown-warning">
                You are about to shut down the MATS system. This will immediately stop all trading activity and close both the backend server and this dashboard.
              </p>
              <div className="shutdown-info-box">
                <p className="shutdown-info-row">
                  <span className="shutdown-info-icon">📈</span>
                  <span><strong>Real trade positions</strong> on Hyperliquid will remain open. They are managed by HL's native trigger orders (SL/TP) and will continue to be tracked on the exchange.</span>
                </p>
                <p className="shutdown-info-row">
                  <span className="shutdown-info-icon">📉</span>
                  <span><strong>Paper trade positions</strong> will be automatically closed at the last known market price before shutdown.</span>
                </p>
                <p className="shutdown-info-row">
                  <span className="shutdown-info-icon">💾</span>
                  <span>All evolution data, portfolio state, and trade history are persisted to disk and will be restored on next startup.</span>
                </p>
              </div>
              <p className="shutdown-confirm-text">Are you sure you want to shut down?</p>
            </div>
            <div className="settings-modal-footer">
              <button className="settings-btn-cancel" onClick={() => setShowShutdown(false)} disabled={shutdownLoading}>Cancel</button>
              <button className="settings-btn-confirm shutdown-btn-confirm" disabled={shutdownLoading} onClick={async () => {
                setShutdownLoading(true)
                try {
                  await fetch(`${API_BASE}/shutdown`, { method: 'POST' })
                  if (esRef.current) {
                    esRef.current.close()
                    esRef.current = null
                  }
                  setConnected(false)
                  setTimeout(() => window.location.reload(), 1000)
                } catch {
                  setShutdownLoading(false)
                }
              }}>{shutdownLoading ? 'Shutting down...' : 'Shutdown'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
