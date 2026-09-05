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

async function trySpotify(id?: string, signal?: AbortSignal): Promise<LyricLine[] | null> {
  const token = getAccessToken()
  if (!id || !token) return null
  try {
    const res = await fetch(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&market=from_token`, {
      headers: { Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' },
      signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    const raw = data?.lyrics?.lines
    if (!Array.isArray(raw) || raw.length === 0) return null
    const lines: LyricLine[] = raw.map((l: any) => ({ start: parseSpotifyTime(l.startTime), end: 0, text: l.words }))
    for (let i = 0; i < lines.length - 1; i++) lines[i].end = lines[i + 1].start
    lines[lines.length - 1].end += 10
    return lines
  } catch { return null } // CORS block / abort -> fall through
}

async function tryLrclib(meta: TrackMeta, signal?: AbortSignal): Promise<{ lines: LyricLine[]; synced: boolean } | null> {
  const urls = []
  if (meta.isrc) urls.push(`https://lrclib.net/api/get?isrc=${encodeURIComponent(meta.isrc)}`)
  urls.push(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(meta.artist || '')}&track_name=${encodeURIComponent(meta.title)}`)
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal })
      if (!res.ok) continue
      const data = await res.json()
      if (data?.syncedLyrics) return { lines: parseLRC(data.syncedLyrics), synced: true }
      if (data?.plainLyrics) {
        const plain = data.plainLyrics.split('\n').filter(Boolean)
        // Unsynced fallback — timings are fabricated, no checker can verify them.
        return { lines: plain.map((text: string, i: number) => ({ start: i * 6, end: i * 6 + 6, text })), synced: false }
      }
    } catch { /* next / aborted */ }
  }
  return null
}

export async function fetchLyrics(meta: TrackMeta, signal?: AbortSignal): Promise<{ lines: LyricLine[]; source: string; synced: boolean } | null> {
  // Cache first: refreshes shouldn't refetch (or re-trip the 401-prone
  // Spotify endpoint) for songs we already resolved.
  const key = lyricCacheKey(meta)
  try {
    const hit = readLyricCache()[key]
    if (hit && Array.isArray(hit.lines) && Date.now() - hit.cachedAt < LYRIC_CACHE_TTL_MS) {
      return { lines: hit.lines, source: hit.source, synced: hit.synced }
    }
  } catch { /* fall through to network */ }

  const sp = await trySpotify(meta.id, signal)
  if (sp) {
    const res = { lines: sp, source: 'spotify', synced: true }
    writeLyricCache(key, res)
    return res
  }
  const lr = await tryLrclib(meta, signal)
  if (lr) {
    const res = { lines: lr.lines, source: 'lrclib', synced: lr.synced }
    writeLyricCache(key, res)
    return res
  }
  return null
}

/** Lyrics cache — localStorage, 7-day TTL, capped so it can't bloat.
 * Best-effort throughout (private mode / quota just means no caching). */
const LYRIC_CACHE_KEY = 'wavi-lyrics-v1'
const LYRIC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LYRIC_CACHE_MAX = 50

interface LyricCacheEntry { lines: LyricLine[]; synced: boolean; source: string; cachedAt: number }

function readLyricCache(): Record<string, LyricCacheEntry> {
  try {
    const raw = localStorage.getItem(LYRIC_CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

export function lyricCacheKey(meta: TrackMeta): string {
  if (meta.id) return `spotify:${meta.id}`
  return `meta:${(meta.artist || '').toLowerCase()}::${meta.title.toLowerCase()}`
}

function writeLyricCache(key: string, entry: Omit<LyricCacheEntry, 'cachedAt'>) {
  try {
    const cache = readLyricCache()
    cache[key] = { ...entry, cachedAt: Date.now() }
    const keys = Object.keys(cache)
    if (keys.length > LYRIC_CACHE_MAX) {
      keys.sort((a, b) => cache[a].cachedAt - cache[b].cachedAt)
      for (const old of keys.slice(0, keys.length - LYRIC_CACHE_MAX)) delete cache[old]
    }
    localStorage.setItem(LYRIC_CACHE_KEY, JSON.stringify(cache))
  } catch { /* caching is best-effort */ }
}

export function guessFromName(name?: string): TrackMeta {
  if (!name) return { title: '' }
  const clean = name.replace(/\.[^/.]+$/, '')
  const parts = clean.split(' - ')
  return parts.length >= 2
    ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
    : { title: clean }
}
