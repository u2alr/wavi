// Spotify Web Playback SDK wrapper (requires a Spotify Premium account).
import { getAccessToken, spotifyApi } from './spotify'

declare global {
  interface Window {
    Spotify?: any
    onSpotifyWebPlaybackSDKReady?: () => void
  }
}

export interface SpotifyPlaybackState {
  paused: boolean
  position: number
  duration: number
  track_window: {
    current_track: {
      id: string
      name: string
      uri: string
      duration_ms: number
      artists: { name: string }[]
      album: { name: string; images: { url: string }[] }
    }
  }
}

let player: any = null
let deviceId: string | null = null
let stateListener: ((s: SpotifyPlaybackState | null) => void) | null = null
let pendingTrackId: string | null = null
// The volume the app last asked for, remembered for the same reason as in
// audio.ts: the SDK player is built lazily on the first play, so a value set
// while it did not exist has to survive until it does. Without this, a refresh
// left the player at its constructor default and everything played at full
// volume while the slider read low — the app only pushes volume when it changes.
let desiredVolume = 1

interface ReadyWaiter {
  settle: (error?: Error) => void
  timer: number
}

let readyWaiters: ReadyWaiter[] = []

/** How long to wait for the SDK device before declaring the player dead. */
const PLAYER_READY_TIMEOUT_MS = 10_000

/**
 * Settle every caller waiting on the device id. Failures *reject*: the SDK
 * reports account/authentication problems through its own listeners, and
 * swallowing them left callers awaiting a `ready` that was never coming — the
 * transport showed the next track as playing while nothing was.
 */
function settleReady(error?: Error) {
  for (const waiter of readyWaiters.splice(0)) waiter.settle(error)
}

/** Resolve with the device id, or reject. Never hangs on a broken player. */
function waitForReady(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const waiter: ReadyWaiter = {
      settle: (error) => {
        window.clearTimeout(waiter.timer)
        if (error) reject(error)
        else resolve(deviceId!)
      },
      timer: 0,
    }
    waiter.timer = window.setTimeout(() => {
      // Drop only this waiter — others may have been added since.
      readyWaiters = readyWaiters.filter((w) => w !== waiter)
      reject(new Error('Spotify player did not become ready — try reconnecting Spotify.'))
    }, PLAYER_READY_TIMEOUT_MS)
    readyWaiters.push(waiter)
  })
}

/**
 * A fatal SDK error tears the player down (so the next attempt rebuilds it
 * instead of reusing a corpse) and rejects anyone waiting on the device id.
 * Events from an instance we already discarded are ignored, or a straggler
 * would null the replacement that took its place.
 */
function failPlayer(instance: any, label: string, message?: string) {
  if (player !== instance) return
  console.error(`Spotify ${label}:`, message)
  player = null
  deviceId = null
  transferredDeviceId = null
  settleReady(new Error(`Spotify ${label}${message ? `: ${message}` : ''}`))
}

/** Named so it can actually be removed again — see disconnectSpotifyPlayer. */
function handlePlayerStateChanged(state: SpotifyPlaybackState | null) {
  if (stateListener) stateListener(state as SpotifyPlaybackState)
}

export function setSpotifyStateListener(cb: (s: SpotifyPlaybackState | null) => void) {
  stateListener = cb
}

/**
 * How long a requested track may stay "pending" before we stop treating SDK
 * events for other tracks as stale. Without an expiry, a play request the SDK
 * never confirms (failed transfer, another device taking over, a dropped
 * event) would leave the guard set forever and silently swallow every later
 * state update — freezing transport, progress and lyrics for the session.
 */
const PENDING_TRACK_TIMEOUT_MS = 6000

let pendingTrackTimer = 0

/** Track id we most recently requested to play (used to ignore stale SDK events). */
export function setPendingTrackId(id: string | null) {
  pendingTrackId = id
  if (pendingTrackTimer) {
    window.clearTimeout(pendingTrackTimer)
    pendingTrackTimer = 0
  }
  if (id !== null) {
    pendingTrackTimer = window.setTimeout(() => {
      pendingTrackId = null
      pendingTrackTimer = 0
    }, PENDING_TRACK_TIMEOUT_MS)
  }
}

export function getPendingTrackId(): string | null {
  return pendingTrackId
}

