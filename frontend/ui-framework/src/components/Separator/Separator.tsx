import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './Separator.css'

export type SeparatorOrientation = 'horizontal' | 'vertical'

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: SeparatorOrientation
  /**
   * Drops the element out of the accessibility tree entirely. Correct whenever
   * the rule is decoration between things that are already visibly grouped.
   */
  decorative?: boolean
  /** Text set into the rule, e.g. "or" between two sign-in options. */
  label?: ReactNode
}

/**
 * A rule between groups of content.
 *
 * `decorative` is not a styling switch, it is the honest answer to "does this
 * line mean anything?". A rule that merely tidies a card up is noise in a
 * screen reader's element list, so it gets `role="none"`; a rule that marks a
 * genuine boundary between sections stays a `separator` so that boundary is
 * announced.
 *
 * The labelled form needs an explanation, because it looks like the label
 * should simply be readable and it is not. ARIA gives `separator` presentational
 * children, so text rendered inside one is stripped from the accessibility tree
 * and a "Danger zone" divider announces as an unnamed separator. The label is
 * therefore wired back in through `aria-labelledby`, which computes the name
 * from the referenced subtree regardless of that rule. That wiring is also why
 * a decorative separator never receives `aria-labelledby`: it is a global ARIA
 * attribute, and a global ARIA attribute on `role="none"` triggers
 * presentational role conflict resolution — the browser discards the `none` and
 * the element is exposed after all, which is precisely what `decorative` asked
 * it not to do.
 *
 * The rules themselves are drawn with `border`, never `background-color`. Under
 * `forced-colors: active` backgrounds are stripped and a background-drawn
 * divider disappears; a border survives and keeps the boundary visible.
 */
export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(function Separator(
  { orientation = 'horizontal', decorative = false, label, className, ...rest },
  ref,
) {
  const labelId = useId()
  const hasLabel = label != null && label !== false && label !== ''

  return (
    <div
      ref={ref}
      data-tl="separator"
      data-orientation={orientation}
      data-labelled={hasLabel || undefined}
      className={cx('tl-separator', className)}
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      aria-labelledby={!decorative && hasLabel ? labelId : undefined}
      {...rest}
    >
      {hasLabel && (
        <span className="tl-separator__label" id={labelId}>
          {label}
        </span>
      )}
    </div>
  )
})
