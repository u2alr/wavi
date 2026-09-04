chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'audio-data' && message.type !== 'capture-status') return
  window.postMessage({
    source: 'visualizer-audio-extension',
    type: message.type,
    bins: message.bins,
    signal: message.signal,
    status: message.status,
    message: message.message,
  }, '*')
})
