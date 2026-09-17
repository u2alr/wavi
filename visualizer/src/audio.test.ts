import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The audio graph is built on the first file load, which is well after the app
 * has applied its persisted volume — so the engine has to remember the level it
 * was told rather than expect to be told again. These cases exist because it
 * didn't: playback came out at 100% while the slider read low.
 *
 * `audio.ts` keeps that memory at module scope, so each case stubs the browser
 * globals it touches and re-imports the module for a clean slate.
 */
class FakeGain {
  gain = { value: 1 }
  connect() {}
  disconnect() {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  state = 'running'
  destination = {}
  gain = new FakeGain()

  constructor() {
    FakeAudioContext.last = this
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, connect() {}, disconnect() {} }
  }
  createGain() {
    return this.gain
  }
  createMediaElementSource() {
    return { connect() {}, disconnect() {} }
  }
  resume() {
    return Promise.resolve()
  }
}

class FakeAudioElement {
  src = ''
  crossOrigin = ''
  play() {
    return Promise.resolve()
  }
  pause() {}
}

const gainValue = () => FakeAudioContext.last!.gain.gain.value
const file = {} as File

async function loadAudio() {
  vi.resetModules()
  return import('./audio')
}

beforeEach(() => {
  FakeAudioContext.last = null
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('Audio', FakeAudioElement)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('volume set before the graph exists', () => {
  it('is the level the graph comes up at', async () => {
    const audio = await loadAudio()

    audio.setAudioVolume(0.25)
    audio.initAudio(file)

    expect(gainValue()).toBe(0.25)
  })

  it('defaults to full volume when nothing has been set', async () => {
    const audio = await loadAudio()

    audio.initAudio(file)

    expect(gainValue()).toBe(1)
  })

  it('is still applied when it changes after the graph exists', async () => {
    const audio = await loadAudio()

    audio.setAudioVolume(0.25)
    audio.initAudio(file)
    audio.setAudioVolume(0.8)

    expect(gainValue()).toBe(0.8)
  })

  it('is clamped to the 0..1 the gain node accepts', async () => {
    const audio = await loadAudio()

    audio.setAudioVolume(4)
    audio.initAudio(file)
    expect(gainValue()).toBe(1)

    audio.setAudioVolume(-2)
    expect(gainValue()).toBe(0)
  })
})
