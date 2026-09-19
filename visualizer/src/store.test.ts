import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESET_LABELS, PRESET_TYPES } from './presets'
import {
  hasStoredPanelPref,
  presetParamsFor,
  PRESET_ID_RENAMES,
  resolvePresetId,
  useStore,
  type PresetParams,
} from './store'

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

describe('the default preset', () => {
  // The list leads with the default look, so the menu opens on it and the A/D
  // cycle starts there. The id itself is written out in the store rather than
  // derived, so this is what keeps a reorder from drifting away from it.
  it('is the first entry of PRESET_TYPES', () => {
    expect(useStore.getState().currentPreset).toBe(PRESET_TYPES[0])
  })

  it('is a preset the list and the labels both know', () => {
    expect(PRESET_TYPES).toContain(useStore.getState().currentPreset)
    expect(PRESET_LABELS[useStore.getState().currentPreset]).toBeTruthy()
  })
})

describe('resolvePresetId', () => {
  it('leaves current ids alone', () => {
    expect(resolvePresetId('mellow1')).toBe('mellow1')
    expect(resolvePresetId('brat')).toBe('brat')
  })

  it('maps ids from before the rename pass', () => {
    expect(resolvePresetId('arcticSwirl')).toBe('prismaticTempest')
    expect(resolvePresetId('am3Preset')).toBe('mellow1')
  })

  it('resolves ids of presets that no longer exist to an empty string', () => {
    expect(resolvePresetId('prismaticGarden')).toBe('')
    expect(resolvePresetId('auroraSilk')).toBe('')
    expect(resolvePresetId('mellow2')).toBe('')
  })

  // A rename whose target is itself removed would otherwise hand back an id the
  // scene cannot render, so the alias table has to point at live presets.
  it('every rename target is a preset that still exists', () => {
    for (const [from, to] of Object.entries(PRESET_ID_RENAMES)) {
      expect(resolvePresetId(to), `${from} -> ${to}`).toBe(to)
    }
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
