// Spotify OAuth 2.0 — Authorization Code flow with PKCE (no backend needed).

const CLIENT_ID: string | undefined = import.meta.env.VITE_SPOTIFY_CLIENT_ID
const REDIRECT_URI: string =
  import.meta.env.VITE_SPOTIFY_REDIRECT_URI || `${window.location.origin}/`

const TOKEN_KEY = 'viz-spotify-tokens'
const VERIFIER_KEY = 'viz-spotify-verifier'
// CSRF marker: generated before we leave for Spotify and checked against the
// `state` that comes back, so a forged or replayed callback URL can't complete
// a sign-in. PKCE already makes a stolen code useless without the verifier;
// this is the other half of the handshake.
const STATE_KEY = 'viz-spotify-state'

const SCOPES = [
  'user-read-email',
  'user-read-private',
  'user-library-read',
  'playlist-read-private',
  // Required for Web Playback SDK playback + control:
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'app-remote-control',
].join(' ')

export interface SpotifyTokens {
  access_token: string
  refresh_token: string
  expires_at: number // epoch ms when the access token expires
  token_type: string
  scope: string
}

export interface SpotifyUser {
  id: string
  display_name: string | null
  images: { url: string }[]
  product: string
}

export interface SpotifyImage {
  url: string
  width?: number
  height?: number
}

export interface SpotifyArtist {
  id: string
  name: string
}

export interface SpotifyAlbum {
  id: string
  name: string
  images: SpotifyImage[]
}

export interface SpotifyTrack {
  id: string
  name: string
  uri: string
  duration_ms: number
  album: SpotifyAlbum
  artists: SpotifyArtist[]
  /** Present on Web API track objects (not on SDK-built placeholders).
   *  Pins lyric lookup to the exact recording. */
  external_ids?: { isrc?: string }
}

export interface SpotifyPlaylist {
  id: string
  name: string
  uri: string
  description: string | null
  images: SpotifyImage[]
  tracks: { total: number }
  owner: { display_name: string | null }
}

function assertConfigured(): string {
  if (!CLIENT_ID) {
    throw new Error(
      'VITE_SPOTIFY_CLIENT_ID is not set. Copy .env.example to .env and add your Spotify Client ID.',
    )
  }
  return CLIENT_ID
}

function base64URLEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(length: number): string {
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return base64URLEncode(arr.buffer)
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64URLEncode(digest)
}

async function buildAuthUrl(): Promise<string> {
  const verifier = randomString(64)
  const state = randomString(16)
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)
  const challenge = await codeChallenge(verifier)
  const params = new URLSearchParams({
    client_id: assertConfigured(),
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
  })
  return `https://accounts.spotify.com/authorize?${params.toString()}`
}

/** Redirect the browser to Spotify's authorization page. */
export async function startSpotifyAuth(): Promise<void> {
  try {
    window.location.assign(await buildAuthUrl())
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Spotify is not configured.')
  }
}

function saveTokens(tokens: SpotifyTokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
}

export function loadTokens(): SpotifyTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    return raw ? (JSON.parse(raw) as SpotifyTokens) : null
  } catch {
    return null
  }
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY)
}

async function postToken(body: URLSearchParams): Promise<SpotifyTokens> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    console.error(`Spotify token request failed (${res.status})`)
    throw new Error("Couldn't sign in with Spotify. Try connecting again.")
  }
  const data = await res.json()
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    scope: data.scope,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

/** Exchange the authorization `code` from the redirect URL for tokens. */
export async function exchangeCodeForToken(
  code: string,
  state: string | null,
): Promise<SpotifyTokens> {
  // No stored state means this browser never started a flow (fresh session,
  // URL opened elsewhere) — the PKCE verifier check covers that case. A state
  // that is present but different is someone else's callback.
  const expected = sessionStorage.getItem(STATE_KEY)
  if (expected && state !== expected) {
    sessionStorage.removeItem(STATE_KEY)
    sessionStorage.removeItem(VERIFIER_KEY)
    throw new Error('Spotify sign-in could not be verified. Start the connection again.')
  }
  const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? ''
  const tokens = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: assertConfigured(),
      code_verifier: verifier,
    }),
  )
  saveTokens(tokens)
  sessionStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(STATE_KEY)
  // Fresh login may mean a different app (possibly with catalog access).
  catalogSearchBlocked = false
  return tokens
}

