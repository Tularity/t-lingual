import { useMemo } from 'react'
import { useI18n } from '../../app/i18n'
import { localeIntlTag } from '../../app/i18n/locales'

/** Numbers, durations and sizes the statistics and monitoring pages show, in the reader's language. */
export function useInsightFormat() {
  const { t, locale, formatDate } = useI18n()
  return useMemo(() => {
    const tag = localeIntlTag(locale)
    const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 })
    const whole = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 })
    const compact = new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 })
    const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 })
    const format = {
      number: (value: number) => number.format(value),
      whole: (value: number) => whole.format(value),
      compact: (value: number) => compact.format(value),
      /** A ratio from 0 to 1. */
      percent: (ratio: number) => percent.format(ratio),
      /** A percentage from 0 to 100. */
      percentOf100: (value: number) => percent.format(value / 100),
      /** A length of time a person reads: "2 h 5 min", "12 min", "40 s". */
      duration(seconds: number) {
        const total = Math.max(0, Math.round(seconds))
        if (total < 60) return t('{count} s', { count: total })
        const minutes = Math.round(total / 60)
        if (minutes < 60) return t('{count} min', { count: minutes })
        const hours = Math.floor(minutes / 60)
        const rest = minutes % 60
        // Past a hundred hours the minutes are noise.
        if (hours >= 100) return t('{count} h', { count: whole.format(Math.round(minutes / 60)) })
        return rest ? t('{hours} h {minutes} min', { hours: whole.format(hours), minutes: rest }) : t('{count} h', { count: whole.format(hours) })
      },
      /** A length of time in one short figure: "10.5 h", "42 min". */
      shortDuration: (seconds: number) => seconds >= 3600 ? t('{count} h', { count: number.format(seconds / 3600) }) : t('{count} min', { count: whole.format(seconds / 60) }),
      milliseconds: (value: number) => t('{count} ms', { count: number.format(value) }),
      megabytes: (value: number) => value >= 1024 ? `${number.format(value / 1024)} GB` : `${whole.format(value)} MB`,
      bytes(value: number) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let size = Math.max(0, value)
        let unit = 0
        while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
        return `${unit ? number.format(size) : whole.format(size)} ${units[unit]}`
      },
      /** A calendar date from the server's YYYY-MM-DD, without shifting it through a time zone. */
      day: (date: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => formatDate(`${date}T12:00:00Z`, { ...options, timeZone: 'UTC' }),
      clock: (value: string) => formatDate(value, { hour: '2-digit', minute: '2-digit' }),
      clockSeconds: (value: string) => formatDate(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }
    return format
  }, [t, locale, formatDate])
}

export type InsightFormat = ReturnType<typeof useInsightFormat>

/**
 * Seconds charted in hours or minutes, whichever the largest value suits,
 * so the axis steps are whole units; each reading still shows as a duration.
 */
export function durationScale(values: ReadonlyArray<number>, format: InsightFormat) {
  const unit = Math.max(0, ...values) >= 5400 ? 3600 : 60
  return { unit, scale: (seconds: number) => seconds / unit, formatY: (value: number) => value === 0 ? '0' : format.duration(value * unit) }
}

/** The reader's offset from UTC in minutes, as the usage endpoints take it. */
export function localOffsetMinutes() {
  return -new Date().getTimezoneOffset()
}

/** Weekday names, Sunday first, as the usage heat map's rows are. */
export function weekdayNames(locale: string) {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2024, 0, 7 + day))))
}
