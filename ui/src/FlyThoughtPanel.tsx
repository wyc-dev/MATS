/* ═══════════════════════════════════════════════════════════════════════
 * FlyThoughtPanel.tsx — Fruit-Fly Thought Visualization (v2.0.902)
 * Master Lord: "do you know what concretization means" — concretization = render the abstract
 * HACP decision flow as ONE concrete, recognizable shape: a fruit fly. Thinking =
 * the brain glowing/firing; losing = a diseased red region / broken path.
 *
 *   Anatomical mapping (HACP ≡ Drosophila CNS):
 *     ┌─ compound eyes              ≡ SENSORY INPUT (market: symbol/trend/regime)
 *     ├─ antennae                   ≡ NEWS/catalyst input
 *     ├─ central brain (mushroom body) ≡ AGENT POPULATION (7 neurons, glow=confidence)
 *     │    └ per-neuron = one agent; vote direction colors the dendrite
 *     ├─ mushroom-body lobes        ≡ DEBATE/consensus wiring (spike flow)
 *     ├─ VNC (segmented nerve cord) ≡ GATE STATIONS along the exec pathway
 *     │    └ green segment = pass, red flaring = blocked path (why losing)
 *     └─ abdominal output            ≡ READOUT (BUY/SELL/HOLD + confidence)
 *   Dopamine feedback = P&L pulse over the whole body (green/red wash).
 *
 * English-only. Display-only. Zero decision impact.
 * ═══════════════════════════════════════════════════════════════════════ */
import React, { useEffect, useRef, useMemo } from 'react'
import type { APIData } from './types'

interface Props { data: APIData | null }

