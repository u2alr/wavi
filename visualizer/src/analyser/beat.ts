import { emitEvent } from './events'
import { clamp01, ema, Envelope } from './smoothing'
import type { AudioAnalysis } from './types'

// Autocorrelation tempo tracker over the onset-strength signal. Frame-based
// lags are converted to seconds with a running dt average so it stays correct
// on 60Hz and high-refresh displays alike.
const HISTORY = 128
const MIN_BPM = 60
const MAX_BPM = 200
const MIN_LAG = Math.round((60 * 60) / MAX_BPM)
const MAX_LAG = Math.round((60 * 60) / MIN_BPM)
const CONF_THRESHOLD = 0.08
const EPS = 1e-9

const onsetHist = new Float32Array(HISTORY)
let histCount = 0
let dtAvg = 1 / 60
let bpmSmoothed = 0
let confSmoothed = 0
let beatPhase = 0
let timeSinceBeat = 0
let barBeat = 0
let rhythmic = 0

const beatEnv = new Envelope(0.85, 0.2)

export function updateBeat(analysis: AudioAnalysis, dt: number): void {
  dtAvg += (dt - dtAvg) * 0.05

  onsetHist.copyWithin(0, 1)
  onsetHist[HISTORY - 1] = analysis.transientStrength
  if (histCount < HISTORY) histCount++

  const time = analysis.time
  let bpmRaw = 0
  let conf = 0

  if (histCount > MIN_LAG + 4) {
    const n = histCount
    let mean = 0
    for (let i = HISTORY - n; i < HISTORY; i++) mean += onsetHist[i]
    mean /= n

    let r0 = 0
    for (let i = HISTORY - n; i < HISTORY; i++) {
      const d = onsetHist[i] - mean
      r0 += d * d
    }

    let best = 0
    let bestLag = 0
    let lagSum = 0
    let lagCount = 0
    const maxLag = Math.min(MAX_LAG, n - 4)
    for (let lag = MIN_LAG; lag <= maxLag; lag++) {
      let acc = 0
      for (let i = HISTORY - n; i < HISTORY - lag; i++) {
        acc += (onsetHist[i] - mean) * (onsetHist[i + lag] - mean)
      }
      lagSum += acc
      lagCount++
      if (acc > best) {
        best = acc
        bestLag = lag
      }
    }

    if (r0 > EPS && bestLag > 0) {
      const lagSec = bestLag * dtAvg
      bpmRaw = 60 / lagSec
      const peakRatio = best / (r0 + EPS)
      const lagMean = lagCount > 0 ? lagSum / lagCount : 0
      const prominence = best > EPS ? clamp01((best - lagMean) / (best + EPS)) : 0
      conf = clamp01(peakRatio * 1.6) * (0.4 + 0.6 * prominence)
    }
  }

  if (bpmRaw > MIN_BPM && bpmRaw < MAX_BPM && conf > CONF_THRESHOLD) {
    bpmSmoothed = bpmSmoothed > 0 ? ema(bpmSmoothed, bpmRaw, 0.08) : bpmRaw
  }
  confSmoothed = ema(confSmoothed, conf, 0.1)

  rhythmic = ema(rhythmic, analysis.transientStrength, 0.05)

  let impulse = 0
  let strength = 0
  timeSinceBeat += dt

  if (bpmSmoothed > MIN_BPM && confSmoothed > CONF_THRESHOLD) {
    const period = 60 / bpmSmoothed
    beatPhase += dt / period
    if (beatPhase >= 1) {
      beatPhase -= Math.floor(beatPhase)
      impulse = 1
      strength = clamp01(analysis.transientStrength * 0.7 + confSmoothed * 0.3)
      timeSinceBeat = 0
      barBeat = (barBeat + 1) & 3
      emitEvent(analysis, 'beat', strength, confSmoothed, 0, time)
    }
  } else {
    beatPhase = 0
  }

  analysis.beat = clamp01(beatEnv.process(impulse))
  analysis.beatStrength = strength > 0 ? strength : analysis.beatStrength * 0.85
  analysis.bpm = bpmSmoothed
  analysis.bpmConfidence = confSmoothed
  analysis.beatPhase = beatPhase
  analysis.timeSinceBeat = timeSinceBeat
  analysis.barPhase = (barBeat + beatPhase) / 4
  analysis.rhythmicEnergy = clamp01(rhythmic)
}

export function resetBeat(): void {
  onsetHist.fill(0)
  histCount = 0
  dtAvg = 1 / 60
  bpmSmoothed = 0
  confSmoothed = 0
  beatPhase = 0
  timeSinceBeat = 0
  barBeat = 0
  rhythmic = 0
  beatEnv.reset()
}
