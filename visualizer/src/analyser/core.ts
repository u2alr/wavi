import { getExtensionWaveData, getFreqData, getSampleRate, getSharedAnalyserNode } from '../audio'
import { byteToLinear, HIGH_BINS, TAP_SIZE, WAVE_SAMPLES } from './fft'

const TAP_SMOOTHING = 0.6

let highAnalyser: AnalyserNode | null = null
let tappedFrom: AnalyserNode | null = null

/**
 * Dedicated high-resolution analyser tapped off the shared node, mirroring
 * emberAnalyser. Gives 1024 frequency bins + 2048 time-domain samples for
 * local files. Returns null in extension/Spotify mode, where only 256 bins
 * and a 2048-byte wave arrive over postMessage.
 */
function getHighResAnalyser(): AnalyserNode | null {
  const shared = getSharedAnalyserNode()
  if (!shared) return null

  if (shared !== tappedFrom) {
    if (highAnalyser && tappedFrom) tappedFrom.disconnect(highAnalyser)
    highAnalyser = shared.context.createAnalyser()
    highAnalyser.fftSize = TAP_SIZE
    highAnalyser.smoothingTimeConstant = TAP_SMOOTHING
    shared.connect(highAnalyser)
    tappedFrom = shared
  }
  return highAnalyser
}

export interface CoreFrame {
  time: number
  sampleRate: number
  binCount: number
  usingHigh: boolean
  waveValid: boolean
  idle: boolean
  /** Normalized 0..1 perceptual spectrum (GPU-friendly). */
  fft: Float32Array
  /** Linear magnitude spectrum, normalized 0..1 (for spectral math).
   *  Scale matters: transient/spectral-flux detectors are tuned for 0..1. */
  mag: Float32Array
  /** Time-domain samples, -1..1. */
  wave: Float32Array
}

export const coreFrame: CoreFrame = {
  time: 0,
  sampleRate: 48000,
  binCount: HIGH_BINS,
  usingHigh: false,
  waveValid: false,
  idle: true,
  fft: new Float32Array(HIGH_BINS),
  mag: new Float32Array(HIGH_BINS),
  wave: new Float32Array(WAVE_SAMPLES),
}

const byteScratch = new Uint8Array(HIGH_BINS)
const waveScratch = new Float32Array(WAVE_SAMPLES)

// byteToLinear tops out at byte 255 (-30 dB). Divide by that so mag spans
// 0..1 like the perceptual `fft` field — transient/beat detectors rely on it.
const MAG_SCALE = 1 / byteToLinear[255]

export function readCoreFrame(): void {
  const sampleRate = getSampleRate()
  const extWave = getExtensionWaveData()

  coreFrame.time = performance.now() / 1000
  coreFrame.sampleRate = sampleRate

  if (extWave) {
    const base = getFreqData()
    const n = Math.min(base.length, HIGH_BINS)
    for (let i = 0; i < n; i++) {
      const b = base[i]
      coreFrame.fft[i] = b / 255
      coreFrame.mag[i] = byteToLinear[b] * MAG_SCALE
    }
    for (let i = n; i < HIGH_BINS; i++) {
      coreFrame.fft[i] = 0
      coreFrame.mag[i] = 0
    }
    coreFrame.binCount = n
    coreFrame.usingHigh = false

    const wn = Math.min(extWave.length, WAVE_SAMPLES)
    for (let i = 0; i < wn; i++) coreFrame.wave[i] = (extWave[i] - 128) / 128
    for (let i = wn; i < WAVE_SAMPLES; i++) coreFrame.wave[i] = 0
    coreFrame.waveValid = true
    coreFrame.idle = false
    return
  }

  const high = getHighResAnalyser()
  if (high) {
    high.getByteFrequencyData(byteScratch)
    for (let i = 0; i < HIGH_BINS; i++) {
      const b = byteScratch[i]
      coreFrame.fft[i] = b / 255
      coreFrame.mag[i] = byteToLinear[b] * MAG_SCALE
    }
    high.getFloatTimeDomainData(waveScratch)
    coreFrame.binCount = HIGH_BINS
    coreFrame.usingHigh = true
    coreFrame.waveValid = true
    coreFrame.idle = false
    return
  }

  // Reaching here means getHighResAnalyser() returned null, which only happens
  // when no analyser is wired into the graph at all — nothing is loaded and no
  // extension frame arrived. Report idle (rather than streaming a zeroed
  // spectrum as if it were live) so the engine zeroes its state once and then
  // skips per-frame work until a source appears.
  coreFrame.fft.fill(0)
  coreFrame.mag.fill(0)
  coreFrame.wave.fill(0)
  coreFrame.binCount = 0
  coreFrame.usingHigh = false
  coreFrame.waveValid = false
  coreFrame.idle = true
}
