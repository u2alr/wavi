import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Shuffle and repeat are pushed onto the device as one request each, on every
 * selection — which is most of what made rapid clicking trip rate limiting, since
 * the values usually haven't changed at all. They are now only sent when the
 * value or the device differs from what was last pushed.
 */
const calls = vi.hoisted(() => [] as { url: string }[])

vi.mock('./spotify', () => ({
  getAccessToken: async () => 'token',
  spotifyApi: async (url: string) => {
    calls.push({ url })
    return {}
  },
}))

/** Both modules freshly, so the queue's module-level memo starts empty. */
async function load() {
  vi.resetModules()
  calls.length = 0
  const [queue, store] = await Promise.all([import('./spotifyQueue'), import('./store')])
  return { queue, store }
}

const urls = () => calls.map((call) => call.url)

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('applySpotifyTransportModes', () => {
  it('sends both modes, aimed at the device, the first time', async () => {
    const { queue, store } = await load()
    store.useStore.setState({ shuffle: false, repeatMode: 'off' })

    queue.applySpotifyTransportModes('device-1')

    expect(urls()).toEqual([
      '/me/player/repeat?state=off&device_id=device-1',
      '/me/player/shuffle?state=false&device_id=device-1',
    ])
  })

  it('sends nothing when neither the modes nor the device changed', async () => {
    const { queue, store } = await load()
    store.useStore.setState({ shuffle: false, repeatMode: 'off' })

    queue.applySpotifyTransportModes('device-1')
    queue.applySpotifyTransportModes('device-1')
    queue.applySpotifyTransportModes('device-1')

    // The spam case: one selection used to be two requests, every time.
    expect(calls).toHaveLength(2)
  })

  it('re-sends only the mode that changed', async () => {
    const { queue, store } = await load()
    store.useStore.setState({ shuffle: false, repeatMode: 'off' })
    queue.applySpotifyTransportModes('device-1')

    store.useStore.setState({ shuffle: true })
    queue.applySpotifyTransportModes('device-1')

    expect(urls().slice(2)).toEqual(['/me/player/shuffle?state=true&device_id=device-1'])
  })

  it('re-sends both for a different device', async () => {
    const { queue, store } = await load()
    store.useStore.setState({ shuffle: false, repeatMode: 'off' })

    queue.applySpotifyTransportModes('device-1')
    queue.applySpotifyTransportModes('device-2')

    // A mode toggled before playback started has to reach whichever device ends
    // up playing, so the memo cannot be remembered across a transfer.
    expect(calls).toHaveLength(4)
    expect(urls().slice(2)).toEqual([
      '/me/player/repeat?state=off&device_id=device-2',
      '/me/player/shuffle?state=false&device_id=device-2',
    ])
  })
})
