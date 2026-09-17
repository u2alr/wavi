import { describe, expect, it } from 'vitest'
import { nextQueueStep } from './queueIndex'

/** Deterministic RNG: walks the given sequence, repeating the last value. */
function rng(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

const base = { index: 1, length: 3, dir: 1 as const, shuffle: false }

describe('nextQueueStep', () => {
  it('stops when there is nothing to play', () => {
    expect(nextQueueStep({ ...base, index: -1, length: 0 })).toEqual({ kind: 'stop' })
  })

  it('steps forward and backward in order', () => {
    expect(nextQueueStep(base)).toEqual({ kind: 'play', index: 2 })
    expect(nextQueueStep({ ...base, dir: -1 })).toEqual({ kind: 'play', index: 0 })
  })

  it('wraps at both ends for manual skips', () => {
    expect(nextQueueStep({ ...base, index: 2 })).toEqual({ kind: 'play', index: 0 })
    expect(nextQueueStep({ ...base, index: 0, dir: -1 })).toEqual({ kind: 'play', index: 2 })
  })

  it('starts from the top (or bottom) when nothing has played yet', () => {
    expect(nextQueueStep({ ...base, index: -1 })).toEqual({ kind: 'play', index: 0 })
    expect(nextQueueStep({ ...base, index: -1, dir: -1 })).toEqual({ kind: 'play', index: 2 })
  })

  it('stops at the end of the list on a natural end unless repeat-all', () => {
    const last = { ...base, index: 2, auto: true }
    expect(nextQueueStep(last)).toEqual({ kind: 'stop' })
    expect(nextQueueStep({ ...last, repeat: 'one' })).toEqual({ kind: 'stop' })
    expect(nextQueueStep({ ...last, repeat: 'all' })).toEqual({ kind: 'play', index: 0 })
  })

  it('advances normally mid-list on a natural end', () => {
    expect(nextQueueStep({ ...base, auto: true })).toEqual({ kind: 'play', index: 2 })
  })

  it('shuffles within the other tracks, skipping over the current one', () => {
    // index 1 of 3: a low draw maps to 0, a high draw skips past the current.
    expect(nextQueueStep({ ...base, shuffle: true, random: rng([0.4]) })).toEqual({
      kind: 'play',
      index: 0,
    })
    expect(nextQueueStep({ ...base, shuffle: true, random: rng([0.9]) })).toEqual({
      kind: 'play',
      index: 2,
    })
  })

  it('never shuffles back to the current track', () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const step = nextQueueStep({ ...base, shuffle: true, random: () => draw })
      expect(step).not.toEqual({ kind: 'play', index: 1 })
      if (step.kind === 'play') expect(step.index).toBeGreaterThanOrEqual(0)
    }
  })

  it('picks any track when nothing is playing yet', () => {
    expect(nextQueueStep({ ...base, index: -1, shuffle: true, random: rng([0.5]) })).toEqual({
      kind: 'play',
      index: 1,
    })
  })

  it('keeps shuffling across a natural end, even with repeat off', () => {
    const step = nextQueueStep({
      ...base,
      index: 2,
      auto: true,
      shuffle: true,
      random: rng([0.05]),
    })
    expect(step).toEqual({ kind: 'play', index: 0 })
  })

  it('follows list order when shuffle cannot do better (single track)', () => {
    expect(nextQueueStep({ index: 0, length: 1, dir: 1, shuffle: true })).toEqual({
      kind: 'play',
      index: 0,
    })
  })

  it('stays inside the list even if random() returns exactly 1', () => {
    expect(nextQueueStep({ ...base, index: 0, shuffle: true, random: () => 1 })).toEqual({
      kind: 'play',
      index: 2,
    })
    expect(nextQueueStep({ ...base, index: -1, shuffle: true, random: () => 1 })).toEqual({
      kind: 'play',
      index: 2,
    })
  })
})
