import { getFreqData, getExtensionWaveData } from './audio'
import { getSharedAnalyserNode } from './audio'

export interface AudioFeatures {
  bass: number
  mids: number
  treble: number
  energy: number
  /** Decaying onset pulse: 1 on kick, ~0 after 300ms. */
  beat: number
}

const BASS_END = 0.1
const MID_END = 0.4
const BEAT_BINS = 12
const BEAT_COOLDOWN_MS = 240

const cached: AudioFeatures = { bass: 0, mids: 0, treble: 0, energy: 0, beat: 0 }
const prevMag = new Float32Array(256)
let fluxAvg = 0
let lastBeatAt = -1e9
let lastT = -1
let inited = false

function follow(current: number, target: number, dt: number): number {
  const rate = target > current ? 18 : 4.5 // fast attack, slow release
  return current + (target - current) * (1 - Math.exp(-dt * rate))
}

/**
 * Central audio feature engine. Call once per frame — results are cached
 * within a 2ms window so multiple presets/layers share one FFT read.
 * Idle (no source) decays everything to 0; shaders keep their own idle drift.
 */
export function getAudioFeatures(now = performance.now()): AudioFeatures {
  if (inited && now - lastT < 2) return cached
  const dt = inited ? Math.min(0.1, Math.max(1e-3, (now - lastT) / 1000)) : 1 / 60
  lastT = now
  inited = true

  const freq = getFreqData()
  const len = Math.min(freq.length, prevMag.length)
  const bassEnd = Math.floor(len * BASS_END)
  const midEnd = Math.floor(len * MID_END)

  let bass = 0, mids = 0, treble = 0, sumSq = 0
  for (let i = 0; i < bassEnd; i++) bass += freq[i]
  for (let i = bassEnd; i < midEnd; i++) mids += freq[i]
  for (let i = midEnd; i < len; i++) treble += freq[i]
  for (let i = 0; i < len; i++) {
    const v = freq[i] / 255
    sumSq += v * v
  }

  cached.bass = follow(cached.bass, bass / (bassEnd * 255), dt)
  cached.mids = follow(cached.mids, mids / ((midEnd - bassEnd) * 255), dt)
  cached.treble = follow(cached.treble, treble / ((len - midEnd) * 255), dt)
  cached.energy = follow(cached.energy, Math.sqrt(sumSq / len) * 2.2, dt)

  // Spectral-flux onset on the low bins (kick region at fftSize 512).
  let flux = 0
  const n = Math.min(BEAT_BINS, len)
  for (let i = 1; i < n; i++) {
    const v = freq[i] / 255
    const d = v - prevMag[i]
    if (d > 0) flux += d
    prevMag[i] = v
  }
  flux /= n
  fluxAvg += (flux - fluxAvg) * (1 - Math.exp(-dt * 1.5))
  if (flux > fluxAvg * 1.6 + 0.02 && now - lastBeatAt > BEAT_COOLDOWN_MS) {
    cached.beat = 1
    lastBeatAt = now
  } else {
    cached.beat *= Math.exp(-dt * 5)
    if (cached.beat < 0.001) cached.beat = 0
  }

  return cached
}

/** 512-sample time-domain snapshot for the wave-field layer. 128 = silence. */
export const WAVE_SIZE = 512

let tdScratch: Uint8Array<ArrayBuffer> | null = null

export function fillWaveTrace(out: Uint8Array): void {
  const ext = getExtensionWaveData()
  if (ext) {
    out.fill(128)
    out.set(ext.subarray(0, Math.min(ext.length, out.length)))
    return
  }
  const node = getSharedAnalyserNode()
  if (!node) {
    out.fill(128)
    return
  }
  if (!tdScratch || tdScratch.length !== node.fftSize) tdScratch = new Uint8Array(node.fftSize)
  node.getByteTimeDomainData(tdScratch)
  for (let i = 0; i < out.length; i++) out[i] = tdScratch[(i * tdScratch.length / out.length) | 0]
}
