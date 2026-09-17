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

vi.mock('./spotify', () => ({
  getAccessToken: async () => 'token',
  spotifyApi: async () => ({}),
}))

async function loadPlayer() {
  vi.resetModules()
  instances = []
  return import('./spotifyPlayer')
}

beforeEach(() => {
  vi.stubGlobal('window', {
    Spotify: { Player: FakePlayer },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
})

afterEach(() => vi.unstubAllGlobals())

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
