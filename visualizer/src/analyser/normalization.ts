import { clamp01 } from './smoothing'

/**
 * Adaptive normalizer driven by rolling statistics instead of fixed
 * thresholds. `floor` tracks the quiet baseline, `peak` the recent loud
 * ceiling; both move slowly so a quiet track still spans 0..1 and a loud
 * track never permanently pins at 1.
 */
export class AdaptiveNormalizer {
  floor = 0
  peak = 0
  mean = 0
  initialized = false

  attack: number
  release: number
  floorRise: number
  floorFall: number
  meanFactor: number

  constructor(opts: {
    attack?: number
    release?: number
    floorRise?: number
    floorFall?: number
    meanFactor?: number
  } = {}) {
    this.attack = opts.attack ?? 0.25
    this.release = opts.release ?? 0.003
    this.floorRise = opts.floorRise ?? 0.0005
    this.floorFall = opts.floorFall ?? 0.15
    this.meanFactor = opts.meanFactor ?? 0.02
  }

  update(x: number): void {
    if (!Number.isFinite(x)) return
    if (!this.initialized) {
      this.floor = x
      this.peak = x
      this.mean = x
      this.initialized = true
      return
    }
    if (x > this.peak) this.peak += (x - this.peak) * this.attack
    else this.peak += (x - this.peak) * this.release

    if (x < this.floor) this.floor += (x - this.floor) * this.floorFall
    else this.floor += (x - this.floor) * this.floorRise

    this.mean += (x - this.mean) * this.meanFactor
  }

  normalize(x: number): number {
    const span = this.peak - this.floor
    if (span < 1e-4) return 0
    return clamp01((x - this.floor) / span)
  }

  reset(): void {
    this.initialized = false
    this.floor = 0
    this.peak = 0
    this.mean = 0
  }
}
