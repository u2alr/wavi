// Canonical preset list. Order also drives the A/D keyboard cycle.
export const PRESET_TYPES = [
  'amPreset',
  'prismaticTempest',
  'auroraSilk',
  'brat',
  'canvasAmbient',
  'waveform',
  'acidWash',
  'mellow1',
  'mellow2',
  'chromaticBurst',
]

export const PRESET_LABELS: Record<string, string> = {
  amPreset: 'AM Preset',
  prismaticTempest: 'Prismatic Tempest',
  auroraSilk: 'Aurora Silk',
  brat: 'brat',
  canvasAmbient: 'Canvas Ambient',
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
