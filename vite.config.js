import { defineConfig } from 'vite'

// In development the API server runs separately (npm run server); Vite forwards /api to it.
// Host is kept as the page's host so the API's same-origin check passes.
export default defineConfig({
  server: {
    proxy: {
      '/api': { target:`http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin:false, xfwd:true },
    },
  },
})
