// emberAnalyser.ts
import { getSharedAnalyserNode } from './audio'

// Must equal the shader's SIZE — getByteTimeDomainData fills exactly fftSize samples
const FFT_SIZE = 2048

let waveAnalyser: AnalyserNode | null = null
let tappedFrom: AnalyserNode | null = null

/**
 * Dedicated AnalyserNode for Fractal Ember's waveform texture.
 * The shared analyser in audio.ts is tuned for frequency bands
 * (fftSize 512, smoothing 0.8) — too coarse/smoothed for a clean
 * oscilloscope trace, so this preset gets its own tap: full 2048-sample
 * buffer, wired as sharedAnalyser -> waveAnalyser (never -> destination).
 */
export function getEmberWaveAnalyser(): AnalyserNode | null {
  const shared = getSharedAnalyserNode()
  if (!shared) return null // no track loaded yet, or extension-audio mode

  if (shared !== tappedFrom) {
    if (waveAnalyser && tappedFrom) {
      tappedFrom.disconnect(waveAnalyser) // remove only this specific edge
    }
    waveAnalyser = shared.context.createAnalyser()
    waveAnalyser.fftSize = FFT_SIZE
    shared.connect(waveAnalyser)
    tappedFrom = shared
  }

  return waveAnalyser
}

export function teardownEmberWaveAnalyser() {
  if (waveAnalyser && tappedFrom) {
    tappedFrom.disconnect(waveAnalyser)
  }
  waveAnalyser = null
  tappedFrom = null
}