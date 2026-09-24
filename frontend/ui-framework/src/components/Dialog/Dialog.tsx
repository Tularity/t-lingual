import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { Portal } from '../../primitives/Portal'
import { composeRefs } from '../../primitives/Slot'
import { useControllableState } from '../../hooks/useControllableState'
import { useAttachedNode } from '../_shared/useAttachedNode'
import { useModalSurface } from '../_shared/useModalSurface'
import { useScrollableRegion } from '../_shared/useScrollableRegion'
import {
  OverlaySurfaceContext,
  useOverlaySurface,
  useOverlaySurfaceValue,
  useSurfaceLabelId,
} from '../_shared/surfaceContext'
import './Dialog.css'

export type DialogSize = 'sm' | 'md' | 'lg' | 'full'

/** A point in viewport coordinates, as reported by `clientX` / `clientY`. */
export interface DialogOrigin {
  x: number
  y: number
}

export interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  size?: DialogSize
  /** Portal target. Defaults to `document.body`. */
  container?: HTMLElement | null
  /** Focused on open. Defaults to the first focusable element in the panel. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Returns focus to whatever had it before the dialog opened. */
  restoreFocus?: boolean
  /** Set false for a dialog that must be resolved by one of its own buttons. */
  dismissOnOutsidePress?: boolean
  /** Set false only when losing unsaved work would be the consequence. */
  dismissOnEscape?: boolean
  /** Renders the close affordance in `DialogHeader`. */
  showCloseButton?: boolean
  closeLabel?: string
  /**
   * The control the dialog should appear to grow out of. Its centre is
   * measured once, at the moment the dialog opens, and the exit collapses back
   * to that same point even if the control has since moved or unmounted.
   *
   * Worth passing for asynchronous opens: the fallback captures the activating
   * control before its handler moves focus, then uses focused-element geometry.
   */
  originRef?: RefObject<HTMLElement | null>
  /** An explicit origin point, for opening from a pointer position or a canvas hit. */
  origin?: DialogOrigin
  children?: ReactNode
}

/** See the note on the same constant in Tabs: SSR-safe layout effect. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Offset from the centre of the viewport to the origin point. A delta rather
 * than a point because that is what the panel's transform needs, and because
 * it is frozen: the exit has to replay the entrance in reverse, from the same
 * place, even if the trigger has since moved or been unmounted.
 */
interface OriginDelta {
  dx: number
  dy: number
}

