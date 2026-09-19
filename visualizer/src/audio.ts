let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let gainNode: GainNode | null = null
let source: MediaElementAudioSourceNode | null = null
// The volume the app last asked for. The graph is built lazily on the first file
// load, so a value set before that has to be remembered rather than dropped:
// createGain() comes up at 1.0, and playback would then come out at full volume
// however low the slider reads. Re-applied in initAudio, below.
let audioElement: HTMLAudioElement | null = null
let audioObjectUrl: string | null = null
let desiredVolume = 1
const freqData = new Uint8Array(256)
// Default sink for readBands below — written and read on the spot by callers
// that don't keep a scratch object of their own.
const bandScratch = { bass: 0, mid: 0, treble: 0 }
// Frame-stamp cache: only call getByteFrequencyData once per animation frame
let lastFillTime = -1
let extensionFreqData: Uint8Array | null = null
let extensionWaveData: Uint8Array | null = null

export function setExtensionAudioData(bins: number[]) {
  extensionFreqData = Uint8Array.from(bins.slice(0, freqData.length))
}

export function setExtensionWaveData(wave: number[]) {
  extensionWaveData = Uint8Array.from(wave)
}

export function clearExtensionAudioData() {
  extensionFreqData = null
  extensionWaveData = null
}

export function initAudio(file: File): HTMLAudioElement {
  clearExtensionAudioData()
  if (!audioContext) {
    audioContext = new AudioContext()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.8
    gainNode = audioContext.createGain()
    // The gain node a fresh context creates is at 1.0, which is not necessarily
    // where the slider is — the app applies its volume only when the value
    // changes, and that happened while this node did not exist yet.
    gainNode.gain.value = desiredVolume
  }

  if (audioElement) {
    audioElement.pause()
    if (source) source.disconnect()
  }
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl)
    audioObjectUrl = null
  }

  if (!audioContext || !analyser) {
    throw new Error('Failed to initialize audio context')
  }

  if (audioContext.state === 'suspended') audioContext.resume().catch(console.error)

  audioElement = new Audio()
  audioObjectUrl = URL.createObjectURL(file)
  audioElement.src = audioObjectUrl
  audioElement.crossOrigin = 'anonymous'

  source = audioContext.createMediaElementSource(audioElement)
  source.connect(analyser)
  if (gainNode) {
    analyser.connect(gainNode)
    gainNode.connect(audioContext.destination)
  }

  audioElement.play().catch((err) => console.error('Audio play failed:', err))
  return audioElement
}

/** Fill freqData from the analyser, at most once per animation frame. */
function fillFreqData() {
  if (extensionFreqData) {
    freqData.set(extensionFreqData)
    return
  }
  if (!analyser) return
  const now = performance.now()
  if (now - lastFillTime < 1) return // already read this frame
  lastFillTime = now
  analyser.getByteFrequencyData(freqData)
}

export function getAudioBands() {
  if (!extensionFreqData && !analyser) return { bass: 0, mid: 0, treble: 0, overall: 0 }

  const { bass, mid, treble } = readBands(getFreqData())

  return { bass, mid, treble, overall: (bass + mid + treble) / 3 }
}

/**
 * Bass/mid/treble split of the raw frequency bytes — one implementation for
 * every consumer (the status-bar meters here, and each three-band preset).
 * Writes into `out` so a per-frame caller allocates nothing; pass your own
 * object when the values have to survive the next call.
 */
export function readBands(frequency: Uint8Array, out = bandScratch) {
  let bass = 0, mid = 0, treble = 0
  const bassEnd = Math.floor(frequency.length * 0.1)
  const midEnd = Math.floor(frequency.length * 0.4)

  for (let i = 0; i < bassEnd; i++) bass += frequency[i]
  for (let i = bassEnd; i < midEnd; i++) mid += frequency[i]
  for (let i = midEnd; i < frequency.length; i++) treble += frequency[i]

  out.bass = bass / (bassEnd * 255)
  out.mid = mid / ((midEnd - bassEnd) * 255)
  out.treble = treble / ((frequency.length - midEnd) * 255)

  return out
}

export function getFreqData(): Uint8Array {
  if (extensionFreqData) {
    freqData.set(extensionFreqData)
    return freqData
  }
  if (!analyser) {
    freqData.fill(0)
    return freqData
  }
  fillFreqData()
  return freqData
}

export function getAudioElement() {
  return audioElement
}

export function getExtensionWaveData(): Uint8Array | null {
  return extensionWaveData
}

export function getAudioSourceMode(): 'live' | 'idle' {
  if (extensionFreqData) return 'live'
  if (analyser) return 'live'
  return 'idle'
}

export function setAudioVolume(volume: number) {
  desiredVolume = Math.max(0, Math.min(1, volume))
  if (gainNode) {
    gainNode.gain.value = desiredVolume
  }
}
export function getSampleRate(): number {
  // fallback matters when extension audio is active and no real AudioContext exists yet
  return audioContext?.sampleRate ?? 48000
}

export function getSharedAnalyserNode(): AnalyserNode | null {
  return analyser
}