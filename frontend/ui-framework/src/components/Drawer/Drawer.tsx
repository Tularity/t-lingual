import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
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
import './Drawer.css'

export type DrawerSide = 'left' | 'right' | 'top' | 'bottom'
export type DrawerSize = 'sm' | 'md' | 'lg' | 'full'

export interface DrawerProps extends HTMLAttributes<HTMLDivElement> {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Edge the panel is anchored to. */
  side?: DrawerSide
  /** Extent along the axis it slides on. */
  size?: DrawerSize
  container?: HTMLElement | null
  initialFocus?: RefObject<HTMLElement | null>
  restoreFocus?: boolean
  dismissOnOutsidePress?: boolean
  dismissOnEscape?: boolean
  showCloseButton?: boolean
  closeLabel?: string
  /** Touch drag toward the anchored edge. See the note on how it degrades. */
  swipeToDismiss?: boolean
  children?: ReactNode
}

interface DragState {
  pointerId: number
  origin: number
  extent: number
  distance: number
  velocity: number
  lastTime: number
  engaged: boolean
}

/** Movement, in px, before a touch counts as a drag rather than a tap. */
const DRAG_THRESHOLD = 6
/** Flick speed, in px/ms, that dismisses regardless of distance travelled. */
const FLICK_VELOCITY = 0.5

/** See the note on the same constant in Tabs: SSR-safe layout effect. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * A modal panel anchored to an edge of the viewport.
 *
 * Everything that makes Dialog modal applies here unchanged — focus trap,
 * scroll lock, `inert` on the rest of the document, dismissal, and a mounted
 * node that outlives `open` so the exit slide can run. Those live in
 * `useModalSurface` and `usePresence`; the differences are the axis it travels
 * on, the `size` prop that sets its extent, and the swipe below.
 *
 * ABOUT THE SWIPE
 * ---------------
 * It is an affordance, never the only way out. Three constraints keep it from
 * being one:
 *
 * Mouse pointers are ignored outright. A mouse drag on a panel is how a user
 * selects text, and hijacking it would make the drawer's contents impossible to
 * copy — while the close button and Escape are already sitting there for anyone
 * with a pointer. So the gesture is touch and pen only, and on a machine
 * without Pointer Events none of these handlers ever fire and nothing is lost.
 *
 * Left and right drawers are draggable anywhere on the panel and declare
 * `touch-action: pan-y`, which hands vertical scrolling back to the browser and
 * lets it — not us — arbitrate which gesture the user meant. Top and bottom
 * drawers cannot do that: `pan-x` there would kill vertical scrolling inside
 * the panel, so they get an explicit grab handle and the drag starts only from
 * it. The handle is `aria-hidden`, because it is a target for a finger and
 * carries no information a screen reader needs. One caveat: the browser reads
 * `touch-action` no further up than the nearest scroll container, so the
 * drawer's own body declares it too, and a consumer who nests another
 * scrolling region inside a left or right drawer must give it `pan-y` as well
 * or a swipe that starts there will be cancelled as a scroll.
 *
 * The panel is moved by writing a custom property straight to the node rather
 * than by re-rendering. A drag produces a pointermove per frame and each one
 * would otherwise reconcile the drawer's entire subtree to change one number.
 */
