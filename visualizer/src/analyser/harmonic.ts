import { HIGH_BINS } from './fft'
import { AdaptiveNormalizer } from './normalization'
import { clamp01 } from './smoothing'
import type { AudioAnalysis } from './types'

// Harmonic/percussive separation (HPSS) approximated with median filtering:
// harmonic content is stable across time (median over past frames), percussive
// content is broadband (median across neighbouring bins). A full spectrogram
// median is too heavy per frame, so we use a small 7-wide window.
// ponytail: 7-frame/7-bin median, widen to 17/17 if separation proves too soft.
const WINDOW = 7
const HALF = 3
const HISTORY = WINDOW
const EPS = 1e-9

const history = new Float32Array(HISTORY * HIGH_BINS)
const scratch = new Float32Array(WINDOW)

let histFilled = 0

const harmonicNorm = new AdaptiveNormalizer({ attack: 0.2, release: 0.01 })
const percussiveNorm = new AdaptiveNormalizer({ attack: 0.25, release: 0.01 })

function median(values: Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = values[i]
    let j = i - 1
    while (j >= 0 && values[j] > v) {
      values[j + 1] = values[j]
      j--
    }
    values[j + 1] = v
  }
  return values[n >> 1]
}

export function updateHarmonic(
  analysis: AudioAnalysis,
  mag: Float32Array,
  binCount: number,
): void {
  history.copyWithin(0, HIGH_BINS)
  const last = (HISTORY - 1) * HIGH_BINS
  for (let i = 0; i < binCount; i++) history[last + i] = mag[i]

  if (histFilled < HISTORY) {
    // Backfill so early-frame medians are not dragged down by empty rows.
    for (let r = 0; r < HISTORY - 1; r++) {
      history.copyWithin(r * HIGH_BINS, last, last + binCount)
    }
    histFilled++
  }

  let sumH = 0
  let sumP = 0

  for (let i = 0; i < binCount; i++) {
    for (let r = 0; r < HISTORY; r++) scratch[r] = history[r * HIGH_BINS + i]
    sumH += median(scratch, HISTORY)

    let s0 = i - HALF
    if (s0 < 0) s0 = 0
    else if (s0 > binCount - WINDOW) s0 = binCount - WINDOW
    for (let k = 0; k < WINDOW; k++) scratch[k] = mag[s0 + k]
    sumP += median(scratch, WINDOW)
  }

  const n = binCount || 1
  const h = sumH / n
  const p = sumP / n

  harmonicNorm.update(h)
  percussiveNorm.update(p)

  const total = h + p + EPS
  analysis.harmonicEnergy = clamp01(harmonicNorm.normalize(h))
  analysis.percussiveEnergy = clamp01(percussiveNorm.normalize(p))
  analysis.harmonicRatio = clamp01(h / total)
  analysis.percussiveRatio = clamp01(p / total)
}

export function resetHarmonic(): void {
  history.fill(0)
  histFilled = 0
  harmonicNorm.reset()
  percussiveNorm.reset()
}
