import { useState } from 'react'
import { useStore } from '../store'
import SpotifyAuth from './SpotifyAuth'
import SpotifyPanel from './SpotifyPanel'

export default function ControlPanel({ onLoadFiles }: { onLoadFiles: () => void }) {
  const {
    currentPreset, params, savedPresets,
    setCurrentPreset, setParam, savePreset, loadPreset, deletePreset,
  } = useStore()

  const [saveName, setSaveName] = useState('')
  const [showSave, setShowSave] = useState(false)

  const handleShare = () => {
    const data = btoa(JSON.stringify({ presetType: currentPreset, params }))
    const url = `${window.location.origin}${window.location.pathname}#p=${data}`
    navigator.clipboard.writeText(url)
    alert('Preset link copied to clipboard!')
  }

  return (
    <div className="control-panel">
      {/* AUDIO */}
      <div className="ctrl-group">
        <h4>Audio Source</h4>
        <div className="audio-source-heading">LOCAL FILES</div>
        <button className="xp-btn primary" onClick={onLoadFiles} style={{ width: '100%', marginBottom: 6 }}>
          Load Audio Files
        </button>
        <div className="audio-source-status">{useStore((s) => s.playlist.length)} local track(s)</div>
        <div className="audio-source-heading spotify-heading">SPOTIFY STREAMING</div>
        <SpotifyAuth />
        <SpotifyPanel />
      </div>

      {/* PRESET + PARAMS */}
      <div className="ctrl-group">
        <h4>Visualizer</h4>
        <select value={currentPreset} onChange={(e) => setCurrentPreset(e.target.value)}
          style={{ width: '100%', marginBottom: 6 }}>
          <option value="mellowDrift">Mellow Drift (Silk Instrumentals)</option>
          <option value="prismaticGarden">Prismatic Garden (Flowing Petals)</option>
          <option value="auroraSilk">Aurora Silk (Flowing Ribbons)</option>
          <option value="brat">brat (lyrics)</option>
        </select>
        <div className="ctrl-row">
          <label>Intensity</label>
          <input type="range" min="0.5" max="3" step="0.1"
            value={params.intensity} onChange={(e) => setParam('intensity', +e.target.value)} />
          <span className="val">{params.intensity.toFixed(1)}</span>
        </div>
        <div className="ctrl-row">
          <label>Sensitivity</label>
          <input type="range" min="0.5" max="5" step="0.1"
            value={params.sensitivity} onChange={(e) => setParam('sensitivity', +e.target.value)} />
          <span className="val">{params.sensitivity.toFixed(1)}x</span>
        </div>
        <div className="ctrl-row">
          <label>Hue Shift</label>
          <input type="range" min="0" max="360" step="1"
            value={params.hueShift} onChange={(e) => setParam('hueShift', +e.target.value)} />
          <span className="val">{params.hueShift}°</span>
        </div>
        <div className="ctrl-row">
          <label>Speed</label>
          <input type="range" min="0.1" max="3" step="0.1"
            value={params.speed} onChange={(e) => setParam('speed', +e.target.value)} />
          <span className="val">{params.speed.toFixed(1)}</span>
        </div>
        <div className="ctrl-row">
          <label>Complexity</label>
          <input type="range" min="0.5" max="3" step="0.1"
            value={params.complexity} onChange={(e) => setParam('complexity', +e.target.value)} />
          <span className="val">{params.complexity.toFixed(1)}</span>
        </div>
        <div className="ctrl-row">
          <label>Thickness</label>
          <input type="range" min="0.3" max="3" step="0.1"
            value={params.thickness} onChange={(e) => setParam('thickness', +e.target.value)} />
          <span className="val">{params.thickness.toFixed(1)}</span>
        </div>
      </div>

      {/* SAVE / LOAD / SHARE */}
      <div className="ctrl-group">
        <h4>Presets</h4>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <button className="xp-btn" onClick={() => setShowSave(!showSave)}>+ Save</button>
          <button className="xp-btn" onClick={handleShare}>Share Link</button>
        </div>
        {showSave && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input type="text" placeholder="Preset name..." value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              style={{ flex: 1, fontSize: 10, padding: '2px 4px', border: '1px solid #ACA899' }} />
            <button className="xp-btn" onClick={() => { if (saveName) { savePreset(saveName); setSaveName(''); setShowSave(false) } }}>
              OK
            </button>
          </div>
        )}
        <div className="preset-list">
          {savedPresets.map((p) => (
            <div key={p.id} className="preset-chip" onClick={() => loadPreset(p.id)}>
              {p.name}
              <span className="del" onClick={(e) => { e.stopPropagation(); deletePreset(p.id) }}>×</span>
            </div>
          ))}
          {savedPresets.length === 0 && <span style={{ fontSize: 9, color: '#999' }}>No saved presets</span>}
        </div>
      </div>
    </div>
  )
}
