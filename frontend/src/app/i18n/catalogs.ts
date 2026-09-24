import { translations } from './translations'
import type { ResolvedLanguage } from './locales'

/** Static dictionaries are fetched only when that locale is selected. */
export const localeCatalogs: Partial<Record<ResolvedLanguage, Record<string, string>>> = { 'zh-Hans': translations }
export const localeLoaders: Partial<Record<ResolvedLanguage, () => Promise<Record<string, string>>>> = {
  ar: () => import('./catalog/ar').then(module => module.ar),
  bg: () => import('./catalog/bg').then(module => module.bg),
  cs: () => import('./catalog/cs').then(module => module.cs),
  da: () => import('./catalog/da').then(module => module.da),
  de: () => import('./catalog/de').then(module => module.de),
  el: () => import('./catalog/el').then(module => module.el),
  es: () => import('./catalog/es').then(module => module.es),
  et: () => import('./catalog/et').then(module => module.et),
  fi: () => import('./catalog/fi').then(module => module.fi),
  fr: () => import('./catalog/fr').then(module => module.fr),
  he: () => import('./catalog/he').then(module => module.he),
  hi: () => import('./catalog/hi').then(module => module.hi),
  hr: () => import('./catalog/hr').then(module => module.hr),
  hu: () => import('./catalog/hu').then(module => module.hu),
  it: () => import('./catalog/it').then(module => module.it),
  ja: () => import('./catalog/ja').then(module => module.ja),
  ko: () => import('./catalog/ko').then(module => module.ko),
  lt: () => import('./catalog/lt').then(module => module.lt),
  lv: () => import('./catalog/lv').then(module => module.lv),
  mt: () => import('./catalog/mt').then(module => module.mt),
  nb: () => import('./catalog/nb').then(module => module.nb),
  nl: () => import('./catalog/nl').then(module => module.nl),
  nn: () => import('./catalog/nn').then(module => module.nn),
  pl: () => import('./catalog/pl').then(module => module.pl),
  pt: () => import('./catalog/pt').then(module => module.pt),
  ro: () => import('./catalog/ro').then(module => module.ro),
  ru: () => import('./catalog/ru').then(module => module.ru),
  sk: () => import('./catalog/sk').then(module => module.sk),
  sl: () => import('./catalog/sl').then(module => module.sl),
  sv: () => import('./catalog/sv').then(module => module.sv),
  th: () => import('./catalog/th').then(module => module.th),
  tr: () => import('./catalog/tr').then(module => module.tr),
  uk: () => import('./catalog/uk').then(module => module.uk),
  vi: () => import('./catalog/vi').then(module => module.vi),
}
const loading = new Map<ResolvedLanguage, Promise<boolean>>()
export function localeAvailable(locale: ResolvedLanguage): boolean {
  return locale === 'en' || Boolean(localeCatalogs[locale] || localeLoaders[locale])
}
export function loadLocaleCatalog(locale: ResolvedLanguage): Promise<boolean> {
  if (locale === 'en' || localeCatalogs[locale]) return Promise.resolve(true)
  const loader = localeLoaders[locale]
  if (!loader) return Promise.resolve(false)
  const existing = loading.get(locale)
  if (existing) return existing
  const request = loader().then(catalog => { localeCatalogs[locale] = catalog; return true })
    .catch(() => false).finally(() => { loading.delete(locale) })
  loading.set(locale, request)
  return request
}
