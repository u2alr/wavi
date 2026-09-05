import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * Self-contained playback time tracker.
 * Counts elapsed time internally instead of relying on Spotify SDK events.
 * Uses requestAnimationFrame so it auto-pauses when the tab is hidden and
 * stays synced with the render clock.
 * - Starts counting when `playing` becomes true
 * - Pauses when `playing` becomes false
 * - Resets when `trackId` changes
 * - `resync(ms)` jumps the clock (seek confirmations, SDK corrections,
 *   optimistic seeks) without changing play state.
 */
export function usePlaybackTracker(playing: boolean, trackId: string | null, durationMs: number) {
  const [currentTime, setCurrentTime] = useState(0) // ms

  const accumulatedRef = useRef(0)   // ms accumulated before current play session
  const startTimeRef = useRef(0)     // timestamp (ms) when current session started
  const lastTrackIdRef = useRef<string | null>(null)
  const rafRef = useRef<number>(0)
  const lastEmittedRef = useRef(0)   // last emitted currentTime value
  const durationRef = useRef(durationMs)
  useEffect(() => {
    durationRef.current = durationMs
  }, [durationMs])

  const clamp = useCallback((ms: number) => {
    const d = durationRef.current
    if (d > 0) return Math.max(0, Math.min(ms, d))
    return Math.max(0, ms)
  }, [])

  /** Jump the clock to `ms` (seek / SDK correction). Keeps play state. */
  const resync = useCallback((ms: number) => {
    const clamped = clamp(ms)
    accumulatedRef.current = clamped
    lastEmittedRef.current = clamped
    if (startTimeRef.current > 0) startTimeRef.current = Date.now()
    setCurrentTime(clamped)
  }, [clamp])

  // Reset on track change
  useEffect(() => {
    if (trackId !== lastTrackIdRef.current) {
      lastTrackIdRef.current = trackId
      accumulatedRef.current = 0
      startTimeRef.current = 0
      lastEmittedRef.current = 0
      setCurrentTime(0)
    }
  }, [trackId])

  // RAF-based tracking loop — auto-pauses when tab is hidden
  useEffect(() => {
    if (!playing || !trackId) {
      // Freeze accumulated time when paused
      if (startTimeRef.current > 0) {
        accumulatedRef.current = clamp(accumulatedRef.current + Date.now() - startTimeRef.current)
        startTimeRef.current = 0
      }
      cancelAnimationFrame(rafRef.current)
      return
    }

    startTimeRef.current = Date.now()

    const tick = () => {
      const elapsed = Date.now() - startTimeRef.current
      const next = clamp(accumulatedRef.current + elapsed)
      // Only update state when time has changed by >50ms to avoid excessive re-renders
      if (Math.abs(next - lastEmittedRef.current) >= 50) {
        lastEmittedRef.current = next
        setCurrentTime(next)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      // Freeze accumulated time on cleanup
      if (startTimeRef.current > 0) {
        accumulatedRef.current = clamp(accumulatedRef.current + Date.now() - startTimeRef.current)
        startTimeRef.current = 0
      }
    }
  }, [playing, trackId, clamp])

  const progress = durationMs > 0 ? Math.min(100, (currentTime / durationMs) * 100) : 0

  return { currentTime, progress, durationMs, resync }
}
