import { useEffect, useRef } from 'react'

/**
 * Ultra-lightweight starfield background with subtle twinkling.
 * Pre-renders ~150 stars once. Twinkle via sin(time + phase) per star.
 * ~15fps, <1% CPU on modern hardware.
 */
export default function StarsBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const starsRef = useRef<Array<{ x: number; y: number; r: number; o: number; phase: number; speed: number }>>([])
  const offsetRef = useRef(0)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let w = window.innerWidth
    let h = window.innerHeight

    const resize = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      generateStars(w, h)
    }

    const generateStars = (cw: number, ch: number) => {
      const stars: Array<{ x: number; y: number; r: number; o: number; phase: number; speed: number }> = []
      const count = 150
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * cw,
          y: Math.random() * ch,
          r: Math.random() * 1.4 + 0.3,
          o: Math.random() * 0.35 + 0.08,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 0.6 + 0.2,
        })
      }
      starsRef.current = stars
    }

    const draw = (time: number) => {
      ctx.clearRect(0, 0, w, h)
      const stars = starsRef.current
      const off = offsetRef.current
      const t = time * 0.001

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i]!
        let sy = (s.y + off) % h
        if (sy < 0) sy += h

        const twinkle = 1 + Math.sin(t * s.speed + s.phase) * 0.25
        const alpha = Math.max(0.02, s.o * twinkle)

        ctx.beginPath()
        ctx.arc(s.x, sy, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
        ctx.fill()
      }
    }

    const animate = (time: number) => {
      if (time - lastFrameRef.current < 66) {
        rafRef.current = requestAnimationFrame(animate)
        return
      }
      lastFrameRef.current = time

      offsetRef.current = (offsetRef.current + 0.15) % (h || 1)
      draw(time)
      rafRef.current = requestAnimationFrame(animate)
    }

    resize()
    draw(performance.now())
    rafRef.current = requestAnimationFrame(animate)

    const handleResize = () => resize()
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        pointerEvents: 'none',
        willChange: 'transform',
      }}
    />
  )
}
