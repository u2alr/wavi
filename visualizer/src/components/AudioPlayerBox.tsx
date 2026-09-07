import { useEffect, useState, useRef, useCallback, memo, type CSSProperties } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { pauseSpotify, resumeSpotify, seekSpotify } from '../spotifyPlayer'
import { usePlaybackTracker } from '../usePlaybackTracker'

const RESYNC_THRESHOLD_MS = 2000

interface ArtGradient {
  g1: string
  g2: string
  g3: string
  edge: string
  glow: string
  ink: string
  dim: string
}

const artGradientCache = new Map<string, ArtGradient | null>()
const ART_GRADIENT_CACHE_MAX = 20

function rememberArtGradient(url: string, value: ArtGradient | null) {
  artGradientCache.set(url, value)
  while (artGradientCache.size > ART_GRADIENT_CACHE_MAX) {
    const oldest = artGradientCache.keys().next()
    if (oldest.done) break
    artGradientCache.delete(oldest.value)
  }
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
const toHex = (r: number, g: number, b: number) =>
  `#${((1 << 24) + (clampByte(r) << 16) + (clampByte(g) << 8) + clampByte(b)).toString(16).slice(1)}`
const scaleRgb = (rgb: [number, number, number], f: number): [number, number, number] => [
  rgb[0] * f,
  rgb[1] * f,
  rgb[2] * f,
]
// Dim + desaturate a sampled stop so cover gradients sit muted/flat
// instead of vivid/glassy: pull toward gray, then darken.
const dimRgb = (rgb: [number, number, number]): [number, number, number] => {
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const SAT_KEEP = 0.6
  const DARKEN = 0.76
  return [
    (rgb[0] + (avg - rgb[0]) * (1 - SAT_KEEP)) * DARKEN,
    (rgb[1] + (avg - rgb[1]) * (1 - SAT_KEEP)) * DARKEN,
    (rgb[2] + (avg - rgb[2]) * (1 - SAT_KEEP)) * DARKEN,
  ]
}
// Relative luminance of an sRGB triple (0-255) — drives the ink decision.
function luminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/**
 * Sample a fully opaque palette from a Spotify cover so the player box can
 * bleed the artwork edge-to-edge with zero translucency: dominant accent
 * (g1), runner-up hue (g2), darkness-weighted depth tone (g3), plus a
 * luminance-derived ink/dim pair that keeps text legible on any cover.
 * Grayscale covers resolve to a neutral light→dark ramp. Local files have
 * no cover (albumImage undefined) and CORS/taint failures fall back to
 * null → the opaque per-theme gray CSS fallback stays.
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
        const BUCKETS = 12
        const bucketR = new Float64Array(BUCKETS)
        const bucketG = new Float64Array(BUCKETS)
        const bucketB = new Float64Array(BUCKETS)
        const bucketW = new Float64Array(BUCKETS)
        let satSum = 0
        let satCount = 0
        const lum: number[] = []
        let darkR = 0
        let darkG = 0
        let darkB = 0
        let darkW = 0
        for (let y = 0; y < 48; y += 2) {
          for (let x = 0; x < 48; x += 2) {
            const i = (y * 48 + x) * 4
            const r = data[i] / 255
            const g = data[i + 1] / 255
            const b = data[i + 2] / 255
            const max = Math.max(r, g, b)
            const min = Math.min(r, g, b)
            const light = (max + min) / 2
            const sat = max === 0 ? 0 : (max - min) / max
            satSum += sat
            satCount += 1
            lum.push(light)
            // Darkness-weighted RGB average → tinted depth tone for g2.
            const dw = (1 - light) * (1 - light)
            darkR += data[i] * dw
            darkG += data[i + 1] * dw
            darkB += data[i + 2] * dw
            darkW += dw
            if (sat < 0.12) continue
            // Hue via the dominant channel sector (0-5 around the wheel).
            let hue: number
            if (max === r) hue = ((g - b) / (max - min || 1) + 6) % 6
            else if (max === g) hue = (b - r) / (max - min || 1) + 2
            else hue = (r - g) / (max - min || 1) + 4
            const bucket = Math.min(BUCKETS - 1, Math.floor((hue / 6) * BUCKETS))
            const weight = sat * (1 - Math.abs(light - 0.55))
            bucketR[bucket] += data[i] * weight
            bucketG[bucket] += data[i + 1] * weight
            bucketB[bucket] += data[i + 2] * weight
            bucketW[bucket] += weight
          }
        }
        // Opaque stops only — translucency is banned from this box.
        let accent: [number, number, number]
        let second: [number, number, number]
        let depth: [number, number, number]
        if (satSum / Math.max(1, satCount) < 0.08) {
          // Grayscale cover — luminance extremes give a neutral ramp.
          lum.sort((a, b) => a - b)
          const quint = Math.max(1, Math.floor(lum.length * 0.2))
          const darkAvg = lum.slice(0, quint).reduce((s, v) => s + v, 0) / quint
          const midAvg = lum.slice(Math.floor(lum.length * 0.4), Math.floor(lum.length * 0.6)).reduce((s, v) => s + v, 0) / Math.max(1, Math.floor(lum.length * 0.2))
          const lightAvg = lum.slice(-quint).reduce((s, v) => s + v, 0) / quint
          const lv = Math.round(lightAvg * 255)
          const mv = Math.round(midAvg * 255)
          const dv = Math.round(darkAvg * 255)
          accent = [lv, lv, lv]
          second = [mv, mv, mv]
          depth = [dv, dv, dv]
        } else {
          let best = 0
          for (let k = 1; k < BUCKETS; k++) {
            if (bucketW[k] > bucketW[best]) best = k
          }
          const w = Math.max(1e-6, bucketW[best])
          accent = [bucketR[best] / w, bucketG[best] / w, bucketB[best] / w]
          // Runner-up hue (distinct bucket, meaningful weight) or darkened accent.
          let runner = -1
          for (let k = 0; k < BUCKETS; k++) {
            if (k === best || bucketW[k] < bucketW[best] * 0.3) continue
            if (runner < 0 || bucketW[k] > bucketW[runner]) runner = k
          }
          second =
            runner >= 0
              ? [
                  bucketR[runner] / Math.max(1e-6, bucketW[runner]),
                  bucketG[runner] / Math.max(1e-6, bucketW[runner]),
                  bucketB[runner] / Math.max(1e-6, bucketW[runner]),
                ]
              : scaleRgb(accent, 0.7)
          const dw = Math.max(1e-6, darkW)
          depth = [darkR / dw, darkG / dw, darkB / dw]
        }
        const midLum = luminance(
          (accent[0] + second[0]) / 2,
          (accent[1] + second[1]) / 2,
          (accent[2] + second[2]) / 2,
        )
        const lightInk = midLum < 0.45
        const ink = lightInk ? '#f4f6f8' : '#17181c'
        const dim = lightInk ? 'rgba(244, 246, 248, 0.68)' : 'rgba(23, 24, 28, 0.66)'
        const edgeRgb = scaleRgb(dimRgb(accent), 0.62)
        const mutedAccent = dimRgb(accent)
        const mutedSecond = dimRgb(second)
        const mutedDepth = dimRgb(depth)
        const next: ArtGradient = {
          g1: toHex(mutedAccent[0], mutedAccent[1], mutedAccent[2]),
          g2: toHex(mutedSecond[0], mutedSecond[1], mutedSecond[2]),
          g3: toHex(mutedDepth[0], mutedDepth[1], mutedDepth[2]),
          edge: toHex(edgeRgb[0], edgeRgb[1], edgeRgb[2]),
          glow: `rgba(${clampByte(mutedAccent[0])}, ${clampByte(mutedAccent[1])}, ${clampByte(mutedAccent[2])}, 0.16)`,
          ink,
          dim,
        }
        rememberArtGradient(coverUrl, next)
        if (!dead) setGradient(next)
      } catch {
        rememberArtGradient(coverUrl, null)
        if (!dead) setGradient(null)
      }
    }
    img.onerror = () => {
      rememberArtGradient(coverUrl, null)
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
  }, [spotifyTimeMs])

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
              '--apb-g3': artGradient.g3,
              '--apb-edge': artGradient.edge,
              '--apb-glow': artGradient.glow,
              '--apb-ink': artGradient.ink,
              '--apb-dim': artGradient.dim,
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
