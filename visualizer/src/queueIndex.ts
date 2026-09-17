/**
 * The "what plays next" decision, shared by the local-file transport and the
 * Spotify queue. Deliberately pure — the RNG is injectable and nothing here
 * touches the store or the DOM — so the whole shuffle/repeat matrix is unit
 * testable. The two transports used to carry private copies of this logic and
 * only one of them consulted shuffle at all.
 */
export type RepeatMode = 'off' | 'all' | 'one'

export type QueueStep = { kind: 'play'; index: number } | { kind: 'stop' }

export interface QueueStepOptions {
  /** Index of the track playing now; -1 means nothing has started yet. */
  index: number
  /** How many tracks are available. */
  length: number
  dir: 1 | -1
  shuffle: boolean
  /** True only when the step is a track ending on its own (repeat applies). */
  auto?: boolean
  repeat?: RepeatMode
  /** Injectable RNG so shuffle can be asserted in tests. */
  random?: () => number
}

export function nextQueueStep({
  index,
  length,
  dir,
  shuffle,
  auto = false,
  repeat = 'off',
  random = Math.random,
}: QueueStepOptions): QueueStep {
  if (length <= 0) return { kind: 'stop' }

  // Shuffle ignores direction and never repeats the current track back-to-back.
  // Drawn uniformly from the *other* tracks rather than rejection-sampling the
  // current one — same distribution, and no retry loop that could spin.
  if (shuffle && length > 1) {
    if (index < 0) return { kind: 'play', index: Math.min(length - 1, Math.floor(random() * length)) }
    const roll = Math.min(length - 2, Math.floor(random() * (length - 1)))
    return { kind: 'play', index: roll >= index ? roll + 1 : roll }
  }

  if (auto && index >= 0 && repeat === 'one') {
    // A natural end replays the same track. The local transport also sets
    // audio.loop for this mode, but the rule lives here so every caller gets it
    // rather than each one re-deriving it.
    return { kind: 'play', index }
  }

  if (auto && index >= 0 && index + dir >= length) {
    // Natural end of the last track: repeat-all wraps, anything else stops.
    return repeat === 'all' ? { kind: 'play', index: 0 } : { kind: 'stop' }
  }

  const base = index < 0 ? (dir > 0 ? -1 : 0) : index
  return { kind: 'play', index: (base + dir + length) % length }
}
