import { useEffect, useState } from 'react'

/**
 * How long focus may be away before the renderer is parked.
 *
 * A blur that is followed by a focus event within this window was focus moving
 * between elements of the same page — into the Spotify SDK's iframe, say — and
 * parking for that would flicker the scene off and on under the user's cursor.
 * Focus that really left (another application, the devtools) stays gone, so the
 * delay buys nothing but is paid only once.
 */
export const PAUSE_AFTER_MS = 250

export interface FocusState {
  /** The tab is hidden: a background tab, or a window Chrome marked occluded. */
  hidden: boolean
  /** This window, or a document inside it, currently has focus. */
  windowFocused: boolean
}

/**
 * Should the scene stop drawing?
 *
 * Both flags are about the window, never about audio: playback is an <audio>
 * element behind the Web Audio graph and, for Spotify, a separate iframe owned
 * by the SDK. Neither asks the page for frames, so a parked renderer still has
 * sound coming out of it.
 */
export function shouldPauseVisuals({ hidden, windowFocused }: FocusState): boolean {
  return hidden || !windowFocused
}

/** Reads the two flags above off a live document. */
export function readFocusState(
  target: Pick<Document, 'hasFocus' | 'visibilityState'> = document,
): FocusState {
  return {
    hidden: target.visibilityState === 'hidden',
    windowFocused: target.hasFocus(),
  }
}

/**
 * True while the scene should be parked — hidden tab, or focus away from this
 * window for longer than PAUSE_AFTER_MS.
 *
 * Two rules that look like details and are not:
 *
 * - The state starts at *drawing* and is only ever changed by an event. Reading
 *   the two flags at mount instead would park the canvas on load for any
 *   environment that reports a visible page as unfocused — headless Chrome does
 *   exactly that — and a window that never fired a focus event would never
 *   un-park it. A page that loads in an unfocused window draws until the first
 *   blur; a page that loads in a hidden tab has nothing to save anyway, since
 *   the browser is not animating it at all.
 * - The decision is re-read from the live document on every event, rather than
 *   tracked as a boolean the events flip. A flag maintained that way is one
 *   missed or reordered event away from a canvas that never comes back, and
 *   that failure looks exactly like the app having crashed. `focusin` is
 *   listened for alongside `focus` for the same reason: a click is a user
 *   saying they are here, whatever the window event did or did not do.
 */
export function usePauseWhenUnfocused(): boolean {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    let timer = 0

    const evaluate = () => {
      window.clearTimeout(timer)
      if (!shouldPauseVisuals(readFocusState())) {
        // Resuming is immediate: whoever comes back should not watch a stale
        // frame for another 250ms.
        setPaused(false)
        return
      }
      // Parking is delayed — see PAUSE_AFTER_MS. Re-read on the way out so a
      // focus that returned during the delay wins.
      timer = window.setTimeout(
        () => setPaused(shouldPauseVisuals(readFocusState())),
        PAUSE_AFTER_MS,
      )
    }

    window.addEventListener('blur', evaluate)
    window.addEventListener('focus', evaluate)
    document.addEventListener('focusin', evaluate)
    document.addEventListener('visibilitychange', evaluate)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('blur', evaluate)
      window.removeEventListener('focus', evaluate)
      document.removeEventListener('focusin', evaluate)
      document.removeEventListener('visibilitychange', evaluate)
    }
  }, [])

  return paused
}
