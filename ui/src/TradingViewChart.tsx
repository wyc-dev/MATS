// ─── TradingView Lightweight Chart ───
// BTCUSDT candlestick chart with Buy/Sell/SL/TP markers + timeframe selector

import { useEffect, useRef, useState } from 'react'
import { createChart, createSeriesMarkers, CandlestickSeries, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type CandlestickData, type SeriesMarker, type Time } from 'lightweight-charts'

interface TradeMarker {
  time: number
  action: 'buy' | 'sell'
  price: number
  sl?: number
  tp?: number
  cycle: number
}

interface Props {
  symbol: string
  currentPrice: number
  trades: TradeMarker[]
}

const TIMEFRAMES = [
  { label: '5m', value: '5m', limit: 500 },
  { label: '1h', value: '1h', limit: 168 },
  { label: '4h', value: '4h', limit: 168 },
  { label: '1d', value: '1d', limit: 365 },
  { label: '1w', value: '1w', limit: 104 },
] as const

type Timeframe = typeof TIMEFRAMES[number]['value']

async function fetchHLKlines(symbol: string, interval: string, limit: number): Promise<CandlestickData[]> {
  try {
    const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`);
    if (!res.ok) {
      console.warn(`[TradingViewChart] Backend candles API ${res.status} for ${symbol}`);
      return [];
    }
    const json = await res.json() as { success: boolean; candles: Array<{ time: number; open: number; high: number; low: number; close: number }> };
    if (!json.success || !Array.isArray(json.candles)) return [];
    return json.candles.map(k => ({
      time: k.time as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
  } catch (err) {
    console.error(`[TradingViewChart] Backend candles error for ${symbol}:`, err);
    return [];
  }
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<CandlestickData[]> {
  try {
    const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`);
    if (!res.ok) {
      console.warn(`[TradingViewChart] Backend candles API ${res.status} for ${symbol}`);
      return [];
    }
    const json = await res.json() as { success: boolean; candles: Array<{ time: number; open: number; high: number; low: number; close: number }> };
    if (!json.success || !Array.isArray(json.candles)) return [];
    return json.candles.map(k => ({
      time: k.time as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
  } catch (err) {
    console.error(`[TradingViewChart] Backend candles error for ${symbol}:`, err);
    return [];
  }
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<CandlestickData[]> {
  const upper = symbol.toUpperCase();
  // Colon-prefixed (xyz:GOLD, flx:NVDA) → Hyperliquid DEX 1-8 only
  if (symbol.includes(':')) {
    return fetchHLKlines(symbol, interval, limit);
  }
  // USDT-suffixed (BTCUSDT, btcusdt) → Binance only
  if (upper.endsWith('USDT') || upper.endsWith('USD')) {
    return fetchBinanceKlines(upper, interval, limit);
  }
  // Bare symbols (BTC, ETH, SOL) → Hyperliquid DEX 0
  return fetchHLKlines(symbol, interval, limit);
}

export default function TradingViewChart({ symbol, currentPrice, trades }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tf = TIMEFRAMES.find(t => t.value === timeframe) ?? TIMEFRAMES[0]!

  // Load data when timeframe or symbol changes (NOT currentPrice — it ticks too fast)
  useEffect(() => {
    if (!containerRef.current) return

    // Destroy previous chart
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
      seriesRef.current = null
      priceLinesRef.current = []
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0a0c12' },
        textColor: '#6b7488',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(255,255,255,0.1)', width: 1, style: LineStyle.Dashed },
        horzLine: { color: 'rgba(255,255,255,0.1)', width: 1, style: LineStyle.Dashed },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.05)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.05)',
      },
      localization: {
        timeZone: 'Asia/Hong_Kong',
        locale: 'en-HK',
      } as any,
      width: containerRef.current.clientWidth,
      height: 320,
    })

    // Adaptive precision based on symbol price magnitude
    const pricePrecision = currentPrice > 10000 ? 0 : currentPrice > 1000 ? 1 : currentPrice > 1 ? 2 : currentPrice > 0.1 ? 4 : 6
    const minMove = 10 ** -pricePrecision

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove,
      },
    })

    chartRef.current = chart
    seriesRef.current = series

    // Load data
    setLoading(true)
    setError(null)
    fetchKlines(symbol, tf.value, tf.limit).then(candles => {
      setLoading(false)
      if (candles.length > 0 && seriesRef.current) {
        seriesRef.current.setData(candles)
        chart.timeScale().fitContent()
      } else {
        setError(`No candle data for ${symbol}`)
        console.warn(`[TradingViewChart] No candles for ${symbol} @ ${tf.value}`)
      }
    }).catch(err => {
      setLoading(false)
      setError(`Failed to load ${symbol}`)
      console.error(`[TradingViewChart] Failed to fetch candles for ${symbol}:`, err)
    })

    // Handle resize
    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      priceLinesRef.current = []
    }
  }, [timeframe, symbol])

  // Update markers + price lines when trades change
  useEffect(() => {
    if (!seriesRef.current) return

    // Clear old price lines
    for (const pl of priceLinesRef.current) {
      try { seriesRef.current.removePriceLine(pl) } catch { /* already removed */ }
    }
    priceLinesRef.current = []

    if (trades.length === 0) return

    // Build markers (Buy/Sell arrows)
    const markers: SeriesMarker<Time>[] = trades.map(t => {
      const isBuy = t.action === 'buy'
      return {
        time: t.time as Time,
        position: isBuy ? 'belowBar' as const : 'aboveBar' as const,
        color: isBuy ? '#34d399' : '#f87171',
        shape: isBuy ? 'arrowUp' as const : 'arrowDown' as const,
        text: `${isBuy ? 'B' : 'S'} #${t.cycle}`,
        size: 1.5,
      }
    })

    // Destroy previous markers plugin if exists
    if ((window as any).__markersApi) {
      (window as any).__markersApi.setMarkers([])
    }
    const markersApi = createSeriesMarkers(seriesRef.current, markers)
    ;(window as any).__markersApi = markersApi

    // Add SL/TP horizontal lines
    for (const t of trades) {
      if (t.sl) {
        const line = seriesRef.current.createPriceLine({
          price: t.sl,
          color: '#f87171',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `SL #${t.cycle}`,
        })
        priceLinesRef.current.push(line)
      }
      if (t.tp) {
        const line = seriesRef.current.createPriceLine({
          price: t.tp,
          color: '#34d399',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `TP #${t.cycle}`,
        })
        priceLinesRef.current.push(line)
      }
    }

    return () => {
      markersApi.setMarkers([])
      if ((window as any).__markersApi === markersApi) {
        (window as any).__markersApi = null
      }
    }
  }, [trades, timeframe])

  return (
    <div>
      {/* Timeframe selector */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 6,
        padding: '0 2px',
      }}>
        {TIMEFRAMES.map(tf => (
          <button
            key={tf.value}
            onClick={() => setTimeframe(tf.value)}
            style={{
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.08)',
              background: timeframe === tf.value ? 'rgba(91,141,239,0.15)' : 'rgba(255,255,255,0.02)',
              color: timeframe === tf.value ? '#5b8def' : '#6b7488',
              fontFamily: 'var(--font-sans)',
              fontSize: '0.7rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* Chart container */}
      <div style={{ position: 'relative', width: '100%', height: 320, borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
        <div
          ref={containerRef}
          style={{
            width: '100%',
            height: 320,
          }}
        />
        {(loading || error) && (
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(10,12,18,0.85)',
            color: '#6b7488',
            fontSize: '0.75rem',
            fontFamily: 'var(--font-sans)',
            zIndex: 10,
          }}>
            {loading ? (
              <span>Loading {symbol}…</span>
            ) : (
              <span style={{ color: '#f87171' }}>{error}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
