import { defineConfig } from 'vite'

// Vite 8 bundles through Rolldown: multi-page input goes in build.rolldownOptions.input.
// In development `npm run dev` starts the API server too (scripts/dev.js); Vite forwards /api to it.
// Host is kept as the page's host so the API's same-origin check passes.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: 'index.html',
        benchmark: 'benchmark.html',
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: `http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin: false, xfwd: true },
    },
  },
})
