// App-side playback queue: deterministic next/prev over the loaded track
// list, with optimistic UI. The SDK echo confirms via the stale-event guard
// in App (pendingTrackId), so the player bar updates instantly.
//
// Shuffle and repeat are owned by Spotify, not by this queue: they are player
// state that governs natural track ends, and the SDK does not report them
// back. So we push them onto the device (see applySpotifyTransportModes) and,
// while shuffle is on, let Spotify pick the track — re-sending our list here
// would rebuild the queue in list order and re-shuffle it, leaving the store
// index pointing at a track that isn't the one playing.
import {
  ensureSpotifyPlayer,
  getSpotifyDeviceId,
  nextSpotify,
  playTracks,
  previousSpotify,
  setPendingTrackId,
  setSpotifyRepeat,
  setSpotifyShuffle,
  spotifyRepeatState,
  transferPlaybackToDevice,
} from './spotifyPlayer'
import { nextQueueStep } from './queueIndex'
import { useStore } from './store'

/**
 * Mirror the session's repeat/shuffle flags onto Spotify. They are player
 * state, so they have to be re-sent whenever our device becomes the playback
 * target — a mode toggled before playback started is otherwise simply absent
 * on the device that ends up playing, and natural track ends ignore it.
 * Best-effort: a failed mode must never abort playback.
 */
export function applySpotifyTransportModes(deviceId: string | null = getSpotifyDeviceId()): void {
  const s = useStore.getState()
  const report = (err: unknown) => {
    useStore.getState().setSpotifyError(err instanceof Error ? err.message : String(err))
  }
  setSpotifyRepeat(spotifyRepeatState(s.repeatMode), deviceId).catch(report)
  setSpotifyShuffle(s.shuffle, deviceId).catch(report)
}

async function advance(dir: 1 | -1): Promise<void> {
  const s = useStore.getState()
  const list = s.spotifyTracks
  if (list.length === 0) throw new Error('No tracks loaded — pick a playlist first.')

  // Shuffle is on and our list is the queue that's playing: skip inside the
  // queue Spotify already shuffled so audio and UI stay in step.
  if (s.shuffle && list.length > 1 && s.spotifyIndex >= 0) {
    await (dir > 0 ? nextSpotify() : previousSpotify())
    return
  }

  const step = nextQueueStep({ index: s.spotifyIndex, length: list.length, dir, shuffle: s.shuffle })
  if (step.kind !== 'play') return // unreachable: the list is non-empty here
  const next = step.index
  const track = list[next]
  s.setSpotifyIndex(next)
  s.setSpotifyCurrentTrack(track)
  s.setTrackName(track.name)
  s.setSpotifyPlaying(true)
  setPendingTrackId(track.id)
  try {
    const deviceId = await ensureSpotifyPlayer()
    await transferPlaybackToDevice(deviceId)
    // This branch picked the track itself, so build the queue with shuffle
    // pinned off — with it on, Spotify shuffles the fresh queue and plays some
    // other track than the one we just showed (and the pending-track guard
    // would then hide that mismatch). Both modes are re-applied afterwards.
    if (s.shuffle) await setSpotifyShuffle(false, deviceId)
    await playTracks(list.map((t) => t.uri), next, deviceId)
    applySpotifyTransportModes(deviceId)
  } catch (err) {
    setPendingTrackId(null)
    throw err
  }
}

export const queueNext = () => advance(1)
export const queuePrev = () => advance(-1)
