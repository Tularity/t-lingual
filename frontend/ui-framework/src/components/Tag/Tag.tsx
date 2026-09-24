import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import './Tag.css'

export type TagVariant =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'danger'
  | 'warning'
  | 'info'

export type TagSize = 'sm' | 'md'

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: TagVariant
  size?: TagSize
  /** Leading glyph. Decorative — the text is what is read. */
  icon?: ReactNode
  /** Adds the remove control. Omit and the tag is a static chip. */
  onRemove?: () => void
  /**
   * Plain-text form of the tag, used to name the remove button. Only needed
   * when `children` is not a string.
   */
  value?: string
  /**
   * Full accessible name for the remove button, for translation. Overrides the
   * generated "Remove {value}".
   */
  removeLabel?: string
  disabled?: boolean
}

/**
 * A user-facing chip: a selected language, a filter, a participant.
 *
 * Badge and Tag look similar and are not the same thing. A Badge reports state
 * the system decided; a Tag represents something the user put there and can
 * usually take away again. That difference is the whole reason this component
 * exists separately, and it is why only this one has a remove control.
 *
 * THE REMOVE BUTTON'S NAME
 * ------------------------
 * A list of eight chips each with a button called "Remove" produces eight
 * identical entries in a screen reader's button list, and choosing between them
 * means walking the whole list to rebuild the context that was thrown away. So
 * the name always includes the tag's own text: "Remove Spanish". The text is
 * taken from `children` when it is a string and from `value` otherwise, and in
 * development a tag that offers removal without either is reported rather than
 * silently shipping the useless name.
 */
export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  {
    variant = 'neutral',
    size = 'md',
    icon,
    onRemove,
    value,
    removeLabel,
    disabled = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  // A string child is the overwhelmingly common case and reading it here saves
  // every consumer from repeating the label as a prop.
  const text = value ?? (typeof children === 'string' ? children : undefined)

  if (import.meta.env?.DEV && onRemove && !removeLabel && !text) {
    console.error(
      '[t-lingual/ui] <Tag onRemove> could not derive its remove button name. ' +
        'Pass `value` with the tag text (or `removeLabel` with the full name) ' +
        'whenever `children` is not a plain string.',
    )
  }

  const accessibleRemoveLabel =
    removeLabel ?? (text ? `Remove ${text}` : 'Remove')

  return (
    <span
      ref={ref}
      data-tl="tag"
      data-variant={variant}
      data-size={size}
      data-removable={onRemove ? '' : undefined}
      data-disabled={disabled || undefined}
      className={cx('tl-tag', className)}
      {...rest}
    >
      {icon && (
        <span className="tl-tag__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="tl-tag__label">{children}</span>
      {onRemove && (
        <button
          type="button"
          className="tl-tag__remove"
          data-tl="tag-remove"
          aria-label={accessibleRemoveLabel}
          disabled={disabled}
          onClick={onRemove}
        >
          {/* Drawn rather than typed: the multiplication sign and the letter x
            * both render at the wrong optical weight next to 11px type, and a
            * text glyph would be read out by any AT that ignores the label. */}
          <svg
            className="tl-tag__remove-glyph"
            viewBox="0 0 10 10"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" />
          </svg>
        </button>
      )}
    </span>
  )
})
