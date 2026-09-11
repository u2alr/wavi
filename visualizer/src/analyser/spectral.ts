import { HIGH_BINS, binToFrequency } from './fft'
import { clamp01 } from './smoothing'
import type { AudioAnalysis } from './types'

const prevMag = new Float32Array(HIGH_BINS)
const peakBin = new Int32Array(3)
const peakMag = new Float32Array(3)
let hasPrev = false

const CONTRAST_BANDS = 6

export function updateSpectral(
  analysis: AudioAnalysis,
  mag: Float32Array,
  binCount: number,
  sampleRate: number,
): void {
  let sum = 0
  let weighted = 0
  let logSum = 0
  let maxMag = 0
  let maxBin = 0
  let flux = 0

  peakMag[0] = peakMag[1] = peakMag[2] = 0
  peakBin[0] = peakBin[1] = peakBin[2] = 0

  for (let i = 0; i < binCount; i++) {
    const m = mag[i]
    sum += m
    weighted += i * m
    logSum += Math.log(m + 1e-7)
    if (m > maxMag) {
      maxMag = m
      maxBin = i
    }
    if (hasPrev) {
      const d = m - prevMag[i]
      if (d > 0) flux += d
    }
    // Track top-3 spaced local peaks for multi-dominant detection.
    const minGap = binCount >> 5
    if (m > peakMag[0] && i > peakBin[0] + minGap) {
      peakMag[2] = peakMag[1]; peakBin[2] = peakBin[1]
      peakMag[1] = peakMag[0]; peakBin[1] = peakBin[0]
      peakMag[0] = m; peakBin[0] = i
    } else if (m > peakMag[1] && i > peakBin[1] + minGap) {
      peakMag[2] = peakMag[1]; peakBin[2] = peakBin[1]
      peakMag[1] = m; peakBin[1] = i
    } else if (m > peakMag[2] && i > peakBin[2] + minGap) {
      peakMag[2] = m; peakBin[2] = i
    }
  }

  const mean = sum / (binCount || 1)
  const centroid = sum > 1e-9 ? weighted / sum : 0

  // Spectral spread (standard deviation about the centroid).
  let spread = 0
  if (sum > 1e-9) {
    for (let i = 0; i < binCount; i++) {
      const d = i - centroid
      spread += d * d * mag[i]
    }
    spread = Math.sqrt(spread / sum)
  }

  // Flatness = geometric mean / arithmetic mean.
  const geo = Math.exp(logSum / (binCount || 1))
  const flatness = mean > 1e-9 ? clamp01(geo / mean) : 0

  // 85% spectral rolloff.
  const target = sum * 0.85
  let acc = 0
  let rolloffBin = binCount - 1
  for (let i = 0; i < binCount; i++) {
    acc += mag[i]
    if (acc >= target) {
      rolloffBin = i
      break
    }
  }

  // Spectral contrast: peak-to-valley ratio across octave-ish sub-bands.
  let contrast = 0
  const bandSize = Math.max(1, Math.floor(binCount / CONTRAST_BANDS))
  for (let b = 0; b < CONTRAST_BANDS; b++) {
    const start = b * bandSize
    const end = b === CONTRAST_BANDS - 1 ? binCount : start + bandSize
    let bandPeak = 0
    let bandSum = 0
    const n = end - start
    for (let i = start; i < end; i++) {
      const m = mag[i]
      if (m > bandPeak) bandPeak = m
      bandSum += m
    }
    const valley = bandSum / (n || 1)
    contrast += Math.log10((bandPeak + 1e-6) / (valley + 1e-6))
  }
  contrast = clamp01(contrast / CONTRAST_BANDS / 3)

  // Spectral slope via least-squares over bin index vs magnitude.
  let num = 0
  let den = 0
  const cx = (binCount - 1) / 2
  for (let i = 0; i < binCount; i++) {
    const dx = i - cx
    num += dx * (mag[i] - mean)
    den += dx * dx
  }
  const slope = den > 0 ? num / den : 0
  const relSlope = (slope * binCount) / (mean * 4 + 1e-9)

  analysis.spectralCentroid = clamp01(centroid / (binCount || 1))
  analysis.spectralSpread = clamp01(spread / (binCount || 1))
  analysis.spectralFlatness = flatness
  analysis.spectralRolloff = clamp01(rolloffBin / (binCount || 1))
  analysis.spectralFlux = clamp01(flux / (binCount || 1))
  analysis.spectralContrast = contrast
  analysis.spectralSlope = clamp01(0.5 + relSlope * 0.5)
  analysis.peakFrequency = binToFrequency(maxBin, binCount, sampleRate)
  analysis.dominantFrequencies[0] = binToFrequency(peakBin[0], binCount, sampleRate)
  analysis.dominantFrequencies[1] = binToFrequency(peakBin[1], binCount, sampleRate)
  analysis.dominantFrequencies[2] = binToFrequency(peakBin[2], binCount, sampleRate)

  prevMag.set(mag.subarray(0, Math.min(binCount, prevMag.length)))
  hasPrev = true
}
