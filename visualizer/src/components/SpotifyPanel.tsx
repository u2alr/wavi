import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { getPlaylistTracks, getUserPlaylists, searchSpotifyTracks } from '../spotify'
import {
  ensureSpotifyPlayer,
  nextSpotify,
  pauseSpotify,
  playTracks,
  previousSpotify,
  resumeSpotify,
  setPendingTrackId,
  transferPlaybackToDevice,
} from '../spotifyPlayer'
import { setAmbientMode } from '../audio'

export default function SpotifyPanel() {
  const isSpotifyAuthed = useStore((s) => s.isSpotifyAuthed)
  const playlists = useStore((s) => s.spotifyPlaylists)
  const tracks = useStore((s) => s.spotifyTracks)
  const index = useStore((s) => s.spotifyIndex)
  const playing = useStore((s) => s.spotifyPlaying)

  const setPlaylists = useStore((s) => s.setSpotifyPlaylists)
  const setTracks = useStore((s) => s.setSpotifyTracks)
  const setIndex = useStore((s) => s.setSpotifyIndex)
  const setPlaying = useStore((s) => s.setSpotifyPlaying)
  const setCurrentTrack = useStore((s) => s.setSpotifyCurrentTrack)
  const setTrackName = useStore((s) => s.setTrackName)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<typeof tracks>([])

  const saveLastTrack = (track: { uri: string; name: string }, playlistId = selectedPlaylistId) => {
    localStorage.setItem('viz-last-spotify-track', JSON.stringify({
      uri: track.uri, name: track.name, playlistId,
    }))
  }

  const loadLastTrack = () => {
    try {
      return JSON.parse(localStorage.getItem('viz-last-spotify-track') || 'null') as {
        uri: string
        name: string
      } | null
    } catch {
      return null
    }
  }

  const fail = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    setError(msg)
    console.error(msg)
  }

  const loadPlaylists = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setPlaylists(await getUserPlaylists())
    } catch (err) {
      fail(err)
    } finally {
      setLoading(false)
    }
  }, [setPlaylists])

  useEffect(() => {
    if (isSpotifyAuthed && playlists.length === 0) {
      loadPlaylists().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpotifyAuthed])

  const playPlaylist = async (id: string) => {
    setLoading(true)
    setError('')
    try {
      const list = await getPlaylistTracks(id)
      setSelectedPlaylistId(id)
      setTracks(list)
      setIndex(0)
      setAmbientMode(true)
      // Do NOT auto-play or set the current track — just load the tracks so
      // the user can pick one. This avoids interrupting whatever is currently
      // playing and prevents lyrics from showing for a song that isn't playing.
    } catch (err) {
      fail(err)
    } finally {
      setLoading(false)
    }
  }

  const playTrack = async (i: number) => {
    const list = useStore.getState().spotifyTracks
    if (i < 0 || i >= list.length) return
    setError('')
    try {
      setIndex(i)
      setCurrentTrack(list[i])
      setTrackName(list[i].name)
      setPlaying(true)
      setAmbientMode(true)
      saveLastTrack(list[i])
      // Guard against stale SDK events immediately, before any async work.
      setPendingTrackId(list[i].id)

      const deviceId = await ensureSpotifyPlayer()
      await transferPlaybackToDevice(deviceId)
      await playTracks(list.map((t) => t.uri), i, deviceId)
    } catch (err) {
      setPendingTrackId(null)
      fail(err)
    }
  }

  const togglePlay = async () => {
    try {
      if (playing) {
        await pauseSpotify()
        setPlaying(false)
      } else {
        const saved = loadLastTrack()
        const deviceId = await ensureSpotifyPlayer()
        await transferPlaybackToDevice(deviceId)
        if (saved && tracks.length === 0) {
          await playTracks([saved.uri], 0, deviceId)
          setCurrentTrack({
            id: saved.uri.split(':').pop() || saved.uri,
            name: saved.name,
            uri: saved.uri,
            duration_ms: 0,
            album: { id: '', name: '', images: [] },
            artists: [],
          })
        } else {
          await resumeSpotify()
        }
        setPlaying(true)
      }
    } catch (err) {
      fail(err)
    }
  }

  const searchTracks = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!searchQuery.trim()) return
    setLoading(true)
    setError('')
    try {
      setSearchResults(await searchSpotifyTracks(searchQuery.trim()))
    } catch (err) {
      fail(err)
    } finally {
      setLoading(false)
    }
  }

  const playSearchResult = async (track: typeof tracks[number]) => {
    setError('')
    try {
      setTracks([track])
      setCurrentTrack(track)
      setTrackName(track.name)
      setIndex(0)
      setPlaying(true)
      setAmbientMode(true)
      setPendingTrackId(track.id)
      const deviceId = await ensureSpotifyPlayer()
      await transferPlaybackToDevice(deviceId)
      await playTracks([track.uri], 0, deviceId)
    } catch (err) {
      setPendingTrackId(null)
      fail(err)
    }
  }

  if (!isSpotifyAuthed) return null

  return (
    <div className="spotify-panel">
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        <select
          value={selectedPlaylistId}
          onChange={(e) => {
            if (e.target.value) playPlaylist(e.target.value)
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">Choose playlist…</option>
          {playlists.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button className="xp-btn" onClick={loadPlaylists} disabled={loading} title="Refresh Playlists">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      <form className="spotify-search" onSubmit={searchTracks}>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search songs or artists"
          aria-label="Search Spotify songs or artists"
        />
        <button className="xp-btn" type="submit" disabled={loading}>Search</button>
      </form>

      {searchResults.length > 0 && (
        <div className="spotify-track-list spotify-search-results">
          {searchResults.map((track) => (
            <div key={track.id} className="spotify-track" onClick={() => playSearchResult(track)}>
              <span className="spotify-track-index">
                <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor">
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              </span>
              <div className="spotify-track-meta">
                <div className="spotify-track-title">{track.name}</div>
                <div className="spotify-track-artist">{track.artists.map((artist) => artist.name).join(', ')}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="spotify-controls">
        <button className="xp-btn" onClick={() => previousSpotify().catch(fail)} title="Previous">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
            <polygon points="19 20 9 12 19 4 19 20" />
            <rect x="5" y="4" width="2.5" height="16" />
          </svg>
        </button>
        <button className="xp-btn" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
          {playing ? (
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
              <rect x="5" y="4" width="4" height="16" />
              <rect x="15" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          )}
        </button>
        <button className="xp-btn" onClick={() => nextSpotify().catch(fail)} title="Next">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
            <polygon points="5 4 15 12 5 20 5 4" />
            <rect x="16.5" y="4" width="2.5" height="16" />
          </svg>
        </button>
      </div>
      {error && <div className="spotify-error">{error}</div>}

      {tracks.length > 0 && (
        <div className="spotify-track-list">
          {tracks.map((t, i) => (
            <div
              key={t.id}
              className={`spotify-track ${i === index ? 'active' : ''}`}
              onClick={() => playTrack(i)}
            >
              <span className="spotify-track-index">{i + 1}</span>
              <div className="spotify-track-meta">
                <div className="spotify-track-title">{t.name}</div>
                <div className="spotify-track-artist">
                  {t.artists.map((a) => a.name).join(', ')}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
