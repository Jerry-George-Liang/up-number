import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/local-api': 'http://127.0.0.1:43123',
      '/bootstrap': 'http://127.0.0.1:43123',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
