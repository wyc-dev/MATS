/* ═══════════════════════════════════════════════════════════════════════
 * FlyThoughtPanel.tsx —— 果蠅思考巨象化（HACP Hippocampus 內嵌）
 * v2.0.900, 主神 2026-09-18:「睇唔到佢點思考,亦唔知點解一直蝕」
 *
 * 概念（connectome-inspired, 純顯示層——零決策改動）:
 *   HACP 辯論流程 ≡ 果蠅腦訊號流:
 *     [感官輸入] 市場特徵 (symbol/trend/regime)
 *     → [Agent 神經元種群] 7 個 agent:圓形亮度 = confidence, 顏色 = 投票方向
 *     → [辯論連線] vote weight:綠 buy / 紅 sell / 灰 hold, 動畫 spike 流動
 *     → [突觸檢查站] decisionAudit.gates:passed=綠通 / blocked=紅閃斷路
 *        （斷路 = 「系統想開但被閂」——mom24/tail-watchdog 兩大蝕因嘅視覺化）
 *     → [讀出層] consensus 最終決策 + confidence（MBON-like readout）
 *     → [多巴胺回饋] 最近 trades P&L: 正=綠脈 / 負=紅脈（reward/aversive）
 *
 * 點解蝕嘅視覺答案:
 *   ① gate 鏈紅閃 = 訊號被斷（pathway break——C1 監察嘅可視化）
 *   ② 多數 agent 投票方向 vs consensus 最終方向 ≠ = 學習層對抗
 *   ③ PnL sparkline 向下 = 決策/執行層持續誤判
 * ═══════════════════════════════════════════════════════════════════════ */
import React, { useEffect, useRef, useMemo } from 'react'
import type { APIData } from './types'

interface Props { data: APIData | null }

const AGENT_COLORS: Record<string, string> = {
  'meta-agent': '#c084fc',       // 紫 — Meta
  'optimist': '#4ade80',         // 綠
  'pessimist': '#f87171',        // 紅
  'skeptic': '#fbbf24',          // 琥珀
  'market': '#38bdf8',           // 藍
  'risk': '#fb923c',             // 橙
  'news': '#a78bfa',             // 淡紫
}

