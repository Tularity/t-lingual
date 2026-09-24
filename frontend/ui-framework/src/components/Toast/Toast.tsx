import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from 'react'
import { useEventCallback } from '../../hooks/useEventCallback'
import { Icon, type IconName } from '../../icons/Icon'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import { usePresence } from '../_shared/usePresence'
import './Toast.css'

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger'

export type ToastPlacement =
  | 'top-start'
  | 'top-center'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-center'
  | 'bottom-end'

export interface ToastAction {
  label: string
  onAction: () => void
}

export interface ToastOptions {
  title?: ReactNode
  description?: ReactNode
  variant?: ToastVariant
  /** Milliseconds before auto-dismiss. `0` pins the toast until dismissed. */
  duration?: number
  action?: ToastAction
  /** Overrides the status glyph. `null` removes it; `undefined` uses the default. */
  icon?: ReactNode
  /** Verb used in the dismiss button's accessible name. */
  dismissLabel?: string
}

export interface ToastRecord extends ToastOptions {
  id: string
  variant: ToastVariant
  duration: number
  /**
   * Bumped by `update()`. The auto-dismiss timer restarts whenever this
   * changes, because a toast whose text was just replaced has to be readable
   * for a full duration rather than for whatever was left of the old one.
   */
  revision: number
}

/**
 * What the provider actually keeps in its queue. The open flag is deliberately
 * not part of the exported `ToastRecord`: it exists only so a dismissed toast
 * can stay in the list while its exit animation runs, and widening the public
 * type for that would break anyone who builds a `ToastRecord` by hand.
 */
interface QueuedToast extends ToastRecord {
  /**
   * `false` from the moment the toast is dismissed until its exit animation
   * has finished, at which point the record is dropped. A closed toast is
   * still in the list so the node can animate out, but it no longer counts
   * toward the queue cap and can no longer be updated.
   */
  open: boolean
}

export interface ToastContextValue {
  /** Queues a toast and returns its id. */
  push: (toast: ToastOptions) => string
  dismiss: (id: string) => void
  /** Patches a live toast in place and restarts its timer. */
  update: (id: string, patch: Partial<ToastOptions>) => void
}

export interface ToastProviderProps {
  children?: ReactNode
  /** Applied to any toast that does not specify its own. */
  duration?: number
  /** Queue cap. Older toasts are dropped once it is exceeded. */
  max?: number
  placement?: ToastPlacement
  /** Accessible name for the notification region. */
  label?: string
}

const DEFAULT_ICONS: Record<ToastVariant, IconName> = {
  info: 'info',
  success: 'checkCircle',
  warning: 'warning',
  danger: 'alert',
}

const ToastContext = createContext<ToastContextValue | null>(null)

/**
 * Ephemeral, non-modal feedback.
 *
 * LIVE REGION MECHANICS
 * ---------------------
 * The viewport is rendered unconditionally, empty, for the entire life of the
 * provider. This is the single most commonly broken thing about toasts: a live
 * region only announces content inserted into a region the platform was already
 * observing, so mounting the region and the first toast in the same commit
 * announces nothing at all. Rendering the container up front is what makes the
 * first toast of a session behave like the tenth.
 *
 * For the same reason the viewport is not portalled. `Portal` defers its mount
 * by one render so it is safe to render on a server, and that one-render gap is
 * long enough for a child's mount effect to push a toast into a region that does
 * not exist yet. `ToastProvider` belongs at the app root, where a `position:
 * fixed` element has nothing above it to establish a containing block.
 *
 * `aria-atomic="false"` is not decoration. `role="status"` carries an implicit
 * `aria-atomic="true"`, which would make every change re-announce every toast
 * currently on screen — so the fourth toast in a burst would be read as all four
 * from the top. Overriding it back to false means only the added node is spoken.
 *
 * Danger toasts carry `role="alert"` on the toast itself, nested inside the
 * polite region. An element with its own `role` establishes its own politeness
 * for its subtree, so a failure interrupts while an "Exported" confirmation
 * waits its turn — which is the whole reason for the distinction. The region
 * around it stays polite so it can keep its identity across the session.
 *
 * DISMISSAL IS TWO STEPS
 * ----------------------
 * Dismissing flips the record to `open: false` rather than removing it, so the
 * node stays in the tree long enough to slide back out the way it came; the
 * item drops the record once `usePresence` reports the exit finished. That
 * costs one rule for the live region: a closing toast is never updated, because
 * a text change inside a region the platform is still observing would announce
 * a notification the user has just dismissed.
 *
 * TIMING
 * ------
 * Auto-dismiss pauses on hover and on focus-within. Focus matters more than
 * hover: a keyboard user tabs into the toast to reach its action, and without
 * the pause the toast they are reading is removed from under their focus after
 * five seconds, which drops focus to the top of the document. WCAG 2.2.1 also
 * wants a way to extend a time limit; `duration: 0` is that escape hatch for
 * anything the user genuinely must act on.
 */
