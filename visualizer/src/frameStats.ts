/**
 * Rendered frames per second, as the renderer actually ran them.
 *
 * The status bar used to measure its own requestAnimationFrame loop, and the
 * browser runs that at the display's refresh rate whether or not a frame was
 * drawn — so a 30 FPS cap still read 60 (or 120, or 144) and the cap looked like
 * it did nothing. Only the scene knows how many frames it drew, so the scene
 * reports them here.
 *
 * Module-level rather than store state on purpose: this is written once per
 * rendered frame, and pushing that through zustand would re-run every
 * subscriber's selector sixty times a second to update one number in a status
 * bar.
 */

/** Shortest window a rate is averaged over; anything shorter reads as noise. */
const WINDOW_MS = 250

/** A measurement older than this describes a renderer that has stopped. */
const STALE_MS = 750

let frames = 0
let windowStart = -1
let lastFrameAt = -Infinity
let rate = 0

/** Called once per rendered frame, from inside the canvas. */
export function countFrame(now: number = performance.now()): void {
  lastFrameAt = now
  if (windowStart < 0) windowStart = now
  frames++
  const elapsed = now - windowStart
  // `frames - 1` intervals happened across `elapsed` milliseconds: the first
  // frame only marks where the window opened.
  if (frames < 2 || elapsed < WINDOW_MS) return
  rate = ((frames - 1) * 1000) / elapsed
  // The frame that just closed the window is also the next window's opening
  // marker; starting the next count at 1 is what keeps the measured rate from
  // drifting a frame low on every window after the first.
  frames = 1
  windowStart = now
}

/**
 * The last measured rate, or 0 when nothing has been drawn lately — a parked
 * renderer (`windowFocus.ts`) reads as 0 rather than as whatever it managed
 * before it stopped, which is the honest number and the reason the status bar
 * doubles as an indicator that the pause is working.
 */
export function readFrameRate(now: number = performance.now()): number {
  return now - lastFrameAt > STALE_MS ? 0 : rate
}
