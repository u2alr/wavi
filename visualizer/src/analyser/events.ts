import type { AudioAnalysis, AudioEventType } from './types'

/**
 * Per-type cooldown in seconds. Prevents a single physical hit from spamming
 * multiple frames of events, and stops fast repeat triggers from stacking.
 */
const COOLDOWNS: Record<AudioEventType, number> = {
  kick: 0.09,
  snare: 0.09,
  hat: 0.045,
  clap: 0.1,
  percussion: 0.08,
  vocal: 0.5,
  bass: 0.15,
  harmonic: 0.3,
  transient: 0.04,
  beat: 0.2,
  energy: 0.2,
}

const lastEmit: Record<AudioEventType, number> = {
  kick: -1e9,
  snare: -1e9,
  hat: -1e9,
  clap: -1e9,
  percussion: -1e9,
  vocal: -1e9,
  bass: -1e9,
  harmonic: -1e9,
  transient: -1e9,
  beat: -1e9,
  energy: -1e9,
}

/**
 * Append an event to the reused per-frame buffer. Returns false when the type
 * is still in cooldown or the buffer is full. No allocation: the caller's
 * preallocated event objects are mutated in place.
 */
export function emitEvent(
  analysis: AudioAnalysis,
  type: AudioEventType,
  strength: number,
  confidence: number,
  frequency: number,
  time: number,
): boolean {
  if (time - lastEmit[type] < COOLDOWNS[type]) return false
  if (analysis.eventCount >= analysis.events.length) return false
  lastEmit[type] = time
  const e = analysis.events[analysis.eventCount++]
  e.type = type
  e.strength = strength
  e.confidence = confidence
  e.frequency = frequency
  e.timestamp = time
  return true
}

export function resetEvents(): void {
  lastEmit.kick = -1e9
  lastEmit.snare = -1e9
  lastEmit.hat = -1e9
  lastEmit.clap = -1e9
  lastEmit.percussion = -1e9
  lastEmit.vocal = -1e9
  lastEmit.bass = -1e9
  lastEmit.harmonic = -1e9
  lastEmit.transient = -1e9
  lastEmit.beat = -1e9
  lastEmit.energy = -1e9
}
