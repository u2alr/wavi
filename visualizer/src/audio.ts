let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let gainNode: GainNode | null = null
let source: MediaElementAudioSourceNode | null = null
let audioElement: HTMLAudioElement | null = null
const freqData = new Uint8Array(256)
// Frame-stamp cache: only call getByteFrequencyData once per animation frame
let lastFillTime = -1
let extensionFreqData: Uint8Array | null = null

export function setExtensionAudioData(bins: number[]) {
  extensionFreqData = Uint8Array.from(bins.slice(0, freqData.length))
}

export function clearExtensionAudioData() {
  extensionFreqData = null
}

export function initAudio(file: File): HTMLAudioElement {
  clearExtensionAudioData()
  if (!audioContext) {
    audioContext = new AudioContext()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.8
    gainNode = audioContext.createGain()
  }

  if (audioElement) {
    audioElement.pause()
    if (source) source.disconnect()
  }

  if (!audioContext || !analyser) {
    throw new Error('Failed to initialize audio context')
  }

  if (audioContext.state === 'suspended') audioContext.resume().catch(console.error)

  audioElement = new Audio()
  audioElement.src = URL.createObjectURL(file)
  audioElement.crossOrigin = 'anonymous'

  source = audioContext.createMediaElementSource(audioElement)
  source.connect(analyser)
  if (gainNode) {
    analyser.connect(gainNode)
    gainNode.connect(audioContext.destination)
  }

  audioElement.play()
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
  if (extensionFreqData) freqData.set(extensionFreqData)
  else if (!analyser) {
    return { bass: 0, mid: 0, treble: 0, overall: 0 }
  } else {
    fillFreqData()
  }

  let bass = 0, mid = 0, treble = 0
  const len = freqData.length
  const bassEnd = Math.floor(len * 0.1)
  const midEnd = Math.floor(len * 0.4)

  for (let i = 0; i < bassEnd; i++) bass += freqData[i]
  for (let i = bassEnd; i < midEnd; i++) mid += freqData[i]
  for (let i = midEnd; i < len; i++) treble += freqData[i]

  bass /= bassEnd * 255
  mid /= (midEnd - bassEnd) * 255
  treble /= (len - midEnd) * 255

  return { bass, mid, treble, overall: (bass + mid + treble) / 3 }
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

export function hasExtensionAudio(): boolean {
  return extensionFreqData !== null
}

export function getAudioSourceMode(): 'live' | 'idle' {
  if (extensionFreqData) return 'live'
  if (analyser) return 'live'
  return 'idle'
}

export function setAudioVolume(volume: number) {
  if (gainNode) {
    gainNode.gain.value = Math.max(0, Math.min(1, volume))
  }
}
export function getSampleRate(): number {
  // fallback matters when extension audio is active and no real AudioContext exists yet
  return audioContext?.sampleRate ?? 48000
}