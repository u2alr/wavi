import { useState, useCallback, useRef } from 'react'
import { useStore } from '../store'
import SpotifyAuth from './SpotifyAuth'
import SpotifyPanel from './SpotifyPanel'

export default function ControlPanel() {
  // Granular Zustand selectors to prevent unnecessary re-renders
  const currentPreset = useStore((s) => s.currentPreset)
  const params = useStore((s) => s.params)
  const savedPresets = useStore((s) => s.savedPresets)
  const isPanelCollapsed = useStore((s) => s.isPanelCollapsed)
  const bratWhiteBg = useStore((s) => s.bratWhiteBg)

  const setCurrentPreset = useStore((s) => s.setCurrentPreset)
  const setParam = useStore((s) => s.setParam)
  const resetParams = useStore((s) => s.resetParams)
  const savePreset = useStore((s) => s.savePreset)
  const loadPreset = useStore((s) => s.loadPreset)
  const deletePreset = useStore((s) => s.deletePreset)
  const togglePanelCollapsed = useStore((s) => s.togglePanelCollapsed)
  const setBratWhiteBg = useStore((s) => s.setBratWhiteBg)

  const [saveName, setSaveName] = useState('')
  const [showSave, setShowSave] = useState(false)
  const [copiedNotification, setCopiedNotification] = useState(false)
  const [toast, setToast] = useState<{ text: string; error?: boolean; key: number } | null>(null)
  const toastTimer = useRef(0)

  // Accordion state
  const [openSections, setOpenSections] = useState({
    audio: true,
    visualizer: true,
    presets: true,
  })

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const showToast = useCallback((text: string, error = false) => {
    window.clearTimeout(toastTimer.current)
    setToast({ text, error, key: Date.now() })
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const handleShare = useCallback(async () => {
    const data = btoa(JSON.stringify({ presetType: currentPreset, params }))
    const url = `${window.location.origin}${window.location.pathname}#p=${data}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedNotification(true)
      showToast('Share link copied to clipboard')
      window.setTimeout(() => setCopiedNotification(false), 2000)
    } catch {
      showToast('Could not copy link — clipboard blocked', true)
    }
  }, [currentPreset, params, showToast])

  const commitSave = useCallback(() => {
    const name = saveName.trim()
    if (!name) return
    savePreset(name)
    setSaveName('')
    setShowSave(false)
    showToast(`Preset "${name}" saved`)
  }, [saveName, savePreset, showToast])

  const onHeaderKeyDown = (section: keyof typeof openSections) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleSection(section)
    }
  }

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
          <div className="ctrl-group-header" role="button" tabIndex={0} aria-expanded={openSections.audio} onClick={() => toggleSection('audio')} onKeyDown={onHeaderKeyDown('audio')}>
            <div className="ctrl-group-title">
              <span>AUDIO SOURCE</span>
            </div>
            <span className="accordion-arrow">{openSections.audio ? '▾' : '▸'}</span>
          </div>

          {openSections.audio && (
            <div className="ctrl-group-body">
              <SpotifyAuth />
              <SpotifyPanel />
            </div>
          )}
        </div>

        {/* VISUALIZER PRESETS & SHADER PARAMS */}
        <div className="ctrl-group">
          <div className="ctrl-group-header" role="button" tabIndex={0} aria-expanded={openSections.visualizer} onClick={() => toggleSection('visualizer')} onKeyDown={onHeaderKeyDown('visualizer')}>
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
                <option value="liquidDrift">Liquid Drift (Liquid Mercury)</option>
                <option value="arcticSwirl">Arctic Swirl (Whirlpool)</option>
                <option value="laserSilk">Laser Silk (Contour Lasers)</option>
                <option value="sonarBloom">Sonar Bloom (Ripple Rings)</option>
                <option value="pastels">Pastels (Laser Threads)</option>
                <option value="brat">brat (Audio Reactive Typography)</option>
              </select>

              {currentPreset === 'brat' && (
                <label className="brat-bg-toggle" htmlFor="brat-white-bg">
                  <span className="brat-bg-label">White background</span>
                  <input
                    id="brat-white-bg"
                    type="checkbox"
                    checked={bratWhiteBg}
                    onChange={(e) => setBratWhiteBg(e.target.checked)}
                  />
                  <span className="brat-switch" aria-hidden="true" />
                </label>
              )}

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

              </div>
            </div>
          )}
        </div>

        {/* PRESET BOOKMARKS */}
        <div className="ctrl-group">
          <div className="ctrl-group-header" role="button" tabIndex={0} aria-expanded={openSections.presets} onClick={() => toggleSection('presets')} onKeyDown={onHeaderKeyDown('presets')}>
            <div className="ctrl-group-title">
              <span>SAVED PRESETS</span>
            </div>
            <span className="accordion-arrow">{openSections.presets ? '▾' : '▸'}</span>
          </div>

          {openSections.presets && (
            <div className="ctrl-group-body">
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button
                  className="xp-btn primary"
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
                      if (e.key === 'Enter') commitSave()
                    }}
                    className="xp-input"
                    autoFocus
                  />
                  <button
                    className="xp-btn primary"
                    onClick={commitSave}
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
                    role="button"
                    tabIndex={0}
                    onClick={() => loadPreset(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        loadPreset(p.id)
                      }
                    }}
                    title={`Load "${p.name}"`}
                  >
                    <span className="chip-name">{p.name}</span>
                    <button
                      type="button"
                      className="del"
                      onClick={(e) => {
                        e.stopPropagation()
                        deletePreset(p.id)
                      }}
                      aria-label={`Delete preset ${p.name}`}
                      title="Delete preset"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {savedPresets.length === 0 && (
                  <span className="no-presets-text">No custom presets yet — save your first one.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="xp-toast-region" role="status" aria-live="polite">
        {toast && (
          <div key={toast.key} className={`xp-toast show${toast.error ? ' error' : ''}`}>
            {toast.text}
          </div>
        )}
      </div>
    </aside>
  )
}
