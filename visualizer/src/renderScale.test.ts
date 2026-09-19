import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RenderScale from './renderScale'

// The scaler keeps its state in module scope, so each case needs its own module
// instance rather than inheriting the previous case's scale history.
let nextScaleState: typeof RenderScale.nextScaleState
let initialScaleState: typeof RenderScale.initialScaleState
let budgetFps: typeof RenderScale.budgetFps
let resolveDpr: typeof RenderScale.resolveDpr
let MIN_RENDER_SCALE: number
let readRenderScale: typeof RenderScale.readRenderScale
let reportScaleSample: typeof RenderScale.reportScaleSample
let resetRenderScale: typeof RenderScale.resetRenderScale

beforeEach(async () => {
  vi.resetModules()
  ;({
    nextScaleState,
    initialScaleState,
    budgetFps,
    resolveDpr,
    MIN_RENDER_SCALE,
    readRenderScale,
    reportScaleSample,
    resetRenderScale,
  } = await import('./renderScale'))
})

/** A renderer holding the default 120 cap, well past the settle window. */
const keeping = { drawnFps: 120, budgetFps: 120, parked: false, now: 10_000 }

/** Feeds the same sample `times` over, advancing the clock a sample apart. */
function repeat(state: RenderScale.ScaleState, sample: typeof keeping, times: number) {
  let current = state
  for (let i = 0; i < times; i++) {
    current = nextScaleState(current, { ...sample, now: sample.now + i * 1000 })
  }
  return current
}

describe('nextScaleState', () => {
  it('leaves a renderer that holds its target alone', () => {
    expect(repeat(initialScaleState(), keeping, 20).scale).toBe(1)
  })

  it('leaves a healthy 60Hz panel alone, where 60 of a 120 cap is the app working', () => {
    // The band the low-water mark has to stay clear of: a 60Hz display holding
    // the default cap draws exactly half the target by design.
    expect(repeat(initialScaleState(), { ...keeping, drawnFps: 60 }, 20).scale).toBe(1)
  })

  it('leaves a renderer alone while it is parked', () => {
    // A parked scene draws nothing on purpose; reading that as "too slow" is
    // what would soften the canvas every time the tab lost focus.
    expect(repeat(initialScaleState(), { ...keeping, drawnFps: 0, parked: true }, 20).scale).toBe(1)
  })

  it('ignores a missing frame reading', () => {
    expect(repeat(initialScaleState(), { ...keeping, drawnFps: 0 }, 20).scale).toBe(1)
  })

  it('ignores a rate too low to be a slow renderer', () => {
    // What a throttled or occluded window looks like. Acting on it would soften
    // the canvas for a machine that was only in the background, and leave it
    // softened after the window came back.
    expect(repeat(initialScaleState(), { ...keeping, drawnFps: 1 }, 20).scale).toBe(1)
  })

  it('needs two missed windows before it moves', () => {
    // One short window is a garbage collection or another app taking the GPU,
    // not a shader that cannot keep up.
    const slow = { ...keeping, drawnFps: 20 }
    const once = repeat(initialScaleState(), slow, 1)
    expect(once.scale).toBe(1)
    expect(repeat(once, slow, 1).scale).toBeLessThan(1)
  })

  it('takes one step rather than creeping toward the target', () => {
    // A quarter of the target means a quarter of the pixels, so half the linear
    // resolution; the 0.6 floor is the binding constraint at this water mark,
    // which is intended — anything slow enough to clear LOW_WATER is short
    // enough that the floor is what the arithmetic asks for anyway.
    const state = repeat(initialScaleState(), { ...keeping, drawnFps: 30 }, 2)
    expect(state.scale).toBe(MIN_RENDER_SCALE)
  })

  it('never goes below the floor, however slow the renderer', () => {
    expect(repeat(initialScaleState(), { ...keeping, drawnFps: 2 }, 40).scale).toBe(MIN_RENDER_SCALE)
  })

  it('stops moving once it is at the floor', () => {
    const atFloor = repeat(initialScaleState(), { ...keeping, drawnFps: 2 }, 40)
    expect(repeat(atFloor, { ...keeping, drawnFps: 1 }, 20).scale).toBe(MIN_RENDER_SCALE)
  })

  it('holds off while the window after a move is still settling', () => {
    const dropped = repeat(initialScaleState(), { ...keeping, drawnFps: 20 }, 2)
    // The frames right after a resolution change are not evidence: the buffer
    // was just reallocated.
    const immediate = nextScaleState(dropped, {
      ...keeping,
      drawnFps: 5,
      now: dropped.changedAt + 500,
    })
    expect(immediate.scale).toBe(dropped.scale)
  })

  it('does not soften the canvas when the cap itself is the limit', () => {
    const state = repeat(
      initialScaleState(),
      { drawnFps: 30, budgetFps: budgetFps(30), parked: false, now: 10_000 },
      20,
    )
    expect(state.scale).toBe(1)
  })

  it('starts at full resolution', () => {
    expect(initialScaleState().scale).toBe(1)
  })
})

describe('budgetFps', () => {
  it('is the cap the renderer was asked for', () => {
    expect(budgetFps(120)).toBe(120)
    expect(budgetFps(30)).toBe(30)
  })

  it('stands in for an unlimited cap', () => {
    // Unlimited asks for as many frames as the renderer can produce, so the
    // target is the rate a display could actually take, not zero.
    expect(budgetFps(0)).toBeGreaterThan(0)
  })
})

describe('module state', () => {
  it('drops through the real entry point and returns to full resolution', () => {
    // The transitions the scene actually drives, including the settle window in
    // between: six samples a second apart is two misses and the hold-off.
    for (let i = 0; i < 6; i++) {
      reportScaleSample({ drawnFps: 10, budgetFps: 120, parked: false, now: 10_000 + i * 1000 })
    }
    expect(readRenderScale()).toBe(MIN_RENDER_SCALE)

    resetRenderScale(20_000)
    expect(readRenderScale()).toBe(1)
  })

  it('holds full resolution for a parked reading', () => {
    reportScaleSample({ drawnFps: 0, budgetFps: 120, parked: true, now: 10_000 })
    expect(readRenderScale()).toBe(1)
  })
})

describe('resolveDpr', () => {
  it('clamps a high-density display to the same ceiling as before', () => {
    expect(resolveDpr(2, 1)).toBe(1.5)
  })

  it('never renders below one CSS pixel per pixel on a standard display', () => {
    expect(resolveDpr(1, 1)).toBe(1)
  })

  it('applies the scale to the clamped ratio', () => {
    expect(resolveDpr(1, 0.6)).toBeCloseTo(0.6, 3)
    expect(resolveDpr(2, 0.6)).toBeCloseTo(0.9, 3)
  })
})