function rectCentre(element: Element | null | undefined): DialogOrigin | null {
  if (!element || !element.isConnected) return null
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** Focused-element fallback for programmatic opens without an activation event. */
function activeTrigger(): Element | null {
  const active = document.activeElement
  if (!active || active === document.body || active === document.documentElement) return null
  return active
}

// Capture the actual activating control in the event's capture phase, before
// its click/key handler can set open and move focus into the portal. This also
// works when a Dialog is conditionally mounted by that very handler.
let lastActivation: { point: DialogOrigin; at: number } | null = null
const activationSelector = 'button, [role="button"], a[href], input[type="button"], input[type="submit"], summary, [tabindex]'
function rememberActivation(target: EventTarget | null) {
  const element = target instanceof Element ? target.closest(activationSelector) : null
  const point = rectCentre(element)
  lastActivation = point ? { point, at: Date.now() } : null
}
function onActivationPointer(event: Event) { rememberActivation(event.target) }
function onActivationKey(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') rememberActivation(event.target)
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', onActivationPointer, true)
  document.addEventListener('click', onActivationPointer, true)
  document.addEventListener('keydown', onActivationKey, true)
  import.meta.hot?.dispose(() => {
    document.removeEventListener('pointerdown', onActivationPointer, true)
    document.removeEventListener('click', onActivationPointer, true)
    document.removeEventListener('keydown', onActivationKey, true)
  })
}
function activatingTrigger(): DialogOrigin | null {
  return lastActivation && Date.now() - lastActivation.at < 1000 ? lastActivation.point : null
}
function captureOrigin(
  explicit: DialogOrigin | undefined,
  anchor: RefObject<HTMLElement | null> | undefined,
): OriginDelta | null {
  if (typeof window === 'undefined') return null
  const point = explicit ?? rectCentre(anchor?.current) ?? activatingTrigger() ?? rectCentre(activeTrigger())
  if (!point) return null
  return {
    dx: Math.round(point.x - window.innerWidth / 2),
    dy: Math.round(point.y - window.innerHeight / 2),
  }
}

/**
 * A modal dialog.
 *
 * MODALITY IS FOUR THINGS, NOT ONE
 * --------------------------------
 * A focus trap is the part everyone implements and it is the part that covers
 * the fewest users. `useModalSurface` composes all four — trap, scroll lock,
 * outside-press/Escape dismissal, and marking the rest of the document `inert`
 * so a screen reader's virtual cursor cannot walk out of the dialog into a page
 * whose controls are visually behind a scrim and functionally unreachable. The
 * ordering constraints between those four are documented on that hook; they are
 * subtle and easy to undo by "tidying" the call order.
 *
 * WHY THE NODE OUTLIVES `open`
 * ----------------------------
 * Rendering `{open && <panel/>}` gives an entrance animation and no exit: the
 * element is gone from the tree before the browser has a style to transition
 * away from, so the dialog disappears instantly while its scrim fades out
 * behind it. `usePresence` therefore drives two values — one saying whether the
 * node is in the tree, one saying which `data-state` it carries — and unmounts
 * only after the running exit animations report finished through their
 * `finished` promises (or after a fixed backstop in `usePresence`, because a
 * throttled background tab may never settle them).
 *
 * A dialog that is open on first render skips the entrance animation entirely,
 * which is deliberate: there is nothing to animate in from when the surface was
 * already on screen the first time the user saw it.
 *
 * MOTION
 * ------
 * The panel grows out of the control that opened it. The origin is measured
 * once, at open, and frozen: the exit collapses back to the same point even if
 * the trigger has since moved, scrolled away or unmounted. No duration is
 * duplicated in JavaScript — `usePresence` unmounts the dialog when the real
 * animations report finished, with only a safety backstop behind them — so the
 * durations exist only in CSS and shorten correctly under
 * `prefers-reduced-motion`, where the zoom and the travel both collapse to
 * nothing and only the fade remains.
 */
export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  {
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    size = 'md',
    container,
    initialFocus,
    restoreFocus = true,
    dismissOnOutsidePress = true,
    dismissOnEscape = true,
    showCloseButton = true,
    closeLabel = 'Close',
    originRef,
    origin,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const [open, setOpen] = useControllableState({
    value: openProp,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })

  const root = useAttachedNode<HTMLDivElement>()
  const panel = useAttachedNode<HTMLDivElement>()

  /* -- Origin capture ------------------------------------------------------
   * The origin has to be in the panel's inline style on the very first commit
   * that puts the panel in the document. `@starting-style` is consumed at the
   * element's first style computation, and a transition created from the wrong
   * from-value keeps that from-value — writing the right number a frame later
   * changes nothing the eye can see, so the panel would zoom from the centre.
   *
   * So the panel is held back until the measurement has landed. The layout
   * effect runs before paint and its state update is flushed synchronously, so
   * the commit that renders the panel is a second commit inside the same frame:
   * nothing is delayed visually. The activation listener already froze the
   * trigger centre before handlers or the focus trap moved anything.
   *
   * Readiness is reset when the node leaves the tree, not when `open` goes
   * false. A re-open while the exit is still running keeps the same node —
   * `usePresence` just flips it back to `entering` and the transition reverses
   * in place — and resetting on close would put that node behind the gate
   * again: one commit of null, the panel unmounted and re-inserted from
   * `@starting-style`, every child remounted and its state lost. The origin is
   * still re-captured below, so the new trigger becomes the exit target. */
  const [originDelta, setOriginDelta] = useState<OriginDelta | null>(null)
  const [originReady, setOriginReady] = useState(false)
  useIsomorphicLayoutEffect(() => {
    if (!open) return
    // Not cleared on close: the exit replays the same origin.
    setOriginDelta(captureOrigin(origin, originRef))
    setOriginReady(true)
    // `origin` is compared by its coordinates rather than by identity, so an
    // inline `{ x, y }` literal does not re-run this on every render.
  }, [open, origin?.x, origin?.y, originRef])

  const close = useCallback(() => setOpen(false), [setOpen])
  const surface = useOverlaySurfaceValue({ close, closeLabel, showCloseButton })

  const { mounted, status } = useModalSurface({
    open,
    rootRef: root.ref,
    panelRef: panel.ref,
    attached: root.node !== null && panel.node !== null,
    onDismiss: close,
    initialFocus,
    restoreFocus,
    dismissOnOutsidePress,
    dismissOnEscape,
  })

  useEffect(() => {
    if (!mounted) setOriginReady(false)
  }, [mounted])

  // GEOMETRY IS LATCHED FOR THE DURATION OF THE EXIT.
  //
  // `open={selected !== null}` paired with `size={selected?.size ?? 'md'}` is
  // the idiomatic way to drive a dialog from nullable state, and it has a sharp
  // edge: closing clears the state, so `size` reverts to its default on the
  // very commit that starts the exit. Width is not a transitioned property, so
  // an `lg` panel would snap to 520px on the first frame and only then zoom
  // back to its trigger — "it flashes back to the wrong size before it closes".
  // A thing on its way out does not resize; the last size it had while open is
  // the one it leaves at.
  const [latchedSize, setLatchedSize] = useState(size)
  useEffect(() => {
    if (open) setLatchedSize(size)
  }, [open, size])
  const renderedSize = status === 'exiting' ? latchedSize : size

  const labelledExternally = Boolean(rest['aria-label'] ?? rest['aria-labelledby'])

  useEffect(() => {
    if (!import.meta.env?.DEV) return
    // Gated on the panel NODE, not on `mounted`. `mounted` goes true one commit
    // before `Portal` puts anything in the document, so a check keyed on it runs
    // against an empty subtree and faults every correctly labelled dialog on the
    // frame it opens — and a check that cries wolf is a check nobody reads. A
    // non-null node is proof the portal content is actually in the document.
    if (!open || !panel.node) return
    if (surface.hasTitle || labelledExternally) return
    // The DOM lookup backs up the flag because React runs a child's effects
    // before its parent's: <DialogTitle> has claimed the id by the time this
    // runs, but the state that records it has not been applied yet.
    if (panel.node.querySelector(`#${CSS.escape(surface.titleId)}`)) return
    console.error(
      '[t-lingual/ui] <Dialog> has no accessible name. Render a <DialogTitle> ' +
        'inside it, or pass `aria-label`. A dialog announced only as "dialog" ' +
        'gives no indication of what it interrupted the page for.',
    )
  }, [open, panel.node, surface.hasTitle, surface.titleId, labelledExternally])

  // The second condition is the origin gate described above; while exiting,
  // `open` is already false and the latched origin is what the panel leaves to.
  if (!mounted || (open && !originReady)) return null

  const panelStyle = {
    ...(originDelta
      ? { '--_origin-x': `${originDelta.dx}px`, '--_origin-y': `${originDelta.dy}px` }
      : null),
    ...style,
  } as CSSProperties

  return (
    <Portal container={container}>
      <OverlaySurfaceContext.Provider value={surface}>
        <div
          ref={root.attach}
          className="tl-dialog"
          data-state={status}
          data-size={renderedSize}
        >
          <div className="tl-dialog__scrim" data-state={status} aria-hidden="true" />
          <div
            {...rest}
            ref={composeRefs(ref, panel.attach)}
            role="dialog"
            aria-modal="true"
            aria-labelledby={
              rest['aria-labelledby'] ?? (surface.hasTitle ? surface.titleId : undefined)
            }
            aria-describedby={
              rest['aria-describedby'] ??
              (surface.hasDescription ? surface.descriptionId : undefined)
            }
            // Focusable so the trap has somewhere to put focus in a dialog that
            // is pure text, and so the panel itself can be scrolled by keyboard.
            tabIndex={-1}
            data-tl="dialog"
            data-state={status}
            data-size={renderedSize}
            className={cx('tl-dialog__panel', className)}
            style={panelStyle}
          >
            {children}
          </div>
        </div>
      </OverlaySurfaceContext.Provider>
    </Portal>
  )
})

