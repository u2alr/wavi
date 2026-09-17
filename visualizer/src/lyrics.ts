export interface LyricWord { text: string; start: number; end: number }
export interface LyricLine { start: number; end: number; text: string; words?: LyricWord[] }
export interface TrackMeta {
  title: string
  artist?: string
  album?: string
  /** Track length in seconds — LRCLib matches/ranks on it, which is the
   *  difference between the studio cut and a live/extended rip. */
  duration?: number
  id?: string
  isrc?: string
}

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
/* Line hygiene                                                        */
/* ------------------------------------------------------------------ */

const SECTION_RE = /^\[[^\]]*\]$/
const DECORATION_RE = /[*♪♫•·…\-–—_.,!?"'`~:;()[\]{}/|\\<>+=&@#$%^]/g

/**
 * Is this line worth showing? Drops the structural markers lyrics files are
 * full of ("[Chorus]", "[Guitar Solo]") and decoration-only lines ("♪♪",
 * "...", "---") — both read as broken lyrics in a tumbler.
 */
function isDisplayLyric(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || SECTION_RE.test(trimmed)) return false
  return trimmed.replace(DECORATION_RE, '').trim().length > 0
}

/* ------------------------------------------------------------------ */
/* LRC parsing — with word-level ("enhanced LRC") tag extraction        */
/* ------------------------------------------------------------------ */

const LINE_TAG_RE = /\[(\d+):(\d+(?:\.\d+)?)\]/g
const WORD_TAG_RE = /<(\d+):(\d+(?:\.\d+)?)>/g
const OFFSET_TAG_RE = /\[offset:\s*([+-]?\d+)\s*\]/i

/**
 * Extract per-word timings from a raw line that contains inline
 * `<mm:ss.xx>` word tags (LRCLib "word-by-word" synced lyrics).
 * Returns null if the line has no word tags.
 */
function extractTimedWords(raw: string, line: LyricLine): LyricWord[] | null {
  const tagged: { t: number; text: string }[] = []
  let m: RegExpExecArray | null
  WORD_TAG_RE.lastIndex = 0
  // Files that tag only the later words still have to show their opening text:
  // karaoke mode renders the line from this word list alone, so a dropped lead
  // would silently truncate the lyric.
  const first = WORD_TAG_RE.exec(raw)
  if (first) {
    const lead = raw.slice(0, first.index).trim()
    if (lead) tagged.push({ t: line.start, text: lead })
  }
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
  // Global [offset:±ms] tag shifts every timestamp (standard LRC). Plenty of
  // files carry one to compensate for a rip that runs early/late.
  const offsetTag = OFFSET_TAG_RE.exec(lrc)
  const offset = offsetTag ? Number(offsetTag[1]) / 1000 : 0

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
    if (!isDisplayLyric(text) || times.length === 0) continue
    for (const t of times) {
      const start = Math.max(0, t + offset)
      out.push({ start, end: start + 8, text, raw: rawText })
    }
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start
  return out.map(({ raw, ...line }) => {
    const words = extractTimedWords(raw, line)
    return words ? { ...line, words } : line
  })
}

/**
 * Plain-text lyrics carry no timings at all, so spread them across the track
 * (weighted by line length) instead of a flat 6s-per-line grid. Rough, but it
 * tracks the song instead of drifting past the end.
 */
function layoutPlainLyrics(plain: string, duration?: number): LyricLine[] {
  const texts = plain.split(/\r?\n/).map((t) => t.trim()).filter(isDisplayLyric)
  if (!texts.length) return []
  if (!duration || duration < 20) {
    return texts.map((text, i) => ({ start: i * 6, end: i * 6 + 6, text }))
  }
  const lead = Math.min(6, duration * 0.06)
  const span = Math.max(1, duration - lead)
  const weights = texts.map((t) => Math.max(10, t.length))
  const total = weights.reduce((s, w) => s + w, 0)
  let cursor = lead
  return texts.map((text, i) => {
    const start = cursor
    cursor += (weights[i] / total) * span
    return { start, end: i === texts.length - 1 ? duration : cursor, text }
  })
}

