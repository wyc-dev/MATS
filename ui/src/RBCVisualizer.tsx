// ─── RBC Visualizer ───
// Canvas 2D parallel-coordinates display for 9-dimension RBC state.
// Three rows of three, updated every cycle. Pure Canvas 2D — zero dependencies.

import { useRef, useEffect } from 'react'

interface DimDetail {
  name: string
  winMin: number
  winMax: number
  winCentroid: number
  lossMin: number
  lossMax: number
  lossCentroid: number
  overlap: boolean
  boundary: number | null
  globalMin: number
  globalMax: number
}

interface Props {
  dimDetails: DimDetail[]
  /** Current feature values for the white dot overlay (optional) */
  currentValues?: Record<string, number>
}

// ─── Colour Palette (pantha_mats) ───
const WIN_COLOR = 'rgba(52, 211, 153, 0.7)'    // green
const LOSS_COLOR = 'rgba(248, 113, 113, 0.7)'  // red
const OVERLAP_COLOR = 'rgba(245, 166, 35, 0.6)' // gold
const BOUNDARY_COLOR = 'rgba(255, 255, 255, 0.5)'
const DOT_COLOR = '#ffffff'
const LABEL_COLOR = 'rgba(168, 176, 196, 0.9)'  // text-secondary
const GRID_COLOR = 'rgba(255, 255, 255, 0.04)'
const BG_COLOR = 'rgba(255, 255, 255, 0.015)'

const COLS = 3
const ROWS = 3
const PAD_LEFT = 8
const PAD_RIGHT = 8
const PAD_TOP = 12
const PAD_BOTTOM = 8
const CELL_GAP_X = 8
const CELL_GAP_Y = 4
const BAR_HEIGHT = 10
const BAR_RADIUS = 3
const DOT_RADIUS = 3.5
const BOUNDARY_DASH = [3, 3]

export default function RBCVisualizer({ dimDetails, currentValues }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimDetails || dimDetails.length === 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height

    // Handle resize
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)
    }

    // Clear
    ctx.clearRect(0, 0, w, h)

    const cellW = (w - PAD_LEFT - PAD_RIGHT - CELL_GAP_X * (COLS - 1)) / COLS
    const cellH = (h - PAD_TOP - PAD_BOTTOM - CELL_GAP_Y * (ROWS - 1)) / ROWS

    for (let i = 0; i < dimDetails.length && i < COLS * ROWS; i++) {
      const d = dimDetails[i]!
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const cx = PAD_LEFT + col * (cellW + CELL_GAP_X)
      const cy = PAD_TOP + row * (cellH + CELL_GAP_Y)

      // ── Background cell ──
      ctx.fillStyle = BG_COLOR
      ctx.beginPath()
      ctx.roundRect(cx, cy, cellW, cellH, 4)
      ctx.fill()

      // ── Label ──
      ctx.fillStyle = LABEL_COLOR
      ctx.font = '10px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(d.name, cx + 6, cy + 4)

      // ── Compute bar geometry (within this cell) ──
      const barLeft = cx + 6
      const barW = cellW - 12
      const span = d.globalMax - d.globalMin || 1
      const toX = (v: number) => barLeft + ((v - d.globalMin) / span) * barW

      const winLeft = toX(d.winMin)
      const winRight = toX(d.winMax)
      const lossLeft = toX(d.lossMin)
      const lossRight = toX(d.lossMax)
      const barY = cy + cellH - BAR_HEIGHT - 4

      // ── Draw loss bar (red, drawn first so green overlays) ──
      const hasLossData = d.lossMin !== 0 || d.lossMax !== 0 || d.lossMin !== d.lossMax
      if (hasLossData) {
        ctx.fillStyle = LOSS_COLOR
        ctx.beginPath()
        const lossBarW = Math.max(2, lossRight - lossLeft)
        ctx.roundRect(lossLeft, barY, lossBarW, BAR_HEIGHT, BAR_RADIUS)
        ctx.fill()
      }

      // ── Draw win bar (green) ──
      const hasWinData = d.winMin !== 0 || d.winMax !== 0 || d.winMin !== d.winMax
      if (hasWinData) {
        ctx.fillStyle = WIN_COLOR
        ctx.beginPath()
        const winBarW = Math.max(2, winRight - winLeft)
        ctx.roundRect(winLeft, barY, winBarW, BAR_HEIGHT, BAR_RADIUS)
        ctx.fill()
      }

      // ── Draw overlap region (gold) ──
      if (d.overlap && d.boundary !== null) {
        const overlapMin = Math.max(d.winMin, d.lossMin)
        const overlapMax = Math.min(d.winMax, d.lossMax)
        const ovLeft = toX(overlapMin)
        const ovRight = toX(overlapMax)
        if (ovRight > ovLeft) {
          ctx.fillStyle = OVERLAP_COLOR
          ctx.beginPath()
          ctx.roundRect(ovLeft, barY, ovRight - ovLeft, BAR_HEIGHT, BAR_RADIUS)
          ctx.fill()
        }

        // ── Boundary line ──
        const bX = toX(d.boundary)
        ctx.strokeStyle = BOUNDARY_COLOR
        ctx.lineWidth = 1
        ctx.setLineDash(BOUNDARY_DASH)
        ctx.beginPath()
        ctx.moveTo(bX, barY - 2)
        ctx.lineTo(bX, barY + BAR_HEIGHT + 2)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // ── Current value dot ──
      const curVal = currentValues?.[d.name]
      if (curVal !== undefined) {
        const dotX = toX(curVal)
        ctx.fillStyle = DOT_COLOR
        ctx.beginPath()
        ctx.arc(dotX, barY + BAR_HEIGHT / 2, DOT_RADIUS, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [dimDetails, currentValues])

  if (!dimDetails || dimDetails.length === 0) return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: 240,
        display: 'block',
        borderRadius: 6,
      }}
    />
  )
}
