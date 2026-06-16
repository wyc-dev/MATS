import { useState, useEffect, useRef, useCallback } from 'react'
import type { APIData, AgentModelConfig, ModelDefinition } from './types'
import { AGENT_META, AGENT_ROLES } from './types'
import StarsBackground from './StarsBackground'
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
  if (!s) return <div className="panel"><div className="panel-title">System Status</div><span className="text-tertiary" style={{fontSize:'0.7rem'}}>Waiting...</span></div>

  const decision = data?.consensus?.decision
  const vetoed = data?.consensus?.metaAgentOverridden
  const totalPnl = s.totalPnl ?? 0
  const drawdownPct = s.drawdownPct ?? 0
  const balance = s.balance ?? 0
  const equity = s.equity ?? 0
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
        <StatCell label="Balance" value={`$${balance.toFixed(0)}`} />
        <StatCell label="Equity" value={`$${equity.toFixed(0)}`} cls={totalPnl >= 0 ? 'positive' : 'negative'} />
        <StatCell label="Drawdown" value={`${(drawdownPct * 100).toFixed(1)}%`} cls={drawdownPct > 0.1 ? 'negative' : 'neutral'} />
        <StatCell label="Trades" value={String(s.tradeCount ?? 0)} sub={`W:${s.winCount ?? 0} L:${s.lossCount ?? 0}`} />
        <StatCell label="Positions" value={String(s.positions ?? 0)} />
        <StatCell label="WS" value={s.wsConnected ? 'Connected' : 'Disconnected'} cls={s.wsConnected ? 'positive' : 'negative'} />
        <StatCell label="Total PnL" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`} cls={totalPnl >= 0 ? 'positive' : 'negative'} />
      </div>

      {s.cycleInProgress && (
        <div className="cycle-spinner" style={{marginTop: 12}}>
          <span className="spinner" />
          <span>{phaseLabel || 'Decision cycle in progress...'}</span>
        </div>
      )}
    </div>
  )
}

function AgentCard({ role, thought, status, progress, models, assignments, onModelChange, activeSymbol }: {
  role: string; thought: any; status: any; progress?: any;
  models: ModelDefinition[]; assignments: AgentModelConfig[]; onModelChange: (role: string, model: string) => void; activeSymbol?: string
}) {
  const meta = AGENT_META[role]
  if (!meta) return null

  // Extract which symbols this agent analyzed
  const analyzingSymbols: string[] = []
  if (thought?.metadata?.multiSymbolDecision) {
    const msd = thought.metadata.multiSymbolDecision
    // Primary market ticker symbol
    if (msd.marketTicker?.symbol) analyzingSymbols.push(msd.marketTicker.symbol)
    // Open position symbols
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

  const currentAssignment = assignments.find((a: AgentModelConfig) => a.role === role)
  const currentModel = currentAssignment?.model ?? ''

  return (
    <div className={`agent-card ${isLive && liveProgress.status === 'thinking' ? 'agent-thinking' : ''}`}>
      <div className="agent-head">
        <div className="agent-name-row">
          <span className="agent-dot" style={{ background: meta.color }} />
          <span className="agent-name">{meta.name}</span>
          {isLive && liveProgress.status === 'thinking' && <span className="live-dot" />}
        </div>
        {analyzingSymbols.length > 0 && (
          <div className="agent-symbols" style={{fontSize:'0.6rem', color:'var(--text-tertiary)', marginLeft:8}}>
            {analyzingSymbols.join(' , ')}
          </div>
        )}
        <span className={`agent-state ${agentState}`}>
          {isLive && liveProgress.status === 'thinking' ? '💭 thinking' : agentState}
        </span>
      </div>
      <div className="agent-meta">
        <span>Temp: {role === 'fractal_momentum_sentinel' ? '0.85' : role === 'onchain_whisperer' ? '0.50' : role === 'regime_risk_guardian' ? '0.25' : role === 'independent_risk_auditor' ? '0.10' : role === 'news_reporter' ? '0.40' : '0.45'}</span>
        <span>Weight: {role === 'meta_agent' ? '0.35' : role === 'news_reporter' ? '0.20' : '0.25'}</span>
        {status && <span>Decisions: {status.decisionsGenerated}</span>}
      </div>
      <div className="agent-conf-bar">
        <div className="conf-track">
          <div className={`conf-fill ${isLive && liveProgress.status === 'thinking' ? 'conf-animate' : ''}`}
            style={{ width: `${confidence * 100}%`, background: meta.color }} />
        </div>
        <span className="conf-pct" style={{ color: meta.color }}>{(confidence * 100).toFixed(0)}%</span>
      </div>
      {displayThought ? (
        <>
          <div className="agent-thought">{displayThought}</div>
          <div className="agent-footer">
            {decision && (
              <span className="agent-footer-item">
                <span className={`decision-tag ${decision.action}`} style={{fontSize:'0.55rem',padding:'1px 5px'}}>
                  {decision.action.toUpperCase()}
                </span>
                {decision.positionSizePct > 0 && <span>{(decision.positionSizePct * 100).toFixed(1)}%</span>}
              </span>
            )}
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
              <span className="agent-footer-item" style={{color:'var(--accent-gold)'}}>⚠️ Fallback</span>
            )}
          </div>
        </>
      ) : (
        <div className="agent-empty">
          {isLive && liveProgress.status === 'thinking' ? '⟳ Thinking...' : 'Waiting for first thought...'}
        </div>
      )}
      {/* Model selector inside each agent card */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <select
          className="model-select"
          value={currentModel}
          onChange={e => onModelChange(role, e.target.value)}
          style={{ maxWidth: '100%', fontSize: '0.6rem', flex: 1 }}
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

/* ── Market Agent card — embedded inside Agent Cognition ── */

function MarketAgentCard({ data }: { data: APIData | null }) {
  const s = data?.status
  const m = data?.marketState
  const ma = data?.marketAgent
  const config = ma?.config
  const topPairs = ma?.topPairs ?? []

  const [selectedTradeMode, setSelectedTradeMode] = useState(config?.tradeMode ?? 'paper')
  // Exchange is now fixed to hyperliquid
  const exchange = 'hyperliquid'
  const [selectedAssetType, setSelectedAssetType] = useState(config?.hyperliquidAssetType ?? 'crypto_perps')
  const [statusMsg, setStatusMsg] = useState('')
  const [statusVisible, setStatusVisible] = useState(false)
  const [positionSizePct, setPositionSizePct] = useState(config?.positionSizePct ?? 0.10)
  const [leverage, setLeverage] = useState(config?.leverage ?? 10)

  useEffect(() => {
    if (config) {
      setSelectedTradeMode(config.tradeMode)
      if (config.hyperliquidAssetType) setSelectedAssetType(config.hyperliquidAssetType)
      setPositionSizePct(config.positionSizePct)
      setLeverage(config.leverage)
    }
  }, [config?.tradeMode, config?.hyperliquidAssetType, config?.positionSizePct, config?.leverage])

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
  // Use live market state price (updates every cycle) instead of topPairs snapshot
  const livePrice = s?.currentPrice ?? m?.currentPrice ?? 0
  const liveVol24h = m?.volume24h ?? 0
  const liveChange24h = m?.priceChange24h ?? 0
  const currentPair = topPairs.find(p => p.symbol === activeSymbol)
  const price = activeSymbol && livePrice > 0 ? livePrice : (currentPair?.price ?? 0)
  const volume24h = liveVol24h > 0 ? liveVol24h : (currentPair?.volume24h ?? 0)
  const change24h = liveChange24h !== 0 ? liveChange24h : (currentPair?.priceChangePercent ?? 0)
  const meta = AGENT_META['market_agent']

  return (
    <div className="agent-card">
      <div className="agent-head">
        <div className="agent-name-row">
          <span className="agent-dot" style={{ background: meta?.color }} />
          <span className="agent-name">{meta?.name ?? 'Market Agent'}</span>
        </div>
        <span className="agent-state idle">{exchange.toUpperCase()} · {config?.tradeMode?.toUpperCase()}</span>
      </div>

      {/* Trade Mode toggle only (exchange fixed to Hyperliquid) */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: 4 }}>Trade Mode</div>
          <div className="market-agent-selector-btns" style={{ display: 'flex', gap: 6 }}>
            <button className={`year-btn ${selectedTradeMode === 'paper' ? 'active' : ''}`} style={{ flex: 1, padding: '4px 8px', fontSize: '0.65rem' }} onClick={() => handleTradeModeChange('paper')}>📒 Paper</button>
            <button className={`year-btn ${selectedTradeMode === 'real' ? 'active' : ''}`} style={{ flex: 1, padding: '4px 8px', fontSize: '0.65rem' }} onClick={() => handleTradeModeChange('real')}>💰 Real</button>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: 4 }}>Exchange · Asset Type</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="model-select" value={exchange} onChange={e => handleExchangeChange(e.target.value)} style={{ flex: 1, fontSize: '0.65rem' }}>
              <option value="hyperliquid">Hyperliquid</option>
            </select>
            <select className="model-select" value={selectedAssetType} onChange={e => handleAssetTypeChange(e.target.value)} style={{ flex: 1, fontSize: '0.65rem' }}>
              <option value="crypto_perps">Crypto Perps</option>
              <option value="indices">Indices</option>
              <option value="stocks">Stocks</option>
              <option value="commodities">Commodities</option>
              <option value="fx">FX / Forex</option>
              <option value="tradfi">All TradFi</option>
            </select>
          </div>
        </div>
      </div>

      {/* Position Size & Leverage Controls */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: 4 }}>
            Position Size: <strong>{(positionSizePct * 100).toFixed(0)}%</strong>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="range" min="1" max="20" value={Math.round(positionSizePct * 100)}
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
            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', minWidth: 20, textAlign: 'right' }}>{Math.round(positionSizePct * 100)}%</span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: 4 }}>
            Leverage: <strong>{leverage}x</strong>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
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
            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', minWidth: 20, textAlign: 'right' }}>{leverage}x</span>
          </div>
        </div>
      </div>

      {/* Status msg */}
      <div className={`model-status ${statusVisible ? '' : 'hidden'}`} style={{ marginTop: 4, fontSize: '0.65rem' }}>{statusMsg}</div>

      {/* Price info */}
      {activeSymbol ? (
        <>
          <div className="market-price" style={{ marginTop: 10 }}>
            <span className="market-symbol" style={{ fontSize: '0.8rem' }}>{activeSymbol}</span>
            <span className="market-value" style={{ fontSize: '0.85rem' }}>${price.toFixed(2)}</span>
            <span className={`market-change ${change24h >= 0 ? 'text-green' : 'text-red'}`} style={{ fontSize: '0.75rem' }}>
              {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}
            </span>
          </div>
          {/* Mini TradingView chart for the selected market */}
          <div style={{ marginTop: 6, marginBottom: 6 }}>
            <TradingViewChart symbol={activeSymbol} currentPrice={price} trades={[]} />
          </div>
          {/* Top pairs list */}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: 6 }}>Top Volume Pairs (top auto-selected)</div>
            <div className="top-pairs-list">
              {topPairs.slice(0, 5).map((pair, i) => (
                <div key={pair.symbol} className={`top-pair-row ${pair.symbol === activeSymbol ? 'active-pair' : ''}`} style={{ fontSize: '0.6rem', padding: '4px 6px' }}>
                  <span className="top-pair-rank" style={{ fontSize: '0.6rem' }}>#{i + 1}</span>
                  <span className="top-pair-symbol" style={{ fontSize: '0.6rem' }}>{pair.symbol}</span>
                  <span className="top-pair-vol" style={{ fontSize: '0.6rem' }}>{pair.volume24h > 0 ? `$${(pair.volume24h / 1_000_000).toFixed(1)}M` : 'N/A'}</span>
                  <span className="top-pair-vol" style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{pair.volume5m != null && pair.volume5m > 0 ? `${(pair.volume5m / 1000).toFixed(0)}K` : '-'}</span>
                  <span className={`top-pair-chg ${pair.priceChangePercent >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '0.6rem' }}>
                    {pair.volume24h > 0 ? `${pair.priceChangePercent >= 0 ? '+' : ''}${pair.priceChangePercent.toFixed(2)}%` : 'N/A'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="empty-state" style={{ marginTop: 12, padding: '12px 0' }}>
          <div className="empty-text" style={{ fontSize: '0.75rem' }}>Waiting for market data...</div>
        </div>
      )}
    </div>
  )
}