export default function FlyThoughtPanel({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const votes = data?.consensus?.votes ?? []
  const agents = data?.agentThoughts ?? []
  const consensus = data?.consensus
  const audit = data?.decisionAudit ?? []
  const lastAudit = audit.length > 0 ? audit[audit.length - 1] : null
  const decision = (consensus?.decision as any)?.action ?? 'hold'
  const trades = (data?.portfolio as any)?.tradeRecords ?? data?.tradeRecords ?? []
  const marketState = data?.marketState as any
  const activeSymbol = (data?.status as any)?.activeSymbol ?? (data?.tradingMarkets?.[0] ?? '—')

  // 用 tradeRecords 計最近交易 win/loss
  const recentTrades = useMemo(() => {
    const list = (Array.isArray(trades) ? trades : []).filter(
      (t: any) => t && typeof t === 'object' && typeof t.closedAt === 'number'
    )
    return list
      .sort((a: any, b: any) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, 12)
  }, [trades])

  const pnls = recentTrades.map((t: any) => (typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct) ? t.pnlPct : 0))
  const lastPnl = pnls.length > 0 ? pnls[0] : 0
  const lastPnlSign: 'pos' | 'neg' | 'flat' = lastPnl > 0.0001 ? 'pos' : lastPnl < -0.0001 ? 'neg' : 'flat'

  // ── canvas 繪製（果蠅腦網絡）──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    const cx = W / 2

    // 節點位置: 感官輸入(左) / agent 種群(中) / 檢查站(右偏) / 讀出(右)
    const sensoryY = H * 0.18
    const readout = { x: W - 44, y: H / 2, r: 26 }
    const senseNode = { x: 26, y: sensoryY, r: 10 }

    let raf = 0
    let t = 0

    const draw = () => {
      t += 0.02
      ctx.clearRect(0, 0, W, H)
      // 背景: 極淡粉紫網格（connectome vibe）
      ctx.fillStyle = 'rgba(18,16,32,0.85)'
      ctx.fillRect(0, 0, W, H)
      ctx.strokeStyle = 'rgba(124,58,237,0.06)'
      for (let gx = 12; gx < W; gx += 26) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (let gy = 12; gy < H; gy += 26) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

      const agentNodes = agents
        .map((a: any, i: number) => {
          const col = AGENT_COLORS[a.agentRole] ?? '#94a3b8'
          const conf = typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? Math.max(0, Math.min(1, a.confidence)) : 0
          const y = 34 + ((H - 68) * (i + 0.5)) / Math.max(1, agents.length)
          return { x: cx - 18, y, r: 8 + conf * 10, col, role: String(a.agentRole ?? '?'), conf }
        })
        .slice(0, 8)

      // 感官輸入 → agents 連線（spike 流動 = 市場訊號輸入）
      for (const n of agentNodes) {
        const pulse = (t * 60 + n.y * 0.5) % 120
        const px = senseNode.x + ((n.x - senseNode.x) * pulse) / 120
        const py = senseNode.y + ((n.y - senseNode.y) * pulse) / 120
        ctx.strokeStyle = 'rgba(148,163,184,0.12)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(senseNode.x, senseNode.y); ctx.lineTo(n.x, n.y); ctx.stroke()
        ctx.fillStyle = 'rgba(96,165,250,0.9)'
        ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill()
      }

      // agents → 讀出連線（vote 方向 + weight 粗幼 + spike）
      for (const v of votes) {
        const n = agentNodes.find((a: any) => String(a.role) === String(v.agentRole)) ?? agentNodes[0]
        if (!n) continue
        const w = typeof v.weight === 'number' && Number.isFinite(v.weight) ? v.weight : 0.5
        const decision = v.decision as any
        const action = decision?.action ?? 'hold'
        const color = action === 'buy' ? 'rgba(74,222,128,0.7)' : action === 'sell' ? 'rgba(248,113,113,0.7)' : 'rgba(148,163,184,0.45)'
        ctx.strokeStyle = color
        ctx.lineWidth = 0.8 + w * 1.8
        const pulse = (t * 40 + n.y) % 130
        const px = n.x + ((readout.x - n.x) * pulse) / 130
        const py = n.y + ((readout.y - n.y) * pulse) / 130
        ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(readout.x, readout.y); ctx.stroke()
        ctx.fillStyle = color
        ctx.beginPath(); ctx.arc(px, py, 1.8 + w, 0, Math.PI * 2); ctx.fill()
      }

      // Agent 神經元（亮度 = confidence, 呼吸 = voting 中）
      for (const n of agentNodes) {
        const glow = 0.35 + 0.25 * Math.sin(t * 2 + n.y)
        ctx.strokeStyle = n.col
        ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = n.col + '22'
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = n.col
        ctx.globalAlpha = 0.25 + n.conf * 0.75 + glow * 0.3
        ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(1.5, n.r * 0.35), 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 1
      }

      // 突觸檢查站（decisionAudit gates——lastAudit）
      const gates = (lastAudit?.gates ?? []) as Array<{ gate: string; passed: boolean }>
      const gateNodes = gates.slice(0, 5).map((g, i) => ({
        x: W - 108,
        y: H * 0.22 + i * (H * 0.15),
        passed: !!g.passed,
        gate: String(g.gate ?? '?').slice(0, 14),
      }))
      for (const g of gateNodes) {
        const flash = g.passed ? 0.25 : 0.5 + 0.5 * Math.abs(Math.sin(t * 4)) // 斷路紅閃
        ctx.strokeStyle = g.passed ? 'rgba(74,222,128,0.8)' : `rgba(248,113,113,${0.55 + flash * 0.45})`
        ctx.lineWidth = g.passed ? 1.2 : 2.2
        ctx.beginPath(); ctx.arc(g.x, g.y, 6, 0, Math.PI * 2); ctx.stroke()
        if (!g.passed) {
          ctx.fillStyle = `rgba(248,113,113,${0.15 + flash * 0.3})`
          ctx.beginPath(); ctx.arc(g.x, g.y, 8, 0, Math.PI * 2); ctx.fill()
        }
        ctx.fillStyle = 'rgba(226,232,240,0.7)'
        ctx.font = '8px system-ui'
        ctx.fillText(g.gate, g.x - 4, g.y - 11)
      }

      // 讀出層（consensus）
      const decision = (consensus?.decision as any)?.action ?? 'hold'
      const conf = typeof consensus?.confidence === 'number' ? consensus.confidence : 0
      const dColor = decision === 'buy' ? '#4ade80' : decision === 'sell' ? '#f87171' : '#94a3b8'
      ctx.strokeStyle = dColor
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(readout.x, readout.y, readout.r, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = dColor + (0.12 + conf * 0.28).toString(16).padStart(2, '0')
      ctx.fillStyle = dColor + '33'
      ctx.beginPath(); ctx.arc(readout.x, readout.y, readout.r, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = dColor
      ctx.font = 'bold 9px system-ui'
      ctx.textAlign = 'center'
      ctx.fillText(decision.toUpperCase(), readout.x, readout.y + 3)
      ctx.textAlign = 'left'

      // 多巴胺回饋脈衝（最近 PnL）——頂部
      const pnlColor = lastPnlSign === 'pos' ? 'rgba(74,222,128,' : lastPnlSign === 'neg' ? 'rgba(248,113,113,' : 'rgba(148,163,184,'
      const amp = lastPnlSign === 'flat' ? 0.1 : 0.35 + 0.25 * Math.min(1, Math.abs(lastPnl) * 8)
      ctx.strokeStyle = pnlColor + (0.35 + amp * Math.abs(Math.sin(t * 2.5))) + ')'
      ctx.lineWidth = 2.2
      ctx.beginPath(); ctx.arc(W / 2, H * 0.10, 5 + amp * 8, 0, Math.PI * 2); ctx.stroke()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [agents.length, votes.length, lastAudit, lastPnlSign, lastPnl, activeSymbol])

  const gateCount = (lastAudit?.gates ?? []).length
  const blockedGates = (lastAudit?.gates ?? []).filter((g: any) => !g.passed).length
  const executed = lastAudit?.executed

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="panel-header">
        <span className="panel-title">🧠 Fly Thought — HACP 決策巨象化</span>
        {lastPnlSign !== 'flat' && (
          <span className={`panel-badge ${lastPnlSign === 'pos' ? 'text-green' : 'text-red'}`}>
            {lastPnlSign === 'pos' ? '▲' : '▼'} {lastPnl >= 0 ? '+' : ''}{(lastPnl * 100).toFixed(2)}% last
          </span>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <canvas ref={canvasRef} width={460} height={240} style={{ width: '100%', display: 'block', borderRadius: '0 0 8px 8px' }} />
        <div style={{
          position: 'absolute', top: 8, left: 12, fontSize: 10, color: '#64748b',
          fontFamily: 'monospace', lineHeight: 1.5,
        }}>
          <div>IN: {activeSymbol} · trend {(marketState as any)?.trend ?? '—'} · regime {(marketState as any)?.regime ?? '—'}</div>
          <div style={{ color: '#94a3b8' }}>sensory ▸ agents ▸ gates ▸ readout</div>
        </div>
      </div>

      {/* 解釋行: 點解蝕嘅視覺答案 */}
      <div className="panel-body" style={{ paddingTop: 8, fontSize: 11 }}>
        {blockedGates > 0 ? (
          <div style={{ color: '#f87171' }}>
            ⛔ 訊號斷路: 想 {String((decision as any) ?? '?')} 但被 {blockedGates}/{gateCount} 個 gate 攔截 —{' '}
            {(lastAudit?.gates ?? []).filter((g: any) => !g.passed).map((g: any) => g.gate).join(', ')}
          </div>
        ) : executed ? (
          <div style={{ color: '#4ade80' }}>✅ 訊號全通 — 執行 {(lastAudit?.action ?? '?').toUpperCase()} @{(lastAudit?.confidence ?? 0).toFixed(0)}%</div>
        ) : (
          <div style={{ color: '#94a3b8' }}>💤 等待決策…</div>
        )}

        {/* Agent 投票矩陣 */}
        <div style={{ marginTop: 6 }}>
          {votes.map((v: any) => {
            const action = (v.decision as any)?.action ?? 'hold'
            const color = action === 'buy' ? '#4ade80' : action === 'sell' ? '#f87171' : '#94a3b8'
            const w = typeof v.weight === 'number' ? Math.round(v.weight * 100) : 0
            const conf = typeof v.confidence === 'number' ? Math.round(v.confidence * 100) : 0
            return (
              <div key={v.agentId ?? v.agentRole} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: AGENT_COLORS[v.agentRole] ?? '#94a3b8', flexShrink: 0 }} />
                <span style={{ width: 92, color: '#94a3b8', flexShrink: 0 }}>{String(v.agentRole ?? '?').slice(0, 12)}</span>
                <span style={{ color, fontWeight: 600, width: 34 }}>{action.toUpperCase()}</span>
                <span style={{ color: '#64748b', fontSize: 10 }}>{w}%</span>
                <div style={{ flex: 1, height: 3, background: 'rgba(148,163,184,0.2)', borderRadius: 2 }}>
                  <div style={{ width: `${Math.max(0, Math.min(100, conf))}%`, height: 3, background: color, borderRadius: 2 }} />
                </div>
                <span style={{ color: '#64748b', fontSize: 10, width: 30, textAlign: 'right' }}>{conf}%</span>
              </div>
            )
          })}
        </div>

        {/* PnL sparkline */}
        {pnls.length >= 2 && (
          <div style={{ marginTop: 6 }}>
            <span style={{ color: '#64748b', fontSize: 10 }}>最近 {pnls.length} 單 P&L:</span>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 26, marginTop: 2 }}>
              {pnls.map((p: number, i: number) => (
                <div key={i} title={`${(p * 100).toFixed(2)}%`} style={{
                  width: 8, background: p >= 0 ? 'rgba(74,222,128,0.8)' : 'rgba(248,113,113,0.8)',
                  height: `${Math.max(2, Math.min(100, Math.abs(p) * 340))}%`, borderRadius: 1,
                }} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
