import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react'
import { cx } from '../../utils/cx'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import './Table.css'

export type TableDensity = 'compact' | 'default' | 'comfortable'
export type TableAlign = 'start' | 'center' | 'end'
export type TableSortDirection = 'ascending' | 'descending'

interface TableContextValue {
  /** True while the table is rendering as a stack of cards. */
  stacked: boolean
  columnCount: number | undefined
}

const TableContext = createContext<TableContextValue>({
  stacked: false,
  columnCount: undefined,
})

/**
 * Which section a header cell sits in, so `scope` can default correctly without
 * the consumer restating it on every cell.
 */
const TableSectionContext = createContext<'head' | 'body'>('body')

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  density?: TableDensity
  /**
   * Pins the header row while the scroll container scrolls. Only has an effect
   * when the container itself is what scrolls — see the note in Table.css.
   */
  stickyHeader?: boolean
  /**
   * Viewport width in px below which every row collapses into a card. Omit to
   * keep the table a table at all widths.
   */
  stackBelow?: number
  caption?: ReactNode
  /** Keeps the caption in the accessibility tree but off the screen. */
  captionHidden?: boolean
  /** Number of columns, used as the default `colSpan` for `TableEmpty`. */
  columnCount?: number
  /** Escape hatch for the scroll container: `style`, `aria-label`, a class. */
  containerProps?: HTMLAttributes<HTMLDivElement>
}

/**
 * A real `<table>`, not a grid of divs.
 *
 * The whole reason to keep the native element is that browsers and screen
 * readers already implement column/row association, table navigation mode and
 * header announcement for it. Every feature below is layered on top of that
 * rather than replacing it.
 *
 * RESPONSIVE STACKING
 * -------------------
 * `stackBelow` is evaluated in JavaScript rather than by a CSS media query,
 * because collapsing the layout has an accessibility consequence that CSS alone
 * cannot repair: switching a `<td>` to `display: block` removes its implicit
 * `cell` role in every engine, and a table whose rows and cells have lost their
 * roles stops being navigable as a table. Knowing the state in JS lets the
 * component re-declare the roles explicitly for exactly as long as the layout
 * is broken, and leave the native semantics untouched the rest of the time.
 *
 * The header is hidden visually rather than removed while stacked, so the
 * column names are still there for assistive technology; the `data-label`
 * text painted next to each value is a sighted-user affordance only.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  {
    density = 'default',
    stickyHeader = false,
    stackBelow,
    caption,
    captionHidden = false,
    columnCount,
    containerProps,
    className,
    children,
    ...rest
  },
  ref,
) {
  // `not all` never matches, which is how the query is switched off without
  // making the hook call conditional.
  const stacked = useMediaQuery(
    stackBelow ? `(max-width: ${stackBelow - 1}px)` : 'not all',
  )

  const context = useMemo<TableContextValue>(
    () => ({ stacked, columnCount }),
    [stacked, columnCount],
  )

  const { className: containerClassName, ...containerRest } = containerProps ?? {}

  return (
    <TableContext.Provider value={context}>
      <div
        data-tl="table-container"
        data-stacked={stacked || undefined}
        className={cx('tl-table__container', containerClassName)}
        // A region that scrolls has to be reachable by keyboard alone (WCAG 2.2
        // SC 2.1.1); a wide table that only responds to a mouse wheel or a drag
        // is unusable without one. Once the rows have collapsed into cards
        // there is nothing left to scroll, so the tab stop is given back.
        tabIndex={stacked ? undefined : 0}
        {...containerRest}
      >
        <table
          ref={ref}
          data-tl="table"
          data-density={density}
          data-sticky-header={stickyHeader || undefined}
          data-stacked={stacked || undefined}
          className={cx('tl-table', className)}
          role={stacked ? 'table' : undefined}
          {...rest}
        >
          {caption != null && (
            <caption
              className={cx(
                'tl-table__caption',
                captionHidden && 'tl-visually-hidden',
              )}
            >
              {caption}
            </caption>
          )}
          {children}
        </table>
      </div>
    </TableContext.Provider>
  )
})

export type TableHeadProps = HTMLAttributes<HTMLTableSectionElement>

export const TableHead = forwardRef<HTMLTableSectionElement, TableHeadProps>(
  function TableHead({ className, ...rest }, ref) {
    const { stacked } = useContext(TableContext)
    return (
      <TableSectionContext.Provider value="head">
        <thead
          ref={ref}
          data-tl="table-head"
          className={cx('tl-table__head', className)}
          role={stacked ? 'rowgroup' : undefined}
          {...rest}
        />
      </TableSectionContext.Provider>
    )
  },
)

export type TableBodyProps = HTMLAttributes<HTMLTableSectionElement>

export const TableBody = forwardRef<HTMLTableSectionElement, TableBodyProps>(
  function TableBody({ className, ...rest }, ref) {
    const { stacked } = useContext(TableContext)
    return (
      <TableSectionContext.Provider value="body">
        <tbody
          ref={ref}
          data-tl="table-body"
          className={cx('tl-table__body', className)}
          role={stacked ? 'rowgroup' : undefined}
          {...rest}
        />
      </TableSectionContext.Provider>
    )
  },
)

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Draws the selected treatment. See the note about `aria-selected` below. */
  selected?: boolean
  /** Adds the hover affordance and the pointer cursor for a clickable row. */
  interactive?: boolean
}

