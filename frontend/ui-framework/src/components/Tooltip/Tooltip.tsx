import {
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { Portal } from '../../primitives/Portal'
import { Slot, composeRefs } from '../../primitives/Slot'
import { useControllableState } from '../../hooks/useControllableState'
import { useAnchoredPosition } from '../_shared/useAnchoredPosition'
import { useAttachedNode } from '../_shared/useAttachedNode'
import { usePresence } from '../_shared/usePresence'
import type { Placement } from '../_shared/position'
import './Tooltip.css'

/**
 * Shared across every Tooltip on the page: once one has been shown, the next
 * one skips its open delay for this long.
 *
 * The delay exists to stop tooltips firing at a pointer merely crossing the
 * screen. Once the user has demonstrably stopped to read one, they have shown
 * intent, and re-imposing half a second on every subsequent target makes
 * scanning along a toolbar feel broken — you hover, wait, read, move one icon
 * left, and wait again.
 */
let skipDelayUntil = 0
const SKIP_DELAY_WINDOW = 300

const INTERACTIVE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

// `content` is omitted because React's HTMLAttributes carries the RDFa
// `content` string attribute, and this component needs the name for a node.
export interface TooltipProps extends Omit<HTMLAttributes<HTMLDivElement>, 'content'> {
  /** The description. Text — see the note about interactive content. */
  content: ReactNode
  /** The element being described. */
  children: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: Placement
  offset?: number
  padding?: number
  arrow?: boolean
  /** Milliseconds of hover before it appears. */
  openDelay?: number
  /** Milliseconds of grace before it disappears. */
  closeDelay?: number
  container?: HTMLElement | null
  /** Suppresses the tooltip without changing the trigger's markup. */
  disabled?: boolean
}

/**
 * A short description attached to a control, shown on hover and on focus.
 *
 * WHAT THIS COMPONENT IS ACTUALLY FOR
 * -----------------------------------
 * It supplements a name; it never replaces one. That is why it wires
 * `aria-describedby` rather than `aria-label`: a labelled icon button should
 * still announce "Copy transcript, button" without a tooltip anywhere in the
 * picture, and the tip adds detail on top. Reaching for a tooltip to name a
 * control means the control has no name at all for anyone who never hovers —
 * every touch user, and every screen reader user on a control that only reveals
 * its purpose to a mouse.
 *
 * WCAG 2.1 SC 1.4.13 IS THE SPEC HERE, AND IT HAS THREE PARTS
 * -----------------------------------------------------------
 * Dismissible: Escape closes the tip without moving focus, so a tip that
 * happens to be covering the thing the user was reading can be got rid of
 * without losing their place in the tab order.
 *
 * Hoverable: the tip itself accepts the pointer and cancels the pending close,
 * and there is a grace period on the way out. A user who is zoomed in and needs
 * to move the pointer onto the tip to read it must be able to arrive without it
 * evaporating in the gap between the trigger and the tip.
 *
 * Persistent: it stays until the pointer leaves, focus leaves, or Escape — it
 * never times out on its own, because a reader who is slower than the timeout
 * simply cannot read it.
 *
 * On top of that, and separately from 1.4.13, it opens on keyboard focus, not
 * only on hover. A hover-only tooltip is information that exists exclusively
 * for people using a mouse.
 *
 * NO INTERACTIVE CONTENT
 * ----------------------
 * A tooltip cannot contain a link, a button or anything focusable. It is not in
 * the tab order, it disappears when the pointer leaves, and `aria-describedby`
 * flattens its subtree to a string when it is announced — so a control inside it
 * is unreachable by keyboard and invisible to a screen reader, whatever it
 * looks like. Anything with a control in it is a Popover. Development builds
 * check the rendered tip and say so.
 */
export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(function Tooltip(
  {
    content,
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    placement = 'top',
    offset = 8,
    padding = 8,
    arrow = true,
    openDelay = 500,
    closeDelay = 150,
    container,
    disabled = false,
    className,
    ...rest
  },
  ref,
) {
  const [open, setOpen] = useControllableState({
    value: openProp,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })

  const anchor = useAttachedNode<HTMLElement>()
  const floating = useAttachedNode<HTMLDivElement>()
  const tip = useAttachedNode<HTMLDivElement>()
  const openTimer = useRef(0)
  const closeTimer = useRef(0)
  // Set when the user has actively dismissed the tip, so it does not spring
  // straight back while the pointer is still sitting on the trigger.
  const suppressed = useRef(false)

  const generatedId = useId()
  const tipId = rest.id ?? generatedId
  const usable = !disabled && content != null && content !== false

  const { mounted, status } = usePresence(open, floating.ref)

  // True when this tip opened inside the skip-delay window above, which means
  // the user is moving between tips rather than arriving at one. The
  // stylesheet then drops the entrance and exit: re-animating each tip as the
  // pointer walks along a toolbar reads as flicker. It is state rather than a
  // ref because it has to be in the DOM on the very commit that mounts the
  // tip — `@starting-style` is consumed at the first style computation, and an
  // attribute added a frame later changes nothing the eye can see. It lasts
  // for the whole of the tip's time in the tree so the exit is a cut too, and
  // is cleared once the tip has gone so a later open decides afresh.
  //
  // The reset is gated on `open` as well as `mounted` because the two are out
  // of step for one render on every fresh open: usePresence only queues its
  // mount during that pass, so `mounted` still reads false while `instant` has
  // just been set for the tip about to appear. Without the gate the flag would
  // be wiped in the very render that needs it.
  const [instant, setInstant] = useState(false)
  if (!open && !mounted && instant) setInstant(false)

  useAnchoredPosition({
    anchor: anchor.node,
    floating: floating.node,
    placement,
    offset,
    padding,
    onAnchorHidden: () => setOpen(false),
  })

  const show = (immediate: boolean) => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = 0
    if (!usable || suppressed.current || open) return
    const warm = Date.now() < skipDelayUntil
    const delay = immediate || warm ? 0 : openDelay
    if (delay === 0) {
      // Set together with `open` so both land in the same commit; see the note
      // on `instant` above for why a frame later would be too late.
      setInstant(warm)
      setOpen(true)
      return
    }
    window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      setInstant(false)
      setOpen(true)
    }, delay)
  }

  // The skip-delay window opens the moment a close is requested, not when it
  // commits. Tabbing from one trigger to the next fires the old one's blur and
  // the new one's focus inside a single call, so the next tip reads
  // `skipDelayUntil` before any effect from this close has had a chance to
  // run; setting it here is what lets a tab along a toolbar cut from tip to
  // tip instead of replaying the entrance at every stop.
  const close = () => {
    skipDelayUntil = Date.now() + SKIP_DELAY_WINDOW
    setOpen(false)
  }

  const hide = (immediate: boolean) => {
    window.clearTimeout(openTimer.current)
    openTimer.current = 0
    if (!open) return
    if (immediate) {
      close()
      return
    }
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(close, closeDelay)
  }

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current)
      window.clearTimeout(closeTimer.current)
    },
    [],
  )

  // Covers the closes this component did not initiate — a controlled `open`
  // flipping false, Escape, the anchor scrolling out of view — none of which
  // opens another tip in the same task, so running after the commit is fine.
  useEffect(() => {
    if (!open) return
    return () => {
      skipDelayUntil = Date.now() + SKIP_DELAY_WINDOW
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Capture phase and stopPropagation so one press closes one layer: a tip
      // showing over a dialog is dismissed without also dismissing the dialog
      // underneath it, which matches how useDismiss stacks everything else.
      event.stopPropagation()
      suppressed.current = true
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, setOpen])

  useEffect(() => {
    if (!import.meta.env?.DEV || !tip.node) return
    if (!tip.node.querySelector(INTERACTIVE)) return
    console.error(
      '[t-lingual/ui] <Tooltip content> contains a focusable element. A tooltip ' +
        'is not in the tab order and is flattened to a string by ' +
        'aria-describedby, so that control can never be reached. Use a Popover.',
    )
  }, [tip.node])

  const onPointerEnter = (event: ReactPointerEvent<HTMLElement>) => {
    // Touch has no hover state; a tap would otherwise flash a tip and dismiss it
    // in the same gesture. Touch users get the control's own name instead.
    if (event.pointerType === 'touch') return
    show(false)
  }

  const onPointerLeave = () => {
    suppressed.current = false
    hide(false)
  }

  const onPointerDown = () => {
    // Activating the control answers whatever the tip was explaining.
    suppressed.current = true
    hide(true)
  }

  const onFocus = () => {
    // Deliberately not gated on `:focus-visible`. A pointer press on the trigger
    // has already set `suppressed` by the time focus lands — pointerdown fires
    // before focus — so the "do not pop a tip when someone clicks the button"
    // case is handled without depending on a selector whose heuristics vary
    // between engines and which jsdom does not implement at all. Keyboard focus
    // then reaches this unconditionally, which is the behaviour that matters.
    show(true)
  }

  const onBlur = () => {
    suppressed.current = false
    hide(true)
  }

  if (import.meta.env?.DEV && !isValidElement(children)) {
    console.error('[t-lingual/ui] <Tooltip> expects a single React element child.')
  }

  // The child is cloned before it reaches Slot so that an `aria-describedby`
  // the trigger already carries — a field pointing at its own hint — is
  // appended to rather than replaced. Slot gives the child's own prop
  // precedence by design, so the merge has to happen on the child itself.
  //
  // The reference is added only while the tip is mounted, because an IDREF to
  // an element that is not in the document names nothing and would leave the
  // description permanently announced as empty.
  let trigger: ReactNode = children
  if (isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>
    const existing = child.props['aria-describedby']
    trigger = (
      <Slot
        ref={anchor.attach}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {cloneElement(child, {
          'aria-describedby': cx(
            typeof existing === 'string' ? existing : undefined,
            mounted ? tipId : undefined,
          ),
        })}
      </Slot>
    )
  }

  return (
    <>
      {trigger}
      {mounted && (
        <Portal container={container}>
          <div
            ref={floating.attach}
            className="tl-tooltip"
            data-state={status}
            data-instant={instant || undefined}
            onPointerEnter={() => show(true)}
            onPointerLeave={() => hide(false)}
          >
            <div
              {...rest}
              ref={composeRefs(ref, tip.attach)}
              id={tipId}
              role="tooltip"
              data-tl="tooltip"
              data-state={status}
              className={cx('tl-tooltip__tip', className)}
            >
              {content}
            </div>
            {arrow && <span className="tl-tooltip__arrow" aria-hidden="true" />}
          </div>
        </Portal>
      )}
    </>
  )
})
