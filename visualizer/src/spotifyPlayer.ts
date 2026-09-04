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
let readyResolvers: Array<() => void> = []
let stateListener: ((s: SpotifyPlaybackState) => void) | null = null
let pendingTrackId: string | null = null

export function setSpotifyStateListener(cb: (s: SpotifyPlaybackState) => void) {
  stateListener = cb
}

/** Track id we most recently requested to play (used to ignore stale SDK events). */
export function setPendingTrackId(id: string | null) {
  pendingTrackId = id
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
    await new Promise<void>((resolve) => readyResolvers.push(resolve))
    return deviceId!
  }

  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated with Spotify')

  player = new window.Spotify.Player({
    name: 'Visualizer.exe',
    getOAuthToken: async (cb: (t: string) => void) => {
      const t = await getAccessToken()
      cb(t ?? '')
    },
    // We will initialize with 1.0; wait for App to sync it immediately via setSpotifyVolume.
    volume: 1.0,
  })

  player.addListener('initialization_error', ({ message }: any) =>
    console.error('Spotify initialization error:', message))
  player.addListener('authentication_error', ({ message }: any) =>
    console.error('Spotify authentication error:', message))
  player.addListener('account_error', ({ message }: any) =>
    console.error('Spotify account error:', message))

  player.addListener('ready', ({ device_id }: { device_id: string }) => {
    deviceId = device_id
    readyResolvers.splice(0).forEach((r) => r())
  })
  player.addListener('not_ready', ({ device_id }: { device_id: string }) => {
    console.warn('Spotify device went offline:', device_id)
  })
  player.addListener('player_state_changed', (state: SpotifyPlaybackState | null) => {
    if (state && stateListener) stateListener(state)
  })

  await player.connect()

  if (!deviceId) {
    await new Promise<void>((resolve) => readyResolvers.push(resolve))
  }
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
    player.removeListener?.('player_state_changed')
    await player.disconnect?.()
    player = null
    deviceId = null
  }
}

/** Make the SDK device the active playback device. */
export async function transferPlaybackToDevice(deviceId: string): Promise<void> {
  await spotifyApi<void>('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  })
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

/** Play a specific list of track URIs starting at `offset`. */
export async function playTracks(uris: string[], offset = 0, deviceId = getSpotifyDeviceId()): Promise<void> {
  pendingTrackId = uris[offset]?.split(':').pop() ?? null
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  try {
    await spotifyApi<void>(`/me/player/play${suffix}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris, offset: { position: offset } }),
    })
  } catch (err) {
    pendingTrackId = null
    throw err
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
  pendingTrackId = null
  await ensureSpotifyPlayer()
  await player.nextTrack()
}

export async function previousSpotify(): Promise<void> {
  pendingTrackId = null
  await ensureSpotifyPlayer()
  await player.previousTrack()
}

export function seekSpotify(positionMs: number): Promise<void> {
  return spotifyApi<void>(`/me/player/seek?position_ms=${Math.max(0, Math.floor(positionMs))}`, {
    method: 'PUT',
  })
}

export async function setSpotifyVolume(volume: number): Promise<void> {
  if (player) {
    await player.setVolume(Math.max(0, Math.min(1, volume)))
  }
}