function loadSDK(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Spotify) return resolve()
    if (document.getElementById('spotify-player-sdk')) {
      window.onSpotifyWebPlaybackSDKReady = () => resolve()
      return
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve()
    const script = document.createElement('script')
    script.id = 'spotify-player-sdk'
    script.src = 'https://sdk.scdn.co/spotify-player.js'
    script.async = true
    script.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'))
    document.head.appendChild(script)
  })
}

/**
 * Creates/connects the Web Playback SDK player and resolves with its device id.
 * Safe to call repeatedly; only initializes once.
 */
export async function ensureSpotifyPlayer(): Promise<string> {
  await loadSDK()

  if (player) {
    if (deviceId) return deviceId
    return waitForReady()
  }

  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated with Spotify')

  player = new window.Spotify.Player({
    name: 'wavi.lol',
    getOAuthToken: async (cb: (t: string) => void) => {
      const t = await getAccessToken()
      cb(t ?? '')
    },
    // Whatever the slider is on now, not 1.0: App's sync effect runs at mount,
    // long before this player exists, so it cannot be relied on to fix this up.
    volume: desiredVolume,
  })

  // The listeners below outlive nothing: `player` can be replaced under them.
  const instance = player
  instance.addListener('initialization_error', ({ message }: any) =>
    failPlayer(instance, 'initialization error', message))
  instance.addListener('authentication_error', ({ message }: any) =>
    failPlayer(instance, 'authentication error', message))
  instance.addListener('account_error', ({ message }: any) =>
    failPlayer(instance, 'account error', message))

  instance.addListener('ready', ({ device_id }: { device_id: string }) => {
    if (player !== instance) return
    deviceId = device_id
    settleReady()
    // Re-assert it now the device is connected: `ready` is the first point where
    // setVolume is meaningful, and it covers a volume set after construction but
    // before the SDK finished connecting. Deliberately not awaited — nothing
    // downstream should wait on the volume for the device to count as ready.
    instance.setVolume(desiredVolume).catch(() => {})
  })
  instance.addListener('not_ready', ({ device_id }: { device_id: string }) => {
    console.warn('Spotify device went offline:', device_id)
  })
  instance.addListener('player_state_changed', handlePlayerStateChanged)

  await instance.connect()

  if (!deviceId) return waitForReady()
  return deviceId!
}

export function getSpotifyDeviceId(): string | null {
  return deviceId
}

async function ensurePlaybackDevice(): Promise<void> {
  const id = await ensureSpotifyPlayer()
  await transferPlaybackToDevice(id)
}

export async function disconnectSpotifyPlayer() {
  if (player) {
    // The SDK matches on the callback, so the event name alone detaches
    // nothing — pass the same function that was registered above.
    player.removeListener?.('player_state_changed', handlePlayerStateChanged)
    await player.disconnect?.()
    player = null
    deviceId = null
    transferredDeviceId = null
    setPendingTrackId(null)
    settleReady(new Error('Spotify player disconnected'))
  }
}

let transferredDeviceId: string | null = null

