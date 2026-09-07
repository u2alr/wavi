import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'
import { getAudioElement, getFreqData } from '../audio'
import { pauseSpotify, resumeSpotify } from '../spotifyPlayer'

const DOT_COUNT = 6
// Peak visual scale for the tall ovals — the "max height" cap. Transform
// scale never affects layout, so this plus the 18px row and pill
// overflow:hidden is the full bound.
const DOT_MAX = 1.45
// Bin ranges into the 256-bin analyser spectrum (fftSize 512), low → high.
const DOT_BANDS: Array<[number, number]> = [
  [1, 3],
  [4, 7],
  [8, 13],
  [14, 22],
  [23, 40],
  [41, 70],
]

export default function FullscreenPill({
  onPrev,
  onNext,
}: {
  onPrev: () => void
  onNext: () => void
}) {
  const trackName = useStore((s) => s.trackName)
  const spotifyPlaying = useStore((s) => s.spotifyPlaying)
  const setSpotifyPlaying = useStore((s) => s.setSpotifyPlaying)
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
  const extensionStatus = useStore((s) => s.extensionStatus)

  const [isLocalPlaying, setIsLocalPlaying] = useState(false)
  const barRefs = useRef<Array<HTMLSpanElement | null>>([])
  const rafRef = useRef(0)
  const smoothRef = useRef<number[]>(Array(DOT_COUNT).fill(0.35))

  const togglePlayPause = useCallback(async () => {
    if (spotifyCurrentTrack) {
      try {
        if (spotifyPlaying) {
          await pauseSpotify()
          setSpotifyPlaying(false)
        } else {
          await resumeSpotify()
          setSpotifyPlaying(true)
        }
      } catch (err) {
        console.error('Spotify toggle failed:', err)
      }
    } else {
      const audio = getAudioElement()
      if (!audio) return
      if (audio.paused) {
        audio.play().catch(console.error)
        setIsLocalPlaying(true)
      } else {
        audio.pause()
        setIsLocalPlaying(false)
      }
    }
  }, [spotifyCurrentTrack, spotifyPlaying, setSpotifyPlaying])

  const extLive = extensionStatus === 'EXT LIVE'
  const isPlaying = spotifyCurrentTrack ? spotifyPlaying || extLive : isLocalPlaying || extLive
  // Real FFT bins exist for local files and extension capture. Extension wins
  // over the Spotify CSS fallback because the bins are the actual tab audio
  // Scene.tsx is already visualising via the same getFreqData() path.
  const isReactive = !spotifyCurrentTrack || extLive
  const driveReactive = (isPlaying && isReactive) || extLive
  const hasTransport = Boolean(trackName)

  // Track local play state so the eq animation follows pause/play.
  useEffect(() => {
    if (spotifyCurrentTrack) return
    const sync = () => {
      const el = getAudioElement()
      if (el) setIsLocalPlaying(!el.paused)
    }
    sync()
    const el = getAudioElement()
    const id = window.setInterval(sync, 200)
    el?.addEventListener('play', sync)
    el?.addEventListener('pause', sync)
    el?.addEventListener('ended', sync)
    return () => {
      window.clearInterval(id)
      el?.removeEventListener('play', sync)
      el?.removeEventListener('pause', sync)
      el?.removeEventListener('ended', sync)
    }
  }, [spotifyCurrentTrack, trackName])

  // True audio-reactive dots for local / extension audio (same getFreqData()
  // bins Scene.tsx visualises). Spotify SDK audio is encrypted
  // (no analyser data) → CSS pulse fallback unless the extension is live.
  useEffect(() => {
    if (!driveReactive) return
    const tick = () => {
      const data = getFreqData()
      for (let i = 0; i < DOT_COUNT; i++) {
        const [from, to] = DOT_BANDS[i]
        let sum = 0
        for (let b = from; b <= to && b < data.length; b++) sum += data[b]
        const target = Math.max(0, Math.min(1, sum / ((to - from + 1) * 255)))
        const prev = smoothRef.current[i]
        const next = prev + (target - prev) * 0.35
        smoothRef.current[i] = next
        const el = barRefs.current[i]
        if (el) {
          // Height dances wide, width breathes slightly — stays oval.
          const sy = Math.min(0.55 + next * 0.9, DOT_MAX)
          const sx = 0.85 + next * 0.35
          el.style.transform = `scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`
          el.style.opacity = (0.35 + next * 0.65).toFixed(3)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [driveReactive])

  // Release dots to CSS when nothing drives them: flowy idle owns them,
  // never a frozen dim state.
  useEffect(() => {
    if (driveReactive) return
    smoothRef.current = Array(DOT_COUNT).fill(0.35)
    barRefs.current.forEach((el) => {
      if (el) {
        el.style.transform = ''
        el.style.opacity = ''
      }
    })
  }, [driveReactive])

  const displayName = trackName || (extLive ? 'Browser audio' : 'Ready')
  const albumImage = spotifyCurrentTrack?.album?.images?.[0]?.url

  return (
    <div
      className={`fs-pill ${driveReactive ? 'playing' : 'paused'}`}
      role="region"
      aria-label={`Now Playing: ${displayName}`}
      title={displayName}
      data-mode={isReactive ? 'reactive' : 'css'}
      data-state={driveReactive ? 'live' : 'idle'}
    >
      <div className="fs-pill-art" aria-hidden="true">
        {albumImage ? (
          <img src={albumImage} alt="" />
        ) : (
          <span className="fs-pill-fallback">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          </span>
        )}
      </div>

      <div className="fs-pill-eq" aria-hidden="true">
        {Array.from({ length: DOT_COUNT }).map((_, i) => (
          <span
            key={i}
            ref={(el) => {
              barRefs.current[i] = el
            }}
          />
        ))}
      </div>

      {hasTransport && (
      <div
        className="fs-pill-transport"
      >
        <div className="fs-pill-transport-inner">
        <button type="button" onClick={onPrev} title="Previous Track" aria-label="Previous Track">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <polygon points="19 20 9 12 19 4 19 20" />
            <rect x="5" y="4" width="2.5" height="16" />
          </svg>
        </button>
        <button
          type="button"
          onClick={togglePlayPause}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <rect x="5" y="4" width="4" height="16" />
              <rect x="15" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          )}
        </button>
        <button type="button" onClick={onNext} title="Next Track" aria-label="Next Track">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <polygon points="5 4 15 12 5 20 5 4" />
            <rect x="16.5" y="4" width="2.5" height="16" />
          </svg>
        </button>
        </div>
      </div>
      )}
    </div>
  )
}