/**
 * `selected` deliberately does not emit `aria-selected`. That attribute is only
 * defined for a row inside a `grid` or `treegrid`; on a plain table it is
 * invalid ARIA, and the engines that do expose it announce a selection state
 * for a row the user has no keyboard means of selecting. In a real selection
 * table the row's own checkbox is both the control and the announced state, so
 * the visual treatment here is exactly that — visual.
 */
export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  function TableRow({ selected = false, interactive = false, className, ...rest }, ref) {
    const { stacked } = useContext(TableContext)
    return (
      <tr
        ref={ref}
        data-tl="table-row"
        data-selected={selected || undefined}
        data-interactive={interactive || undefined}
        className={cx('tl-table__row', className)}
        role={stacked ? 'row' : undefined}
        {...rest}
      />
    )
  },
)

export interface TableCellProps
  extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'> {
  align?: TableAlign
  /** Right-aligns and switches on tabular figures so digits line up. */
  numeric?: boolean
  /** Column name repeated beside the value once the table has stacked. */
  label?: string
  truncate?: boolean
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  function TableCell(
    { align, numeric = false, label, truncate = false, className, ...rest },
    ref,
  ) {
    const { stacked } = useContext(TableContext)
    return (
      <td
        ref={ref}
        data-tl="table-cell"
        data-align={align ?? (numeric ? 'end' : undefined)}
        data-numeric={numeric || undefined}
        data-truncate={truncate || undefined}
        data-label={label}
        className={cx('tl-table__cell', className)}
        role={stacked ? 'cell' : undefined}
        {...rest}
      />
    )
  },
)

export interface TableHeaderCellProps
  extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'align'> {
  align?: TableAlign
  numeric?: boolean
  /** Wraps the label in a button and exposes `aria-sort`. */
  sortable?: boolean
  /** `null` means "sortable but not currently the sort column". */
  sortDirection?: TableSortDirection | null
  onSort?: () => void
}

/**
 * The sortable variant follows the APG's sortable-table pattern: the sort state
 * lives on the header cell as `aria-sort`, and the thing the user activates is
 * a real `<button>` inside it. A `<th>` with a click handler is not an
 * acceptable substitute — it is not focusable, not in the tab order, and does
 * not respond to Enter or Space.
 *
 * The direction affordance is a pair of triangles rather than a single arrow
 * that appears on sort, so the column reads as sortable before it has ever been
 * sorted. Both triangles are dimmed when the column is inactive and the
 * relevant one becomes solid when it is — a shape change, not just a colour
 * change, which is what keeps it legible in high contrast and to a user who
 * cannot separate the two states by hue.
 */
