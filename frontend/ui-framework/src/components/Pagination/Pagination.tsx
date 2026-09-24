import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import { Button, type ButtonSize } from '../Button/Button'
import { paginationRange } from './paginationRange'
import './Pagination.css'

export interface PaginationProps
  extends Omit<HTMLAttributes<HTMLElement>, 'onChange'> {
  /** Total number of pages, not the number of records. */
  count: number
  page?: number
  defaultPage?: number
  onPageChange?: (page: number) => void
  /** Page numbers kept either side of the current one. */
  siblings?: number
  size?: Extract<ButtonSize, 'sm' | 'md' | 'lg'>
  disabled?: boolean
  /** Name of the navigation landmark. */
  label?: string
  previousLabel?: string
  nextLabel?: string
  /** Accessible name for a page button. Receives the page number. */
  pageLabel?: (page: number) => string
  previousIcon?: ReactNode
  nextIcon?: ReactNode
}

const ChevronStart = (
  <svg
    className="tl-pagination__chevron"
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m14 7-5 5 5 5" />
  </svg>
)

const ChevronEnd = (
  <svg
    className="tl-pagination__chevron"
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m10 7 5 5-5 5" />
  </svg>
)

/**
 * Page navigation.
 *
 * STRUCTURE
 * ---------
 * A `<nav>` around a list around buttons, which is more markup than it looks
 * like it needs and each layer earns its place. The landmark is what lets a
 * screen reader user jump to the pager instead of arrowing to the bottom of a
 * hundred-row table; the list is what makes "8 items" available before they
 * commit to walking it; and the buttons are buttons because these change state
 * on the current page rather than navigating to a document — an `<a>` here
 * promises a URL that the component has no way to produce.
 *
 * `aria-current="page"` rather than `aria-selected` or a disabled current
 * button: it names the one item in a set of links or buttons that represents
 * where the user already is, which is exactly the claim being made. Leaving the
 * current page enabled also keeps its width and its focusability stable while
 * the user pages, so tabbing does not jump around under them.
 *
 * The previous and next buttons DO use the real `disabled` attribute at the
 * ends of the range, unlike a loading Button elsewhere in the framework. The
 * distinction is whether anything is coming: a loading button will become
 * activatable again and must not throw focus away in the meantime, while page
 * one's "previous" is inert until the user does something else entirely, and
 * an `aria-disabled` button that swallows its own clicks is a worse experience
 * than one honestly removed from the tab order.
 */
export const Pagination = forwardRef<HTMLElement, PaginationProps>(function Pagination(
  {
    count,
    page,
    defaultPage = 1,
    onPageChange,
    siblings = 1,
    size = 'sm',
    disabled = false,
    label = 'Pagination',
    previousLabel = 'Previous page',
    nextLabel = 'Next page',
    pageLabel = (value) => `Page ${value}`,
    previousIcon,
    nextIcon,
    className,
    ...rest
  },
  ref,
) {
  const [current, setCurrent] = useControllableState<number>({
    value: page,
    defaultValue: defaultPage,
    onChange: onPageChange,
  })

  const clamped = Math.min(Math.max(current, 1), Math.max(count, 1))
  const items = paginationRange(clamped, count, siblings)

  const goTo = (next: number) => {
    const target = Math.min(Math.max(next, 1), Math.max(count, 1))
    if (target !== clamped) setCurrent(target)
  }

  return (
    <nav
      ref={ref}
      data-tl="pagination"
      data-size={size}
      className={cx('tl-pagination', className)}
      aria-label={label}
      {...rest}
    >
      <ul className="tl-pagination__list">
        <li className="tl-pagination__item">
          <Button
            variant="ghost"
            size={size}
            iconOnly
            icon={previousIcon ?? ChevronStart}
            aria-label={previousLabel}
            disabled={disabled || clamped <= 1}
            onClick={() => goTo(clamped - 1)}
          />
        </li>

        {items.map((item, index) =>
          item === 'ellipsis' ? (
            // Hidden rather than labelled "more pages": it is not actionable,
            // and announcing a gap between two numbers adds noise to a list
            // whose whole purpose is to be counted quickly.
            <li
              // The gaps have no identity of their own to key on, and they
              // never reorder relative to the numbers around them.
              key={`ellipsis-${index}`}
              className="tl-pagination__ellipsis"
              aria-hidden="true"
            >
              &hellip;
            </li>
          ) : (
            <li key={item} className="tl-pagination__item">
              <Button
                className="tl-pagination__page"
                variant={item === clamped ? 'primary' : 'ghost'}
                size={size}
                aria-label={pageLabel(item)}
                aria-current={item === clamped ? 'page' : undefined}
                disabled={disabled}
                onClick={() => goTo(item)}
              >
                {item}
              </Button>
            </li>
          ),
        )}

        <li className="tl-pagination__item">
          <Button
            variant="ghost"
            size={size}
            iconOnly
            icon={nextIcon ?? ChevronEnd}
            aria-label={nextLabel}
            disabled={disabled || clamped >= count}
            onClick={() => goTo(clamped + 1)}
          />
        </li>
      </ul>
    </nav>
  )
})
