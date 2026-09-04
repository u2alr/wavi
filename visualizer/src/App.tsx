import { useRef, useEffect, useCallback, useState } from 'react'
import Scene from './components/Scene'
import NowPlaying from './components/NowPlaying'
import ControlPanel from './components/ControlPanel'
import AboutModal from './components/AboutModal'
import { useStore } from './store'
import {
  clearExtensionAudioData,
  getAudioBands,
  getAudioElement,
  getAudioSourceMode,
  initAudio,
  initAudioFromStream,
  setAmbientMode,
  setAudioVolume,
  setExtensionAudioData,
  setSpotifyPlaybackState,
} from './audio'
import {
  getPendingTrackId,
  nextSpotify,
  pauseSpotify,
  previousSpotify,
  resumeSpotify,
  setPendingTrackId,
  setSpotifyStateListener,
  setSpotifyVolume,
} from './spotifyPlayer'
import { exchangeCodeForToken, getSpotifyUser, loadTokens } from './spotify'
import BratLyrics from './components/BratLyrics'
import StatusBar from './components/StatusBar'

const PRESET_TYPES = ['mellowDrift', 'prismaticGarden', 'auroraSilk', 'brat']

export default function App() {
  const fileRef = useRef<HTMLInputElement>(null)

  // Granular Zustand subscriptions
  const playlist = useStore((s) => s.playlist)
  const currentTrackIndex = useStore((s) => s.currentTrackIndex)
  const isFullscreen = useStore((s) => s.isFullscreen)
  const isMiniPlayer = useStore((s) => s.isMiniPlayer)
  const trackName = useStore((s) => s.trackName)
  const volume = useStore((s) => s.volume)
  const currentPreset = useStore((s) => s.currentPreset)
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)

  const setPlaylist = useStore((s) => s.setPlaylist)
  const setCurrentTrackIndex = useStore((s) => s.setCurrentTrackIndex)
  const setTrackName = useStore((s) => s.setTrackName)
  const setIsFullscreen = useStore((s) => s.setIsFullscreen)
  const setIsMiniPlayer = useStore((s) => s.setIsMiniPlayer)
  const setParams = useStore((s) => s.setParams)
  const resetParams = useStore((s) => s.resetParams)
  const setCurrentPreset = useStore((s) => s.setCurrentPreset)
  const setSpotifyAuthed = useStore((s) => s.setSpotifyAuthed)
  const setSpotifyUser = useStore((s) => s.setSpotifyUser)
  const setSpotifyPlaying = useStore((s) => s.setSpotifyPlaying)
  const setPlaybackProgress = useStore((s) => s.setPlaybackProgress)
  const setMetrics = useStore((s) => s.setMetrics)
  const setVolume = useStore((s) => s.setVolume)
  const togglePanelCollapsed = useStore((s) => s.togglePanelCollapsed)
  const setActiveModal = useStore((s) => s.setActiveModal)

  const [showUI, setShowUI] = useState(true)
  const [showStatusBar, setShowStatusBar] = useState(true)
  const [extensionStatus, setExtensionStatus] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [metricVisibility, setMetricVisibility] = useState({
    fps: true,
    source: true,
    bass: true,
    mid: true,
    treble: true,
    level: true,
  })

  // Parse preset from URL hash
  useEffect(() => {
    const hash = window.location.hash
    if (hash.startsWith('#p=')) {
      try {
        const data = JSON.parse(atob(hash.slice(3)))
        if (data.presetType) setCurrentPreset(data.presetType)
        if (data.params) setParams(data.params)
      } catch (e) {
        console.warn('Failed to parse URL preset data', e)
      }
    }
  }, [setCurrentPreset, setParams])

  // Sync volume to audio engine and Spotify
  useEffect(() => {
    setAudioVolume(volume)
    setSpotifyVolume(volume)
  }, [volume])

  // Close dropdown menu when clicking anywhere else
  useEffect(() => {
    const handleClickOutside = () => setOpenMenu(null)
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [])

  // Spotify OAuth
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code')
    if (code) {
      exchangeCodeForToken(code)
        .then(async () => {
          const user = await getSpotifyUser()
          setSpotifyAuthed(true)
          setSpotifyUser(user)
        })
        .catch((err) => {
          console.warn('Spotify auth failed', err)
          setSpotifyAuthed(false)
        })
        .finally(() => {
          window.history.replaceState({}, '', window.location.pathname)
        })
      return
    }

    if (loadTokens()) {
      setSpotifyAuthed(true)
      getSpotifyUser()
        .then(setSpotifyUser)
        .catch(() => setSpotifyAuthed(false))
    }
  }, [setSpotifyAuthed, setSpotifyUser])

  // Spotify SDK State Listener
  useEffect(() => {
    setSpotifyStateListener((state) => {
      const currentId = state.track_window.current_track.id
      const pending = getPendingTrackId()
      if (pending && pending !== currentId) return
      if (pending === currentId) setPendingTrackId(null)

      const store = useStore.getState()
      const isPlaying = !state.paused
      store.setSpotifyPlaying(isPlaying)
      setSpotifyPlaybackState(isPlaying, state.position, state.duration)
      setPlaybackProgress(state.position, state.duration)
      const track = store.spotifyTracks.find((item) => item.id === currentId)
      if (track) {
        store.setSpotifyCurrentTrack(track)
        store.setSpotifyIndex(store.spotifyTracks.indexOf(track))
      }
      store.setTrackName(state.track_window.current_track.name)
    })
  }, [setPlaybackProgress])

  // Browser Audio Extension listener
  useEffect(() => {
    const receiveExtensionAudio = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'visualizer-audio-extension') return
      if (event.data.type === 'audio-data' && Array.isArray(event.data.bins)) {
        if (event.data.signal > 8) {
          setExtensionAudioData(event.data.bins)
          setExtensionStatus('EXT LIVE')
        } else {
          clearExtensionAudioData()
          setExtensionStatus('EXT SILENT')
        }
      }
      if (event.data.type === 'capture-status') {
        setExtensionStatus(event.data.status === 'started' ? 'EXT READY' : 'EXT ERROR')
        if (event.data.message) console.error('Visualizer Audio Bridge:', event.data.message)
      }
    }
    window.addEventListener('message', receiveExtensionAudio)
    return () => window.removeEventListener('message', receiveExtensionAudio)
  }, [])

  // Audio metrics sampling loop
  useEffect(() => {
    let frameId = 0
    let frameCount = 0
    let lastUpdate = performance.now()

    const sample = (time: number) => {
      frameCount += 1
      if (time - lastUpdate >= 250) {
        const fps = (frameCount * 1000) / (time - lastUpdate)
        const bands = getAudioBands()
        setMetrics({ fps, ...bands, sourceMode: getAudioSourceMode() })
        frameCount = 0
        lastUpdate = time
      }
      frameId = requestAnimationFrame(sample)
    }

    frameId = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frameId)
  }, [setMetrics])

  const playTrack = useCallback(
    (index: number) => {
      if (index < 0 || index >= playlist.length) return
      setAmbientMode(false)
      setSpotifyPlaying(false)
      setCurrentTrackIndex(index)
      const file = playlist[index]
      initAudio(file)
      setTrackName(file.name.replace(/\.[^/.]+$/, ''))
    },
    [playlist, setCurrentTrackIndex, setSpotifyPlaying, setTrackName]
  )

  const handleFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length === 0) return
      setAmbientMode(false)
      setSpotifyPlaying(false)
      setPlaylist(files)
      setCurrentTrackIndex(0)
      initAudio(files[0])
      setTrackName(files[0].name.replace(/\.[^/.]+$/, ''))
      if (fileRef.current) fileRef.current.value = ''
    },
    [setPlaylist, setCurrentTrackIndex, setSpotifyPlaying, setTrackName]
  )

  const prev = useCallback(() => {
    if (playlist.length === 0) return
    const nextIdx = (currentTrackIndex - 1 + playlist.length) % playlist.length
    playTrack(nextIdx)
  }, [currentTrackIndex, playlist.length, playTrack])

  const next = useCallback(() => {
    if (playlist.length === 0) return
    const nextIdx = (currentTrackIndex + 1) % playlist.length
    playTrack(nextIdx)
  }, [currentTrackIndex, playlist.length, playTrack])

  const spotifyPrev = useCallback(() => {
    previousSpotify().catch((err) => console.error('Spotify previous failed', err))
  }, [])

  const spotifyNext = useCallback(() => {
    nextSpotify().catch((err) => console.error('Spotify next failed', err))
  }, [])

  const toggleFS = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(console.error)
    } else {
      document.exitFullscreen().catch(console.error)
    }
  }, [])

  const handleResetPlayback = useCallback(() => {
    const audio = getAudioElement()
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    if (spotifyCurrentTrack) {
      pauseSpotify().catch(console.error)
      setSpotifyPlaying(false)
    }
    clearExtensionAudioData()
    setTrackName('')
  }, [spotifyCurrentTrack, setSpotifyPlaying, setTrackName])

  const handleLiveMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      initAudioFromStream(stream)
      setTrackName('Live Microphone / Line In')
    } catch (err) {
      console.error('Microphone access failed:', err)
      alert('Could not access microphone: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [setTrackName])

  // Native fullscreen changes listener
  useEffect(() => {
    const handler = () => {
      const isFS = !!document.fullscreenElement
      setIsFullscreen(isFS)
      setShowUI(isFS)
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [setIsFullscreen])

  // Mouse activity timer for fullscreen HUD & NowPlaying fade
  useEffect(() => {
    if (!isFullscreen) return

    let timeoutId: ReturnType<typeof setTimeout>
    const handleActivity = () => {
      setShowUI(true)
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => setShowUI(false), 3200)
    }

    handleActivity()
    window.addEventListener('mousemove', handleActivity)
    window.addEventListener('click', handleActivity)
    window.addEventListener('keydown', handleActivity)

    return () => {
      window.removeEventListener('mousemove', handleActivity)
      window.removeEventListener('click', handleActivity)
      window.removeEventListener('keydown', handleActivity)
      clearTimeout(timeoutId)
    }
  }, [isFullscreen])

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return
      }

      const key = event.key.toLowerCase()

      // Preset navigation (A/D or Left/Right arrows)
      if (key === 'a' || event.code === 'KeyA' || key === 'arrowleft') {
        event.preventDefault()
        const currentIndex = PRESET_TYPES.indexOf(useStore.getState().currentPreset)
        const nextIndex = (currentIndex - 1 + PRESET_TYPES.length) % PRESET_TYPES.length
        setCurrentPreset(PRESET_TYPES[nextIndex])
      } else if (key === 'd' || event.code === 'KeyD' || key === 'arrowright') {
        event.preventDefault()
        const currentIndex = PRESET_TYPES.indexOf(useStore.getState().currentPreset)
        const nextIndex = (currentIndex + 1) % PRESET_TYPES.length
        setCurrentPreset(PRESET_TYPES[nextIndex])
      } else if (key === ' ' || event.code === 'Space') {
        // Space to toggle play/pause
        event.preventDefault()
        const state = useStore.getState()
        if (state.spotifyCurrentTrack) {
          if (state.spotifyPlaying) {
            pauseSpotify().catch(console.error)
            setSpotifyPlaying(false)
          } else {
            resumeSpotify().catch(console.error)
            setSpotifyPlaying(true)
          }
        } else {
          const audio = getAudioElement()
          if (audio) {
            if (audio.paused) audio.play().catch(console.error)
            else audio.pause()
          }
        }
      } else if (key === 'f' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        toggleFS()
      } else if (key === 'm') {
        event.preventDefault()
        const currentVol = useStore.getState().volume
        setVolume(currentVol > 0 ? 0 : 1.0)
      } else if (key === 'tab' || key === 'h') {
        event.preventDefault()
        togglePanelCollapsed()
      } else if (key === 'escape') {
        setOpenMenu(null)
        setActiveModal(null)
        if (useStore.getState().isMiniPlayer) {
          setIsMiniPlayer(false)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    setCurrentPreset,
    setSpotifyPlaying,
    setVolume,
    toggleFS,
    togglePanelCollapsed,
    setActiveModal,
    setIsMiniPlayer,
  ])

  return (
    <div
      className={`xp-window ${isFullscreen ? 'fullscreen' : ''} ${isMiniPlayer ? 'mini-player' : ''
        }`}
    >
      {/* WINDOW TITLE BAR */}
      {!isFullscreen && (
        <>
          <div className="title-bar">
            <div className="title-bar-text">
              <div className="title-icon" />
              <span>
                Visualizer.exe {isMiniPlayer ? '· Mini Player' : ''} - [
                {trackName || 'Ready'}
                ]
              </span>
            </div>
            <div className="window-controls">
              <div
                className="win-btn btn-min"
                onClick={() => setIsMiniPlayer(!isMiniPlayer)}
                role="button"
                tabIndex={0}
                title={isMiniPlayer ? 'Restore Window (Esc)' : 'Minimize to Mini Player'}
              >
                {isMiniPlayer ? '[ ]' : '_'}
              </div>
              <div
                className="win-btn btn-max"
                onClick={toggleFS}
                role="button"
                tabIndex={0}
                title="Fullscreen (F)"
              >
                [ ]
              </div>
              <div
                className="win-btn btn-close"
                onClick={handleResetPlayback}
                role="button"
                tabIndex={0}
                title="Stop / Reset"
              >
                X
              </div>
            </div>
          </div>

          {/* INTERACTIVE MENU BAR */}
          {!isMiniPlayer && (
            <div className="menu-bar" role="menubar">
              {/* FILE MENU */}
              <div className="menu-item-wrapper" onClick={(e) => e.stopPropagation()}>
                <span
                  className={`menu-item ${openMenu === 'file' ? 'active' : ''}`}
                  onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
                >
                  File
                </span>
                {openMenu === 'file' && (
                  <div className="menu-dropdown">
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        fileRef.current?.click()
                        setOpenMenu(null)
                      }}
                    >
                      <span>Open Local Audio Files...</span>
                      <span className="shortcut-hint">Ctrl+O</span>
                    </div>
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        handleLiveMic()
                        setOpenMenu(null)
                      }}
                    >
                      <span>Use Live Microphone / Line In</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        handleResetPlayback()
                        setOpenMenu(null)
                      }}
                    >
                      <span>Reset Audio Playback</span>
                    </div>
                  </div>
                )}
              </div>

              {/* VIEW MENU */}
              <div className="menu-item-wrapper" onClick={(e) => e.stopPropagation()}>
                <span
                  className={`menu-item ${openMenu === 'view' ? 'active' : ''}`}
                  onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
                >
                  View
                </span>
                {openMenu === 'view' && (
                  <div className="menu-dropdown">
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        togglePanelCollapsed()
                        setOpenMenu(null)
                      }}
                    >
                      <span>Toggle Controls Sidebar</span>
                      <span className="shortcut-hint">Tab / H</span>
                    </div>
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        setShowStatusBar((s) => !s)
                        setOpenMenu(null)
                      }}
                    >
                      <span className={showStatusBar ? 'checked' : ''}>Status Bar</span>
                    </div>
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        setIsMiniPlayer(!isMiniPlayer)
                        setOpenMenu(null)
                      }}
                    >
                      <span>Mini Player Mode</span>
                    </div>
                    <div className="dropdown-divider" />
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        toggleFS()
                        setOpenMenu(null)
                      }}
                    >
                      <span>Fullscreen Mode</span>
                      <span className="shortcut-hint">F</span>
                    </div>
                  </div>
                )}
              </div>

              {/* PRESETS MENU */}
              <div className="menu-item-wrapper" onClick={(e) => e.stopPropagation()}>
                <span
                  className={`menu-item ${openMenu === 'presets' ? 'active' : ''}`}
                  onClick={() => setOpenMenu(openMenu === 'presets' ? null : 'presets')}
                >
                  Presets
                </span>
                {openMenu === 'presets' && (
                  <div className="menu-dropdown">
                    {PRESET_TYPES.map((type) => (
                      <div
                        key={type}
                        className={`dropdown-item ${currentPreset === type ? 'checked' : ''}`}
                        onClick={() => {
                          setCurrentPreset(type)
                          setOpenMenu(null)
                        }}
                      >
                        <span>
                          {type === 'mellowDrift'
                            ? 'Mellow Drift (Silk)'
                            : type === 'prismaticGarden'
                              ? 'Prismatic Garden (Petals)'
                              : type === 'auroraSilk'
                                ? 'Aurora Silk (Ribbons)'
                                : 'brat (Typography)'}
                        </span>
                      </div>
                    ))}
                    <div className="dropdown-divider" />
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        const idx = (PRESET_TYPES.indexOf(currentPreset) + 1) % PRESET_TYPES.length
                        setCurrentPreset(PRESET_TYPES[idx])
                        setOpenMenu(null)
                      }}
                    >
                      <span>Next Preset</span>
                      <span className="shortcut-hint">D</span>
                    </div>
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        const idx =
                          (PRESET_TYPES.indexOf(currentPreset) - 1 + PRESET_TYPES.length) %
                          PRESET_TYPES.length
                        setCurrentPreset(PRESET_TYPES[idx])
                        setOpenMenu(null)
                      }}
                    >
                      <span>Previous Preset</span>
                      <span className="shortcut-hint">A</span>
                    </div>
                  </div>
                )}
              </div>

              {/* TOOLS MENU */}
              <div className="menu-item-wrapper" onClick={(e) => e.stopPropagation()}>
                <span
                  className={`menu-item ${openMenu === 'tools' ? 'active' : ''}`}
                  onClick={() => setOpenMenu(openMenu === 'tools' ? null : 'tools')}
                >
                  Tools
                </span>
                {openMenu === 'tools' && (
                  <div className="menu-dropdown" style={{ minWidth: 220 }}>
                    <div
                      style={{
                        padding: '4px 12px',
                        fontSize: 10,
                        fontWeight: 'bold',
                        color: '#666',
                        letterSpacing: 0.5,
                      }}
                    >
                      STATUS METRICS DISPLAY
                    </div>
                    {(
                      [
                        ['fps', 'FPS Counter'],
                        ['source', 'Audio Source Mode'],
                        ['bass', 'Bass Frequency Meter'],
                        ['mid', 'Mid Frequency Meter'],
                        ['treble', 'Treble Frequency Meter'],
                        ['level', 'Overall Level Meter'],
                      ] as const
                    ).map(([key, label]) => (
                      <div
                        key={key}
                        className={`dropdown-item ${metricVisibility[key] ? 'checked' : ''}`}
                        onClick={() =>
                          setMetricVisibility((cur) => ({ ...cur, [key]: !cur[key] }))
                        }
                      >
                        <span>{label}</span>
                      </div>
                    ))}
                    <div className="dropdown-divider" />
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        resetParams()
                        setOpenMenu(null)
                      }}
                    >
                      <span>Reset Shader Parameters</span>
                    </div>
                  </div>
                )}
              </div>

              {/* HELP MENU */}
              <div className="menu-item-wrapper" onClick={(e) => e.stopPropagation()}>
                <span
                  className={`menu-item ${openMenu === 'help' ? 'active' : ''}`}
                  onClick={() => setOpenMenu(openMenu === 'help' ? null : 'help')}
                >
                  Help
                </span>
                {openMenu === 'help' && (
                  <div className="menu-dropdown">
                    <div
                      className="dropdown-item"
                      onClick={() => {
                        setActiveModal('help')
                        setOpenMenu(null)
                      }}
                    >
                      <span>Keyboard Shortcuts &amp; Info</span>
                      <span className="shortcut-hint">F1</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}



      {/* MAIN VIEWPORT */}
      <div className="main-content">
        <div className="canvas-wrap">
          <Scene />
          <BratLyrics active={currentPreset === 'brat'} />

          {/* Smooth overlay NowPlaying bar */}
          <NowPlaying
            onPrev={spotifyCurrentTrack ? spotifyPrev : prev}
            onNext={spotifyCurrentTrack ? spotifyNext : next}
          />
        </div>

        {/* Collapsible Control Panel */}
        {!isFullscreen && !isMiniPlayer && (
          <ControlPanel onLoadFiles={() => fileRef.current?.click()} />
        )}
      </div>

      <input
        ref={fileRef}
        id="fileInput"
        type="file"
        accept="audio/*"
        multiple
        onChange={handleFiles}
        style={{ display: 'none' }}
      />

      {/* STATUS BAR */}
      {!isFullscreen && !isMiniPlayer && showStatusBar && (
        <StatusBar metricVisibility={metricVisibility} extensionStatus={extensionStatus} />
      )}

      {/* ABOUT & SHORTCUTS MODAL */}
      <AboutModal />
    </div>
  )
}
