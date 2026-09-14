// Cover-derived palettes for the ambient (canvasAmbient*) backgrounds.
// Pure color math on raw RGBA pixels — no DOM, no three, no React — so the
// ramp can be reasoned about (and tested) on its own.

export type Rgb = [number, number, number]

/** Stops pulled off a cover for the ambient wash. */
export const PALETTE_STOPS = 5

const PALETTE_BUCKETS = 12

// Fallback palette when no cover is sampled (warm brown, dark -> light so the
// shader can read the stops as one ramp).
export const FALLBACK_PALETTE: Rgb[] = [
  [0.16, 0.09, 0.05],
  [0.30, 0.19, 0.11],
  [0.46, 0.28, 0.16],
  [0.64, 0.40, 0.24],
  [0.82, 0.60, 0.38],
]

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const luma = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

/** Push a sampled color toward vivid without clipping its hue. */
function vividRgb(c: Rgb): Rgb {
  const m = (c[0] + c[1] + c[2]) / 3
  const SAT = 1.32
  return [
    clamp01(m + (c[0] - m) * SAT),
    clamp01(m + (c[1] - m) * SAT),
    clamp01(m + (c[2] - m) * SAT),
  ]
}

/**
 * Vivid dark->light palette from cover pixels: hues binned by
 * saturation x mid-tone weight, one stop per distinct hue, then normalized as
 * a set so the brightest stop lands near 0.95 while the cover's own
 * dark-to-light spread survives. Grayscale covers fall back to a luminance
 * ramp. Returns null when there is nothing to sample.
 */
export function extractPalette(data: Uint8ClampedArray): Rgb[] | null {
  const buckets = new Float64Array(PALETTE_BUCKETS * 4)
  const lum: number[] = []
  let satSum = 0
  let count = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const light = (max + min) / 2
    const sat = max > 0 ? (max - min) / max : 0
    satSum += sat
    count += 1
    lum.push(light)
    const weight = sat * (1 - Math.abs(light - 0.55)) + 0.02
    let hue: number
    if (max === min) hue = 0
    else if (max === r) hue = ((g - b) / (max - min) + 6) % 6
    else if (max === g) hue = (b - r) / (max - min) + 2
    else hue = (r - g) / (max - min) + 4
    const bucket = Math.min(PALETTE_BUCKETS - 1, Math.floor((hue / 6) * PALETTE_BUCKETS))
    buckets[bucket * 4] += r * weight
    buckets[bucket * 4 + 1] += g * weight
    buckets[bucket * 4 + 2] += b * weight
    buckets[bucket * 4 + 3] += weight
  }
  if (count === 0) return null

  const stops: Rgb[] = []
  if (satSum / count < 0.08) {
    // Grayscale cover — percentile ramp keeps it neutral, not brown.
    lum.sort((a, b) => a - b)
    for (let i = 0; i < PALETTE_STOPS; i++) {
      const t = 0.06 + (i / (PALETTE_STOPS - 1)) * 0.88
      const v = lum[Math.min(lum.length - 1, Math.floor(t * (lum.length - 1)))]
      stops.push([v, v, v])
    }
  } else {
    // Heaviest hue first, skipping buckets next to an already-picked hue so
    // the five stops read as five colors instead of one smeared one.
    const order = Array.from({ length: PALETTE_BUCKETS }, (_, i) => i).sort(
      (a, b) => buckets[b * 4 + 3] - buckets[a * 4 + 3],
    )
    const used: number[] = []
    for (const bucket of order) {
      if (stops.length >= PALETTE_STOPS) break
      const w = buckets[bucket * 4 + 3]
      if (w <= 0) continue
      if (used.some((u) => Math.min(Math.abs(u - bucket), PALETTE_BUCKETS - Math.abs(u - bucket)) <= 1)) continue
      used.push(bucket)
      stops.push([
        buckets[bucket * 4] / w,
        buckets[bucket * 4 + 1] / w,
        buckets[bucket * 4 + 2] / w,
      ])
    }
    if (stops.length === 0) return null
    // Narrow covers yield few hues: pad by lifting the last stop so the top of
    // the ramp still has somewhere to go.
    while (stops.length < PALETTE_STOPS) {
      const last = stops[stops.length - 1]
      stops.push([clamp01(last[0] * 1.22), clamp01(last[1] * 1.22), clamp01(last[2] * 1.22)])
    }
  }

  const vivid = stops.map(vividRgb).sort((a, b) => luma(a) - luma(b))
  // One shared gain: ratio between stops (the cover's depth) stays intact.
  let peak = 0
  for (const c of vivid) peak = Math.max(peak, c[0], c[1], c[2])
  const gain = Math.min(0.95 / Math.max(peak, 1e-6), 4)
  return vivid.map((c) => [clamp01(c[0] * gain), clamp01(c[1] * gain), clamp01(c[2] * gain)] as Rgb)
}
