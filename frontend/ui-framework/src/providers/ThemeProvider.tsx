import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeContextValue {
  /** What the user chose, including "system". */
  preference: ThemePreference
  /** What is actually applied right now. Never "system". */
  theme: ResolvedTheme
  system: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export interface ThemeProviderProps {
  children: ReactNode
  /** Used when nothing is stored yet. */
  defaultPreference?: ThemePreference
  /** localStorage key. Pass `null` to disable persistence entirely. */
  storageKey?: string | null
  /** Element the `data-theme` attribute is written to. Defaults to <html>. */
  target?: HTMLElement | null
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStored(key: string | null): ThemePreference | null {
  if (!key || typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(key)
    return value === 'light' || value === 'dark' || value === 'system' ? value : null
  } catch {
    // Storage throws rather than returning null in Safari private mode and
    // under some enterprise policies. A theme is not worth crashing the app.
    return null
  }
}

/**
 * Owns the resolved theme and writes it to `data-theme`.
 *
 * The attribute is the single source of truth for CSS; nothing in the framework
 * reads `prefers-color-scheme` directly. That indirection is what lets a user
 * pin light mode on a machine set to dark, and what makes the resolved theme
 * assertable from a test.
 *
 * On mount the stored preference is read once and applied. To avoid the flash
 * of the wrong theme before React hydrates, render `themeInitScript` in <head>;
 * it applies the same attribute synchronously during parse.
 */
export function ThemeProvider({
  children,
  defaultPreference = 'system',
  storageKey = 't-lingual-theme',
  target,
}: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => readStored(storageKey) ?? defaultPreference,
  )
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)

  // Tracked live rather than read once: a user switching their OS to dark at
  // sunset should see the app follow while it is open, not on next reload.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const list = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystem(list.matches ? 'dark' : 'light')
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])

  const theme: ResolvedTheme = preference === 'system' ? system : preference

  // Written as the change commits, before paint: a swap that animates between
  // themes (irisTransition) captures the new one as soon as its update returns.
  useLayoutEffect(() => {
    const element = target ?? (typeof document !== 'undefined' ? document.documentElement : null)
    if (!element) return
    element.setAttribute('data-theme', theme)
  }, [theme, target])

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next)
      if (!storageKey || typeof window === 'undefined') return
      try {
        window.localStorage.setItem(storageKey, next)
      } catch {
        // See readStored — persistence is best-effort.
      }
    },
    [storageKey],
  )

  const value = useMemo(
    () => ({ preference, theme, system, setPreference }),
    [preference, theme, system, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside a <ThemeProvider>')
  return context
}

/**
 * Blocking script for <head>, rendered with `dangerouslySetInnerHTML`.
 *
 * Must run before first paint, which means it cannot be a module and cannot be
 * deferred. Without it the page paints light, React mounts, and the theme snaps
 * to dark — a full-viewport flash on every load for every dark-mode user.
 */
export function themeInitScript(storageKey = 't-lingual-theme'): string {
  return `(function(){try{var p=localStorage.getItem(${JSON.stringify(storageKey)});var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=p==='light'||p==='dark'?p:(d?'dark':'light');document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`
}
