import { useStore } from '../store'

export default function StatusBar({
  metricVisibility,
  extensionStatus,
}: {
  metricVisibility: Record<string, boolean>
  extensionStatus: string
}) {
  const metrics = useStore((s) => s.metrics)
  const isSpotifyAuthed = useStore((s) => s.isSpotifyAuthed)
  const spotifyPlaying = useStore((s) => s.spotifyPlaying)
  const currentPreset = useStore((s) => s.currentPreset)
  const liveAudio = metrics.sourceMode === 'live'

  const fps = Math.round(metrics.fps)
  const fpsClass = fps >= 55 ? 'fps-good' : fps >= 30 ? 'fps-mid' : 'fps-low'

  const sourceName = extensionStatus
    ? extensionStatus
    : liveAudio
    ? 'LIVE AUDIO'
    : isSpotifyAuthed && spotifyPlaying
    ? 'SPOTIFY — NEEDS EXTENSION'
    : 'IDLE — INSTALL EXTENSION'

  return (
    <footer className="status-bar" role="status" aria-label="System status">
      {Object.values(metricVisibility).some(Boolean) && (
        <div className="status-metrics-group">
          {metricVisibility.fps && (
            <span className="status-section">
              <span className={`status-indicator ${fpsClass}`} />
              <span className="status-label">FPS</span>
              <span className="status-val tabular">{fps}</span>
            </span>
          )}

          {metricVisibility.source && (
            <span className="status-section">
              <span className={`status-indicator ${liveAudio ? 'dot-live' : 'dot-idle'}`} />
              <span className="status-label">SRC</span>
              <span className="status-val">{sourceName}</span>
            </span>
          )}

          {metricVisibility.bass && (
            <span className="status-section">
              <span className="status-label">BASS</span>
              <span className="status-meter">
                <span
                  className="status-meter-fill bass-fill"
                  style={{ width: `${Math.min(100, Math.round(metrics.bass * 100))}%` }}
                />
              </span>
              <span className="status-val tabular">{Math.round(metrics.bass * 100)}%</span>
            </span>
          )}

          {metricVisibility.mid && (
            <span className="status-section">
              <span className="status-label">MID</span>
              <span className="status-meter">
                <span
                  className="status-meter-fill mid-fill"
                  style={{ width: `${Math.min(100, Math.round(metrics.mid * 100))}%` }}
                />
              </span>
              <span className="status-val tabular">{Math.round(metrics.mid * 100)}%</span>
            </span>
          )}

          {metricVisibility.treble && (
            <span className="status-section">
              <span className="status-label">TREBLE</span>
              <span className="status-meter">
                <span
                  className="status-meter-fill treble-fill"
                  style={{ width: `${Math.min(100, Math.round(metrics.treble * 100))}%` }}
                />
              </span>
              <span className="status-val tabular">{Math.round(metrics.treble * 100)}%</span>
            </span>
          )}

          {metricVisibility.level && (
            <span className="status-section">
              <span className="status-label">LEVEL</span>
              <span className="status-meter">
                <span
                  className="status-meter-fill level-fill"
                  style={{ width: `${Math.min(100, Math.round(metrics.overall * 100))}%` }}
                />
              </span>
              <span className="status-val tabular">{Math.round(metrics.overall * 100)}%</span>
            </span>
          )}
        </div>
      )}

      <span style={{ flex: 1 }} />

      <div className="status-right">
        <span className="status-preset-tag">
          Preset: <strong>{currentPreset}</strong>
        </span>
        <span className="status-divider">|</span>
        <span className="status-version">wavi.lol v2.2</span>
      </div>
    </footer>
  )
}
