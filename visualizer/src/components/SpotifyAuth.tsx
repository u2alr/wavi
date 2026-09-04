import { useStore } from '../store'
import { clearTokens, startSpotifyAuth } from '../spotify'

export default function SpotifyAuth() {
  const isSpotifyAuthed = useStore((s) => s.isSpotifyAuthed)
  const spotifyUser = useStore((s) => s.spotifyUser)
  const setSpotifyAuthed = useStore((s) => s.setSpotifyAuthed)
  const setSpotifyUser = useStore((s) => s.setSpotifyUser)

  const logout = () => {
    clearTokens()
    setSpotifyAuthed(false)
    setSpotifyUser(null)
  }

  if (isSpotifyAuthed && spotifyUser) {
    return (
      <div className="spotify-user" style={{ marginBottom: 6 }}>
        {spotifyUser.images?.[0] && (
          <img
            src={spotifyUser.images[0].url}
            alt=""
            className="spotify-avatar"
          />
        )}
        <span className="spotify-name" title={spotifyUser.display_name ?? spotifyUser.id}>
          {spotifyUser.display_name ?? spotifyUser.id}
        </span>
        <button className="xp-btn" onClick={logout}>Disconnect</button>
      </div>
    )
  }

  return (
    <button
      className="xp-btn"
      style={{ width: '100%', marginBottom: 6, fontWeight: 'bold', color: '#1DB954' }}
      onClick={() => { startSpotifyAuth().catch(console.error) }}
    >
      Connect Spotify
    </button>
  )
}
