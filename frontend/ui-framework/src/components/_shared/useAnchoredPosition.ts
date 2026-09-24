import { useEffect, useLayoutEffect } from 'react'
import { useEventCallback } from '../../hooks/useEventCallback'
import { computePosition, type Placement } from './position'

// Calling useLayoutEffect during a server render logs a warning even when the
// body would bail out immediately, and every floating component calls this hook
// unconditionally. Positioning genuinely must happen before paint on the client,
// so the effect is swapped rather than downgraded everywhere.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

export interface UseAnchoredPositionOptions {
  /** The trigger. Null until it is in the document. */
  anchor: HTMLElement | null
  /** The positioner that carries `--_x` / `--_y`. Null until portalled. */
  floating: HTMLElement | null
  placement?: Placement
  offset?: number
  padding?: number
  /** Called once the anchor has scrolled out of the viewport. */
  onAnchorHidden?: () => void
}

/**
 * Measures, positions and keeps a floating surface attached to its anchor.
 *
 * The elements are passed as values rather than as refs on purpose: a portalled
 * panel is not in the document on the commit that opened it, so an effect
 * depending on a ref object would run once against `null` and never run again.
 * Depending on the nodes makes their arrival the thing that starts the work.
 *
 * The result is written straight to the DOM as custom properties and data
 * attributes rather than being pushed through React state. Scrolling a long
 * page with a popover open produces a position update every frame, and routing
 * each one through a render means reconciling the entire panel subtree sixty
 * times a second to move one box — the visible symptom is a panel that lags a
 * few pixels behind its trigger.
 *
 * The corollary a reader needs to know: `data-side` and `data-align` are set
 * imperatively and must never also appear in the component's JSX. React leaves
 * attributes it did not itself set alone, but the moment a render declares
 * `data-side` it takes ownership and will fight this hook on every commit.
 *
 * Scroll is observed in the capture phase because `scroll` does not bubble.
 * Listening on `window` alone catches the document scrolling but not the
 * overflow container the trigger actually lives in, which is the common case in
 * a dense table.
 */
export function useAnchoredPosition({
  anchor,
  floating,
  placement = 'bottom',
  offset = 8,
  padding = 8,
  onAnchorHidden,
}: UseAnchoredPositionOptions): void {
  const anchorHidden = useEventCallback(onAnchorHidden)

  useIsomorphicLayoutEffect(() => {
    if (!anchor || !floating) return

    let frame = 0

    const update = () => {
      frame = 0
      const result = computePosition({
        anchor: anchor.getBoundingClientRect(),
        // offsetWidth/offsetHeight, not the bounding rect: the surface is being
        // scaled by its entrance transition, and a rect reports the *visual*
        // box, so measuring mid-animation would place a panel that is 4% too
        // small and then never correct itself once the transition settles.
        //
        // The compiler treats `floating` as immutable and objects to this line
        // because the same element is written to a few lines below. Writing to
        // the DOM from a layout effect is the entire job of this hook — there is
        // no declarative way to position an element against a rect that only
        // exists after paint.
        // eslint-disable-next-line react-hooks/immutability
        floating: { width: floating.offsetWidth, height: floating.offsetHeight },
        placement,
        offset,
        padding,
      })

      floating.style.setProperty('--_x', `${result.x}px`)
      floating.style.setProperty('--_y', `${result.y}px`)
      floating.style.setProperty('--_arrow-x', `${result.arrowX}px`)
      floating.style.setProperty('--_arrow-y', `${result.arrowY}px`)
      floating.style.setProperty('--_available-width', `${result.availableWidth}px`)
      floating.style.setProperty('--_available-height', `${result.availableHeight}px`)
      floating.dataset.side = result.side
      floating.dataset.align = result.align

      if (result.anchorHidden) anchorHidden()
    }

    // Coalesced to one write per frame. A trackpad can emit several scroll
    // events between paints, and each one would otherwise force a synchronous
    // layout to read the anchor rect back.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }

    update()

    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    // Content that grows — a menu filtering, a popover loading — moves the
    // surface's edges without any scroll or resize event to notice it. Guarded
    // because jsdom has no ResizeObserver, and a component that throws on
    // import in a test environment is a component nobody writes tests for.
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(anchor)
      observer.observe(floating)
    }

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [anchor, floating, placement, offset, padding, anchorHidden])
}
