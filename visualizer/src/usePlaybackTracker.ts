import { useState, useRef, useEffect } from 'react'

/**
 * Self-contained playback time tracker.
 * Counts elapsed time internally instead of relying on Spotify SDK events.
 * - Starts counting when `playing` becomes true
 * - Pauses when `playing` becomes false
 * - Resets when `trackId` changes
 */
export function usePlaybackTracker(playing: boolean, trackId: string | null, durationMs: number) {
  const [currentTime, setCurrentTime] = useState(0) // ms

  const accumulatedRef = useRef(0)   // ms accumulated before current play session
  const startTimeRef = useRef(0)     // timestamp (ms) when current session started
  const lastTrackIdRef = useRef<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Reset on track change
  useEffect(() => {
    if (trackId !== lastTrackIdRef.current) {
      lastTrackIdRef.current = trackId
      accumulatedRef.current = 0
      startTimeRef.current = 0
      setCurrentTime(0)
    }
  }, [trackId])

  // Start/stop tracking based on playing state
  useEffect(() => {
    if (playing && trackId) {
      startTimeRef.current = Date.now()
      intervalRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current
        setCurrentTime(accumulatedRef.current + elapsed)
      }, 100)
    } else {
      // Paused — freeze the accumulated time
      if (startTimeRef.current > 0) {
        accumulatedRef.current += Date.now() - startTimeRef.current
        startTimeRef.current = 0
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [playing, trackId])

  const progress = durationMs > 0 ? Math.min(100, (currentTime / durationMs) * 100) : 0

  return { currentTime, progress, durationMs }
}