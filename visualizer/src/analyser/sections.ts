import { clamp01, ema } from './smoothing'
import type { AudioAnalysis, SectionState } from './types'

// Slow, hysteretic song-section tracker. Two nested EMAs give a stable
// loudness envelope; a high-water mark lets a drop be read as a breakdown.
const SLOW_FACTOR = 0.02
const SLOWER_FACTOR = 0.006
const PEAK = 0.7
const ENERGETIC = 0.42
const LOW = 0.15
const BUILD_TREND = 0.0015
const FALL_TREND = -0.0012
const BREAKDOWN_DROP = 0.22
const OUTRO_AFTER = 30
const MIN_STATE_TIME = 0.5

let slow = 0
let slower = 0
let highWater = 0
let prevSlow = 0
let state: SectionState = 'silence'
let stateTime = 0
let startTime = 0

function setState(next: SectionState): void {
  state = next
  stateTime = 0
}

export function updateSections(analysis: AudioAnalysis, dt: number): void {
  const e = analysis.energy
  slow = ema(slow, e, SLOW_FACTOR)
  slower = ema(slower, e, SLOWER_FACTOR)
  highWater = slow > highWater ? slow : highWater * (1 - 0.0008)

  const trend = slow - prevSlow
  prevSlow = slow
  if (startTime === 0) startTime = analysis.time
  const elapsed = analysis.time - startTime
  stateTime += dt

  const silent = analysis.rms < 0.004 && e < 0.02
  let next = state

  if (silent) {
    next = 'silence'
  } else if (slow > PEAK) {
    next = 'peak'
  } else if (slow > ENERGETIC) {
    next = 'energetic'
  } else if (trend > BUILD_TREND && slow > 0.12) {
    next = 'building'
  } else if (highWater > 0.45 && slow < highWater - BREAKDOWN_DROP) {
    next = 'breakdown'
  } else if (slow < LOW) {
    next = elapsed < 12 ? 'intro' : 'low'
  } else if (trend < FALL_TREND && elapsed > OUTRO_AFTER && slow < 0.35) {
    next = 'outro'
  } else {
    next = 'low'
  }

  if (next !== state && (next === 'silence' || stateTime >= MIN_STATE_TIME)) {
    setState(next)
  }

  analysis.sectionEnergy = clamp01(slower)
  analysis.sectionState = state
}

export function resetSections(): void {
  slow = 0
  slower = 0
  highWater = 0
  prevSlow = 0
  state = 'silence'
  stateTime = 0
  startTime = 0
}
