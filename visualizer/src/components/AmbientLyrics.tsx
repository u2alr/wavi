import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { fetchLyrics, guessFromName, type LyricLine } from '../lyrics'
import { usePlaybackTracker } from '../usePlaybackTracker'

// Snap band vs SDK ground truth (ms) — matches brat's threshold.
const SEEK_SNAP_MS = 2000

/**
 * Apple Music-style lyrics for canvasAmbient2. Same fetch path as
 * BratLyrics; render-only difference: a vertical tumbler — previous
 * line above (exiting), current locked center, next below dimmed,
 * incoming rising from the bottom on each line change.
 *
 * Sync is derived during render from the playback tracker (20Hz), so
 * there is no RAF loop or ref-clock to stall — if dots persist, the
 * fetch returned nothing and the empty state says so.
 */
export default function AmbientLyrics({ active }: { active: boolean }) {
  const [lines, setLines] = useState<LyricLine[]>([])
  const [fetched, setFetched] = useState(false)
  const [lyricSynced, setLyricSynced] = useState(true)
  const trackName = useStore((s) => s.trackName)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const playing = useStore((s) => s.spotifyPlaying)
  const playbackPosition = useStore((s) => s.playbackPosition)

  // Primitives only — the store hands out a fresh track object per SDK
  // event, and depending on it would refetch lyrics every event.
  const trackId = track?.id ?? null
  const trackTitle = track?.name ?? ''
  const trackArtist = track?.artists?.[0]?.name

  // Tracker lives in this body (not a memo child) so its ticks always
  // re-render this tree — a 3-line tumbler at 20Hz is trivial.
  const { currentTime, resync } = usePlaybackTracker(playing, trackId, track?.duration_ms ?? 0)

  // Ref mirror of the ticking clock so the snap effects below compare
  // against fresh time without re-subscribing to every 50ms tick.
  const timeRef = useRef(0)
  useEffect(() => {
    timeRef.current = currentTime
  }, [currentTime])

  // Ref mirror so the resume-edge snap always sees the current flag.
  const lyricSyncedRef = useRef(lyricSynced)
  useEffect(() => {
    lyricSyncedRef.current = lyricSynced
  }, [lyricSynced])

  const songKey = trackId ?? `local:${trackName}`
  const lastSongKeyRef = useRef<string | null>(null)
  // Position the store held at the song change — it belongs to the OLD
  // song until the SDK emits a fresh one. While set, the snap effects
  // must not touch the clock.
  const stalePosRef = useRef<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    if (lastSongKeyRef.current !== songKey) {
      lastSongKeyRef.current = songKey
      setLines([])
      setFetched(false)
      resync(0)
      stalePosRef.current = useStore.getState().playbackPosition
    }

    const meta = trackId
      ? { title: trackTitle, artist: trackArtist, id: trackId }
      : guessFromName(trackName)

    if (!meta.title) {
      setLines([])
      setFetched(true)
      return () => controller.abort()
    }

    fetchLyrics(meta, controller.signal).then((res) => {
      if (controller.signal.aborted) return
      setLines(res ? res.lines : [])
      setLyricSynced(res ? res.synced : true)
      setFetched(true)
    }).catch(() => { /* aborted */ })

    return () => controller.abort()
  }, [trackId, trackName, trackTitle, trackArtist, songKey, resync])

  // Sync snap (Spotify only — local files read audio.currentTime live, so
  // seeks already follow). Snaps the tracker to SDK ground truth ONLY on
  // fresh information: a changed playbackPosition (seeks / track changes /
  // SDK corrections) or a pause→play resume edge (the SDK may have moved
  // while time looked frozen). Never on a timer. Fabricated timings
  // (unsynced fallback sources) get a wider band.
  useEffect(() => {
    if (!trackId || !playing) return
    if (stalePosRef.current !== null) {
      if (playbackPosition === stalePosRef.current) return
      stalePosRef.current = null
    }
    const threshold = lyricSynced ? SEEK_SNAP_MS : SEEK_SNAP_MS * 3
    if (Math.abs(timeRef.current - playbackPosition) > threshold) {
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
    if (stalePosRef.current !== null) {
      if (sdkPos === stalePosRef.current) return
      stalePosRef.current = null
    }
    const threshold = lyricSyncedRef.current ? SEEK_SNAP_MS : SEEK_SNAP_MS * 3
    if (Math.abs(timeRef.current - sdkPos) > threshold) {
      resync(sdkPos)
    }
  }, [playing, trackId, resync])

  const audio = active && !trackId ? getAudioElement() : null
  const pos = trackId ? currentTime / 1000 : (audio?.currentTime ?? 0)
  // Frozen on pause: the tracker stops ticking, so the index stays on
  // the current line instead of jumping to the first.
  const lineIdx = !active ? -1 : lines.findIndex((l) => pos >= l.start && pos < l.end)

  // Ticker: on a forward line step, swap to the new content immediately
  // but start the stack shifted DOWN one line, then glide to zero in a
  // single animation — no snap-back, so next→current travel is smooth.
  // No steady prev line: the outgoing line only lives transiently while
  // it fades upward (`leaving`), then unmounts.
  const SLIDE_MS = 600
  const tumblerRefs = useRef({ current: null as HTMLDivElement | null, next: null as HTMLDivElement | null })
  const [shownIdx, setShownIdx] = useState(lineIdx)
  const [glide, setGlide] = useState<{ px: number; go: boolean } | null>(null)
  const [leaving, setLeaving] = useState<LyricLine | null>(null)
  const glideTimer = useRef(0)
  const prevSongKeyRef = useRef(songKey)
  const reduceMotionRef = useRef(
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )

  const settleInstant = (idx: number) => {
    window.clearTimeout(glideTimer.current)
    setShownIdx(idx)
    setGlide(null)
    setLeaving(null)
  }

  useEffect(() => {
    if (lineIdx === shownIdx) return
    if (prevSongKeyRef.current !== songKey) {
      prevSongKeyRef.current = songKey
      settleInstant(lineIdx)
      return
    }
    if (reduceMotionRef.current || glide || lineIdx !== shownIdx + 1) {
      settleInstant(lineIdx)
      return
    }
    // DOM still shows the old content — measure with offsetTop so an
    // in-flight transform can't skew the distance.
    const cur = tumblerRefs.current.current
    const nxt = tumblerRefs.current.next
    let px = cur?.offsetHeight ?? 0
    if (cur && nxt) px = nxt.offsetTop - cur.offsetTop
    if (!(px > 0)) {
      settleInstant(lineIdx)
      return
    }
    setLeaving(shownIdx > 0 ? lines[shownIdx - 1] : null)
    setShownIdx(lineIdx)
    setGlide({ px, go: false })
    // Double rAF so the offset paints before the transition engages.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setGlide({ px, go: true }))
    })
    glideTimer.current = window.setTimeout(() => {
      setGlide(null)
      setLeaving(null)
    }, SLIDE_MS + 60)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [lineIdx, shownIdx, songKey, glide, lines])

  useEffect(() => () => window.clearTimeout(glideTimer.current), [])

  // Past the last line's end: stay blank. Without this, the index falls
  // back to -1 and `upcoming` re-shows the song from the start.
  // All render reads use `shownIdx` (the ticker may lag one step behind).
  const ended = shownIdx === -1 && lines.length > 0 && pos >= lines[lines.length - 1].end

  // One line back, four ahead. New arrivals fade in via .amb-line's
  // mount animation; the outgoing line floats off via .amb-leaving.
  const current = shownIdx >= 0 ? lines[shownIdx] : null
  const upcoming =
    ended ? [] : shownIdx >= 0 ? lines.slice(shownIdx + 1, shownIdx + 6) : lines.slice(0, 6)

  return (
    <div className="amb-lyrics" style={{ display: active ? 'flex' : 'none' }}>
      <div
        className={glide?.go ? 'amb-tumbler amb-slide' : 'amb-tumbler'}
        style={glide ? { transform: `translateY(${glide.go ? 0 : glide.px}px)` } : undefined}
      >
        <div className="amb-slot amb-top" />
        <div className="amb-current-wrap">
          {leaving && (
            <div key={leaving.start} className="amb-line amb-prev amb-leaving">{leaving.text}</div>
          )}
          <div
            key={shownIdx}
            ref={(el) => { tumblerRefs.current.current = el }}
            className="amb-line amb-current"
          >
          {current ? current.text : ended ? '' : !fetched ? '...' : lines.length === 0 ? 'no lyrics for this track' : '...'}
          </div>
        </div>
        <div className="amb-slot amb-bottom">
          {upcoming.map((l, i) => (
            <div
              key={l.start}
              ref={i === 0 ? (el) => { tumblerRefs.current.next = el } : undefined}
              className="amb-line amb-next"
            >{l.text}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
