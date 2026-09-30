import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import { Icon } from '../../icons/Icon'
import { Button } from '../Button/Button'
import { Menu, MenuCheckboxItem, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../Menu/Menu'
import { Pagination } from '../Pagination/Pagination'
import { Select, SelectOption } from '../Select/Select'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeaderCell,
  TableRow,
  type TableAlign,
  type TableDensity,
  type TableRowProps,
  type TableSortDirection,
} from '../Table/Table'
import './DataTable.css'

export interface DataTableColumn<Row> {
  /** Stable identity: the key for sorting, hiding and React. */
  id: string
  header: ReactNode
  /** Plain name for the column menu and for stacked cards. Defaults to `header` when that is text. */
  label?: string
  cell: (row: Row) => ReactNode
  /** Makes the column sortable, by this value. `null` and `undefined` sort last either way. */
  sortValue?: (row: Row) => string | number | null | undefined
  /** The direction a first click sorts in. Dates and counts usually want `descending`. */
  firstSort?: TableSortDirection
  align?: TableAlign
  numeric?: boolean
  truncate?: boolean
  /** Whether the column menu may hide it. Default true; keep the column that names a row visible. */
  hideable?: boolean
  /** A CSS width for the column, when its content should not decide it. */
  width?: string
}

export interface DataTableSort {
  column: string
  direction: TableSortDirection
}

export interface DataTableLabels {
  /** Accessible name of the options button. */
  options: string
  columns: string
  density: string
  densities: Record<TableDensity, string>
  rowsPerPage: string
  /** "1–20 of 134". */
  range: (first: number, last: number, total: number) => string
  pagination: string
  previous: string
  next: string
  page: (page: number) => string
}

