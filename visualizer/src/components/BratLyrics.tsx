import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { getAudioElement } from '../audio'
import { fetchLyrics, guessFromName, type LyricLine } from '../lyrics'
import { usePlaybackTracker } from '../usePlaybackTracker'

export default function BratLyrics({ active }: { active: boolean }) {
  const [lines, setLines] = useState<LyricLine[]>([])
  const [idx, setIdx] = useState(-1)
  const trackName = useStore((s) => s.trackName)
  const track = useStore((s) => s.spotifyCurrentTrack)
  const playing = useStore((s) => s.spotifyPlaying)
  const metrics = useStore((s) => s.metrics)
  const base = useRef({ pos: 0, at: 0 })

  // Self-contained playback tracker — counts time internally, independent of Spotify SDK
  const { progress } = usePlaybackTracker(
    playing,
    track?.id ?? null,
    track?.duration_ms ?? 0
  )

  // fetch lyrics on track change
  useEffect(() => {
    let cancel = false
    setLines([]); setIdx(-1)
    base.current = { pos: 0, at: performance.now() }
    const meta = track
      ? { title: track.name, artist: track.artists?.[0]?.name, id: track.id }
      : guessFromName(trackName)
    if (!meta.title) return
    fetchLyrics(meta).then((res) => {
      if (cancel) return
      if (res) setLines(res.lines)
    })
    return () => { cancel = true }
  }, [track, trackName])

  // line sync loop — uses the same internal clock as the progress bar
  useEffect(() => {
    const t = setInterval(() => {
      const audio = getAudioElement()
      const pos = track
        ? base.current.pos + (playing ? performance.now() - base.current.at : 0) / 1000
        : audio?.currentTime ?? base.current.pos
      if (track ? !playing : audio?.paused) return
      setIdx(lines.findIndex((l) => pos >= l.start && pos < l.end))
    }, 100)
    return () => clearInterval(t)
  }, [lines, playing, track])

  const bass = metrics?.bass ?? 0
  const blur = `blur(${(1.1 + bass * 1.8).toFixed(2)}px)`
  const metaBlur = `blur(${(0.4 + bass * 0.5).toFixed(2)}px)`
  const current = idx >= 0 ? lines[idx] : null
  const title = (track?.name || trackName || 'no track').toLowerCase()
  const artist = track?.artists?.[0]?.name?.toLowerCase() || ''

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#8ACE00', display: active ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', overflow: 'hidden', zIndex: 5 }}>
      <style>{`
        .brat-meta{position:absolute;top:26px;right:40px;font:600 14px Arial;color:#1c2400;text-transform:lowercase}
        .brat-line{max-width:35%;text-align:justify;text-align-last:justify;font:700 clamp(26px,6vw,64px)/1.15 Arial,Helvetica,sans-serif;color:#0d1200;text-transform:lowercase}
        .brat-next{margin-top:16px;font:400 14px Arial;color:rgba(13,18,0,.55);filter:blur(0.9px);text-transform:lowercase;max-width:70%;text-align:justify;text-align-last:justify}
        .brat-progress{position:absolute;bottom:0;left:0;height:5px;background:rgba(255,255,255,0.5);transition:width 0.1s linear}
      `}</style>
      <div className="brat-meta" style={{ filter: metaBlur }}>{title}{artist && ` – ${artist}`}</div>
      <div
        className="brat-line"
        style={{ transform: `scale(${1 + bass * 0.08})`, filter: blur }}
      >
        {current ? current.text.toLowerCase() : '...'}
      </div>
      {lines[idx + 1] && <div className="brat-next">{lines[idx + 1].text.toLowerCase()}</div>}
      <div className="brat-progress" style={{ width: `${progress}%` }} />
    </div>
  )
}