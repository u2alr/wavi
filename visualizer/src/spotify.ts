// Spotify OAuth 2.0 — Authorization Code flow with PKCE (no backend needed).

const CLIENT_ID: string | undefined = import.meta.env.VITE_SPOTIFY_CLIENT_ID
const REDIRECT_URI: string =
  import.meta.env.VITE_SPOTIFY_REDIRECT_URI || `${window.location.origin}/`

const TOKEN_KEY = 'viz-spotify-tokens'
const VERIFIER_KEY = 'viz-spotify-verifier'

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
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  const challenge = await codeChallenge(verifier)
  const params = new URLSearchParams({
    client_id: assertConfigured(),
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
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
export async function exchangeCodeForToken(code: string): Promise<SpotifyTokens> {
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
  return tokens
}

/** Generic authenticated fetch to the Spotify Web API. */
export async function spotifyApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated with Spotify')
  const send = (t: string) =>
    fetch(`https://api.spotify.com/v1${path}`, {
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
      throw new Error('Your Spotify session expired. Reconnect and try again.')
    }
  }
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    const detail = await res.text()
    console.error(`Spotify API error (${res.status})${detail ? `: ${detail}` : ''}`)
    if (res.status === 429) {
      throw new Error("Spotify is rate-limiting us. Wait a moment, then tap Retry.")
    }
    if (res.status >= 500) {
      throw new Error("Spotify's servers hiccuped. Tap Retry in a moment.")
    }
    if (res.status === 403) {
      throw new Error('Spotify refused that request. A Premium account may be required.')
    }
    throw new Error("Couldn't reach Spotify. Check your connection and tap Retry.")
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

export async function getPlaylistTracks(playlistId: string, limit = 50): Promise<SpotifyTrack[]> {
  const data = await spotifyApi<{
    items: { item?: SpotifyTrack | null; track?: SpotifyTrack | null }[]
    next: string | null
  }>(`/playlists/${playlistId}/items?limit=${limit}`)
  return data.items
    .map((item) => item.item ?? item.track ?? null)
    .filter((t): t is SpotifyTrack => !!t)
}

export async function searchSpotifyTracks(query: string, limit = 20): Promise<SpotifyTrack[]> {
  const data = await spotifyApi<{ tracks: { items: SpotifyTrack[] } }>(
    `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
  )
  return data.tracks?.items ?? []
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

