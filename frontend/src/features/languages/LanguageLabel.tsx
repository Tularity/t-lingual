import {useI18n} from '../../app/i18n'
import type { ReactNode } from 'react'
import { languages, languageName } from '../../app/utils'
import { localeIntlTag, type ResolvedLanguage } from '../../app/i18n/locales'
import './languages.css'

const supported = new Set([...languages.map((language) => language.code), 'uk', 'lt', 'et', 'lv', 'mt', 'nb', 'nn'])
const aliases: Record<string, string> = {
  zh: 'zh-Hans', 'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans',
  'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', 'zh-MO': 'zh-Hant',
  'no-NO': 'nb', 'nb-NO': 'nb', 'nn-NO': 'nn',
}

function canonicalLanguage(code: string): string {
  if (supported.has(code)) return code
  const normalized = code.replace(/_/gu, '-')
  const lower = normalized.toLowerCase()
  if (lower === 'auto' || lower === 'mixed' || lower === 'mul' || lower === 'und') return lower
  const alias = aliases[normalized]
  if (alias) return alias
  if (lower === 'zh' || lower.startsWith('zh-hans') || lower.startsWith('zh-cn') || lower.startsWith('zh-sg')) return 'zh-Hans'
  if (lower.startsWith('zh-hant') || lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-mo')) return 'zh-Hant'
  const base = lower.split('-')[0] ?? ''
  if (base === 'no') return 'nb'
  return supported.has(base) ? base : code
}

/** Returns only reviewed local assets; unknown codes cannot construct a URL. */
export function languageFlag(code: string): string | undefined {
  const canonical = canonicalLanguage(code)
  if (canonical === 'auto' || canonical === 'mixed' || canonical === 'mul' || canonical === 'und') return '/flags/globe.svg'
  if (!supported.has(canonical)) return undefined
  if (canonical === 'en') return '/flags/lang-en-au.svg'
  if (canonical === 'zh-Hans') return '/flags/lang-zh.svg'
  if (canonical === 'zh-Hant') return '/flags/tw.svg'
  if (canonical === 'yue') return '/flags/hk.svg'
  if (canonical === 'nb' || canonical === 'nn') return '/flags/lang-no.svg'
  return `/flags/lang-${canonical}.svg`
}

export interface LanguageLabelProps {
  code: string
  children?: ReactNode
  native?: boolean
  compact?: boolean
}

export function languageDisplayName(code: string, locale: ResolvedLanguage = 'en'): string {
  const canonical = canonicalLanguage(code)
  if (canonical === 'auto') return 'Detect automatically'
  if (canonical === 'mixed' || canonical === 'mul') return 'Multiple languages'
  if (canonical === 'und') return 'Unknown language'
  try {
    const display = new Intl.DisplayNames([localeIntlTag(locale)], { type: 'language' }).of(canonical)
    if (display && display !== canonical) return display
  } catch { /* A provider may return a private or malformed language code. */ }
  return languageName(canonical)
}

export function LanguageLabel({ code, children, native = false, compact = false }: LanguageLabelProps) {
  const {t,locale}=useI18n()
  const canonical = canonicalLanguage(code)
  const language = languages.find((item) => item.code === canonical)
  const named = languageDisplayName(code, locale)
  const text = children === undefined || children === language?.label ? t(named) : typeof children==='string' ? t(children) : children
  const nativeName = language?.native
  const showNative = native && !compact && nativeName && nativeName.toLocaleLowerCase() !== String(text).toLocaleLowerCase()
  const flag = languageFlag(code)
  return <span className={`language-label${compact ? ' language-label--compact' : ''}`}>
    {flag && <img className="language-label__flag" src={flag} width={compact ? 16 : 18} height={compact ? 16 : 18} alt="" aria-hidden="true" />}
    <span className="language-label__text" dir="auto">{text}</span>
    {/* Only the name is isolated, so the separator stays between the two names
      * instead of travelling to the far end of a right-to-left one. */}
    {showNative && <span className="language-label__native"><bdi>{nativeName}</bdi></span>}
  </span>
}
