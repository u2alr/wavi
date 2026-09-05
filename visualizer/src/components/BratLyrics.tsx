import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { fetchLyrics, guessFromName, type LyricLine } from '../lyrics'
import { usePlaybackTracker } from '../usePlaybackTracker'

/** Shared with the Now Playing bar — both clocks must agree on what "drifted" means. */
const LYRIC_SYNC_THRESHOLD_MS = 2000

export default function BratLyrics({ active }: { active: boolean }) {
  const [lines, setLines] = useState<LyricLine[]>([])
  const [idx, setIdx] = useState(-1)
  const [lyricSynced, setLyricSynced] = useState(true)
  const trackName = useStore((s) => s.trackName)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const playing = useStore((s) => s.spotifyPlaying)
  const playbackPosition = useStore((s) => s.playbackPosition)
  const whiteBg = useStore((s) => s.bratWhiteBg)

  // Self-contained playback tracker — counts time internally, independent of Spotify SDK.
  // Its currentTime is the Spotify clock (resets on track id change).
  const { currentTime, progress, resync } = usePlaybackTracker(
    playing,
    track?.id ?? null,
    track?.duration_ms ?? 0
  )

  // Mirror of the smooth clock for the sync checker (avoids re-subscribing every frame).
  const trackerTimeRef = useRef(currentTime)
  useEffect(() => {
    trackerTimeRef.current = currentTime
  })

  // Ref mirror so the resume-edge snap always sees the current flag.
  const lyricSyncedRef = useRef(lyricSynced)
  useEffect(() => {
    lyricSyncedRef.current = lyricSynced
  }, [lyricSynced])

  // Stable song identity — the store hands out a fresh track OBJECT on
  // every SDK event, so depending on `track` would refetch lyrics (and
  // blink `...`) without the song ever changing. Primitives only below.
  const trackId = track?.id ?? null
  const trackTitle = track?.name ?? ''
  const trackArtist = track?.artists?.[0]?.name

  // Fetch lyrics on track change — use AbortController to cancel stale requests
  useEffect(() => {
    const controller = new AbortController()
    const meta = trackId
      ? { title: trackTitle, artist: trackArtist, id: trackId }
      : guessFromName(trackName)

    if (!meta.title) {
      setLines([])
      setIdx(-1)
      return () => controller.abort()
    }

    fetchLyrics(meta, controller.signal).then((res) => {
      if (controller.signal.aborted) return
      setLines(res ? res.lines : [])
      setLyricSynced(res ? res.synced : true)
      setIdx(-1)
    }).catch(() => { /* aborted */ })

    return () => controller.abort()
  }, [trackId, trackName, trackTitle, trackArtist])

  // Sync snap (Spotify only — local files read audio.currentTime live
  // every frame, so seeks already follow). Snaps the private clock to the
  // SDK ground truth ONLY on fresh information: a changed playbackPosition
  // (seeks / track changes / SDK corrections) or a pause→play resume edge
  // (the SDK may have moved while time looked frozen). Never on a timer —
  // polling a frozen store value is what caused the backward sawtooth.
  // Fabricated timings (unsynced fallback sources) get a wider band.
  // Silent by design.
  useEffect(() => {
    if (!trackId || !playing) return
    const threshold = lyricSynced ? LYRIC_SYNC_THRESHOLD_MS : LYRIC_SYNC_THRESHOLD_MS * 3
    if (Math.abs(trackerTimeRef.current - playbackPosition) > threshold) {
      resync(playbackPosition)
    }
  }, [playbackPosition, trackId, playing, lyricSynced, resync])

  // Resume-edge snap: no SDK position arrives exactly at resume, so catch
  // the transition itself instead of waiting for the next event.
  const prevPlayingRef = useRef(playing)
  useEffect(() => {
    const resumed = playing && !prevPlayingRef.current
    prevPlayingRef.current = playing
    if (!resumed || !trackId) return
    const sdkPos = useStore.getState().playbackPosition
    const threshold = lyricSyncedRef.current ? LYRIC_SYNC_THRESHOLD_MS : LYRIC_SYNC_THRESHOLD_MS * 3
    if (Math.abs(trackerTimeRef.current - sdkPos) > threshold) {
      resync(sdkPos)
    }
  }, [playing, trackId, resync])

  // Line sync loop — one persistent RAF while active (reads the clock
  // through a ref so tracker ticks don't tear the loop down 20x/sec).
  // Spotify uses the playback tracker clock (resets on track change, so a
  // naturally-ending song can't leave the previous song's lyrics on screen).
  useEffect(() => {
    if (!active) return

    let rafId = 0
    const tick = () => {
      const audio = getAudioElement()
      const pos = trackId ? trackerTimeRef.current / 1000 : (audio?.currentTime ?? 0)
      if (!(trackId ? !playing : audio?.paused)) {
        setIdx(lines.findIndex((l) => pos >= l.start && pos < l.end))
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [active, lines, playing, trackId])

  // Static typography — no audio reactivity. (Blur values preserve the
  // original resting look.)
  const current = idx >= 0 ? lines[idx] : null
  const title = (track?.name || trackName || 'no track').toLowerCase()
  const artist = track?.artists?.[0]?.name?.toLowerCase() || ''

  return (
    <div style={{ position: 'absolute', inset: 0, background: whiteBg ? '#ffffff' : '#8ACE00', display: active ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', overflow: 'hidden', zIndex: 5 }}>
      <style>{`
        .brat-meta{position:absolute;top:26px;right:40px;font:600 14px Arial;color:#1c2400;text-transform:lowercase}
        .brat-line{max-width:35%;text-align:justify;text-align-last:justify;font:700 clamp(26px,6vw,64px)/1.15 Arial,Helvetica,sans-serif;color:#0d1200;text-transform:lowercase}
        .brat-next{margin-top:16px;font:400 14px Arial;color:rgba(13,18,0,.55);filter:blur(0.9px);text-transform:lowercase;max-width:70%;text-align:justify;text-align-last:justify}
        .brat-progress{position:absolute;bottom:0;left:0;height:5px;background:${whiteBg ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.5)'};transition:width 0.1s linear}
      `}</style>
      <div className="brat-meta" style={{ filter: 'blur(0.4px)' }}>{title}{artist && ` – ${artist}`}</div>
      <div
        className="brat-line"
        style={{ filter: 'blur(1.1px)' }}
      >
        {current ? current.text.toLowerCase() : '...'}
      </div>
      {lines[idx + 1] && <div className="brat-next">{lines[idx + 1].text.toLowerCase()}</div>}
      <div className="brat-progress" style={{ width: `${progress}%` }} />
    </div>
  )
}