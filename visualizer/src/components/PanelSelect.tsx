import { useEffect, useId, useRef, useState } from 'react'

export interface PanelOption {
  value: string
  label: string
}

export default function PanelSelect({
  value,
  options,
  onChange,
  placeholder = 'Choose...',
  ariaLabel,
  disabled = false,
  id,
  searchable = false,
  searchPlaceholder = 'Search...',
}: {
  value: string
  options: PanelOption[]
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
  id?: string
  searchable?: boolean
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selected = options.find((o) => o.value === value) ?? null
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open ])

  const commit = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  const openMenu = () => {
    const idx = options.findIndex((o) => o.value === value)
    setActiveIndex(idx >= 0 ? idx : 0)
    setQuery('')
    setOpen(true)
  }

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      if (open) setOpen(false)
      else openMenu()
    }
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % visible.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + visible.length) % visible.length)
    } else if (e.key === 'Enter' || e.key === ' ') {
      if ((e.target as HTMLElement).tagName === 'INPUT' && e.key === ' ') return
      e.preventDefault()
      const opt = visible[activeIndex]
      if (opt) commit(opt.value)
    }
  }

  return (
    <div ref={rootRef} className="panel-select" data-open={open || undefined}>
      <button
        type="button"
        id={id}
        className="panel-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (open) setOpen(false)
          else openMenu()
        }}
        onKeyDown={onTriggerKey}
      >
        <span className="panel-select-value">{selected ? selected.label : placeholder}</span>
        <span className="panel-select-chevron-slot" aria-hidden="true">
          <svg className="panel-select-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="panel-select-popover"
          onKeyDown={onListKey}
        >
          {searchable && (
            <div className="panel-select-search">
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActiveIndex(0)
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          {visible.length === 0 && (
            <div className="panel-select-empty" aria-disabled="true">
              {options.length === 0 ? 'No options yet' : 'No matches'}
            </div>
          )}
          {visible.map((opt, i) => {
            const isSelected = opt.value === value
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                data-active={i === activeIndex || undefined}
                className={`panel-select-option${isSelected ? ' selected' : ''}`}
                onClick={() => commit(opt.value)}
                onMouseEnter={() => setActiveIndex(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    commit(opt.value)
                  }
                }}
              >
                <span className="panel-select-option-label">{opt.label}</span>
                {isSelected ? (
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5l3.5 3.5L13 4.5" />
                  </svg>
                ) : (
                  <span className="panel-select-check-spacer" aria-hidden="true" />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
