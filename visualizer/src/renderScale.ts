import { useEffect, useSyncExternalStore } from 'react'
import { readFrameRate } from './frameStats'

/**
 * Adaptive render resolution.
 *
 * Every preset is one full-screen fragment shader, so a frame costs
 * pixels × shader cost. Measured on a software rasteriser, at one canvas size and
 * with nothing varying but the drawing buffer: a five-octave fbm preset drew
 * 16 fps at full resolution and 32–35 fps at this module's 0.6 floor, i.e. 2.1x
 * for 36% of the pixels, and the frame rate tracks the pixel count closely. So the one lever
 * that cuts GPU cost on a machine like that, without changing the look, is
 * drawing fewer pixels. That is all this does.
 *
 * What counts as "too slow", and why it is not measured against the display.
 * The obvious target is the display's refresh rate, and the obvious way to get
 * it is to time the requestAnimationFrame cadence. That does not work here, and
 * the measurement says so plainly: in this app a frame's drawing happens on the
 * thread that also serves rAF, so the cadence *is* the rate the app is achieving
 * — 17–101 Hz on the same machine in the same session, tracking its own cost.
 * Comparing the drawn rate against it is comparing a number with itself, and the
 * scale then only ever moves on sampling noise between two windows (observed
 * taking 28s to reach the floor, in the one environment where it should have
 * been immediate).
 *
 * So the target is what the app was *asked* for: `fpsLimit`, the cap the user
 * chose in Tools → Frame Rate, which is also the only rate the app has any
 * business trying to reach. A renderer drawing at 16 fps against a 120 cap is
 * plainly in trouble; that is the case this catches.
 *
 * The trade this accepts, stated plainly because it is a real one: the cap and
 * the display are not the same number, so a display that genuinely runs at a
 * third of the cap (a 40Hz panel with the default 120) looks exactly like a
 * machine that cannot keep up, and gets softened. LOW_WATER is set below that
 * band rather than in the middle of it: a healthy 60Hz panel holding the default
 * 120 cap sits at half the target, so anything that acts at 0.5 would soften
 * every healthy laptop on the default settings. At 0.35 the app adapts only when
 * it is at roughly a third of what it was asked for, which is where the win is
 * large (16 → 32 fps above) and where no healthy display configuration lives.
 *
 * Deliberately not done here:
 *
 * - No climb back up on a timer. Only accumulated missed windows move the scale,
 *   in one proportional step, and it stops as soon as the renderer keeps up.
 *   Climbing on a schedule is how resolution scalers start visibly breathing;
 *   instead the scale resets when the load itself changes (a different preset or
 *   cap), which is when a retry is actually justified.
 * - Nothing touches the frame-rate cap. That decides how many frames are asked
 *   for; this decides how expensive each one is.
 *
 * A machine that holds its target never sees this module move at all.
 */

/** Lowest the scaler will go, as a fraction of the canvas's CSS pixels. */
export const MIN_RENDER_SCALE = 0.6

/** Ceiling for the resolution multiplier, matching the Canvas's old dpr max. */
export const MAX_DPR = 1.5

/** How often the scaler looks, in ms. */
export const SAMPLE_MS = 1000

/** Drawn rate below this fraction of the target counts as a missed window. */
const LOW_WATER = 0.35

/**
 * Windows that must miss in a row before the scale moves.
 *
 * One is not enough: a single 250ms window can be short for reasons that have
 * nothing to do with the shader — a garbage collection, another application
 * taking the GPU, the browser doing its own work — and reacting to those would
 * soften the canvas for a hitch nobody saw.
 */
const MISSES_TO_DROP = 2

/**
 * Hold-off after a scale change or a reset, in ms.
 *
 * A resolution change reallocates the drawing buffer, and a preset change
 * compiles a shader, so the frames right after either are not evidence of
 * anything. This also holds the scaler off for the first two seconds of a load.
 */
const SETTLE_MS = 2000

/** Rate assumed for the unlimited cap, which asks for "as fast as you can". */
const UNLIMITED_TARGET = 120

/**
 * Below this, a reading is a measurement failure rather than a slow renderer.
 *
 * A browser throttles or stops requestAnimationFrame for a window it considers
 * hidden or occluded, which reaches this module as a frame rate of roughly one,
 * and acting on it would leave the canvas softened for a machine that was merely
 * in the background. A page genuinely drawing one frame a second is past saving
 * by resolution anyway — the preset or the cap is the answer there.
 */
const MIN_READABLE_FPS = 2

export interface ScaleState {
  /** Multiplier on the canvas's base device pixel ratio. */
  scale: number
  /** Consecutive missed windows. */
  misses: number
  /** When the scale last moved, or when it was last reset. */
  changedAt: number
}

export function initialScaleState(): ScaleState {
  // changedAt: 0 means "never moved", which also holds the first decision back
  // until SETTLE_MS after load — the grace period shader compilation needs.
  return { scale: 1, misses: 0, changedAt: 0 }
}

