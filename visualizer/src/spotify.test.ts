import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `spotify.ts` reads env + `window` at import time and keeps its refresh state
 * at module scope, so every case stubs the environment first and re-imports the
 * module to start from a clean slate.
 */
const TOKEN_KEY = 'viz-spotify-tokens'

function stubBrowser(tokens?: Record<string, unknown>) {
  const store = new Map<string, string>()
  if (tokens) store.set(TOKEN_KEY, JSON.stringify(tokens))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
  vi.stubEnv('VITE_SPOTIFY_CLIENT_ID', 'test-client')
  vi.stubEnv('VITE_SPOTIFY_REDIRECT_URI', 'http://localhost:5173/callback')
  return store
}

/** An access token that is already past its expiry, so a refresh is required. */
const expiredTokens = (refreshToken = 'r1') => ({
  access_token: 'stale',
  refresh_token: refreshToken,
  token_type: 'Bearer',
  scope: 'streaming',
  expires_at: Date.now() - 1000,
})

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const freshGrant = (extra: Record<string, unknown> = {}) => ({
  access_token: 'fresh',
  token_type: 'Bearer',
  scope: 'streaming',
  expires_in: 3600,
  ...extra,
})

async function loadSpotify() {
  vi.resetModules()
  return import('./spotify')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('getAccessToken', () => {
  it('returns the stored token while it is still fresh', async () => {
    stubBrowser({ ...expiredTokens(), expires_at: Date.now() + 60_000 })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { getAccessToken } = await loadSpotify()

    expect(await getAccessToken()).toBe('stale')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one refresh between callers that ask in the same tick', async () => {
    stubBrowser(expiredTokens())
    const fetchMock = vi.fn(async () => jsonResponse(freshGrant()))
    vi.stubGlobal('fetch', fetchMock)

    const { getAccessToken } = await loadSpotify()
    const [first, second] = await Promise.all([getAccessToken(), getAccessToken()])

    // Parallel callers (player + lyrics + canvas) used to fire parallel POSTs
    // whose last-write-wins persistence could drop a rotated refresh token.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first).toBe('fresh')
    expect(second).toBe('fresh')
  })

  it('persists a refresh token that Spotify rotated', async () => {
    const store = stubBrowser(expiredTokens('r1'))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(freshGrant({ refresh_token: 'r2' }))))

    const { getAccessToken } = await loadSpotify()
    await getAccessToken()

    expect(JSON.parse(store.get(TOKEN_KEY)!).refresh_token).toBe('r2')
  })

  it('keeps the sent refresh token when the grant omits a new one', async () => {
    const store = stubBrowser(expiredTokens('r1'))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(freshGrant())))

    const { getAccessToken } = await loadSpotify()
    await getAccessToken()

    expect(JSON.parse(store.get(TOKEN_KEY)!).refresh_token).toBe('r1')
  })

  it('clears the session when the refresh is rejected', async () => {
    const store = stubBrowser(expiredTokens())
    // The module logs the failing status before throwing; that is expected here.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)),
    )

    const { getAccessToken } = await loadSpotify()

    expect(await getAccessToken()).toBeNull()
    expect(store.has(TOKEN_KEY)).toBe(false)
    logged.mockRestore()
  })

  it('is null when nothing is stored', async () => {
    stubBrowser()
    vi.stubGlobal('fetch', vi.fn())

    const { getAccessToken } = await loadSpotify()

    expect(await getAccessToken()).toBeNull()
  })
})
