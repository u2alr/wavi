export const TAP_SIZE = 2048
export const HIGH_BINS = TAP_SIZE / 2
export const WAVE_SAMPLES = TAP_SIZE
export const BAND_COUNT = 32

// AnalyserNode byte frequency data maps [minDecibels, maxDecibels] = [-100, -30]
// onto [0, 255]. Precompute the dB -> linear-magnitude conversion once.
export const byteToLinear: Float32Array = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const db = -100 + (i / 255) * 70
    t[i] = db <= -100 ? 0 : Math.pow(10, db / 20)
  }
  return t
})()

/** Frequency (Hz) of a bin for an FFT of `binCount` bins at `sampleRate`. */
export function binToFrequency(bin: number, binCount: number, sampleRate: number): number {
  return (bin * sampleRate) / (binCount * 2)
}

/** Nearest bin index for a frequency. */
export function frequencyToBin(freq: number, binCount: number, sampleRate: number): number {
  const bin = Math.round((freq * binCount * 2) / sampleRate)
  return bin < 0 ? 0 : bin > binCount - 1 ? binCount - 1 : bin
}
