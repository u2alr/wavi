import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { getPlaylistTracks, getPlaylistTracksPage, getUserPlaylists, searchSpotifyTracks, SpotifyApiError } from '../spotify'

/** Smallest album-art thumbnail (Spotify returns images largest-first). */
function artFor(track: { album?: { images?: { url: string }[] } }): string | null {
  const imgs = track.album?.images
  return imgs && imgs.length > 0 ? imgs[imgs.length - 1].url : null
}
import {
  ensureSpotifyPlayer,
  playTracks,
  setPendingTrackId,
  transferPlaybackToDevice,
} from '../spotifyPlayer'
import PanelSelect from './PanelSelect'
export default function SpotifyPanel() {
  const isSpotifyAuthed = useStore((s) => s.isSpotifyAuthed)
  const playlists = useStore((s) => s.spotifyPlaylists)
  const tracks = useStore((s) => s.spotifyTracks)
  const index = useStore((s) => s.spotifyIndex)
  const playing = useStore((s) => s.spotifyPlaying)
  const currentTrackId = useStore((s) => s.spotifyCurrentTrack?.id ?? null)

  const setPlaylists = useStore((s) => s.setSpotifyPlaylists)
  const setTracks = useStore((s) => s.setSpotifyTracks)
  const setIndex = useStore((s) => s.setSpotifyIndex)
  const setPlaying = useStore((s) => s.setSpotifyPlaying)
  const setCurrentTrack = useStore((s) => s.setSpotifyCurrentTrack)
  const setTrackName = useStore((s) => s.setTrackName)
  const appendTracks = useStore((s) => s.appendSpotifyTracks)
  const storeError = useStore((s) => s.spotifyError)
  const setStoreError = useStore((s) => s.setSpotifyError)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [playlistTotal, setPlaylistTotal] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<typeof tracks>([])
  const [pendingTrackId, setPendingTrack] = useState<string | null>(null)
  /** Re-runnable copy of the last failed action, for the banner's Retry button. */
  const retryRef = useRef<(() => void) | null>(null)

  const saveLastTrack = (track: { uri: string; name: string }, playlistId = selectedPlaylistId) => {
    localStorage.setItem('viz-last-spotify-track', JSON.stringify({
      uri: track.uri, name: track.name, playlistId,
    }))
  }

  const fail = (err: unknown, retry?: () => void) => {
    const msg = err instanceof Error ? err.message : String(err)
    setError(msg)
    retryRef.current = retry ?? null
    console.error(msg)
  }

  const clearError = useCallback(() => {
    setError('')
    setStoreError(null)
    retryRef.current = null
  }, [setStoreError])

  const loadPlaylists = useCallback(async () => {
    setLoading(true)
    clearError()
    try {
      setPlaylists(await getUserPlaylists())
    } catch (err) {
      fail(err, () => loadPlaylists().catch(() => {}))
    } finally {
      setLoading(false)
    }
  }, [setPlaylists, clearError])

  useEffect(() => {
    if (isSpotifyAuthed && playlists.length === 0) {
      loadPlaylists().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpotifyAuthed])

  const playPlaylist = async (id: string) => {
    setLoading(true)
    clearError()
    try {
      const { tracks: list, total } = await getPlaylistTracks(id)
      setSelectedPlaylistId(id)
      setPlaylistTotal(total)
      setTracks(list)
      setIndex(0)
      // Do NOT auto-play or set the current track — just load the tracks so
      // the user can pick one. This avoids interrupting whatever is currently
      // playing and prevents lyrics from showing for a song that isn't playing.
    } catch (err) {
      fail(err, () => playPlaylist(id).catch(() => {}))
    } finally {
      setLoading(false)
    }
  }

  const playTrack = async (i: number) => {
    const list = useStore.getState().spotifyTracks
    if (i < 0 || i >= list.length) return
    clearError()
    setPendingTrack(list[i].id)
    try {
      setIndex(i)
      setCurrentTrack(list[i])
      setTrackName(list[i].name)
      setPlaying(true)
      saveLastTrack(list[i])
      // Guard against stale SDK events immediately, before any async work.
      setPendingTrackId(list[i].id)

      const deviceId = await ensureSpotifyPlayer()
      await transferPlaybackToDevice(deviceId)
      await playTracks(list.map((t) => t.uri), i, deviceId)
    } catch (err) {
      setPendingTrackId(null)
      fail(err, () => playTrack(i).catch(() => {}))
    } finally {
      setPendingTrack((cur) => (cur === list[i].id ? null : cur))
    }
  }

  const prefetchingRef = useRef(false)

  // Near the end of a truncated (>500) playlist, load the next page ahead
  // so queue advance + metadata stay instant. Appends only — index preserved.
  useEffect(() => {
    if (!selectedPlaylistId || tracks.length === 0 || tracks.length >= playlistTotal) return
    if (index < tracks.length - 5 || prefetchingRef.current) return
    prefetchingRef.current = true
    getPlaylistTracksPage(selectedPlaylistId, tracks.length)
      .then((p) => {
        if (p.tracks.length > 0) appendTracks(p.tracks)
      })
      .catch(() => {})
      .finally(() => {
        prefetchingRef.current = false
      })
  }, [index, tracks, selectedPlaylistId, playlistTotal, appendTracks])

  const runSearch = async (query: string) => {
    setLoading(true)
    clearError()
    try {
      setSearchResults(await searchSpotifyTracks(query))
    } catch (err) {
      // Dev-mode apps can't hit /search at all — fall back to filtering the
      // already-loaded playlist tracks so the box stays useful.
      if (err instanceof SpotifyApiError && err.reason === 'CATALOG_BLOCKED') {
        const q = query.toLowerCase()
        const local = tracks.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.artists.some((a) => a.name.toLowerCase().includes(q)),
        )
        setSearchResults(local)
      }
      fail(err, () => runSearch(query).catch(() => {}))
    } finally {
      setLoading(false)
    }
  }

  const clearSearch = () => {
    setSearchQuery('')
    setSearchResults([])
  }

  const searchTracks = (event: React.FormEvent) => {
    event.preventDefault()
    const query = searchQuery.trim()
    if (!query) return
    runSearch(query).catch(() => {})
  }

  const playSearchResult = async (track: typeof tracks[number]) => {
    clearError()
    setPendingTrack(track.id)
    try {
      // The queue is now this single track, not the playlist — clear the
      // selection so the dropdown stops claiming a playlist it isn't showing.
      setSelectedPlaylistId('')
      setTracks([track])
      setCurrentTrack(track)
      setTrackName(track.name)
      setIndex(0)
      setPlaying(true)
      setPendingTrackId(track.id)
      const deviceId = await ensureSpotifyPlayer()
      await transferPlaybackToDevice(deviceId)
      await playTracks([track.uri], 0, deviceId)
    } catch (err) {
      setPendingTrackId(null)
      fail(err, () => playSearchResult(track).catch(() => {}))
    } finally {
      setPendingTrack((cur) => (cur === track.id ? null : cur))
    }
  }

  if (!isSpotifyAuthed) return null

  const showEmptyState = tracks.length === 0 && searchResults.length === 0
  // Labels only when both lists are visible — that's when they blur together.
  const showLabels = searchResults.length > 0 && tracks.length > 0
  const playlistLabel = selectedPlaylistId
    ? (playlists.find((p) => p.id === selectedPlaylistId)?.name ?? 'Playlist tracks')
    : 'Now playing'

  return (
    <div className="spotify-panel">
      {(error || storeError) && (
        <div className="spotify-error-banner" role="alert">
          <span className="spotify-error-text">{error || storeError}</span>
          <div className="spotify-error-actions">
            {retryRef.current && (
              <button
                className="spotify-error-retry"
                onClick={() => {
                  const retry = retryRef.current
                  retryRef.current = null
                  clearError()
                  retry?.()
                }}
              >
                Retry
              </button>
            )}
            <button
              className="spotify-error-dismiss"
              onClick={clearError}
              aria-label="Dismiss error"
              title="Dismiss"
            >
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="field-wrap">
        <div className="spotify-playlist-row">
        <PanelSelect
          id="spotify-playlist-select"
          value={selectedPlaylistId}
          options={playlists.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v) => {
            if (v) playPlaylist(v)
          }}
          placeholder={loading ? 'Loading playlists...' : 'Choose playlist...'}
          ariaLabel="Choose a Spotify playlist"
          disabled={loading && playlists.length === 0}
          searchable
          searchPlaceholder="Search playlists..."
        />
        {loading ? (
          <span className="loading-indicator" aria-label="Loading" />
        ) : (
          <button
            className="xp-btn spotify-reload-btn"
            onClick={loadPlaylists}
            title="Reload your playlists from Spotify"
            aria-label="Reload playlists"
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        )}
        </div>
      </div>

      <form className="spotify-search" onSubmit={searchTracks}>
        <span className="spotify-search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
        </span>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search all of Spotify..."
          aria-label="Search all of Spotify for songs or artists"
        />
        {searchResults.length > 0 && (
          <button
            type="button"
            className="search-clear"
            onClick={clearSearch}
            aria-label="Clear search results"
            title="Clear search"
          >
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        )}
      </form>

      {searchResults.length > 0 && (
        <>
          {showLabels && <div className="spotify-list-label">Search results</div>}
          <div className="spotify-track-list spotify-search-results" aria-label="Search results">
          {searchResults.map((track) => {
            const art = artFor(track)
            const isActive = track.id === currentTrackId
            return (
              <button
                key={track.id}
                type="button"
                className={`spotify-track${isActive ? ' active' : ''}${pendingTrackId === track.id ? ' is-pending' : ''}`}
                onClick={() => playSearchResult(track)}
                aria-label={`Play ${track.name}`}
                aria-current={isActive || undefined}
              >
                {art ? (
                  <img src={art} alt="" className="spotify-track-art" loading="lazy" />
                ) : (
                  <span className="spotify-track-index">
                    <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor">
                      <polygon points="6 4 20 12 6 20 6 4" />
                    </svg>
                  </span>
                )}
                <div className="spotify-track-meta">
                  <div className="spotify-track-title">{track.name}</div>
                  <div className="spotify-track-artist">{track.artists.map((artist) => artist.name).join(', ')}</div>
                </div>
                {isActive && playing && (
                  <span className="spotify-eq" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
              </button>
            )
          })}
          </div>
        </>
      )}

      {showEmptyState ? (
        <div className="spotify-empty">
          <div className="spotify-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l10-2v13" />
              <circle cx="6.5" cy="18" r="2.5" />
              <circle cx="16.5" cy="16" r="2.5" />
            </svg>
          </div>
          <div className="spotify-empty-text">Pick a playlist or search to queue songs.</div>
          <div className="spotify-empty-hint">Results appear here instantly.</div>
        </div>
      ) : (
        tracks.length > 0 && (
          <>
            {showLabels && <div className="spotify-list-label">{playlistLabel}</div>}
            <div className="spotify-track-list" aria-busy={loading}>
            {tracks.map((t, i) => {
              const isActive = i === index
              const art = artFor(t)
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`spotify-track${isActive ? ' active' : ''}${pendingTrackId === t.id ? ' is-pending' : ''}`}
                  onClick={() => playTrack(i)}
                  aria-label={`Play ${t.name}`}
                  aria-current={isActive || undefined}
                >
                  <span className="spotify-track-index">{i + 1}</span>
                  {art && <img src={art} alt="" className="spotify-track-art" loading="lazy" />}
                  <div className="spotify-track-meta">
                    <div className="spotify-track-title">{t.name}</div>
                    <div className="spotify-track-artist">
                      {t.artists.map((a) => a.name).join(', ')}
                    </div>
                  </div>
                  {isActive && playing && (
                    <span className="spotify-eq" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </button>
              )
            })}
            </div>
          </>
        )
      )}
    </div>
  )
}
