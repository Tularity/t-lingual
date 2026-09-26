import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { composeRefs } from '../../primitives/Slot'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { CollapseMark } from '../CollapseMark/CollapseMark'
import './LoadingState.css'

/** A wait that settles sooner than this shows nothing at all. */
export const LOADING_STATE_DELAY = 180
/**
 * Seconds per sequence while waiting: the collapse at two and a half times its
 * own leisurely pace, which is the speed it reads best at as a loader — the
 * pieces are arriving within a frame or two of the plate appearing.
 */
export const LOADING_STATE_SECONDS = 4.8
/**
 * The plate's wind-up before it leaves: a small dip, as if drawn back. It
 * starts briskly and slows right down, so its last stretch barely moves —
 * the brief pause before the release is the tail of the curve, not a stop.
 * Kept short: content that has arrived should not be held back for long.
 */
export const LOADING_STATE_WINDUP = 210
/** Then it is flung outward — fast, then easing — blurring as it fades. */
export const LOADING_STATE_POP = 380
/** The content's fade in, from the release: slow enough to be seen as one. */
export const LOADING_STATE_ARRIVAL = 480
/**
 * Drawn back on a cubic ease-out: visibly decelerating for most of the
 * wind-up and still only for its last ~50 ms. (The signature curve's tail is
 * too long for a phase this short — it reads as a jolt and then a dead stop.)
 */
const DRAW_BACK = 'cubic-bezier(0.33, 1, 0.68, 1)'
/** Released on a quartic ease-out: a fast burst that eases into the fade. */
const RELEASE = 'cubic-bezier(0.25, 1, 0.5, 1)'

/* Every LoadingState that is still waiting, anywhere on the page. Counted in a
 * layout effect, so a page that has just mounted with its waits is counted in
 * the very commit it appears in, before anything asks. */
const waiting = new Set<symbol>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const settled = () => waiting.size === 0

/**
 * Whether every loading state on the page has its content. For a transition
 * that should not reveal a page until the page has something to show.
 */
export function useLoadsSettled(): boolean {
  return useSyncExternalStore(subscribe, settled, settled)
}

/** Where the plate's exit cannot be animated it is simply removed. */
const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'

export interface LoadingStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** What is being waited for: announced, and written under the logo. */
  label: string
  /**
   * Whether the content is still on its way. While it is, the plate shows;
   * once it is not, `children` render and the plate leaves over them.
   * Defaults to true, for a wait with nothing to show afterwards.
   */
  loading?: boolean
  /** The content, rendered once `loading` is false. */
  children?: ReactNode
  /** Width of the logo in px; the plate is sized around it. */
  size?: number
  /** Fill the parent's height, for a whole page waiting, instead of a panel's minimum. */
  fill?: boolean
  /** Shown instead of the animation under reduced motion. Pass the static logo. */
  still?: ReactNode
}

/**
 * An area whose content is still arriving, and the moment it arrives.
 *
 * While waiting it shows a translucent rounded plate holding the logo's
 * collapse, looping, with what is being loaded written beneath — after a
 * moment, so the many waits that end at once never flash. When the content
 * arrives the plate takes its leave in one gesture of its own: it dips a
 * little, as though drawn back, slowing almost to a stop, then is flung
 * outward — fast, then easing — blurring and fading, still animating as it
 * goes. The content does not come out of it;
 * it simply fades in underneath, starting the instant the plate is flung.
 * A wait that ended before the plate appeared just shows the content.
 *
 * The same element holds the plate and then the content, so a component that
 * returns `<LoadingState loading />` early and `<LoadingState loading={false}>
 * …</LoadingState>` later keeps one instance across the two — which is what
 * lets the plate that was showing play its exit over what arrived.
 *
 * Waits inside a control — a button that is busy, "load more" — belong to the
 * compact mark instead (Spinner, Button `loading`).
 */
