import { useEffect, useState } from 'react'

export interface ArtGradient {
  g1: string
  g2: string
  g3: string
  edge: string
  glow: string
  ink: string
  dim: string
}

const artGradientCache = new Map<string, ArtGradient | null>()
const ART_GRADIENT_CACHE_MAX = 20

function rememberArtGradient(url: string, value: ArtGradient | null) {
  artGradientCache.set(url, value)
  while (artGradientCache.size > ART_GRADIENT_CACHE_MAX) {
    const oldest = artGradientCache.keys().next()
    if (oldest.done) break
    artGradientCache.delete(oldest.value)
  }
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
const toHex = (r: number, g: number, b: number) =>
  `#${((1 << 24) + (clampByte(r) << 16) + (clampByte(g) << 8) + clampByte(b)).toString(16).slice(1)}`
const scaleRgb = (rgb: [number, number, number], f: number): [number, number, number] => [
  rgb[0] * f,
  rgb[1] * f,
  rgb[2] * f,
]
// Dim + desaturate a sampled stop so cover gradients sit muted/flat
// instead of vivid/glassy: pull toward gray, then darken.
const dimRgb = (rgb: [number, number, number]): [number, number, number] => {
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const SAT_KEEP = 0.6
  const DARKEN = 0.76
  return [
    (rgb[0] + (avg - rgb[0]) * (1 - SAT_KEEP)) * DARKEN,
    (rgb[1] + (avg - rgb[1]) * (1 - SAT_KEEP)) * DARKEN,
    (rgb[2] + (avg - rgb[2]) * (1 - SAT_KEEP)) * DARKEN,
  ]
}
// Relative luminance of an sRGB triple (0-255) — drives the ink decision.
function luminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/**
 * Sample a fully opaque palette from a Spotify cover so the player box can
 * bleed the artwork edge-to-edge with zero translucency: dominant accent
 * (g1), runner-up hue (g2), darkness-weighted depth tone (g3), plus a
 * luminance-derived ink/dim pair that keeps text legible on any cover.
 * Grayscale covers resolve to a neutral light→dark ramp. Local files have
 * no cover (albumImage undefined) and CORS/taint failures fall back to
 * null → the opaque per-theme gray CSS fallback stays.
 */
export function useArtGradient(coverUrl: string | undefined): ArtGradient | null {
  // The sampled result is kept with the URL it belongs to, and the cache is read
  // during render: a cache hit used to arrive through an effect, costing a
  // second render pass for every cover the sampler had already seen.
  const [loaded, setLoaded] = useState<{ url: string; gradient: ArtGradient | null } | null>(null)

  useEffect(() => {
    if (!coverUrl || artGradientCache.has(coverUrl)) return
    let dead = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 48
        canvas.height = 48
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(img, 0, 0, 48, 48)
        const data = ctx.getImageData(0, 0, 48, 48).data
        const BUCKETS = 12
        const bucketR = new Float64Array(BUCKETS)
        const bucketG = new Float64Array(BUCKETS)
        const bucketB = new Float64Array(BUCKETS)
        const bucketW = new Float64Array(BUCKETS)
        let satSum = 0
        let satCount = 0
        const lum: number[] = []
        let darkR = 0
        let darkG = 0
        let darkB = 0
        let darkW = 0
        for (let y = 0; y < 48; y += 2) {
          for (let x = 0; x < 48; x += 2) {
            const i = (y * 48 + x) * 4
            const r = data[i] / 255
            const g = data[i + 1] / 255
            const b = data[i + 2] / 255
            const max = Math.max(r, g, b)
            const min = Math.min(r, g, b)
            const light = (max + min) / 2
            const sat = max === 0 ? 0 : (max - min) / max
            satSum += sat
            satCount += 1
            lum.push(light)
            // Darkness-weighted RGB average → tinted depth tone for g2.
            const dw = (1 - light) * (1 - light)
            darkR += data[i] * dw
            darkG += data[i + 1] * dw
            darkB += data[i + 2] * dw
            darkW += dw
            if (sat < 0.12) continue
            // Hue via the dominant channel sector (0-5 around the wheel).
            let hue: number
            if (max === r) hue = ((g - b) / (max - min || 1) + 6) % 6
            else if (max === g) hue = (b - r) / (max - min || 1) + 2
            else hue = (r - g) / (max - min || 1) + 4
            const bucket = Math.min(BUCKETS - 1, Math.floor((hue / 6) * BUCKETS))
            const weight = sat * (1 - Math.abs(light - 0.55))
            bucketR[bucket] += data[i] * weight
            bucketG[bucket] += data[i + 1] * weight
            bucketB[bucket] += data[i + 2] * weight
            bucketW[bucket] += weight
          }
        }
        // Opaque stops only — translucency is banned from this box.
        let accent: [number, number, number]
        let second: [number, number, number]
        let depth: [number, number, number]
        if (satSum / Math.max(1, satCount) < 0.08) {
          // Grayscale cover — luminance extremes give a neutral ramp.
          lum.sort((a, b) => a - b)
          const quint = Math.max(1, Math.floor(lum.length * 0.2))
          const darkAvg = lum.slice(0, quint).reduce((s, v) => s + v, 0) / quint
          const midAvg = lum.slice(Math.floor(lum.length * 0.4), Math.floor(lum.length * 0.6)).reduce((s, v) => s + v, 0) / Math.max(1, Math.floor(lum.length * 0.2))
          const lightAvg = lum.slice(-quint).reduce((s, v) => s + v, 0) / quint
          const lv = Math.round(lightAvg * 255)
          const mv = Math.round(midAvg * 255)
          const dv = Math.round(darkAvg * 255)
          accent = [lv, lv, lv]
          second = [mv, mv, mv]
          depth = [dv, dv, dv]
        } else {
          let best = 0
          for (let k = 1; k < BUCKETS; k++) {
            if (bucketW[k] > bucketW[best]) best = k
          }
          const w = Math.max(1e-6, bucketW[best])
          accent = [bucketR[best] / w, bucketG[best] / w, bucketB[best] / w]
          // Runner-up hue (distinct bucket, meaningful weight) or darkened accent.
          let runner = -1
          for (let k = 0; k < BUCKETS; k++) {
            if (k === best || bucketW[k] < bucketW[best] * 0.3) continue
            if (runner < 0 || bucketW[k] > bucketW[runner]) runner = k
          }
          second =
            runner >= 0
              ? [
                  bucketR[runner] / Math.max(1e-6, bucketW[runner]),
                  bucketG[runner] / Math.max(1e-6, bucketW[runner]),
                  bucketB[runner] / Math.max(1e-6, bucketW[runner]),
                ]
              : scaleRgb(accent, 0.7)
          const dw = Math.max(1e-6, darkW)
          depth = [darkR / dw, darkG / dw, darkB / dw]
        }
        const midLum = luminance(
          (accent[0] + second[0]) / 2,
          (accent[1] + second[1]) / 2,
          (accent[2] + second[2]) / 2,
        )
        const lightInk = midLum < 0.45
        const ink = lightInk ? '#f4f6f8' : '#17181c'
        const dim = lightInk ? 'rgba(244, 246, 248, 0.68)' : 'rgba(23, 24, 28, 0.66)'
        const edgeRgb = scaleRgb(dimRgb(accent), 0.62)
        const mutedAccent = dimRgb(accent)
        const mutedSecond = dimRgb(second)
        const mutedDepth = dimRgb(depth)
        const next: ArtGradient = {
          g1: toHex(mutedAccent[0], mutedAccent[1], mutedAccent[2]),
          g2: toHex(mutedSecond[0], mutedSecond[1], mutedSecond[2]),
          g3: toHex(mutedDepth[0], mutedDepth[1], mutedDepth[2]),
          edge: toHex(edgeRgb[0], edgeRgb[1], edgeRgb[2]),
          glow: `rgba(${clampByte(mutedAccent[0])}, ${clampByte(mutedAccent[1])}, ${clampByte(mutedAccent[2])}, 0.16)`,
          ink,
          dim,
        }
        rememberArtGradient(coverUrl, next)
        if (!dead) setLoaded({ url: coverUrl, gradient: next })
      } catch {
        rememberArtGradient(coverUrl, null)
        if (!dead) setLoaded({ url: coverUrl, gradient: null })
      }
    }
    img.onerror = () => {
      rememberArtGradient(coverUrl, null)
      if (!dead) setLoaded({ url: coverUrl, gradient: null })
    }
    img.src = coverUrl
    return () => {
      dead = true
    }
  }, [coverUrl])

  if (!coverUrl) return null
  const cached = artGradientCache.get(coverUrl)
  if (cached !== undefined) return cached
  // Still loading: keep the previous cover's palette on screen rather than
  // dropping to the gray fallback for the length of the fetch. A cached
  // failure resolves to null above, so a broken cover can't strand it.
  return loaded?.gradient ?? null
}
