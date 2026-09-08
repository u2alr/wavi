import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { fetchLyrics, guessFromName, toTimedWords, type LyricLine } from '../lyrics'
import { usePlaybackTracker } from '../usePlaybackTracker'

/** Shared with the Now Playing bar — both clocks must agree on what "drifted" means. */
const LYRIC_SYNC_THRESHOLD_MS = 2000

// Isolated 20Hz progress bar — it owns the playback-tracker clock, so ticks
// re-render this memoized child only, never the lyric text tree. The parent
// reads the clock through a mutable ref for its RAF loop and sync snaps.
interface BratClock {
  current: number
  resync: (ms: number) => void
}

const BratProgress = memo(function BratProgress({
  playing,
  trackId,
  durationMs,
  whiteBg,
  clock,
}: {
  playing: boolean
  trackId: string | null
  durationMs: number
  whiteBg: boolean
  clock: BratClock
}) {
  const { currentTime, progress, resync } = usePlaybackTracker(playing, trackId, durationMs)
  useEffect(() => {
    clock.current = currentTime
  }, [clock, currentTime])
  useEffect(() => {
    clock.resync = resync
  }, [clock, resync])
  return (
    <div
      className="brat-progress"
      style={{
        width: `${progress}%`,
        background: whiteBg ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.5)',
      }}
    />
  )
})