const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
const money = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—'

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
  // v2.0.904: animation reads latest via ref — effect mounts once, no restart (no flicker/frame-skip)
  const dataRef = useRef(data)
  dataRef.current = data
  const votes = data?.consensus?.votes ?? []
  const agents = data?.agentThoughts ?? []
  const consensus = data?.consensus
  const audit = data?.decisionAudit ?? []
  const lastAudit = audit.length > 0 ? audit[audit.length - 1] : null
  const decision = (consensus?.decision as any)?.action ?? 'hold'
  const statusColor = decision === 'buy' ? '#4ade80' : decision === 'sell' ? '#f87171' : '#94a3b8'
  const marketState = data?.marketState as any
  const activeSymbol = (data?.status as any)?.activeSymbol ?? (data?.tradingMarkets?.[0] ?? '—')
  const p = (data?.portfolio as any) ?? {}
  const s = data?.status as any

  // ── Genuine Balance / last-trade P&L（Master Lord: must be obvious, no dead cells） ──
  const isRealMode = (data?.marketAgent?.config as any)?.tradeMode === 'real'
  const genuineBalance = isRealMode ? p?.totalEquity : (p?.balance ?? s?.balance)
  const genuineEquity = isRealMode ? p?.balance : (p?.totalEquity ?? s?.equity)

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
      const r = t.closeReason ?? 'unknown'
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

  /* ─────────────────────────────────────────────────────────────
   * CANVAS — DRAW THE FLY (top-down): eyes / antennae / brain /
   * VNC with gate segments / abdominal readout
   * ─────────────────────────────────────────────────────────────
   * Animation stability (v2.0.904): effect mounts once (empty deps), each frame reads
   * latest via dataRef — no RAF restart on data update (old version flickered/skipped).
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    const cx = W / 2
    let raf = 0, t = 0

    // read latest data each frame (no frozen closure values)
    const cur = (): { votes: any[]; agents: any[]; decision: string; statusColor: string; conf: number; gates: any[]; lastPnl: number } => {
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
      return {
        votes: c?.votes ?? [],
        agents: d?.agentThoughts ?? [],
        decision,
        statusColor: decision === 'buy' ? '#4ade80' : decision === 'sell' ? '#f87171' : '#94a3b8',
        conf: typeof c?.confidence === 'number' ? c.confidence : 0,
        gates,
        lastPnl,
      }
    }

    // body geometry (top-down fly)
    const HEAD_R = 34, EYE_RX = 26, EYE_RY = 30
    const headY = H * 0.26
    const thoraxY = H * 0.55, thoraxW = 36, thoraxH = 52
    const abdomenY = H * 0.82, abdomenW = 52, abdomenH = 44
    const VNC_START = headY + 20, VNC_END = abdomenY

    const draw = () => {
      // fresh values each frame (v2.0.904)
      const { votes: curVotes, agents: curAgents, decision: curDecision, statusColor: curColor, conf: curConf, gates: curGates, lastPnl } = cur()
      const votes = curVotes as any[]
      const agents = curAgents as any[]
      const decision = curDecision
      const statusColor = curColor
      const gates = (curGates ?? []) as Array<{ gate: string; passed: boolean }>
      const consensusConf = curConf
      const vncGates = gates.slice(0, 5)
      t += 0.016
      ctx.clearRect(0, 0, W, H)
      // background
      const bg = ctx.createLinearGradient(0, 0, 0, H)
      bg.addColorStop(0, '#0a0715'); bg.addColorStop(1, '#141023')
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)

      // ── dopamine wash (P&L pulse over the whole body) ──
      const wash = lastPnl > 0.0001 ? 'rgba(74,222,128,' : lastPnl < -0.0001 ? 'rgba(248,113,113,' : 'rgba(148,163,184,'
      const washA = 0.04 + 0.03 * Math.min(1, Math.abs(lastPnl) * 6)
      ctx.fillStyle = wash + washA + ')'
      ctx.fillRect(0, 0, W, H)

      // ── antennae (news input) ──
      ctx.strokeStyle = 'rgba(148,163,184,0.5)'; ctx.lineWidth = 2
      for (const sgn of [-1, 1]) {
        const ax = cx + sgn * 10, ay = headY - HEAD_R + 6
        ctx.beginPath(); ctx.moveTo(ax, ay)
        ctx.quadraticCurveTo(ax + sgn * 18, ay - 18, ax + sgn * 24, ay - 8)
        ctx.stroke()
        ctx.fillStyle = 'rgba(226,232,240,0.6)'
        ctx.beginPath(); ctx.arc(ax + sgn * 24, ay - 8, 3, 0, Math.PI * 2); ctx.fill()
      }

      // ── compound eyes (sensory input) ──
      ;[-1, 1].forEach((sgn) => {
        const ex = cx + sgn * (EYE_RX - 6), ey = headY
        const gE = ctx.createRadialGradient(ex, ey - 6, 2, ex, ey, EYE_RX)
        gE.addColorStop(0, '#f0abfc'); gE.addColorStop(0.4, '#a855f7'); gE.addColorStop(1, '#3b0764')
        ctx.fillStyle = gE
        ctx.beginPath(); ctx.ellipse(ex, ey, EYE_RX, EYE_RY, 0, 0, Math.PI * 2); ctx.fill()
        // specular
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.beginPath(); ctx.ellipse(ex - 7, ey - 9, 7, 4, -0.5, 0, Math.PI * 2); ctx.fill()
        // label
        ctx.fillStyle = 'rgba(216,180,254,0.7)'; ctx.font = '7.5px ui-monospace, monospace'
        ctx.textAlign = sgn < 0 ? 'right' : 'left'
        ctx.fillText('market', ex + sgn * (EYE_RX + 6), ey)
        ctx.textAlign = 'left'
      })

      // ── head outline ──
      ctx.strokeStyle = 'rgba(203,213,225,0.25)'; ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.arc(cx, headY, HEAD_R, 0, Math.PI * 2); ctx.stroke()

      // ── central brain = AGENT POPULATION (mushroom-body cloud) ──
      const agentNodes = agents.map((a: any, i: number) => {
        const col = ROLE_COLORS[a.agentRole] ?? '#94a3b8'
        const conf = typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? Math.max(0, Math.min(1, a.confidence)) : 0
        const ang = -Math.PI / 2 + (i - (Math.max(1, agents.length) - 1) / 2) * 0.28
        const r = 16 + (i % 3) * 4
        return { x: cx + Math.cos(ang) * r, y: headY + Math.sin(ang) * r * 0.7, conf, col, role: String(a.agentRole ?? '?').replace('meta-', 'meta·').slice(0, 10) }
      }).slice(0, 8)

      // dendrite wires brain → VNC (debate toward output) with spike flow
      const vncX = cx
      for (const n of agentNodes) {
        const ph = (t * 40 + n.y * 0.6) % 90
        const py = n.y + (VNC_START - n.y) * ph / 90
        const actN = votes.find((v: any) => String(v.agentRole) === String(n.role).replace('meta·', 'meta-'))
        const act = (actN?.decision as any)?.action ?? 'hold'
        const col = act === 'buy' ? 'rgba(74,222,128,' : act === 'sell' ? 'rgba(248,113,113,' : 'rgba(148,163,184,'
        ctx.strokeStyle = col + '0.22)'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(vncX, VNC_START); ctx.stroke()
        ctx.fillStyle = col + '0.7)'
        ctx.beginPath(); ctx.arc(vncX + Math.sin(t * 2 + n.y) * 3, py, 1.6, 0, Math.PI * 2); ctx.fill()
      }

      // agent neurons (glow = confidence, color = role/vote)
      for (const n of agentNodes) {
        const glow = 0.4 + 0.3 * Math.sin(t * 2 + n.y * 0.04)
        ctx.strokeStyle = n.col; ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.arc(n.x, n.y, 7 + n.conf * 8, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = n.col + '1f'
        ctx.beginPath(); ctx.arc(n.x, n.y, 7 + n.conf * 8, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 0.2 + n.conf * 0.55 + glow * 0.25
        ctx.fillStyle = n.col
        ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(1.4, (7 + n.conf * 8) * 0.3), 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 1
      }
      // brain label
      ctx.fillStyle = 'rgba(196,181,253,0.8)'; ctx.font = '8px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('AGENT BRAIN', cx, headY - HEAD_R - 12)
      ctx.textAlign = 'left'

      // ── thorax ──
      const tG = ctx.createLinearGradient(0, thoraxY - thoraxH / 2, 0, thoraxY + thoraxH / 2)
      tG.addColorStop(0, '#312e4a'); tG.addColorStop(1, '#1e1b33')
      ctx.fillStyle = tG
      ctx.beginPath(); ctx.ellipse(cx, thoraxY, thoraxW / 2, thoraxH / 2, 0, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.ellipse(cx, thoraxY, thoraxW / 2, thoraxH / 2, 0, 0, Math.PI * 2); ctx.stroke()

      // ── VNC (ventral nerve cord) with GATE STATIONS ──
      const segH = VNC_END - VNC_START
      vncGates.forEach((g, i) => {
        const y = VNC_START + segH * (i + 0.5) / 6
        const flash = 0.5 + 0.5 * Math.abs(Math.sin(t * 5 + i))
        const colG = g.passed ? 'rgba(74,222,128,0.9)' : `rgba(248,113,113,${0.6 + flash * 0.4})`
        ctx.strokeStyle = colG; ctx.lineWidth = g.passed ? 1.4 : 2.6
        ctx.beginPath(); ctx.moveTo(vncX, VNC_START + segH * i / 6)
        ctx.lineTo(vncX, VNC_START + segH * (i + 1) / 6); ctx.stroke()
        // node
        ctx.beginPath(); ctx.arc(vncX, y, g.passed ? 3.5 : 5, 0, Math.PI * 2); ctx.stroke()
        if (!g.passed) { ctx.fillStyle = `rgba(248,113,113,${0.1 + flash * 0.25})`; ctx.beginPath(); ctx.arc(vncX, y, 7, 0, Math.PI * 2); ctx.fill() }
        // label right
        ctx.font = '7.5px ui-monospace, monospace'
        ctx.fillStyle = g.passed ? 'rgba(74,222,128,0.7)' : 'rgba(252,165,165,0.9)'
        ctx.textAlign = 'left'
        ctx.fillText((g.passed ? '✓ ' : '⛔ ') + String(g.gate ?? '?').replace(/[()]/g, '').slice(0, 12), vncX + 10, y + 2.5)
      })

      // ── abdomen (output / readout) ──
      const aG = ctx.createLinearGradient(0, abdomenY - abdomenH / 2, 0, abdomenY + abdomenH / 2)
      aG.addColorStop(0, statusColor + '55'); aG.addColorStop(1, '#1e1b33')
      ctx.fillStyle = aG
      ctx.beginPath(); ctx.ellipse(cx, abdomenY, abdomenW / 2, abdomenH / 2, 0, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = statusColor; ctx.lineWidth = 2
      ctx.beginPath(); ctx.ellipse(cx, abdomenY, abdomenW / 2, abdomenH / 2, 0, 0, Math.PI * 2); ctx.stroke()
      // readout text
      ctx.fillStyle = statusColor; ctx.font = 'bold 11px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(`${decision.toUpperCase()} ${Math.round(consensusConf * 100)}%`, cx, abdomenY + 4)
      ctx.font = '7.5px ui-monospace, monospace'
      ctx.fillStyle = 'rgba(148,163,184,0.7)'
      ctx.fillText('READOUT', cx, abdomenY + abdomenH / 2 + 10)
      ctx.textAlign = 'left'

      // thorax/abdomen labels
      ctx.font = '8px ui-monospace, monospace'
      ctx.fillStyle = 'rgba(148,163,184,0.5)'
      ctx.fillText('VNC · gate chain', cx + thoraxW / 2 + 6, thoraxY - 10)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, []) // v2.0.904: empty deps — RAF mounts once, reads latest via dataRef

  return (
    <div className="panel panel-rgb-border" style={{ padding: 0, overflow: 'hidden' }}>
      {/* header */}
      <div className="panel-header" style={{ background: 'linear-gradient(90deg, rgba(139,92,246,0.14), transparent)' }}>
        <span className="panel-title">🧠 Fruit-Fly Thought Engine</span>
        <span className="panel-badge">{isRealMode ? 'REAL' : 'PAPER'}</span>
      </div>

      {/* balance strip (obvious) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: '1px solid rgba(148,163,184,0.15)' }}>
        {[
          [isRealMode ? 'GENUINE BALANCE' : 'SIM BALANCE', money(genuineBalance), '#e2e8f0'],
          [isRealMode ? 'GENUINE EQUITY' : 'SIM EQUITY', money(genuineEquity), '#e2e8f0'],
          ['LAST CLOSED', (() => { const l = recent[0] as any; return l ? `${l.side?.toUpperCase?.() ?? '?'} ${fmtPct(l.pnlPct)}` : '—' })(), (() => { const l = recent[0] as any; return l ? (l.pnlPct >= 0 ? '#4ade80' : '#f87171') : '#94a3b8' })()],
          ['LAST {n} NET', stats.n ? fmtPct(stats.net) : '—', stats.net >= 0 ? '#4ade80' : '#f87171'],
        ].map(([label, val, col], i) => (
          <div key={i} style={{ padding: '9px 10px', borderRight: i < 3 ? '1px solid rgba(148,163,184,0.12)' : 'none' }}>
            <div style={{ fontSize: 8.5, color: '#64748b', letterSpacing: 0.5 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: col as string, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
          </div>
        ))}
      </div>

      {/* fly canvas */}
      <div style={{ borderBottom: '1px solid rgba(148,163,184,0.15)' }}>
        <canvas ref={canvasRef} width={620} height={340} style={{ width: '100%', display: 'block' }} />
      </div>

      {/* attribution + discipline */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>WHY LOSING — by close reason</div>
          {byReason.length === 0 && <div style={{ color: '#475569', fontSize: 11 }}>No closed trades yet.</div>}
          {byReason.map((r) => (
            <div key={r.reason} style={{ padding: '4px 0', borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: r.total < 0 ? '#fca5a5' : '#94a3b8', textTransform: 'capitalize' }}>{r.reason}</span>
                <span style={{ color: r.avg >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>{fmtPct(r.avg)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#64748b' }}>
                <span>{r.n} trades · WR {Math.round(r.winRate * 100)}%</span>
                <span>Σ {fmtPct(r.total)}</span>
              </div>
            </div>
          ))}

          <div className="stat-label" style={{ marginTop: 10, marginBottom: 6 }}>GATE BLOCKS (VNC red flames)</div>
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
                // real span of ALL closed trades (not last-30 window)
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

      {/* insight */}
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
                  const parts: string[] = []
                  if (byReason[0] && byReason[0].total < 0) parts.push(`leak: ${byReason[0].reason} (Σ ${fmtPct(byReason[0].total)})`)
                  if (stats.payoff < 1.2) parts.push(`payoff ${stats.payoff.toFixed(2)}<1.2 (winners too small)`)
                  if (gateBlocks[0]) parts.push(`path blocked ${gateBlocks[0][0]} ×${gateBlocks[0][1]}`)
                  if (stats.winRate < 0.45) parts.push(`WR ${Math.round(stats.winRate * 100)}%`)
                  return 'Persistent loss: ' + (parts.join(' · ') || 'see grid')
                })()
            : (() => {
                const hints: string[] = []
                if (stats.payoff < 1.2) hints.push(`payoff ${stats.payoff.toFixed(2)}<1.2 — winners too small vs losers (cutting wins?)`)
                if (gateBlocks[0]) hints.push(`path blocked ${gateBlocks[0][0]} ×${gateBlocks[0][1]}`)
                if (stats.winRate < 0.45) hints.push(`WR ${Math.round(stats.winRate * 100)}%`)
                const top = byReason[0]
                if (top && top.total < 0) hints.push(`top leak by reason: ${top.reason}`)
                return hints.length ? `Watching for: ${hints.join(' · ')}` : 'Discipline looks healthy.'
              })()}
        </div>
      </div>
    </div>
  )
}
