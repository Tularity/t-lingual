import { forwardRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './Chart.css'

export interface HeatmapProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string
  rows: ReadonlyArray<string>
  columns: ReadonlyArray<string>
  /** values[row][column]. */
  values: ReadonlyArray<ReadonlyArray<number>>
  formatValue?: (value: number) => string
  /** Show every nth column label. */
  columnLabelEvery?: number
  /** Any CSS colour for the most intense cell. */
  color?: string
  /** Said while nothing is hovered, under the grid. */
  caption?: ReactNode
}

/**
 * Intensity over two dimensions — the hours of a week, say. Each cell's
 * shade is a share of the busiest; its value is read out under the grid
 * when it is hovered or focused, since a shade alone is no number.
 */
export const Heatmap = forwardRef<HTMLDivElement, HeatmapProps>(function Heatmap(
  { label, rows, columns, values, formatValue = String, columnLabelEvery = 3, color = 'var(--tl-chart-1)', caption, className, style, ...rest },
  ref,
) {
  const [active, setActive] = useState<[number, number] | null>(null)
  const peak = Math.max(0, ...values.flat())
  const reading = active ? `${rows[active[0]]} ${columns[active[1]]} · ${formatValue(values[active[0]]?.[active[1]] ?? 0)}` : caption
  return (
    <div ref={ref} data-tl="heatmap" className={cx('tl-heatmap', className)} role="figure" aria-label={label}
      style={{ ...style, '--_heat': color, '--_columns': columns.length } as CSSProperties} {...rest}>
      <div className="tl-heatmap__grid" onPointerLeave={() => setActive(null)}>
        <span />
        {columns.map((column, index) => <span key={column} className="tl-heatmap__column">{index % columnLabelEvery === 0 ? column : ''}</span>)}
        {rows.map((row, rowIndex) => [
          <span key={`label-${row}`} className="tl-heatmap__row">{row}</span>,
          ...columns.map((column, columnIndex) => {
            const value = values[rowIndex]?.[columnIndex] ?? 0
            const share = peak ? value / peak : 0
            return (
              <span key={`${row}-${column}`} className="tl-heatmap__cell" tabIndex={-1} aria-label={`${row} ${column}: ${formatValue(value)}`}
                data-active={active?.[0] === rowIndex && active?.[1] === columnIndex || undefined}
                style={{ '--_share': share > 0 ? `${Math.round(8 + share * 92)}%` : '0%' } as CSSProperties}
                onPointerEnter={() => setActive([rowIndex, columnIndex])} onFocus={() => setActive([rowIndex, columnIndex])} />
            )
          }),
        ])}
      </div>
      <p className="tl-heatmap__reading" aria-live="polite">{reading}</p>
    </div>
  )
})
