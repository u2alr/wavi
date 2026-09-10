import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { fetchLyrics, guessFromName, type LyricLine } from '../lyrics'
import { usePlaybackTracker } from '../usePlaybackTracker'

const SEEK_SNAP_MS = 2000
const LINE_LEAD_SECONDS = 0.3

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

    const changed =
      lastSongKeyRef.current !== songKey

    if (changed) {
      lastSongKeyRef.current = songKey

      setLines([])
      setFetched(false)
      setHeights(new Map())

      previousActiveIndexRef.current = -1

      resync(0)

      stalePositionRef.current =
        useStore.getState().playbackPosition
    }

    const meta = trackId
      ? {
          title: trackTitle,
          artist: trackArtist,
          id: trackId,
        }
      : guessFromName(trackName)

    if (!meta.title) {
      setLines([])
      setFetched(true)

      return () => controller.abort()
    }

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
    songKey,
    resync,
  ])

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
    if (currentIndex < 0) return []

    const start = Math.max(
      0,
      currentIndex - PREVIOUS_LINES,
    )

    const end = Math.min(
      lines.length,
      currentIndex + NEXT_LINES + 1,
    )

    return lines.slice(start, end)
  }, [lines, currentIndex])

  const readVisibleHeights = () => {
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
  }

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
    commitHeights(readVisibleHeights())
  }, [visibleLines])

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

  const getOpacity = (distance: number) => {
    if (distance === 0) return 1
    if (distance === -1) return 0
    if (distance === 1) return 0.48
    if (distance === 2) return 0.25
    if (distance === 3) return 0.12

    return 0.045
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
    if (d === 1) return 0.25
    if (d === 2) return 0.6
    if (d === 3) return 1
    if (d === 4) return 1.5

    return 2
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

    if (currentIndex < 0) return positions

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

  const transition = reduceMotion
    ? {
        duration: 0,
      }
    : {
        type: 'spring' as const,
        stiffness: 170,
        damping: 28,
        mass: 0.75,
      }

  if (!active) return null

  return (
    <div className="amb-lyrics">
      <div className="amb-tumbler">
        {!fetched ? (
          <motion.div
            className="amb-status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.45 }}
          >
            ...
          </motion.div>
        ) : lines.length === 0 ? (
          <motion.div
            className="amb-status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.45 }}
          >
            no lyrics for this track
          </motion.div>
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

              const y =
                yPositions.get(line.start) ??
                CURRENT_RAISE +
                  distance *
                    BASE_LINE_HEIGHT

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
                    initialBottom &&
                    !reduceMotion
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