import ExtensionPanel from './ExtensionPanel'
import type { ExtensionStatus } from '../store'

/**
 * Compact extension status pill pinned to the right end of the menu bar.
 * Click toggles a popover with the full setup steps (same ExtensionPanel
 * content that used to live in the sidebar).
 */
export default function ExtensionBadge({
  status,
  open,
  onToggle,
}: {
  status: string
  open: boolean
  onToggle: () => void
}) {
  const s = status as ExtensionStatus
  const isLive = s === 'EXT LIVE'
  const isSilent = s === 'EXT SILENT'
  const isReady = s === 'EXT READY'
  const isError = s === 'EXT ERROR'

  const dotColor = isLive
    ? '#2ecc40'
    : isSilent
      ? '#ffcc00'
      : isReady
        ? '#7fb3ff'
        : '#ff4136'
  const shortLabel = isLive
    ? 'LIVE'
    : isSilent
      ? 'SILENT'
      : isReady
        ? 'READY'
        : isError
          ? 'ERROR'
          : 'NO EXT'

  return (
    <div
      className="menu-item-wrapper menu-ext-wrapper"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        className={`menu-ext-badge${open ? ' active' : ''}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        title={
          isLive
            ? 'Audio extension connected — click for details'
            : 'Audio extension required for visuals — click for setup'
        }
      >
        <span className="menu-ext-dot" style={{ background: dotColor }} />
        <span className="menu-ext-label">{shortLabel}</span>
      </span>
      {open && (
        <div className="menu-dropdown menu-ext-popover">
          <ExtensionPanel status={status} />
        </div>
      )}
    </div>
  )
}
