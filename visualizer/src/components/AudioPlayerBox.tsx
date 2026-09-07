import { useEffect, useState, useRef, useCallback, memo, type CSSProperties } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { pauseSpotify, resumeSpotify, seekSpotify } from '../spotifyPlayer'
import { usePlaybackTracker } from '../usePlaybackTracker'

const RESYNC_THRESHOLD_MS = 2000

interface ArtGradient {
  g1: string
  g2: string
}

const artGradientCache = new Map<string, ArtGradient | null>()

/**
 * Sample two soft tint stops from a Spotify cover so the player box gradient
 * follows the artwork. Local files have no cover (albumImage undefined) and
 * CORS/taint failures fall back to null → the static lime gradient stays.
 */
function useArtGradient(coverUrl: string | undefined): ArtGradient | null {
  const [gradient, setGradient] = useState<ArtGradient | null>(() =>
    coverUrl ? (artGradientCache.get(coverUrl) ?? null) : null,
  )

  useEffect(() => {
    if (!coverUrl) {
      setGradient(null)
      return
    }
    if (artGradientCache.has(coverUrl)) {
      setGradient(artGradientCache.get(coverUrl) ?? null)
      return
    }
    let dead = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 48
        canvas.height = 48
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(img, 0, 0, 48, 48)
        const data = ctx.getImageData(0, 0, 48, 48).data
        let r1 = 0, g1 = 0, b1 = 0, n1 = 0
        let r2 = 0, g2 = 0, b2 = 0, n2 = 0
        for (let y = 0; y < 48; y += 2) {
          for (let x = 0; x < 48; x += 2) {
            const i = (y * 48 + x) * 4
            if (y < 24) {
              r1 += data[i]; g1 += data[i + 1]; b1 += data[i + 2]; n1 += 1
            } else {
              r2 += data[i]; g2 += data[i + 1]; b2 += data[i + 2]; n2 += 1
            }
          }
        }
        // Low alphas keep dark text legible over any cover.
        const top = `rgba(${Math.round(r1 / n1)}, ${Math.round(g1 / n1)}, ${Math.round(b1 / n1)}, 0.3)`
        const bottom = `rgba(${Math.round(r2 / n2)}, ${Math.round(g2 / n2)}, ${Math.round(b2 / n2)}, 0.24)`
        const next = { g1: top, g2: bottom }
        artGradientCache.set(coverUrl, next)
        if (!dead) setGradient(next)
      } catch {
        artGradientCache.set(coverUrl, null)
        if (!dead) setGradient(null)
      }
    }
    img.onerror = () => {
      artGradientCache.set(coverUrl, null)
      if (!dead) setGradient(null)
    }
    img.src = coverUrl
    return () => {
      dead = true
    }
  }, [coverUrl])

  return gradient
}

