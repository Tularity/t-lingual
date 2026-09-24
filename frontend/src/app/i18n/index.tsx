import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../api/client'
import type { UserSettings } from '../../api/contracts'
import { useAuth } from '../auth'
import { useTheme, useToast } from '../../design-system'
import type { ThemeMode } from '../../design-system/theme'
import { localeCatalogs, localeAvailable, loadLocaleCatalog } from './catalogs'
import { canonicalInterfaceLanguage, localeDirection, localeIntlTag, resolveBrowserInterfaceLanguage } from './locales'
import type { InterfaceLanguage, ResolvedLanguage } from './locales'
export type { InterfaceLanguage, ResolvedLanguage } from './locales'

type InterfaceSettings = UserSettings & { interfaceLanguage?: InterfaceLanguage; themePreference?: ThemeMode }
type Params = Record<string, string | number | null | undefined>

export function resolveInterfaceLanguage(preference: InterfaceLanguage, systemLanguages: readonly string[] = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])): ResolvedLanguage {
  return preference === 'system' ? resolveBrowserInterfaceLanguage(systemLanguages) : preference
}
export function normalizeInterfaceLanguage(value: unknown): InterfaceLanguage {
  return value === 'system' ? 'system' : canonicalInterfaceLanguage(value) ?? 'system'
}
export function normalizeThemePreference(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}
export function translate(locale: ResolvedLanguage, key: string, params?: Params): string {
  const value = locale === 'en' ? key : localeCatalogs[locale]?.[key] ?? key
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu, (match, name: string) => params?.[name] == null ? match : String(params[name]))
}
export function formatInterfaceDate(value: string | number | Date, locale: ResolvedLanguage, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(localeIntlTag(locale), options).format(date)
}

interface I18nValue {
  preference: InterfaceLanguage
  locale: ResolvedLanguage
  setPreference: (next: InterfaceLanguage) => void
  setThemePreference: (next: ThemeMode) => void
  languagePreference: InterfaceLanguage
  resolvedLanguage: ResolvedLanguage
  systemLanguage: ResolvedLanguage
  setLanguagePreference: (next: InterfaceLanguage) => void
  t: (key: string, params?: Params) => string
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string
}
const defaultValue: I18nValue = {
  preference: 'system', locale: 'en', setPreference: () => undefined, setThemePreference: () => undefined,
  languagePreference: 'system', resolvedLanguage: 'en', systemLanguage: 'en', setLanguagePreference: () => undefined,
  t: (key, params) => translate('en', key, params), formatDate: (value, options) => formatInterfaceDate(value, 'en', options),
}
const Context = createContext<I18nValue>(defaultValue)
const cacheKey = (userId: string) => `t-lingual.interface.${userId}`
function readCache(userId: string): { language: InterfaceLanguage; theme: ThemeMode } | null {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey(userId)) ?? 'null') as Record<string, unknown> | null
    return value ? { language: normalizeInterfaceLanguage(value.language), theme: normalizeThemePreference(value.theme) } : null
  } catch { return null }
}
function writeCache(userId: string, language: InterfaceLanguage, theme: ThemeMode) {
  try { localStorage.setItem(cacheKey(userId), JSON.stringify({ language, theme })) } catch { /* Private browsing can disable storage. */ }
}

