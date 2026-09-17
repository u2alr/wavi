import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasStoredPanelPref, presetParamsFor, resolvePresetId, type PresetParams } from './store'

describe('hasStoredPanelPref', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    // The narrow-viewport default must never override a stored choice, so this
    // predicate has to be exact about a missing/invalid blob.
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('is false when nothing has been written yet', () => {
    expect(hasStoredPanelPref()).toBe(false)
  })

  it('is true once a panel state exists', () => {
    localStorage.setItem('viz-ui-prefs', JSON.stringify({ v: 1, isPanelCollapsed: true }))
    expect(hasStoredPanelPref()).toBe(true)
  })

  it('ignores a blob from another schema version', () => {
    localStorage.setItem('viz-ui-prefs', JSON.stringify({ v: 2, isPanelCollapsed: true }))
    expect(hasStoredPanelPref()).toBe(false)
  })

  it('ignores a blob that never chose a panel state', () => {
    localStorage.setItem('viz-ui-prefs', JSON.stringify({ v: 1, volume: 0.5 }))
    expect(hasStoredPanelPref()).toBe(false)
  })
})

describe('resolvePresetId', () => {
  it('leaves current ids alone', () => {
    expect(resolvePresetId('mellow2')).toBe('mellow2')
    expect(resolvePresetId('brat')).toBe('brat')
  })

  it('maps ids from before the rename pass', () => {
    expect(resolvePresetId('arcticSwirl')).toBe('prismaticTempest')
    expect(resolvePresetId('am3Preset')).toBe('mellow2')
  })

  it('resolves unknown ids to an empty string', () => {
    expect(resolvePresetId('prismaticGarden')).toBe('')
  })
})

describe('presetParamsFor', () => {
  const defaults: PresetParams = {
    intensity: 1.5,
    sensitivity: 1,
    bassAmp: 1,
    midAmp: 1,
    trebleAmp: 1,
    hueShift: 200,
    speed: 1.0,
    complexity: 1,
  }

  it('falls back to defaults for a preset with no overrides', () => {
    expect(presetParamsFor({ currentPreset: 'brat', presetParams: {} })).toEqual(defaults)
  })

  it('merges that preset\'s overrides over the defaults', () => {
    const resolved = presetParamsFor({
      currentPreset: 'brat',
      presetParams: { brat: { speed: 2.5 } },
    })
    expect(resolved).toEqual({ ...defaults, speed: 2.5 })
  })

  it('ignores other presets\' overrides, and can target an explicit id', () => {
    const state = { currentPreset: 'brat', presetParams: { mellow1: { speed: 3 } } }
    expect(presetParamsFor(state).speed).toBe(1.0)
    expect(presetParamsFor(state, 'mellow1').speed).toBe(3)
  })
})
