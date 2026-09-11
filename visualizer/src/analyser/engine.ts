import { BAND_COUNT, HIGH_BINS } from './fft'
import { coreFrame, readCoreFrame } from './core'
import { resetBands, updateBands, updateMacroBands } from './bands'
import { resetDynamics, updateDynamics } from './dynamics'
import { updateSpectral } from './spectral'
import { resetTransient, updateTransient } from './transient'
import { resetBeat, updateBeat } from './beat'
import { resetEvents } from './events'
import { resetHarmonic, updateHarmonic } from './harmonic'
import { resetPercussive, updatePercussive } from './percussive'
import { resetVocal, updateVocal } from './vocal'
import { resetSections, updateSections } from './sections'
import { updateTextures } from './textures'
import type { AudioAnalysis, AudioEvent, BandData } from './types'

const MAX_EVENTS = 32

function createBandDetails(): BandData[] {
  const out: BandData[] = []
  for (let i = 0; i < BAND_COUNT; i++) {
    out.push({
      index: i,
      low: 0,
      high: 0,
      center: 0,
      energy: 0,
      smoothed: 0,
      normalized: 0,
      velocity: 0,
      attack: 0,
      decay: 0,
      peak: 0,
      activity: 0,
    })
  }
  return out
}

function createEvents(): AudioEvent[] {
  const out: AudioEvent[] = []
  for (let i = 0; i < MAX_EVENTS; i++) {
    out.push({ type: 'energy', strength: 0, confidence: 0, frequency: 0, timestamp: 0 })
  }
  return out
}

const analysis: AudioAnalysis = {
  time: 0,
  frame: 0,
  source: 'idle',
  sampleRate: 48000,
  binCount: HIGH_BINS,
  fft: new Float32Array(HIGH_BINS),
  fftHigh: false,

  rms: 0,
  peak: 0,
  loudness: -80,
  normalizedLoudness: 0,
  energy: 0,
  dynamicRange: 0,

  subBass: 0,
  bass: 0,
  lowMid: 0,
  mid: 0,
  upperMid: 0,
  presence: 0,
  treble: 0,
  air: 0,

  bands: new Float32Array(BAND_COUNT),
  bandDetails: createBandDetails(),

  spectralCentroid: 0,
  spectralSpread: 0,
  spectralFlatness: 0,
  spectralRolloff: 0,
  spectralFlux: 0,
  spectralContrast: 0,
  spectralSlope: 0,
  peakFrequency: 0,
  dominantFrequencies: new Float32Array(3),
  noiseFloor: 0,

  transient: 0,
  transientStrength: 0,
  transientFrequency: 0,
  transientVelocity: 0,

  beat: 0,
  beatStrength: 0,
  bpm: 0,
  bpmConfidence: 0,
  beatPhase: 0,
  timeSinceBeat: 0,
  barPhase: 0,
  rhythmicEnergy: 0,

  harmonicEnergy: 0,
  percussiveEnergy: 0,
  harmonicRatio: 0,
  percussiveRatio: 0,

  vocalEnergy: 0,
  vocalPresence: 0,
  vocalActivity: 0,

  kickEnergy: 0,
  snareEnergy: 0,
  hatEnergy: 0,
  clapEnergy: 0,
  percussionEnergy: 0,

  energyVelocity: 0,
  energyAcceleration: 0,
  attackIntensity: 0,
  decayIntensity: 0,

  sectionEnergy: 0,
  sectionState: 'silence',

  events: createEvents(),
  eventCount: 0,
}

export function getAnalysis(): AudioAnalysis {
  return analysis
}

