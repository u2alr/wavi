import { useState } from 'react'

type ExtensionStatus = '' | 'EXT LIVE' | 'EXT SILENT' | 'EXT READY' | 'EXT ERROR'

/**
 * Extension install/usage guard.
 * The visualizer has no synthetic fallback — real FFT data only comes from
 * the "Visualizer Audio Bridge" MV3 extension (tabCapture -> offscreen analyser).
 * This panel makes sure the user has it installed and capturing.
 */
export default function ExtensionPanel({ status }: { status: string }) {
  const [expanded, setExpanded] = useState(status === '' || status === 'EXT ERROR')
  const [copied, setCopied] = useState(false)

  const s = status as ExtensionStatus
  const isLive = s === 'EXT LIVE'
  const isSilent = s === 'EXT SILENT'
  const isReady = s === 'EXT READY'
  const isError = s === 'EXT ERROR'

  const dotColor = isLive ? '#2ecc40' : isSilent ? '#ffcc00' : isReady ? '#7fb3ff' : '#ff4136'
  const label = isLive
    ? 'Extension connected — live audio'
    : isSilent
      ? 'Extension capturing — no signal yet'
      : isReady
        ? 'Extension installed — click its toolbar button to start capture'
        : isError
          ? 'Extension error — see steps below'
          : 'Extension not detected — required for visuals'

  const copyPath = () => {
    navigator.clipboard.writeText('visualizer/extension').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div
      className="extension-panel"
      style={{
        border: '1px solid rgba(0, 0, 0, 0.08)',
        background: isLive ? '#eef7d8' : '#f4f4f6',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 8,
      }}
      role="status"
      aria-label="Audio extension status"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 'bold', flex: 1 }}>{label}</span>
        <button
          className="btn-tiny"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Hide setup steps' : 'Show setup steps'}
        >
          {expanded ? 'Hide' : 'Setup'}
        </button>
      </div>

      {!isLive && (
        <div style={{ fontSize: 11, marginTop: 6, color: '#6e6e73' }}>
          Visuals stay idle without the extension. No synthetic estimate is used.
        </div>
      )}

      {expanded && (
        <ol style={{ fontSize: 11, margin: '8px 0 4px 16px', padding: 0, lineHeight: 1.6 }}>
          <li>
            Open <code>chrome://extensions</code> (or <code>edge://extensions</code>), enable{' '}
            <b>Developer mode</b>.
          </li>
          <li>
            Click <b>Load unpacked</b> → select the <code>visualizer/extension</code> folder.{' '}
            <button className="btn-tiny" onClick={copyPath} title="Copy folder path">
              {copied ? 'Copied!' : 'Copy path'}
            </button>
          </li>
          <li>
            Open this app (<code>http://127.0.0.1:5173/</code>), start Spotify or local playback{' '}
            <b>in this same tab</b>.
          </li>
          <li>
            Click the <b>wavi.lol Audio Bridge</b> toolbar button once per session — status above
            should turn <b>EXT LIVE</b>.
          </li>
          {isSilent && (
            <li>
              <b>EXT SILENT</b> means capture works but the tab is quiet — press play (signal must
              exceed the silence threshold).
            </li>
          )}
        </ol>
      )}
    </div>
  )
}
