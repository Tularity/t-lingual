import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), '')
  const developmentMockEnabled = command === 'serve' && mode === 'development' && environment.VITE_USE_MOCK_API === 'true'

  return {
    resolve: { alias: { '@t-lingual/ui': fileURLToPath(new URL('./ui-framework/src/index.ts', import.meta.url)) } },
    define: { __TLINGUAL_DEVELOPMENT_MOCK__: JSON.stringify(developmentMockEnabled) },
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8088',
          changeOrigin: false,
          ws: true,
        },
      },
    },
    test: {
      include: ['src/**/*.test.{ts,tsx}', 'ui-framework/src/**/*.test.{ts,tsx}'],
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
      css: true,
      coverage: { reporter: ['text', 'html'] },
    },
  }
})
