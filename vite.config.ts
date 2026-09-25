import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Fonts ship as files, not inlined data: URIs — the Content-Security-Policy
    // allows same-origin only, and a data: font is refused by it silently.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
