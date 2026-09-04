import { getAccessToken } from './spotify'

export interface LyricLine { start: number; end: number; text: string }
export interface TrackMeta { title: string; artist?: string; id?: string; isrc?: string }

function parseSpotifyTime(t: string): number {
  const p = t.split(':').map(parseFloat)
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0
}

export function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g
  for (const raw of lrc.split('\n')) {
    const times: number[] = []
    let m: RegExpExecArray | null, lastEnd = 0
    re.lastIndex = 0
    while ((m = re.exec(raw))) { times.push(Number(m[1]) * 60 + parseFloat(m[2])); lastEnd = m.index + m[0].length }
    const text = raw.slice(lastEnd).trim()
    if (!text || times.length === 0) continue
    for (const t of times) lines.push({ start: t, end: t + 8, text })
  }
  lines.sort((a, b) => a.start - b.start)
  for (let i = 0; i < lines.length - 1; i++) lines[i].end = lines[i + 1].start
  return lines
}

async function trySpotify(id?: string): Promise<LyricLine[] | null> {
  const token = getAccessToken()
  if (!id || !token) return null
  try {
    const res = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&market=from_token`, {
      headers: { Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' },
    })
    if (!res.ok) return null
    const data = await res.json()
    const raw = data?.lyrics?.lines
    if (!Array.isArray(raw) || raw.length === 0) return null
    const lines: LyricLine[] = raw.map((l: any) => ({ start: parseSpotifyTime(l.startTime), end: 0, text: l.words }))
    for (let i = 0; i < lines.length - 1; i++) lines[i].end = lines[i + 1].start
    lines[lines.length - 1].end += 10
    return lines
  } catch { return null } // CORS block -> fall through
}

async function tryLrclib(meta: TrackMeta): Promise<LyricLine[] | null> {
  const urls = []
  if (meta.isrc) urls.push(`https://lrclib.net/api/get?isrc=${encodeURIComponent(meta.isrc)}`)
  urls.push(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(meta.artist || '')}&track_name=${encodeURIComponent(meta.title)}`)
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      if (data?.syncedLyrics) return parseLRC(data.syncedLyrics)
      if (data?.plainLyrics) {
        const plain = data.plainLyrics.split('\n').filter(Boolean)
        return plain.map((text: string, i: number) => ({ start: i * 6, end: i * 6 + 6, text }))
      }
    } catch { /* next */ }
  }
  return null
}

export async function fetchLyrics(meta: TrackMeta): Promise<{ lines: LyricLine[]; source: string } | null> {
  const sp = await trySpotify(meta.id)
  if (sp) return { lines: sp, source: 'spotify' }
  const lr = await tryLrclib(meta)
  if (lr) return { lines: lr, source: 'lrclib' }
  return null
}

export function guessFromName(name?: string): TrackMeta {
  if (!name) return { title: '' }
  const clean = name.replace(/\.[^/.]+$/, '')
  const parts = clean.split(' - ')
  return parts.length >= 2
    ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
    : { title: clean }
}
