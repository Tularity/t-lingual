import { useLayoutEffect, type RefObject } from 'react'

/** Time between one item's entrance and the next. */
export const REVEAL_STEP = 55
/** The longest any item waits for its turn, however many arrive at once. */
export const REVEAL_MAX_WAIT = 480

const SELECTOR = '[data-tl-reveal]'

/* Entrances can be held, page-wide, while what they belong to is covered —
 * a list loaded behind a transition would otherwise play them unseen. */
let holds = 0
const RELEASE = 'tl-reveal-release'

/** Holds every entrance until the matching releaseReveals(). */
export function holdReveals() {
  holds += 1
}

/** Releases a hold; entrances waiting in view then play. */
export function releaseReveals() {
  holds = Math.max(0, holds - 1)
  if (holds === 0 && typeof document !== 'undefined') document.dispatchEvent(new Event(RELEASE))
}

/**
 * Items fade in as they come into view, one after another.
 *
 * Mark each item with `data-tl-reveal` (any value, or none) and pass an
 * element that contains them all.
 * Items already on screen enter at once, in document order; items below the
 * fold wait, unseen, and make the same entrance when they are scrolled to;
 * items added later — another batch, a new filter — are picked up the same
 * way, and so is an item whose `data-tl-reveal` is set back to empty. Every entrance is queued behind the one before it, so the order holds
 * across batches and scrolls, while no item ever waits longer than
 * REVEAL_MAX_WAIT for its turn.
 *
 * A container can hold every entrance back until a moment of its own by
 * setting `--tl-reveal-after` (a time) on an ancestor of the items; the
 * loading state does this so a list starts arriving as its plate is released.
 *
 * holdReveals() keeps every entrance waiting while the page is covered, and
 * releaseReveals() lets the ones in view play.
 *
 * Without IntersectionObserver (a test DOM, an old engine) nothing is hidden.
 */
export function useRevealOnView(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const container = root.current
    if (!container || typeof IntersectionObserver === 'undefined') return
    let queue = 0

    const observer = new IntersectionObserver(
      (entries) => {
        if (holds > 0) return
        const arriving = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target as HTMLElement)
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        if (!arriving.length) return
        const now = performance.now()
        const after = parseFloat(getComputedStyle(arriving[0]).getPropertyValue('--tl-reveal-after')) || 0
        queue = Math.max(queue, now + after)
        for (const item of arriving) {
          const wait = Math.min(queue - now, REVEAL_MAX_WAIT + after)
          item.style.setProperty('--tl-reveal-wait', `${Math.round(wait)}ms`)
          item.dataset.tlReveal = 'shown'
          observer.unobserve(item)
          queue = now + wait + REVEAL_STEP
        }
      },
      // The viewport, whatever scrolls: an item's visible area is clipped by
      // every scrolling ancestor on the way, so a list in its own scroll box
      // is judged by what can actually be seen of it.
      { root: null },
    )

    // Marked before the first paint, so nothing flashes and then hides.
    const track = (item: Element) => {
      if (!(item instanceof HTMLElement) || item.dataset.tlReveal === 'shown' || item.dataset.tlReveal === 'pending') return
      item.dataset.tlReveal = 'pending'
      observer.observe(item)
    }
    // Items still waiting from an earlier run of this effect (a remount, a
    // new root) wait on this observer now.
    container.querySelectorAll<HTMLElement>('[data-tl-reveal="pending"]').forEach((item) => observer.observe(item))
    container.querySelectorAll(SELECTOR).forEach(track)
    // Items added later are picked up; so is an item whose mark is set back
    // to empty, which asks for a fresh entrance (useFlip does this for an
    // item brought into view by a rearrangement).
    const additions = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLElement && record.target.dataset.tlReveal === '') track(record.target)
          continue
        }
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return
          if (node.matches(SELECTOR)) track(node)
          node.querySelectorAll(SELECTOR).forEach(track)
        })
      }
    })
    additions.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tl-reveal'] })

    // Released: look again at everything still waiting, which reports what
    // is in view afresh.
    const release = () => {
      container.querySelectorAll<HTMLElement>('[data-tl-reveal="pending"]').forEach((item) => {
        observer.unobserve(item)
        observer.observe(item)
      })
    }
    document.addEventListener(RELEASE, release)

    return () => {
      document.removeEventListener(RELEASE, release)
      additions.disconnect()
      observer.disconnect()
    }
  }, [root])
}
