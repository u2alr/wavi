// Canonical preset list. Order also drives the A/D keyboard cycle.
export const PRESET_TYPES = [
  'amPreset',
  'am2Preset',
  'prismaticTempest',
  'sandsOfTime',
  'auroraSilk',
  'brat',
  'canvasAmbient',
  'canvasAmbient2',
  'waveform',
  'acidWash',
  'mellow1',
  'mellow2',
  'chromaticBurst',
]

export const PRESET_LABELS: Record<string, string> = {
  amPreset: 'AM Preset',
  am2Preset: 'AM2',
  prismaticTempest: 'Prismatic Tempest',
  sandsOfTime: 'Sands of Time',
  auroraSilk: 'Aurora Silk',
  brat: 'brat',
  canvasAmbient: 'Canvas Ambient',
  canvasAmbient2: 'Canvas Ambient 2',
  waveform: 'Waveform',
  acidWash: 'Acid Wash',
  mellow1: 'Mellow 1',
  mellow2: 'Mellow 2',
  chromaticBurst: 'Chromatic Burst',
}

export const PRESET_OPTIONS = PRESET_TYPES.map((value) => ({
  value,
  label: PRESET_LABELS[value] ?? value,
}))
