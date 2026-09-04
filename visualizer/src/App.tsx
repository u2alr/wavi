import { useRef, useEffect, useCallback, useState } from 'react'
import Scene from './components/Scene'
import NowPlaying from './components/NowPlaying'
import ControlPanel from './components/ControlPanel'
import { useStore } from './store'
import { clearExtensionAudioData, getAudioBands, getAudioSourceMode, initAudio, setAmbientMode, setExtensionAudioData, setSpotifyPlaybackState } from './audio'
import { getPendingTrackId, nextSpotify, previousSpotify, setPendingTrackId, setSpotifyStateListener } from './spotifyPlayer'
import { exchangeCodeForToken, getSpotifyUser, loadTokens } from './spotify'
import BratLyrics from './components/BratLyrics'

const PRESET_TYPES = ['mellowDrift', 'prismaticGarden', 'auroraSilk', 'brat']

export default function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  
  // ✅ FIX: Properly subscribe to Zustand store so UI re-renders on changes
  const playlist = useStore((s) => s.playlist)
  const currentTrackIndex = useStore((s) => s.currentTrackIndex)
  const isFullscreen = useStore((s) => s.isFullscreen)
  const trackName = useStore((s) => s.trackName)
  const metrics = useStore((s) => s.metrics)
  
  const setPlaylist = useStore((s) => s.setPlaylist)
  const setCurrentTrackIndex = useStore((s) => s.setCurrentTrackIndex)
  const setTrackName = useStore((s) => s.setTrackName)
  const setIsFullscreen = useStore((s) => s.setIsFullscreen)
  const setParams = useStore((s) => s.setParams)
  const setCurrentPreset = useStore((s) => s.setCurrentPreset)
  const setSpotifyAuthed = useStore((s) => s.setSpotifyAuthed)
  const setSpotifyUser = useStore((s) => s.setSpotifyUser)
  const isSpotifyAuthed = useStore((s) => s.isSpotifyAuthed)
  const spotifyPlaying = useStore((s) => s.spotifyPlaying)
  const setSpotifyPlaying = useStore((s) => s.setSpotifyPlaying)
  const setPlaybackProgress = useStore((s) => s.setPlaybackProgress)
  const spotifyCurrentTrack = useStore((s) => s.spotifyCurrentTrack)
  const setMetrics = useStore((s) => s.setMetrics)
  const currentPreset = useStore((s) => s.currentPreset)
  const liveAudio = getAudioSourceMode() === 'live'

  // ✅ React-idiomatic way to handle UI visibility (replaces document.querySelector)
  const [showUI, setShowUI] = useState(true)
  const [extensionStatus, setExtensionStatus] = useState('')
  const [metricVisibility, setMetricVisibility] = useState({
    fps: true, source: true, bass: true, mid: true, treble: true, level: true,
  })
  const [showTools, setShowTools] = useState(false)

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

  useEffect(() => {
    const handlePresetKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const key = event.key.toLowerCase()
      const isPrevious = key === 'arrowleft' || key === 'a' || event.code === 'KeyA'
      const isNext = key === 'arrowright' || key === 'd' || event.code === 'KeyD'
      if (!isPrevious && !isNext) return
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return
      if (target?.tagName === 'SELECT' && !isPrevious && !isNext) return
      if (target?.tagName === 'SELECT' && (key === 'arrowleft' || key === 'arrowright')) return
      event.preventDefault()

      const currentIndex = PRESET_TYPES.indexOf(useStore.getState().currentPreset)
      const index = currentIndex < 0 ? 0 : currentIndex
      const direction = isPrevious ? -1 : 1
      const nextIndex = (index + direction + PRESET_TYPES.length) % PRESET_TYPES.length
      setCurrentPreset(PRESET_TYPES[nextIndex])
    }

    window.addEventListener('keydown', handlePresetKeys)
    return () => window.removeEventListener('keydown', handlePresetKeys)
  }, [setCurrentPreset])

  // Spotify OAuth: handle the redirect callback or restore an existing session.
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

  useEffect(() => {
    setSpotifyStateListener((state) => {
      const currentId = state.track_window.current_track.id
      const pending = getPendingTrackId()
      // Ignore stale SDK events while a track is pending — only accept the requested track.
      if (pending && pending !== currentId) return
      if (pending === currentId) setPendingTrackId(null)

      useStore.getState().setSpotifyPlaying(!state.paused)
      setSpotifyPlaybackState(!state.paused, state.position, state.duration)
      setPlaybackProgress(state.position, state.duration)
      const track = useStore.getState().spotifyTracks.find(
        (item) => item.id === currentId,
      )
      if (track) {
        useStore.getState().setSpotifyCurrentTrack(track)
        useStore.getState().setSpotifyIndex(useStore.getState().spotifyTracks.indexOf(track))
      }
      useStore.getState().setTrackName(state.track_window.current_track.name)
    })
  }, [setPlaybackProgress])

  useEffect(() => {
    const receiveExtensionAudio = (event: MessageEvent) => {
      if (event.source !== window || event.data?.source !== 'visualizer-audio-extension') return
      if (event.data.type === 'audio-data' && Array.isArray(event.data.bins)) {
        if (event.data.signal > 8) {
          setExtensionAudioData(event.data.bins)
          setExtensionStatus('EXTENSION LIVE')
        } else {
          clearExtensionAudioData()
          setExtensionStatus('EXTENSION SILENT')
        }
      }
      if (event.data.type === 'capture-status') {
        setExtensionStatus(event.data.status === 'started' ? 'EXTENSION READY' : 'EXTENSION ERROR')
        if (event.data.message) console.error('Visualizer Audio Bridge:', event.data.message)
      }
    }
    window.addEventListener('message', receiveExtensionAudio)
    return () => window.removeEventListener('message', receiveExtensionAudio)
  }, [])

  useEffect(() => {
    let frameId = 0
    let frameCount = 0
    let lastUpdate = performance.now()

    const sample = (time: number) => {
      frameCount += 1
      if (time - lastUpdate >= 250) {
        const fps = frameCount * 1000 / (time - lastUpdate)
        const bands = getAudioBands()
        setMetrics({ fps, ...bands })
        frameCount = 0
        lastUpdate = time
      }
      frameId = requestAnimationFrame(sample)
    }

    frameId = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frameId)
  }, [setMetrics])

  const playTrack = useCallback((index: number) => {
    if (index < 0 || index >= playlist.length) return
    setAmbientMode(false)
    setSpotifyPlaying(false)
    setCurrentTrackIndex(index)
    const file = playlist[index]
    initAudio(file)
    setTrackName(file.name.replace(/\.[^/.]+$/, ''))
  }, [playlist, setCurrentTrackIndex, setSpotifyPlaying, setTrackName])

  const handleFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setAmbientMode(false)
    setSpotifyPlaying(false)
    setPlaylist(files)
    setCurrentTrackIndex(0)
    initAudio(files[0])
    setTrackName(files[0].name.replace(/\.[^/.]+$/, ''))
    // ✅ Reset input so the same file can be selected again if needed
    if (fileRef.current) fileRef.current.value = ''
  }, [setPlaylist, setCurrentTrackIndex, setSpotifyPlaying, setTrackName])

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

  // Listen to native fullscreen changes
  useEffect(() => {
    const handler = () => {
      const isFS = !!document.fullscreenElement
      setIsFullscreen(isFS)
      setShowUI(isFS) // Show UI initially when entering fullscreen
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [setIsFullscreen])

  // Handle mouse movement to toggle UI visibility in fullscreen
  useEffect(() => {
    if (!isFullscreen) return
    
    let timeoutId: ReturnType<typeof setTimeout>
    
    const handleActivity = () => {
      setShowUI(true)
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => setShowUI(false), 3000)
    }

    handleActivity() // Start timer immediately on enter

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

  return (
    <div className={`xp-window ${isFullscreen ? 'fullscreen' : ''}`}>
      {/* ✅ Hide window chrome in fullscreen for true Vista immersion */}
      {!isFullscreen && (
        <>
          <div className="title-bar">
            <div className="title-bar-text">
              <div className="title-icon" />
              <span>Visualizer.exe - [{trackName || 'No Track'}]</span>
            </div>
            <div className="window-controls">
              <div className="win-btn btn-min">_</div>
              <div className="win-btn btn-max" onClick={toggleFS} role="button" tabIndex={0}>□</div>
              <div className="win-btn btn-close">✕</div>
            </div>
          </div>

          <div className="menu-bar">
            <span className="menu-item" onClick={() => fileRef.current?.click()}>File</span>
            <span className="menu-item">View</span>
            <span className="menu-item" onClick={toggleFS}>Fullscreen</span>
            <span className="menu-item tools-menu" onClick={() => setShowTools((value) => !value)}>Tools
              {showTools && (
                <div className="tools-popup" onClick={(event) => event.stopPropagation()}>
                  <div className="tools-popup-title">STATUS METRICS</div>
                  {([
                    ['fps', 'FPS'], ['source', 'Source'], ['bass', 'Bass'],
                    ['mid', 'Mid'], ['treble', 'Treble'], ['level', 'Level'],
                  ] as const).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={metricVisibility[key]}
                        onChange={(event) => setMetricVisibility((current) => ({ ...current, [key]: event.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </span>
            <span className="menu-item">Help</span>
          </div>
        </>
      )}

      <div className="canvas-wrap">
        <Scene />
        <BratLyrics active={currentPreset === 'brat'} />
        
        {/* ✅ UI Overlays that smoothly fade based on showUI state */}
        <div className={`ui-overlay now-playing-overlay ${showUI ? 'visible' : 'hidden'}`}>
          <NowPlaying
            onPrev={spotifyCurrentTrack ? spotifyPrev : prev}
            onNext={spotifyCurrentTrack ? spotifyNext : next}
          />
        </div>
      </div>

      <div className={`ui-overlay control-panel-overlay ${!isFullscreen || showUI ? 'visible' : 'hidden'}`}>
        <ControlPanel onLoadFiles={() => fileRef.current?.click()} />
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

      {!isFullscreen && (
        <div className="status-bar">
          {Object.values(metricVisibility).some(Boolean) ? (
            <>
              {metricVisibility.fps && <span className="status-section">FPS {Math.round(metrics.fps)}</span>}
              {metricVisibility.source && <span className="status-section">{extensionStatus || (liveAudio ? 'SOURCE LIVE AUDIO' : isSpotifyAuthed && spotifyPlaying ? 'SOURCE SPOTIFY SDK' : 'SOURCE AUDIO')}</span>}
              {metricVisibility.bass && <span className="status-section">BASS{liveAudio ? '' : ' EST'} {(metrics.bass * 100).toFixed(0)}%</span>}
              {metricVisibility.mid && <span className="status-section">MID{liveAudio ? '' : ' EST'} {(metrics.mid * 100).toFixed(0)}%</span>}
              {metricVisibility.treble && <span className="status-section">TREBLE{liveAudio ? '' : ' EST'} {(metrics.treble * 100).toFixed(0)}%</span>}
              {metricVisibility.level && <span className="status-section">LEVEL{liveAudio ? '' : ' EST'} {(metrics.overall * 100).toFixed(0)}%</span>}
            </>
          ) : null}
          <span style={{ flex: 1 }} />
          <span>Visualizer.exe v2.1</span>
        </div>
      )}
    </div>
  )
}
