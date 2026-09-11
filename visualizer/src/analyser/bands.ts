import { BAND_COUNT, frequencyToBin } from './fft'
import { AdaptiveNormalizer } from './normalization'
import { clamp01, Envelope } from './smoothing'
import type { AudioAnalysis } from './types'

const MIN_FREQ = 20
const MAX_FREQ = 20000

interface BandEdges {
  low: Int32Array
  high: Int32Array
  center: Float32Array
}

const edgeCache = new Map<string, BandEdges>()

function bandEdges(binCount: number, sampleRate: number): BandEdges {
  const key = `${binCount}:${sampleRate}`
  const cached = edgeCache.get(key)
  if (cached) return cached

  const nyquist = sampleRate / 2
  const maxFreq = Math.min(MAX_FREQ, nyquist * 0.95)
  const low = new Int32Array(BAND_COUNT)
  const high = new Int32Array(BAND_COUNT)
  const center = new Float32Array(BAND_COUNT)
  const ratio = maxFreq / MIN_FREQ

  for (let i = 0; i < BAND_COUNT; i++) {
    const fLow = MIN_FREQ * Math.pow(ratio, i / BAND_COUNT)
    const fHigh = MIN_FREQ * Math.pow(ratio, (i + 1) / BAND_COUNT)
    let lo = frequencyToBin(fLow, binCount, sampleRate)
    let hi = frequencyToBin(fHigh, binCount, sampleRate)
    if (hi <= lo) hi = lo + 1
    if (hi > binCount) hi = binCount
    low[i] = lo
    high[i] = hi
    center[i] = Math.sqrt(fLow * fHigh)
  }

  const edges = { low, high, center }
  edgeCache.set(key, edges)
  return edges
}

const bandNorm: AdaptiveNormalizer[] = []
const bandEnvelope: Envelope[] = []
const bandAttack: Envelope[] = []
const bandDecay: Envelope[] = []
const bandActivity: Envelope[] = []
const bandPeak = new Float32Array(BAND_COUNT)
const bandPrevEnergy = new Float32Array(BAND_COUNT)

for (let i = 0; i < BAND_COUNT; i++) {
  bandNorm.push(new AdaptiveNormalizer({ attack: 0.3, release: 0.004 }))
  bandEnvelope.push(new Envelope(0.5, 0.15))
  bandAttack.push(new Envelope(0.6, 0.1))
  bandDecay.push(new Envelope(0.4, 0.05))
  bandActivity.push(new Envelope(0.3, 0.02))
}

export function resetBands(): void {
  for (let i = 0; i < BAND_COUNT; i++) {
    bandNorm[i].reset()
    bandEnvelope[i].reset()
    bandAttack[i].reset()
    bandDecay[i].reset()
    bandActivity[i].reset()
    bandPeak[i] = 0
    bandPrevEnergy[i] = 0
  }
}

export function updateBands(
  analysis: AudioAnalysis,
  mag: Float32Array,
  binCount: number,
  sampleRate: number,
  dt: number,
): void {
  const edges = bandEdges(binCount, sampleRate)
  const peakDecay = dt * 0.4

  for (let b = 0; b < BAND_COUNT; b++) {
    const lo = edges.low[b]
    const hi = edges.high[b]
    let sum = 0
    for (let i = lo; i < hi; i++) sum += mag[i]
    const energy = sum / (hi - lo || 1)

    bandNorm[b].update(energy)
    const normalized = bandNorm[b].normalize(energy)
    const smoothed = bandEnvelope[b].process(energy)

    const velocity = energy - bandPrevEnergy[b]
    bandPrevEnergy[b] = energy
    const attack = bandAttack[b].process(velocity > 0 ? velocity : 0)
    const decay = bandDecay[b].process(velocity < 0 ? -velocity : 0)
    bandPeak[b] = Math.max(energy, bandPeak[b] - peakDecay)
    const activity = bandActivity[b].process(normalized)

    analysis.bands[b] = normalized

    const detail = analysis.bandDetails[b]
    detail.index = b
    detail.low = bandFreq(edges, b, false, sampleRate, binCount)
    detail.high = bandFreq(edges, b, true, sampleRate, binCount)
    detail.center = edges.center[b]
    detail.energy = energy
    detail.smoothed = smoothed
    detail.normalized = normalized
    detail.velocity = velocity
    detail.attack = attack
    detail.decay = decay
    detail.peak = bandPeak[b]
    detail.activity = activity
  }
}

function bandFreq(edges: BandEdges, b: number, high: boolean, sampleRate: number, binCount: number): number {
  const bin = high ? edges.high[b] : edges.low[b]
  return (bin * sampleRate) / (binCount * 2)
}

interface MacroRange {
  lo: number
  hi: number
}

const MACRO: Record<string, MacroRange> = {
  subBass: { lo: 20, hi: 60 },
  bass: { lo: 60, hi: 250 },
  lowMid: { lo: 250, hi: 500 },
  mid: { lo: 500, hi: 2000 },
  upperMid: { lo: 2000, hi: 4000 },
  presence: { lo: 4000, hi: 6000 },
  treble: { lo: 6000, hi: 12000 },
  air: { lo: 12000, hi: 20000 },
}

function macroEnergy(fft: Float32Array, binCount: number, sampleRate: number, range: MacroRange): number {
  let lo = frequencyToBin(range.lo, binCount, sampleRate)
  let hi = frequencyToBin(range.hi, binCount, sampleRate)
  if (hi <= lo) hi = lo + 1
  if (hi > binCount) hi = binCount
  let sum = 0
  for (let i = lo; i < hi; i++) sum += fft[i]
  return clamp01(sum / (hi - lo || 1))
}

export function updateMacroBands(
  analysis: AudioAnalysis,
  fft: Float32Array,
  binCount: number,
  sampleRate: number,
): void {
  analysis.subBass = macroEnergy(fft, binCount, sampleRate, MACRO.subBass)
  analysis.bass = macroEnergy(fft, binCount, sampleRate, MACRO.bass)
  analysis.lowMid = macroEnergy(fft, binCount, sampleRate, MACRO.lowMid)
  analysis.mid = macroEnergy(fft, binCount, sampleRate, MACRO.mid)
  analysis.upperMid = macroEnergy(fft, binCount, sampleRate, MACRO.upperMid)
  analysis.presence = macroEnergy(fft, binCount, sampleRate, MACRO.presence)
  analysis.treble = macroEnergy(fft, binCount, sampleRate, MACRO.treble)
  analysis.air = macroEnergy(fft, binCount, sampleRate, MACRO.air)
}