const formatTime = (seconds: number) => {
  const valid = isFinite(seconds) && seconds >= 0 ? seconds : 0
  const m = Math.floor(valid / 60)
  const s = Math.floor(valid % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Slim seek bar — isolated so playback ticks never re-render the rest.
const BoxSeekBar = memo(function BoxSeekBar({
  currentTime,
  duration,
  displayRatio,
  onSeekRatio,
}: {
  currentTime: number
  duration: number
  displayRatio: number
  onSeekRatio: (ratio: number) => void
}) {
  const [isDragging, setIsDragging] = useState(false)

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!duration) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // Keep App-level shortcuts (preset cycling) from firing too.
      e.preventDefault()
      e.stopPropagation()
      const step = e.shiftKey ? 10 : 2
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const ratio = Math.max(0, Math.min(1, currentTime / duration + (dir * step) / duration))
      onSeekRatio(ratio)
    },
    [currentTime, duration, onSeekRatio],
  )

  return (
    <div
      className={`apb-track${isDragging ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
      title="Click or drag to seek"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        setIsDragging(true)
        const track = e.currentTarget
        const rect = track.getBoundingClientRect()
        const ratioAt = (x: number) => Math.max(0, Math.min(1, (x - rect.left) / rect.width))
        onSeekRatio(ratioAt(e.clientX))
        const onMove = (ev: PointerEvent) => onSeekRatio(ratioAt(ev.clientX))
        const onUp = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setIsDragging(false)
          onSeekRatio(ratioAt(ev.clientX))
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }}
      onKeyDown={onKeyDown}
    >
      <span className="apb-time">{formatTime(currentTime)}</span>
      <div className="apb-bar">
        <div className="apb-fill" style={{ width: `${displayRatio * 100}%` }} />
      </div>
      <span className="apb-time">{formatTime(duration)}</span>
    </div>
  )
})

export default function AudioPlayerBox({
  onPrev,
  onNext,
}: {
  onPrev: () => void
  onNext: () => void
}) {
  const trackName = useStore((s) => s.trackName)
  const volume = useStore((s) => s.volume)
  const setVolume = useStore((s) => s.setVolume)
  const spotifyPlaying = useStore((s) => s.spotifyPlaying)
  const setSpotifyPlaying = useStore((s) => s.setSpotifyPlaying)
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
  const playbackPosition = useStore((s) => s.playbackPosition)

  const [isLocalPlaying, setIsLocalPlaying] = useState(false)
  const [localProgress, setLocalProgress] = useState({ position: 0, duration: 0 })
  const [scrubRatio, setScrubRatio] = useState<number | null>(null)
  const lastNonZeroVolume = useRef(volume > 0 ? volume : 1.0)

  // Smooth Spotify clock — ticks every frame instead of only on SDK events.
  const spotifyDurationMs = spotifyCurrentTrack?.duration_ms ?? 0
  const { currentTime: spotifyTimeMs, resync: resyncSpotify } = usePlaybackTracker(
    spotifyPlaying,
    spotifyCurrentTrack?.id ?? null,
    spotifyDurationMs,
  )
  const spotifyTimeRef = useRef(spotifyTimeMs)
  useEffect(() => {
    spotifyTimeRef.current = spotifyTimeMs
  })

  // Re-anchor the smooth clock when the SDK reports a real position.
  useEffect(() => {
    if (!spotifyCurrentTrack) return
    if (Math.abs(spotifyTimeRef.current - playbackPosition) > RESYNC_THRESHOLD_MS) {
      resyncSpotify(playbackPosition)
    }
  }, [playbackPosition, spotifyCurrentTrack, resyncSpotify])

  // Track local audio state and progress.
  useEffect(() => {
    const audio = getAudioElement()
    if (!audio) return

    const updateProgress = () => {
      setLocalProgress({
        position: audio.currentTime || 0,
        duration: audio.duration || 0,
      })
      setIsLocalPlaying(!audio.paused)
    }

    updateProgress()
    const timer = window.setInterval(updateProgress, 200)
    audio.addEventListener('play', updateProgress)
    audio.addEventListener('pause', updateProgress)
    audio.addEventListener('ended', updateProgress)

    return () => {
      window.clearInterval(timer)
      audio.removeEventListener('play', updateProgress)
      audio.removeEventListener('pause', updateProgress)
      audio.removeEventListener('ended', updateProgress)
    }
  }, [trackName])

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

  const toggleMute = useCallback(() => {
    if (volume > 0) {
      lastNonZeroVolume.current = volume
      setVolume(0)
    } else {
      setVolume(lastNonZeroVolume.current || 1.0)
    }
  }, [volume, setVolume])

  // Optimistic seek — the bar follows the pointer immediately.
  const commitSeekRatio = useCallback(
    (ratio: number) => {
      const clamped = Math.max(0, Math.min(1, ratio))
      setScrubRatio(clamped)
      if (spotifyCurrentTrack?.duration_ms) {
        const targetMs = clamped * spotifyCurrentTrack.duration_ms
        resyncSpotify(targetMs)
        seekSpotify(targetMs).catch(() => setScrubRatio(null))
        window.setTimeout(() => setScrubRatio((r) => (r === clamped ? null : r)), 800)
      } else {
        const audio = getAudioElement()
        if (audio && audio.duration) {
          audio.currentTime = clamped * audio.duration
        }
        window.setTimeout(() => setScrubRatio((r) => (r === clamped ? null : r)), 300)
      }
    },
    [spotifyCurrentTrack, resyncSpotify],
  )

  const albumImage = spotifyCurrentTrack?.album?.images?.[0]?.url
  const artGradient = useArtGradient(albumImage)

  if (!trackName) return null

  const isPlaying = spotifyCurrentTrack ? spotifyPlaying : isLocalPlaying
  const currentTime = spotifyCurrentTrack ? spotifyTimeMs / 1000 : localProgress.position
  const duration = spotifyCurrentTrack?.duration_ms
    ? spotifyCurrentTrack.duration_ms / 1000
    : localProgress.duration
  const baseRatio = duration > 0 ? Math.min(1, currentTime / duration) : 0
  const displayRatio = scrubRatio ?? baseRatio

  const artistName = spotifyCurrentTrack?.artists?.map((a) => a.name).join(', ')

  return (
    <div
      className="audio-player-box"
      role="region"
      aria-label={trackName ? `Now Playing: ${trackName}` : 'Now Playing'}
      style={
        artGradient
          ? ({
              '--apb-g1': artGradient.g1,
              '--apb-g2': artGradient.g2,
            } as CSSProperties)
          : undefined
      }
    >
      <div className="apb-row">
        <div className="apb-art" aria-hidden="true">
          {albumImage ? (
            <img src={albumImage} alt="" className="apb-art-img" />
          ) : (
            <span className="apb-art-fallback">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            </span>
          )}
        </div>

        <div className="apb-meta">
          <div className="apb-title" title={trackName}>
            {trackName}
          </div>
          {artistName && (
            <div className="apb-artist" title={artistName}>
              {artistName}
            </div>
          )}
        </div>

        <div className={`apb-eq${isPlaying ? '' : ' paused'}`} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>

      <BoxSeekBar
        currentTime={currentTime}
        duration={duration}
        displayRatio={displayRatio}
        onSeekRatio={commitSeekRatio}
      />

      <div className="apb-controls">
        <div className="apb-transport">
          <button className="xp-btn" onClick={onPrev} title="Previous Track" aria-label="Previous Track">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
              <polygon points="19 20 9 12 19 4 19 20" />
              <rect x="5" y="4" width="2.5" height="16" />
            </svg>
          </button>
          <button
            className="xp-btn primary"
            onClick={togglePlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                <rect x="5" y="4" width="4" height="16" />
                <rect x="15" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            )}
          </button>
          <button className="xp-btn" onClick={onNext} title="Next Track" aria-label="Next Track">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
              <polygon points="5 4 15 12 5 20 5 4" />
              <rect x="16.5" y="4" width="2.5" height="16" />
            </svg>
          </button>
        </div>

        <div className="apb-volume">
          <button
            className="apb-mute-btn"
            onClick={toggleMute}
            title={volume === 0 ? 'Unmute' : 'Mute'}
            aria-label="Toggle Mute"
          >
            {volume === 0 ? (
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            style={{ ['--p' as string]: `${Math.round(volume * 100)}%` }}
            onChange={(e) => setVolume(+e.target.value)}
            className="apb-volume-slider"
            title={`Volume: ${Math.round(volume * 100)}%`}
            aria-label="Volume Slider"
          />
          <span className="apb-vol-val">{Math.round(volume * 100)}%</span>
        </div>
      </div>
    </div>
  )
}