export const LoadingState = forwardRef<HTMLDivElement, LoadingStateProps>(function LoadingState(
  { label, loading = true, children, size = 160, fill = false, still, className, style, ...rest },
  ref,
) {
  const reduced = useReducedMotion()
  const root = useRef<HTMLDivElement>(null)
  const plate = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const setRefs = useMemo(() => composeRefs<HTMLDivElement>(ref, root), [ref])

  // Each wait is numbered, so a wait that starts again starts hidden again.
  const [wait, setWait] = useState(loading ? 1 : 0)
  const [shownWait, setShownWait] = useState(0)
  const [leavingWait, setLeavingWait] = useState(0)
  const [wasLoading, setWasLoading] = useState(loading)
  if (wasLoading !== loading) {
    setWasLoading(loading)
    if (loading) setWait(wait + 1)
    // The content has arrived where a plate was showing: it plays its exit.
    else if (shownWait === wait && !reduced && canAnimate) setLeavingWait(wait)
  }
  useLayoutEffect(() => {
    if (!loading) return
    const token = Symbol('loading')
    waiting.add(token)
    notify()
    return () => {
      waiting.delete(token)
      notify()
    }
  }, [loading])
  const shown = loading && shownWait === wait
  const leaving = !loading && leavingWait !== 0 && leavingWait === wait
  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => setShownWait(wait), LOADING_STATE_DELAY)
    return () => window.clearTimeout(timer)
  }, [loading, wait])

  /** Where the plate sits, relative to this element, so it can stay put as it leaves. */
  const last = useRef<{ x: number; y: number; w: number } | null>(null)
  useLayoutEffect(() => {
    if (!shown || !plate.current || !root.current) return
    const outer = root.current.getBoundingClientRect()
    const box = plate.current.getBoundingClientRect()
    last.current = { x: box.left - outer.left, y: box.top - outer.top, w: box.width }
  })

  useLayoutEffect(() => {
    const node = plate.current
    const from = last.current
    if (!leaving || !node || !from || !content.current) return
    // Pinned where it sat, while the content lays itself out underneath.
    Object.assign(node.style, { position: 'absolute', left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, margin: '0' })
    const total = LOADING_STATE_WINDUP + LOADING_STATE_POP
    const release = LOADING_STATE_WINDUP / total
    // Size and fade run on separate curves. The size is drawn back, slowing
    // to a near-standstill, then released fast and easing out. The fade and blur wait out the wind-up and then
    // ease in and out across the fling, so the burst is seen before it
    // dissolves.
    const flung = node.animate(
      [
        { transform: 'scale(1)', easing: DRAW_BACK },
        { transform: 'scale(0.92)', offset: release, easing: RELEASE },
        { transform: 'scale(1.8)' },
      ],
      { duration: total, fill: 'forwards' },
    )
    const dissolves = node.animate(
      [
        { opacity: 1, filter: 'blur(0px)' },
        { opacity: 1, filter: 'blur(0px)', offset: release, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
        { opacity: 0, filter: 'blur(16px)' },
      ],
      { duration: total, fill: 'forwards' },
    )
    // Content that stages its own entrance item by item (useRevealOnView) is
    // only held until the release; anything else fades in as one.
    const body = content.current
    const staged = body.querySelector('[data-tl-reveal]') !== null
    if (staged) body.style.setProperty('--tl-reveal-after', `${LOADING_STATE_WINDUP}ms`)
    const arrives = staged
      ? null
      : body.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: LOADING_STATE_ARRIVAL,
          delay: LOADING_STATE_WINDUP,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          fill: 'backwards',
        })
    let live = true
    flung.finished.then(() => { if (live) setLeavingWait(0) }, () => {})
    return () => {
      live = false
      flung.cancel()
      dissolves.cancel()
      arrives?.cancel()
      body.style.removeProperty('--tl-reveal-after')
    }
  }, [leaving])

  return (
    <div
      {...rest}
      ref={setRefs}
      // Only the wait is a status region; the content it becomes is not.
      role={loading ? 'status' : undefined}
      aria-label={loading ? label : undefined}
      data-tl="loading-state"
      data-state={loading ? 'loading' : 'loaded'}
      data-fill={fill || undefined}
      className={cx('tl-loading-state', className)}
      style={{ '--_size': `${size}px`, ...style } as CSSProperties}
    >
      {!loading && (
        <div ref={content} className="tl-loading-state__content">
          {children}
        </div>
      )}
      {/* Second in the tree either way, so the plate showing during the wait
        * is the very element that leaves, its animation uninterrupted. */}
      {(shown || leaving) && (
        <div ref={plate} className="tl-loading-state__plate" data-leaving={leaving || undefined}>
          <CollapseMark className="tl-loading-state__mark" duration={LOADING_STATE_SECONDS} still={still} />
          <p className="tl-loading-state__label" aria-hidden="true">
            {label}
          </p>
        </div>
      )}
    </div>
  )
})
