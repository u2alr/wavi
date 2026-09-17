import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AppErrorBoundary from './components/AppErrorBoundary'
import './styles/index.css'

// ponytail: @react-three/fiber@9.7.0 news up THREE.Clock internally;
// three deprecated it without shipping Timer migration upstream yet.
// Scoped to this exact string — drop when fiber migrates.
const warn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('THREE.Clock')) return
  warn(...args)
}

// Rejected promises (playback calls, lyric fetches, SDK handshakes) never reach
// an error boundary. Log them behind one stable prefix so a failing call is
// findable instead of vanishing as a bare console entry.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection:', event.reason)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
)