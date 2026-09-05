import { useEffect, useState, useRef, useCallback } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { pauseSpotify, resumeSpotify, seekSpotify } from '../spotifyPlayer'
import { usePlaybackTracker } from '../usePlaybackTracker'

const AUTOHIDE_DELAY_MS = 3000
/** Ignore SDK corrections smaller than this — avoids fighting the RAF clock. */
const RESYNC_THRESHOLD_MS = 2000

const formatTime = (seconds: number) => {
  const valid = isFinite(seconds) && seconds >= 0 ? seconds : 0
  const m = Math.floor(valid / 60)
  const s = Math.floor(valid % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function NowPlaying({
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
  const [autoHidden, setAutoHidden] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const lastNonZeroVolume = useRef(volume > 0 ? volume : 1.0)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef(0)
  const visible = Boolean(trackName)

  // Smooth Spotify clock — ticks every frame instead of only on SDK events.
  const spotifyDurationMs = spotifyCurrentTrack?.duration_ms ?? 0
  const { currentTime: spotifyTimeMs, resync: resyncSpotify } = usePlaybackTracker(
    spotifyPlaying,
    spotifyCurrentTrack?.id ?? null,
    spotifyDurationMs
  )
  // Latest tracker value for the SDK-correction effect (avoids re-subscribing every frame).
  // NOTE: only resync when playbackPosition *changes* (fresh SDK info). The
  // SDK value goes stale between events, so comparing on every tick would
  // snap the smooth clock back and freeze the bar again.
  const spotifyTimeRef = useRef(spotifyTimeMs)
  useEffect(() => {
    spotifyTimeRef.current = spotifyTimeMs
  })

  // Re-anchor the smooth clock when the SDK reports a real position
  // (track change, seek confirmation, play/pause) that drifted away.
  useEffect(() => {
    if (!spotifyCurrentTrack) return
    if (Math.abs(spotifyTimeRef.current - playbackPosition) > RESYNC_THRESHOLD_MS) {
      resyncSpotify(playbackPosition)
    }
  }, [playbackPosition, spotifyCurrentTrack, resyncSpotify])

  // Track local audio state and progress — only start interval when audio exists
  useEffect(() => {
    const audio = getAudioElement()
    if (!audio) return  // no local file loaded; nothing to poll

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

  // Mute / Unmute toggle
  const toggleMute = useCallback(() => {
    if (volume > 0) {
      lastNonZeroVolume.current = volume
      setVolume(0)
    } else {
      setVolume(lastNonZeroVolume.current || 1.0)
    }
  }, [volume, setVolume])

  // Toggle Play / Pause
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

  // Seek on progress bar click — optimistically move the bar immediately
  // instead of waiting for the next SDK event.
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return
    const rect = progressBarRef.current.getBoundingClientRect()
    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))

    if (spotifyCurrentTrack) {
      const targetMs = clickRatio * (spotifyCurrentTrack.duration_ms || 0)
      resyncSpotify(targetMs)
      seekSpotify(targetMs).catch(console.error)
    } else {
      const audio = getAudioElement()
      if (audio && audio.duration) {
        audio.currentTime = clickRatio * audio.duration
      }
    }
  }

  // Mirrors isHovering for the async hide timer (updated in event handlers).
  const isHoveringRef = useRef(isHovering)

  // Auto-hide after 3s idle (windowed + fullscreen); any activity reshows.
  const poke = useCallback(() => {
    setAutoHidden(false)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      // Never fade while the cursor is on the bar (mid seek/volume click).
      if (!isHoveringRef.current) setAutoHidden(true)
    }, AUTOHIDE_DELAY_MS)
  }, [])

  // Show briefly on track change so the new title is seen even when idle.
  const activeTrackId = spotifyCurrentTrack?.id ?? trackName
  useEffect(() => {
    if (activeTrackId) poke()
  }, [activeTrackId, poke])

  useEffect(() => {
    poke()
    const onActivity = () => poke()
    window.addEventListener('mousemove', onActivity)
    window.addEventListener('mousedown', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('touchstart', onActivity)
    window.addEventListener('wheel', onActivity)
    return () => {
      window.clearTimeout(hideTimer.current)
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('mousedown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('touchstart', onActivity)
      window.removeEventListener('wheel', onActivity)
    }
  }, [poke])

  if (!trackName) return null

  const isPlaying = spotifyCurrentTrack ? spotifyPlaying : isLocalPlaying
  const currentTime = spotifyCurrentTrack ? spotifyTimeMs / 1000 : localProgress.position
  const duration = spotifyCurrentTrack?.duration_ms ? spotifyCurrentTrack.duration_ms / 1000 : localProgress.duration
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const hidden = autoHidden && !isHovering

  const albumImage = spotifyCurrentTrack?.album?.images?.[0]?.url
  const artistName = spotifyCurrentTrack?.artists?.map((a) => a.name).join(', ')
  const timeLabel = spotifyCurrentTrack
    ? `${formatTime(currentTime)} / ${formatTime(duration)}`
    : localProgress.duration > 0
      ? `${formatTime(currentTime)} / ${formatTime(duration)}`
      : null

  return (
    <div
      className={`now-playing ${visible ? 'visible' : ''}${hidden ? ' auto-hidden' : ''}`}
      role="region"
      aria-label={trackName ? `Now Playing: ${trackName}` : 'Now Playing Bar'}
      onMouseEnter={() => {
        setIsHovering(true)
        isHoveringRef.current = true
        window.clearTimeout(hideTimer.current)
        setAutoHidden(false)
      }}
      onMouseLeave={() => {
        setIsHovering(false)
        isHoveringRef.current = false
        poke()
      }}
      onFocus={() => {
        window.clearTimeout(hideTimer.current)
        setAutoHidden(false)
      }}
      onBlur={() => poke()}
    >
      <div className="now-playing-left">
        {/* Album art or vinyl record icon */}
        <div className={`now-playing-artwork ${isPlaying ? 'spinning' : ''}`}>
          {albumImage ? (
            <img src={albumImage} alt="Album Cover" className="album-img" />
          ) : (
            <div className="vinyl-icon">
              <div className="vinyl-center" />
            </div>
          )}
        </div>

        <div className="now-playing-meta">
          <div className="np-title" title={trackName}>
            {trackName}
          </div>
          <div className="np-sub" title={artistName ? `${artistName}${timeLabel ? ` · ${timeLabel}` : ''}` : (timeLabel ?? '')}>
            {artistName ? <span>{artistName} · </span> : null}
            {timeLabel ? <span>{timeLabel}</span> : null}
          </div>
        </div>

        <div className="now-playing-controls">
          <button
            className="ctrl-btn"
            onClick={onPrev}
            title="Previous Track"
            aria-label="Previous Track"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <polygon points="19 20 9 12 19 4 19 20" />
              <rect x="5" y="4" width="2.5" height="16" />
            </svg>
          </button>
          <button
            className="ctrl-btn ctrl-btn-play"
            onClick={togglePlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <rect x="5" y="4" width="4" height="16" />
                <rect x="15" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            )}
          </button>
          <button
            className="ctrl-btn"
            onClick={onNext}
            title="Next Track"
            aria-label="Next Track"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <polygon points="5 4 15 12 5 20 5 4" />
              <rect x="16.5" y="4" width="2.5" height="16" />
            </svg>
          </button>

          <div className="volume-control-group">
            <button
              className="ctrl-btn volume-btn"
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
              onChange={(e) => setVolume(+e.target.value)}
              className="volume-slider"
              title={`Volume: ${Math.round(volume * 100)}%`}
              aria-label="Volume Slider"
            />
          </div>
        </div>
      </div>

      {/* Interactive Seek Bar */}
      <div
        ref={progressBarRef}
        className="now-playing-progress"
        onClick={handleSeek}
        title="Click to seek"
      >
        <div
          className="now-playing-progress-bar"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </div>
  )
}
