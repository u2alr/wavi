import { useState } from 'react'
import { useStore } from '../store'

/**
 * Saved-looks bookmark section living inside the Presets menu dropdown.
 * Toasts are reported up via `notify` so the toast region can live at the
 * window root (this component mounts inside an absolutely-positioned
 * dropdown, which would corrupt absolute toast positioning).
 */
export default function SavedLooksSection({
  onAction,
  notify,
}: {
  onAction: () => void
  notify: (text: string, error?: boolean) => void
}) {
  const savedPresets = useStore((s) => s.savedPresets)
  const currentPreset = useStore((s) => s.currentPreset)
  const params = useStore((s) => s.params)
  const savePreset = useStore((s) => s.savePreset)
  const loadPreset = useStore((s) => s.loadPreset)
  const deletePreset = useStore((s) => s.deletePreset)

  const [saveName, setSaveName] = useState('')
  const [showSave, setShowSave] = useState(false)
  const [copied, setCopied] = useState(false)

  const commitSave = () => {
    const name = saveName.trim()
    if (!name) return
    savePreset(name)
    setSaveName('')
    setShowSave(false)
    notify(`Preset "${name}" saved`)
  }

  const handleShare = async () => {
    const data = btoa(JSON.stringify({ presetType: currentPreset, params }))
    const url = `${window.location.origin}${window.location.pathname}#p=${data}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      notify('Share link copied to clipboard')
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      notify('Could not copy link — clipboard blocked', true)
    }
  }

  return (
    <>
      <div className="dropdown-divider" />
      <div className="menu-section-label">SAVED LOOKS</div>
      <div className="menu-preset-actions">
        <button
          type="button"
          className="xp-btn primary"
          onClick={() => setShowSave((s) => !s)}
        >
          {showSave ? 'Cancel' : '+ Save current'}
        </button>
        <button
          type="button"
          className="xp-btn"
          onClick={() => handleShare().catch(() => {})}
          title="Copy shareable preset link to clipboard"
        >
          {copied ? 'Copied' : 'Share link'}
        </button>
      </div>

      {showSave && (
        <div className="menu-save-row">
          <label htmlFor="menu-save-preset-name" className="sr-only">
            Preset name
          </label>
          <input
            id="menu-save-preset-name"
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
          <button type="button" className="xp-btn primary" onClick={commitSave}>
            Save
          </button>
        </div>
      )}

      <div className="menu-saved-list">
        {savedPresets.map((p) => (
          <div key={p.id} className="dropdown-item menu-saved-row">
            <span
              className="menu-saved-load"
              role="button"
              tabIndex={0}
              title={`Load "${p.name}"`}
              onClick={() => {
                loadPreset(p.id)
                onAction()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  loadPreset(p.id)
                  onAction()
                }
              }}
            >
              {p.name}
            </span>
            <button
              type="button"
              className="menu-saved-del"
              onClick={() => deletePreset(p.id)}
              aria-label={`Delete preset ${p.name}`}
              title="Delete preset"
            >
              x
            </button>
          </div>
        ))}
        {savedPresets.length === 0 && (
          <div className="menu-saved-empty">No custom presets yet.</div>
        )}
      </div>
    </>
  )
}
