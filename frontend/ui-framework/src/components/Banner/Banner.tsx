import { forwardRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { Icon, type IconName } from '../../icons/Icon'
import { useControllableState } from '../../hooks/useControllableState'
import './Banner.css'

export type BannerVariant = 'info' | 'success' | 'warning' | 'danger'

export type BannerEmphasis = 'subtle' | 'solid'

export interface BannerStorage {
  /** Storage key. Namespace it — the whole origin shares this keyspace. */
  key: string
  scope: 'session' | 'local'
}

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: BannerVariant
  /** `subtle` tints the surface; `solid` fills it with the status colour. */
  emphasis?: BannerEmphasis
  /** Short lead-in above the body copy. */
  title?: ReactNode
  /**
   * Overrides the status glyph. Pass `null` to remove it entirely — `undefined`
   * means "use the default for this variant", so the two are not interchangeable.
   */
  icon?: ReactNode
  /** Buttons or links. Rendered inline at the end of the strip. */
  actions?: ReactNode
  dismissible?: boolean
  onDismiss?: () => void
  /** Accessible name for the dismiss control. */
  dismissLabel?: string
  /** Remembers the dismissal so the banner does not come back on next visit. */
  storage?: BannerStorage
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

const DEFAULT_ICONS: Record<BannerVariant, IconName> = {
  info: 'info',
  success: 'checkCircle',
  warning: 'warning',
  danger: 'alert',
}

/**
 * Every one of these touches the Storage object inside the try, not just the
 * read or the write. Safari in private browsing throws on `setItem`, and a
 * sandboxed iframe or a "block all cookies" profile throws on the
 * `window.localStorage` property access itself — so pulling the reference out
 * of the block would move the failure somewhere nothing catches it. The same
 * guard covers server rendering, where `window` is not defined at all.
 */
function readDismissed(storage: BannerStorage | undefined): boolean {
  if (!storage) return false
  try {
    const area = storage.scope === 'local' ? window.localStorage : window.sessionStorage
    return area.getItem(storage.key) === '1'
  } catch {
    return false
  }
}

function writeDismissed(storage: BannerStorage | undefined): void {
  if (!storage) return
  try {
    const area = storage.scope === 'local' ? window.localStorage : window.sessionStorage
    area.setItem(storage.key, '1')
  } catch {
    // A banner that cannot remember its dismissal is a far smaller problem than
    // a banner that throws during an event handler and takes the tree with it.
  }
}

/**
 * A page-level message strip: maintenance windows, degraded ASR, a session that
 * ended while the operator was away.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - The role is chosen by variant, and the split is deliberate. `alert` is an
 *   assertive live region: it interrupts whatever the screen reader is currently
 *   saying, which is right for a warning or a failure the user must act on and
 *   actively hostile for an informational notice — being cut off mid-sentence to
 *   be told the changelog is available is how users learn to disable a product's
 *   announcements entirely. So info and success announce politely through
 *   `status` and wait their turn; warning and danger interrupt. A consumer that
 *   knows better can pass `role` explicitly and it wins.
 *
 * - Because the role is what makes this announce, a banner that mounts as part
 *   of the initial document may not be announced at all: a live region only
 *   fires for content inserted after it exists. That is correct behaviour — the
 *   user is about to read the page anyway — and it is the reason a banner
 *   raised in response to an event should be mounted, not merely unhidden.
 *
 * - The dismiss control is 24x24 regardless of the banner's density, which is
 *   the WCAG 2.2 SC 2.5.8 minimum target size. It is also the only interactive
 *   element the component owns; `actions` are the consumer's own buttons.
 */
export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
  {
    variant = 'info',
    emphasis = 'subtle',
    title,
    icon,
    actions,
    dismissible = false,
    onDismiss,
    dismissLabel = 'Dismiss',
    storage,
    open: openProp,
    defaultOpen = true,
    onOpenChange,
    role,
    className,
    children,
    ...rest
  },
  ref,
) {
  // Read persisted state exactly once. Threading it through `useState`'s lazy
  // initialiser rather than calling it inline keeps a synchronous, potentially
  // throwing storage hit off every single render.
  const [initialOpen] = useState(() => defaultOpen && !readDismissed(storage))

  const [open, setOpen] = useControllableState({
    value: openProp,
    defaultValue: initialOpen,
    onChange: onOpenChange,
  })

  if (!open) return null

  const resolvedRole = role ?? (variant === 'warning' || variant === 'danger' ? 'alert' : 'status')
  const resolvedIcon = icon === undefined ? <Icon name={DEFAULT_ICONS[variant]} /> : icon

  return (
    <div
      {...rest}
      ref={ref}
      role={resolvedRole}
      data-tl="banner"
      data-variant={variant}
      data-emphasis={emphasis}
      className={cx('tl-banner', className)}
    >
      {resolvedIcon != null && (
        <span className="tl-banner__icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      )}

      <div className="tl-banner__body">
        {title != null && <p className="tl-banner__title">{title}</p>}
        {children != null && children !== false && (
          <div className="tl-banner__content">{children}</div>
        )}
      </div>

      {actions != null && <div className="tl-banner__actions">{actions}</div>}

      {dismissible && (
        <button
          type="button"
          className="tl-banner__dismiss"
          aria-label={dismissLabel}
          onClick={() => {
            // Persist even when the open state is controlled: the consumer owns
            // whether the banner is showing, but the user's "I have read this"
            // is a fact about the user, not about this render.
            writeDismissed(storage)
            setOpen(false)
            onDismiss?.()
          }}
        >
          <Icon name="close" />
        </button>
      )}
    </div>
  )
})
