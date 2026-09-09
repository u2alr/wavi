import { create } from 'zustand'
import type { SpotifyPlaylist, SpotifyTrack, SpotifyUser } from './spotify'

export interface PresetParams {
  intensity: number
  sensitivity: number
  hueShift: number
  speed: number
  particleSize: number
  complexity: number
  thickness: number
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
  params: PresetParams
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
  setSpotifyIndex: (i: number) => void
  setSpotifyPlaying: (b: boolean) => void
  setSpotifyCurrentTrack: (t: SpotifyTrack | null) => void
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
  hueShift: 200,
  speed: 1.0,
  particleSize: 0.03,
  complexity: 1,
  thickness: 1,
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
  params: { ...DEFAULT_PARAMS },
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
  setParam: (key, value) => set((s) => ({ params: { ...s.params, [key]: value } })),
  setParams: (p) => set({ params: p }),
  resetParams: () => set({ params: { ...DEFAULT_PARAMS } }),
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
    const { currentPreset, params, savedPresets } = get()
    const newPreset: SavedPreset = {
      id: crypto.randomUUID(),
      name,
      presetType: currentPreset,
      params: { ...params },
      createdAt: Date.now(),
    }
    const updated = [...savedPresets, newPreset]
    persistPresets(updated)
    set({ savedPresets: updated })
  },

  loadPreset: (id) => {
    const preset = get().savedPresets.find((p) => p.id === id)
    if (preset) {
      set({ currentPreset: preset.presetType, params: { ...DEFAULT_PARAMS, ...preset.params } })
    }
  },

  deletePreset: (id) => {
    const updated = get().savedPresets.filter((p) => p.id !== id)
    persistPresets(updated)
    set({ savedPresets: updated })
  },
}))