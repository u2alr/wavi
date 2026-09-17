import { describe, expect, it } from 'vitest'
import { cleanTitle, parseLRC, toTimedWords } from './lyrics'

describe('parseLRC', () => {
  it('parses timestamps and display text', () => {
    const lines = parseLRC('[00:12.34]Hello\n[00:15.00]World')
    expect(lines.map((l) => l.text)).toEqual(['Hello', 'World'])
    expect(lines[0].start).toBeCloseTo(12.34)
    expect(lines[1].start).toBeCloseTo(15)
  })

  it('chains each line end to the next line start, last one left open', () => {
    const lines = parseLRC('[00:01.00]a\n[00:04.00]b\n[00:09.00]c')
    expect(lines[0].end).toBeCloseTo(4)
    expect(lines[1].end).toBeCloseTo(9)
    expect(lines[2].end).toBeGreaterThan(9)
  })

  it('drops section markers and decoration-only lines', () => {
    const lines = parseLRC('[00:01.00][Chorus]\n[00:02.00]♪♪\n[00:03.00]---\n[00:04.00]real lyric')
    expect(lines.map((l) => l.text)).toEqual(['real lyric'])
  })

  it('applies a global offset tag and never goes negative', () => {
    const lines = parseLRC('[offset:-500]\n[00:01.00]late\n[00:00.20]early')
    expect(lines.map((l) => l.text)).toEqual(['early', 'late'])
    expect(lines[0].start).toBe(0)
    expect(lines[1].start).toBeCloseTo(0.5)
  })

  it('emits one entry per timestamp on a repeated line', () => {
    const lines = parseLRC('[00:01.00][00:30.00]echo')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.start)).toEqual([1, 30])
  })

  it('strips word tags from the display text but keeps them as timings', () => {
    const [line] = parseLRC('[00:10.00]<00:10.00>Hello <00:10.60>world')
    expect(line.text).toBe('Hello world')
    expect(line.words?.map((w) => w.text)).toEqual(['Hello', 'world'])
    expect(line.words?.[1].start).toBeCloseTo(10.6)
  })

  it('keeps a leading word that carries no timing tag of its own', () => {
    const [line] = parseLRC('[00:10.00]Hello <00:10.60>world')
    expect(line.words?.map((w) => w.text)).toEqual(['Hello', 'world'])
    expect(line.words?.[0].start).toBeCloseTo(10)
  })
})

describe('cleanTitle', () => {
  it('strips the version and feature noise Spotify bolts onto titles', () => {
    expect(cleanTitle('Song - Remastered 2011')).toBe('Song')
    expect(cleanTitle('Song (feat. Someone)')).toBe('Song')
    expect(cleanTitle('Song [Live]')).toBe('Song')
    expect(cleanTitle('Song (Sped Up)')).toBe('Song')
    expect(cleanTitle('Song - From the Motion Picture')).toBe('Song')
  })

  it('falls back to the raw title when cleaning removes everything', () => {
    expect(cleanTitle('[Live]')).toBe('[Live]')
  })

  it('leaves a plain title untouched', () => {
    expect(cleanTitle('Ordinary Love')).toBe('Ordinary Love')
  })
})

describe('toTimedWords', () => {
  it('passes real word timings through untouched', () => {
    const words = [{ text: 'a', start: 1, end: 2 }]
    expect(toTimedWords({ text: 'a', start: 1, end: 2, words })).toBe(words)
  })

  it('interpolates word timings weighted by syllables', () => {
    const words = toTimedWords({ text: 'beautiful day', start: 0, end: 2 })
    expect(words.map((w) => w.text)).toEqual(['beautiful', 'day'])
    // "beautiful" has three vowel groups to "day"'s one, so it takes most of
    // the window plus the inter-word gap.
    expect(words[0].end - words[0].start).toBeGreaterThan(words[1].end - words[1].start)
    expect(words[0].start).toBe(0)
    expect(words[1].end).toBe(2)
  })

  it('does not karaoke structural markers', () => {
    expect(toTimedWords({ text: '[Verse 1]', start: 0, end: 3 })).toEqual([])
  })

  it('handles empty and single-word lines', () => {
    expect(toTimedWords({ text: '   ', start: 0, end: 1 })).toEqual([])
    expect(toTimedWords({ text: 'solo', start: 5, end: 6 })).toEqual([
      { text: 'solo', start: 5, end: 6 },
    ])
  })
})
