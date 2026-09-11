import { binToFrequency, HIGH_BINS } from './fft'
import { emitEvent } from './events'
import { clamp, clamp01, Envelope } from './smoothing'
import type { AudioAnalysis } from './types'

// Half-wave-rectified spectral flux, tracked against an adaptive threshold
// built from a rolling mean + standard deviation. No fixed onset threshold.
const MEAN_FACTOR = 0.04
const VAR_FACTOR = 0.04
const THRESHOLD_K = 1.6
const ABS_FLOOR = 0.0012
const MIN_INTERVAL = 0.045
const WARMUP = 8

const prevMag = new Float32Array(HIGH_BINS)
const transientEnv = new Envelope(0.8, 0.12)

let hasPrev = false
let prevFlux = 0
let fluxMean = 0
let fluxVar = 0
let frames = 0
let lastOnset = -1e9
let strengthHold = 0
let prevStrength = 0

export function updateTransient(
  analysis: AudioAnalysis,
  mag: Float32Array,
  binCount: number,
  sampleRate: number,
  dt: number,
): void {
  let flux = 0
  let weighted = 0
  let fluxFreq = 0

  if (hasPrev) {
    for (let i = 0; i < binCount; i++) {
      const d = mag[i] - prevMag[i]
      if (d > 0) {
        flux += d
        weighted += i * d
      }
    }
    flux /= binCount || 1
    if (weighted > 1e-9) fluxFreq = binToFrequency(weighted / (flux * (binCount || 1)), binCount, sampleRate)
  }

  const dev = flux - fluxMean
  fluxMean += dev * MEAN_FACTOR
  fluxVar += (dev * dev - fluxVar) * VAR_FACTOR
  const std = Math.sqrt(fluxVar < 0 ? 0 : fluxVar)
  const threshold = fluxMean + THRESHOLD_K * std + ABS_FLOOR

  frames++
  const time = analysis.time
  let onset = 0
  let strength = 0

  if (
    frames > WARMUP &&
    hasPrev &&
    flux > threshold &&
    flux >= prevFlux &&
    flux > ABS_FLOOR &&
    time - lastOnset >= MIN_INTERVAL
  ) {
    onset = 1
    lastOnset = time
    strength = clamp01((flux - threshold) / (threshold + 1e-6) / 2)
    analysis.transientFrequency = fluxFreq
    emitEvent(analysis, 'transient', strength, clamp01(flux / (threshold + 1e-6) - 1), fluxFreq, time)
  }

  prevFlux = flux
  prevMag.set(mag.subarray(0, Math.min(binCount, prevMag.length)))
  hasPrev = true

  const env = transientEnv.process(onset ? strength : 0)
  strengthHold = strength > strengthHold ? strength : strengthHold * 0.9
  const velocity = dt > 0 ? (strengthHold - prevStrength) / dt : 0
  prevStrength = strengthHold

  analysis.transient = clamp01(env)
  analysis.transientStrength = clamp01(strengthHold)
  analysis.transientVelocity = clamp(velocity, -6, 6)
}

export function resetTransient(): void {
  prevMag.fill(0)
  transientEnv.reset()
  hasPrev = false
  prevFlux = 0
  fluxMean = 0
  fluxVar = 0
  frames = 0
  lastOnset = -1e9
  strengthHold = 0
  prevStrength = 0
}
