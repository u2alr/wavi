import { create } from 'zustand'
import type { SpotifyPlaylist, SpotifyTrack, SpotifyUser } from './spotify'

export interface PresetParams {
  intensity: number
  sensitivity: number
  bassAmp: number
  midAmp: number
  trebleAmp: number
  hueShift: number
  speed: number
  complexity: number
}

export type PresetParamKey = keyof PresetParams

// Which sliders actually do something, per preset (read from the shader
// uniform writes in Scene.tsx — anything not listed here stays hidden).
export const PRESET_PARAM_KEYS: Record<string, PresetParamKey[]> = {
  mellow2: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  auroraSilk: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  mellow1: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  prismaticTempest: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  acidWash: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  chromaticBurst: ['intensity', 'sensitivity', 'hueShift', 'speed'],
  waveform: ['sensitivity', 'speed'],
  amPreset: ['sensitivity', 'speed'],
  am2Preset: ['sensitivity', 'speed', 'bassAmp', 'midAmp', 'trebleAmp'],
  canvasAmbient: ['sensitivity', 'speed'],
  canvasAmbient2: ['speed'],
  brat: [],
}

// Old preset ids renamed in the "rename the presets" pass. URLs/saved presets
// from before the rename keep working by mapping through this on load.
export const PRESET_ID_RENAMES: Record<string, string> = {
  arcticSwirl: 'prismaticTempest',
  fractalEmber: 'waveform',
  laserSilk: 'acidWash',
  liquidDrift: 'mellow1',
  mellowDrift: 'mellow2',
  sonarBloom: 'chromaticBurst',
}

// Preset ids that no longer exist. Anything referencing these is dropped.
export const REMOVED_PRESETS = new Set(['prismaticGarden'])

/** Resolve a possibly-legacy preset id to its current id ('' if removed). */
export function resolvePresetId(id: string): string {
  if (REMOVED_PRESETS.has(id)) return ''
  return PRESET_ID_RENAMES[id] ?? id
}

export interface SavedPreset {
  id: string
  name: string
  presetType: string
  params: PresetParams
  createdAt: number
}

export interface VisualizerMetrics {
  fps: number
  bass: number
  mid: number
  treble: number
  overall: number
  sourceMode: 'live' | 'idle'
}

interface Store {
  currentPreset: string
  // Per-preset overrides (sparse — anything missing falls back to defaults).
  presetParams: Record<string, Partial<PresetParams>>
  playlist: File[]
  currentTrackIndex: number
  trackName: string
  isFullscreen: boolean
  savedPresets: SavedPreset[]
  isSpotifyAuthed: boolean
  spotifyUser: SpotifyUser | null
  spotifyPlaylists: SpotifyPlaylist[]
  spotifyTracks: SpotifyTrack[]
  spotifyIndex: number
  spotifyPlaying: boolean
  spotifyCurrentTrack: SpotifyTrack | null
  spotifyError: string | null
  playbackPosition: number
  playbackDuration: number
  metrics: VisualizerMetrics
  volume: number
  isPanelCollapsed: boolean
  isMiniPlayer: boolean
  activeModal: 'help' | 'shortcuts' | null
  bratWhiteBg: boolean
  bratKaraoke: boolean
  amFlip: boolean
  extensionStatus: '' | 'EXT LIVE' | 'EXT SILENT' | 'EXT READY' | 'EXT ERROR'

  setCurrentPreset: (p: string) => void
  setParam: <K extends keyof PresetParams>(key: K, value: PresetParams[K]) => void
  setParams: (p: PresetParams) => void
  resetParams: () => void
  setPlaylist: (files: File[]) => void
  setCurrentTrackIndex: (i: number) => void
  setTrackName: (name: string) => void
  setIsFullscreen: (fs: boolean) => void
  togglePanelCollapsed: () => void
  setPanelCollapsed: (collapsed: boolean) => void
  setIsMiniPlayer: (mini: boolean) => void
  setActiveModal: (modal: 'help' | 'shortcuts' | null) => void
  setSpotifyAuthed: (b: boolean) => void
  setSpotifyUser: (u: SpotifyUser | null) => void
  setSpotifyPlaylists: (p: SpotifyPlaylist[]) => void
  setSpotifyTracks: (t: SpotifyTrack[]) => void
  appendSpotifyTracks: (t: SpotifyTrack[]) => void
  setSpotifyIndex: (i: number) => void
  setSpotifyPlaying: (b: boolean) => void
  setSpotifyCurrentTrack: (t: SpotifyTrack | null) => void
  setSpotifyError: (e: string | null) => void
  setPlaybackProgress: (position: number, duration: number) => void
  setMetrics: (metrics: VisualizerMetrics) => void
  savePreset: (name: string) => void
  loadPreset: (id: string) => void
  deletePreset: (id: string) => void
  setVolume: (v: number) => void
  setBratWhiteBg: (b: boolean) => void
  setBratKaraoke: (b: boolean) => void
  setAmFlip: (b: boolean) => void
  setExtensionStatus: (s: '' | 'EXT LIVE' | 'EXT SILENT' | 'EXT READY' | 'EXT ERROR') => void
}

const DEFAULT_PARAMS: PresetParams = {
  intensity: 1.5,
  sensitivity: 1,
  bassAmp: 1,
  midAmp: 1,
  trebleAmp: 1,
  hueShift: 200,
  speed: 1.0,
  complexity: 1,
}

