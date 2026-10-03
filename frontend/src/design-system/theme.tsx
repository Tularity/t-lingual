import { useEffect, type ReactNode } from 'react'
import { ThemeProvider as Provider, useTheme as useUITheme } from '@tular/ui'
export type ThemeMode = 'system' | 'light' | 'dark'
function ThemeChrome() {
  const { theme } = useUITheme()
  useEffect(() => { document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17130f' : '#f7f2e8') }, [theme])
  return null
}
export function ThemeProvider({ children }: { children: ReactNode }) { return <Provider storageKey={null}><ThemeChrome />{children}</Provider> }
export function useTheme() { const { preference, theme, system, setPreference } = useUITheme(); return { mode: preference, resolved: theme, system, setMode: setPreference } }
