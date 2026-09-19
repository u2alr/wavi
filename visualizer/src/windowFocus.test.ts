import { describe, expect, it } from 'vitest'
import { readFocusState, shouldPauseVisuals } from './windowFocus'

describe('shouldPauseVisuals', () => {
  it('keeps drawing while the window is focused and visible', () => {
    expect(shouldPauseVisuals({ hidden: false, windowFocused: true })).toBe(false)
  })

  it('parks for a hidden tab', () => {
    expect(shouldPauseVisuals({ hidden: true, windowFocused: true })).toBe(true)
  })

  it('parks when focus went to another window', () => {
    expect(shouldPauseVisuals({ hidden: false, windowFocused: false })).toBe(true)
  })

  it('parks only once — hidden and unfocused is not a different state', () => {
    expect(shouldPauseVisuals({ hidden: true, windowFocused: false })).toBe(true)
  })
})

describe('readFocusState', () => {
  const doc = (state: DocumentVisibilityState, focused: boolean) =>
    ({ visibilityState: state, hasFocus: () => focused }) as Pick<
      Document,
      'hasFocus' | 'visibilityState'
    >

  it('reads a focused, visible document as watching', () => {
    expect(readFocusState(doc('visible', true))).toEqual({ hidden: false, windowFocused: true })
  })

  it('reads only "hidden" as hidden', () => {
    expect(readFocusState(doc('hidden', true)).hidden).toBe(true)
    expect(readFocusState(doc('visible', false)).hidden).toBe(false)
  })

  it('takes focus from document.hasFocus(), not from the visibility state', () => {
    // A window can be on screen and still be behind another application, which
    // is the case this whole feature exists for.
    const state = readFocusState(doc('visible', false))
    expect(state.windowFocused).toBe(false)
    expect(shouldPauseVisuals(state)).toBe(true)
  })
})