/** Make the SDK device the active playback device (once per device). */
export async function transferPlaybackToDevice(deviceId: string): Promise<void> {
  if (transferredDeviceId === deviceId) return
  await spotifyApi<void>('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  })
  transferredDeviceId = deviceId
  // Spotify can acknowledge the transfer before the device accepts commands.
  await new Promise((resolve) => setTimeout(resolve, 350))
}

/** Start playing a playlist/album/artist by its context URI. */
export async function playContext(contextUri: string, deviceId = getSpotifyDeviceId()): Promise<void> {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  await spotifyApi<void>(`/me/player/play${suffix}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context_uri: contextUri }),
  })
}

/**
 * How long a selection waits before it is sent, so a burst of clicks becomes one
 * request instead of one per click.
 */
const PLAY_SETTLE_MS = 180

interface PlayIntent {
  uris: string[]
  offset: number
  deviceId: string | null
}

let pendingPlay: PlayIntent | null = null
let pendingPlayTimer: number | null = null
let playWaiters: { resolve: () => void; reject: (err: unknown) => void }[] = []

/**
 * Play a specific list of track URIs starting at `offset`.
 *
 * Selections are coalesced, newest wins. Every click used to fire its own PUT
 * /me/player/play, and Spotify gives no ordering guarantee across independent
 * requests — so clicking 2,3,4,5 could be applied back-to-front and settle on 2,
 * the track clicked first, while the UI showed 5. The burst also hammered the
 * API hard enough to trip rate limiting.
 *
 * Only the newest intent is sent: older ones are replaced rather than queued
 * behind it. Coalescing is safe because each selection is absolute (a list plus
 * an offset, recomputed from state that already moved optimistically), so the
 * newest request carries everything the earlier ones were asking for.
 *
 * Waiters settle together: a superseded caller is told what became of the
 * request that replaced it. Rejecting it would raise an error banner for a
 * selection the user has already moved past.
 */
export function playTracks(uris: string[], offset = 0, deviceId = getSpotifyDeviceId()): Promise<void> {
  pendingPlay = { uris, offset, deviceId }
  // Marked pending immediately rather than when the request goes out: the guard
  // that ignores stale SDK events has to cover the settle window too, or an
  // event for the track we are leaving would land while the click is still queued.
  setPendingTrackId(uris[offset]?.split(':').pop() ?? null)
  const settled = new Promise<void>((resolve, reject) => playWaiters.push({ resolve, reject }))
  if (pendingPlayTimer !== null) window.clearTimeout(pendingPlayTimer)
  pendingPlayTimer = window.setTimeout(() => void flushPlay(), PLAY_SETTLE_MS)
  return settled
}

async function flushPlay(): Promise<void> {
  const intent = pendingPlay
  const waiters = playWaiters
  pendingPlay = null
  pendingPlayTimer = null
  playWaiters = []
  if (!intent) return

  const suffix = intent.deviceId ? `?device_id=${encodeURIComponent(intent.deviceId)}` : ''
  try {
    await spotifyApi<void>(`/me/player/play${suffix}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: intent.uris, offset: { position: intent.offset } }),
    })
    for (const waiter of waiters) waiter.resolve()
  } catch (err) {
    setPendingTrackId(null)
    for (const waiter of waiters) waiter.reject(err)
  }
}

export function pauseSpotify(): Promise<void> {
  return ensurePlaybackDevice().then(() => spotifyApi<void>('/me/player/pause', { method: 'PUT' }))
}

export async function resumeSpotify(): Promise<void> {
  await ensureSpotifyPlayer()
  if (player?.resume) {
    await player.resume()
    return
  }
  await ensurePlaybackDevice()
  await spotifyApi<void>('/me/player/play', { method: 'PUT' })
}

export async function nextSpotify(): Promise<void> {
  setPendingTrackId(null)
  await ensureSpotifyPlayer()
  await player.nextTrack()
}

export async function previousSpotify(): Promise<void> {
  setPendingTrackId(null)
  await ensureSpotifyPlayer()
  await player.previousTrack()
}

export function seekSpotify(positionMs: number): Promise<void> {
  return spotifyApi<void>(`/me/player/seek?position_ms=${Math.max(0, Math.floor(positionMs))}`, {
    method: 'PUT',
  })
}

export async function setSpotifyVolume(volume: number): Promise<void> {
  desiredVolume = Math.max(0, Math.min(1, volume))
  if (player) {
    await player.setVolume(desiredVolume)
  }
}

/** Our session's repeat mode, in Spotify's naming. */
export function spotifyRepeatState(mode: 'off' | 'all' | 'one'): 'off' | 'context' | 'track' {
  return mode === 'all' ? 'context' : mode === 'one' ? 'track' : 'off'
}

/**
 * Shuffle and repeat are player state, not app state: without a device_id they
 * land on whichever device is currently active, and Spotify does not guarantee
 * the order in which they run relative to other player endpoints. Always aim
 * them at the device we just transferred playback to.
 */
function deviceParam(deviceId: string | null): string {
  return deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''
}

/** Mirror repeat onto Spotify itself so natural track ends obey it. */
export function setSpotifyRepeat(
  mode: 'off' | 'track' | 'context',
  deviceId: string | null = getSpotifyDeviceId(),
): Promise<void> {
  return spotifyApi<void>(`/me/player/repeat?state=${mode}${deviceParam(deviceId)}`, { method: 'PUT' })
}

/** Mirror shuffle onto Spotify itself so natural ends follow the shuffled queue. */
export function setSpotifyShuffle(
  on: boolean,
  deviceId: string | null = getSpotifyDeviceId(),
): Promise<void> {
  return spotifyApi<void>(`/me/player/shuffle?state=${on}${deviceParam(deviceId)}`, { method: 'PUT' })
}

