import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The SDK player is built on the first play, which is after the app has already
 * applied its persisted volume — so the module has to hold that value until the
 * player exists. These cases exist because it didn't: a refresh played at full
 * volume while the slider read low.
 *
 * The real SDK can't be reached without Premium and a login, so this stubs the
 * piece `spotifyPlayer.ts` talks to and drives the same path the app does.
 */
class FakePlayer {
  options: { volume?: number }
  volumeCalls: number[] = []
  private listeners = new Map<string, (payload: unknown) => void>()

  constructor(options: { volume?: number }) {
    this.options = options
    instances.push(this)
  }
  addListener(event: string, cb: (payload: unknown) => void) {
    this.listeners.set(event, cb)
  }
  async connect() {
    this.listeners.get('ready')?.({ device_id: 'device-1' })
  }
  async setVolume(volume: number) {
    this.volumeCalls.push(volume)
  }
}

let instances: FakePlayer[] = []
const apiCalls = vi.hoisted(() => [] as { url: string; body?: string }[])

vi.mock('./spotify', () => ({
  getAccessToken: async () => 'token',
  spotifyApi: async (url: string, init?: { body?: string }) => {
    apiCalls.push({ url, body: init?.body })
    return {}
  },
}))

async function loadPlayer() {
  vi.resetModules()
  instances = []
  apiCalls.length = 0
  return import('./spotifyPlayer')
}

beforeEach(() => {
  vi.stubGlobal('window', {
    Spotify: { Player: FakePlayer },
    // Delegated rather than copied, so a case that swaps in fake timers after
    // this stub was installed still reaches them.
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('rapid track selections', () => {
  const uris = ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']

  it('sends one request, for the selection made last', async () => {
    vi.useFakeTimers()
    try {
      const sdk = await loadPlayer()

      const first = sdk.playTracks(uris, 0, 'device-1')
      const last = sdk.playTracks(uris, 2, 'device-1')
      await vi.advanceTimersByTimeAsync(400)
      await Promise.all([first, last])

      // One request, carrying the newest offset. Clicking 2,3,4,5 used to send
      // four PUTs whose order Spotify does not guarantee, so playback could be
      // left on 2 — the track clicked first — while the UI showed 5.
      expect(apiCalls).toHaveLength(1)
      expect(JSON.parse(apiCalls[0].body!).offset.position).toBe(2)
      expect(apiCalls[0].url).toContain('device_id=device-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still sends a lone selection', async () => {
    vi.useFakeTimers()
    try {
      const sdk = await loadPlayer()

      const settled = sdk.playTracks(uris, 1, 'device-1')
      await vi.advanceTimersByTimeAsync(400)
      await settled

      expect(apiCalls).toHaveLength(1)
      expect(JSON.parse(apiCalls[0].body!).offset.position).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the newest track pending before the request goes out', async () => {
    vi.useFakeTimers()
    try {
      const sdk = await loadPlayer()

      void sdk.playTracks(uris, 0, 'device-1')
      void sdk.playTracks(uris, 2, 'device-1')

      // The stale-event guard has to cover the settle window, not just the
      // flight, or an event for the track being left behind lands in between.
      expect(sdk.getPendingTrackId()).toBe('c')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('volume set before the player exists', () => {
  it('is the volume the player is created with', async () => {
    const sdk = await loadPlayer()

    await sdk.setSpotifyVolume(0.3)
    await sdk.ensureSpotifyPlayer()

    // Both, deliberately: the constructor option is the SDK's own initial
    // volume, and setVolume on ready is what covers it not being honoured.
    expect(instances[0].options.volume).toBe(0.3)
    expect(instances[0].volumeCalls).toEqual([0.3])
  })

  it('is re-applied when the player becomes ready', async () => {
    const sdk = await loadPlayer()

    await sdk.ensureSpotifyPlayer()

    expect(instances[0].volumeCalls).toContain(1)
  })

  it('is still applied when it changes while the player exists', async () => {
    const sdk = await loadPlayer()

    await sdk.ensureSpotifyPlayer()
    await sdk.setSpotifyVolume(0.8)

    expect(instances[0].volumeCalls.at(-1)).toBe(0.8)
  })

  it('is clamped before it reaches the SDK', async () => {
    const sdk = await loadPlayer()

    await sdk.setSpotifyVolume(3)

    expect(instances).toHaveLength(0) // nothing constructed yet: the value waits
    await sdk.ensureSpotifyPlayer()
    expect(instances[0].options.volume).toBe(1)
  })
})