/** Error from the Spotify Web API — carries the status so callers can recover. */
export class SpotifyApiError extends Error {
  status: number
  reason: string
  serverMessage: string
  constructor(status: number, message: string, opts?: { reason?: string; serverMessage?: string }) {
    super(message)
    this.name = 'SpotifyApiError'
    this.status = status
    this.reason = opts?.reason ?? ''
    this.serverMessage = opts?.serverMessage ?? ''
  }
}

/** Generic authenticated fetch to the Spotify Web API. */
export async function spotifyApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated with Spotify')
  const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`
  const send = (t: string) =>
    fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${t}`, ...(init?.headers ?? {}) },
    })
  let res = await send(token)
  if (res.status === 401) {
    // The token may have expired between the freshness check and the
    // request — try exactly one refresh + retry before giving up the session.
    const stored = loadTokens()
    if (stored?.refresh_token) {
      try {
        const fresh = await refreshTokensDeduped(stored.refresh_token)
        res = await send(fresh.access_token)
      } catch {
        // Refresh itself failed — fall through to session-expired below.
      }
    }
    if (res.status === 401) {
      clearTokens()
      throw new SpotifyApiError(res.status, 'Your Spotify session expired. Reconnect and try again.')
    }
  }
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    const detail = await res.text()
    console.error(`Spotify API error (${res.status})${detail ? `: ${detail}` : ''}`)
    // Spotify usually explains itself in the body
    // ({"error": {"message": "...", "reason": "PREMIUM_REQUIRED"}}) — surface
    // its words instead of a generic banner so failures stay diagnosable.
    let serverMessage = ''
    let reason = ''
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string; reason?: string } }
      serverMessage = parsed?.error?.message ?? ''
      reason = parsed?.error?.reason ?? ''
    } catch {
      // Non-JSON error body — fall through to the generic copy below.
    }
    if (res.status === 429) {
      throw new SpotifyApiError(res.status, "Spotify is rate-limiting us. Wait a moment, then tap Retry.", {
        reason,
        serverMessage,
      })
    }
    if (res.status >= 500) {
      throw new SpotifyApiError(res.status, "Spotify's servers hiccuped. Tap Retry in a moment.", {
        reason,
        serverMessage,
      })
    }
    if (res.status === 403) {
      if (reason === 'PREMIUM_REQUIRED') {
        throw new SpotifyApiError(
          res.status,
          'In-app playback needs Spotify Premium. Play in the Spotify app instead — lyrics will still follow along.',
          { reason, serverMessage },
        )
      }
      throw new SpotifyApiError(res.status, 'Spotify refused that request. A Premium account may be required.', {
        reason,
        serverMessage,
      })
    }
    if (res.status === 400) {
      throw new SpotifyApiError(
        res.status,
        serverMessage && serverMessage !== 'Bad request'
          ? `Spotify rejected that request (${serverMessage}). Tap Retry — if it keeps happening, reconnect Spotify.`
          : 'Spotify rejected that request. Tap Retry — if it keeps happening, reconnect Spotify.',
        { reason, serverMessage },
      )
    }
    throw new SpotifyApiError(res.status, "Couldn't reach Spotify. Check your connection and tap Retry.", {
      reason,
      serverMessage,
    })
  }
  const body = await res.text()
  if (!body.trim()) return undefined as T
  try {
    return JSON.parse(body) as T
  } catch {
    // Some player endpoints answer 2xx with a plain-text body (e.g. an
    // echoed device id). The request succeeded, so hand the raw text back
    // instead of failing the whole action.
    console.warn(`Spotify returned non-JSON success body (${res.status}): ${body.slice(0, 200)}`)
    return body as unknown as T
  }
}

export function getSpotifyUser(): Promise<SpotifyUser> {
  return spotifyApi<SpotifyUser>('/me')
}

export async function getUserPlaylists(limit = 50): Promise<SpotifyPlaylist[]> {
  const data = await spotifyApi<{ items: SpotifyPlaylist[]; next: string | null }>(
    `/me/playlists?limit=${limit}`,
  )
  return data.items ?? []
}

interface PlaylistItemsPage {
  items: { item?: SpotifyTrack | null; track?: SpotifyTrack | null }[]
  total: number
  next: string | null
}

function cleanPlaylistItems(
  items: PlaylistItemsPage['items'],
): SpotifyTrack[] {
  return items
    .map((item) => item.item ?? item.track ?? null)
    .filter((t): t is SpotifyTrack => !!t)
}