export const Drawer = forwardRef<HTMLDivElement, DrawerProps>(function Drawer(
  {
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    side = 'right',
    size = 'md',
    container,
    initialFocus,
    restoreFocus = true,
    dismissOnOutsidePress = true,
    dismissOnEscape = true,
    showCloseButton = true,
    closeLabel = 'Close',
    swipeToDismiss = true,
    className,
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
  const dragRef = useRef<DragState | null>(null)

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

  // Geometry is LATCHED while the sheet is leaving. A caller that stores the
  // side in the same state that drives `open` — `const [side, setSide] =
  // useState<Side | null>(null)`, closing with `setSide(null)` — hands us the
  // default `'right'` on the very render that starts the exit, while the sheet
  // is still mounted. A drawer opened from the left would then fly out to the
  // right. The last geometry seen while open is what it leaves with.
  const [latched, setLatched] = useState({ side, size })
  useEffect(() => {
    if (open) setLatched({ side, size })
  }, [open, side, size])
  const renderedSide = status === 'exiting' ? latched.side : side
  const renderedSize = status === 'exiting' ? latched.size : size

  // From the rendered side, not the live one, for the same reason: on that
  // exit render a bottom sheet would otherwise be judged horizontal, drop its
  // grabber, and shift its header up while the panel is still sliding out.
  const horizontal = renderedSide === 'left' || renderedSide === 'right'
  const labelledExternally = Boolean(rest['aria-label'] ?? rest['aria-labelledby'])

  useEffect(() => {
    if (!import.meta.env?.DEV) return
    // See the matching note in Dialog. Gated on the panel node rather than on
    // `mounted`, because `mounted` leads the portal's actual insertion by a
    // commit and the check would otherwise fault every labelled drawer.
    if (!open || !panel.node) return
    if (surface.hasTitle || labelledExternally) return
    // A child's effects run before its parent's, so `hasTitle` is still false on
    // the commit that opens a drawer that does have a <DrawerTitle>. The heading
    // is already in the document by then, which is why the DOM gets the say.
    if (panel.node.querySelector(`#${CSS.escape(surface.titleId)}`)) return
    console.error(
      '[t-lingual/ui] <Drawer> has no accessible name. Render a <DrawerTitle> ' +
        'inside it, or pass `aria-label`.',
    )
  }, [open, panel.node, surface.hasTitle, surface.titleId, labelledExternally])

  const rootRef = root.ref
  const setDragOffset = useCallback(
    (distance: number | null, progress = 0) => {
      const node = rootRef.current
      if (!node) return
      if (distance === null) {
        node.style.removeProperty('--_drag')
        node.style.removeProperty('--_progress')
        delete node.dataset.dragging
        return
      }
      node.style.setProperty('--_drag', `${distance}px`)
      node.style.setProperty('--_progress', `${progress}`)
      node.dataset.dragging = 'true'
    },
    [rootRef],
  )

  // A swipe that dismissed leaves its offset on the root (see the release
  // handler) and relies on the node unmounting to discard it. A re-open that
  // lands before the exit has finished keeps the node — `usePresence` reverses
  // the exit in place — so the offset has to be cleared here, before paint,
  // or the sheet re-enters parked wherever the finger left it with a scrim
  // dimmed to match. On a first open the root is not attached yet and this is
  // a no-op; the fresh node has nothing to clear.
  useIsomorphicLayoutEffect(() => {
    if (open) setDragOffset(null)
  }, [open, setDragOffset])

  // The gesture handlers are attached after `{...rest}`, so a consumer's own
  // pointer handlers would be replaced rather than composed. Forwarding first
  // keeps them working and keeps the drag from depending on their behaviour.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    rest.onPointerDown?.(event)
    if (!swipeToDismiss || !open) return
    // Pen counts: a stylus has no text-selection expectation on a panel body.
    if (event.pointerType === 'mouse' || !event.isPrimary) return
    if (!horizontal && !(event.target as Element).closest('.tl-drawer__grabber')) return

    const panelNode = panel.ref.current
    if (!panelNode) return

    dragRef.current = {
      pointerId: event.pointerId,
      origin: horizontal ? event.clientX : event.clientY,
      extent: horizontal ? panelNode.offsetWidth : panelNode.offsetHeight,
      distance: 0,
      velocity: 0,
      lastTime: event.timeStamp,
      engaged: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    rest.onPointerMove?.(event)
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const position = horizontal ? event.clientX : event.clientY
    const signed =
      renderedSide === 'right' || renderedSide === 'bottom'
        ? position - drag.origin
        : drag.origin - position
    // Dragging away from the edge does nothing. A rubber band there would imply
    // the panel can be made larger, which it cannot.
    const distance = Math.max(0, signed)

    if (!drag.engaged) {
      if (distance < DRAG_THRESHOLD) return
      drag.engaged = true
    }

    const elapsed = Math.max(1, event.timeStamp - drag.lastTime)
    drag.velocity = (distance - drag.distance) / elapsed
    drag.lastTime = event.timeStamp
    drag.distance = distance

    setDragOffset(distance, drag.extent > 0 ? Math.min(1, distance / drag.extent) : 0)
  }

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.type === 'pointercancel') rest.onPointerCancel?.(event)
    else rest.onPointerUp?.(event)
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!drag.engaged) return

    const dismissed =
      event.type !== 'pointercancel' &&
      (drag.distance > Math.min(drag.extent * 0.3, 120) || drag.velocity > FLICK_VELOCITY)

    if (dismissed) {
      // The offset is deliberately left in place. Clearing it here would snap
      // the panel back to its open position for the frame between this call and
      // React committing `data-state="exiting"`, so the dismissal would flicker
      // backwards before it played forwards.
      const node = rootRef.current
      if (node) delete node.dataset.dragging
      close()
      return
    }
    setDragOffset(null)
  }

  if (!mounted) return null

  return (
    <Portal container={container}>
      <OverlaySurfaceContext.Provider value={surface}>
        <div
          ref={root.attach}
          className="tl-drawer"
          data-state={status}
          data-side={renderedSide}
          data-size={renderedSize}
          data-swipe={swipeToDismiss || undefined}
        >
          <div className="tl-drawer__scrim" data-state={status} aria-hidden="true" />
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
            tabIndex={-1}
            data-tl="drawer"
            data-state={status}
            data-side={renderedSide}
            className={cx('tl-drawer__panel', className)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          >
            {swipeToDismiss && !horizontal && (
              <div className="tl-drawer__grabber" aria-hidden="true">
                <span className="tl-drawer__grabber-bar" />
              </div>
            )}
            {children}
          </div>
        </div>
      </OverlaySurfaceContext.Provider>
    </Portal>
  )
})

