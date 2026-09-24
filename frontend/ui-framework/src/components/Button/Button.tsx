import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { Slot, Slottable } from '../../primitives/Slot'
import { Spinner } from '../Spinner/Spinner'
import './Button.css'

export type ButtonVariant =
  | 'primary'
  | 'default'
  | 'subtle'
  | 'ghost'
  | 'danger'
  | 'danger-subtle'
  | 'link'

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'prefix'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading adornment. Decorative — the label carries the meaning. */
  icon?: ReactNode
  /** Trailing adornment: a chevron, a count, an external-link marker. */
  iconEnd?: ReactNode
  /**
   * Replaces `icon` with a spinner and swallows activation. See the note below
   * on why this does not set `disabled`.
   */
  loading?: boolean
  /** Announced while `loading`. */
  loadingLabel?: string
  fullWidth?: boolean
  /** Square proportions for a lone icon. Makes an accessible name mandatory. */
  iconOnly?: boolean
  /** Render onto the child element — for a router <Link> that must look like a button. */
  asChild?: boolean
}

/**
 * The framework's primary action control.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - `loading` intentionally does NOT set `disabled`. A disabled element leaves
 *   the tab order, so a keyboard user who activates a button and has focus
 *   destroyed under them is silently returned to the top of the document. The
 *   button instead stays focusable, reports `aria-disabled` and `aria-busy`,
 *   and refuses activation in the handler.
 *
 * - `iconOnly` reports an error in development when there is no accessible
 *   name. An unlabelled icon button is the most common serious violation in
 *   operator tooling, and `title` is not a fix: several screen readers ignore
 *   it when no other naming is present, and it never surfaces for touch users.
 *
 * - Every size holds a 24x24 minimum pointer target (WCAG 2.2 SC 2.5.8). The
 *   two smallest sizes are visually below that and grow the target with a
 *   transparent pseudo-element rather than by getting bigger.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    icon,
    iconEnd,
    loading = false,
    loadingLabel,
    fullWidth = false,
    iconOnly = false,
    asChild = false,
    disabled = false,
    className,
    children,
    onClick,
    type = 'button',
    ...rest
  },
  ref,
) {
  if (
    import.meta.env?.DEV &&
    iconOnly &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <Button iconOnly> needs `aria-label` or `aria-labelledby`. ' +
        'A `title` attribute is not a reliable substitute.',
    )
  }

  const inert = disabled || loading
  const Component = asChild ? Slot : 'button'

  return (
    <Component
      {...rest}
      ref={ref}
      // A Slot target may be an <a>, which has no `type`.
      {...(asChild ? {} : { type, disabled })}
      data-tl="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-slotted={asChild || undefined}
      data-icon-only={iconOnly || undefined}
      data-full-width={fullWidth || undefined}
      className={cx('tl-button', className)}
      aria-disabled={loading || (asChild && disabled) || undefined}
      aria-busy={loading || undefined}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        if (inert) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
    >
      {loading ? (
        <Spinner
          size={size === 'lg' ? 'md' : 'sm'}
          className="tl-button__spinner"
          label={loadingLabel}
        />
      ) : (
        icon && (
          <span className="tl-button__icon" aria-hidden="true">
            {icon}
          </span>
        )
      )}

      {/* Under `asChild` the label must be the consumer's own element, so it is
        * marked Slottable and the icon spans around it end up inside it. Passing
        * these three nodes to Slot unwrapped would give it three children to
        * merge onto and it would render nothing at all. */}
      {asChild ? (
        <Slottable>{children}</Slottable>
      ) : (
        children != null &&
        children !== false && <span className="tl-button__label">{children}</span>
      )}

      {iconEnd && !loading && (
        <span className="tl-button__icon" aria-hidden="true">
          {iconEnd}
        </span>
      )}
    </Component>
  )
})
