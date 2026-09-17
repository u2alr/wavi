import { useRef, useEffect, useCallback, useState, lazy, Suspense } from 'react'
import SceneErrorBoundary from './components/SceneErrorBoundary'

// The WebGL scene carries three.js and every shader — it is the bulk of the
// bundle. Load it after the shell paints so first paint isn't blocked on it.
const Scene = lazy(() => import('./components/Scene'))
// Debug-only overlay, behind ?analysis-debug — no reason to ship it to everyone.
const AnalysisDebugOverlay = lazy(() => import('./components/AnalysisDebugOverlay'))
import FullscreenPill from './components/FullscreenPill'
import ControlPanel from './components/ControlPanel'
import AboutModal from './components/AboutModal'
import { useStore, resolvePresetId, hasStoredPanelPref } from './store'
import { PRESET_TYPES, PRESET_LABELS } from './presets'
import {
  clearExtensionAudioData,
  getAudioBands,
  getAudioElement,
  getAudioSourceMode,
  initAudio,
  setAudioVolume,
  setExtensionAudioData,
  setExtensionWaveData,
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
import { queueNext, queuePrev } from './spotifyQueue'
import { nextQueueStep } from './queueIndex'
import { exchangeCodeForToken, getSpotifyUser, loadTokens } from './spotify'
import BratLyrics from './components/BratLyrics'
import AmbientLyrics from './components/AmbientLyrics'
import StatusBar from './components/StatusBar'
import ExtensionBadge from './components/ExtensionBadge'
import SavedLooksSection from './components/SavedLooksMenu'
import { setAnalysisDebug } from './analyser'

// Canonical order also drives the A/D keyboard cycle.

// Drag-and-drop can't rely on the MIME type alone — some browsers report "" for
// audio files — so fall back to the extension.
const AUDIO_FILE_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i

export default function App() {
  const fileRef = useRef<HTMLInputElement>(null)

  // Granular Zustand subscriptions
  const playlist = useStore((s) => s.playlist)
  const isFullscreen = useStore((s) => s.isFullscreen)
  const isMiniPlayer = useStore((s) => s.isMiniPlayer)
  const trackName = useStore((s) => s.trackName)
  const volume = useStore((s) => s.volume)
  const currentPreset = useStore((s) => s.currentPreset)
  const bratKaraoke = useStore((s) => s.bratKaraoke)
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
  const setSpotifyCurrentTrack = useStore((s) => s.setSpotifyCurrentTrack)
  const setPlaybackProgress = useStore((s) => s.setPlaybackProgress)
  const setMetrics = useStore((s) => s.setMetrics)
  const setVolume = useStore((s) => s.setVolume)
  const isPanelCollapsed = useStore((s) => s.isPanelCollapsed)
  const togglePanelCollapsed = useStore((s) => s.togglePanelCollapsed)
  const setPanelCollapsed = useStore((s) => s.setPanelCollapsed)
  const setActiveModal = useStore((s) => s.setActiveModal)

  const [showStatusBar, setShowStatusBar] = useState(false)
  const [showAnalysisDebug, setShowAnalysisDebug] = useState(
    () => new URLSearchParams(window.location.search).has('analysis-debug'),
  )
  useEffect(() => {
    setAnalysisDebug(showAnalysisDebug)
  }, [showAnalysisDebug])
  const extensionStatus = useStore((s) => s.extensionStatus)
  const setExtensionStatus = useStore((s) => s.setExtensionStatus)
  const fpsLimit = useStore((s) => s.fpsLimit)
  const setFpsLimit = useStore((s) => s.setFpsLimit)
  const [menuToast, setMenuToast] = useState<{ text: string; error?: boolean; key: number } | null>(null)
  const menuToastTimer = useRef(0)

  const showMenuToast = useCallback((text: string, error = false) => {
    window.clearTimeout(menuToastTimer.current)
    setMenuToast({ text, error, key: Date.now() })
    menuToastTimer.current = window.setTimeout(() => setMenuToast(null), 2600)
  }, [])
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
        // Legacy brat2 preset was folded into brat + karaoke toggle.
        if (data.presetType === 'brat2') {
          setCurrentPreset('brat')
          useStore.getState().setBratKaraoke(true)
        } else if (data.presetType) {
          // Map pre-rename ids (arcticSwirl, mellowDrift, ...) to their new ids.
          const pid = resolvePresetId(data.presetType)
          if (pid) setCurrentPreset(pid)
        }
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

  // Under 860px the panel is a full-width overlay drawer, so opening it on load
  // would hide the visualizer behind its own settings. Start closed there —
  // only when the user hasn't already picked a panel state, since the pref is
  // written from the first toggle onwards.
  const panelDefaultAppliedRef = useRef(false)
  useEffect(() => {
    if (panelDefaultAppliedRef.current) return
    panelDefaultAppliedRef.current = true
    if (!hasStoredPanelPref() && window.matchMedia('(max-width: 860px)').matches) {
      setPanelCollapsed(true)
    }
  }, [setPanelCollapsed])

  // Close dropdown menu when clicking anywhere else
  useEffect(() => {
    const handleClickOutside = () => setOpenMenu(null)
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [])

  // Spotify OAuth
  const exchangedCodeRef = useRef<string | null>(null)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code) {
      // StrictMode invokes effects twice in dev and the ?code= is only stripped
      // asynchronously below, so without this guard the same authorization code
      // is POSTed twice and the second attempt fails with invalid_grant.
      if (exchangedCodeRef.current === code) return
      exchangedCodeRef.current = code
      exchangeCodeForToken(code, params.get('state'))
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

  // Spotify SDK State Listener — always sync from the SDK event so a
  // naturally-ending song advances the panel player + lyrics even when the next
  // track isn't in our loaded list.
  useEffect(() => {
    setSpotifyStateListener((state) => {
      const store = useStore.getState()
      if (!state) {
        store.setSpotifyPlaying(false)
        return
      }
      const sdkTrack = state.track_window.current_track
      const currentId = sdkTrack.id
      const pending = getPendingTrackId()
      if (pending && pending !== currentId) return
      if (pending === currentId) setPendingTrackId(null)

      const isPlaying = !state.paused
      store.setSpotifyPlaying(isPlaying)
      setPlaybackProgress(state.position, state.duration)
      const idx = store.spotifyTracks.findIndex((item) => item.id === currentId)
      if (idx >= 0) {
        store.setSpotifyCurrentTrack(store.spotifyTracks[idx])
        store.setSpotifyIndex(idx)
      } else {
        // Track advanced outside our loaded list (e.g. natural queue
        // advance) — build a minimal record from SDK data so the player
        // bar and lyrics update instead of showing the previous song.
        store.setSpotifyCurrentTrack({
          id: sdkTrack.id,
          name: sdkTrack.name,
          uri: sdkTrack.uri,
          duration_ms: sdkTrack.duration_ms ?? state.duration,
          album: sdkTrack.album
            ? { id: sdkTrack.album.name ?? '', name: sdkTrack.album.name ?? '', images: sdkTrack.album.images ?? [] }
            : { id: '', name: '', images: [] },
          artists: (sdkTrack.artists ?? []).map((a: { name: string }) => ({ id: a.name, name: a.name })),
        })
        store.setSpotifyIndex(-1)
      }
      store.setTrackName(sdkTrack.name)
    })
  }, [setPlaybackProgress])

  // Browser Audio Extension listener
  useEffect(() => {
    const receiveExtensionAudio = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'visualizer-audio-extension') return
      if (event.data.type === 'audio-data' && Array.isArray(event.data.bins)) {
        if (event.data.signal > 8) {
          setExtensionAudioData(event.data.bins)
          if (Array.isArray(event.data.wave)) setExtensionWaveData(event.data.wave)
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
  }, [setExtensionStatus])

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

  // The local-file step lives behind a ref so the `ended` handler can be
  // attached to every fresh Audio element while still calling the latest
  // closure (the handler itself is created before playTrack exists).
  const stepLocalRef = useRef<(dir: 1 | -1, isAuto?: boolean) => void>(() => {})

  const handleLocalEnded = useCallback(() => {
    const s = useStore.getState()
    if (s.repeatMode === 'one' && s.currentTrackIndex >= 0) {
      // Restart on the same element — coarser than seeking, but it keeps the
      // analyser wired up. A fresh Audio here would leave AudioPlayerBox's
      // progress listener attached to a discarded element, since its effect
      // only re-runs when trackName changes.
      const audio = getAudioElement()
      if (audio) {
        audio.loop = true
        audio.currentTime = 0
        audio.play().catch(console.error)
        return
      }
    }
    stepLocalRef.current(1, true)
  }, [])

  const playTrack = useCallback(
    (index: number) => {
      if (index < 0 || index >= playlist.length) return
      setSpotifyPlaying(false)
      setSpotifyCurrentTrack(null)
      setCurrentTrackIndex(index)
      const file = playlist[index]
      const audio = initAudio(file)
      audio.loop = useStore.getState().repeatMode === 'one'
      // Auto-advance local files when a song naturally ends so the player
      // bar and lyrics move to the next song instead of going stale.
      audio.onended = handleLocalEnded
      setTrackName(file.name.replace(/\.[^/.]+$/, ''))
    },
    [playlist, setCurrentTrackIndex, setSpotifyPlaying, setSpotifyCurrentTrack, setTrackName, handleLocalEnded]
  )

  // Shared by the file picker and drag-and-drop. Guarded because initAudio
  // throws on an unusable file or an unavailable AudioContext, and the playlist
  // is already committed by then — failing silently would leave the player
  // holding a queue with nothing playing and nothing said about it.
  const loadLocalFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      setSpotifyPlaying(false)
      setSpotifyCurrentTrack(null)
      try {
        setPlaylist(files)
        setCurrentTrackIndex(0)
        const audio = initAudio(files[0])
        audio.loop = useStore.getState().repeatMode === 'one'
        audio.onended = handleLocalEnded
        setTrackName(files[0].name.replace(/\.[^/.]+$/, ''))
        showMenuToast(`Loaded ${files.length} ${files.length === 1 ? 'file' : 'files'}`)
      } catch (err) {
        console.error('Local audio failed to start:', err)
        setPlaylist([])
        setCurrentTrackIndex(-1)
        setTrackName('')
        showMenuToast("Couldn't play that file — try another audio file.", true)
      }
    },
    [
      setPlaylist,
      setCurrentTrackIndex,
      setSpotifyPlaying,
      setSpotifyCurrentTrack,
      setTrackName,
      handleLocalEnded,
      showMenuToast,
    ],
  )

  const handleFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      loadLocalFiles(Array.from(e.target.files || []))
      if (fileRef.current) fileRef.current.value = ''
    },
    [loadLocalFiles],
  )

  // Preventing the default on drag-over is what makes this element a valid drop
  // target — without it the browser navigates to the dropped file and the app
  // unloads mid-playback.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }, [])

  // Dropping audio anywhere in the window loads it, like File > Open.
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith('audio/') || AUDIO_FILE_RE.test(f.name),
      )
      if (files.length === 0) {
        showMenuToast('That drop had no audio files.', true)
        return
      }
      loadLocalFiles(files)
    },
    [loadLocalFiles, showMenuToast],
  )

  // One step for every local-file transition — the transport buttons and the
  // natural-end handler above — so shuffle and repeat apply to both. Previously
  // only the buttons consulted them, so shuffle played the list in order.
  const stepLocal = useCallback(
    (dir: 1 | -1, isAuto = false) => {
      const s = useStore.getState()
      const step = nextQueueStep({
        index: s.currentTrackIndex,
        length: s.playlist.length,
        dir,
        shuffle: s.shuffle,
        auto: isAuto,
        repeat: s.repeatMode,
      })
      if (step.kind === 'stop') {
        s.setTrackName('')
        s.setCurrentTrackIndex(-1)
        return
      }
      playTrack(step.index)
    },
    [playTrack],
  )

  useEffect(() => {
    stepLocalRef.current = stepLocal
  }, [stepLocal])

  const prev = useCallback(() => stepLocal(-1), [stepLocal])
  const next = useCallback(() => stepLocal(1), [stepLocal])

  const spotifyPrev = useCallback(() => {
    useStore.getState().setSpotifyError(null)
    // Empty queue (e.g. external Spotify control) — fall back to the SDK.
    if (useStore.getState().spotifyTracks.length === 0) {
      previousSpotify().catch((err) => console.error('Spotify previous failed', err))
      return
    }
    queuePrev().catch((err) =>
      useStore.getState().setSpotifyError(err instanceof Error ? err.message : String(err)),
    )
  }, [])

  const spotifyNext = useCallback(() => {
    useStore.getState().setSpotifyError(null)
    if (useStore.getState().spotifyTracks.length === 0) {
      nextSpotify().catch((err) => console.error('Spotify next failed', err))
      return
    }
    queueNext().catch((err) =>
      useStore.getState().setSpotifyError(err instanceof Error ? err.message : String(err)),
    )
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

  // Native fullscreen changes listener
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [setIsFullscreen])

  // Fullscreen panel overlay: auto-collapse on enter (canvas stays full-bleed),
  // restore prior state on exit. Toast hint shows once per session.
  const preFsPanelRef = useRef<boolean | null>(null)
  const fsToastShownRef = useRef(false)
  useEffect(() => {
    if (isFullscreen) {
      preFsPanelRef.current = useStore.getState().isPanelCollapsed
      setPanelCollapsed(true)
      if (!fsToastShownRef.current) {
        fsToastShownRef.current = true
        showMenuToast('Fullscreen — press Tab for controls')
      }
    } else if (preFsPanelRef.current === false) {
      setPanelCollapsed(false)
      preFsPanelRef.current = null
    }
  }, [isFullscreen, setPanelCollapsed, showMenuToast])

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
      } else if (key === 'y') {
        event.preventDefault()
        setShowAnalysisDebug((s) => !s)
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
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* WINDOW CHROME — one continuous translucent material */}
      {!isFullscreen && (
        <div className="window-chrome">
          <div className="title-bar">
            <div className="traffic-lights" aria-hidden="true">
              <span className="traffic-light red" />
              <span className="traffic-light yellow" />
              <span className="traffic-light green" />
            </div>
            <div className="title-bar-text">
              <span>
                wavi.lol — {trackName || (isMiniPlayer ? 'Mini Player' : 'Ready')}
              </span>
            </div>
            <div className="title-bar-spacer" aria-hidden="true" />
            {/* Drawer handle for narrow viewports: there the panel covers the
                canvas, so the toggle can't live inside the panel itself, and
                the View menu is two taps away. Hidden on desktop. */}
            <button
              type="button"
              className="panel-toggle-btn"
              onClick={togglePanelCollapsed}
              title={isPanelCollapsed ? 'Show controls' : 'Hide controls'}
              aria-label={isPanelCollapsed ? 'Show controls' : 'Hide controls'}
              aria-expanded={!isPanelCollapsed}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                {isPanelCollapsed ? (
                  <>
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="5" y1="5" x2="19" y2="19" />
                    <line x1="19" y1="5" x2="5" y2="19" />
                  </>
                )}
              </svg>
            </button>
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
                        <span>{PRESET_LABELS[type] ?? type}</span>
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
                    <SavedLooksSection
                      onAction={() => setOpenMenu(null)}
                      notify={showMenuToast}
                    />
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
                      style={{
                        padding: '4px 12px',
                        fontSize: 10,
                        fontWeight: 'bold',
                        color: '#666',
                        letterSpacing: 0.5,
                      }}
                    >
                      FRAME RATE
                    </div>
                    {([30, 60, 75, 100, 120, 144, 160, 200, 240, 0] as const).map((fps) => (
                      <div
                        key={fps}
                        className={`dropdown-item ${fpsLimit === fps ? 'checked' : ''}`}
                        onClick={() => setFpsLimit(fps)}
                      >
                        <span>{fps === 0 ? 'Unlimited' : `${fps} FPS`}</span>
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

              {/* EXTENSION STATUS — pinned right */}
              <ExtensionBadge
                status={extensionStatus}
                open={openMenu === 'extension'}
                onToggle={() => setOpenMenu(openMenu === 'extension' ? null : 'extension')}
              />
            </div>
          )}
        </div>
      )}



      {/* MAIN VIEWPORT */}
      <div className="main-content">
        <div className="canvas-wrap">
          <SceneErrorBoundary>
            <Suspense fallback={<div className="canvas-loading" aria-hidden="true" />}>
              <Scene />
            </Suspense>
          </SceneErrorBoundary>
          <BratLyrics
            active={currentPreset === 'brat'}
            variant={bratKaraoke ? 'karaoke' : 'line'}
          />
          <AmbientLyrics active={currentPreset === 'canvasAmbient2'} />

          {/* Fullscreen pill — panel is hidden, so playback UI lives here.
              Always mounted in fullscreen: shows track transport when a track
              is loaded, browser-audio dots when only the extension is live,
              and a flowy idle state otherwise. */}
          {isFullscreen && (
            <FullscreenPill
              onPrev={spotifyCurrentTrack ? spotifyPrev : prev}
              onNext={spotifyCurrentTrack ? spotifyNext : next}
            />
          )}
        </div>

        {/* Collapsible Control Panel — in fullscreen it floats above the
            canvas (see .xp-window.fullscreen .control-panel) so the
            visualizer keeps its full size. */}
        {!isMiniPlayer && (
          <ControlPanel
            onPrev={spotifyCurrentTrack ? spotifyPrev : prev}
            onNext={spotifyCurrentTrack ? spotifyNext : next}
          />
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

      {/* Analysis engine debug overlay (?analysis-debug) */}
      {showAnalysisDebug && (
        <Suspense fallback={null}>
          <AnalysisDebugOverlay />
        </Suspense>
      )}

      {/* Window-level toasts for menu actions (save/share). */}
      <div className="xp-toast-region" role="status" aria-live="polite">
        {menuToast && (
          <div key={menuToast.key} className={`xp-toast show${menuToast.error ? ' error' : ''}`}>
            {menuToast.text}
          </div>
        )}
      </div>
    </div>
  )
}
