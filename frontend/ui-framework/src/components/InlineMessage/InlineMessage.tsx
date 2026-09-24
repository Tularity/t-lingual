import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { Icon, type IconName } from '../../icons/Icon'
import './InlineMessage.css'

export type InlineMessageVariant = 'info' | 'success' | 'warning' | 'danger'

export type InlineMessageSize = 'sm' | 'md'

export interface InlineMessageProps extends HTMLAttributes<HTMLDivElement> {
  variant?: InlineMessageVariant
  size?: InlineMessageSize
  /**
   * Overrides the status glyph. Pass `null` to remove it — `undefined` means
   * "use the variant default", so the two are not interchangeable.
   */
  icon?: ReactNode
}

const DEFAULT_ICONS: Record<InlineMessageVariant, IconName> = {
  info: 'info',
  success: 'checkCircle',
  warning: 'warning',
  danger: 'alert',
}

/**
 * Banner's compact sibling: field-level validation copy, a note inside a card,
 * the one-line explanation under a toggle.
 *
 * Deliberately not a Banner with smaller padding. A banner is a strip that owns
 * its horizontal band and announces itself; this is a run of text that happens
 * to be prefixed with a glyph, so it has no fill, no border, no title slot and
 * no dismiss. Anything that needs those is a Banner.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - No live-region role by default, which is the opposite of Banner. The
 *   overwhelmingly common placement is under a form control that already points
 *   at this element with `aria-describedby`; adding `role="alert"` there means
 *   the text is spoken twice, once as an interruption and once as the field's
 *   description, and the second reading is the one the user actually needed.
 *   When the message appears on its own — a save that failed, a row-level
 *   result — pass `role="alert"` explicitly and it is honoured.
 *
 * - The status colour is applied to the text, not just the glyph, because at
 *   this size there is no tinted surface to carry the state. Every `-fg` token
 *   used here is placed to clear 4.5:1 on the page and card surfaces; the glyph
 *   is what keeps the meaning available when colour is not perceived.
 */
export const InlineMessage = forwardRef<HTMLDivElement, InlineMessageProps>(
  function InlineMessage(
    { variant = 'info', size = 'sm', icon, className, children, ...rest },
    ref,
  ) {
    const resolvedIcon = icon === undefined ? <Icon name={DEFAULT_ICONS[variant]} /> : icon

    return (
      <div
        {...rest}
        ref={ref}
        data-tl="inline-message"
        data-variant={variant}
        data-size={size}
        className={cx('tl-inline-message', className)}
      >
        {resolvedIcon != null && (
          <span className="tl-inline-message__icon" aria-hidden="true">
            {resolvedIcon}
          </span>
        )}
        <span className="tl-inline-message__content">{children}</span>
      </div>
    )
  },
)
