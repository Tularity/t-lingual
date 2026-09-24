import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../utils/cx'

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLSpanElement> {
  /** Renders onto the child element instead of a <span>. */
  asChild?: boolean
}

/**
 * Content available to assistive technology but not painted.
 *
 * Not `display: none` and not `visibility: hidden` — both remove the element
 * from the accessibility tree, which is the opposite of the intent. The
 * implementation lives in the base stylesheet as `.tl-visually-hidden` so this
 * component and any consumer that needs the utility share one definition.
 *
 * The `:not(:focus)` guard in that rule is what makes a skip link work: it is
 * invisible until focused, then reveals itself.
 */
export const VisuallyHidden = forwardRef<HTMLSpanElement, VisuallyHiddenProps>(
  function VisuallyHidden({ className, ...rest }, ref) {
    return <span ref={ref} className={cx('tl-visually-hidden', className)} {...rest} />
  },
)
