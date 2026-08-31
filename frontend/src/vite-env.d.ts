/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCK_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __TLINGUAL_DEVELOPMENT_MOCK__: boolean
