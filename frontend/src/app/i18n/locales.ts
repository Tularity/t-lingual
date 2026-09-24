/** UI language choices, de-duplicated from Nemotron's 40 locale entries.
 * These are interface locales, independent of active ASR capabilities. */
export const interfaceLocales = [
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'he',
  'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'lt', 'lv', 'mt', 'nb', 'nl', 'nn',
  'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-Hans',
] as const
export type ResolvedLanguage = typeof interfaceLocales[number]
export type InterfaceLanguage = ResolvedLanguage | 'system'
const supported = new Set<string>(interfaceLocales)
const aliases: Record<string, ResolvedLanguage> = {
  zh: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-sg': 'zh-Hans',
  'zh-tw': 'zh-Hans', 'zh-hk': 'zh-Hans', 'zh-mo': 'zh-Hans',
  no: 'nb', 'no-no': 'nb',
}
export function canonicalInterfaceLanguage(value: unknown): ResolvedLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/_/gu, '-').toLowerCase()
  if (supported.has(value)) return value as ResolvedLanguage
  if (aliases[normalized]) return aliases[normalized]
  const base = normalized.split('-')[0] ?? ''
  return supported.has(base) ? base as ResolvedLanguage : null
}
export function resolveBrowserInterfaceLanguage(languages: readonly string[]): ResolvedLanguage {
  for (const value of languages) {
    const locale = canonicalInterfaceLanguage(value)
    if (locale) return locale
  }
  return 'en'
}
export function localeIntlTag(locale: ResolvedLanguage): string {
  return locale === 'en' ? 'en-AU' : locale === 'zh-Hans' ? 'zh-CN' : locale
}
export function localeDirection(locale: ResolvedLanguage): 'ltr' | 'rtl' {
  return locale === 'ar' || locale === 'he' ? 'rtl' : 'ltr'
}
export function interfaceLocaleName(locale: ResolvedLanguage, inLocale: ResolvedLanguage = locale): string {
  if (locale === 'en' && inLocale === 'en') return 'English (Australia)'
  try {
    return new Intl.DisplayNames([localeIntlTag(inLocale)], { type: 'language' }).of(localeIntlTag(locale)) ?? locale
  } catch { return locale }
}
const knownFlagCodes = new Set(['ar','bg','cs','da','de','el','es','fi','fr','he','hi','hr','hu','it','ja','ko','nl','pl','pt','ro','ru','sk','sl','sv','th','tr','vi','uk','lt','et','lv','mt'])
export function interfaceLocaleFlag(locale: ResolvedLanguage): string {
  if (locale === 'en') return '/flags/lang-en-au.svg'
  if (locale === 'zh-Hans') return '/flags/lang-zh.svg'
  if (locale === 'nb' || locale === 'nn') return '/flags/lang-no.svg'
  return knownFlagCodes.has(locale) ? `/flags/lang-${locale}.svg` : '/flags/globe.svg'
}
function folded(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}
export function searchInterfaceLocales(query: string, displayLocale: ResolvedLanguage): ResolvedLanguage[] {
  const needle = folded(query.trim())
  if (!needle) return [...interfaceLocales]
  return interfaceLocales.filter(locale => [locale, interfaceLocaleName(locale), interfaceLocaleName(locale, 'en'), interfaceLocaleName(locale, displayLocale)].some(value => folded(value).includes(needle)))
}