/* -- Sub-components -------------------------------------------------------- */

export interface DrawerHeaderProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode
}

export const DrawerHeader = forwardRef<HTMLElement, DrawerHeaderProps>(function DrawerHeader(
  { className, children, ...rest },
  ref,
) {
  const surface = useOverlaySurface('DrawerHeader')
  return (
    <header ref={ref} {...rest} className={cx('tl-drawer__header', className)}>
      <div className="tl-drawer__heading">{children}</div>
      {surface.showCloseButton && (
        <button
          type="button"
          data-tl="drawer-close"
          className="tl-drawer__close"
          onClick={surface.close}
          aria-label={surface.closeLabel}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </header>
  )
})

export type DrawerTitleProps = HTMLAttributes<HTMLHeadingElement>

export const DrawerTitle = forwardRef<HTMLHeadingElement, DrawerTitleProps>(function DrawerTitle(
  { className, ...rest },
  ref,
) {
  const id = useSurfaceLabelId('title', 'DrawerTitle')
  return <h2 ref={ref} {...rest} id={id} className={cx('tl-drawer__title', className)} />
})

export type DrawerDescriptionProps = HTMLAttributes<HTMLParagraphElement>

export const DrawerDescription = forwardRef<HTMLParagraphElement, DrawerDescriptionProps>(
  function DrawerDescription({ className, ...rest }, ref) {
    const id = useSurfaceLabelId('description', 'DrawerDescription')
    return <p ref={ref} {...rest} id={id} className={cx('tl-drawer__description', className)} />
  },
)

export type DrawerBodyProps = HTMLAttributes<HTMLDivElement>

export const DrawerBody = forwardRef<HTMLDivElement, DrawerBodyProps>(function DrawerBody(
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
      className={cx('tl-drawer__body', className)}
    />
  )
})

export type DrawerFooterProps = HTMLAttributes<HTMLElement>

export const DrawerFooter = forwardRef<HTMLElement, DrawerFooterProps>(function DrawerFooter(
  { className, ...rest },
  ref,
) {
  return <footer ref={ref} {...rest} className={cx('tl-drawer__footer', className)} />
})
