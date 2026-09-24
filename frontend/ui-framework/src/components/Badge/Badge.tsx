import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './Badge.css'

export type BadgeVariant =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'danger'
  | 'warning'
  | 'info'

export type BadgeEmphasis = 'subtle' | 'outline' | 'solid'

export type BadgeSize = 'sm' | 'md'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  /** `subtle` is a tint, `outline` is a hairline on the page, `solid` is filled. */
  emphasis?: BadgeEmphasis
  size?: BadgeSize
  /** Decorative leading dot. See the note on why it carries no meaning. */
  dot?: boolean
  /** Leading glyph. Decorative — the text is what is read. */
  icon?: ReactNode
}

/**
 * A status pill: "Live", "Ended", "Needs review".
 *
 * THE TEXT IS THE SIGNAL
 * ----------------------
 * Every variant here is a colour, and colour is never allowed to be the only
 * carrier of meaning (WCAG 1.4.1). So the badge has no icon-only or dot-only
 * mode: its children are required and they are what says what the state is.
 * The dot exists to make a row of badges scannable at a glance for people who
 * do see the hue, which is why it is `aria-hidden` and why removing it costs
 * nothing but speed.
 *
 * The badge is a `<span>` with no role. A status pill that changes as a session
 * progresses should not announce itself from inside the badge — the live region
 * belongs around whatever owns the state, not around one of possibly twenty
 * pills in a table, each of which would otherwise shout on every poll.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  {
    variant = 'neutral',
    emphasis = 'subtle',
    size = 'md',
    dot = false,
    icon,
    className,
    children,
    ...rest
  },
  ref,
) {
  if (
    import.meta.env?.DEV &&
    children == null &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <Badge> needs children, or `aria-label` when the text is ' +
        'somewhere else. The dot and the icon are both `aria-hidden`, so a badge ' +
        'with neither leaves the state carried by hue alone.',
    )
  }

  return (
    <span
      ref={ref}
      data-tl="badge"
      data-variant={variant}
      data-emphasis={emphasis}
      data-size={size}
      className={cx('tl-badge', className)}
      {...rest}
    >
      {dot && <span className="tl-badge__dot" aria-hidden="true" />}
      {icon && (
        <span className="tl-badge__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="tl-badge__label">{children}</span>
    </span>
  )
})
