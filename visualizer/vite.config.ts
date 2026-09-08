import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api/canvas': {
        target: 'https://spotify-canva.vercel.app',
        changeOrigin: true,
        secure: true,
      },
      // NetEase has no CORS headers — proxy via same origin in dev so the
      // browser never touches music.163.com directly.
      '/api/netease': {
        target: 'https://music.163.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/netease/, '/api'),
        headers: {
          Referer: 'https://music.163.com/',
        },
      },
    },
  },
})