/* ------------------------------------------------------------------ */
/* Matching — Spotify metadata is dirty, LRCLib matching is exact.      */
/* ------------------------------------------------------------------ */

// Suffixes Spotify and friends bolt onto titles that LRCLib does not store.
const TITLE_BRACKETS_RE =
  /[[(][^)\]]*(feat\.?|ft\.?|with |remaster|remastered|live|version|edit|mix|deluxe|bonus|explicit|mono|stereo|anniversary|demo|acoustic|instrumental|sped up|slowed|tiktok|spotify)[^)\]]*[)\]]/gi
const TITLE_TAIL_RE =
  /\s*[-–—]\s*(remaster(ed)?(\s+\d{4})?|live(\s+.*)?|single(\s+version)?|album(\s+version)?|radio\s+edit|deluxe(\s+.*)?|bonus\s+track|explicit|mono|stereo|instrumental|acoustic|demo|\d{4}\s+remaster(ed)?|.*?\b(version|edit|mix|remaster(ed)?)\b|from\s+.*)\s*$/gi
const TITLE_FEAT_RE = /\s+(feat\.?|ft\.?|featuring)\s+.*$/i

/**
 * Strip the version/feature noise so "Song - Remastered 2011 (feat. X)" can
 * still match the plain "Song" record. Falls back to the raw title.
 */
