let context = null
let analyser = null
let waveAnalyser = null
let source = null
let stream = null
let captureTabId = null
let capturing = false
let bins = new Uint8Array(256)
let waveData = new Uint8Array(2048)

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'stop-capture') {
    stopCapture()
    return
  }
  if (message.type !== 'start-capture') return
  // Release any previous capture first — Chrome forbids a second live stream
  // on a tab, so a repeat click would otherwise throw
  // "Cannot capture a tab with an active stream".
  stopCapture()
  captureTabId = message.tabId
  try {
    await startCapture(message.streamId)
    chrome.runtime.sendMessage({ type: 'capture-status', status: 'started', tabId: captureTabId })
  } catch (error) {
    chrome.runtime.sendMessage({
      type: 'capture-status',
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      tabId: captureTabId,
    })
  }
})

function stopCapture() {
  capturing = false
  if (stream) {
    stream.getTracks().forEach((track) => track.stop())
    stream = null
  }
  if (source) {
    source.disconnect()
    source = null
  }
  analyser = null
  waveAnalyser = null
  if (context) {
    context.close().catch(() => {})
    context = null
  }
  captureTabId = null
}

async function startCapture(streamId) {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  })

  context = new AudioContext()
  analyser = context.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.72
  // Dedicated waveform tap for oscilloscope presets (2048 time-domain samples).
  // Kept separate so the frequency bins above keep their current 256-bin spread.
  waveAnalyser = context.createAnalyser()
  waveAnalyser.fftSize = 2048
  source = context.createMediaStreamSource(stream)
  source.connect(analyser)
  source.connect(waveAnalyser)
  // tabCapture mutes the captured tab; route it back so Spotify stays audible.
  source.connect(context.destination)
  await context.resume()

  stream.getAudioTracks()[0]?.addEventListener('ended', stopCapture)
  capturing = true
  sample()
}

function sample() {
  if (!capturing || !captureTabId || !analyser) return
  analyser.getByteFrequencyData(bins)
  waveAnalyser?.getByteTimeDomainData(waveData)
  let signal = 0
  for (const value of bins) signal += value
  chrome.runtime.sendMessage({
    type: 'audio-data',
    tabId: captureTabId,
    bins: Array.from(bins),
    wave: waveAnalyser ? Array.from(waveData) : null,
    signal,
  })
  setTimeout(sample, 16)
}
