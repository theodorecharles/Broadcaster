import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    proxy: {
      '/manifest.json': 'http://localhost:12121',
      '/channels': 'http://localhost:12121',
      '/api': 'http://localhost:12121'
    }
  }
})
