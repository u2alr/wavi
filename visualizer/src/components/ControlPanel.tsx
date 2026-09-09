import { useState } from 'react'
import { useStore, PRESET_PARAM_KEYS, presetParamsFor, type PresetParamKey } from '../store'
import SpotifyAuth from './SpotifyAuth'
import SpotifyPanel from './SpotifyPanel'
import AudioPlayerBox from './AudioPlayerBox'

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

interface SliderDef {
  key: PresetParamKey
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => { text: string; valuText: string }
}

const oneDecimal = (v: number) => ({ text: v.toFixed(1), valuText: v.toFixed(1) })

const SLIDERS: SliderDef[] = [
  { key: 'intensity', label: 'Intensity', min: 0.5, max: 3, step: 0.1, format: oneDecimal },
  { key: 'sensitivity', label: 'Sensitivity', min: 0.5, max: 5, step: 0.1, format: oneDecimal },
  { key: 'bassAmp', label: 'Bass Amp', min: 0, max: 3, step: 0.1, format: oneDecimal },
  { key: 'midAmp', label: 'Mid Amp', min: 0, max: 3, step: 0.1, format: oneDecimal },
  { key: 'trebleAmp', label: 'Treble Amp', min: 0, max: 3, step: 0.1, format: oneDecimal },
  {
    key: 'hueShift',
    label: 'Hue Shift',
    min: 0,
    max: 360,
    step: 1,
    format: (v) => ({ text: `${Math.round(v)}°`, valuText: `${Math.round(v)} degrees` }),
  },
  { key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.1, format: oneDecimal },
  { key: 'complexity', label: 'Complexity', min: 0.5, max: 3, step: 0.1, format: oneDecimal },
]

export default function ControlPanel({
  onPrev,
  onNext,
}: {
  onPrev: () => void
  onNext: () => void
}) {
  // Granular Zustand selectors to prevent unnecessary re-renders
  const currentPreset = useStore((s) => s.currentPreset)
  const presetParams = useStore((s) => s.presetParams)
  const params = { ...presetParamsFor({ currentPreset, presetParams }) }
  const isPanelCollapsed = useStore((s) => s.isPanelCollapsed)
  const isSpotifyAuthed = useStore((s) => s.isSpotifyAuthed)
  const bratWhiteBg = useStore((s) => s.bratWhiteBg)
  const bratKaraoke = useStore((s) => s.bratKaraoke)
  const amFlip = useStore((s) => s.amFlip)

  const setParam = useStore((s) => s.setParam)
  const resetParams = useStore((s) => s.resetParams)
  const setBratWhiteBg = useStore((s) => s.setBratWhiteBg)
  const setBratKaraoke = useStore((s) => s.setBratKaraoke)
  const setAmFlip = useStore((s) => s.setAmFlip)

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

  return (
    <aside className={`control-panel ${isPanelCollapsed ? 'collapsed' : ''}`} aria-label="Visualizer Controls">
      <div className="control-panel-scroll">
        {/* AUDIO SOURCE SECTION */}
        <div className={`ctrl-group audio-source-group${openSections.audio ? ' open' : ''}`}>
          <div className="ctrl-group-header" role="button" tabIndex={0} id="ctrl-hdr-audio" aria-controls="ctrl-body-audio" aria-expanded={openSections.audio} onClick={() => toggleSection('audio')} onKeyDown={onHeaderKeyDown('audio')}>
            <div className="ctrl-group-eyebrow-row">
              <div className="ctrl-group-title">
                <span>Audio source</span>
              </div>
            </div>
            <span className="accordion-arrow" aria-hidden="true"><Chevron /></span>
          </div>

          <div className="ctrl-group-body" id="ctrl-body-audio" role="region" aria-labelledby="ctrl-hdr-audio">
            <div className="ctrl-group-body-inner">
              <SpotifyAuth />
              {!isSpotifyAuthed && (
                <p className="field-hint audio-connect-hint">
                  Connect Spotify to search &amp; play tracks, or use File &rarr; Open&hellip; for local audio.
                </p>
              )}
              <SpotifyPanel />
            </div>
          </div>
        </div>

        {/* VISUALIZER PRESETS & SHADER PARAMS */}
        <div className={`ctrl-group visualizer-group${openSections.visualizer ? ' open' : ''}`}>
          <div className="ctrl-group-header" role="button" tabIndex={0} id="ctrl-hdr-visualizer" aria-controls="ctrl-body-visualizer" aria-expanded={openSections.visualizer} onClick={() => toggleSection('visualizer')} onKeyDown={onHeaderKeyDown('visualizer')}>
            <div className="ctrl-group-eyebrow-row">
              <div className="ctrl-group-title">
                <span>Visualizer engine</span>
              </div>
            </div>
            <span className="accordion-arrow" aria-hidden="true"><Chevron /></span>
          </div>

          <div className="ctrl-group-body" id="ctrl-body-visualizer" role="region" aria-labelledby="ctrl-hdr-visualizer">
            <div className="ctrl-group-body-inner">
              {currentPreset === 'brat' ? (
                <>
                  <label className="brat-bg-toggle" htmlFor="brat-karaoke">
                    <span className="brat-bg-label">Karaoke<span className="panel-header-sub">(BETA)</span></span>
                    <input
                      id="brat-karaoke"
                      type="checkbox"
                      checked={bratKaraoke}
                      onChange={(e) => setBratKaraoke(e.target.checked)}
                    />
                    <span className="brat-switch" aria-hidden="true" />
                  </label>
                  <label className="brat-bg-toggle" htmlFor="brat-white-bg">
                    <span className="brat-bg-label">WhiteBG</span>
                    <input
                      id="brat-white-bg"
                      type="checkbox"
                      checked={bratWhiteBg}
                      onChange={(e) => setBratWhiteBg(e.target.checked)}
                    />
                    <span className="brat-switch" aria-hidden="true" />
                  </label>
                </>
              ) : currentPreset === 'amPreset' || currentPreset === 'am2Preset' ? (
                <label className="brat-bg-toggle" htmlFor="am-flip">
                  <span className="brat-bg-label">Flip</span>
                  <input
                    id="am-flip"
                    type="checkbox"
                    checked={amFlip}
                    onChange={(e) => setAmFlip(e.target.checked)}
                  />
                  <span className="brat-switch" aria-hidden="true" />
                </label>
              ) : null}

              <div className="sliders-container">
                {SLIDERS.filter((s) => (PRESET_PARAM_KEYS[currentPreset] ?? []).includes(s.key)).map(
                  (s) => {
                    const v = params[s.key]
                    const shown = s.format(v)
                    return (
                      <div className="ctrl-row" key={s.key}>
                        <div className="slider-label">
                          <label htmlFor={`param-${s.key}`}>{s.label}</label>
                        </div>
                        <input
                          id={`param-${s.key}`}
                          type="range"
                          min={s.min}
                          max={s.max}
                          step={s.step}
                          value={v}
                          aria-valuetext={shown.valuText}
                          style={{ ['--p' as string]: pct(v, s.min, s.max) }}
                          onChange={(e) => setParam(s.key, +e.target.value)}
                        />
                        <span className="val">{shown.text}</span>
                      </div>
                    )
                  },
                )}
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
      </div>
    </aside>
  )
}