function zeroAnalysis(): void {
  analysis.rms = 0
  analysis.peak = 0
  analysis.loudness = -80
  analysis.normalizedLoudness = 0
  analysis.energy = 0
  analysis.dynamicRange = 0
  analysis.subBass = 0
  analysis.bass = 0
  analysis.lowMid = 0
  analysis.mid = 0
  analysis.upperMid = 0
  analysis.presence = 0
  analysis.treble = 0
  analysis.air = 0
  analysis.bands.fill(0)
  // Spectrum must go silent too — updateTextures() only rewrites [0, binCount)
  // and would otherwise freeze the FFT texture on the last live frame.
  analysis.fft.fill(0)
  // Detail bands carry the same data as `bands` plus derived envelopes; they
  // are read directly (see readVisualBands), so they must not stay stale while
  // idle. Edges (index/low/high/center) are static and stay untouched.
  for (let i = 0; i < analysis.bandDetails.length; i++) {
    const d = analysis.bandDetails[i]
    d.energy = 0
    d.smoothed = 0
    d.normalized = 0
    d.velocity = 0
    d.attack = 0
    d.decay = 0
    d.peak = 0
    d.activity = 0
  }
  analysis.spectralCentroid = 0
  analysis.spectralSpread = 0
  analysis.spectralFlatness = 0
  analysis.spectralRolloff = 0
  analysis.spectralFlux = 0
  analysis.spectralContrast = 0
  analysis.spectralSlope = 0
  analysis.peakFrequency = 0
  analysis.dominantFrequencies.fill(0)
  analysis.noiseFloor = 0
  analysis.transient = 0
  analysis.transientStrength = 0
  analysis.transientFrequency = 0
  analysis.transientVelocity = 0
  analysis.beat = 0
  analysis.beatStrength = 0
  analysis.bpm = 0
  analysis.bpmConfidence = 0
  analysis.beatPhase = 0
  analysis.timeSinceBeat = 0
  analysis.barPhase = 0
  analysis.rhythmicEnergy = 0
  analysis.harmonicEnergy = 0
  analysis.percussiveEnergy = 0
  analysis.harmonicRatio = 0
  analysis.percussiveRatio = 0
  analysis.vocalEnergy = 0
  analysis.vocalPresence = 0
  analysis.vocalActivity = 0
  analysis.kickEnergy = 0
  analysis.snareEnergy = 0
  analysis.hatEnergy = 0
  analysis.clapEnergy = 0
  analysis.percussionEnergy = 0
  analysis.energyVelocity = 0
  analysis.energyAcceleration = 0
  analysis.attackIntensity = 0
  analysis.decayIntensity = 0
  analysis.sectionEnergy = 0
  analysis.sectionState = 'silence'
  analysis.eventCount = 0
}

let idleZeroed = false
let lastFrameTime = 0

function updateAnalysis(): void {
  readCoreFrame()
  const now = coreFrame.time
  let dt = lastFrameTime > 0 ? now - lastFrameTime : 1 / 60
  lastFrameTime = now
  if (dt < 1 / 240) dt = 1 / 240
  else if (dt > 1 / 20) dt = 1 / 20

  analysis.time = now
  analysis.frame++

  if (coreFrame.idle) {
    if (!idleZeroed) {
      zeroAnalysis()
      resetDynamics()
      resetBands()
      resetTransient()
      resetBeat()
      resetEvents()
      resetHarmonic()
      resetPercussive()
      resetVocal()
      resetSections()
      analysis.source = 'idle'
      updateTextures(analysis)
      idleZeroed = true
    }
    return
  }

  idleZeroed = false
  analysis.source = 'live'
  analysis.sampleRate = coreFrame.sampleRate
  analysis.binCount = coreFrame.binCount
  analysis.fftHigh = coreFrame.usingHigh

  const n = coreFrame.binCount
  for (let i = 0; i < n; i++) analysis.fft[i] = coreFrame.fft[i]
  // binCount drops when switching from the 1024-bin tap to 256 extension
  // bins; clear the tail so the public `fft` field is never partly stale.
  for (let i = n; i < analysis.fft.length; i++) analysis.fft[i] = 0

  analysis.eventCount = 0
  updateMacroBands(analysis, coreFrame.fft, n, coreFrame.sampleRate)
  updateBands(analysis, coreFrame.mag, n, coreFrame.sampleRate, dt)
  updateSpectral(analysis, coreFrame.mag, n, coreFrame.sampleRate)
  updateDynamics(analysis, coreFrame.wave, coreFrame.waveValid, coreFrame.fft, n, dt)
  updateTransient(analysis, coreFrame.mag, n, coreFrame.sampleRate, dt)
  updateBeat(analysis, dt)
  updateHarmonic(analysis, coreFrame.mag, n)
  updatePercussive(analysis)
  updateVocal(analysis)
  updateSections(analysis, dt)

  updateTextures(analysis)
}

let running = false
let rafId = 0

function tick(): void {
  if (!running) return
  updateAnalysis()
  rafId = requestAnimationFrame(tick)
}

export function startAnalysis(): void {
  if (running || typeof window === 'undefined') return
  running = true
  rafId = requestAnimationFrame(tick)
}

export function stopAnalysis(): void {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}
