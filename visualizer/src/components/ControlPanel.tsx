import { useState, useCallback } from 'react'
import { useStore } from '../store'
import SpotifyAuth from './SpotifyAuth'
import SpotifyPanel from './SpotifyPanel'
import { clearExtensionAudioData, initAudioFromStream } from '../audio'

export default function ControlPanel({ onLoadFiles }: { onLoadFiles: () => void }) {
  // Granular Zustand selectors to prevent unnecessary re-renders
  const currentPreset = useStore((s) => s.currentPreset)
  const params = useStore((s) => s.params)
  const savedPresets = useStore((s) => s.savedPresets)
  const playlistLength = useStore((s) => s.playlist.length)
  const isPanelCollapsed = useStore((s) => s.isPanelCollapsed)

  const setCurrentPreset = useStore((s) => s.setCurrentPreset)
  const setParam = useStore((s) => s.setParam)
  const resetParams = useStore((s) => s.resetParams)
  const savePreset = useStore((s) => s.savePreset)
  const loadPreset = useStore((s) => s.loadPreset)
  const deletePreset = useStore((s) => s.deletePreset)
  const setTrackName = useStore((s) => s.setTrackName)
  const togglePanelCollapsed = useStore((s) => s.togglePanelCollapsed)

  const [saveName, setSaveName] = useState('')
  const [showSave, setShowSave] = useState(false)
  const [isListeningMic, setIsListeningMic] = useState(false)
  const [copiedNotification, setCopiedNotification] = useState(false)

  // Accordion state
  const [openSections, setOpenSections] = useState({
    audio: true,
    visualizer: true,
    presets: true,
  })

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const handleToggleMic = useCallback(async () => {
    if (isListeningMic) {
      setIsListeningMic(false)
      clearExtensionAudioData()
      setTrackName('')
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        initAudioFromStream(stream)
        setTrackName('Live Microphone / Line In')
        setIsListeningMic(true)
      } catch (err) {
        console.error('Microphone access failed:', err)
        alert('Could not access microphone: ' + (err instanceof Error ? err.message : String(err)))
      }
    }
  }, [isListeningMic, setTrackName])

  const handleShare = useCallback(() => {
    const data = btoa(JSON.stringify({ presetType: currentPreset, params }))
    const url = `${window.location.origin}${window.location.pathname}#p=${data}`
    navigator.clipboard.writeText(url).then(() => {
      setCopiedNotification(true)
      setTimeout(() => setCopiedNotification(false), 2000)
    })
  }, [currentPreset, params])

  return (
    <aside className={`control-panel ${isPanelCollapsed ? 'collapsed' : ''}`} aria-label="Visualizer Controls">
      {/* Sidebar Collapse / Expand Handle */}
      <button
        className="panel-toggle-tab"
        onClick={togglePanelCollapsed}
        title={isPanelCollapsed ? 'Expand Controls (Tab)' : 'Collapse Controls (Tab)'}
        aria-label="Toggle Control Panel"
      >
        <span className="toggle-tab-icon">{isPanelCollapsed ? '◀' : '▶'}</span>
      </button>

      <div className="control-panel-scroll">
        {/* AUDIO SOURCE SECTION */}
        <div className="ctrl-group">
          <div className="ctrl-group-header" onClick={() => toggleSection('audio')}>
            <div className="ctrl-group-title">
              <span>AUDIO SOURCE</span>
            </div>
            <span className="accordion-arrow">{openSections.audio ? '▾' : '▸'}</span>
          </div>

          {openSections.audio && (
            <div className="ctrl-group-body">
              <div className="audio-source-actions">
                <button className="xp-btn primary source-btn" onClick={onLoadFiles}>
                  Load Local Files
                </button>
                {playlistLength > 0 && (
                  <span className="track-badge">{playlistLength} file{playlistLength > 1 ? 's' : ''}</span>
                )}
              </div>

              <div className="audio-source-actions" style={{ marginTop: 6 }}>
                <button
                  className={`xp-btn ${isListeningMic ? 'active-mic' : ''} source-btn`}
                  onClick={handleToggleMic}
                  title="Visualize live microphone or system audio line-in"
                >
                  {isListeningMic ? 'Stop Mic Input' : 'Live Mic Input'}
                </button>
              </div>

              <div className="source-divider">
                <span className="source-divider-line" />
                <span className="source-divider-text">SPOTIFY STREAMING</span>
                <span className="source-divider-line" />
              </div>

              <SpotifyAuth />
              <SpotifyPanel />
            </div>
          )}
        </div>

        {/* VISUALIZER PRESETS & SHADER PARAMS */}
        <div className="ctrl-group">
          <div className="ctrl-group-header" onClick={() => toggleSection('visualizer')}>
            <div className="ctrl-group-title">
              <span>VISUALIZER ENGINE</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                className="btn-tiny"
                title="Reset sliders to defaults"
                onClick={(e) => {
                  e.stopPropagation()
                  resetParams()
                }}
              >
                Reset
              </button>
              <span className="accordion-arrow">{openSections.visualizer ? '▾' : '▸'}</span>
            </div>
          </div>

          {openSections.visualizer && (
            <div className="ctrl-group-body">
              <label className="field-label" htmlFor="preset-select">Active Preset</label>
              <select
                id="preset-select"
                value={currentPreset}
                onChange={(e) => setCurrentPreset(e.target.value)}
                className="xp-select"
                style={{ width: '100%', marginBottom: 8 }}
              >
                <option value="mellowDrift">Mellow Drift (Silk Instrumentals)</option>
                <option value="prismaticGarden">Prismatic Garden (Flowing Petals)</option>
                <option value="auroraSilk">Aurora Silk (Flowing Ribbons)</option>
                <option value="brat">brat (Audio Reactive Typography)</option>
              </select>

              <div className="sliders-container">
                <div className="ctrl-row">
                  <div className="label-with-tooltip">
                    <label htmlFor="param-intensity">Intensity</label>
                  </div>
                  <input
                    id="param-intensity"
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={params.intensity}
                    onChange={(e) => setParam('intensity', +e.target.value)}
                  />
                  <span className="val">{params.intensity.toFixed(1)}</span>
                </div>

                <div className="ctrl-row">
                  <div className="label-with-tooltip">
                    <label htmlFor="param-sensitivity">Sensitivity</label>
                  </div>
                  <input
                    id="param-sensitivity"
                    type="range"
                    min="0.5"
                    max="5"
                    step="0.1"
                    value={params.sensitivity}
                    onChange={(e) => setParam('sensitivity', +e.target.value)}
                  />
                  <span className="val">{params.sensitivity.toFixed(1)}x</span>
                </div>

                <div className="ctrl-row">
                  <div className="label-with-tooltip">
                    <label htmlFor="param-hueshift">Hue Shift</label>
                  </div>
                  <input
                    id="param-hueshift"
                    type="range"
                    min="0"
                    max="360"
                    step="1"
                    value={params.hueShift}
                    onChange={(e) => setParam('hueShift', +e.target.value)}
                  />
                  <span className="val">{params.hueShift}°</span>
                </div>

                <div className="ctrl-row">
                  <div className="label-with-tooltip">
                    <label htmlFor="param-speed">Speed</label>
                  </div>
                  <input
                    id="param-speed"
                    type="range"
                    min="0.1"
                    max="3"
                    step="0.1"
                    value={params.speed}
                    onChange={(e) => setParam('speed', +e.target.value)}
                  />
                  <span className="val">{params.speed.toFixed(1)}</span>
                </div>

                <div className="ctrl-row">
                  <div className="label-with-tooltip">
                    <label htmlFor="param-complexity">Complexity</label>
                  </div>
                  <input
                    id="param-complexity"
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={params.complexity}
                    onChange={(e) => setParam('complexity', +e.target.value)}
                  />
                  <span className="val">{params.complexity.toFixed(1)}</span>
                </div>

                <div className="ctrl-row">
                  <div className="label-with-tooltip">
                    <label htmlFor="param-thickness">Thickness</label>
                  </div>
                  <input
                    id="param-thickness"
                    type="range"
                    min="0.3"
                    max="3"
                    step="0.1"
                    value={params.thickness}
                    onChange={(e) => setParam('thickness', +e.target.value)}
                  />
                  <span className="val">{params.thickness.toFixed(1)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* PRESET BOOKMARKS */}
        <div className="ctrl-group">
          <div className="ctrl-group-header" onClick={() => toggleSection('presets')}>
            <div className="ctrl-group-title">
              <span>SAVED PRESETS</span>
            </div>
            <span className="accordion-arrow">{openSections.presets ? '▾' : '▸'}</span>
          </div>

          {openSections.presets && (
            <div className="ctrl-group-body">
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button
                  className="xp-btn"
                  onClick={() => setShowSave(!showSave)}
                  style={{ flex: 1 }}
                >
                  {showSave ? 'Cancel' : '+ Save Preset'}
                </button>
                <button
                  className="xp-btn"
                  onClick={handleShare}
                  style={{ flex: 1 }}
                  title="Copy shareable preset link to clipboard"
                >
                  {copiedNotification ? 'Copied!' : 'Share Link'}
                </button>
              </div>

              {showSave && (
                <div className="save-preset-bar">
                  <input
                    type="text"
                    placeholder="Enter preset name..."
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && saveName.trim()) {
                        savePreset(saveName.trim())
                        setSaveName('')
                        setShowSave(false)
                      }
                    }}
                    className="xp-input"
                    autoFocus
                  />
                  <button
                    className="xp-btn primary"
                    onClick={() => {
                      if (saveName.trim()) {
                        savePreset(saveName.trim())
                        setSaveName('')
                        setShowSave(false)
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              )}

              <div className="preset-list">
                {savedPresets.map((p) => (
                  <div
                    key={p.id}
                    className="preset-chip"
                    onClick={() => loadPreset(p.id)}
                    title={`Load "${p.name}"`}
                  >
                    <span className="chip-name">{p.name}</span>
                    <span
                      className="del"
                      onClick={(e) => {
                        e.stopPropagation()
                        deletePreset(p.id)
                      }}
                      title="Delete preset"
                    >
                      ×
                    </span>
                  </div>
                ))}
                {savedPresets.length === 0 && (
                  <span className="no-presets-text">No custom presets saved yet.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
