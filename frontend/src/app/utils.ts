export const languages: Array<{ code: string; label: string; native: string }> = [
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'az', label: 'Azerbaijani', native: 'Azərbaycanca' },
  { code: 'bg', label: 'Bulgarian', native: 'Български' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'ca', label: 'Catalan', native: 'Català' },
  { code: 'cs', label: 'Czech', native: 'Čeština' },
  { code: 'da', label: 'Danish', native: 'Dansk' },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά' },
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'fa', label: 'Persian', native: 'فارسی' },
  { code: 'fi', label: 'Finnish', native: 'Suomi' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'he', label: 'Hebrew', native: 'עברית' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'kk', label: 'Kazakh', native: 'Қазақша' },
  { code: 'km', label: 'Khmer', native: 'ខ្មែរ' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'lo', label: 'Lao', native: 'ລາວ' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'my', label: 'Burmese', native: 'မြန်မာ' },
  { code: 'no', label: 'Norwegian', native: 'Norsk' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'ro', label: 'Romanian', native: 'Română' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'sk', label: 'Slovak', native: 'Slovenčina' },
  { code: 'sl', label: 'Slovenian', native: 'Slovenščina' },
  { code: 'sv', label: 'Swedish', native: 'Svenska' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'th', label: 'Thai', native: 'ไทย' },
  { code: 'tl', label: 'Tagalog', native: 'Filipino' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
  { code: 'ur', label: 'Urdu', native: 'اردو' },
  { code: 'uz', label: 'Uzbek', native: 'Oʻzbekcha' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'yue', label: 'Cantonese', native: '粵語' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)', native: '繁體中文' },
]

export function languageName(code: string) {
  const aliases: Record<string, string> = {
    'ja-JP': 'ja', 'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans',
    'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', 'zh-MO': 'zh-Hant',
  }
  const canonical = aliases[code] ?? code
  return languages.find((language) => language.code === canonical)?.label ?? code
}

export function formatDuration(milliseconds: number) {
  if (!milliseconds) return 'Not started'
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function formatTimestamp(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatDate(value: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value))
}

export function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.'
  if (error instanceof Error) return error.message
  return 'Something went wrong. Please try again.'
}

/** How long ago `timestamp` was, briefly: 'Just now' (an interface string to translate) under a minute, then minutes, hours and days in `locale`. */
export function relativeTime(timestamp: string, now: number, locale = 'en') {
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000))
  if (seconds < 60) return 'Just now'
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' })
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86400) return format.format(-Math.floor(seconds / 3600), 'hour')
  return format.format(-Math.floor(seconds / 86400), 'day')
}
