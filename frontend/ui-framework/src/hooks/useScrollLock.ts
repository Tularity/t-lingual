import { useEffect } from 'react'

// Nested overlays must not each restore the body on their own way out: the
// inner one closing would unlock the page while the outer one is still open.
// A module-level count makes the lock reference-counted instead.
let locks = 0
let restore: (() => void) | null = null

/**
 * Prevents the page behind an overlay from scrolling.
 *
 * Two details that are easy to get wrong and very visible when you do:
 *
 * 1. Setting `overflow: hidden` on <body> removes the scrollbar, which widens
 *    the viewport and shifts the entire page left by ~15px the instant a
 *    dialog opens. Compensating with padding equal to the scrollbar width
 *    keeps the layout still. `position: fixed` is not used because it destroys
 *    the scroll position on unlock and breaks anchor links.
 *
 * 2. iOS Safari ignores `overflow: hidden` on <body> for touch scrolling, so
 *    `overscroll-behavior` is set as well; it is what stops the rubber-band
 *    from dragging the page behind a sheet.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return

    locks += 1
    if (locks === 1) {
      const body = document.body
      const previousOverflow = body.style.overflow
      const previousPadding = body.style.paddingRight
      const previousOverscroll = body.style.overscrollBehavior
      const gutter = window.innerWidth - document.documentElement.clientWidth

      body.style.overflow = 'hidden'
      body.style.overscrollBehavior = 'none'
      if (gutter > 0) {
        const current = Number.parseFloat(getComputedStyle(body).paddingRight) || 0
        body.style.paddingRight = `${current + gutter}px`
      }

      restore = () => {
        body.style.overflow = previousOverflow
        body.style.paddingRight = previousPadding
        body.style.overscrollBehavior = previousOverscroll
      }
    }

    return () => {
      locks -= 1
      if (locks === 0) {
        restore?.()
        restore = null
      }
    }
  }, [active])
}
