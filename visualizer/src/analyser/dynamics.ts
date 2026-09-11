import { AdaptiveNormalizer } from './normalization'
import { clamp, clamp01, Envelope } from './smoothing'
import type { AudioAnalysis } from './types'

const rmsNorm = new AdaptiveNormalizer({ attack: 0.2, release: 0.01 })
const attackEnv = new Envelope(0.6, 0.08)
const decayEnv = new Envelope(0.4, 0.04)

let prevEnergy = 0
let prevVelocity = 0

export function updateDynamics(
  analysis: AudioAnalysis,
  wave: Float32Array,
  waveValid: boolean,
  fft: Float32Array,
  binCount: number,
  dt: number,
): void {
  let rms = 0
  let peak = 0

  if (waveValid) {
    let sumSq = 0
    for (let i = 0; i < wave.length; i++) {
      const s = wave[i]
      sumSq += s * s
      const a = s < 0 ? -s : s
      if (a > peak) peak = a
    }
    rms = Math.sqrt(sumSq / (wave.length || 1))
  } else {
    // No time-domain data (extension idle): estimate from the spectrum.
    let sum = 0
    for (let i = 0; i < binCount; i++) sum += fft[i]
    rms = (sum / (binCount || 1)) * 0.5
    peak = rms * 1.5
  }

  const loudnessDb = 20 * Math.log10(rms + 1e-6)
  rmsNorm.update(rms)
  const energy = rmsNorm.normalize(rms)

  const velocity = dt > 0 ? (energy - prevEnergy) / dt : 0
  const acceleration = dt > 0 ? (velocity - prevVelocity) / dt : 0
  prevEnergy = energy
  prevVelocity = velocity

  analysis.rms = clamp01(rms)
  analysis.peak = clamp01(peak)
  analysis.loudness = clamp(loudnessDb, -80, 0)
  analysis.normalizedLoudness = clamp01((loudnessDb + 60) / 60)
  analysis.energy = energy
  analysis.dynamicRange = clamp01(peak - rms)
  analysis.noiseFloor = rmsNorm.floor
  analysis.energyVelocity = clamp(velocity, -4, 4)
  analysis.energyAcceleration = clamp(acceleration, -8, 8)
  analysis.attackIntensity = attackEnv.process(velocity > 0 ? clamp01(velocity) : 0)
  analysis.decayIntensity = decayEnv.process(velocity < 0 ? clamp01(-velocity) : 0)
}

export function resetDynamics(): void {
  rmsNorm.reset()
  attackEnv.reset()
  decayEnv.reset()
  prevEnergy = 0
  prevVelocity = 0
}
