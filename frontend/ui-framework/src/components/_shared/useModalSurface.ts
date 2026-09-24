import { useEffect, type RefObject } from 'react'
import { useDismiss } from '../../hooks/useDismiss'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useScrollLock } from '../../hooks/useScrollLock'
import { usePresence, type Presence } from './usePresence'

/* ---------------------------------------------------------------------------
 * BACKGROUND INERTNESS
 *
 * A focus trap is not enough to make a dialog modal. It intercepts Tab, which
 * covers a sighted keyboard user, and it does nothing at all for a screen
 * reader: the virtual cursor moves through the accessibility tree, not the tab
 * order, so a NVDA or VoiceOver user reading with arrow keys walks straight out
 * of the dialog and into the page behind it — where they find controls that
 * appear operable and, since the scrim swallows the clicks, are not.
 *
 * `inert` is the fix, because it removes a subtree from the tab order, from hit
 * testing and from the accessibility tree in one attribute. Where it is not
 * supported, `aria-hidden` restores the screen-reader half and the focus trap
 * continues to carry the keyboard half.
 *
 * Marks are reference counted per element. Two stacked dialogs both inert the
 * application root; without a count, closing the inner one would hand the page
 * back to a user who is still looking at the outer one.
 * ------------------------------------------------------------------------- */

interface InertMark {
  count: number
  hadInert: boolean
  previousAriaHidden: string | null
}

const marks = new WeakMap<Element, InertMark>()

/** Elements that render nothing, so marking them is noise in the inspector. */
const UNRENDERED = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE', 'META', 'HEAD'])

function supportsInert(): boolean {
  return typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype
}

function mark(element: Element): void {
  const existing = marks.get(element)
  if (existing) {
    existing.count += 1
    return
  }
  marks.set(element, {
    count: 1,
    hadInert: element.hasAttribute('inert'),
    previousAriaHidden: element.getAttribute('aria-hidden'),
  })
  if (supportsInert()) {
    element.setAttribute('inert', '')
  } else {
    element.setAttribute('aria-hidden', 'true')
  }
}

function unmark(element: Element): void {
  const existing = marks.get(element)
  if (!existing) return
  existing.count -= 1
  if (existing.count > 0) return
  marks.delete(element)
  if (!existing.hadInert) element.removeAttribute('inert')
  if (existing.previousAriaHidden === null) {
    element.removeAttribute('aria-hidden')
  } else {
    element.setAttribute('aria-hidden', existing.previousAriaHidden)
  }
}

function useInertBackground(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    const marked: Element[] = []
    let current: Element | null = node
    // Walk to <body>, marking everything that is not on the path from the
    // overlay up. Sibling-by-sibling rather than "everything except body's
    // children" so an overlay portalled into a nested container still works.
    while (current && current !== document.body) {
      const parent: HTMLElement | null = current.parentElement
      if (!parent) break
      for (const sibling of parent.children) {
        if (sibling === current || UNRENDERED.has(sibling.tagName)) continue
        mark(sibling)
        marked.push(sibling)
      }
      current = parent
    }

    return () => {
      for (const element of marked) unmark(element)
    }
  }, [active, ref])
}

export interface UseModalSurfaceOptions {
  open: boolean
  /** The portalled wrapper. Everything beside it on the way to <body> is inerted. */
  rootRef: RefObject<HTMLElement | null>
  /** The transitioning, focus-trapped surface. */
  panelRef: RefObject<HTMLElement | null>
  /**
   * Whether both nodes are in the document. Portal mounts a render late, so an
   * effect that fires on `open` alone would read null refs and give up.
   */
  attached: boolean
  onDismiss: () => void
  initialFocus?: RefObject<HTMLElement | null>
  restoreFocus?: boolean
  dismissOnOutsidePress?: boolean
  dismissOnEscape?: boolean
}

/**
 * Everything Dialog and Drawer need to be modal, in the order they need it.
 *
 * The hook order below is load bearing and is the reason this is one hook
 * rather than five calls copied into two components. React runs the cleanups of
 * a commit in the order the effects were declared, so `useInertBackground` must
 * come before `useFocusTrap`: on close the background has to stop being inert
 * *before* the trap tries to hand focus back, because `focus()` on an element
 * inside an inert subtree is silently ignored and the user is dropped onto
 * <body> with no way back to where they were.
 *
 * The two flags are also deliberately different. Inertness is released as soon
 * as `open` goes false — the overlay is on its way out and there is no reason to
 * keep the page unreachable through the exit animation — while the scroll lock
 * is held until the node actually unmounts, because releasing it early restores
 * the scrollbar and jerks the page sideways underneath a panel that is still
 * visibly fading.
 */
export function useModalSurface({
  open,
  rootRef,
  panelRef,
  attached,
  onDismiss,
  initialFocus,
  restoreFocus = true,
  dismissOnOutsidePress = true,
  dismissOnEscape = true,
}: UseModalSurfaceOptions): Presence {
  const presence = usePresence(open, panelRef)
  const active = open && presence.mounted && attached

  useScrollLock(presence.mounted)
  useInertBackground(active, rootRef)
  useFocusTrap({ enabled: active, ref: panelRef, initialFocus, restoreFocus })
  useDismiss({
    enabled: active,
    ref: panelRef,
    onDismiss,
    onPointerDownOutside: dismissOnOutsidePress,
    onEscapeKey: dismissOnEscape,
  })

  return presence
}
