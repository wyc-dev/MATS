/* ═══════════════════════════════════════════════════════════════════════
 * FlyThoughtPanel.tsx — HACP Decision Intelligence (v2.0.901)
 * Master Lord 2026-09-18: professional-grade loss attribution, English-only UI.
 *
 * Three answers to "why is it persistently losing":
 *   ① Loss attribution by close-reason  (SL too tight? consensus cut too early?
 *      reversal stop? reconciliation?) — with avg loss per bucket
 *   ② Payoff ratio & win-rate discipline  (avg win vs |avg loss| — the structural
 *      reason a system bleeds even at 50% win rate)
 *   ③ Gate-block leaderboard + per-symbol drag  (which decision path keeps
 *      breaking, and which symbol keeps draining)
 * Plus a minimal live-decision strip (agents → consensus) in professional
 * terminal style — not a cartoon.
 * ═══════════════════════════════════════════════════════════════════════ */
import React, { useMemo } from 'react'
import type { APIData } from './types'

interface Props { data: APIData | null }

const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
const fmtNum = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

export default function FlyThoughtPanel({ data }: Props) {
  const votes = data?.consensus?.votes ?? []
  const agents = data?.agentThoughts ?? []
  const consensus = data?.consensus
  const audit = data?.decisionAudit ?? []
  const trades = useMemo(() => {
    const raw = (data?.portfolio as any)?.tradeRecords ?? data?.tradeRecords ?? []
    return (Array.isArray(raw) ? raw : []).filter(
      (t: any) => t && typeof t === 'object' && typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct)
    )
  }, [data])

  const closed = useMemo(
    () => trades.filter((t: any) => t.status === 'closed' || t.status === 'hl-fill') as any[],
    [trades]
  )
  const recent = useMemo(() => [...closed].sort((a: any, b: any) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 30), [closed])

  // ── ① Loss attribution by close-reason ──
  const byReason = useMemo(() => {
    const map = new Map<string, { n: number; wins: number; sumPct: number }>()
    for (const t of recent) {
      const r = t.closeReason ?? 'unknown'
      const e = map.get(r) ?? { n: 0, wins: 0, sumPct: 0 }
      e.n++
      if (t.pnlPct > 0) e.wins++
      e.sumPct += t.pnlPct
      map.set(r, e)
    }
    return [...map.entries()]
      .map(([reason, e]) => ({
        reason: String(reason).replace(/_/g, ' '),
        n: e.n,
        winRate: e.n > 0 ? e.wins / e.n : 0,
        avg: e.n > 0 ? e.sumPct / e.n : 0,
        total: e.sumPct,
      }))
      .sort((a, b) => a.total - b.total) // most-damaging first
  }, [recent])

  // ── ② Payoff / discipline ──
  const stats = useMemo(() => {
    const pnls = recent.map((t: any) => t.pnlPct)
    const wins = pnls.filter((p) => p > 0)
    const losses = pnls.filter((p) => p < 0)
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
    const net = pnls.reduce((a, b) => a + b, 0)
    return {
      n: pnls.length,
      winRate: pnls.length ? wins.length / pnls.length : 0,
      avgWin,
      avgLoss,
      payoff: Math.abs(avgLoss) > 1e-9 ? avgWin / Math.abs(avgLoss) : 0,
      net,
      streak: (() => {
        let s = 0
        for (let i = 0; i < pnls.length; i++) {
          if ((pnls[i] > 0) === (pnls[0] > 0)) s++ ; else break
        }
        return pnls.length ? (pnls[0] > 0 ? s : -s) : 0
      })(),
    }
  }, [recent])

  // ── ③ Gate-block leaderboard + per-symbol drag ──
  const gateBlocks = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of audit.slice(-30)) {
      for (const g of a.gates ?? []) {
        if (!g.passed) {
          const k = String(g.gate ?? '?').replace(/[()]/g, '').slice(0, 32)
          map.set(k, (map.get(k) ?? 0) + 1)
        }
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [audit])

  const bySymbol = useMemo(() => {
    const map = new Map<string, { n: number; sumPct: number }>()
    for (const t of recent) {
      const sym = String(t.symbol ?? '?').replace(/^xyz:/, '').toUpperCase()
      const e = map.get(sym) ?? { n: 0, sumPct: 0 }
      e.n++; e.sumPct += t.pnlPct
      map.set(sym, e)
    }
    return [...map.entries()].sort((a, b) => a[1].sumPct - b[1].sumPct)
  }, [recent])

  const lastAudit = audit.length > 0 ? audit[audit.length - 1] : null
  const decision = (consensus?.decision as any)?.action ?? 'hold'
  const statusColor = decision === 'buy' ? '#4ade80' : decision === 'sell' ? '#f87171' : '#94a3b8'
  const blockPct = recent.length ? byReason.filter((r) => r.total < 0).reduce((a, r) => a + r.total, 0) / Math.max(1e-9, Math.abs(stats.net)) : 0

  return (
    <div className="panel panel-rgb-border" style={{ padding: 0 }}>
      {/* ── header ── */}
      <div className="panel-header">
        <span className="panel-title">HACP Decision Intelligence</span>
        <span className="panel-badge">{stats.n} closed</span>
        {stats.n > 0 && (
          <span className={`panel-badge ${stats.net >= 0 ? 'text-green' : 'text-red'}`}>
            NET {fmtPct(stats.net)}
          </span>
        )}
      </div>

      {/* ── live decision strip (professional, compact) ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        borderBottom: '1px solid rgba(148,163,184,0.15)', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
          <span style={{ fontSize: 10, color: '#64748b' }}>DECISION</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: statusColor, letterSpacing: 0.5 }}>
            {decision.toUpperCase()}
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 4, alignItems: 'center', minWidth: 120 }}>
          {(votes as any[]).map((v, i) => {
            const a = (v.decision as any)?.action ?? 'hold'
            const c = a === 'buy' ? '#4ade80' : a === 'sell' ? '#f87171' : '#334155'
            return <div key={i} title={`${v.agentRole}: ${a}`} style={{ width: 14, height: 14, borderRadius: 3, background: c, opacity: 0.85 }} />
          })}
        </div>
        <div style={{ fontSize: 10, color: '#64748b', textAlign: 'right' }}>
          {(agents as any[]).filter((a) => a.state === 'thinking' || a.state === 'voting').length > 0
            ? '⦿ debating…'
            : `conf ${fmtNum((consensus?.confidence ?? 0) * 100, 0)}%`}
        </div>
      </div>

      {/* ── KPI row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 0, borderBottom: '1px solid rgba(148,163,184,0.15)' }}>
        {[
          ['WIN RATE', fmtNum(stats.winRate * 100, 0) + '%', stats.winRate >= 0.5 ? '#4ade80' : '#f87171'],
          ['AVG WIN', fmtPct(stats.avgWin), '#4ade80'],
          ['AVG LOSS', fmtPct(stats.avgLoss), '#f87171'],
          ['PAYOFF', fmtNum(stats.payoff, 2), stats.payoff >= 1.5 ? '#4ade80' : '#fbbf24'],
          ['STREAK', `${stats.streak >= 0 ? '+' : ''}${stats.streak}`, stats.streak >= 0 ? '#4ade80' : '#f87171'],
          ['BLOCKED/BY REASON', `${Math.round(blockPct * 100)}%`, '#94a3b8'],
        ].map(([label, val, col], i) => (
          <div key={i} style={{ padding: '8px 10px', borderRight: i < 5 ? '1px solid rgba(148,163,184,0.12)' : 'none' }}>
            <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 0.6 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 650, color: col as string }}>{val}</div>
          </div>
        ))}
      </div>

      {/* ── attribution grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
        {/* ① loss attribution by reason */}
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>LOSS ATTRIBUTION (last 30 closed)</div>
          {byReason.length === 0 && <div style={{ color: '#475569', fontSize: 11 }}>No closed trades yet.</div>}
          {byReason.map((r) => (
            <div key={r.reason} style={{ padding: '4px 0', borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, lineHeight: 1.4 }}>
                <span style={{ color: r.total < 0 ? '#fca5a5' : '#94a3b8', textTransform: 'capitalize' }}>{r.reason}</span>
                <span style={{ color: r.avg >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>{fmtPct(r.avg)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#64748b' }}>
                <span>{r.n} trades · WR {fmtNum(r.winRate * 100, 0)}%</span>
                <span>Σ {fmtPct(r.total)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ③ gate-block leaderboard + per-symbol */}
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>BLOCKED SIGNALS (last 30 audits)</div>
          {gateBlocks.length === 0 && <div style={{ color: '#475569', fontSize: 11 }}>No gate blocks recorded.</div>}
          {gateBlocks.map(([gate, cnt]) => (
            <div key={gate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              <div style={{ flex: 1, fontSize: 10, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gate}</div>
              <div style={{ width: 60, height: 4, background: 'rgba(248,113,113,0.15)', borderRadius: 2 }}>
                <div style={{ width: `${Math.min(100, cnt * 14)}%`, height: 4, background: '#f87171', borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 10, color: '#f87171', width: 18, textAlign: 'right' }}>{cnt}</span>
            </div>
          ))}

          <div className="stat-label" style={{ marginTop: 10, marginBottom: 6 }}>PER-SYMBOL DRAG</div>
          {bySymbol.length === 0 && <div style={{ color: '#475569', fontSize: 11 }}>—</div>}
          {bySymbol.slice(0, 4).map(([sym, e]) => (
            <div key={sym} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0', color: e.sumPct < 0 ? '#fca5a5' : '#4ade80' }}>
              <span>{sym} <span style={{ color: '#64748b' }}>({e.n})</span></span>
              <span style={{ fontWeight: 600 }}>{fmtPct(e.sumPct)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── insight line: why persistent loss ── */}
      <div style={{ padding: '0 12px 12px' }}>
        <div style={{
          padding: '8px 10px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
          background: stats.payoff >= 1.2 && stats.net >= 0 ? 'rgba(74,222,128,0.07)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${stats.net >= 0 ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.3)'}`,
          color: stats.net >= 0 ? '#bbf7d0' : '#fecaca',
        }}>
          {stats.n === 0
            ? 'Awaiting first closed trade for attribution.'
            : stats.net < 0
              ? (() => {
                  const worst = byReason[0]
                  const worstGate = gateBlocks[0]
                  const parts: string[] = []
                  if (worst && worst.total < 0) parts.push(`biggest leak: ${worst.reason} (Σ ${fmtPct(worst.total)})`)
                  if (stats.payoff < 1.2) parts.push(`payoff ${fmtNum(stats.payoff, 2)} < 1.2 — winners too small vs losers (cutting wins / letting losses run)`)
                  if (worstGate) parts.push(`path blocked ${worstGate[0]} ×${worstGate[1]} — signals killed before execution`)
                  if (stats.winRate < 0.45) parts.push(`win rate ${fmtNum(stats.winRate * 100, 0)}% — directional judgement weak`)
                  return parts.length ? `Persistent loss: ${parts.join(' · ')}` : 'Persistent loss (see grid above).'
                })()
            : `Positive: ${fmtPct(stats.net)} over ${stats.n} — payoff ${fmtNum(stats.payoff, 2)}, keep discipline.`}
        </div>
      </div>
    </div>
  )
}
