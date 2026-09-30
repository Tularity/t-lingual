import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './Chart.css'

export interface BarListItem {
  id: string
  label: ReactNode
  value: number
  /** The value as read, where formatValue is not enough. */
  valueLabel?: ReactNode
  description?: ReactNode
  icon?: ReactNode
  color?: string
}

export interface BarListProps extends Omit<HTMLAttributes<HTMLUListElement>, 'children'> {
  /** Accessible name of the list. */
  label: string
  items: ReadonlyArray<BarListItem>
  /** Full length of a bar; defaults to the largest value. */
  max?: number
  formatValue?: (value: number) => string
  emptyLabel?: ReactNode
}

/**
 * A ranking: each item's name over a bar of its share of the largest, with
 * its value at the end. A list, not a picture — every value is text — so it
 * reads the same to a screen reader and at any width.
 */
export const BarList = forwardRef<HTMLUListElement, BarListProps>(function BarList(
  { label, items, max, formatValue = String, emptyLabel = 'Nothing yet', className, ...rest },
  ref,
) {
  const top = max ?? Math.max(0, ...items.map((item) => item.value))
  if (!items.length) return <p className="tl-bar-list__empty">{emptyLabel}</p>
  return (
    <ul ref={ref} data-tl="bar-list" className={cx('tl-bar-list', className)} aria-label={label} {...rest}>
      {items.map((item) => (
        <li key={item.id} style={{ '--_share': `${top > 0 ? Math.max(1.5, (Math.max(0, item.value) / top) * 100) : 0}%`, '--_bar': item.color ?? 'var(--tl-chart-1)' } as CSSProperties}>
          {item.icon != null ? <span className="tl-bar-list__icon">{item.icon}</span> : null}
          <span className="tl-bar-list__body">
            <span className="tl-bar-list__label"><span>{item.label}</span>{item.description != null ? <small>{item.description}</small> : null}</span>
            <span className="tl-bar-list__track" aria-hidden="true"><span /></span>
          </span>
          <b className="tl-bar-list__value">{item.valueLabel ?? formatValue(item.value)}</b>
        </li>
      ))}
    </ul>
  )
})