function AgentPanel({ data }: { data: APIData | null }) {
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
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Agent Cognition</span>
        <span className="panel-badge">
          {progress ? `Phase: ${progress.phase}` : ''}
        </span>
      </div>
      <div className="agent-list">
        {AGENT_ROLES.map(role => (
          role === 'market_agent'
            ? <MarketAgentCard key={role} data={data} />
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
  const positions = Object.values(p?.positions ?? {}) as any[]
  const [chartSymbol, setChartSymbol] = useState<string | null>(
    positions.length > 0 ? positions[0]?.symbol ?? null : null
  )

  // Clear chartSymbol when all positions are closed
  useEffect(() => {
    if (positions.length === 0 && chartSymbol !== null) {
      setChartSymbol(null)
    }
  }, [positions.length])
  if (!s) return null

  const balance = p?.balance ?? s.balance ?? 0
  const equity = p?.totalEquity ?? s.equity ?? 0
  const totalPnl = p?.totalPnl ?? s.totalPnl ?? 0
  const drawdownPct = p?.maxDrawdownPct ?? s.drawdownPct ?? 0
  const initialBalance = p?.initialBalance ?? 1000
  const displaySymbol = chartSymbol ?? ''

  // Get current price for chart symbol from positions or market state
  const selectedPos = positions.find((pos: any) => pos.symbol === displaySymbol)
  const chartPrice = selectedPos?.currentPrice ?? 0

  // Build trade markers — merge historical trade decisions with current position's live SL/TP
  const tradeMarkers: Array<{ time: number; action: 'buy' | 'sell'; price: number; sl?: number; tp?: number; cycle: number }> = []
  
  // Add historical trade markers from trade history
  const historyMarkers = th
    .filter((t: any) => t.decision.symbol === displaySymbol && (t.decision.action === 'buy' || t.decision.action === 'sell'))
    .map((t: any) => {
      const isShort = t.decision.action === 'sell';
      return {
        time: Math.floor((t.openedAt ?? t.timestamp) / 1000),
        action: t.decision.action as 'buy' | 'sell',
        price: t.entryPrice,
        sl: t.decision.stopLossPct
          ? isShort
            ? t.entryPrice * (1 + t.decision.stopLossPct)
            : t.entryPrice * (1 - t.decision.stopLossPct)
          : undefined,
        tp: t.decision.takeProfitPct
          ? isShort
            ? t.entryPrice * (1 - t.decision.takeProfitPct)
            : t.entryPrice * (1 + t.decision.takeProfitPct)
          : undefined,
        cycle: t.cycleNumber,
      };
    })
  tradeMarkers.push(...historyMarkers)

  // Add CURRENT position's live SL/TP as a special marker (cycle=0 = current)
  if (selectedPos) {
    const hasExisting = historyMarkers.some(m => m.cycle === 0)
    if (!hasExisting) {
      tradeMarkers.push({
        time: Math.floor((selectedPos.openedAt ?? Date.now()) / 1000),
        action: selectedPos.side === 'buy' ? 'buy' : 'sell',
        price: selectedPos.currentPrice,
        sl: selectedPos.stopLossPrice,
        tp: selectedPos.takeProfitPrice,
        cycle: 0, // 0 = current position
      })
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Portfolio</span>
        <span className="panel-badge">{s.positions} positions</span>
      </div>

      {/* TradingView Chart — only shows when user clicks a position row */}
      {displaySymbol ? (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
              Chart: {displaySymbol}
              {positions.length > 0 && !chartSymbol && <span style={{ marginLeft: 6, fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>(click a position row)</span>}
            </span>
          </div>
          <TradingViewChart
            symbol={displaySymbol}
            currentPrice={chartPrice}
            trades={tradeMarkers}
          />
        </div>
      ) : (
        <div className="empty-state" style={{ margin: '12px 0' }}>
          <div className="empty-text" style={{ fontSize: '0.75rem' }}>Click a position row to view chart</div>
        </div>
      )}

      <div className="portfolio-grid">
        <div className="portfolio-cell">
          <span className="stat-label">Balance</span>
          <span className="stat-number neutral">${balance.toFixed(2)}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Equity</span>
          <span className={`stat-number ${equity >= initialBalance ? 'positive' : 'negative'}`}>
            ${equity.toFixed(2)}
          </span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Total PnL</span>
          <span className={`stat-number ${totalPnl >= 0 ? 'positive' : 'negative'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Drawdown</span>
          <span className={`stat-number ${drawdownPct > 0.1 ? 'negative' : 'neutral'}`}>
            {(drawdownPct * 100).toFixed(2)}%
          </span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Win Rate</span>
          <span className="stat-number positive">
            {s.tradeCount > 0 ? ((s.winCount / s.tradeCount) * 100).toFixed(1) : '0.0'}%
          </span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Trades</span>
          <span className="stat-number neutral">
            {s.tradeCount}
            <span className="stat-sub" style={{marginLeft:6}}>W:{s.winCount} L:{s.lossCount}</span>
          </span>
        </div>
      </div>

      {p?.positions && Object.keys(p.positions).length > 0 ? (
        <div className="positions-table-wrap">
          <table className="positions-table">
            <thead>
              <tr>
                <th>Exchange</th>
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
              {Object.values(p.positions).map((pos: any) => {
                const exchangeDisplay = pos.exchange
                  ? pos.exchange
                  : (pos.symbol && (pos.symbol.includes(':') || (!pos.symbol.endsWith('usdt') && !pos.symbol.endsWith('usd'))))
                    ? 'hyperliquid'
                    : 'binance';
                return (
                <tr key={pos.id} onClick={() => setChartSymbol(pos.symbol)} style={{ cursor: 'pointer' }} className={chartSymbol === pos.symbol ? 'selected-position' : ''}>
                  <td style={{fontSize:'0.85rem', color:'var(--text-tertiary)'}}>{exchangeDisplay}</td>
                  <td style={{fontSize:'0.9rem', fontWeight:600}}>{pos.symbol}</td>
                  <td><span className={`side-tag ${pos.side}`}>{pos.side.toUpperCase()}</span></td>
                  <td>{pos.quantity.toFixed(6)}</td>
                  <td style={{fontFamily:'var(--font-mono)', fontSize:'0.95rem', fontWeight:500, color:'var(--text-secondary)'}}>
                    ${(pos.quantity * pos.currentPrice).toFixed(2)}
                  </td>
                  <td>${pos.averageEntryPrice.toFixed(2)}</td>
                  <td>${pos.currentPrice.toFixed(2)}</td>
                  <td style={{color: pos.unrealizedPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}}>
                    ${pos.unrealizedPnl.toFixed(2)} ({(pos.unrealizedPnlPct * 100).toFixed(2)}%)
                  </td>
                  <td>{pos.stopLossPrice ? `$${pos.stopLossPrice.toFixed(2)}` : '-'}</td>
                  <td>{pos.takeProfitPrice ? `$${pos.takeProfitPrice.toFixed(2)}` : '-'}</td>
                  <td>{pos.leverage ?? 1}x</td>
                  <td style={{fontSize:'0.9rem', color:'var(--text-tertiary)', whiteSpace:'nowrap'}}>
                    {formatHKTime(pos.openedAt)}
                  </td>
                </tr>
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
      <div style={{ marginTop: 14 }}>
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

  // Sort newest first
  const sorted = [...tradeRecords].reverse()
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const visible = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize)

  const openCount = sorted.filter((t: any) => t.status === 'open').length
  const closedCount = sorted.filter((t: any) => t.status === 'closed').length

  useEffect(() => { setPage(0) }, [tradeRecords.length])

  if (sorted.length === 0) {
    return (
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Trade Records</span>
          <span className="panel-badge">0 trades</span>
        </div>
        <div className="empty-state" style={{ padding: '16px 0' }}>
          <div className="empty-text" style={{ fontSize: '0.75rem' }}>No trades yet</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Trade Records</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="panel-badge" style={{ display: 'flex', gap: 6 }}>
            {openCount > 0 && <span>{openCount} open</span>}
            {closedCount > 0 && <span>{closedCount} closed</span>}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="header-btn" style={{ padding: '3px 10px', fontSize: '0.6rem', opacity: safePage === 0 ? 0.3 : 1 }}
              disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>◀</button>
            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', padding: '0 6px', alignSelf: 'center' }}>
              {safePage + 1}/{totalPages}
            </span>
            <button className="header-btn" style={{ padding: '3px 10px', fontSize: '0.6rem', opacity: safePage >= totalPages - 1 ? 0.3 : 1 }}
              disabled={safePage >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>▶</button>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map((t: any, i: number) => {
          const isOpen = t.status === 'open'
          return (
            <div key={t.id ?? i} style={{
              display: 'flex', flexDirection: 'column', gap: 3,
              padding: '8px 12px', borderRadius: 'var(--radius-md)',
              background: isOpen ? 'rgba(255, 215, 0, 0.04)' : 'var(--surface-elevated)',
              border: isOpen ? '1px solid rgba(255, 215, 0, 0.15)' : '1px solid var(--glass-border)',
              fontSize: '0.7rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className={`side-tag ${t.side}`} style={{ fontSize: '0.55rem', padding: '1px 5px' }}>
                  {t.side.toUpperCase()}
                </span>
                <span style={{ fontWeight: 600, fontSize: '0.72rem' }}>{t.symbol}</span>
                {isOpen && (
                  <span style={{
                    fontSize: '0.55rem', padding: '1px 5px', borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255, 215, 0, 0.12)', color: '#ffd700', fontWeight: 600,
                  }}>
                    OPEN
                  </span>
                )}
                {!isOpen && (
                  <span style={{
                    fontSize: '0.55rem', padding: '1px 5px', borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255, 255, 255, 0.06)', color: 'var(--text-tertiary)', fontWeight: 600,
                  }}>
                    CLOSE
                  </span>
                )}
                <span style={{ color: 'var(--text-tertiary)', fontSize: '0.6rem' }}>
                  Invest ${t.investment?.toFixed(2) ?? '—'} × {t.leverage ?? 1}x
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: '0.6rem' }}>
                  {isOpen
                    ? `Entry $${t.entryPrice?.toFixed(2)}`
                    : `Entry $${t.entryPrice?.toFixed(2)} → Exit $${t.exitPrice?.toFixed(2)}`
                  }
                </span>
                {!isOpen && (
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontWeight: 600,
                    color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2) ?? '0.00'} ({(t.pnlPct != null ? (t.pnlPct * 100) : 0).toFixed(1)}%)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
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
      <div className="panel">
        <div className="panel-header"><span className="panel-title">HACP Debate</span></div>
        <div className="empty-state">
          <div className="empty-icon">🗣️</div>
          <div className="empty-text">Waiting for first debate cycle...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">HACP Debate</span>
        {consensus && <span className="panel-badge">Cycle #{cycleNum} · {consensus.roundsUsed} round{consensus.roundsUsed !== 1 ? 's' : ''}</span>}
      </div>

      {progress && progress.phase === 'thinking' && (
        <div className="cycle-spinner" style={{marginBottom: 12}}>
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
        </div>
      )}

      {rounds.map((round: any) => {
        const isExpanded = expandedRounds.has(round.roundNumber)
        return (
          <div key={round.roundNumber} className="round-card">
            <div
              className="round-head"
              onClick={() => toggleRound(round.roundNumber)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <span className="round-num">Round {round.roundNumber}</span>
              <span className={`round-phase-tag ${round.phase}`}>{round.phase.toUpperCase()}</span>
              <span className="round-toggle" style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
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

      <EvolutionPanel data={data} />
    </div>
  )
}

function EvolutionPanel({ data }: { data: APIData | null }) {
  const evo = data?.evolution
  const [resetStatus, setResetStatus] = useState('')

  const handleResetTradeHistory = async () => {
    if (!confirm('Reset trade history? Strategy + generation preserved. This cannot be undone.')) return
    try {
      const res = await fetch(`${API_BASE}/evolution/reset-trade-history`, { method: 'POST' })
      if ((await res.json()).success) {
        setResetStatus('✅ Reset')
        setTimeout(() => setResetStatus(''), 3000)
      }
    } catch { setResetStatus('❌ Failed') }
  }

  if (!evo) {
    return (
      <div className="panel" style={{marginTop: 12}}>
        <div className="panel-header"><span className="panel-title">🧬 Evolution</span></div>
        <div className="empty-state">
          <div className="empty-icon">🧬</div>
          <div className="empty-text">Waiting for evolution data...</div>
        </div>
      </div>
    )
  }

  const th = evo.tradeHistory
  const fitnessPct = (evo.bestFitness * 100).toFixed(1)
  const winRatePct = (th.winRate * 100).toFixed(1)
  const totalReturnPct = (th.totalReturn * 100).toFixed(2)
  const maxDdPct = (th.maxDrawdown * 100).toFixed(2)
  const fb = evo.fitnessBreakdown

  return (
    <div className="panel" style={{marginTop: 12}}>
      <div className="panel-header">
        <span className="panel-title">🧬 Evolution</span>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <span className="panel-badge">Gen {evo.generation}</span>
          {(() => { const ecs = data?.emClusterState; return ecs?.symbols?.length ? <span className="panel-badge">{ecs.symbols.length} sym</span> : null })()}
          <button
            className="header-btn"
            style={{padding:'2px 8px', fontSize:'0.55rem', color:'var(--text-muted)'}}
            onClick={handleResetTradeHistory}
            title="Reset trade history (keeps strategy + generation)"
          >{resetStatus || '🗑️'}</button>
        </div>
      </div>

      <div className="portfolio-grid">
        <div className="portfolio-cell">
          <span className="stat-label">Best Fitness</span>
          <span className={`stat-number ${evo.bestFitness >= 0.3 ? 'positive' : 'neutral'}`}>{fitnessPct}%</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Total Cycles</span>
          <span className="stat-number neutral">{th.countedTrades ?? th.totalEntries}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Win Rate</span>
          <span className={`stat-number ${th.winRate >= 0.5 ? 'positive' : 'neutral'}`}>{winRatePct}%</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Sharpe</span>
          <span className={`stat-number ${th.sharpeRatio >= 1 ? 'positive' : 'neutral'}`}>{th.sharpeRatio.toFixed(2)}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Sortino</span>
          <span className={`stat-number ${th.sortinoRatio >= 1 ? 'positive' : 'neutral'}`}>{th.sortinoRatio.toFixed(2)}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Calmar</span>
          <span className={`stat-number ${th.calmarRatio >= 1 ? 'positive' : 'neutral'}`}>{th.calmarRatio.toFixed(2)}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Profit Factor</span>
          <span className={`stat-number ${th.profitFactor >= 1.5 ? 'positive' : 'neutral'}`}>{th.profitFactor.toFixed(2)}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Total Return</span>
          <span className={`stat-number ${th.totalReturn >= 0 ? 'positive' : 'negative'}`}>{totalReturnPct}%</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Max DD</span>
          <span className={`stat-number ${th.maxDrawdown < 0.1 ? 'neutral' : 'negative'}`}>{maxDdPct}%</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Expectancy</span>
          <span className={`stat-number ${th.expectancy >= 0 ? 'positive' : 'negative'}`}>{th.expectancy.toFixed(4)}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Real Trades</span>
          <span className="stat-number neutral">{th.realTrades}</span>
        </div>
        <div className="portfolio-cell">
          <span className="stat-label">Memory</span>
          <span className="stat-number neutral">{evo.memoryShortTerm}ST / {evo.memoryLongTerm}LT</span>
        </div>
      </div>

      {fb && (
        <div style={{marginTop: 6, marginBottom: 4}}>
          <div className="panel-header" style={{marginBottom: 4}}>
            <span className="panel-title" style={{fontSize:'0.7rem'}}>Fitness Breakdown</span>
          </div>
          <div style={{display:'flex', flexWrap:'wrap', gap:'2px 10px', fontSize:'0.6rem', color:'var(--text-tertiary)'}}>
            <span>Capital Preservation: <strong style={{color:'var(--text-secondary)'}}>{(fb.capitalPreservation * 100).toFixed(1)}%</strong></span>
            <span>Return Generation: <strong style={{color:'var(--text-secondary)'}}>{(fb.returnGeneration * 100).toFixed(1)}%</strong></span>
            <span>Adaptability: <strong style={{color:'var(--text-secondary)'}}>{(fb.adaptability * 100).toFixed(1)}%</strong></span>
            <span>Consistency: <strong style={{color:'var(--text-secondary)'}}>{(fb.consistency * 100).toFixed(1)}%</strong></span>
            <span>Risk Management: <strong style={{color:'var(--text-secondary)'}}>{(fb.riskManagement * 100).toFixed(1)}%</strong></span>
            <span>Decision Quality: <strong style={{color:'var(--text-secondary)'}}>{(fb.decisionQuality * 100).toFixed(1)}%</strong></span>
          </div>
        </div>
      )}

      {evo.strategies.length > 0 && (
        <>
          <div className="panel-header" style={{marginTop: 8, marginBottom: 6}}>
            <span className="panel-title" style={{fontSize:'0.7rem'}}>Current Strategy</span>
          </div>
          <div className="strategy-list">
            {evo.strategies.filter((s: any) => s.status === 'active').slice(0, 1).map((s: any, i: number) => (
              <div key={s.id} className={`strategy-row ${s.status}`}>
                <span className="strategy-id">#{i + 1}</span>
                <span className={`strategy-gen`}>G{s.generation}</span>
                <span className={`strategy-fitness ${s.fitness >= 0.3 ? 'positive' : s.fitness >= 0.2 ? 'neutral' : 'negative'}`}>
                  {(s.fitness * 100).toFixed(1)}%
                </span>
                <span className={`strategy-status ${s.status}`}>{s.status}</span>
                <span className="strategy-params">
                  M{s.momentumWindow} R{s.riskAversion.toFixed(2)} S{s.signalThreshold.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="strategy-detail-grid">
            {evo.strategies.filter((s: any) => s.status === 'active').slice(0, 1).map((s: any) => (
              <div key={s.id} style={{display:'flex', flexWrap:'wrap', gap:'4px 12px', padding:'6px 0', fontSize:'0.65rem', color:'var(--text-tertiary)'}}>
                <span>Volatility Threshold: <strong style={{color:'var(--text-secondary)'}}>{(s.volatilityThreshold * 100).toFixed(2)}%</strong></span>
                <span>Confirmation: <strong style={{color:'var(--text-secondary)'}}>{s.confirmationRequired} agents</strong></span>
                <span>Sizing Model: <strong style={{color:'var(--text-secondary)'}}>{s.positionSizingModel}</strong></span>
                <span>Risk Aversion: <strong style={{color:'var(--text-secondary)'}}>{s.riskAversion.toFixed(2)}</strong></span>
                <span>Signal Threshold: <strong style={{color:'var(--text-secondary)'}}>{s.signalThreshold.toFixed(2)}</strong></span>
                <span>Momentum Window: <strong style={{color:'var(--text-secondary)'}}>{s.momentumWindow}</strong></span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── GMM EM Clusters ── */}
      {data?.emClusterState?.symbols?.map ? (
        <div style={{marginTop: 10}}>
          <div className="panel-header" style={{marginBottom: 6}}>
            <span className="panel-title" style={{fontSize:'0.7rem'}}>🧬 EM Clusters</span>
            <span className="panel-badge" style={{fontSize:'0.5rem'}}>{data.emClusterState.symbols.length} symbols</span>
          </div>
          {data.emClusterState.symbols.map(symState => (
            <div key={symState.symbol} style={{marginBottom: 6}}>
              <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:3}}>
                <span style={{fontSize:'0.65rem', fontWeight:600, color:'var(--text-secondary)'}}>{symState.symbol.toUpperCase()}</span>
                <span className="panel-badge" style={{fontSize:'0.5rem'}}>BIC {symState.bic.toFixed(1)}</span>
                <span style={{fontSize:'0.5rem', color:'var(--text-tertiary)', marginLeft:'auto'}}>{symState.totalSamples} samples</span>
              </div>
              <div className="strategy-list">
                {symState.clusters.map(c => {
                  const wrColor = c.winRate > 0.6 ? 'var(--accent-green)' : c.winRate > 0.4 ? 'var(--text-secondary)' : 'var(--accent-red)'
                  return (
                    <div key={c.index} className="strategy-row active" style={{gap:6}}>
                      <span className="strategy-id">#{c.index}</span>
                      <span style={{fontSize:'0.6rem', color: wrColor, fontWeight:600}}>wr={((c.winRate)*100).toFixed(0)}%</span>
                      <span style={{fontSize:'0.55rem', color:'var(--text-tertiary)'}}>n={c.sampleCount}</span>
                      <span style={{fontSize:'0.55rem', color:'var(--text-tertiary)'}}>π={((c.weight)*100).toFixed(0)}%</span>
                      <span style={{fontSize:'0.5rem', marginLeft:'auto'}}>
                        {c.winRate > 0.6 ? '🟢' : c.winRate < 0.4 ? '🔴' : '🟡'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
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
        {isRunning && <span className="panel-badge" style={{color:'var(--accent-gold)'}}>{phaseIcon} {bp!.phase}</span>}
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
          className="model-select"
          value={selectedInterval}
          onChange={e => setSelectedInterval(e.target.value)}
          style={{maxWidth: 80, fontSize: '0.6rem'}}
          disabled={isRunning}
        >
          <option value="5m">5m</option>
          <option value="1h">1h</option>
          <option value="1d">1d</option>
          <option value="1w">1w</option>
        </select>
        <select
          className="model-select"
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          style={{maxWidth: 140, fontSize: '0.6rem'}}
          disabled={isRunning}
        >
          {backtestModels.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button
          className={`header-btn ${reverseMode ? 'shutdown-btn' : ''}`}
          onClick={() => setReverseMode(v => !v)}
          disabled={isRunning}
          title="Reverse mode: process newest → oldest (contrarian analysis)"
          style={{ opacity: isRunning ? 0.5 : 1, padding: '6px 10px' }}
        >
          <span className="btn-label">🔄</span>
        </button>
        {isRunning && !isPaused && (
          <button
            className="header-btn"
            onClick={handlePause}
            style={{ padding: '6px 10px' }}
            title="Pause backtest"
          >
            <span className="btn-label">⏸️</span>
          </button>
        )}
        {isRunning && (
          <button
            className="header-btn shutdown-btn"
            onClick={handleStop}
            style={{ padding: '6px 10px' }}
            title="Stop/cancel backtest"
          >
            <span className="btn-label">⏹️</span>
          </button>
        )}
        {isPaused && (
          <button
            className="header-btn trigger-btn"
            onClick={handleResume}
            style={{ padding: '6px 10px' }}
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
          <div className="portfolio-grid" style={{marginTop: 12}}>
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
          <div className="panel-header" style={{marginTop: 8, marginBottom: 6}}>
            <span className="panel-title" style={{fontSize:'0.7rem'}}>Signal Distribution</span>
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
              <div className="panel-header" style={{marginTop: 8, marginBottom: 6}}>
                <span className="panel-title" style={{fontSize:'0.7rem'}}>Accumulated P&L</span>
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
              <div className="panel-header" style={{marginTop: 8, marginBottom: 6}}>
                <span className="panel-title" style={{fontSize:'0.7rem'}}>Regime Distribution</span>
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

export default function App() {
  const [data, setData] = useState<APIData | null>(null)
  const [connected, setConnected] = useState(false)
  const [activeTab, setActiveTab] = useState<'status' | 'agents' | 'portfolio' | 'debate' | 'backtest'>('agents')
  const esRef = useRef<EventSource | null>(null)

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
    }
    es.onmessage = (event) => {
      try {
        const parsed: APIData = JSON.parse(event.data)
        setData(parsed)
      } catch { /* ignore */ }
    }
    es.onerror = () => {
      setConnected(false)
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

  const s = data?.status

  return (
    <div className="app">
      <StarsBackground />
      {/* Top Bar */}
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-brand">
            <span className="brand-mark" />
            <span className="brand-text">{"{"}</span><span className="brand-name">MATS</span><span className="brand-text">{"}"}</span>
          </div>
          <div className="glow-line" />
          <span className="topbar-subtitle">Multi-Agent Trading · Capital Preservation</span>
        </div>
        <div className="topbar-right">
          <button className="header-btn trigger-btn" onClick={handleRunCycle} title="Run decision cycle now">
            <span className="btn-icon">▶</span>
            <span className="btn-label">Run Cycle</span>
          </button>
          <button className="header-btn shutdown-btn" onClick={async () => {
            try {
              await fetch(`${API_BASE}/shutdown`, { method: 'POST' })
              if (esRef.current) {
                esRef.current.close()
                esRef.current = null
              }
              setConnected(false)
              setTimeout(() => window.location.reload(), 500)
            } catch {}
          }} title="Shutdown system">
            <span className="btn-icon">⏻</span>
            <span className="btn-label">Shutdown</span>
          </button>
          <span className={`conn-badge ${connected ? 'live' : 'dead'}`}>
            <span className="conn-dot" />
            {connected ? 'Live' : 'Disconnected'}
          </span>
          {s && <span className="cycle-badge">Cycle #{s.cycles}</span>}
        </div>
      </header>

      {/* Mobile Tab Bar — hidden on desktop */}
      <div className="tab-bar">
        {(['agents','portfolio','debate','backtest'] as const).map(tab => (
          <button key={tab} className={`tab-btn ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'agents' ? '🤖 Agents' : tab === 'portfolio' ? '💼 Portfolio' : tab === 'debate' ? '🗣️ Debate' : '📜 Backtest'}
          </button>
        ))}
      </div>

      {/* Main 50/50 Grid — both columns always visible on desktop */}
      <div className="main-grid">
        {/* Left Column: Agents only */}
        <div className={`col-left ${activeTab === 'agents' ? 'visible' : ''}`}>
          <AgentPanel data={data} />
        </div>

        {/* Right Column: conditional on mobile, always on desktop */}
        <div className={`col-right ${activeTab !== 'agents' ? 'visible' : ''}`}>
          {/* Mobile: only show active tab's content; Desktop: show all */}
          <div className="mobile-only">
            {activeTab === 'portfolio' && <PortfolioPanel data={data} />}
            {activeTab === 'debate' && <DebatePanel data={data} />}
            {activeTab === 'backtest' && <BacktestPanel data={data} onRun={handleRunBacktest} />}
          </div>
          <div className="desktop-only">
            <PortfolioPanel data={data} />
            <DebatePanel data={data} />
            <BacktestPanel data={data} onRun={handleRunBacktest} />
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="footer">
        <span className="footer-brand">{"{"}</span><span className="footer-name">MATS</span><span className="footer-brand">{"}"}</span>
        <span className="footer-motto">Capital Preservation First. Never Blow Up. Continuously Evolve.</span>
        {s && <span>Uptime: {Math.floor(s.cycles * 60 / 60)}h</span>}
      </footer>
    </div>
  )
}