/** One page of a playlist's tracks, plus the playlist total. */
export async function getPlaylistTracksPage(
  playlistId: string,
  offset = 0,
  pageSize = 100,
): Promise<{ tracks: SpotifyTrack[]; total: number }> {
  const data = await spotifyApi<PlaylistItemsPage>(
    `/playlists/${playlistId}/items?limit=${pageSize}&offset=${offset}`,
  )
  return { tracks: cleanPlaylistItems(data.items), total: data.total ?? 0 }
}

/**
 * Full track list for a playlist (paged, capped at `max`). The first page
 * returns fast; remaining pages load concurrently so big playlists don't
 * pay sequential round-trips.
 */
export async function getPlaylistTracks(
  playlistId: string,
  max = 500,
): Promise<{ tracks: SpotifyTrack[]; total: number }> {
  const pageSize = 100
  const first = await getPlaylistTracksPage(playlistId, 0, pageSize)
  const want = Math.min(first.total || first.tracks.length, max)
  if (first.tracks.length >= want) {
    return { tracks: first.tracks.slice(0, want), total: first.total }
  }
  const pages = Math.ceil((want - first.tracks.length) / pageSize)
  const rest = await Promise.all(
    Array.from({ length: pages }, (_, k) =>
      getPlaylistTracksPage(playlistId, (k + 1) * pageSize, pageSize),
    ),
  )
  return {
    tracks: [...first.tracks, ...rest.flatMap((p) => p.tracks)].slice(0, want),
    total: first.total,
  }
}

const CATALOG_BLOCKED_MESSAGE =
  'Spotify blocks catalog search for newer developer apps (they need Extended Quota Mode since Nov 2024). Showing matches from your loaded tracks instead — pick a playlist above to search more of your library.'

/**
 * Set once Spotify refuses a /search call: since Nov 27 2024, developer
 * apps without Extended Quota Mode are blocked from catalog endpoints and
 * get a misleading 400 "Invalid limit". Remember it for the session so we
 * skip straight to the local fallback instead of re-failing every search.
 */
let catalogSearchBlocked = false

export async function searchSpotifyTracks(query: string, limit = 10): Promise<SpotifyTrack[]> {
  if (catalogSearchBlocked) {
    throw new SpotifyApiError(400, CATALOG_BLOCKED_MESSAGE, { reason: 'CATALOG_BLOCKED' })
  }
  // /search caps limit at 10 (anything above fails with "Invalid limit").
  const safeLimit = Math.min(10, Math.max(1, Math.floor(limit) || 10))
  const params = new URLSearchParams({
    q: query,
    type: 'track',
    limit: String(safeLimit),
  })
  // NOTE: no `market` param — `from_token` was deprecated in Spotify's Nov
  // 2024 changes and fails the same misleading way.
  try {
    const data = await spotifyApi<{ tracks: { items: SpotifyTrack[] } }>(
      `/search?${params.toString()}`,
    )
    return data.tracks?.items ?? []
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 400) {
      // Params above are valid, so a 400 here is the dev-mode catalog block,
      // not a bad request (Spotify's message is misleading — the restriction
      // is on the app, which also explains why playlists/playback keep working).
      catalogSearchBlocked = true
      throw new SpotifyApiError(400, CATALOG_BLOCKED_MESSAGE, {
        reason: 'CATALOG_BLOCKED',
        serverMessage: err.serverMessage,
      })
    }
    throw err
  }
}

async function refreshTokens(refreshToken: string): Promise<SpotifyTokens> {
  const tokens = await postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: assertConfigured(),
    }),
  )
  tokens.refresh_token = refreshToken
  saveTokens(tokens)
  return tokens
}

// Single-user app, but many callers can ask for a token in the same tick
// (player + search + lyrics). Share one in-flight refresh so parallel
// callers don't fire parallel refresh POSTs with last-write-wins persistence.
let inflightRefresh: Promise<SpotifyTokens> | null = null

function refreshTokensDeduped(refreshToken: string): Promise<SpotifyTokens> {
  if (!inflightRefresh) {
    inflightRefresh = refreshTokens(refreshToken).finally(() => {
      inflightRefresh = null
    })
  }
  return inflightRefresh
}

/** Returns a valid access token, refreshing it when needed. Null if signed out. */
export async function getAccessToken(): Promise<string | null> {
  let tokens = loadTokens()
  if (!tokens) return null
  if (Date.now() < tokens.expires_at - 30_000) return tokens.access_token
  if (!tokens.refresh_token) {
    clearTokens()
    return null
  }
  try {
    tokens = await refreshTokensDeduped(tokens.refresh_token)
    return tokens.access_token
  } catch {
    clearTokens()
    return null
  }
}

