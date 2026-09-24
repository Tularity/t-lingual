import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'

// Library build. The app consumes this package through a source alias during
// development (see the app's vite config), so this build exists for producing a
// distributable surface and for proving the package compiles in isolation —
// which is what actually keeps the framework layer honest.
export default defineConfig({
  // Colocated tests are typechecked but must not reach the published types:
  // emitting a .d.ts for a test file leaks its imports into the package surface.
  plugins: [
    react(),
    dts({ include: ['src'], exclude: ['**/*.test.*'], rollupTypes: false }),
  ],
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 't-lingual-ui',
    },
    rollupOptions: {
      // Never bundle React: two copies in one page break hooks.
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
})
