import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // three.js + every shader sit in the lazily imported Scene chunk
    // (~940 kB raw / ~250 kB gzip). The limit is raised so that intentional
    // chunk stays quiet while a *new* oversized chunk still warns.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // Mirrors the Pages Function in functions/api/canvas.js — keep the two in
      // sync: anything proxied only here works in dev and breaks in production.
      '/api/canvas': {
        target: 'https://spotify-canva.vercel.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})