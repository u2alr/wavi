export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Attack/release envelope follower. Fast attack catches transients, slow
 * release avoids flicker. Coefficients are per-frame blends (0..1).
 */
export class Envelope {
  value = 0
  attack: number
  release: number

  constructor(attack = 0.5, release = 0.08) {
    this.attack = attack
    this.release = release
  }

  process(x: number): number {
    const a = x > this.value ? this.attack : this.release
    this.value += (x - this.value) * a
    return this.value
  }

  reset(): void {
    this.value = 0
  }
}

/** One-pole exponential moving average. */
export function ema(prev: number, next: number, factor: number): number {
  return prev + (next - prev) * factor
}