export function ToastProvider({
  children,
  duration = 5000,
  max = 4,
  placement = 'bottom-end',
  label,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<QueuedToast[]>([])

  const idPrefix = useId()
  const seq = useRef(0)

  // `push` must never change identity: a consumer who puts it in an effect's
  // dependency array should not have that effect re-run because the provider
  // re-rendered for an unrelated reason. `useEventCallback` parks the latest
  // closure in an insertion effect, so `duration` and `max` are read fresh
  // without a ref being written during render — a render React discards still
  // runs its body, and a ref mutated there keeps a value from an attempt that
  // was never committed.
  const push = useEventCallback(
    (options: ToastOptions) => {
      if (import.meta.env?.DEV && options.title == null && options.description == null) {
        console.error(
          '[t-lingual/ui] toast.push() needs a `title` or a `description`. ' +
            'A toast with neither announces nothing and renders as an empty card.',
        )
      }

      seq.current += 1
      const id = `${idPrefix}-${seq.current}`

      setToasts((previous) => {
        const next = previous.concat({
          ...options,
          id,
          variant: options.variant ?? 'info',
          duration: options.duration ?? duration,
          revision: 0,
          open: true,
        })
        // The cap counts only what is still open; a toast on its way out has
        // already given up its place. Excess is closed from the front rather
        // than cut, so the oldest — which has had the most time on screen and
        // is the one the user is least likely to still be reading — leaves
        // through the same exit as any other dismissal.
        let excess = next.reduce((count, toast) => (toast.open ? count + 1 : count), 0) - max
        if (excess <= 0) return next
        return next.map((toast) => {
          if (!toast.open || excess <= 0) return toast
          excess -= 1
          return { ...toast, open: false }
        })
      })

      return id
    },
  )

  const dismiss = useCallback((id: string) => {
    setToasts((previous) => {
      const target = previous.find((toast) => toast.id === id)
      // Returning the same array keeps a second dismissal of an already-closing
      // toast (its timer firing after the close button, say) from re-rendering
      // the whole stack for nothing.
      if (!target || !target.open) return previous
      return previous.map((toast) => (toast.id === id ? { ...toast, open: false } : toast))
    })
  }, [])

  const update = useCallback((id: string, patch: Partial<ToastOptions>) => {
    setToasts((previous) =>
      previous.map((toast) =>
        toast.id === id && toast.open
          ? { ...toast, ...patch, revision: toast.revision + 1 }
          : toast,
      ),
    )
  }, [])

  const remove = useCallback((id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id))
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ push, dismiss, update }),
    [push, dismiss, update],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport
        toasts={toasts}
        onDismiss={dismiss}
        onRemove={remove}
        placement={placement}
        label={label}
      />
    </ToastContext.Provider>
  )
}

