import {
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
} from 'three'
import { BAND_COUNT, HIGH_BINS } from './fft'
import type { AudioAnalysis } from './types'

const FEATURE_COUNT = 16

let fftTexture: DataTexture | null = null
let bandTexture: DataTexture | null = null
let featureTexture: DataTexture | null = null

let fftBytes = new Uint8Array(HIGH_BINS)
let bandBytes = new Uint8Array(BAND_COUNT)
let featureBytes = new Uint8Array(FEATURE_COUNT)

function makeTexture(data: Uint8Array, width: number): DataTexture {
  const tex = new DataTexture(data, width, 1, RedFormat, UnsignedByteType)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = false
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

/** Normalized spectrum texture, width HIGH_BINS. */
export function getFftTexture(): DataTexture {
  if (!fftTexture) fftTexture = makeTexture(fftBytes, HIGH_BINS)
  return fftTexture
}

/** Log-band energy texture, width BAND_COUNT. */
export function getBandTexture(): DataTexture {
  if (!bandTexture) bandTexture = makeTexture(bandBytes, BAND_COUNT)
  return bandTexture
}

/** Misc feature texture (centroid, flux, transient, beat, ...), width 16. */
export function getFeatureTexture(): DataTexture {
  if (!featureTexture) featureTexture = makeTexture(featureBytes, FEATURE_COUNT)
  return featureTexture
}

export function updateTextures(analysis: AudioAnalysis): void {
  const n = Math.min(analysis.binCount, HIGH_BINS)
  for (let i = 0; i < n; i++) fftBytes[i] = (analysis.fft[i] * 255) | 0
  for (let i = n; i < HIGH_BINS; i++) fftBytes[i] = 0

  for (let i = 0; i < BAND_COUNT; i++) bandBytes[i] = (analysis.bands[i] * 255) | 0

  featureBytes[0] = (analysis.spectralCentroid * 255) | 0
  featureBytes[1] = (analysis.spectralFlatness * 255) | 0
  featureBytes[2] = (analysis.spectralRolloff * 255) | 0
  featureBytes[3] = (analysis.spectralFlux * 255) | 0
  featureBytes[4] = (analysis.transientStrength * 255) | 0
  featureBytes[5] = (analysis.beatStrength * 255) | 0
  featureBytes[6] = (analysis.harmonicRatio * 255) | 0
  featureBytes[7] = (analysis.percussiveRatio * 255) | 0
  featureBytes[8] = (analysis.vocalPresence * 255) | 0
  featureBytes[9] = (analysis.energy * 255) | 0
  featureBytes[10] = (analysis.kickEnergy * 255) | 0
  featureBytes[11] = (analysis.snareEnergy * 255) | 0
  featureBytes[12] = (analysis.hatEnergy * 255) | 0
  featureBytes[13] = (analysis.subBass * 255) | 0
  featureBytes[14] = (analysis.treble * 255) | 0
  featureBytes[15] = (analysis.bpmConfidence * 255) | 0

  if (fftTexture) fftTexture.needsUpdate = true
  if (bandTexture) bandTexture.needsUpdate = true
  if (featureTexture) featureTexture.needsUpdate = true
}
