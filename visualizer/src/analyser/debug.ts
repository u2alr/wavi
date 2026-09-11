import { getAnalysis } from './engine'
import type { AudioAnalysis } from './types'

let debugEnabled = false

export function setAnalysisDebug(enabled: boolean): void {
  debugEnabled = enabled
}

export function isAnalysisDebug(): boolean {
  return debugEnabled
}

/**
 * Live analysis object for debug tooling, or null when debug is off. Returns
 * the mutable singleton so a debug view reads it every frame with zero
 * allocation.
 */
export function getAnalysisSnapshot(): AudioAnalysis | null {
  return debugEnabled ? getAnalysis() : null
}
