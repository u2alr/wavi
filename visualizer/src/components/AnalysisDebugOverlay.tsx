import { useEffect, useRef } from 'react'
import { getAnalysis } from '../analyser'

const W = 344
const H = 236

function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: number,
  color: string,
) {
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = color
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, fill)), h)
}

export default function AnalysisDebugOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    let raf = 0
    const draw = () => {
      const a = getAnalysis()
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(4, 8, 16, 0.8)'
      ctx.fillRect(0, 0, W, H)
      ctx.strokeStyle = 'rgba(90, 170, 255, 0.35)'
      ctx.strokeRect(0.5, 0.5, W - 1, H - 1)

      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = '#7cc4ff'
      ctx.fillText('ANALYSIS DEBUG', 8, 14)
      ctx.fillStyle = '#8fe28f'
      ctx.textAlign = 'right'
      ctx.fillText(a.sectionState, W - 8, 14)
      ctx.textAlign = 'left'

      // FFT spectrum (log-frequency)
      const n = a.binCount
      const specTop = 20
      const specH = 50
      const specW = W - 16
      for (let x = 0; x < specW; x++) {
        const t = x / specW
        const bin = Math.min(n - 1, Math.floor(Math.pow(n, t) - 1))
        const v = a.fft[bin] || 0
        ctx.fillStyle = v > 0.75 ? '#ff7a7a' : v > 0.45 ? '#ffd27a' : '#3d7dff'
        ctx.fillRect(8 + x, specTop + specH - v * specH, 1, v * specH)
      }

      // 32 log bands
      const bandTop = specTop + specH + 6
      const bandH = 30
      const bands = a.bandDetails
      const bw = specW / bands.length
      for (let i = 0; i < bands.length; i++) {
        const v = a.bands[i] || 0
        ctx.fillStyle = 'rgba(255,255,255,0.08)'
        ctx.fillRect(8 + i * bw, bandTop, bw - 1, bandH)
        ctx.fillStyle = '#4fd6a0'
        ctx.fillRect(8 + i * bw, bandTop + bandH - v * bandH, bw - 1, v * bandH)
        if (bands[i].attack > 0.5) {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(8 + i * bw, bandTop, bw - 1, 2)
        }
      }

      // feature meters
      const mx = 8
      let my = bandTop + bandH + 8
      const mw = W - 16
      const mh = 7
      bar(ctx, mx, my, mw, mh, a.harmonicRatio, '#7a9cff')
      bar(ctx, mx, my + 10, mw, mh, a.percussiveRatio, '#ff9a5c')
      bar(ctx, mx, my + 20, mw, mh, a.vocalPresence, '#d67aff')
      my += 32

      // transient / beat flashes
      ctx.fillStyle = a.transient > 0.4 ? '#ffffff' : 'rgba(255,255,255,0.12)'
      ctx.fillRect(mx, my, 10, 10)
      ctx.fillStyle = a.beat > 0.4 ? '#ffe066' : 'rgba(255,255,255,0.12)'
      ctx.fillRect(mx + 16, my, 10, 10)

      // scalar readouts
      ctx.font = '10px monospace'
      ctx.fillStyle = '#9fb6d6'
      const y0 = my + 22
      ctx.fillText(`bpm ${a.bpm.toFixed(0)} (${a.bpmConfidence.toFixed(2)})`, mx, y0)
      ctx.fillText(`centroid ${(a.spectralCentroid * a.sampleRate / 2).toFixed(0)}Hz`, mx + 150, y0)
      ctx.fillText(`flat ${a.spectralFlatness.toFixed(2)}`, mx, y0 + 12)
      ctx.fillText(`rms ${a.rms.toFixed(3)}`, mx + 150, y0 + 12)
      ctx.fillText(
        `kick ${a.kickEnergy.toFixed(2)} snr ${a.snareEnergy.toFixed(2)} hat ${a.hatEnergy.toFixed(2)}`,
        mx,
        y0 + 24,
      )
      ctx.fillText(`events ${a.eventCount}`, mx + 240, y0 + 24)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className="analysis-debug"
      style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 40, pointerEvents: 'none' }}
    >
      <canvas ref={canvasRef} style={{ width: W, height: H, display: 'block' }} />
    </div>
  )
}
