/* ═══════════════════════════════════════════════════════════════════════
 * FlyThoughtPanel.tsx — HACP Decision Flow (v2.0.908)
 * Master Lord review 2: ① balance strip was redundant (main UI already shows it) — removed;
 *                       ② fly anatomy sketch unreadable to users — replaced with a
 *                          self-labelled decision-flow diagram every element has text.
 *
 * Flow (left → right, all labelled):
 *   MARKET (input) → 7 AGENT neurons (name + vote icon + confidence) → GATE chain
 *   (green=pass / red=blocked, why-losing visible) → READOUT (BUY/SELL/HOLD + conf)
 *   Brain metaphor kept light: neurons glow, spikes flow, red gate = broken path.
 * ═══════════════════════════════════════════════════════════════════════ */
import React, { useEffect, useRef, useMemo } from 'react'
import type { APIData } from './types'

interface Props { data: APIData | null }

const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`

const ROLE_COLORS: Record<string, string> = {
  'meta-agent': '#a78bfa',
  optimist: '#4ade80',
  pessimist: '#f87171',
  skeptic: '#fbbf24',
  market: '#38bdf8',
  risk: '#fb923c',
  news: '#e879f9',
}

export default function FlyThoughtPanel({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const consensus = data?.consensus
  const audit = data?.decisionAudit ?? []
  const lastAudit = audit.length > 0 ? audit[audit.length - 1] : null
  const decision = (consensus?.decision as any)?.action ?? 'hold'
  const statusColor = decision === 'buy' ? '#4ade80' : decision === 'sell' ? '#f87171' : '#94a3b8'
  const marketState = data?.marketState as any
  const activeSymbol = (data?.status as any)?.activeSymbol ?? (data?.tradingMarkets?.[0] ?? '—')
  const tradingMarkets = (data?.tradingMarkets ?? []).filter((m: string) => typeof m === 'string' && m.length > 0)
  const perSym = data?.consensus?.perSymbolConsensus ?? []
  const p = (data?.portfolio as any) ?? {}

  // ── closed trades for attribution ──
  const trades = useMemo(() => {
    const raw = p?.tradeRecords ?? data?.tradeRecords ?? []
    return (Array.isArray(raw) ? raw : []).filter(
      (t: any) => t && typeof t === 'object' && typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct)
    )
  }, [data, p])
  const closed = useMemo(
    () => trades.filter((t: any) => t.status === 'closed' || t.status === 'hl-fill') as any[],
    [trades]
  )
  const recent = useMemo(
    () => [...closed].sort((a: any, b: any) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 30),
    [closed]
  )

  const byReason = useMemo(() => {
    const map = new Map<string, { n: number; wins: number; sumPct: number }>()
    for (const t of recent) {
      const r = String(t.closeReason ?? 'unknown') // v2.0.906-attack7: String() fallback
      const e = map.get(r) ?? { n: 0, wins: 0, sumPct: 0 }
      e.n++; if (t.pnlPct > 0) e.wins++; e.sumPct += t.pnlPct
      map.set(r, e)
    }
    return [...map.entries()].map(([reason, e]) => ({
      reason: String(reason).replace(/_/g, ' '), n: e.n, winRate: e.n ? e.wins / e.n : 0,
      avg: e.n ? e.sumPct / e.n : 0, total: e.sumPct,
    })).sort((a, b) => a.total - b.total)
  }, [recent])

  const stats = useMemo(() => {
    const pnls = recent.map((t: any) => t.pnlPct)
    const wins = pnls.filter((x) => x > 0); const losses = pnls.filter((x) => x < 0)
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
    let streak = 0
    if (pnls.length) { const s0 = pnls[0] > 0; for (const x of pnls) { if ((x > 0) !== s0) break; streak = x > 0 ? streak + 1 : streak - 1 } }
    return { n: pnls.length, winRate: pnls.length ? wins.length / pnls.length : 0, avgWin, avgLoss, payoff: Math.abs(avgLoss) > 1e-9 ? avgWin / Math.abs(avgLoss) : 0, net: pnls.reduce((a, b) => a + b, 0), streak }
  }, [recent])

  const gateBlocks = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of audit.slice(-30)) for (const g of a.gates ?? []) if (!g.passed) {
      const k = String(g.gate ?? '?').replace(/[()]/g, '').slice(0, 26)
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [audit])

  const bySymbol = useMemo(() => {
    const map = new Map<string, { n: number; sumPct: number }>()
    for (const t of recent) {
      const sym = String(t.symbol ?? '?').replace(/^xyz:/, '').toUpperCase()
      const e = map.get(sym) ?? { n: 0, sumPct: 0 }; e.n++; e.sumPct += t.pnlPct; map.set(sym, e)
    }
    return [...map.entries()].sort((a, b) => a[1].sumPct - b[1].sumPct)
  }, [recent])

  // ── decision-flow diagram (self-labelled; every element has text) ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    let raf = 0, t = 0

    const cur = (): { votes: any[]; agents: any[]; decision: string; conf: number; gates: any[]; lastPnl: number; sym: string; mkts: string[]; perSym: any[]; trend: string } => {
      const d = dataRef.current
      const c = d?.consensus as any
      const decision = c?.decision?.action ?? 'hold'
      const gates = (() => {
        const a = d?.decisionAudit ?? []
        return a.length > 0 ? (a[a.length - 1]?.gates ?? []) : []
      })()
      const rec = ((d?.portfolio as any)?.tradeRecords ?? d?.tradeRecords ?? [])
        .filter((x: any) => x && typeof x === 'object' && typeof x.pnlPct === 'number' && Number.isFinite(x.pnlPct) && (x.status === 'closed' || x.status === 'hl-fill'))
      const lastPnl = rec.length ? rec[rec.length - 1].pnlPct : 0
      const ms = (d?.marketState as any) ?? {}
      const active = String((d?.status as any)?.activeSymbol ?? (d?.tradingMarkets?.[0] ?? '—'))
      const mkts = (d?.tradingMarkets ?? []).filter((m: any) => typeof m === 'string' && m.length > 0)
      const perSym = (c?.perSymbolConsensus ?? []) as any[]
      return {
        votes: c?.votes ?? [],
        agents: d?.agentThoughts ?? [],
        decision,
        conf: typeof c?.confidence === 'number' ? c.confidence : 0,
        gates,
        lastPnl,
        sym: active,
        mkts: mkts.length > 0 ? mkts : [active],
        perSym,
        trend: String(ms.trend ?? ms.regime ?? '—'),
      }
    }

    // layout
    const INPUT = { x: 62, y: H * 0.5, w: 120, h: 12 }
    const READOUT = { x: W - 58, y: H * 0.42, r: 34 }
    const agentX = W * 0.38

    const draw = () => {
      const { votes, agents, decision, conf, gates, lastPnl, sym, trend, mkts: curMkts, perSym: perSymC } = cur()
      const colorD = decision === 'buy' ? '#4ade80' : decision === 'sell' ? '#f87171' : '#94a3b8'
      const gatesArr = (gates ?? []) as Array<{ gate: string; passed: boolean }>
      t += 0.016
      ctx.clearRect(0, 0, W, H)
      // bg
      const bg = ctx.createLinearGradient(0, 0, 0, H)
      bg.addColorStop(0, '#0d0a1c'); bg.addColorStop(1, '#171329')
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
      // subtle grid
      ctx.strokeStyle = 'rgba(139,92,246,0.05)'
      for (let gx = 16; gx < W; gx += 32) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke() }
      for (let gy = 16; gy < H; gy += 32) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke() }

      ctx.font = '9px ui-monospace, monospace'

      // ── INPUT: ALL markets block (v2.0.910 — not just active) ──
      const mkts = (curMkts ?? [sym]).slice(0, 10)
      const boxH = Math.max(32, mkts.length * INPUT.h + 8)
      const boxY = (H - boxH) / 2
      ctx.strokeStyle = 'rgba(56,189,248,0.5)'; ctx.lineWidth = 1.2
      ctx.fillStyle = 'rgba(56,189,248,0.05)'
      ctx.beginPath(); ctx.roundRect(INPUT.x - INPUT.w / 2, boxY, INPUT.w, boxH, 8); ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#7dd3fc'; ctx.font = '8px ui-monospace, monospace'; ctx.textAlign = 'center'
      ctx.fillText('MARKETS', INPUT.x, boxY + 11)
      mkts.forEach((m: string, mi: number) => {
        const rowY = boxY + 24 + mi * INPUT.h
        const norm = String(m).replace(/^xyz:/, '').toUpperCase()
        const isActive = norm === String(sym).replace(/^xyz:/, '').toUpperCase()
        const pc = perSymC.find((x: any) => String(x.symbol).replace(/^xyz:/, '').toUpperCase() === norm)
        const mAct = pc?.action ?? (isActive ? decision : '—')
        const mCol = mAct === 'buy' ? '#4ade80' : mAct === 'sell' ? '#f87171' : '#475569'
        if (isActive) {
          ctx.fillStyle = 'rgba(167,139,250,0.18)'
          ctx.beginPath(); ctx.roundRect(INPUT.x - INPUT.w / 2 + 3, rowY - 8, INPUT.w - 6, 11, 3); ctx.fill()
        }
        ctx.font = 'bold 8px ui-monospace, monospace'
        ctx.fillStyle = isActive ? '#e9d5ff' : '#94a3b8'
        ctx.fillText(norm, INPUT.x - 22, rowY + 1)
        ctx.fillStyle = mCol
        ctx.beginPath(); ctx.arc(INPUT.x + 16, rowY - 1, 3, 0, Math.PI * 2); ctx.fill()
        ctx.font = '6.5px ui-monospace, monospace'
        ctx.fillStyle = '#64748b'
        ctx.fillText(String(mAct ?? '—').toUpperCase(), INPUT.x + 26, rowY + 1)
      })
      ctx.textAlign = 'left'
      // pulse (active market)
      ctx.fillStyle = 'rgba(125,211,252,0.9)'
      ctx.beginPath(); ctx.arc(INPUT.x + INPUT.w / 2 - 4, boxY + 18, 3 + 1.4 * Math.sin(t * 3), 0, Math.PI * 2); ctx.fill()

      // ── AGENT neurons (labelled: name + vote arrow + conf) ──
      const agentNodes = agents.map((a: any, i: number) => {
        const role = String(a.agentRole ?? '?')
        const col = ROLE_COLORS[role] ?? '#94a3b8'
        const c = typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? Math.max(0, Math.min(1, a.confidence)) : 0
        const y = 30 + ((H - 60) * (i + 0.5)) / Math.max(1, agents.length)
        return { x: agentX, y, r: 10 + c * 8, col, rawRole: role, role: role.replace('meta-agent', 'META').slice(0, 8).toUpperCase(), conf: c, i }
      }).slice(0, 8)

      for (const n of agentNodes) {
        // input → neuron spike (start at ACTIVE market row, not box center)
        const actIdx = Math.max(0, mkts.findIndex((m: string) => String(m).replace(/^xyz:/, '').toUpperCase() === String(sym).replace(/^xyz:/, '').toUpperCase()))
        const srcX = INPUT.x, srcY = boxY + 24 + actIdx * INPUT.h
        const ph = (t * 60 + n.y * 0.5) % 100
        const sx = srcX + (n.x - srcX) * ph / 100, sy = srcY + (n.y - srcY) * ph / 100
        ctx.strokeStyle = 'rgba(148,163,184,0.12)'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(srcX, srcY); ctx.lineTo(n.x, n.y); ctx.stroke()
        ctx.fillStyle = 'rgba(96,165,250,0.8)'
        ctx.beginPath(); ctx.arc(sx, sy, 1.5, 0, Math.PI * 2); ctx.fill()

        // neuron
        const glow = 0.4 + 0.3 * Math.sin(t * 2 + n.y * 0.04)
        ctx.strokeStyle = n.col; ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = n.col + '1c'
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 0.2 + n.conf * 0.5 + glow * 0.25
        ctx.fillStyle = n.col
        ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(1.4, n.r * 0.3), 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 1

        // label: name + vote
        const vote = votes.find((v: any) => String(v.agentRole).toLowerCase() === String(n.rawRole).toLowerCase())
        const act = (vote?.decision as any)?.action ?? 'hold'
        const aCol = act === 'buy' ? '#4ade80' : act === 'sell' ? '#f87171' : '#475569'
        ctx.font = '8px ui-monospace, monospace'
        ctx.fillStyle = 'rgba(203,213,225,0.85)'
        ctx.textAlign = 'right'
        ctx.fillText(n.role, n.x - n.r - 8, n.y + 2)
        ctx.textAlign = 'left'
        // vote arrow
        ctx.fillStyle = aCol
        ctx.font = 'bold 9px ui-monospace, monospace'
        ctx.fillText(act === 'buy' ? '▲' : act === 'sell' ? '▼' : '·', n.x + n.r + 6, n.y + 3)
        ctx.font = '8px ui-monospace, monospace'
        ctx.fillStyle = 'rgba(148,163,184,0.8)'
        ctx.fillText(`${Math.round(n.conf * 100)}%`, n.x + n.r + 16, n.y + 3)
        ctx.textAlign = 'left'
      }
      ctx.fillStyle = 'rgba(196,181,253,0.75)'; ctx.font = '9px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('AGENTS', agentX, H - 12)
      ctx.textAlign = 'left'

      // ── GATE chain (bottom band, labelled) ──
      const gy0 = H - 34
      const gx0 = W * 0.30, gx1 = W - 84
      const segs = gatesArr.slice(0, 6)
      for (let i = 0; i < 6; i++) {
        const x = gx0 + ((gx1 - gx0) * i) / 5
        const g = segs[i]
        ctx.strokeStyle = 'rgba(148,163,184,0.15)'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x, gy0 - 10); ctx.lineTo(x, gy0); ctx.stroke()
        if (g) {
          const flash = 0.5 + 0.5 * Math.abs(Math.sin(t * 5 + i))
          ctx.strokeStyle = g.passed ? 'rgba(74,222,128,0.85)' : `rgba(248,113,113,${0.6 + flash * 0.4})`
          ctx.lineWidth = g.passed ? 1.3 : 2.6
          ctx.beginPath(); ctx.arc(x, gy0 - 10, g.passed ? 4 : 6, 0, Math.PI * 2); ctx.stroke()
          if (!g.passed) { ctx.fillStyle = `rgba(248,113,113,${0.12 + flash * 0.2})`; ctx.beginPath(); ctx.arc(x, gy0 - 10, 8, 0, Math.PI * 2); ctx.fill() }
          ctx.font = '7px ui-monospace, monospace'
          ctx.fillStyle = g.passed ? 'rgba(74,222,128,0.6)' : 'rgba(252,165,165,0.9)'
          ctx.textAlign = 'center'
          ctx.fillText(String(g.gate ?? '?').replace(/[()]/g, '').slice(0, 10), x, gy0 + 10)
          ctx.textAlign = 'left'
        }
      }
      ctx.fillStyle = 'rgba(148,163,184,0.55)'; ctx.font = '8px ui-monospace, monospace'
      ctx.textAlign = 'left'
      ctx.fillText('GATES', W * 0.30 - 34, gy0 + 10)

      // ── READOUT ──
      ctx.strokeStyle = colorD; ctx.lineWidth = 2.6
      ctx.beginPath(); ctx.arc(READOUT.x, READOUT.y, READOUT.r, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = colorD + '24'
      ctx.beginPath(); ctx.arc(READOUT.x, READOUT.y, READOUT.r, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = colorD; ctx.font = 'bold 12px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(decision.toUpperCase(), READOUT.x, READOUT.y - 2)
      ctx.font = '8px ui-monospace, monospace'
      ctx.fillStyle = 'rgba(226,232,240,0.7)'
      ctx.fillText(`${Math.round(conf * 100)}%`, READOUT.x, READOUT.y + 12)
      ctx.font = '9px ui-monospace, monospace'
      ctx.fillStyle = colorD
      ctx.fillText('READOUT', READOUT.x, READOUT.y + READOUT.r + 12)
      ctx.textAlign = 'left'

      // agent → readout spikes (vote color)
      for (const v of votes) {
        const n = agentNodes.find((a: any) => 
          String(v.agentRole).toLowerCase() === String(a.role).toLowerCase() ||
          (String(v.agentRole).toLowerCase().startsWith('meta') && String(a.role).startsWith('META')))
        if (!n) continue
        const act = (v.decision as any)?.action ?? 'hold'
        const col = act === 'buy' ? 'rgba(74,222,128,' : act === 'sell' ? 'rgba(248,113,113,' : 'rgba(148,163,184,'
        const w = typeof v.weight === 'number' && Number.isFinite(v.weight) ? v.weight : 0.5
        const ph = (t * 40 + n.y) % 110
        const px = n.x + (READOUT.x - n.x) * ph / 110, py = n.y + (READOUT.y - n.y) * ph / 110
        ctx.fillStyle = col + (0.5 + w * 0.4) + ')'
        ctx.beginPath(); ctx.arc(px, py, 1.4 + w * 1.2, 0, Math.PI * 2); ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="panel panel-rgb-border" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="panel-header" style={{ background: 'linear-gradient(90deg, rgba(139,92,246,0.14), transparent)' }}>
        <span className="panel-title">🧠 HACP Decision Flow</span>
        <span className="panel-badge">{(data?.marketAgent?.config as any)?.tradeMode === 'real' ? 'REAL' : 'PAPER'}</span>
      </div>

      {/* v2.0.909: ALL trading markets — not just active symbol (Master Lord: why only BTC?) */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid rgba(148,163,184,0.15)' }}>
        {(tradingMarkets.length > 0 ? tradingMarkets : [activeSymbol]).map((sym: string) => {
          const norm = String(sym).replace(/^xyz:/, '').toUpperCase()
          const pc = perSym.find((c: any) => String(c.symbol).replace(/^xyz:/, '').toUpperCase() === norm)
          const act = pc?.action ?? (activeSymbol === sym ? decision : '—')
          const conf = typeof pc?.confidence === 'number' ? pc.confidence : (activeSymbol === sym ? (consensus?.confidence ?? 0) : 0)
          const col = act === 'buy' ? '#4ade80' : act === 'sell' ? '#f87171' : '#64748b'
          const isActive = activeSymbol === sym || (perSym.length === 0 && tradingMarkets.length === 1)
          return (
            <div key={String(sym)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6,
              background: isActive ? 'rgba(139,92,246,0.14)' : 'rgba(148,163,184,0.06)',
              border: `1px solid ${isActive ? 'rgba(167,139,250,0.45)' : 'rgba(148,163,184,0.15)'}`,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? '#c4b5fd' : '#94a3b8' }}>{norm}</span>
              <span style={{ fontSize: 10, fontWeight: 650, color: col as string }}>{String(act ?? '—').toUpperCase()}</span>
              <span style={{ fontSize: 9, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{Math.round((conf ?? 0) * 100)}%</span>
              {isActive && <span style={{ fontSize: 8, color: '#8b5cf6' }}>●</span>}
            </div>
          )
        })}
      </div>

      <div style={{ borderBottom: '1px solid rgba(148,163,184,0.15)' }}>
        <canvas ref={canvasRef} width={640} height={280} style={{ width: '100%', display: 'block' }} />
      </div>

      {/* attribution — single block, each metric once */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>WHY LOSING — by close reason</div>
          {byReason.length === 0 && <div style={{ color: '#475569', fontSize: 11 }}>No closed trades yet.</div>}
          {byReason.filter((r) => r.n > 0).map((r) => (
            <div key={r.reason} style={{ padding: '4px 0', borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: r.total < 0 ? '#fca5a5' : '#94a3b8', textTransform: 'capitalize' }}>{r.reason}</span>
                <span style={{ color: r.avg >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>{fmtPct(r.avg)}</span>
              </div>
              <div style={{ fontSize: 9, color: '#64748b' }}>{r.n} trades</div>
            </div>
          ))}

          <div className="stat-label" style={{ marginTop: 10, marginBottom: 6 }}>GATE BLOCKS (red on diagram)</div>
          {gateBlocks.length === 0 && <div style={{ color: '#475569', fontSize: 11 }}>None.</div>}
          {gateBlocks.map(([gate, cnt]) => (
            <div key={gate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <div style={{ flex: 1, fontSize: 10, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gate}</div>
              <div style={{ width: 64, height: 4, background: 'rgba(248,113,113,0.15)', borderRadius: 2 }}>
                <div style={{ width: `${Math.min(100, cnt * 14)}%`, height: 4, background: '#f87171', borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 10, color: '#f87171', width: 16, textAlign: 'right' }}>{cnt}</span>
            </div>
          ))}
        </div>

        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>DISCIPLINE (last {stats.n} closed)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {[
              ['WIN RATE', `${Math.round(stats.winRate * 100)}%`, stats.winRate >= 0.5 ? '#4ade80' : '#f87171'],
              ['AVG WIN', fmtPct(stats.avgWin), '#4ade80'],
              ['AVG LOSS', fmtPct(stats.avgLoss), '#f87171'],
              ['PAYOFF', stats.payoff.toFixed(2), stats.payoff >= 1.3 ? '#4ade80' : '#fbbf24'],
              ['STREAK', `${stats.streak >= 0 ? '+' : ''}${stats.streak}`, stats.streak >= 0 ? '#4ade80' : '#f87171'],
              ['FREQ/DAY', (() => {
                const ts = closed.map((t: any) => t.openedAt ?? t.closedAt ?? 0).filter((x: number) => x > 0)
                if (ts.length < 2) return '—'
                const spanDays = (Math.max(...ts) - Math.min(...ts)) / 86400_000
                return spanDays > 0 ? (ts.length / spanDays).toFixed(1) : '—'
              })(), '#94a3b8'],
            ].map(([label, val, col], i) => (
              <div key={i} style={{ background: 'rgba(148,163,184,0.06)', borderRadius: 6, padding: '6px 8px' }}>
                <div style={{ fontSize: 8.5, color: '#64748b' }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 650, color: col as string }}>{val}</div>
              </div>
            ))}
          </div>

          <div className="stat-label" style={{ marginTop: 10, marginBottom: 6 }}>PER-SYMBOL DRAG</div>
          {bySymbol.slice(0, 4).map(([sym, e]) => (
            <div key={sym} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0', color: e.sumPct < 0 ? '#fca5a5' : '#4ade80' }}>
              <span>{sym} <span style={{ color: '#64748b' }}>({e.n})</span></span>
              <span style={{ fontWeight: 600 }}>{fmtPct(e.sumPct)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* single-sentence insight — reasons only, no repeated numbers */}
      <div style={{ padding: '0 12px 12px' }}>
        <div style={{
          padding: '8px 10px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
          background: stats.net >= 0 ? 'rgba(74,222,128,0.06)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${stats.net >= 0 ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.3)'}`,
          color: stats.net >= 0 ? '#bbf7d0' : '#fecaca',
        }}>
          {stats.n === 0
            ? 'Awaiting first closed trade.'
            : stats.net < 0
              ? (() => {
                  const top = byReason[0]
                  if (top && top.total < 0) return `Top loss driver: ${top.reason} (avg ${fmtPct(top.avg)} over ${top.n}) — details above`
                  return 'Net negative — see attribution above'
                })()
              : (() => {
                  const top = byReason[0]
                  if (top && top.total < 0) return `Watch: ${top.reason} is the largest outflow driver (see above)`
                  return 'None of the close-reason buckets is structurally negative.'
                })()}
        </div>
      </div>
    </div>
  )
}