/* -- Sub-components -------------------------------------------------------- */

export interface DialogHeaderProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

/**
 * Title area, plus the close button unless the dialog opted out.
 *
 * The close button lives here rather than floating over the panel corner so it
 * comes early in the reading order — a screen reader user should meet the exit
 * before the content, not after scrolling past all of it.
 */
export const DialogHeader = forwardRef<HTMLElement, DialogHeaderProps>(function DialogHeader(
  { className, children, ...rest },
  ref,
) {
  const surface = useOverlaySurface('DialogHeader')
  return (
    <header ref={ref} {...rest} className={cx('tl-dialog__header', className)}>
      <div className="tl-dialog__heading">{children}</div>
      {surface.showCloseButton && (
        <button
          type="button"
          data-tl="dialog-close"
          className="tl-dialog__close"
          onClick={surface.close}
          aria-label={surface.closeLabel}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </header>
  )
})

export type DialogTitleProps = HTMLAttributes<HTMLHeadingElement>

/**
 * `h2` rather than a configurable level: a dialog is a new context stacked on
 * the page, so its heading only ever has to be consistent with the other
 * headings inside the dialog. Override with `role="heading" aria-level={n}` in
 * the rare case a dialog nests a full document outline.
 */
export const DialogTitle = forwardRef<HTMLHeadingElement, DialogTitleProps>(function DialogTitle(
  { className, ...rest },
  ref,
) {
  const id = useSurfaceLabelId('title', 'DialogTitle')
  // `id` after the spread: overwriting it would leave the dialog unnamed.
  return <h2 ref={ref} {...rest} id={id} className={cx('tl-dialog__title', className)} />
})

export type DialogDescriptionProps = HTMLAttributes<HTMLParagraphElement>

export const DialogDescription = forwardRef<HTMLParagraphElement, DialogDescriptionProps>(
  function DialogDescription({ className, ...rest }, ref) {
    const id = useSurfaceLabelId('description', 'DialogDescription')
    return <p ref={ref} {...rest} id={id} className={cx('tl-dialog__description', className)} />
  },
)

export type DialogBodyProps = HTMLAttributes<HTMLDivElement>

export const DialogBody = forwardRef<HTMLDivElement, DialogBodyProps>(function DialogBody(
  { className, ...rest },
  ref,
) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollable = useScrollableRegion(bodyRef)
  return (
    <div
      {...rest}
      ref={composeRefs(ref, bodyRef)}
      tabIndex={scrollable ? 0 : undefined}
      className={cx('tl-dialog__body', className)}
    />
  )
})

export type DialogFooterProps = HTMLAttributes<HTMLElement>

export const DialogFooter = forwardRef<HTMLElement, DialogFooterProps>(function DialogFooter(
  { className, ...rest },
  ref,
) {
  return <footer ref={ref} {...rest} className={cx('tl-dialog__footer', className)} />
})
