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
      <div className="spotify-user spotify-auth-bar">
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
        <button className="spotify-disconnect" onClick={logout} title="Disconnect Spotify account">
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <button
      className="xp-btn primary spotify-connect-btn"
      onClick={() => { startSpotifyAuth().catch(console.error) }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.7.7 0 0 1-.96.23c-2.63-1.6-5.94-1.97-9.84-1.08a.7.7 0 1 1-.32-1.36c4.23-.97 7.9-.55 10.9 1.25.33.2.43.63.22.96zm1.23-2.75a.88.88 0 0 1-1.2.29c-3.01-1.84-7.6-2.37-11.16-1.3a.88.88 0 1 1-.51-1.68c4.06-1.23 9.14-.64 12.6 1.49.4.25.53.79.27 1.2zm.11-2.87C14.3 8.6 8.5 8.36 5.14 9.37a1.05 1.05 0 1 1-.61-2.01c3.87-1.17 10.28-.9 14.33 1.53a1.05 1.05 0 0 1-1.07 1.82z" />
      </svg>
      Connect Spotify
    </button>
  )
}
