const OFFSCREEN_URL = 'offscreen.html'

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (contexts.length > 0) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Analyze the active tab audio for the visualizer.',
  })
}

async function sendToOffscreen(message) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await chrome.runtime.sendMessage(message)
      return
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith('http')) return
  try {
    await ensureOffscreen()
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })
    await sendToOffscreen({ type: 'start-capture', streamId, tabId: tab.id })
  } catch (error) {
    console.error('Visualizer capture failed:', error)
    chrome.tabs.sendMessage(tab.id, {
      type: 'capture-status',
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
  }
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'audio-data' && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, message).catch(() => {})
  }
  if (message.type === 'capture-status' && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, message).catch(() => {})
  }
})
