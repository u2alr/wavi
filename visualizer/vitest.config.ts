import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so the app build config stays untouched
// (and so `tsc -b` doesn't have to typecheck vitest's module graph).
// Tests cover pure logic only — no DOM, no network, no store singletons.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
