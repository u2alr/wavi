import { emitEvent } from './events'
import { AdaptiveNormalizer } from './normalization'
import { clamp01, Envelope } from './smoothing'
import { getStemProvider } from './stems'
import type { AudioAnalysis } from './types'

// Approximate vocal presence. There is no isolation here: we combine energy in
// the vocal formant region with tonality (low flatness), harmonic dominance,
// sustain (low transient) and stability (low spectral flux — voice sustains,
// drums spike). When a StemProvider is registered (Demucs/MDX) its
// vocals stem replaces the heuristic entirely.
const GATE = 0.5

const vocalNorm = new AdaptiveNormalizer({ attack: 0.18, release: 0.008 })
const presenceEnv = new Envelope(0.4, 0.05)
const activityEnv = new Envelope(0.15, 0.01)

export function updateVocal(analysis: AudioAnalysis): void {
  const provider = getStemProvider()

  let raw: number
  if (provider) {
    raw = clamp01(provider.vocals)
  } else {
    const formant =
      analysis.mid * 0.4 + analysis.upperMid * 0.3 + analysis.presence * 0.3
    const tonality = 1 - analysis.spectralFlatness
    const sustain = 1 - analysis.transient
    const harmonic = analysis.harmonicRatio
    const stability = 1 - clamp01(analysis.spectralFlux * 1.5)
    raw = formant * (0.4 + 0.6 * harmonic) * (0.5 + 0.5 * tonality) * (0.6 + 0.4 * sustain) * (0.5 + 0.5 * stability)
  }

  vocalNorm.update(raw)
  const energy = clamp01(vocalNorm.normalize(raw))
  const presence = presenceEnv.process(energy)
  const activity = activityEnv.process(energy)

  analysis.vocalEnergy = energy
  analysis.vocalPresence = clamp01(presence)
  analysis.vocalActivity = clamp01(activity)

  if (presence > GATE && energy > GATE) {
    emitEvent(analysis, 'vocal', energy, presence, 0, analysis.time)
  }
}

export function resetVocal(): void {
  vocalNorm.reset()
  presenceEnv.reset()
  activityEnv.reset()
}
