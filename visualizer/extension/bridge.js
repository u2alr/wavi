chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'audio-data' && message.type !== 'capture-status') return
  window.postMessage(
    {
      source: 'visualizer-audio-extension',
      type: message.type,
      bins: message.bins,
      wave: message.wave,
      signal: message.signal,
      status: message.status,
      message: message.message,
    },
    // The page's own origin rather than '*'. The app already checks
    // event.source, so this is depth, not the only guard.
    window.location.origin,
  )
})
