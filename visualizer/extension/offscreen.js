let context = null
let analyser = null
let source = null
let captureTabId = null
let bins = new Uint8Array(256)

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type !== 'start-capture') return
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

async function startCapture(streamId) {
  if (source) source.disconnect()
  if (context) await context.close()

  const stream = await navigator.mediaDevices.getUserMedia({
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
  source = context.createMediaStreamSource(stream)
  source.connect(analyser)
  // tabCapture mutes the captured tab; route it back so Spotify stays audible.
  source.connect(context.destination)
  await context.resume()

  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    source?.disconnect()
    source = null
  })
  sample()
}

function sample() {
  if (!analyser || !captureTabId) return
  analyser.getByteFrequencyData(bins)
  let signal = 0
  for (const value of bins) signal += value
  chrome.runtime.sendMessage({
    type: 'audio-data',
    tabId: captureTabId,
    bins: Array.from(bins),
    signal,
  })
  setTimeout(sample, 33)
}
