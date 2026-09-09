// App-side playback queue: deterministic next/prev over the loaded track
// list, with optimistic UI. The SDK echo confirms via the stale-event guard
// in App (pendingTrackId), so the player bar updates instantly.
import { ensureSpotifyPlayer, playTracks, setPendingTrackId, transferPlaybackToDevice } from './spotifyPlayer'
import { useStore } from './store'

async function advance(dir: 1 | -1): Promise<void> {
  const s = useStore.getState()
  const list = s.spotifyTracks
  if (list.length === 0) throw new Error('No tracks loaded — pick a playlist first.')
  const base = s.spotifyIndex < 0 ? (dir > 0 ? -1 : 0) : s.spotifyIndex
  const next = (base + dir + list.length) % list.length
  const track = list[next]
  s.setSpotifyIndex(next)
  s.setSpotifyCurrentTrack(track)
  s.setTrackName(track.name)
  s.setSpotifyPlaying(true)
  setPendingTrackId(track.id)
  try {
    const deviceId = await ensureSpotifyPlayer()
    await transferPlaybackToDevice(deviceId)
    await playTracks(list.map((t) => t.uri), next, deviceId)
  } catch (err) {
    setPendingTrackId(null)
    throw err
  }
}

export const queueNext = () => advance(1)
export const queuePrev = () => advance(-1)
