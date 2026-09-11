import { getAnalysis, startAnalysis, stopAnalysis } from './engine'
import { getBandTexture, getFftTexture, getFeatureTexture } from './textures'
import { getAnalysisSnapshot, isAnalysisDebug, setAnalysisDebug } from './debug'
import { getStemProvider, setStemProvider } from './stems'
import type { StemProvider } from './types'

export type {
  AudioAnalysis,
  AudioEvent,
  AudioEventType,
  BandData,
  SectionState,
  StemProvider,
} from './types'

export { getAnalysis, startAnalysis, stopAnalysis }
export { getFftTexture, getBandTexture, getFeatureTexture }
export { getAnalysisSnapshot, isAnalysisDebug, setAnalysisDebug }
export { getStemProvider }

/**
 * Register a source-separation backend (e.g. Demucs/MDX). When set, vocal and
 * percussive estimators use the supplied stem energies instead of heuristics.
 * Presets never need to change.
 */
export function configureAnalysis(opts: { stemProvider?: StemProvider | null }): void {
  if ('stemProvider' in opts) setStemProvider(opts.stemProvider ?? null)
}

// Independent of React: the engine owns its own rAF loop and idle-skips.
startAnalysis()
