import { emitEvent } from './events'
import { AdaptiveNormalizer } from './normalization'
import { clamp01, Envelope } from './smoothing'
import type { AudioAnalysis } from './types'

// Per-instrument confidence estimates. These are NOT classifications: Web
// Audio cannot isolate a drum, so each value is a frequency-emphasis + onset
// heuristic, adaptively normalized and gated on a detected transient.
const KICK_FREQ = 55
const SNARE_FREQ = 200
const HAT_FREQ = 8000
const CLAP_FREQ = 2500
const PERC_FREQ = 400
const GATE = 0.5
const TRANSIENT_GATE = 0.15

const kickNorm = new AdaptiveNormalizer({ attack: 0.3, release: 0.008 })
const snareNorm = new AdaptiveNormalizer({ attack: 0.3, release: 0.008 })
const hatNorm = new AdaptiveNormalizer({ attack: 0.35, release: 0.006 })
const clapNorm = new AdaptiveNormalizer({ attack: 0.3, release: 0.008 })
const percNorm = new AdaptiveNormalizer({ attack: 0.25, release: 0.008 })

const hatEnv = new Envelope(0.7, 0.08)

export function updatePercussive(analysis: AudioAnalysis): void {
  const t = analysis.transientStrength
  const flat = analysis.spectralFlatness
  const time = analysis.time

  const kickRaw = (analysis.subBass * 0.7 + analysis.bass * 0.3) * t
  const snareRaw = (analysis.lowMid * 0.3 + analysis.mid * 0.3 + analysis.presence * 0.4) * t
  const hatRaw = (analysis.treble * 0.5 + analysis.air * 0.5) * t
  const clapRaw = (analysis.presence * 0.6 + analysis.upperMid * 0.4) * t * (0.4 + 0.6 * flat)
  const percRaw = analysis.percussiveRatio * t

  kickNorm.update(kickRaw)
  snareNorm.update(snareRaw)
  hatNorm.update(hatRaw)
  clapNorm.update(clapRaw)
  percNorm.update(percRaw)

  const kick = clamp01(kickNorm.normalize(kickRaw))
  const snare = clamp01(snareNorm.normalize(snareRaw))
  const hat = clamp01(hatEnv.process(hatNorm.normalize(hatRaw)))
  const clap = clamp01(clapNorm.normalize(clapRaw))
  const perc = clamp01(percNorm.normalize(percRaw))

  analysis.kickEnergy = kick
  analysis.snareEnergy = snare
  analysis.hatEnergy = hat
  analysis.clapEnergy = clap
  analysis.percussionEnergy = perc

  if (t < TRANSIENT_GATE) return
  if (kick > GATE) emitEvent(analysis, 'kick', kick, kick, KICK_FREQ, time)
  if (snare > GATE) emitEvent(analysis, 'snare', snare, snare, SNARE_FREQ, time)
  if (hat > GATE) emitEvent(analysis, 'hat', hat, hat, HAT_FREQ, time)
  if (clap > GATE) emitEvent(analysis, 'clap', clap, clap, CLAP_FREQ, time)
  if (perc > GATE) emitEvent(analysis, 'percussion', perc, perc, PERC_FREQ, time)
}

export function resetPercussive(): void {
  kickNorm.reset()
  snareNorm.reset()
  hatNorm.reset()
  clapNorm.reset()
  percNorm.reset()
  hatEnv.reset()
}
