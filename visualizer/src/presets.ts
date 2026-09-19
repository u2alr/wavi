// Canonical preset list. The first entry is the preset the app opens on, so the
// default look leads both the Presets menu and the A/D keyboard cycle; store.ts
// holds that same id and a test keeps the two from drifting apart.
export const PRESET_TYPES = [
  'mellow1',
  'amPreset',
  'am2Preset',
  'prismaticTempest',
  'sandsOfTime',
  'brat',
  'canvasAmbient',
  'canvasAmbient2',
  'waveform',
  'acidWash',
  'chromaticBurst',
]

// Kept in the same order as the list above, so the two read together.
export const PRESET_LABELS: Record<string, string> = {
  mellow1: 'Mellow 1',
  amPreset: 'AM Preset',
  am2Preset: 'AM2',
  prismaticTempest: 'Prismatic Tempest',
  sandsOfTime: 'Sands of Time',
  brat: 'brat',
  canvasAmbient: 'Canvas Ambient',
  canvasAmbient2: 'Canvas Ambient 2',
  waveform: 'Waveform',
  acidWash: 'Acid Wash',
  chromaticBurst: 'Chromatic Burst',
}
