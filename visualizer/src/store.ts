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
  sandsOfTime: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  acidWash: ['intensity', 'sensitivity', 'hueShift', 'speed', 'complexity'],
  chromaticBurst: ['intensity', 'hueShift', 'speed'],
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
  touchRadial: 'mellow2',
  lightDome: 'mellow2',
  am3Preset: 'mellow2',
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
  /** Render FPS cap (0 = unlimited). Session-only. */
  fpsLimit: number
  /** Local + Spotify transport modes. Session-only. */
  repeatMode: 'off' | 'all' | 'one'
  shuffle: boolean

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
  setFpsLimit: (fps: number) => void
  setRepeatMode: (m: 'off' | 'all' | 'one') => void
  cycleRepeatMode: () => void
  setShuffle: (b: boolean) => void
  toggleShuffle: () => void
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
  // Best-effort: private mode / quota exhaustion throw here, and failing to
  // persist a look must never break the action that saved it.
  try {
    localStorage.setItem('viz-presets', JSON.stringify(presets))
  } catch { /* in-memory state stays authoritative */ }
}

/**
 * Look-and-feel prefs worth surviving a reload. Transport modes (repeat /
 * shuffle) are deliberately *not* here: they mirror onto the Spotify player for
 * one session and are meant to start clean. The `v` field versions the blob so
 * a future shape change can be detected and ignored instead of misread.
 */
interface UiPrefs {
  v: 1
  volume: number
  fpsLimit: number
  bratWhiteBg: boolean
  bratKaraoke: boolean
  amFlip: boolean
  isPanelCollapsed: boolean
}

const UI_PREFS_KEY = 'viz-ui-prefs'

const DEFAULT_UI_PREFS: UiPrefs = {
  v: 1,
  volume: 1.0,
  fpsLimit: 0,
  bratWhiteBg: false,
  bratKaraoke: false,
  amFlip: false,
  isPanelCollapsed: false,
}

function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (!raw) return DEFAULT_UI_PREFS
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    if (parsed?.v !== 1) return DEFAULT_UI_PREFS
    return { ...DEFAULT_UI_PREFS, ...parsed, v: 1 }
  } catch {
    return DEFAULT_UI_PREFS
  }
}

function persistUiPrefs(patch: Partial<Omit<UiPrefs, 'v'>>) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...loadUiPrefs(), ...patch, v: 1 }))
  } catch { /* in-memory state stays authoritative */ }
}

const initialPrefs = loadUiPrefs()

/**
 * Whether the panel state in storage is the user's choice rather than our
 * default. Narrow viewports start with the panel closed (it covers the whole
 * canvas there), and that decision must not override a stored preference.
 */
export function hasStoredPanelPref(): boolean {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return parsed?.v === 1 && typeof parsed.isPanelCollapsed === 'boolean'
  } catch {
    return false
  }
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
  isPanelCollapsed: initialPrefs.isPanelCollapsed,
  isMiniPlayer: false,
  activeModal: null,
  savedPresets: loadSavedPresets(),
  volume: initialPrefs.volume,
  bratWhiteBg: initialPrefs.bratWhiteBg,
  bratKaraoke: initialPrefs.bratKaraoke,
  amFlip: initialPrefs.amFlip,
  extensionStatus: '' as '' | 'EXT LIVE' | 'EXT SILENT' | 'EXT READY' | 'EXT ERROR',
  fpsLimit: initialPrefs.fpsLimit,
  repeatMode: 'off' as 'off' | 'all' | 'one',
  shuffle: false,

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
  togglePanelCollapsed: () => {
    const next = !get().isPanelCollapsed
    persistUiPrefs({ isPanelCollapsed: next })
    set({ isPanelCollapsed: next })
  },
  setPanelCollapsed: (collapsed) => {
    persistUiPrefs({ isPanelCollapsed: collapsed })
    set({ isPanelCollapsed: collapsed })
  },
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
  setVolume: (v) => {
    persistUiPrefs({ volume: v })
    set({ volume: v })
  },
  setBratWhiteBg: (b) => {
    persistUiPrefs({ bratWhiteBg: b })
    set({ bratWhiteBg: b })
  },
  setBratKaraoke: (b) => {
    persistUiPrefs({ bratKaraoke: b })
    set({ bratKaraoke: b })
  },
  setAmFlip: (b) => {
    persistUiPrefs({ amFlip: b })
    set({ amFlip: b })
  },
  setExtensionStatus: (s) => set({ extensionStatus: s }),
  setFpsLimit: (fps) => {
    persistUiPrefs({ fpsLimit: fps })
    set({ fpsLimit: fps })
  },
  setRepeatMode: (m) => set({ repeatMode: m }),
  cycleRepeatMode: () =>
    set((s) => ({ repeatMode: s.repeatMode === 'off' ? 'all' : s.repeatMode === 'all' ? 'one' : 'off' })),
  setShuffle: (b) => set({ shuffle: b }),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),

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