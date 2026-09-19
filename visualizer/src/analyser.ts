/**
 * Public entry point for the audio analysis engine.
 *
 * The implementation lives in `./analyser/` (a directory); this file exists so
 * the bare specifier `./analyser` resolves deterministically to the current
 * engine rather than to a stale sibling module. Presets should import from
 * here, never from `./analyser/...` internals.
 *
 * Importing this module starts the engine's own rAF loop — `startAnalysis()`
 * runs at module scope below, independently of React.
 */
import { BAND_COUNT } from './analyser/fft'
import { startAnalysis } from './analyser/engine'
import { getStemProvider, setStemProvider } from './analyser/stems'
import type { AudioAnalysis, StemProvider } from './analyser/types'

export {
  getAnalysis,
  startAnalysis,
  stopAnalysis,
} from './analyser/engine'
export {
  getFftTexture,
  getBandTexture,
  getFeatureTexture,
} from './analyser/textures'
export { getStemProvider }

export type {
  AudioAnalysis,
  AudioEvent,
  AudioEventType,
  BandData,
  SectionState,
  StemProvider,
} from './analyser/types'

/**
 * Register a source-separation backend (e.g. Demucs/MDX). When set, vocal and
 * percussive estimators use the supplied stem energies instead of heuristics.
 * Presets never need to change.
 */
export function configureAnalysis(opts: { stemProvider?: StemProvider | null }): void {
  if ('stemProvider' in opts) setStemProvider(opts.stemProvider ?? null)
}

/** Number of visual bands contour-style presets consume. */
export const VISUAL_BAND_COUNT = 7

/**
 * Bin ranges into the engine's 32 log-spaced detail bands, one per visual
 * band. Both sets are log-spaced over the same 20Hz–20kHz range, so an even
 * index split keeps each visual band inside its own frequency region.
 */
const VISUAL_BAND_RANGES: Array<[number, number]> = (() => {
  const ranges: Array<[number, number]> = []
  for (let g = 0; g < VISUAL_BAND_COUNT; g++) {
    const from = Math.floor((g * BAND_COUNT) / VISUAL_BAND_COUNT)
    const to = Math.max(from + 1, Math.floor(((g + 1) * BAND_COUNT) / VISUAL_BAND_COUNT))
    ranges.push([from, to])
  }
  return ranges
})()

/**
 * Aggregate the engine's per-band energy into `VISUAL_BAND_COUNT` visual bands
 * (0..1, raw linear magnitude). Allocation-free: writes into `out`.
 */
export function readVisualBands(analysis: AudioAnalysis, out: number[]): number[] {
  for (let g = 0; g < VISUAL_BAND_COUNT; g++) {
    const [from, to] = VISUAL_BAND_RANGES[g]
    let sum = 0
    for (let i = from; i < to; i++) sum += analysis.bandDetails[i].energy
    out[g] = sum / (to - from)
  }
  return out
}

// Independent of React: the engine owns its own rAF loop and idle-skips.
startAnalysis()
