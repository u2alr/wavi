import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FrameStats from './frameStats'

// Frame counting is module state, so each case needs its own module instance or
// it would inherit the previous case's open window.
let countFrame: typeof FrameStats.countFrame
let readFrameRate: typeof FrameStats.readFrameRate

beforeEach(async () => {
  vi.resetModules()
  ;({ countFrame, readFrameRate } = await import('./frameStats'))
})

/** Drives `frames` frames over `durationMs` and returns when the last one was. */
function render(frames: number, durationMs: number, startAt = 10_000) {
  const step = durationMs / frames
  for (let i = 0; i < frames; i++) countFrame(startAt + i * step)
  return startAt + durationMs
}

describe('readFrameRate', () => {
  it('is zero before anything has been drawn', () => {
    expect(readFrameRate(10_000)).toBe(0)
  })

  it('does not invent a rate from a single frame', () => {
    countFrame(10_000)
    expect(readFrameRate(10_500)).toBe(0)
  })

  it('reports the rate the frames were drawn at', () => {
    // 60 frames over a second is 60 FPS, whatever the display is doing.
    render(60, 1000)
    expect(readFrameRate(10_999)).toBeCloseTo(60, 0)
  })

  it('follows a slower renderer', () => {
    const now = render(30, 1000)
    expect(readFrameRate(now + 10)).toBeCloseTo(30, 0)
  })

  it('drops to zero once the renderer has stopped', () => {
    // This is the parked-renderer case: the number must not keep claiming the
    // rate from before the pause.
    const now = render(60, 1000)
    expect(readFrameRate(now + 100)).toBeCloseTo(60, 0)
    expect(readFrameRate(now + 1000)).toBe(0)
  })

  it('resumes reporting when frames come back', () => {
    let now = render(60, 1000)
    expect(readFrameRate(now + 5000)).toBe(0)
    now = render(60, 1000, now + 5000)
    expect(readFrameRate(now + 100)).toBeCloseTo(60, 0)
  })

  it('re-measures rather than averaging a rate change away', () => {
    let now = render(120, 1000)
    expect(readFrameRate(now + 10)).toBeCloseTo(120, 0)
    now = render(30, 1000, now + 10)
    expect(readFrameRate(now + 10)).toBeCloseTo(30, 0)
  })
})