const defaultLabels: DataTableLabels = {
  options: 'Table options',
  columns: 'Columns',
  density: 'Density',
  densities: { compact: 'Compact', default: 'Default', comfortable: 'Comfortable' },
  rowsPerPage: 'Rows per page',
  range: (first, last, total) => (total === 0 ? '0 rows' : `${first}–${last} of ${total}`),
  pagination: 'Pagination',
  previous: 'Previous page',
  next: 'Next page',
  page: (page) => `Page ${page}`,
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[]
  rows: readonly Row[]
  rowKey: (row: Row) => string
  /** Names the table for assistive technology; hidden unless `captionHidden` is false. */
  caption: ReactNode
  captionHidden?: boolean
  sort?: DataTableSort | null
  defaultSort?: DataTableSort | null
  onSortChange?: (sort: DataTableSort | null) => void
  page?: number
  defaultPage?: number
  onPageChange?: (page: number) => void
  pageSize?: number
  defaultPageSize?: number
  onPageSizeChange?: (pageSize: number) => void
  pageSizeOptions?: readonly number[]
  hiddenColumns?: readonly string[]
  defaultHiddenColumns?: readonly string[]
  onHiddenColumnsChange?: (hidden: readonly string[]) => void
  density?: TableDensity
  defaultDensity?: TableDensity
  onDensityChange?: (density: TableDensity) => void
  /** Search, filters and actions, set before the options button. */
  toolbar?: ReactNode
  /** Shown in the body when there are no rows. */
  empty?: ReactNode
  /** Beside the range in the footer: "loading more", a note about a limit. */
  footerNote?: ReactNode
  /** Changing it brings the table back to its first page: pass whatever narrowed `rows`. */
  resetPageKey?: unknown
  stackBelow?: number
  rowProps?: (row: Row) => Omit<TableRowProps, 'children'>
  labels?: Partial<DataTableLabels>
  className?: string
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null

function compare(a: string | number | null | undefined, b: string | number | null | undefined) {
  const aMissing = a === null || a === undefined || a === ''
  const bMissing = b === null || b === undefined || b === ''
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator ? collator.compare(String(a), String(b)) : String(a).localeCompare(String(b))
}

function columnLabel<Row>(column: DataTableColumn<Row>) {
  return column.label ?? (typeof column.header === 'string' ? column.header : column.id)
}

/**
 * A list of records to work through: sorted by any sortable column, read a
 * page at a time, with the columns and the density the reader chooses.
 *
 * It is the framework's Table and Pagination put together, and it keeps their
 * semantics — a real `<table>` whose sortable headers are buttons, a pager in
 * its own landmark. Everything it decides is presentation over rows it was
 * given; filtering belongs to whoever supplies `rows` (a search box in
 * `toolbar`, say), which also passes `resetPageKey` so a narrower list starts
 * again from its first page.
 *
 * Every piece of state is controlled or not, so an app can keep the reader's
 * choice of columns, density and page size wherever it keeps preferences.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  captionHidden = true,
  sort: sortProp,
  defaultSort = null,
  onSortChange,
  page: pageProp,
  defaultPage = 1,
  onPageChange,
  pageSize: pageSizeProp,
  defaultPageSize = 20,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
  hiddenColumns: hiddenProp,
  defaultHiddenColumns = [],
  onHiddenColumnsChange,
  density: densityProp,
  defaultDensity = 'default',
  onDensityChange,
  toolbar,
  empty,
  footerNote,
  resetPageKey,
  stackBelow,
  rowProps,
  labels: labelOverrides,
  className,
}: DataTableProps<Row>) {
  const labels = { ...defaultLabels, ...labelOverrides }
  const [sort, setSort] = useControllableState<DataTableSort | null>({ value: sortProp, defaultValue: defaultSort, onChange: onSortChange })
  const [page, setPage] = useControllableState({ value: pageProp, defaultValue: defaultPage, onChange: onPageChange })
  const [pageSize, setPageSize] = useControllableState({ value: pageSizeProp, defaultValue: defaultPageSize, onChange: onPageSizeChange })
  const [hidden, setHidden] = useControllableState<readonly string[]>({ value: hiddenProp, defaultValue: defaultHiddenColumns, onChange: onHiddenColumnsChange })
  const [density, setDensity] = useControllableState<TableDensity>({ value: densityProp, defaultValue: defaultDensity, onChange: onDensityChange })

  // A narrower list starts again from its first page.
  const lastResetKey = useRef(resetPageKey)
  useEffect(() => {
    if (Object.is(lastResetKey.current, resetPageKey)) return
    lastResetKey.current = resetPageKey
    setPage(1)
  }, [resetPageKey, setPage])

  const visible = columns.filter((column) => !hidden.includes(column.id))
  const sorted = useMemo(() => {
    const column = sort && columns.find((candidate) => candidate.id === sort.column)
    if (!sort || !column?.sortValue) return rows
    const value = column.sortValue
    const sign = sort.direction === 'ascending' ? 1 : -1
    // Missing values stay last whichever way the column is sorted.
    return [...rows].sort((a, b) => {
      const left = value(a), right = value(b)
      const missing = (left === null || left === undefined || left === '') !== (right === null || right === undefined || right === '')
      return missing ? compare(left, right) : sign * compare(left, right)
    })
  }, [rows, columns, sort])

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(Math.max(1, page), pageCount)
  const first = (currentPage - 1) * pageSize
  const shown = sorted.slice(first, first + pageSize)
  const sizes = pageSizeOptions.includes(pageSize) ? pageSizeOptions : [...pageSizeOptions, pageSize].sort((a, b) => a - b)

  const toggleSort = (column: DataTableColumn<Row>) => {
    const next: TableSortDirection = sort?.column === column.id
      ? sort.direction === 'ascending' ? 'descending' : 'ascending'
      : column.firstSort ?? 'ascending'
    setSort({ column: column.id, direction: next })
    setPage(1)
  }
  const toggleColumn = (id: string, show: boolean) => {
    setHidden((current) => show ? current.filter((item) => item !== id) : [...current, id])
  }
  const hideable = columns.filter((column) => column.hideable !== false)

  return (
    <div data-tl="data-table" className={cx('tl-data-table', className)}>
      <div className="tl-data-table__toolbar">
        <div className="tl-data-table__tools">{toolbar}</div>
        <Menu
          placement="bottom-end"
          aria-label={labels.options}
          trigger={<Button className="tl-data-table__options" iconOnly icon={<Icon name="columns" />} aria-label={labels.options} title={labels.options} />}
        >
          {hideable.length > 0 && (
            <MenuGroup label={labels.columns}>
              {hideable.map((column) => {
                const isVisible = !hidden.includes(column.id)
                return (
                  <MenuCheckboxItem
                    key={column.id}
                    checked={isVisible}
                    // The last column left showing stays: a table of no columns is no table.
                    disabled={isVisible && visible.length <= 1}
                    onCheckedChange={(checked) => toggleColumn(column.id, checked)}
                  >
                    {columnLabel(column)}
                  </MenuCheckboxItem>
                )
              })}
            </MenuGroup>
          )}
          {hideable.length > 0 && <MenuSeparator />}
          <MenuGroup label={labels.density}>
            <MenuRadioGroup value={density} onValueChange={(value) => setDensity(value as TableDensity)}>
              {(['compact', 'default', 'comfortable'] as const).map((value) => (
                <MenuRadioItem key={value} value={value} closeOnSelect={false}>{labels.densities[value]}</MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </Menu>
      </div>

      <div className="tl-data-table__surface">
        <Table density={density} stackBelow={stackBelow} caption={caption} captionHidden={captionHidden} columnCount={visible.length}>
          <TableHead>
            <TableRow>
              {visible.map((column) => (
                <TableHeaderCell
                  key={column.id}
                  align={column.align}
                  numeric={column.numeric}
                  style={column.width ? { width: column.width } : undefined}
                  sortable={Boolean(column.sortValue)}
                  sortDirection={sort?.column === column.id ? sort.direction : null}
                  onSort={column.sortValue ? () => toggleSort(column) : undefined}
                >
                  {column.header}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          {/* Keyed by the page, so a new page's rows make their entrance. */}
          <TableBody key={currentPage} className="tl-data-table__body">
            {shown.length === 0 ? (
              <TableEmpty>{empty}</TableEmpty>
            ) : (
              shown.map((row) => (
                <TableRow key={rowKey(row)} {...rowProps?.(row)}>
                  {visible.map((column) => (
                    <TableCell key={column.id} align={column.align} numeric={column.numeric} truncate={column.truncate} label={columnLabel(column)}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="tl-data-table__footer">
        <p className="tl-data-table__range" aria-live="polite">
          {labels.range(sorted.length ? first + 1 : 0, first + shown.length, sorted.length)}
          {footerNote && <span className="tl-data-table__note">{footerNote}</span>}
        </p>
        {sorted.length > sizes[0]! && (
          <label className="tl-data-table__size">
            <span>{labels.rowsPerPage}</span>
            <Select size="sm" value={String(pageSize)} aria-label={labels.rowsPerPage} onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}>
              {sizes.map((size) => <SelectOption key={size} value={String(size)}>{size}</SelectOption>)}
            </Select>
          </label>
        )}
        {pageCount > 1 && (
          <Pagination
            size="sm"
            count={pageCount}
            page={currentPage}
            onPageChange={setPage}
            label={labels.pagination}
            previousLabel={labels.previous}
            nextLabel={labels.next}
            pageLabel={labels.page}
          />
        )}
      </div>
    </div>
  )
}
