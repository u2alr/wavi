export type SectionState =
  | 'silence'
  | 'intro'
  | 'low'
  | 'building'
  | 'energetic'
  | 'peak'
  | 'breakdown'
  | 'outro'

export type AudioEventType =
  | 'kick'
  | 'snare'
  | 'hat'
  | 'clap'
  | 'percussion'
  | 'vocal'
  | 'bass'
  | 'harmonic'
  | 'transient'
  | 'beat'
  | 'energy'

export interface AudioEvent {
  type: AudioEventType
  strength: number
  confidence: number
  frequency: number
  timestamp: number
}

export interface BandData {
  index: number
  low: number
  high: number
  center: number
  energy: number
  smoothed: number
  normalized: number
  velocity: number
  attack: number
  decay: number
  peak: number
  activity: number
}

/**
 * Optional source-separation backend. A future ML model (Demucs / MDX) can
 * supply per-stem energy in 0..1 without any preset changes; when absent the
 * engine falls back to spectral heuristics.
 */
export interface StemProvider {
  vocals: number
  drums: number
  bass: number
  other: number
}

export interface AudioAnalysis {
  time: number
  frame: number
  source: 'live' | 'idle'
  sampleRate: number
  binCount: number
  /** Normalized 0..1 perceptual spectrum, safe for GPU upload. */
  fft: Float32Array
  /** True when a high-resolution (2048-tap) analyser supplied the frame. */
  fftHigh: boolean

  // Dynamics
  rms: number
  peak: number
  loudness: number
  normalizedLoudness: number
  energy: number
  dynamicRange: number

  // Macro bands (0..1)
  subBass: number
  bass: number
  lowMid: number
  mid: number
  upperMid: number
  presence: number
  treble: number
  air: number

  // Log-spaced detail bands
  bands: Float32Array
  bandDetails: BandData[]

  // Spectral shape
  spectralCentroid: number
  spectralSpread: number
  spectralFlatness: number
  spectralRolloff: number
  spectralFlux: number
  spectralContrast: number
  spectralSlope: number
  peakFrequency: number
  dominantFrequencies: Float32Array
  noiseFloor: number

  // Transient
  transient: number
  transientStrength: number
  transientFrequency: number
  transientVelocity: number

  // Beat / rhythm
  beat: number
  beatStrength: number
  bpm: number
  bpmConfidence: number
  beatPhase: number
  timeSinceBeat: number
  barPhase: number
  rhythmicEnergy: number

  // Harmonic / percussive
  harmonicEnergy: number
  percussiveEnergy: number
  harmonicRatio: number
  percussiveRatio: number

  // Vocal (approximate)
  vocalEnergy: number
  vocalPresence: number
  vocalActivity: number

  // Percussive confidence estimates
  kickEnergy: number
  snareEnergy: number
  hatEnergy: number
  clapEnergy: number
  percussionEnergy: number

  // Energy motion
  energyVelocity: number
  energyAcceleration: number
  attackIntensity: number
  decayIntensity: number

  // Section
  sectionEnergy: number
  sectionState: SectionState

  // Events emitted this frame (reused array, valid up to eventCount)
  events: AudioEvent[]
  eventCount: number
}
