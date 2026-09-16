import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Component tests run in jsdom against the real components; the API is stubbed at
 * `fetch`, which is where this project's frontend boundary actually is (the client
 * in src/api is the only thing that talks to it).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
  },
})
