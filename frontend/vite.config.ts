import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), '')
  const developmentMockEnabled = command === 'serve' && mode === 'development' && environment.VITE_USE_MOCK_API === 'true'

  return {
    // The framework's collapse mark loads a worker file that sits beside the
    // package's modules. Pre-bundling would move those modules into Vite's
    // cache and leave the worker behind, so the package is served as it ships;
    // its own dependencies are still pre-bundled.
    optimizeDeps: { exclude: ['@tular/ui'], include: ['@tular/ui > react-markdown', '@tular/ui > remark-gfm'] },
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
      include: ['src/**/*.test.{ts,tsx}'],
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
      css: true,
      coverage: { reporter: ['text', 'html'] },
    },
  }
})
