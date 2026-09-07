import { useState } from 'react'
import { useStore } from '../store'
import SpotifyAuth from './SpotifyAuth'
import SpotifyPanel from './SpotifyPanel'
import AudioPlayerBox from './AudioPlayerBox'

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
  const isPanelCollapsed = useStore((s) => s.isPanelCollapsed)
  const bratWhiteBg = useStore((s) => s.bratWhiteBg)
  const bratKaraoke = useStore((s) => s.bratKaraoke)

  const setParam = useStore((s) => s.setParam)
  const resetParams = useStore((s) => s.resetParams)
  const togglePanelCollapsed = useStore((s) => s.togglePanelCollapsed)
  const setBratWhiteBg = useStore((s) => s.setBratWhiteBg)
  const setBratKaraoke = useStore((s) => s.setBratKaraoke)

  // Accordion state — audio open on first load, the rest expand on demand
  const [openSections, setOpenSections] = useState({
    audio: true,
    visualizer: false,
  })

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

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
          <span className="panel-header-eyebrow">Controls<span className="panel-header-sub">({currentPresetLabel})</span></span>
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
              {currentPreset === 'brat' ? (
                <>
                  <label className="brat-bg-toggle" htmlFor="brat-karaoke">
                    <span className="brat-bg-label">Karaoke words<span className="panel-header-sub">(BETA)</span></span>
                    <input
                      id="brat-karaoke"
                      type="checkbox"
                      checked={bratKaraoke}
                      onChange={(e) => setBratKaraoke(e.target.checked)}
                    />
                    <span className="brat-switch" aria-hidden="true" />
                  </label>
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
                </>
              ) : null}

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

      </div>

      {/* Static footer — pinned below the scroll area, never scrolls. */}
      <div className="panel-footer">
        <AudioPlayerBox onPrev={onPrev} onNext={onNext} />
        <SpotifyAuth />
      </div>
    </aside>
  )
}
