import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { Button } from '../Button/Button'
import './ErrorState.css'

export type ErrorStateSize = 'sm' | 'md' | 'lg'

export type ErrorStateHeadingLevel = 2 | 3 | 4 | 5 | 6

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Overrides the default warning glyph. `null` removes it. */
  icon?: ReactNode
  title: ReactNode
  /** What went wrong, in the user's terms. */
  description?: ReactNode
  /**
   * Diagnostics: a request id, a status code, a stack. Collapsed by default and
   * selectable when opened — see the note below.
   */
  detail?: ReactNode
  /** Label on the disclosure that reveals `detail`. */
  detailLabel?: string
  /** Renders the retry button. Omit it and no retry is offered. */
  onRetry?: () => void
  retryLabel?: string
  /** "Go back", "Contact support", "Reload the page". */
  secondaryAction?: ReactNode
  headingLevel?: ErrorStateHeadingLevel
  size?: ErrorStateSize
}

/**
 * The failure counterpart to EmptyState: a request that did not come back, a
 * session that could not be joined, a transcript that failed to load.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - `role="alert"` by default. An error state almost always replaces content
 *   that was already on screen, and a sighted user sees that swap instantly
 *   while a screen reader user gets no signal at all unless the replacement
 *   announces itself. The prop is a plain `role`, so a full-page error route —
 *   where the failure is present at first paint and there is nothing to
 *   interrupt — can pass `role={undefined}` and opt out.
 *
 * - The technical detail is real, selectable text inside a `<details>`, not a
 *   tooltip and not a copy-to-clipboard-only affordance. Someone filing a bug
 *   report needs to get the request id into an email, and a clipboard button
 *   alone fails anyone whose assistive technology or browser blocks the
 *   clipboard API. `user-select: text` is set explicitly because an ancestor
 *   that disabled selection for a drag surface would otherwise silently take
 *   this away.
 *
 * - Retry is a prop rather than a generic action slot. It is the one affordance
 *   every error surface in the product should offer, and making it a slot means
 *   every screen invents its own label for the same idea.
 */
export const ErrorState = forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  {
    icon,
    title,
    description,
    detail,
    detailLabel = 'Technical details',
    onRetry,
    retryLabel = 'Try again',
    secondaryAction,
    headingLevel,
    size = 'md',
    role = 'alert',
    className,
    children,
    ...rest
  },
  ref,
) {
  const Title = headingLevel ? (`h${headingLevel}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6') : 'p'
  const resolvedIcon = icon === undefined ? <Icon name="warning" /> : icon

  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      data-tl="error-state"
      data-size={size}
      className={cx('tl-error-state', className)}
    >
      {resolvedIcon != null && (
        <span className="tl-error-state__icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      )}

      <Title className="tl-error-state__title">{title}</Title>

      {description != null && <p className="tl-error-state__description">{description}</p>}

      {children}

      {(onRetry || secondaryAction != null) && (
        <div className="tl-error-state__actions">
          {onRetry && (
            <Button variant="primary" size={size === 'sm' ? 'sm' : 'md'} onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {secondaryAction}
        </div>
      )}

      {detail != null && (
        <details className="tl-error-state__detail">
          <summary className="tl-error-state__summary">
            <span className="tl-error-state__caret" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
            {detailLabel}
          </summary>
          {/* <pre> rather than a <div>: the content is almost always a stack or
            * an id where whitespace is meaningful, and a monospace block is
            * also the strongest visual signal that this text is for pasting
            * rather than for reading. */}
          <pre className="tl-error-state__detail-body">{detail}</pre>
        </details>
      )}
    </div>
  )
})