export interface ScaleSample {
  /** Frames the scene actually drew per second, from frameStats. 0 = no reading. */
  drawnFps: number
  /** Frames per second the renderer is being asked for, from budgetFps(). */
  budgetFps: number
  /** True while the scene is parked or hidden and drawing nothing on purpose. */
  parked: boolean
  now: number
}

/**
 * The scaler's whole policy, as a pure function of the last state and one
 * sample, so the behaviour is testable without a browser or a clock.
 */
export function nextScaleState(state: ScaleState, sample: ScaleSample): ScaleState {
  const { drawnFps, budgetFps, parked, now } = sample

  // Nothing to judge. A parked renderer draws no frames by design, and a stale
  // reading (0) would otherwise be indistinguishable from a renderer that
  // cannot keep up — which is exactly the mistake that would soften the canvas
  // every time the tab lost focus.
  if (parked || drawnFps < MIN_READABLE_FPS || budgetFps <= 0) return state
  if (now - state.changedAt < SETTLE_MS) return state

  if (drawnFps >= budgetFps * LOW_WATER) return state.misses ? { ...state, misses: 0 } : state

  const misses = state.misses + 1
  if (misses < MISSES_TO_DROP) return { ...state, misses }
  if (state.scale <= MIN_RENDER_SCALE) return { ...state, misses: 0 }

  // Cost per frame goes with the pixel count, so the scale that would close the
  // gap is the square root of the shortfall: a renderer at a quarter of the
  // target needs half the pixels. One step instead of a creep, because a step is
  // a drawing-buffer reallocation.
  //
  // With these constants the step always lands on the floor, and that is the
  // intent rather than a rounding artefact: LOW_WATER is far enough below 1 that
  // any shortfall clearing it is already severe (sqrt(0.35) = 0.59, under the
  // 0.6 floor), so the floor is both what the arithmetic asks for and the most
  // the look can give up. Keeping the step proportional is what makes the
  // constants safe to re-tune — raise LOW_WATER to catch milder cases and the
  // response grades itself instead of slamming to the floor.
  const target = state.scale * Math.sqrt(drawnFps / budgetFps)
  const scale = round(Math.max(MIN_RENDER_SCALE, target))

  return { scale, misses: 0, changedAt: now }
}

/** Rounded to 3dp so scale values are comparable and stable to log. */
const round = (v: number): number => Math.round(v * 1000) / 1000

/** The rate the renderer is being asked for: the cap, or a stand-in for "max". */
export function budgetFps(fpsLimit: number): number {
  return fpsLimit > 0 ? fpsLimit : UNLIMITED_TARGET
}

/**
 * The device pixel ratio to hand the Canvas: the same 1..1.5 clamp as before,
 * times the scaler's multiplier — so an unadapted run is pixel-identical to the
 * fixed `dpr={[1, 1.5]}` it replaces.
 */
export function resolveDpr(devicePixelRatio: number, scale: number): number {
  const base = Math.min(Math.max(devicePixelRatio, 1), MAX_DPR)
  return round(base * scale)
}

/* ── module state (not the store: this is written by a measurement, read by
      the canvas, and never shown in the UI) ─────────────────────────── */

let state: ScaleState = initialScaleState()
const listeners = new Set<() => void>()

export function readRenderScale(): number {
  return state.scale
}

/** Feeds one sample in and notifies subscribers only when the scale moves. */
export function reportScaleSample(sample: ScaleSample): void {
  const next = nextScaleState(state, sample)
  if (next === state) return
  const moved = next.scale !== state.scale
  state = next
  if (moved) for (const listener of listeners) listener()
}

/**
 * Back to full resolution, with a fresh settle window. Called when the load
 * changes — a new preset, a new cap — since the scale that suited the old one
 * is not evidence about the new one.
 */
export function resetRenderScale(now: number = performance.now()): void {
  const moved = state.scale !== 1
  state = { scale: 1, misses: 0, changedAt: now }
  if (moved) for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getScale = (): number => state.scale

/**
 * The scaler, wired to the scene. Returns the current multiplier; samples on a
 * timer and resets when `preset` or `fpsLimit` changes.
 */
export function useRenderScale({
  fpsLimit,
  preset,
  parked,
}: {
  fpsLimit: number
  preset: string
  parked: boolean
}): number {
  const scale = useSyncExternalStore(subscribe, getScale, getScale)

  useEffect(() => {
    resetRenderScale()
  }, [preset, fpsLimit])

  useEffect(() => {
    const id = window.setInterval(() => {
      reportScaleSample({
        drawnFps: readFrameRate(),
        budgetFps: budgetFps(fpsLimit),
        // Read live rather than from a hook: a hidden tab is not a slow machine,
        // and this holds even when the user has turned pause-on-blur off.
        parked: parked || document.hidden,
        now: performance.now(),
      })
    }, SAMPLE_MS)
    return () => window.clearInterval(id)
  }, [fpsLimit, parked])

  return scale
}
