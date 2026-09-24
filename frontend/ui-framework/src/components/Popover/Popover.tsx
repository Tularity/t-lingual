import {
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { cx } from '../../utils/cx'
import { Portal } from '../../primitives/Portal'
import { Slot, composeRefs } from '../../primitives/Slot'
import { useControllableState } from '../../hooks/useControllableState'
import { useDismiss } from '../../hooks/useDismiss'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useAnchoredPosition } from '../_shared/useAnchoredPosition'
import { useAttachedNode } from '../_shared/useAttachedNode'
import { usePresence } from '../_shared/usePresence'
import type { Placement } from '../_shared/position'
import './Popover.css'

export interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The control the panel hangs off. A single element — it is rendered through
   * `Slot`, so no wrapper is added and the trigger keeps its own layout.
   */
  trigger: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: Placement
  /** Gap between trigger and panel. Leave room for the arrow if one is shown. */
  offset?: number
  /** Viewport inset the panel keeps clear when it shifts. */
  padding?: number
  arrow?: boolean
  container?: HTMLElement | null
  initialFocus?: RefObject<HTMLElement | null>
  restoreFocus?: boolean
  dismissOnOutsidePress?: boolean
  dismissOnEscape?: boolean
  children?: ReactNode
}

/**
 * A non-modal floating panel attached to a trigger.
 *
 * WHAT MAKES IT NOT A DIALOG
 * --------------------------
 * Focus moves into the panel on open and returns to the trigger on close, the
 * same as Dialog. Everything else is deliberately absent: the page behind is
 * NOT marked `inert`, and the body scroll is NOT locked. That is the entire
 * distinction, and it is a semantic one rather than a stylistic shortcut — a
 * popover is a continuation of the page, so a user must be able to read the
 * paragraph it is explaining, scroll to it, and click it. A component that
 * locked scrolling would be a dialog wearing a popover's styling, and the tell
 * is the scrollbar disappearing when a small panel opens.
 *
 * Tab is still confined to the panel while it is open. Without that, tabbing
 * past the last control lands on whatever follows the trigger in the document
 * while a panel is visibly floating over it, and a keyboard user has no way to
 * tell they have left. Escape and an outside press both close it, so nothing is
 * trapped in the colloquial sense.
 *
 * POSITION
 * --------
 * `useAnchoredPosition` re-measures on scroll and resize behind a
 * requestAnimationFrame, and closes the panel outright once the trigger has
 * scrolled out of the viewport. A panel that stays pinned to the top edge after
 * its anchor has gone reads as a piece of detached chrome, and there is no
 * longer anything on screen it could be explaining.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    trigger,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    placement = 'bottom',
    offset = 8,
    padding = 8,
    arrow = true,
    container,
    initialFocus,
    restoreFocus = true,
    dismissOnOutsidePress = true,
    dismissOnEscape = true,
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

  const anchor = useAttachedNode<HTMLElement>()
  const floating = useAttachedNode<HTMLDivElement>()
  const panel = useAttachedNode<HTMLDivElement>()

  const generatedId = useId()
  const panelId = rest.id ?? generatedId

  const close = useCallback(() => setOpen(false), [setOpen])
  const { mounted, status } = usePresence(open, floating.ref)
  const active = open && mounted && panel.node !== null

  useAnchoredPosition({
    anchor: anchor.node,
    floating: floating.node,
    placement,
    offset,
    padding,
    onAnchorHidden: close,
  })
  useFocusTrap({ enabled: active, ref: panel.ref, initialFocus, restoreFocus })
  useDismiss({
    enabled: active,
    // The positioner rather than the panel, so a press that lands on the arrow
    // is not treated as a press outside the popover.
    ref: floating.ref,
    triggerRef: anchor.ref,
    onDismiss: close,
    onPointerDownOutside: dismissOnOutsidePress,
    onEscapeKey: dismissOnEscape,
  })

  const labelled = Boolean(rest['aria-label'] ?? rest['aria-labelledby'])

  useEffect(() => {
    if (!import.meta.env?.DEV || !active) return
    if (labelled) return
    console.error(
      '[t-lingual/ui] <Popover> renders role="dialog" and needs `aria-label` or ' +
        '`aria-labelledby`. Without one it is announced as an unnamed dialog, ' +
        'which tells the user focus moved but not where to.',
    )
  }, [active, labelled])

  if (import.meta.env?.DEV && !isValidElement(trigger)) {
    console.error('[t-lingual/ui] <Popover trigger> must be a single React element.')
  }

  return (
    <>
      {isValidElement(trigger) ? (
        <Slot
          ref={anchor.attach}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen(!open)}
        >
          {trigger}
        </Slot>
      ) : (
        trigger
      )}

      {mounted && (
        <Portal container={container}>
          {/* The REQUESTED placement, as distinct from the `data-side` the
           * positioning hook writes once it has measured. The hook writes after
           * the element has already had its first style computed, which is the
           * moment `@starting-style` is consumed, so the entrance vector in the
           * stylesheet has to be keyed on something React renders. */}
          <div
            ref={floating.attach}
            className="tl-popover"
            data-state={status}
            data-placement={placement}
          >
            <div
              {...rest}
              ref={composeRefs(ref, panel.attach)}
              id={panelId}
              role="dialog"
              tabIndex={-1}
              data-tl="popover"
              data-state={status}
              className={cx('tl-popover__panel', className)}
            >
              {children}
            </div>
            {arrow && <span className="tl-popover__arrow" aria-hidden="true" />}
          </div>
        </Portal>
      )}
    </>
  )
})
