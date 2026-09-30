import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useEventCallback } from './useEventCallback'
import { useReducedMotion } from './useReducedMotion'

/** How long an item takes to move to its new place. */
export const FLIP_MOVE_MS = 460
/** How long an item that has gone takes to fade out where it was. */
export const FLIP_LEAVE_MS = 220
/** Items that come into view wait this long, so the moves are seen to begin first. */
export const FLIP_ARRIVE_AFTER_MS = 140

/** The signature curve: fast away, a long gentle settle. */
const MOVE_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const SELECTOR = '[data-tl-flip]'

interface Seen {
  rect: DOMRect
  visible: boolean
  /** A copy of the item as it looked, to stand in for it if it goes. */
  copy: HTMLElement | null
  parent: Element | null
}

/** The part of the page `root` shows: its own box, cut to the viewport. */
function visibleArea(root: HTMLElement) {
  const box = root.getBoundingClientRect()
  return {
    left: Math.max(box.left, 0),
    top: Math.max(box.top, 0),
    right: Math.min(box.right, window.innerWidth),
    bottom: Math.min(box.bottom, window.innerHeight),
  }
}

const overlaps = (rect: DOMRect, area: ReturnType<typeof visibleArea>) =>
  rect.right > area.left && rect.left < area.right && rect.bottom > area.top && rect.top < area.bottom

/**
 * Items that rearrange themselves — a list refiltered, re-sorted, laid out
 * another way — move to their new places instead of jumping there.
 *
 * Mark each item with `data-tl-flip` set to a key that stays with it (an id),
 * and pass an element that contains them all, ideally the box that scrolls
 * them. Call `capture()` just before the change — in the handler that makes
 * it — and the hook plays it as the change is committed:
 *
 * - an item that was in view and still exists slides from where it was to
 *   where it is now, on the signature curve;
 * - an item that was in view and is gone fades out where it was, a copy of it
 *   standing in (inert, hidden from assistive technology) while it does;
 * - an item that was not in view before and is now — new, or brought up from
 *   below the fold — makes a fresh entrance: it is handed back to
 *   useRevealOnView (it should carry `data-tl-reveal`), so it fades in after
 *   the others have begun to move, one after another, as a newly loaded item
 *   would.
 *
 * Anything that happens in a layout effect declared before this hook — say,
 * scrolling the list back to its top — has happened by the time the new
 * places are measured. Under reduced motion nothing moves; items simply are
 * where they are.
 */
export function useFlip(root: RefObject<HTMLElement | null>) {
  const reduced = useReducedMotion()
  const seen = useRef<Map<string, Seen> | null>(null)

  const capture = useEventCallback(() => {
    const container = root.current
    if (!container || reduced) return
    const area = visibleArea(container)
    const map = new Map<string, Seen>()
    container.querySelectorAll<HTMLElement>(SELECTOR).forEach((item) => {
      const key = item.dataset.tlFlip
      if (!key) return
      const rect = item.getBoundingClientRect()
      const visible = overlaps(rect, area)
      map.set(key, { rect, visible, copy: visible ? (item.cloneNode(true) as HTMLElement) : null, parent: item.parentElement })
    })
    seen.current = map
  })

  // Every commit: if a change was captured, play it. Runs after the layout
  // effects of the component that owns the items, declared before it.
  useLayoutEffect(() => {
    const before = seen.current
    const container = root.current
    if (!before || !container) return
    seen.current = null
    if (typeof Element.prototype.animate !== 'function') return
    const area = visibleArea(container)
    const present = new Set<string>()

    container.querySelectorAll<HTMLElement>(SELECTOR).forEach((item) => {
      const key = item.dataset.tlFlip
      if (!key) return
      present.add(key)
      const was = before.get(key)
      const rect = item.getBoundingClientRect()
      if (was?.visible) {
        const dx = was.rect.left - rect.left
        const dy = was.rect.top - rect.top
        if (Math.abs(dx) + Math.abs(dy) < 0.5) return
        item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: FLIP_MOVE_MS, easing: MOVE_EASING })
      } else if (overlaps(rect, area) && item.hasAttribute('data-tl-reveal')) {
        // A fresh entrance, behind the moves.
        item.style.setProperty('--tl-reveal-after', `${FLIP_ARRIVE_AFTER_MS}ms`)
        item.dataset.tlReveal = ''
      }
    })

    // What has gone fades out where it was.
    before.forEach((was, key) => {
      if (present.has(key) || !was.copy) return
      const host = was.parent?.isConnected ? was.parent : container
      const copy = was.copy
      copy.removeAttribute('data-tl-flip')
      copy.removeAttribute('data-tl-reveal')
      copy.removeAttribute('id')
      copy.setAttribute('aria-hidden', 'true')
      copy.inert = true
      Object.assign(copy.style, {
        position: 'absolute', left: '0px', top: '0px', margin: '0px',
        width: `${was.rect.width}px`, height: `${was.rect.height}px`,
        pointerEvents: 'none', zIndex: '0',
      })
      host.appendChild(copy)
      const at = copy.getBoundingClientRect()
      copy.style.translate = `${was.rect.left - at.left}px ${was.rect.top - at.top}px`
      const leaving = copy.animate(
        [{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.94 }],
        { duration: FLIP_LEAVE_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
      )
      leaving.finished.then(() => copy.remove(), () => copy.remove())
    })
  })

  return { capture }
}
