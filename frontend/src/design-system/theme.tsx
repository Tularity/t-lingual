import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { readBrowserStorage, writeBrowserStorage } from '../platform/storage'

export type ThemeMode = 'system' | 'light' | 'dark'

interface ThemeContextValue {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)
const STORAGE_KEY = 't-lingual.theme'

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = readBrowserStorage('local', STORAGE_KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  })
  const [system, setSystem] = useState(systemTheme)
  const resolved = mode === 'system' ? system : mode

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      resolved === 'dark' ? '#17130f' : '#f7f2e8',
    )
  }, [resolved])

  const setMode = (next: ThemeMode) => {
    writeBrowserStorage('local', STORAGE_KEY, next)
    setModeState(next)
  }

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
