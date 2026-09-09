export interface LyricWord { text: string; start: number; end: number }
export interface LyricLine { start: number; end: number; text: string; words?: LyricWord[] }
export interface TrackMeta { title: string; artist?: string; id?: string; isrc?: string }

/* ------------------------------------------------------------------ */
/* Word timing — only used as a fallback when the source gives us      */
/* line-level timing only.                                             */
/* ------------------------------------------------------------------ */

const WORD_GAP = 0.07 // ~70ms breath between words

/** Rough syllable count via vowel groups — sung duration scales with this, not chars. */
function syllables(w: string): number {
  const groups = w.toLowerCase().match(/[aeiouyà-ÿ]+/g)
  return Math.max(1, groups?.length ?? 1)
}

/**
 * Fallback: interpolate word timings across a line window,
 * weighted by syllables, with a small gap reserved between words.
 */
export function toTimedWords(line: LyricLine): LyricWord[] {
  if (line.words?.length) return line.words // already have real timings
  const parts = line.text.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return []
  if (parts.length === 1) return [{ text: parts[0], start: line.start, end: line.end }]
  // Structural markers like "[Verse 1]" — never karaoke them
  if (/^\[.+\]$/.test(line.text.trim())) return []

  const span = Math.max(0.2, line.end - line.start)
  const usable = Math.max(0.05, span - WORD_GAP * (parts.length - 1))
  const weights = parts.map(syllables)
  const total = weights.reduce((s, w) => s + w, 0)
  let cursor = line.start
  return parts.map((text, i) => {
    const isLast = i === parts.length - 1
    const dur = (weights[i] / total) * usable
    const word: LyricWord = { text, start: cursor, end: isLast ? line.end : cursor + dur }
    cursor += dur + WORD_GAP
    return word
  })
}

/* ------------------------------------------------------------------ */
/* LRC parsing — now with word-level ("enhanced LRC") tag extraction   */
/* ------------------------------------------------------------------ */

const LINE_TAG_RE = /\[(\d+):(\d+(?:\.\d+)?)\]/g
const WORD_TAG_RE = /<(\d+):(\d+(?:\.\d+)?)>/g
const META_TAG_RE = /^\[(ti|ar|al|by|re|ve|length|au):/i

/**
 * Extract per-word timings from a raw line that contains inline
 * `<mm:ss.xx>` word tags (LRCLib "word-by-word" synced lyrics).
 * Returns null if the line has no word tags.
 */
function extractTimedWords(raw: string, line: LyricLine): LyricWord[] | null {
  const tagged: { t: number; text: string }[] = []
  let m: RegExpExecArray | null
  WORD_TAG_RE.lastIndex = 0
  while ((m = WORD_TAG_RE.exec(raw))) {
    const rest = raw.slice(m.index + m[0].length)
    const next = rest.search(/<\d+:\d/)
    const text = (next === -1 ? rest : rest.slice(0, next)).trim()
    if (text) tagged.push({ t: Number(m[1]) * 60 + parseFloat(m[2]), text })
  }
  if (!tagged.length) return null

  // Files vary: most use absolute time (first tag == line start),
  // MiniLyrics-style files use time relative to the line start.
  const absolute = tagged[0].t >= line.start - 0.25 && tagged[0].t < line.end
  const at = (t: number) => (absolute ? t : line.start + t)

  return tagged.map((w, i) => ({
    text: w.text,
    start: at(w.t),
    end: i + 1 < tagged.length ? at(tagged[i + 1].t) : line.end,
  }))
}

export function parseLRC(lrc: string): LyricLine[] {
  const out: (LyricLine & { raw: string })[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const times: number[] = []
    let m: RegExpExecArray | null
    let lastEnd = 0
    LINE_TAG_RE.lastIndex = 0
    while ((m = LINE_TAG_RE.exec(raw))) {
      times.push(Number(m[1]) * 60 + parseFloat(m[2]))
      lastEnd = m.index + m[0].length
    }
    const rawText = raw.slice(lastEnd).trim()          // keeps <mm:ss.xx> tags
    const text = rawText.replace(WORD_TAG_RE, '').trim() // clean display text
    if (!text || times.length === 0 || META_TAG_RE.test(text)) continue
    for (const t of times) out.push({ start: t, end: t + 8, text, raw: rawText })
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start
  return out.map(({ raw, ...line }) => {
    const words = extractTimedWords(raw, line)
    return words ? { ...line, words } : line
  })
}

/* Sources — LRCLib only. NetEase sends no CORS headers and spclient
   rejects user OAuth tokens, so both are unreachable from the browser. */

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
        return { lines: plain.map((text: string, i: number) => ({ start: i * 6, end: i * 6 + 6, text })), synced: false }
      }
    } catch { /* next / aborted */ }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Public API + cache (unchanged contract)                             */
/* ------------------------------------------------------------------ */

export async function fetchLyrics(meta: TrackMeta, signal?: AbortSignal): Promise<{ lines: LyricLine[]; source: string; synced: boolean } | null> {
  const key = lyricCacheKey(meta)
  try {
    const hit = readLyricCache()[key]
    if (hit && Array.isArray(hit.lines) && Date.now() - hit.cachedAt < LYRIC_CACHE_TTL_MS) {
      return { lines: hit.lines, source: hit.source, synced: hit.synced }
    }
  } catch { /* fall through to network */ }

  const lr = await tryLrclib(meta, signal)
  if (!lr) return null
  const best = { lines: lr.lines, source: 'lrclib', synced: lr.synced }
  writeLyricCache(key, best)
  return best
}

/** Lyrics cache — localStorage, 7-day TTL, capped so it can't bloat. */
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