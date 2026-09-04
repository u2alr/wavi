import { useEffect, useState } from 'react'
import { useStore } from '../store'

export default function NowPlaying({ onPrev, onNext }: { onPrev: () => void; onNext: () => void }) {
  const trackName = useStore((s) => s.trackName)
  const currentTrackIndex = useStore((s) => s.currentTrackIndex)
  const playlist = useStore((s) => s.playlist)
  const spotifyPlaying = useStore((s) => s.spotifyPlaying)
  const spotifyIndex = useStore((s) => s.spotifyIndex)
  const spotifyTracks = useStore((s) => s.spotifyTracks)
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
  const playbackPosition = useStore((s) => s.playbackPosition)
  const isFullscreen = useStore((s) => s.isFullscreen)
  const [visible, setVisible] = useState(false)
  const [localProgress, setLocalProgress] = useState({ position: 0, duration: 0 })

  useEffect(() => {
    if (trackName) {
      setVisible(true)
    }
  }, [trackName, isFullscreen])

  useEffect(() => {
    if (isFullscreen && trackName) setVisible(true)
  }, [isFullscreen, trackName])

  useEffect(() => {
    const updateProgress = () => {
      const audio = document.querySelector('audio') as HTMLAudioElement | null
      setLocalProgress({ position: audio?.currentTime || 0, duration: audio?.duration || 0 })
    }
    updateProgress()
    const timer = window.setInterval(updateProgress, 250)
    return () => window.clearInterval(timer)
  }, [trackName])

  if (!trackName) return null

  const displayIndex = spotifyPlaying ? spotifyIndex : currentTrackIndex
  const displayTotal = spotifyPlaying ? spotifyTracks.length : playlist.length
  const currentTime = spotifyCurrentTrack ? playbackPosition / 1000 : localProgress.position
  const duration = spotifyCurrentTrack?.duration_ms ? spotifyCurrentTrack.duration_ms / 1000 : localProgress.duration
  const timeText = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`

  return (
    <div className={`now-playing ${visible ? 'visible' : ''}`}>
      <div>
        <div className="track-title">{trackName}</div>
        <div className="track-status">{timeText(currentTime)} / {timeText(duration)} · Track {Math.max(0, displayIndex + 1)} of {displayTotal}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ctrl-btn" onClick={onPrev} aria-label="Previous track">⏮</button>
        <button className="ctrl-btn" onClick={onNext} aria-label="Next track">⏭</button>
      </div>
    </div>
  )
}
