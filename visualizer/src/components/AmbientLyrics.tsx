import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { cachedLyrics, fetchLyrics, guessFromName, type LyricLine } from '../lyrics'
import { usePlaybackTracker } from '../usePlaybackTracker'

const SEEK_SNAP_MS = 2000
// A line lights up this long BEFORE its timestamp, so the words are already
// on screen and legible when the vocal actually lands.
const LINE_LEAD_SECONDS = 0.5

const PREVIOUS_LINES = 1
const NEXT_LINES = 4

/*
 * Distance between the visually rendered edges of two lyrics.
 * Increase this if you want more separation.
 */
const LINE_GAP = 22

// Approximate fallback used before the first measurement exists.
const BASE_LINE_HEIGHT = 58

// Current lyric sits roughly two normal lines above center.
const CURRENT_RAISE = -150

export default function AmbientLyrics({
  active,
}: {
  active: boolean
}) {
  const [lines, setLines] = useState<LyricLine[]>([])
  const [fetched, setFetched] = useState(false)
  const [lyricSynced, setLyricSynced] = useState(true)
  const [localTime, setLocalTime] = useState(0)

  /*
   * Measured unscaled layout height of every visible lyric.
   *
   * offsetHeight intentionally ignores transforms. We multiply it by the
   * target scale when calculating positions so LINE_GAP is measured between
   * the visually rendered edges, not merely between layout boxes.
   */
  const [heights, setHeights] = useState(
    new Map<number, number>(),
  )

  const trackName = useStore((s) => s.trackName)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const playing = useStore((s) => s.spotifyPlaying)
  const playbackPosition = useStore((s) => s.playbackPosition)

  const trackId = track?.id ?? null
  const trackTitle = track?.name ?? ''
  const trackArtist = track?.artists?.[0]?.name
  const trackAlbum = track?.album?.name
  const trackDurationMs = track?.duration_ms ?? 0
  const trackIsrc = track?.external_ids?.isrc

  const { currentTime, resync } = usePlaybackTracker(
    playing,
    trackId,
    track?.duration_ms ?? 0,
  )

  const reduceMotion = useReducedMotion()

  const previousPlayingRef = useRef(playing)
  const timeRef = useRef(0)
  const lyricSyncedRef = useRef(lyricSynced)

  const lastSongKeyRef = useRef<string | null>(null)
  const stalePositionRef = useRef<number | null>(null)

  const nodeRefs = useRef(
    new Map<number, HTMLDivElement>(),
  )

  const previousActiveIndexRef = useRef(-1)

  useEffect(() => {
    timeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    lyricSyncedRef.current = lyricSynced
  }, [lyricSynced])

  /*
   * Local audio fallback.
   */
  useEffect(() => {
    if (!active || trackId) return

    const audio = getAudioElement()

    const sync = () => {
      setLocalTime(audio?.currentTime ?? 0)
    }

    sync()

    const timer = window.setInterval(sync, 50)

    audio?.addEventListener('timeupdate', sync)
    audio?.addEventListener('play', sync)
    audio?.addEventListener('pause', sync)
    audio?.addEventListener('ended', sync)

    return () => {
      window.clearInterval(timer)

      audio?.removeEventListener('timeupdate', sync)
      audio?.removeEventListener('play', sync)
      audio?.removeEventListener('pause', sync)
      audio?.removeEventListener('ended', sync)
    }
  }, [active, trackId])

  /*
   * Fetch lyrics whenever the song changes.
   */
  const songKey = trackId ?? `local:${trackName}`

  useEffect(() => {
    const controller = new AbortController()

    // Length + ISRC are what make the lookup pick THIS recording: LRCLib
    // matches on duration, and the ISRC pinpoints the exact release.
    const meta = trackId
      ? {
          title: trackTitle,
          artist: trackArtist,
          album: trackAlbum,
          duration: trackDurationMs > 0 ? trackDurationMs / 1000 : undefined,
          id: trackId,
          isrc: trackIsrc,
        }
      : guessFromName(trackName)

    const changed =
      lastSongKeyRef.current !== songKey

    /*
     * Already looked up (prefetched ahead of the queue, or played before):
     * the lyrics are on screen from the first frame, so nothing about the
     * song's start reads as "loading".
     */
    const warm = changed ? cachedLyrics(meta) : null

    if (changed) {
      lastSongKeyRef.current = songKey

      setLines(warm ? warm.lines : [])
      setLyricSynced(warm ? warm.synced : true)
      setFetched(Boolean(warm))
      setHeights(new Map())

      previousActiveIndexRef.current = -1

      resync(0)

      stalePositionRef.current =
        useStore.getState().playbackPosition
    }

    if (!meta.title) {
      setLines([])
      setFetched(true)

      return () => controller.abort()
    }

    // Cache hit handled above — keep what's already on screen.
    if (warm) return () => controller.abort()

    fetchLyrics(meta, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return

        setLines(result ? result.lines : [])
        setLyricSynced(result ? result.synced : true)
        setFetched(true)
      })
      .catch(() => {
        if (controller.signal.aborted) return

        setLines([])
        setFetched(true)
      })

    return () => controller.abort()
  }, [
    trackId,
    trackName,
    trackTitle,
    trackArtist,
    trackAlbum,
    trackDurationMs,
    trackIsrc,
    songKey,
    resync,
  ])

  /*
   * Warm lyrics AHEAD of playback: this position and the next two tracks are
   * looked up while nothing is waiting on them, so starting, skipping or
   * auto-advancing into a song never sits through a network round-trip. The
   * cache hit is synchronous, which is what lets the fetch effect above open
   * straight on lyrics. Fire-and-forget: it only writes the lyrics cache, so
   * an unmount or a skipped track costs nothing. Also runs right after a
   * playlist loads (index 0, nothing playing yet), so the first press of play
   * is warm too. Skipped while the index is unknown (-1 = the track advanced
   * outside the loaded list).
   */
  const spotifyTracks = useStore((s) => s.spotifyTracks)
  const spotifyIndex = useStore((s) => s.spotifyIndex)
  const prefetchedIdsRef = useRef(new Set<string>())

  useEffect(() => {
    if (!active || spotifyIndex < 0 || !spotifyTracks.length) return

    for (const offset of [0, 1, 2]) {
      const next =
        spotifyTracks[(spotifyIndex + offset) % spotifyTracks.length]

      // The playing track is already being fetched by the effect above.
      if (!next || next.id === trackId) continue
      if (prefetchedIdsRef.current.has(next.id)) continue

      prefetchedIdsRef.current.add(next.id)

      fetchLyrics({
        title: next.name,
        artist: next.artists?.[0]?.name,
        album: next.album?.name,
        duration: next.duration_ms > 0 ? next.duration_ms / 1000 : undefined,
        id: next.id,
        isrc: next.external_ids?.isrc,
      }).catch(() => { /* best-effort */ })
    }
  }, [active, trackId, spotifyIndex, spotifyTracks])

  /*
   * Keep lyrics synchronized with Spotify.
   */
  useEffect(() => {
    if (!trackId || !playing) return

    if (stalePositionRef.current !== null) {
      if (
        playbackPosition ===
        stalePositionRef.current
      ) {
        return
      }

      stalePositionRef.current = null
    }

    const threshold = lyricSynced
      ? SEEK_SNAP_MS
      : SEEK_SNAP_MS * 3

    if (
      Math.abs(
        timeRef.current - playbackPosition,
      ) > threshold
    ) {
      resync(playbackPosition)
    }
  }, [
    playbackPosition,
    trackId,
    playing,
    lyricSynced,
    resync,
  ])

  /*
   * Correct position when playback resumes.
   */
  useEffect(() => {
    const resumed =
      playing && !previousPlayingRef.current

    previousPlayingRef.current = playing

    if (!resumed || !trackId) return

    const sdkPosition =
      useStore.getState().playbackPosition

    if (stalePositionRef.current !== null) {
      if (
        sdkPosition ===
        stalePositionRef.current
      ) {
        return
      }

      stalePositionRef.current = null
    }

    const threshold = lyricSyncedRef.current
      ? SEEK_SNAP_MS
      : SEEK_SNAP_MS * 3

    if (
      Math.abs(
        timeRef.current - sdkPosition,
      ) > threshold
    ) {
      resync(sdkPosition)
    }
  }, [playing, trackId, resync])

  const position = trackId
    ? currentTime / 1000
    : localTime

  /*
   * Find active lyric.
   */
  const activeIndex = useMemo(() => {
    if (!active || !lines.length) return -1

    let index = -1

    for (let i = 0; i < lines.length; i++) {
      if (
        position >=
        lines[i].start - LINE_LEAD_SECONDS
      ) {
        index = i
      } else {
        break
      }
    }

    return index
  }, [active, lines, position])

  const ended =
    activeIndex === -1 &&
    lines.length > 0 &&
    position >= lines[lines.length - 1].end

  const currentIndex = ended
    ? -1
    : activeIndex

  /*
   * Only render one previous and four upcoming lyrics.
   */
  const visibleLines = useMemo(() => {
    if (currentIndex >= 0) {
      const start = Math.max(
        0,
        currentIndex - PREVIOUS_LINES,
      )

      const end = Math.min(
        lines.length,
        currentIndex + NEXT_LINES + 1,
      )

      return lines.slice(start, end)
    }

    /*
     * Intro: nothing has been sung yet. Showing the upcoming lines here is
     * the difference between lyrics that appear with the first vocal and
     * lyrics that are already on screen when the track opens.
     */
    if (ended) return []

    return lines.slice(0, NEXT_LINES + 1)
  }, [lines, currentIndex, ended])

  const readVisibleHeights = useCallback(() => {
    const nextHeights = new Map<number, number>()

    for (const line of visibleLines) {
      const node = nodeRefs.current.get(
        line.start,
      )

      if (!node) continue

      /*
       * offsetHeight includes wrapped lines and vertical padding,
       * but intentionally excludes the motion scale transform.
       */
      const height = node.offsetHeight

      if (height > 0) {
        nextHeights.set(line.start, height)
      }
    }

    return nextHeights
  }, [visibleLines])

  const commitHeights = (
    nextHeights: Map<number, number>,
  ) => {
    if (!nextHeights.size) return

    setHeights((previous) => {
      let changed =
        previous.size !== nextHeights.size

      if (!changed) {
        for (const [key, value] of nextHeights) {
          if (
            Math.abs(
              (previous.get(key) ?? 0) - value,
            ) > 0.5
          ) {
            changed = true
            break
          }
        }
      }

      if (!changed) return previous

      const merged = new Map(previous)

      for (const [key, value] of nextHeights) {
        merged.set(key, value)
      }

      return merged
    })
  }

  /*
   * Measure before paint whenever the visible slice changes.
   */
  useLayoutEffect(() => {
    // Measuring before paint is the point — the heights feed the y positions of
    // the lines being painted — and commitHeights bails out unless a height
    // actually changed, so this cannot cascade.
    // oxlint-disable-next-line react/set-state-in-effect -- DOM measurement
    commitHeights(readVisibleHeights())
  }, [visibleLines, readVisibleHeights])

  /*
   * Continue observing each lyric so font loading, font-weight changes,
   * container resizing, and text wrapping update neighboring positions.
   */
  useLayoutEffect(() => {
    if (!visibleLines.length) return

    const measure = () => {
      const nextHeights = new Map<number, number>()

      for (const [
        key,
        node,
      ] of nodeRefs.current) {
        const height = node.offsetHeight

        if (height > 0) {
          nextHeights.set(key, height)
        }
      }

      commitHeights(nextHeights)
    }

    const observer = new ResizeObserver(measure)

    for (const line of visibleLines) {
      const node = nodeRefs.current.get(
        line.start,
      )

      if (node) observer.observe(node)
    }

    measure()

    return () => observer.disconnect()
  }, [visibleLines])

  const getDistance = (index: number) =>
    index - currentIndex

  /*
   * Upcoming lines stay genuinely readable (the reference keeps them a touch
   * under full strength) so the words are pre-read before they are sung,
   * instead of fading up out of nothing at the timestamp.
   */
  const getOpacity = (distance: number) => {
    if (distance === 0) return 1
    if (distance === -1) return 0
    if (distance === 1) return 0.55
    if (distance === 2) return 0.34
    if (distance === 3) return 0.2

    return 0.12
  }

  const getScale = (distance: number) => {
    if (distance === 0) return 1
    if (distance === -1) return 0.96
    if (distance === 1) return 0.94
    if (distance === 2) return 0.9
    if (distance === 3) return 0.87

    return 0.84
  }

  const getBlur = (distance: number) => {
    const d = Math.abs(distance)

    if (d === 0) return 0
    if (d === 1) return 0.2
    if (d === 2) return 0.5
    if (d === 3) return 0.9
    if (d === 4) return 1.3

    return 1.8
  }

  const getHeight = (line: LyricLine) =>
    heights.get(line.start) ??
    BASE_LINE_HEIGHT

  /*
   * The actual rendered height after the motion scale is applied.
   * Using this for layout makes LINE_GAP consistent between:
   *
   * - one-line lyrics
   * - two-line wrapped lyrics
   * - lyrics with different target scales
   */
  const getVisualHeight = (
    line: LyricLine,
    distance: number,
  ) =>
    getHeight(line) *
    getScale(distance)

  /*
   * Calculate positions from the visually rendered top and bottom edges.
   *
   * Current stays at CURRENT_RAISE.
   * Every following lyric starts exactly LINE_GAP below the previous
   * lyric's rendered bottom edge.
   * The previous lyric ends exactly LINE_GAP above the current lyric.
   */
  const getYPositions = () => {
    const positions = new Map<number, number>()

    /*
     * Intro: lay the opening lines out below the (still empty) active slot,
     * with the same distance/opacity ramp they'll keep while they scroll up.
     * Distances mirror getDistance() with currentIndex === -1, so the first
     * line lifts into place instead of jumping when it is finally sung.
     */
    if (currentIndex < 0) {
      if (ended || !lines.length) return positions

      const first = lines[0]
      let previousY = CURRENT_RAISE
      let previousVisualHeight = getVisualHeight(first, 0)

      const introEnd = Math.min(lines.length, NEXT_LINES + 1)

      for (let i = 0; i < introEnd; i++) {
        const line = lines[i]
        const distance = i + 1

        const visualHeight = getVisualHeight(
          line,
          distance,
        )

        const y =
          previousY +
          previousVisualHeight / 2 +
          LINE_GAP +
          visualHeight / 2

        positions.set(line.start, y)

        previousY = y
        previousVisualHeight = visualHeight
      }

      return positions
    }

    const currentLine =
      lines[currentIndex]

    if (!currentLine) return positions

    const currentDistance = 0

    const currentVisualHeight =
      getVisualHeight(
        currentLine,
        currentDistance,
      )

    positions.set(
      currentLine.start,
      CURRENT_RAISE,
    )

    /*
     * Upcoming lyrics.
     */
    let previousY = CURRENT_RAISE
    let previousVisualHeight =
      currentVisualHeight

    const upcomingEnd = Math.min(
      lines.length,
      currentIndex + NEXT_LINES + 1,
    )

    for (
      let i = currentIndex + 1;
      i < upcomingEnd;
      i++
    ) {
      const line = lines[i]
      const distance = getDistance(i)

      const visualHeight =
        getVisualHeight(
          line,
          distance,
        )

      const y =
        previousY +
        previousVisualHeight / 2 +
        LINE_GAP +
        visualHeight / 2

      positions.set(line.start, y)

      previousY = y
      previousVisualHeight = visualHeight
    }

    /*
     * Previous lyric.
     */
    if (currentIndex > 0) {
      const previousLine =
        lines[currentIndex - 1]

      const previousDistance =
        getDistance(
          currentIndex - 1,
        )

      const previousVisualHeight =
        getVisualHeight(
          previousLine,
          previousDistance,
        )

      const y =
        CURRENT_RAISE -
        currentVisualHeight / 2 -
        LINE_GAP -
        previousVisualHeight / 2

      positions.set(
        previousLine.start,
        y,
      )
    }

    return positions
  }

  const yPositions = getYPositions()

  /*
   * Track active lyric changes.
   */
  const activeChanged =
    previousActiveIndexRef.current !==
    currentIndex

  useEffect(() => {
    previousActiveIndexRef.current =
      currentIndex
  }, [currentIndex])

  /*
   * The scroll stays a spring, but brightness/scale/blur snap in ~0.2s:
   * a line has to be legible the moment it becomes current, not still
   * catching up while the vocal is already singing it.
   */
  const glide = {
    type: 'spring' as const,
    stiffness: 170,
    damping: 28,
    mass: 0.75,
  }

  const transition = reduceMotion
    ? {
        duration: 0,
      }
    : {
        y: glide,
        opacity: { duration: 0.2, ease: 'easeOut' as const },
        scale: { duration: 0.24, ease: 'easeOut' as const },
        filter: { duration: 0.2, ease: 'easeOut' as const },
      }

  if (!active) return null

  return (
    <div className="amb-lyrics">
      <div className="amb-tumbler">
        {/* While a lookup is in flight the tumbler stays empty — a "..."
            placeholder at the top of a song reads as broken lyrics, and with
            the prefetch above it is almost never seen. */}
        {lines.length === 0 ? (
          fetched ? (
            <motion.div
              className="amb-status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.45 }}
            >
              no lyrics for this track
            </motion.div>
          ) : null
        ) : ended ? null : (
          <div className="amb-stack">
            {visibleLines.map((line) => {
              const absoluteIndex =
                lines.findIndex(
                  (item) =>
                    item.start === line.start,
                )

              const distance =
                getDistance(absoluteIndex)

              const isCurrent =
                distance === 0

              const isBottom =
                distance === NEXT_LINES

              const layoutY =
                yPositions.get(line.start) ??
                CURRENT_RAISE +
                  distance *
                    BASE_LINE_HEIGHT

              // The line that just lost the slot simply fades in place as the
              // stack scrolls on — no extra upward travel of its own.
              const y = layoutY

              /*
               * A newly introduced bottom lyric starts at its final
               * bottom position, so it does not fly in from center.
               */
              const initialBottom =
                isBottom &&
                activeChanged &&
                absoluteIndex >
                  previousActiveIndexRef.current

              return (
                <motion.div
                  key={line.start}
                  ref={(node) => {
                    if (node) {
                      nodeRefs.current.set(
                        line.start,
                        node,
                      )
                    } else {
                      nodeRefs.current.delete(
                        line.start,
                      )
                    }
                  }}
                  className={`amb-line${
                    isCurrent
                      ? ' is-active'
                      : ''
                  }`}
                  style={{
                    /*
                     * Ensure the active lyric stays visually above
                     * upcoming lyrics during scale transitions.
                     */
                    zIndex: isCurrent
                      ? 5
                      : 4 -
                        Math.max(
                          distance,
                          0,
                        ),
                  }}
                  initial={
                    initialBottom
                      ? {
                          opacity: 0,
                          scale: 0.84,
                          y,
                          filter:
                            'blur(1.5px)',
                        }
                      : false
                  }
                  animate={{
                    opacity:
                      getOpacity(distance),
                    scale:
                      getScale(distance),
                    y,
                    filter: `blur(${getBlur(
                      distance,
                    )}px)`,
                  }}
                  transition={
                    initialBottom && !reduceMotion
                      ? {
                          y: {
                            duration: 0,
                          },
                          opacity: {
                            duration: 0.35,
                            ease: 'easeOut',
                          },
                          scale: {
                            duration: 0.35,
                            ease: 'easeOut',
                          },
                          filter: {
                            duration: 0.35,
                            ease: 'easeOut',
                          },
                        }
                      : transition
                  }
                >
                  {line.text}
                </motion.div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}