export function cleanTitle(title: string): string {
  const cleaned = title
    .replace(TITLE_BRACKETS_RE, ' ')
    .replace(TITLE_FEAT_RE, '')
    .replace(TITLE_TAIL_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
    .trim()
  return cleaned || title.trim()
}

/** Loose comparison form — case/accent/punctuation-insensitive. */
const norm = (s?: string) =>
  (s || '').toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim()

// Qualifiers that mean a *different* recording. Only penalized when the
// queried title doesn't ask for them.
const VARIANT_WORDS = [
  'live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic', 'slowed',
  'sped', 'nightcore', 'demo', 'edit', 'version', 'mix', 'remaster', 'remastered',
  'backing', 'tribute', 'reprise', 'extended',
]

interface LrclibRecord {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

const LRCLIB_API = 'https://lrclib.net/api'

async function lrclibGet(params: Record<string, string>, signal?: AbortSignal): Promise<LrclibRecord | null> {
  try {
    const res = await fetch(`${LRCLIB_API}/get?${new URLSearchParams(params)}`, { signal })
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === 'object' ? (data as LrclibRecord) : null
  } catch { return null }
}

async function lrclibSearch(params: Record<string, string>, signal?: AbortSignal): Promise<LrclibRecord[]> {
  try {
    const res = await fetch(`${LRCLIB_API}/search?${new URLSearchParams(params)}`, { signal })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? (data as LrclibRecord[]) : []
  } catch { return [] }
}

/**
 * Rank search hits: timed lyrics first, then length agreement, then how
 * exactly the title/artist line up, then "is this even the same recording".
 */
function rankCandidates(records: LrclibRecord[], meta: TrackMeta, title: string): LrclibRecord[] {
  const wantTitle = norm(title)
  const wantArtist = norm(meta.artist)
  const wantDur = meta.duration && meta.duration > 0 ? meta.duration : undefined
  const askedFor = new Set(VARIANT_WORDS.filter((w) => wantTitle.includes(w)))

  const score = (rec: LrclibRecord) => {
    let s = 0
    if (rec.instrumental) s -= 200
    if (rec.syncedLyrics) s += 60
    else if (rec.plainLyrics) s += 20
    else s -= 100

    if (wantDur && rec.duration) {
      const delta = Math.abs(wantDur - rec.duration)
      s += delta <= 1.5 ? 40 : delta <= 3 ? 20 : delta <= 6 ? 5 : delta <= 15 ? -10 : -40
    }
    const recTitle = norm(rec.trackName)
    if (recTitle && recTitle === wantTitle) s += 30
    else if (recTitle && (recTitle.includes(wantTitle) || wantTitle.includes(recTitle))) s += 12
    const recArtist = norm(rec.artistName)
    if (wantArtist && recArtist) {
      if (recArtist === wantArtist) s += 20
      else if (recArtist.includes(wantArtist) || wantArtist.includes(recArtist)) s += 8
    }
    for (const word of VARIANT_WORDS) {
      if (askedFor.has(word)) continue
      if (recTitle.includes(word)) s -= 35
    }
    return s
  }

  return records
    .map((rec) => ({ rec, s: score(rec) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.rec)
}

/**
 * Spotify and LRCLib disagree by a second or two on the same master; more than
 * that and it is a different cut (extended, live, faded outro).
 */
const LENGTH_TOLERANCE = 8
function sameLength(rec: LrclibRecord, duration?: number): boolean {
  if (!duration || !rec.duration) return true
  return Math.abs(rec.duration - duration) <= LENGTH_TOLERANCE
}

/**
 * A synced file for a different cut drifts badly, so sanity-check the last
 * timestamp against the track length before trusting it.
 */
function withinTrack(lines: LyricLine[], duration?: number): boolean {
  if (!duration || duration <= 0 || !lines.length) return true
  return lines[0].start <= duration && lines[lines.length - 1].start <= duration + 20
}

function lyricsFrom(rec: LrclibRecord, meta: TrackMeta): { lines: LyricLine[]; synced: boolean } | null {
  if (rec.instrumental) return null
  if (rec.syncedLyrics) {
    const lines = parseLRC(rec.syncedLyrics)
    if (lines.length && withinTrack(lines, meta.duration)) return { lines, synced: true }
  }
  if (rec.plainLyrics) {
    const lines = layoutPlainLyrics(rec.plainLyrics, meta.duration)
    if (lines.length) return { lines, synced: false }
  }
  return null
}

/* Sources — LRCLib only. NetEase sends no CORS headers and spclient
   rejects user OAuth tokens, so both are unreachable from the browser. */

async function tryLrclib(
  meta: TrackMeta,
  signal?: AbortSignal,
): Promise<{ lines: LyricLine[]; synced: boolean } | null> {
  const title = cleanTitle(meta.title)
  const artist = (meta.artist || '').trim()
  const duration = meta.duration && meta.duration > 0 ? Math.round(meta.duration) : undefined

  const found: LrclibRecord[] = []
  const seen = new Set<string>()
  const add = (rec: LrclibRecord) => {
    const key = rec.id != null ? `id:${rec.id}` : `${rec.trackName}|${rec.artistName}|${rec.duration}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(rec)
  }

  /*
   * 1) Every exact lookup AT ONCE. They don't depend on each other, and each
   *    one costs a full round-trip to lrclib.net (~200ms), so running them in
   *    sequence was most of the wait the tumbler sits through. Preference
   *    order: ISRC (the exact recording) > duration-gated (LRCLib only answers
   *    within ~2s, so a hit rejects other cuts outright) > artist+title.
   */
  const [gatedRec, looseRec] = await Promise.all([
    artist && duration
      ? lrclibGet({ artist_name: artist, track_name: title, duration: String(duration) }, signal)
      : Promise.resolve(null),
    lrclibGet(artist ? { artist_name: artist, track_name: title } : { track_name: title }, signal),
  ])
  if (signal?.aborted) return null

  // The duration-gated hit identifies the recording, so trust it outright.
  if (gatedRec) {
    const exact = lyricsFrom(gatedRec, meta)
    if (exact) return exact
    add(gatedRec)
  }

  // Artist + title alone can be a different cut wearing the same name, so it
  // is only taken straight away when the lengths agree.
  if (looseRec) {
    const exact = sameLength(looseRec, duration) ? lyricsFrom(looseRec, meta) : null
    if (exact) return exact
    add(looseRec)
  }

  /*
   * 2) Fuzzy fallback, ranked: catches remasters, "feat." ordering, casing and
   *    punctuation differences the exact lookups 404 on. The two primary
   *    queries go out together; the title-only search is noisier, so it is
   *    only paid for when almost nothing came back.
   */
  const searchQueries: Record<string, string>[] = artist
    ? [{ artist_name: artist, track_name: title }, { q: `${title} ${artist}` }]
    : [{ q: title }]
  for (const recs of await Promise.all(searchQueries.map((params) => lrclibSearch(params, signal)))) {
    for (const rec of recs.slice(0, 20)) add(rec)
  }
  if (found.length < 3) {
    for (const rec of (await lrclibSearch({ q: title }, signal)).slice(0, 20)) add(rec)
  }
  if (signal?.aborted) return null

  for (const rec of rankCandidates(found, meta, title)) {
    const out = lyricsFrom(rec, meta)
    if (out) return out
  }

  /*
   * 3) Last resort: the ISRC. LRCLib only carries one for a minority of
   *    tracks (measured: 0 of 100 records across popular releases), so
   *    probing it up front was ~200ms of nothing on nearly every lookup. Here
   *    it only costs anything when the answer would otherwise be "no lyrics".
   */
  if (meta.isrc) {
    const rec = await lrclibGet({ isrc: meta.isrc }, signal)
    if (rec) return lyricsFrom(rec, meta)
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Public API + cache (unchanged contract)                             */
/* ------------------------------------------------------------------ */

/**
 * Synchronous cache read. Callers use it to render a track's lyrics on the
 * very first frame (a track that was prefetched or played before) instead of
 * showing a loading state.
 */
export function cachedLyrics(meta: TrackMeta): { lines: LyricLine[]; source: string; synced: boolean } | null {
  try {
    const hit = readLyricCache()[lyricCacheKey(meta)]
    if (hit && Array.isArray(hit.lines) && Date.now() - hit.cachedAt < LYRIC_CACHE_TTL_MS) {
      return { lines: hit.lines, source: hit.source, synced: hit.synced }
    }
  } catch { /* fall through to network */ }
  return null
}

export async function fetchLyrics(meta: TrackMeta, signal?: AbortSignal): Promise<{ lines: LyricLine[]; source: string; synced: boolean } | null> {
  const key = lyricCacheKey(meta)
  const cached = cachedLyrics(meta)
  if (cached) return cached

  const lr = await tryLrclib(meta, signal)
  if (!lr) return null
  const best = { lines: lr.lines, source: 'lrclib', synced: lr.synced }
  writeLyricCache(key, best)
  return best
}

/** Lyrics cache — localStorage, 7-day TTL, capped so it can't bloat.
 *  v2: v1 entries were written before title cleaning / duration ranking, so
 *  they can be the wrong version of a song. Bumping the key retires them. */
const LYRIC_CACHE_KEY = 'wavi-lyrics-v2'
const LYRIC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LYRIC_CACHE_MAX = 50

interface LyricCacheEntry { lines: LyricLine[]; synced: boolean; source: string; cachedAt: number }

/**
 * Parsed cache held in memory. Reads happen on every track change (and the
 * localStorage copy can run to tens of KB), so the parse is worth skipping.
 */
let lyricCacheMemory: Record<string, LyricCacheEntry> | null = null

function readLyricCache(): Record<string, LyricCacheEntry> {
  if (lyricCacheMemory) return lyricCacheMemory
  let cache: Record<string, LyricCacheEntry> = {}
  try {
    const raw = localStorage.getItem(LYRIC_CACHE_KEY)
    if (raw) cache = JSON.parse(raw)
  } catch { /* unreadable store — memory only */ }
  lyricCacheMemory = cache
  return cache
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