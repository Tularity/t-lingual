import { useCallback, useMemo, useState } from 'react'
import type { DataTableLabels, TableDensity } from '@t-lingual/ui'
import { readBrowserStorage, writeBrowserStorage } from '../platform/storage'
import { useI18n } from './i18n'

/** The data table's words, in the interface language. */
export function useDataTableLabels(): Partial<DataTableLabels> {
  const { t } = useI18n()
  return useMemo(() => ({
    options: t('Table options'),
    columns: t('Columns'),
    density: t('Density'),
    densities: { compact: t('Compact'), default: t('Default'), comfortable: t('Comfortable') },
    rowsPerPage: t('Rows per page'),
    range: (first: number, last: number, total: number) => total === 0 ? t('No rows') : t('{first}–{last} of {total}', { first, last, total }),
    pagination: t('Pages'),
    previous: t('Previous page'),
    next: t('Next page'),
    page: (page: number) => t('Page {number}', { number: page }),
  }), [t])
}

interface TablePreferences { hidden: string[]; density: TableDensity; pageSize: number }

/**
 * The reader's choice of columns, density and page size for one table,
 * kept in this browser so the table opens the way it was left.
 */
export function useTablePreferences(key: string, defaults: Partial<TablePreferences> = {}) {
  const storageKey = `t-lingual:table:${key}`
  const [preferences, setPreferences] = useState<TablePreferences>(() => {
    const fallback: TablePreferences = { hidden: defaults.hidden ?? [], density: defaults.density ?? 'default', pageSize: defaults.pageSize ?? 20 }
    try {
      const saved = JSON.parse(readBrowserStorage('local', storageKey) ?? 'null') as Partial<TablePreferences> | null
      if (!saved) return fallback
      return {
        hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((item): item is string => typeof item === 'string') : fallback.hidden,
        density: saved.density === 'compact' || saved.density === 'comfortable' || saved.density === 'default' ? saved.density : fallback.density,
        pageSize: typeof saved.pageSize === 'number' && [10, 20, 50, 100].includes(saved.pageSize) ? saved.pageSize : fallback.pageSize,
      }
    } catch { return fallback }
  })
  const change = useCallback((next: Partial<TablePreferences>) => {
    setPreferences((current) => {
      const merged = { ...current, ...next }
      writeBrowserStorage('local', storageKey, JSON.stringify(merged))
      return merged
    })
  }, [storageKey])
  return {
    hiddenColumns: preferences.hidden,
    onHiddenColumnsChange: (hidden: readonly string[]) => change({ hidden: [...hidden] }),
    density: preferences.density,
    onDensityChange: (density: TableDensity) => change({ density }),
    pageSize: preferences.pageSize,
    onPageSizeChange: (pageSize: number) => change({ pageSize }),
  }
}
