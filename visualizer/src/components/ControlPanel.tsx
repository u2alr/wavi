import { useState, useCallback, useRef } from 'react'
import { useStore } from '../store'
import SpotifyAuth from './SpotifyAuth'
import SpotifyPanel from './SpotifyPanel'
import AudioPlayerBox from './AudioPlayerBox'
import PanelSelect from './PanelSelect'

const PRESET_OPTIONS = [
  { value: 'arcticSwirl', label: 'Arctic Swirl' },
  { value: 'auroraSilk', label: 'Aurora Silk' },
  { value: 'brat', label: 'brat' },
  { value: 'canvasAmbient', label: 'Canvas Ambient' },
  { value: 'fractalEmber', label: 'Fractal Ember' },
  { value: 'laserSilk', label: 'Laser Silk' },
  { value: 'liquidDrift', label: 'Liquid Drift' },
  { value: 'mellowDrift', label: 'Mellow Drift' },
  { value: 'prismaticGarden', label: 'Prismatic Garden' },
  { value: 'sonarBloom', label: 'Sonar Bloom' },
]

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

export default function ControlPanel({
  onPrev,
  onNext,
}: {
  onPrev: () => void
  onNext: () => void
}) {
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

  // Accordion state — audio open on first load, the rest expand on demand
  const [openSections, setOpenSections] = useState({
    audio: true,
    visualizer: false,
    presets: false,
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

  const pct = (v: number, min: number, max: number) =>
    `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`

  const currentPresetLabel =
    PRESET_OPTIONS.find((option) => option.value === currentPreset)?.label ?? currentPreset

  return (
    <aside className={`control-panel ${isPanelCollapsed ? 'collapsed' : ''}`} aria-label="Visualizer Controls">
      {isPanelCollapsed && (
        <button className="panel-reopen" onClick={togglePanelCollapsed} title="Expand Controls (Tab)" aria-label="Expand Control Panel">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 4L6 8l4 4" />
          </svg>
        </button>
      )}
      <div className="panel-header">
        <div className="panel-header-copy">
          <span className="panel-header-eyebrow">Controls</span>
          <span className="panel-header-sub">{currentPresetLabel}</span>
        </div>
        <button
          className="panel-collapse-btn"
          onClick={togglePanelCollapsed}
          title="Collapse Controls (Tab)"
          aria-label="Collapse Control Panel"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
      </div>

      <div className="control-panel-scroll">
        {/* AUDIO SOURCE SECTION */}
        <div className={`ctrl-group audio-source-group${openSections.audio ? ' open' : ''}`}>
          <div className="ctrl-group-header" role="button" tabIndex={0} aria-expanded={openSections.audio} onClick={() => toggleSection('audio')} onKeyDown={onHeaderKeyDown('audio')}>
            <div className="ctrl-group-eyebrow-row">
              <div className="ctrl-group-title">
                <span>Audio source</span>
              </div>
            </div>
            <span className="accordion-arrow" aria-hidden="true"><Chevron /></span>
          </div>

          <div className="ctrl-group-body">
            <div className="ctrl-group-body-inner">
              <SpotifyAuth />
              <AudioPlayerBox onPrev={onPrev} onNext={onNext} />
              <SpotifyPanel />
            </div>
          </div>
        </div>

        {/* VISUALIZER PRESETS & SHADER PARAMS */}
        <div className={`ctrl-group${openSections.visualizer ? ' open' : ''}`}>
          <div className="ctrl-group-header" role="button" tabIndex={0} aria-expanded={openSections.visualizer} onClick={() => toggleSection('visualizer')} onKeyDown={onHeaderKeyDown('visualizer')}>
            <div className="ctrl-group-eyebrow-row">
              <div className="ctrl-group-title">
                <span>Visualizer engine</span>
              </div>
            </div>
            <span className="accordion-arrow" aria-hidden="true"><Chevron /></span>
          </div>

          <div className="ctrl-group-body">
            <div className="ctrl-group-body-inner">
              <div className="field-wrap">
              <label className="field-label" htmlFor="preset-select">Active Preset</label>
              <PanelSelect
                id="preset-select"
                value={currentPreset}
                options={PRESET_OPTIONS}
                onChange={(v) => setCurrentPreset(v)}
                ariaLabel="Active preset"
              />

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
              </div>
              <p className="field-hint">Changes apply live.</p>

              <div className="sliders-container">
                <div className="ctrl-row">
                  <div className="slider-label">
                    <label htmlFor="param-intensity">Intensity</label>
                  </div>
                  <input
                    id="param-intensity"
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={params.intensity}
                    style={{ ['--p' as string]: pct(params.intensity, 0.5, 3) }}
                    onChange={(e) => setParam('intensity', +e.target.value)}
                  />
                  <span className="val">{params.intensity.toFixed(1)}</span>
                </div>

                <div className="ctrl-row">
                  <div className="slider-label">
                    <label htmlFor="param-sensitivity">Sensitivity</label>
                  </div>
                  <input
                    id="param-sensitivity"
                    type="range"
                    min="0.5"
                    max="5"
                    step="0.1"
                    value={params.sensitivity}
                    style={{ ['--p' as string]: pct(params.sensitivity, 0.5, 5) }}
                    onChange={(e) => setParam('sensitivity', +e.target.value)}
                  />
                  <span className="val">{params.sensitivity.toFixed(1)}</span>
                </div>

                <div className="ctrl-row">
                  <div className="slider-label">
                    <label htmlFor="param-hueshift">Hue Shift</label>
                  </div>
                  <input
                    id="param-hueshift"
                    type="range"
                    min="0"
                    max="360"
                    step="1"
                    value={params.hueShift}
                    style={{ ['--p' as string]: pct(params.hueShift, 0, 360) }}
                    onChange={(e) => setParam('hueShift', +e.target.value)}
                  />
                  <span className="val">{params.hueShift}°</span>
                </div>

                <div className="ctrl-row">
                  <div className="slider-label">
                    <label htmlFor="param-speed">Speed</label>
                  </div>
                  <input
                    id="param-speed"
                    type="range"
                    min="0.1"
                    max="3"
                    step="0.1"
                    value={params.speed}
                    style={{ ['--p' as string]: pct(params.speed, 0.1, 3) }}
                    onChange={(e) => setParam('speed', +e.target.value)}
                  />
                  <span className="val">{params.speed.toFixed(1)}</span>
                </div>

                <div className="ctrl-row">
                  <div className="slider-label">
                    <label htmlFor="param-complexity">Complexity</label>
                  </div>
                  <input
                    id="param-complexity"
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={params.complexity}
                    style={{ ['--p' as string]: pct(params.complexity, 0.5, 3) }}
                    onChange={(e) => setParam('complexity', +e.target.value)}
                  />
                  <span className="val">{params.complexity.toFixed(1)}</span>
                </div>

              </div>

              <div className="reset-row">
                <button
                  className="btn-tiny"
                  title="Reset sliders to defaults"
                  onClick={() => resetParams()}
                >
                  Reset to defaults
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* PRESET BOOKMARKS */}
        <div className={`ctrl-group${openSections.presets ? ' open' : ''}`}>
          <div className="ctrl-group-header" role="button" tabIndex={0} aria-expanded={openSections.presets} onClick={() => toggleSection('presets')} onKeyDown={onHeaderKeyDown('presets')}>
            <div className="ctrl-group-eyebrow-row">
              <div className="ctrl-group-title">
                <span>Saved presets</span>
              </div>
              {savedPresets.length > 0 && (
                <span className="ctrl-group-count" aria-label={`${savedPresets.length} saved presets`}>{savedPresets.length}</span>
              )}
            </div>
            <span className="accordion-arrow" aria-hidden="true"><Chevron /></span>
          </div>

          <div className="ctrl-group-body">
            <div className="ctrl-group-body-inner">
              <div className="preset-actions">
                <button
                  className="xp-btn primary"
                  onClick={() => setShowSave(!showSave)}
                >
                  {showSave ? 'Cancel' : '+ Save current'}
                </button>
                <button
                  className="xp-btn"
                  onClick={handleShare}
                  title="Copy shareable preset link to clipboard"
                >
                  {copiedNotification ? 'Copied' : 'Share link'}
                </button>
              </div>

              {showSave && (
                <div className="save-preset-bar">
                  <label htmlFor="save-preset-name" className="sr-only">
                    Preset name
                  </label>
                  <input
                    id="save-preset-name"
                    type="text"
                    placeholder="Name this look..."
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
                  <div key={p.id} className="preset-chip">
                    <button
                      type="button"
                      className="chip-load"
                      onClick={() => loadPreset(p.id)}
                      title={`Load "${p.name}"`}
                    >
                      <span className="chip-name">{p.name}</span>
                    </button>
                    <button
                      type="button"
                      className="del"
                      onClick={() => deletePreset(p.id)}
                      aria-label={`Delete preset ${p.name}`}
                      title="Delete preset"
                    >
                      x
                    </button>
                  </div>
                ))}
                {savedPresets.length === 0 && (
                  <div className="preset-empty">
                    <div className="preset-empty-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
                        <circle cx="12" cy="12" r="3.2" />
                      </svg>
                    </div>
                    <div className="preset-empty-text">No custom presets yet.</div>
                  </div>
                )}
              </div>
            </div>
          </div>
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
