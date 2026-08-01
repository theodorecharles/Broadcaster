import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks: {
          hls: ['hls.js'],
          react: ['react', 'react-dom']
        }
      }
    }
  },
  server: {
    proxy: {
      '/manifest.json': 'http://localhost:12121',
      '/channels': 'http://localhost:12121',
      '/api': 'http://localhost:12121'
    }
  }
})