/** Changing interface preferences updates context/CSS in place; feature pages and audio leases stay mounted. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { setMode } = useTheme()
  const { push } = useToast()
  const [languagePreference, setLanguage] = useState<InterfaceLanguage>('system')
  const [activeLocale, setActiveLocale] = useState<ResolvedLanguage>('en')
  const [systemLanguages, setSystemLanguages] = useState<readonly string[]>(() => navigator.languages ?? [navigator.language])
  const state = useRef<{ userId: string | null; language: InterfaceLanguage; theme: ThemeMode }>({ userId: null, language: 'system', theme: 'system' })
  const generation = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const localChanges = useRef(0)
  const userId = user?.id ?? null
  useEffect(() => {
    const update = () => setSystemLanguages([...(navigator.languages ?? [navigator.language])])
    window.addEventListener('languagechange', update)
    return () => window.removeEventListener('languagechange', update)
  }, [])
  useLayoutEffect(() => {
    const epoch = ++generation.current
    let active = true
    const startChanges = localChanges.current
    state.current.userId = userId
    // An account switch must not display the previous account's chosen locale.
    queueMicrotask(() => { if (active) setActiveLocale('en') })
    if (!userId) {
      const anonymous = readCache('anonymous')
      state.current = { userId: null, language: anonymous?.language ?? 'system', theme: anonymous?.theme ?? 'system' }
      setLanguage(state.current.language); setMode(state.current.theme)
      return () => { active = false }
    }
    const cached = readCache(userId)
    const language = cached?.language ?? 'system'
    const theme = cached?.theme ?? 'system'
    state.current = { userId, language, theme }
    setLanguage(language); setMode(theme)
    void api.settings.get().then((settings) => {
      if (!active || generation.current !== epoch || localChanges.current !== startChanges) return
      const server = settings as InterfaceSettings
      const language = normalizeInterfaceLanguage(server.interfaceLanguage)
      const theme = normalizeThemePreference(server.themePreference)
      state.current = { userId, language, theme }
      setLanguage(language); setMode(theme); writeCache(userId, language, theme)
    }).catch(() => { /* Scoped cache remains usable while offline. */ })
    return () => { active = false }
  }, [userId, setMode])

  const persist = useCallback((next: { language: InterfaceLanguage; theme: ThemeMode }) => {
    const account = state.current.userId
    if (!account) { writeCache('anonymous', next.language, next.theme); return }
    writeCache(account, next.language, next.theme)
    queue.current = queue.current.catch(() => undefined).then(async () => {
      if (state.current.userId !== account) return
      await api.settings.updateInterface({ interfaceLanguage: state.current.language, themePreference: state.current.theme })
    }).catch(() => {
      if (state.current.userId === account) push({ tone: 'error', title: translate(resolveInterfaceLanguage(state.current.language), 'Preference could not sync'), message: translate(resolveInterfaceLanguage(state.current.language), 'Your choice is saved in this browser. Try again when the connection returns.') })
    })
  }, [push])
  const setLanguagePreference = useCallback((next: InterfaceLanguage) => {
    const language = normalizeInterfaceLanguage(next)
    localChanges.current++
    state.current.language = language
    setLanguage(language)
    persist({ language, theme: state.current.theme })
  }, [persist])
  const setThemePreference = useCallback((next: ThemeMode) => {
    const theme = normalizeThemePreference(next)
    localChanges.current++
    state.current.theme = theme
    setMode(theme)
    persist({ language: state.current.language, theme })
  }, [persist, setMode])
  const systemLanguage = resolveInterfaceLanguage('system', systemLanguages)
  const requestedLocale = resolveInterfaceLanguage(languagePreference, systemLanguages)
  useEffect(() => {
    let active = true
    if (!localeAvailable(requestedLocale)) { queueMicrotask(() => { if (active) setActiveLocale('en') }); return () => { active = false } }
    if (requestedLocale === 'en' || localeCatalogs[requestedLocale]) { queueMicrotask(() => { if (active) setActiveLocale(requestedLocale) }); return () => { active = false } }
    void loadLocaleCatalog(requestedLocale).then(ready => { if (active) setActiveLocale(ready ? requestedLocale : 'en') })
    return () => { active = false }
  }, [requestedLocale, userId])
  const resolvedLanguage = activeLocale
  useEffect(() => { document.documentElement.lang = localeIntlTag(resolvedLanguage); document.documentElement.dir = localeDirection(resolvedLanguage) }, [resolvedLanguage])
  const value = useMemo<I18nValue>(() => ({ preference: languagePreference, locale: resolvedLanguage, setPreference: setLanguagePreference, setThemePreference, languagePreference, resolvedLanguage, systemLanguage, setLanguagePreference,
    t: (key, params) => translate(resolvedLanguage, key, params),
    formatDate: (date, options) => formatInterfaceDate(date, resolvedLanguage, options),
  }), [languagePreference, resolvedLanguage, systemLanguage, setLanguagePreference, setThemePreference])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
/** Translation-only context for a separate React root such as Document Picture-in-Picture. */
export function I18nTextProvider({ locale, children }: { locale: ResolvedLanguage; children: ReactNode }) {
  const [active, setActive] = useState<ResolvedLanguage>(localeCatalogs[locale] || locale === 'en' ? locale : 'en')
  useEffect(() => {
    let mounted = true
    void loadLocaleCatalog(locale).then(ready => { if (mounted) setActive(ready ? locale : 'en') })
    return () => { mounted = false }
  }, [locale])
  const value = useMemo<I18nValue>(() => ({ ...defaultValue,
    preference: locale, languagePreference: locale, locale: active, resolvedLanguage: active,
    t: (key, params) => translate(active, key, params),
    formatDate: (date, options) => formatInterfaceDate(date, active, options),
  }), [active, locale])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useI18n() { return useContext(Context) }
