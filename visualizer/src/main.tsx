import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'

// ponytail: @react-three/fiber@9.7.0 news up THREE.Clock internally;
// three deprecated it without shipping Timer migration upstream yet.
// Scoped to this exact string — drop when fiber migrates.
const warn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('THREE.Clock')) return
  warn(...args)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)