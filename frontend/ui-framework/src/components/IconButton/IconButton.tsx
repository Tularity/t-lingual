import { forwardRef, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { Button, type ButtonProps } from '../Button/Button'
import './IconButton.css'

export type IconButtonShape = 'square' | 'round'

export interface IconButtonProps
  extends Omit<ButtonProps, 'icon' | 'iconEnd' | 'iconOnly' | 'children' | 'aria-label'> {
  /** The glyph. Rendered decoratively — `label` carries the meaning. */
  icon: ReactNode
  /** The accessible name. Required, and that is the entire point of this component. */
  label: string
  shape?: IconButtonShape
}

/**
 * A Button that cannot ship without an accessible name.
 *
 * `<Button iconOnly>` already reports a missing name in development, but a
 * development-only console error is a reminder rather than a guarantee: it is
 * silent in the build that users get, and it is easy to scroll past. Making
 * `label` a required prop moves the same rule to the type checker, where it
 * fails the build instead of the audit. That, and nothing else, is why this
 * wrapper exists — every visual decision still belongs to Button.
 *
 * The label becomes `aria-label` rather than `title`. `title` is not an
 * equivalent: several screen readers skip it when no other naming is present,
 * it never appears for touch users, and its tooltip cannot be reached by
 * keyboard. A consumer who wants the hover tooltip as well can still pass
 * `title` through, and it will not affect the computed name.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shape = 'square', className, ...rest },
  ref,
) {
  return (
    <Button
      {...rest}
      ref={ref}
      icon={icon}
      iconOnly
      aria-label={label}
      data-shape={shape}
      className={cx('tl-icon-button', className)}
    />
  )
})