/** Effective params for a preset: defaults + that preset's overrides. */
export function presetParamsFor(
  s: { currentPreset: string; presetParams: Record<string, Partial<PresetParams>> },
  id = s.currentPreset,
): PresetParams {
  return { ...DEFAULT_PARAMS, ...s.presetParams[id] }
}

function loadSavedPresets(): SavedPreset[] {
  try {
    const raw = localStorage.getItem('viz-presets')
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedPreset[]
    return parsed
      .map((p) => ({ ...p, presetType: resolvePresetId(p.presetType) }))
      .filter((p) => p.presetType !== '')
  } catch { return [] }
}

function persistPresets(presets: SavedPreset[]) {
  localStorage.setItem('viz-presets', JSON.stringify(presets))
}

export const useStore = create<Store>((set, get) => ({
  currentPreset: 'mellow2',
  presetParams: {},
  playlist: [],
  currentTrackIndex: -1,
  trackName: '',
  isSpotifyAuthed: false,
  spotifyUser: null,
  spotifyPlaylists: [],
  spotifyTracks: [],
  spotifyIndex: -1,
  spotifyPlaying: false,
  spotifyCurrentTrack: null,
  spotifyError: null,
  playbackPosition: 0,
  playbackDuration: 0,
  metrics: { fps: 0, bass: 0, mid: 0, treble: 0, overall: 0, sourceMode: 'idle' as const },
  isFullscreen: false,
  isPanelCollapsed: false,
  isMiniPlayer: false,
  activeModal: null,
  savedPresets: loadSavedPresets(),
  volume: 1.0,
  bratWhiteBg: false,
  bratKaraoke: false,
  amFlip: false,
  extensionStatus: '' as '' | 'EXT LIVE' | 'EXT SILENT' | 'EXT READY' | 'EXT ERROR',

  setCurrentPreset: (p) => set({ currentPreset: p }),
  setParam: (key, value) =>
    set((s) => ({
      presetParams: {
        ...s.presetParams,
        [s.currentPreset]: { ...s.presetParams[s.currentPreset], [key]: value },
      },
    })),
  setParams: (p) =>
    set((s) => ({ presetParams: { ...s.presetParams, [s.currentPreset]: { ...p } } })),
  resetParams: () =>
    set((s) => ({
      presetParams: { ...s.presetParams, [s.currentPreset]: { ...DEFAULT_PARAMS } },
    })),
  setPlaylist: (files) => set({ playlist: files }),
  setCurrentTrackIndex: (i) => set({ currentTrackIndex: i }),
  setIsFullscreen: (fs) => set({ isFullscreen: fs }),
  togglePanelCollapsed: () => set((s) => ({ isPanelCollapsed: !s.isPanelCollapsed })),
  setPanelCollapsed: (collapsed) => set({ isPanelCollapsed: collapsed }),
  setIsMiniPlayer: (mini) => set({ isMiniPlayer: mini }),
  setActiveModal: (modal) => set({ activeModal: modal }),
  setSpotifyAuthed: (b) => set({ isSpotifyAuthed: b }),
  setSpotifyUser: (u) => set({ spotifyUser: u }),
  setSpotifyPlaylists: (p) => set({ spotifyPlaylists: p }),
  setSpotifyTracks: (t) => set({ spotifyTracks: t, spotifyIndex: t.length ? 0 : -1 }),
  appendSpotifyTracks: (t) => set((s) => ({ spotifyTracks: [...s.spotifyTracks, ...t] })),
  setSpotifyError: (e) => set({ spotifyError: e }),
  setSpotifyIndex: (i) => set({ spotifyIndex: i }),
  setSpotifyPlaying: (b) => set({ spotifyPlaying: b }),
  setSpotifyCurrentTrack: (t) => set({ spotifyCurrentTrack: t }),
  setPlaybackProgress: (position, duration) => set({ playbackPosition: position, playbackDuration: duration }),
  setMetrics: (metrics) => set({ metrics }),
  setTrackName: (name) => set({ trackName: name }),
  setVolume: (v) => set({ volume: v }),
  setBratWhiteBg: (b) => set({ bratWhiteBg: b }),
  setBratKaraoke: (b) => set({ bratKaraoke: b }),
  setAmFlip: (b) => set({ amFlip: b }),
  setExtensionStatus: (s) => set({ extensionStatus: s }),

  savePreset: (name) => {
    const { currentPreset, savedPresets } = get()
    const newPreset: SavedPreset = {
      id: crypto.randomUUID(),
      name,
      presetType: currentPreset,
      params: presetParamsFor(get()),
      createdAt: Date.now(),
    }
    const updated = [...savedPresets, newPreset]
    persistPresets(updated)
    set({ savedPresets: updated })
  },

  loadPreset: (id) => {
    const preset = get().savedPresets.find((p) => p.id === id)
    if (preset) {
      set((s) => ({
        currentPreset: preset.presetType,
        presetParams: { ...s.presetParams, [preset.presetType]: { ...preset.params } },
      }))
    }
  },

  deletePreset: (id) => {
    const updated = get().savedPresets.filter((p) => p.id !== id)
    persistPresets(updated)
    set({ savedPresets: updated })
  },
}))