export const TableHeaderCell = forwardRef<HTMLTableCellElement, TableHeaderCellProps>(
  function TableHeaderCell(
    {
      align,
      numeric = false,
      sortable = false,
      sortDirection = null,
      onSort,
      scope,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const { stacked } = useContext(TableContext)
    const section = useContext(TableSectionContext)
    const resolvedScope = scope ?? (section === 'head' ? 'col' : 'row')

    if (import.meta.env?.DEV && sortable && !onSort) {
      console.error(
        '[t-lingual/ui] <TableHeaderCell sortable> renders a button and needs `onSort`. ' +
          'Without it the column announces itself as sortable and then does nothing.',
      )
    }

    return (
      <th
        ref={ref}
        data-tl="table-header-cell"
        data-align={align ?? (numeric ? 'end' : undefined)}
        data-numeric={numeric || undefined}
        data-sortable={sortable || undefined}
        className={cx('tl-table__header-cell', className)}
        scope={resolvedScope}
        aria-sort={sortable ? (sortDirection ?? 'none') : undefined}
        // A `<th scope="row">` is a row header, and stacking must re-declare the
        // role it had rather than a different one: announcing the leading cell
        // of every card as a column header tells the user the value below it
        // belongs to a column that does not exist.
        role={
          stacked
            ? resolvedScope === 'row' || resolvedScope === 'rowgroup'
              ? 'rowheader'
              : 'columnheader'
            : undefined
        }
        {...rest}
      >
        {sortable ? (
          <button type="button" className="tl-table__sort" onClick={onSort}>
            <span className="tl-table__sort-label">{children}</span>
            <svg
              className="tl-table__sort-icon"
              viewBox="0 0 8 14"
              aria-hidden="true"
              focusable="false"
            >
              <path className="tl-table__sort-arrow" data-dir="ascending" d="M4 1l3 4H1z" />
              <path className="tl-table__sort-arrow" data-dir="descending" d="M4 13l-3-4h6z" />
            </svg>
          </button>
        ) : (
          children
        )}
      </th>
    )
  },
)

export interface TableEmptyProps
  extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'colSpan'> {
  colSpan?: number
  rowProps?: HTMLAttributes<HTMLTableRowElement>
}

/**
 * The "no rows" state, as a row rather than as something rendered beside the
 * table. Keeping it inside `<tbody>` is what stops the message from being
 * orphaned when the table scrolls horizontally, and it keeps the table's own
 * row count honest.
 *
 * The fallback `colSpan` of 1000 is not a magic number: HTML clamps `colspan`
 * to 1000, and every engine then clamps it again to the number of columns that
 * actually exist, so it is the portable way to say "span everything" without
 * the component having to count columns it never sees. Pass `columnCount` on
 * `<Table>` when the exact value matters for a test or a print stylesheet.
 */
export const TableEmpty = forwardRef<HTMLTableCellElement, TableEmptyProps>(
  function TableEmpty({ colSpan, rowProps, className, ...rest }, ref) {
    const { stacked, columnCount } = useContext(TableContext)
    const { className: rowClassName, ...rowRest } = rowProps ?? {}
    return (
      <tr
        data-tl="table-empty-row"
        className={cx('tl-table__empty-row', rowClassName)}
        role={stacked ? 'row' : undefined}
        {...rowRest}
      >
        <td
          ref={ref}
          data-tl="table-empty"
          colSpan={colSpan ?? columnCount ?? 1000}
          className={cx('tl-table__empty', className)}
          role={stacked ? 'cell' : undefined}
          {...rest}
        />
      </tr>
    )
  },
)
