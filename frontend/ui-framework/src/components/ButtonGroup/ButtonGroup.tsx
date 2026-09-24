import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import './ButtonGroup.css'

export type ButtonGroupOrientation = 'horizontal' | 'vertical'

export interface ButtonGroupProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ButtonGroupOrientation
  /**
   * Joins the buttons into one visual control. Turn it off to keep the grouping
   * semantics and the layout while spacing the buttons normally.
   */
  attached?: boolean
}

/**
 * A set of related buttons presented as one control.
 *
 * The joining is done entirely in CSS with `:first-child` / `:last-child`, and
 * that is the design decision worth defending. The obvious alternative is to
 * walk `children` and clone position props onto each one, but that breaks the
 * first time a consumer wraps a button in a Tooltip, renders one from a `.map`,
 * or hides the middle button behind a permission check — the clone sees a
 * wrapper element or a `false`, not a Button. Positional selectors are
 * evaluated by the engine against the DOM that actually exists, so a
 * conditionally rendered middle button simply disappears and the two survivors
 * become first and last on their own.
 *
 * The cost of that choice is that the rules reach exactly one level: a button
 * wrapped in another element gets the treatment on the wrapper, not on itself.
 *
 * `role="group"` rather than `role="toolbar"`, because a toolbar owes the user
 * arrow-key navigation and a roving tabindex, and a plain visual grouping does
 * not implement either. A consumer building a real toolbar can pass the role
 * explicitly, and is then responsible for the keyboard contract that comes with
 * it.
 */
export const ButtonGroup = forwardRef<HTMLDivElement, ButtonGroupProps>(function ButtonGroup(
  { orientation = 'horizontal', attached = true, role = 'group', className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role={role}
      data-tl="button-group"
      data-orientation={orientation}
      data-attached={attached || undefined}
      className={cx('tl-button-group', className)}
      {...rest}
    />
  )
})