export default function BratLyrics({
  active,
  variant,
}: {
  active: boolean
  variant: 'line' | 'karaoke'
}) {
  const [lines, setLines] = useState<LyricLine[]>([])
  // Packed sync key: lineIdx * 1000 + wordIdx (-1 = nothing). One state
  // update per line/word change instead of two, still guarded below.
  const [key, setKey] = useState(-1)
  const [lyricSynced, setLyricSynced] = useState(true)
  const trackName = useStore((s) => s.trackName)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const playing = useStore((s) => s.spotifyPlaying)
  const playbackPosition = useStore((s) => s.playbackPosition)
  const whiteBg = useStore((s) => s.bratWhiteBg)

  // Clock owned by the memoized progress child — parent never subscribes
  // to its ticks, so lyric text only re-renders on line/track changes.
  // The container object identity is stable for the component lifetime.
  const clock = useRef<BratClock>({ current: 0, resync: () => {} }).current

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

  // Song identity for transition resets — the fetch below resolves
  // asynchronously, so without a synchronous blank the old song's lines
  // stay mounted and the RAF loop matches the new song's position against
  // them (stale lyrics popping up over the next song).
  const songKey = trackId ?? `local:${trackName}`
  const lastSongKeyRef = useRef<string | null>(null)
  // Position the store held at the song change — it belongs to the OLD
  // song until the SDK emits a fresh one for the new song. While set, the
  // snap effects below must not touch the clock (otherwise a seek-then-skip
  // flashes the next song's lyrics at the old seek time, then snaps back).
  const stalePosRef = useRef<number | null>(null)

  // Fetch lyrics on track change — use AbortController to cancel stale requests
  useEffect(() => {
    const controller = new AbortController()
    // New song → blank immediately (no stale-line flash) and rewind the
    // shared clock, so the first RAF tick can't place the new song inside
    // the old lyrics' time range. Same-song refires skip this and keep
    // whatever is on screen.
    if (lastSongKeyRef.current !== songKey) {
      lastSongKeyRef.current = songKey
      setLines([])
      setKey(-1)
      clock.current = 0
      stalePosRef.current = useStore.getState().playbackPosition
    }

    const meta = trackId
      ? { title: trackTitle, artist: trackArtist, id: trackId }
      : guessFromName(trackName)

    if (!meta.title) {
      setLines([])
      setKey(-1)
      return () => controller.abort()
    }

    fetchLyrics(meta, controller.signal).then((res) => {
      if (controller.signal.aborted) return
      setLines(res ? res.lines : [])
      setLyricSynced(res ? res.synced : true)
      setKey(-1)
    }).catch(() => { /* aborted */ })

    return () => controller.abort()
  }, [trackId, trackName, trackTitle, trackArtist, songKey, clock])

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
    // The store position is the old song's until the SDK reports the new
    // song — snapping to it is what flashed next-song lyrics at the old
    // seek time. Wait for a position we haven't seen before.
    if (stalePosRef.current !== null) {
      if (playbackPosition === stalePosRef.current) return
      stalePosRef.current = null
    }
    const threshold = lyricSynced ? LYRIC_SYNC_THRESHOLD_MS : LYRIC_SYNC_THRESHOLD_MS * 3
    if (Math.abs(clock.current - playbackPosition) > threshold) {
      clock.resync(playbackPosition)
    }
  }, [playbackPosition, trackId, playing, lyricSynced])

  // Resume-edge snap: no SDK position arrives exactly at resume, so catch
  // the transition itself instead of waiting for the next event.
  const prevPlayingRef = useRef(playing)
  useEffect(() => {
    const resumed = playing && !prevPlayingRef.current
    prevPlayingRef.current = playing
    if (!resumed || !trackId) return
    const sdkPos = useStore.getState().playbackPosition
    // Same quarantine as the snap above — a resume coinciding with a track
    // change must not inject the old song's leftover position.
    if (stalePosRef.current !== null) {
      if (sdkPos === stalePosRef.current) return
      stalePosRef.current = null
    }
    const threshold = lyricSyncedRef.current ? LYRIC_SYNC_THRESHOLD_MS : LYRIC_SYNC_THRESHOLD_MS * 3
    if (Math.abs(clock.current - sdkPos) > threshold) {
      clock.resync(sdkPos)
    }
  }, [playing, trackId])

  // Word windows per line. With the updated lyrics module this is a
  // passthrough for `line.words` (real LRCLib/NetEase word timing) and
  // only interpolates for line-level sources. Memoized on fetch — never
  // recomputed per frame.
  const wordLines = useMemo(() => lines.map(toTimedWords), [lines])

  // Line sync loop — one persistent RAF while active (reads the clock
  // through a ref so tracker ticks don't tear the loop down 20x/sec).
  // Spotify uses the playback tracker clock (resets on track change, so a
  // naturally-ending song can't leave the previous song's lyrics on screen).
  // setKey is guarded: identical keys bail without scheduling a render.
  const keyRef = useRef(key)
  useEffect(() => {
    keyRef.current = key
  }, [key])

  useEffect(() => {
    if (!active) return

    let rafId = 0
    const tick = () => {
      const audio = getAudioElement()
      const pos = trackId ? clock.current / 1000 : (audio?.currentTime ?? 0)
      if (!(trackId ? !playing : audio?.paused)) {
        const lineIdx = lines.findIndex((l) => pos >= l.start && pos < l.end)
        let wordIdx = 0
        if (variant === 'karaoke' && lineIdx >= 0) {
          const words = wordLines[lineIdx]
          // Highlight by START times, not start/end containment: both the
          // interpolated timings (70ms inter-word gaps) and real word-level
          // sources (LRCLib/NetEase) have gaps between words, and during a
          // gap no word satisfies start<=pos<end — the old containment
          // check made the "now" highlight flicker off every gap.
          const started = words.reduce((n, w) => (pos >= w.start ? n + 1 : n), 0)
          wordIdx = started === 0 ? 0 : Math.min(started - 1, words.length - 1)
        }
        const next = lineIdx < 0 ? -1 : lineIdx * 1000 + wordIdx
        if (next !== keyRef.current) setKey(next)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [active, lines, wordLines, playing, trackId, variant])

  // Static typography — no audio reactivity. (Blur values preserve the
  // original resting look.)
  const lineIdx = key >= 0 ? Math.floor(key / 1000) : -1
  const wordIdx = key >= 0 ? key % 1000 : -1
  const current = lineIdx >= 0 ? lines[lineIdx] : null
  const currentWords = lineIdx >= 0 ? wordLines[lineIdx] : []
  const title = (track?.name || trackName || 'no track').toLowerCase()
  const artist = track?.artists?.[0]?.name?.toLowerCase() || ''
  const karaoke = variant === 'karaoke'

  return (
    <div className="brat-overlay" style={{ background: whiteBg ? '#ffffff' : '#8ACE00', display: active ? 'flex' : 'none' }}>
      <div className="brat-meta">{title}{artist && ` – ${artist}`}</div>
      <div key={lineIdx} className="brat-line">
        {current ? (
          karaoke ? (
            <span className="brat2-words">
              {currentWords.map((w, i) => (
                <Fragment key={i}>
                  <span className={`brat2-w${i < wordIdx ? ' sung' : ''}${i === wordIdx ? ' now' : ''}`}>
                    {w.text.toLowerCase()}
                  </span>
                  {i < currentWords.length - 1 ? ' ' : ''}
                </Fragment>
              ))}
            </span>
          ) : (
            current.text.toLowerCase()
          )
        ) : (
          '...'
        )}
      </div>
      {lines[lineIdx + 1] && <div key={lineIdx + 1} className="brat-next">{lines[lineIdx + 1].text.toLowerCase()}</div>}
      <BratProgress
        playing={playing}
        trackId={trackId}
        durationMs={track?.duration_ms ?? 0}
        whiteBg={whiteBg}
        clock={clock}
      />
    </div>
  )
}