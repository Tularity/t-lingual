import { useEffect, useState, type RefObject } from 'react'

/**
 * Reports whether a region currently overflows.
 *
 * Dialog and Drawer use it to decide whether their body needs `tabindex="0"`.
 * A scroll container that holds no focusable element cannot be scrolled from
 * the keyboard at all — there is nothing to press the arrow keys against — so a
 * long block of terms and conditions inside a dialog is simply unreadable
 * without a mouse (WCAG 2.1.1). The tab stop is added only when it is needed,
 * because an unconditional one is an extra empty stop on every short dialog.
 */
export function useScrollableRegion(ref: RefObject<HTMLElement | null>): boolean {
  const [scrollable, setScrollable] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    // A pixel of tolerance: fractional layout sizes make scrollHeight exceed
    // clientHeight by a hair on plenty of otherwise unscrollable regions.
    const measure = () => setScrollable(node.scrollHeight > node.clientHeight + 1)
    measure()

    // Guarded: jsdom has no ResizeObserver, and the one-shot measurement above
    // is still correct without it.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    // The container's own size does not change when its contents grow, so the
    // content has to be watched as well for the late-loading-image case.
    for (const child of node.children) observer.observe(child)

    return () => observer.disconnect()
  }, [ref])

  return scrollable
}
