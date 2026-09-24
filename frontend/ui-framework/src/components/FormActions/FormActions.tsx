import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './FormActions.css'

export type FormActionsAlign = 'start' | 'end' | 'between' | 'stretch'
export type FormActionsStack = 'auto' | 'never' | 'always'

export interface FormActionsProps extends HTMLAttributes<HTMLDivElement> {
  align?: FormActionsAlign
  /**
   * A secondary destructive action — "Delete draft", "Revoke access" — pushed
   * away from the main group.
   */
  destructive?: ReactNode
  /** Rule and breathing room above the row, for a form that ends on a card edge. */
  divided?: boolean
  /** Whether the row collapses into a stack on a narrow viewport. */
  stack?: FormActionsStack
}

/**
 * The row of buttons that ends a form.
 *
 * ORDER
 * -----
 * Children are authored in reading order — dismissive actions first, the
 * primary last — which is also the order a keyboard reaches them. On a narrow
 * viewport the row becomes `column-reverse`, so the primary action rises to the
 * top of the stack where a thumb reaches it first, and it does so entirely in
 * the cascade. Reordering the children in JS instead would move the primary
 * action in the tab sequence as the viewport crossed the breakpoint, and would
 * unmount and remount a focused button mid-interaction.
 *
 * The destructive slot is rendered first in the DOM and pushed away with an
 * auto margin rather than with `order`. `order` would put the visual sequence
 * out of step with the focus sequence, which is exactly the failure WCAG 2.4.3
 * describes; an auto margin moves the box without touching either sequence.
 *
 * The stacking breakpoint is a media query rather than a container query
 * because the row's own width is not the question — a wide form on a phone
 * still wants stacked, thumb-sized buttons.
 */
export const FormActions = forwardRef<HTMLDivElement, FormActionsProps>(function FormActions(
  {
    align = 'end',
    destructive,
    divided = false,
    stack = 'auto',
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <div
      {...rest}
      ref={ref}
      data-tl="form-actions"
      data-align={align}
      data-stack={stack}
      data-divided={divided || undefined}
      className={cx('tl-form-actions', className)}
    >
      {destructive != null && (
        <div className="tl-form-actions__destructive">{destructive}</div>
      )}
      {children}
    </div>
  )
})
