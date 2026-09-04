let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let source: MediaElementAudioSourceNode | MediaStreamAudioSourceNode | null = null
let audioElement: HTMLAudioElement | null = null
const freqData = new Uint8Array(256)
let extensionFreqData: Uint8Array | null = null

// When true (Spotify Web Playback SDK is the source), generate a gentle
// time-based "ambient" signal instead of reading a silent analyser.
let ambientMode = false
let spotifyPlaying = false
let spotifyPosition = 0
let spotifyDuration = 1
let spotifyStateTime = performance.now()

export function setAmbientMode(on: boolean) {
  ambientMode = on
}

export function setExtensionAudioData(bins: number[]) {
  extensionFreqData = Uint8Array.from(bins.slice(0, freqData.length))
  ambientMode = false
}

export function clearExtensionAudioData() {
  extensionFreqData = null
}

export function setSpotifyPlaybackState(playing: boolean, position: number, duration: number) {
  spotifyPlaying = playing
  spotifyPosition = position
  spotifyDuration = Math.max(duration, 1)
  spotifyStateTime = performance.now()
}

function ambientBands() {
  const t = performance.now() / 1000
  if (!spotifyPlaying) return { bass: 0.025, mid: 0.02, treble: 0.015, overall: 0.02 }
  const elapsed = spotifyPlaying ? (performance.now() - spotifyStateTime) : 0
  const progress = Math.min(1, (spotifyPosition + elapsed) / spotifyDuration)
  const beat = Math.max(0, Math.sin(t * 5.2 + progress * 30)) ** 6
  const pulse = Math.max(0, Math.sin(t * 2.1 + progress * 18)) ** 4
  const breath = 0.5 + 0.5 * Math.sin(t * 0.55 + progress * 12)
  const bass = 0.34 + 0.3 * breath + 0.3 * beat + 0.12 * pulse
  const mid = 0.24 + 0.2 * Math.sin(t * 1.4 + 1.2 + progress * 8) + 0.16 * beat
  const treble = 0.18 + 0.16 * Math.sin(t * 3.3 + 2.1 + progress * 18) + 0.12 * pulse
  return { bass, mid, treble, overall: (bass + mid + treble) / 3 }
}

export function initAudio(file: File): HTMLAudioElement {
  clearExtensionAudioData()
  if (!audioContext) {
    audioContext = new AudioContext()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.8
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
  analyser.connect(audioContext.destination)

  audioElement.play()
  return audioElement
}

/** Connect browser-captured tab/system audio to the same analyser as local files. */
export function initAudioFromStream(stream: MediaStream): void {
  clearExtensionAudioData()
  if (!audioContext) {
    audioContext = new AudioContext()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.8
  }
  if (!audioContext || !analyser) throw new Error('Failed to initialize audio context')
  if (source) source.disconnect()
  if (audioContext.state === 'suspended') audioContext.resume().catch(console.error)

  ambientMode = false
  source = audioContext.createMediaStreamSource(stream)
  source.connect(analyser)
  // The captured tab is already audible; do not connect it back to speakers.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    source?.disconnect()
  })
}

export function getAudioBands() {
  if (extensionFreqData) freqData.set(extensionFreqData)
  if (ambientMode) return ambientBands()
  if (!analyser) {
    return { bass: 0.05, mid: 0.03, treble: 0.02, overall: 0.03 }
  }
  analyser.getByteFrequencyData(freqData)

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
  if (ambientMode) {
    const bands = ambientBands()
    const time = performance.now() / 1000
    const bassEnd = Math.floor(freqData.length * 0.1)
    const midEnd = Math.floor(freqData.length * 0.4)
    for (let i = 0; i < freqData.length; i++) {
      const band = i < bassEnd ? bands.bass : i < midEnd ? bands.mid : bands.treble
      const harmonic = 0.5 + 0.5 * Math.sin(time * 3.5 + i * 0.19) ** 2
      const ripple = 0.58 + 0.42 * Math.sin(time * 4 + i * 0.43) ** 2
      const shapedBand = band * (0.72 + harmonic * 0.42)
      freqData[i] = Math.min(255, Math.round(shapedBand * ripple * 255))
    }
    return freqData
  }
  if (analyser) analyser.getByteFrequencyData(freqData)
  return freqData
}

export function getAudioElement() {
  return audioElement
}

export function getAudioSourceMode(): 'live' | 'estimated' | 'idle' {
  if (extensionFreqData) return 'live'
  if (ambientMode) return 'estimated'
  if (analyser) return 'live'
  return 'idle'
}