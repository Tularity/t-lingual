import {
  createContext,
  forwardRef,
  useContext,
  type HTMLAttributes,
} from 'react'
import { cx } from '../../utils/cx'
import './DescriptionList.css'

export type DescriptionListLayout = 'stacked' | 'inline' | 'grid'

const DescriptionListContext = createContext<DescriptionListLayout>('stacked')

export interface DescriptionListProps extends HTMLAttributes<HTMLDListElement> {
  /**
   * `stacked` puts the value under the label, `inline` runs them on one line,
   * `grid` aligns every label in a single column across all rows.
   */
  layout?: DescriptionListLayout
  /** Hairline between rows. Reads better in a long settings panel. */
  divided?: boolean
}

/**
 * The key/value panel.
 *
 * This exists to delete the ad-hoc "setting-row" divs the app grew: a label and
 * a value are a description list, and saying so gets the pairing for free in
 * the accessibility tree instead of leaving two unrelated spans next to each
 * other. Screen readers announce a `<dd>` as the description of the `<dt>`
 * before it; two divs announce as two divs.
 *
 * `grid` is the layout worth understanding. The alignment has to happen across
 * rows, so the grid lives on the `<dl>` and each `<DescriptionListItem>` is
 * `display: contents` — the wrapper's box disappears and its `<dt>`/`<dd>`
 * become direct grid items of the list. That is safe here specifically because
 * the wrapper is a plain `<div>` with no semantics of its own to lose, which is
 * also why HTML allows a `<div>` between `<dl>` and its pairs at all.
 */
export const DescriptionList = forwardRef<HTMLDListElement, DescriptionListProps>(
  function DescriptionList({ layout = 'stacked', divided = false, className, ...rest }, ref) {
    return (
      <DescriptionListContext.Provider value={layout}>
        <dl
          ref={ref}
          data-tl="description-list"
          data-layout={layout}
          data-divided={divided || undefined}
          className={cx('tl-dl', className)}
          {...rest}
        />
      </DescriptionListContext.Provider>
    )
  },
)

export type DescriptionListItemProps = HTMLAttributes<HTMLDivElement>

export const DescriptionListItem = forwardRef<HTMLDivElement, DescriptionListItemProps>(
  function DescriptionListItem({ className, ...rest }, ref) {
    const layout = useContext(DescriptionListContext)
    return (
      <div
        ref={ref}
        data-tl="description-list-item"
        data-layout={layout}
        className={cx('tl-dl__item', className)}
        {...rest}
      />
    )
  },
)

export type DescriptionTermProps = HTMLAttributes<HTMLElement>

export const DescriptionTerm = forwardRef<HTMLElement, DescriptionTermProps>(
  function DescriptionTerm({ className, ...rest }, ref) {
    return (
      <dt
        ref={ref}
        data-tl="description-term"
        className={cx('tl-dl__term', className)}
        {...rest}
      />
    )
  },
)

export type DescriptionDetailsProps = HTMLAttributes<HTMLElement>

export const DescriptionDetails = forwardRef<HTMLElement, DescriptionDetailsProps>(
  function DescriptionDetails({ className, ...rest }, ref) {
    return (
      <dd
        ref={ref}
        data-tl="description-details"
        className={cx('tl-dl__details', className)}
        {...rest}
      />
    )
  },
)
