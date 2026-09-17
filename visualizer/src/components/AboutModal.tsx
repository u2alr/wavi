import { useStore } from '../store'

export default function AboutModal() {
  const activeModal = useStore((s) => s.activeModal)
  const setActiveModal = useStore((s) => s.setActiveModal)

  if (!activeModal) return null

  return (
    <div className="modal-backdrop" onClick={() => setActiveModal(null)}>
      <div
        className="modal-window xp-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="title-bar dialog-title-bar">
          <div className="title-bar-text">
            <span className="dialog-icon">i</span>
            <span id="dialog-title">About wavi.lol &amp; Shortcuts</span>
          </div>
          <button
            className="modal-close-btn"
            onClick={() => setActiveModal(null)}
            title="Close"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          <div className="dialog-header-banner">
            <div className="dialog-logo">w</div>
            <div>
              <h3 className="dialog-app-name">wavi.lol</h3>
              <p className="dialog-app-desc">
                Real-Time Audio Shader Visualizer · v2.2
              </p>
            </div>
          </div>

          <div className="dialog-section-title">KEYBOARD SHORTCUTS</div>
          <div className="shortcuts-grid">
            <div className="shortcut-item">
              <kbd className="key-badge">Space</kbd>
              <span>Play / Pause Audio</span>
            </div>
            <div className="shortcut-item">
              <kbd className="key-badge">A</kbd> / <kbd className="key-badge">D</kbd>
              <span>Previous / Next Preset</span>
            </div>
            <div className="shortcut-item">
              <kbd className="key-badge">Left</kbd> / <kbd className="key-badge">Right</kbd>
              <span>Cycle Presets</span>
            </div>
            <div className="shortcut-item">
              <kbd className="key-badge">H</kbd>
              <span>Toggle Controls Sidebar</span>
            </div>
            <div className="shortcut-item">
              <kbd className="key-badge">F</kbd>
              <span>Toggle Fullscreen</span>
            </div>
            <div className="shortcut-item">
              <kbd className="key-badge">M</kbd>
              <span>Mute / Unmute Volume</span>
            </div>
            <div className="shortcut-item">
              <kbd className="key-badge">Esc</kbd>
              <span>Close Dialog / Exit Fullscreen</span>
            </div>
          </div>

          <div className="dialog-section-title" style={{ marginTop: 12 }}>
            AUDIO REACTIVE ENGINE
          </div>
          <p className="dialog-engine-note">
            wavi.lol translates multi-band audio (Sub-Bass, Mid, Treble) through custom
            GLSL fragment shaders with dynamic fluid motion, blooming petals, and ribbon silk harmonics.
          </p>

          <div className="dialog-actions">
            <button className="xp-btn primary dialog-ok-btn" onClick={() => setActiveModal(null)}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
