/* ---------------------------------------------------------------------------
 * THE IRIS
 *
 * A round opening that widens or narrows around one point, as the old film
 * wipe does. Two forms:
 *
 * iris(element, …) cuts the opening into an element laid over the page — a
 * cover — and moves its radius through the stops it is given. Widening it
 * uncovers what lies beneath from that point outward; narrowing it covers the
 * page from the edges in, closing on the point. Between stops the radius
 * follows each stop's own curve, so an opening can pause, creep and burst.
 *
 * irisTransition(update, …) swaps the page itself for what `update` makes of
 * it — a new colour theme, say: the new state opens as a circle from the
 * point over the old one, which stays exactly as it was until the circle has
 * passed. It is a view transition; where the browser has none, or the user
 * has asked for reduced motion, the update simply happens.
 *
 * Both have the same soft edge, IRIS_EDGE wide, so an opening never reads as
 * a hard cut.
 * ------------------------------------------------------------------------- */
import './Iris.css'

/** The width of the opening's soft edge, in px. */
export const IRIS_EDGE = 24
/** How long a swapped page takes to open over the old one. */
export const IRIS_TRANSITION_MS = 620

export interface IrisStop {
  /** Radius in px, or 'cover': wide enough to clear the element's farthest corner. */
  radius: number | 'cover'
  /** When the radius is reached, in ms from the start. */
  at: number
  /** The curve from this stop to the next. Linear by default. */
  easing?: string
}

export interface IrisOptions {
  /** The centre, in viewport px. */
  x: number
  y: number
  /** The radius over time, first stop at 0 ms. */
  stops: readonly IrisStop[]
}

/** The distance from a point to the farthest corner of a box, plus the soft edge. */
function coverRadius(x: number, y: number, box: { left: number; top: number; right: number; bottom: number }) {
  const corners: [number, number][] = [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]]
  return Math.max(...corners.map(([cx, cy]) => Math.hypot(cx - x, cy - y))) + IRIS_EDGE
}

/**
 * Cuts a round opening into `element` around a point and moves its radius
 * through `stops`. The element keeps the opening where the last stop leaves
 * it until the animation is cancelled. Returns the animation, or null where
 * the element cannot be animated (the opening is then simply at its last stop).
 */
export function iris(element: HTMLElement, { x, y, stops }: IrisOptions): Animation | null {
  const box = element.getBoundingClientRect()
  const far = coverRadius(x, y, box)
  const px = (stop: IrisStop) => `${stop.radius === 'cover' ? far : stop.radius}px`
  element.classList.add('tl-iris')
  element.style.setProperty('--tl-iris-x', `${x - box.left}px`)
  element.style.setProperty('--tl-iris-y', `${y - box.top}px`)
  const last = stops[stops.length - 1]
  if (!last) return null
  if (typeof element.animate !== 'function' || last.at <= 0) {
    element.style.setProperty('--tl-iris-radius', px(last))
    return null
  }
  return element.animate(
    stops.map((stop) => ({ '--tl-iris-radius': px(stop), offset: stop.at / last.at, easing: stop.easing ?? 'linear' })),
    { duration: last.at, fill: 'both' },
  )
}

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { ready: Promise<void>; finished: Promise<void> }
}

export interface IrisTransitionOptions {
  /** Where the new state opens from, in viewport px. */
  x: number
  y: number
  /** Milliseconds for the circle to clear the viewport. */
  duration?: number
  /** Answers at once, is quickest early on, and eases out past the farthest corner. */
  easing?: string
}

/**
 * Swaps the page for what `update` makes of it, the new state opening as a
 * circle from a point. `update` must apply the change to the DOM before it
 * returns (or before the promise it returns settles) — in React, wrap the
 * state change in flushSync. Resolves once the swap is over.
 */
export function irisTransition(
  update: () => void | Promise<void>,
  { x, y, duration = IRIS_TRANSITION_MS, easing = 'cubic-bezier(0.45, 0, 0.2, 1)' }: IrisTransitionOptions,
): Promise<void> {
  const doc = document as TransitionDocument
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!doc.startViewTransition || reduced) return Promise.resolve(update())
  const root = document.documentElement
  const far = coverRadius(x, y, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })
  root.dataset.tlIris = ''
  root.style.setProperty('--tl-iris-x', `${x}px`)
  root.style.setProperty('--tl-iris-y', `${y}px`)
  const transition = doc.startViewTransition(update)
  // Held open at the end: the transition is torn down only after its last
  // animation has finished, and a radius back at zero for that moment would
  // flash the old state over the new.
  transition.ready.then(
    () => { root.animate({ '--tl-iris-radius': ['0px', `${far}px`] }, { duration, easing, fill: 'forwards', pseudoElement: '::view-transition-new(root)' }) },
    () => {},
  )
  return transition.finished.finally(() => {
    delete root.dataset.tlIris
    root.style.removeProperty('--tl-iris-x')
    root.style.removeProperty('--tl-iris-y')
  })
}