/**
 * Access to the toast queue.
 *
 * Throws rather than returning a no-op outside a provider: a silently swallowed
 * notification is a bug that only shows up as "the user was never told", which
 * is precisely the failure mode nobody notices in review.
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('[t-lingual/ui] useToast() must be called inside a <ToastProvider>.')
  }
  return context
}

interface ToastViewportProps {
  toasts: QueuedToast[]
  onDismiss: (id: string) => void
  onRemove: (id: string) => void
  placement: ToastPlacement
  label: string | undefined
}

function ToastViewport({ toasts, onDismiss, onRemove, placement, label }: ToastViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Tabbing from a toast's action button to its dismiss button fires blur then
    // focus. Without this containment check the timers would resume for one
    // frame in between and a toast could vanish mid-keystroke.
    if (event.currentTarget.contains(event.relatedTarget)) return
    setFocused(false)
  }

  useEffect(() => {
    // Removing the node the pointer is over does not reliably produce a
    // `pointerleave`, and removing the focused node does not reliably produce a
    // `focusout`. Dismissing a toast by clicking its own close button hits both
    // at once, so after any change to the stack either flag can be latched on
    // with nothing left under the pointer or the caret — and every toast still
    // on screen would then sit there with its timer paused forever. Re-deriving
    // from the live DOM is the only reading of these two that cannot go stale,
    // so do not trust the events to have fired.
    const node = viewportRef.current
    if (!node) return
    setHovered(node.matches(':hover'))
    setFocused(node.contains(document.activeElement))
  }, [toasts])

  return (
    <div
      ref={viewportRef}
      data-tl="toast-viewport"
      data-placement={placement}
      className="tl-toast-viewport"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label={label}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          paused={hovered || focused}
          onDismiss={onDismiss}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

interface ToastItemProps {
  toast: QueuedToast
  paused: boolean
  onDismiss: (id: string) => void
  onRemove: (id: string) => void
}

function ToastItem({ toast, paused, onDismiss, onRemove }: ToastItemProps) {
  const uid = useId()
  const titleId = `${uid}-title`
  const descriptionId = `${uid}-description`
  const dismissId = `${uid}-dismiss`

  const { id, duration, revision, open } = toast

  // A toast is only ever pushed open, so presence settles it straight into
  // `entered` — the entrance is driven by `@starting-style` on insertion, not
  // by the `entering` state — and its real job here is the exit: holding the
  // node until the slide-out has finished, then reporting it can go.
  const ref = useRef<HTMLDivElement>(null)
  const { mounted, status } = usePresence(open, ref)

  useEffect(() => {
    if (mounted) return
    onRemove(id)
  }, [mounted, id, onRemove])

  const remaining = useRef(duration)
  const startedAt = useRef(0)

  useEffect(() => {
    remaining.current = duration
  }, [duration, revision])

  useEffect(() => {
    // A closing toast has no timer: it has already been dismissed, and firing
    // again would only churn state while the exit is running.
    if (paused || !open || duration <= 0) return

    startedAt.current = Date.now()
    const timer = window.setTimeout(() => onDismiss(id), Math.max(remaining.current, 0))

    return () => {
      window.clearTimeout(timer)
      // Bank the elapsed slice so an unpause resumes where the user interrupted
      // rather than granting a fresh full duration every time the pointer
      // crosses the toast.
      remaining.current -= Date.now() - startedAt.current
    }
  }, [paused, open, duration, revision, id, onDismiss])

  if (!mounted) return null

  const resolvedIcon =
    toast.icon === undefined ? <Icon name={DEFAULT_ICONS[toast.variant]} /> : toast.icon

  // The dismiss button's name has to say WHICH toast it closes — four stacked
  // buttons all called "Dismiss" are indistinguishable in a screen reader's
  // element list. Referencing the button's own id first, then the title, builds
  // "Dismiss / Recording saved" out of nodes that already exist, so it stays
  // correct through `update()` without a second copy of the text to maintain.
  const nameSource =
    toast.title != null ? titleId : toast.description != null ? descriptionId : undefined

  const timed = duration > 0
  const style = timed ? ({ '--_life': `${duration}ms` } as CSSProperties) : undefined

  return (
    <div
      ref={ref}
      data-tl="toast"
      data-variant={toast.variant}
      data-state={status}
      data-paused={paused || undefined}
      className="tl-toast"
      role={toast.variant === 'danger' ? 'alert' : undefined}
      style={style}
    >
      {resolvedIcon != null && (
        <span className="tl-toast__icon" aria-hidden="true">
          {resolvedIcon}
        </span>
      )}

      <div className="tl-toast__body">
        {toast.title != null && (
          <p className="tl-toast__title" id={titleId}>
            {toast.title}
          </p>
        )}
        {toast.description != null && (
          <div className="tl-toast__description" id={descriptionId}>
            {toast.description}
          </div>
        )}
      </div>

      {toast.action && (
        <button
          type="button"
          className="tl-toast__action"
          onClick={() => {
            toast.action?.onAction()
            // Acting on a toast is an acknowledgement. Leaving it on screen
            // afterwards makes the user dismiss the same thing twice.
            onDismiss(id)
          }}
        >
          {toast.action.label}
        </button>
      )}

      <button
        type="button"
        id={dismissId}
        className="tl-toast__dismiss"
        aria-labelledby={nameSource ? `${dismissId} ${nameSource}` : undefined}
        onClick={() => onDismiss(id)}
      >
        <VisuallyHidden>{toast.dismissLabel ?? 'Dismiss'}</VisuallyHidden>
        <Icon name="close" />
      </button>

      {/* Keyed on revision so `update()` restarts the countdown from full,
        * in step with the timer it mirrors. Absent entirely for a pinned toast:
        * a bar that never drains would promise a departure that is not coming. */}
      {timed && <span key={revision} className="tl-toast__life" aria-hidden="true" />}
    </div>
  )
}
