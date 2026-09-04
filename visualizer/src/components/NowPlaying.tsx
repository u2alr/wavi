import { useEffect, useState, useRef, useCallback } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { pauseSpotify, resumeSpotify, seekSpotify } from '../spotifyPlayer'

export default function NowPlaying({
  onPrev,
  onNext,
}: {
  onPrev: () => void
  onNext: () => void
}) {
  const trackName = useStore((s) => s.trackName)
  const currentTrackIndex = useStore((s) => s.currentTrackIndex)
  const playlist = useStore((s) => s.playlist)
  const volume = useStore((s) => s.volume)
  const setVolume = useStore((s) => s.setVolume)
  const spotifyPlaying = useStore((s) => s.spotifyPlaying)
  const setSpotifyPlaying = useStore((s) => s.setSpotifyPlaying)
  const spotifyIndex = useStore((s) => s.spotifyIndex)
  const spotifyTracks = useStore((s) => s.spotifyTracks)
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
  const playbackPosition = useStore((s) => s.playbackPosition)

  const [isLocalPlaying, setIsLocalPlaying] = useState(false)
  const [localProgress, setLocalProgress] = useState({ position: 0, duration: 0 })
  const lastNonZeroVolume = useRef(volume > 0 ? volume : 1.0)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const visible = Boolean(trackName)

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

  // Seek on progress bar click
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return
    const rect = progressBarRef.current.getBoundingClientRect()
    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))

    if (spotifyCurrentTrack) {
      const targetMs = clickRatio * (spotifyCurrentTrack.duration_ms || 0)
      seekSpotify(targetMs).catch(console.error)
    } else {
      const audio = getAudioElement()
      if (audio && audio.duration) {
        audio.currentTime = clickRatio * audio.duration
      }
    }
  }

  if (!trackName) return null

  const isPlaying = spotifyCurrentTrack ? spotifyPlaying : isLocalPlaying
  const displayIndex = spotifyCurrentTrack ? spotifyIndex : currentTrackIndex
  const displayTotal = spotifyCurrentTrack ? spotifyTracks.length : playlist.length
  const currentTime = spotifyCurrentTrack ? playbackPosition / 1000 : localProgress.position
  const duration = spotifyCurrentTrack?.duration_ms ? spotifyCurrentTrack.duration_ms / 1000 : localProgress.duration
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  const timeText = (seconds: number) => {
    const valid = isFinite(seconds) && seconds >= 0 ? seconds : 0
    const m = Math.floor(valid / 60)
    const s = Math.floor(valid % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const albumImage = spotifyCurrentTrack?.album?.images?.[0]?.url
  const artistName = spotifyCurrentTrack?.artists?.map((a) => a.name).join(', ')

  return (
    <div
      className={`now-playing ${visible ? 'visible' : ''}`}
      role="region"
      aria-label="Now Playing Bar"
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
          <div className="track-title" title={trackName}>
            {trackName}
          </div>
          <div className="track-status">
            {artistName ? <span className="track-artist">{artistName} · </span> : null}
            <span className="track-time">
              {timeText(currentTime)} / {timeText(duration)}
            </span>
            {displayTotal > 0 && (
              <span className="track-counter"> · Track {Math.max(0, displayIndex + 1)} of {displayTotal}</span>
            )}
          </div>
        </div>
      </div>

      <div className="now-playing-controls">
        <button
          className="ctrl-btn"
          onClick={onPrev}
          title="Previous Track"
          aria-label="Previous Track"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
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
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <rect x="5" y="4" width="4" height="16" />
              <rect x="15" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
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
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
            <polygon points="5 4 15 12 5 20 5 4" />
            <rect x="16.5" y="4" width="2.5" height="16" />
          </svg>
        </button>

        <div className="ctrl-separator" />

        <div className="volume-control-group">
          <button
            className="ctrl-btn volume-btn"
            onClick={toggleMute}
            title={volume === 0 ? 'Unmute' : 'Mute'}
            aria-label="Toggle Mute"
          >
            {volume === 0 ? (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
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
