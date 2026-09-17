import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { getExtensionWaveData } from '../../audio'
import { getEmberWaveAnalyser, teardownEmberWaveAnalyser } from '../../emberAnalyser'

// Waveform width for the time-domain presets. Must match the extension's
// time-domain tap and emberAnalyser.ts' FFT_SIZE (both 2048).
export const WAVE_SIZE = 2048

/**
 * Shared waveform source for the time-domain presets (Fractal Ember, AM Preset).
 * Owns the 2048-sample buffer + DataTexture, refills it each frame from the
 * extension tab-capture (when live) or the dedicated local AnalyserNode tap,
 * and releases the tap + texture on unmount.
 * `alpha` is the temporal-smoothing factor: 1 = replace (raw trace),
 * <1 = exponential blend toward the newest samples (calmer, flowing wave).
 */
export function useWaveTrace() {
  const tex = useMemo(() => {
    const data = new Uint8Array(WAVE_SIZE).fill(128) // 128 = silence
    const t = new THREE.DataTexture(data, WAVE_SIZE, 1, THREE.RedFormat, THREE.UnsignedByteType)
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearFilter
    t.needsUpdate = true
    return t
  }, [])
  const buf = useMemo(() => tex.image.data as Uint8Array, [tex])
  const scratch = useRef(new Uint8Array(WAVE_SIZE))

  useEffect(() => () => {
    teardownEmberWaveAnalyser()
    tex.dispose()
  }, [tex])

  const refresh = useCallback((alpha: number) => {
    const raw = scratch.current
    // Extension tab-capture wins (same precedence as audio.ts): it reflects
    // the actual audible source (Spotify SDK or captured tab audio) even when
    // a stale local AnalyserNode from an earlier file session is still wired
    // into the graph (that tap reads silence once the local file is paused).
    const ext = getExtensionWaveData()
    if (ext) {
      raw.set(ext.subarray(0, WAVE_SIZE))
    } else {
      const waveAnalyser = getEmberWaveAnalyser()
      if (waveAnalyser) waveAnalyser.getByteTimeDomainData(raw)
      else raw.fill(128) // no audio source yet — hold a flat silence line
    }
    if (alpha >= 1) {
      buf.set(raw)
    } else {
      for (let i = 0; i < WAVE_SIZE; i++) buf[i] = buf[i] + (raw[i] - buf[i]) * alpha
    }
    tex.needsUpdate = true
  }, [buf, tex])

  return { tex, refresh }
}
