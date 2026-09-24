import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type Ref,
} from 'react'
import { cx } from '../../utils/cx'
import { useEventCallback } from '../../hooks/useEventCallback'
import './ScrollArea.css'

export interface ScrollAreaEdges {
  /** There is content hidden above the top edge. */
  top: boolean
  /** There is content hidden below the bottom edge. */
  bottom: boolean
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** Height cap for the scroller. A bare number is read as pixels. */
  maxHeight?: number | string
  /** Draw the built-in edge shadows. Off by default. */
  shadows?: boolean
  /**
   * Makes the scroller a tab stop so it can be scrolled from the keyboard.
   * On by default; see the note on why.
   */
  focusable?: boolean
  /** Reaches the scrolling element itself — what you need to pin to the bottom. */
  viewportRef?: Ref<HTMLDivElement>
  /** Fired only when an edge actually flips, never per scroll event. */
  onEdgesChange?: (edges: ScrollAreaEdges) => void
}

function toLength(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * A bounded scrolling region that tells its consumer where its edges are.
 *
 * `data-scrolled-top` and `data-scrolled-bottom` land on the root, and each one
 * means "there is content hidden past this edge" — the signal a fade or a shadow
 * needs, and the signal that is wrong if you compute it from `scrollTop` alone
 * without accounting for the container's own height.
 *
 * WHY THE ATTRIBUTES ARE WRITTEN BY HAND
 * --------------------------------------
 * They are set with `toggleAttribute` on the DOM node rather than rendered from
 * state, and this is the central decision in the file. A live transcript pane is
 * the worst case this component exists for: it scrolls continuously while new
 * lines arrive, and routing an edge flag through `setState` re-renders the pane
 * and every message in it on the way to changing one attribute that only CSS
 * ever reads. Writing the attribute directly costs a style invalidation on the
 * root and nothing else. React never renders these attributes, so it has no
 * opinion about them and will not clobber them. Consumers who need the value in
 * JavaScript get `onEdgesChange`, which fires on a transition rather than on a
 * scroll.
 *
 * The scroll listener is passive — a non-passive listener on a scroller blocks
 * the compositor until the handler returns, which is how a scroll starts to feel
 * heavy — and every read is coalesced into one `requestAnimationFrame`, so a
 * flick that fires forty scroll events measures once per frame instead.
 * `ResizeObserver` watches both the viewport and the content, because those
 * change independently: the viewport when the surrounding layout moves, the
 * content when a line of transcript arrives. Without the second one the bottom
 * edge flag goes stale the moment the pane grows.
 *
 * KEYBOARD
 * --------
 * `focusable` defaults to true. A region that scrolls but cannot be focused is a
 * WCAG 2.1.1 failure whenever its content is not itself focusable, which is
 * exactly the transcript case; Chrome and Firefox now focus such scrollers
 * automatically but Safari does not, so the framework does not rely on it. A tab
 * stop with no name is its own problem, so a scroller that is focusable and
 * unnamed reports an error in development. Pass `focusable={false}` for a
 * scroller whose content is entirely made of focusable controls — there the tab
 * stop is redundant and the arrow keys already work.
 */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    maxHeight,
    shadows = false,
    focusable = true,
    viewportRef,
    onEdgesChange,
    onScroll,
    className,
    style,
    children,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    ...rest
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportNodeRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const edgesRef = useRef<ScrollAreaEdges>({ top: false, bottom: false })

  const emitEdgesChange = useEventCallback(onEdgesChange)

  if (import.meta.env?.DEV && focusable && !ariaLabel && !ariaLabelledBy) {
    console.error(
      '[t-lingual/ui] <ScrollArea> is a tab stop and needs `aria-label` or `aria-labelledby`, ' +
        'or `focusable={false}` if its content is already reachable from the keyboard.',
    )
  }

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  const setViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewportNodeRef.current = node
      if (typeof viewportRef === 'function') viewportRef(node)
      else if (viewportRef) (viewportRef as { current: HTMLDivElement | null }).current = node
    },
    [viewportRef],
  )

  useEffect(() => {
    const root = rootRef.current
    const viewport = viewportNodeRef.current
    const content = contentRef.current
    if (!root || !viewport || !content) return

    let frame = 0

    const measure = () => {
      frame = 0
      const { scrollTop, scrollHeight, clientHeight } = viewport

      // A pixel of tolerance at each end. On a fractional device pixel ratio
      // the resting position at the true bottom lands a fraction short of
      // `scrollHeight - clientHeight`, and an exact comparison leaves the
      // bottom affordance switched on forever at the end of every transcript.
      const top = scrollTop > 1
      const bottom = scrollTop + clientHeight < scrollHeight - 1

      const previous = edgesRef.current
      if (previous.top === top && previous.bottom === bottom) return

      edgesRef.current = { top, bottom }
      root.toggleAttribute('data-scrolled-top', top)
      root.toggleAttribute('data-scrolled-bottom', bottom)
      emitEdgesChange({ top, bottom })
    }

    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(measure)
    }

    measure()

    viewport.addEventListener('scroll', schedule, { passive: true })

    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    observer.observe(content)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [emitEdgesChange])

  const rootVars: Record<string, string> = {}
  if (maxHeight != null) rootVars['--_max-h'] = toLength(maxHeight)

  return (
    <div
      ref={setRootRef}
      data-tl="scroll-area"
      data-shadows={shadows || undefined}
      className={cx('tl-scroll-area', className)}
      style={{ ...rootVars, ...style } as CSSProperties}
      {...rest}
    >
      {/* The name and the tab stop belong to the element that actually scrolls,
          not to the wrapper that draws the shadows over it. `onScroll` is pulled
          out of the rest spread for the same reason and is the one handler that
          has to be: React does not bubble scroll, so a handler left on the root
          would be attached to an element that never scrolls and would simply
          never fire. */}
      <div
        ref={setViewportRef}
        data-tl="scroll-area-viewport"
        className="tl-scroll-area__viewport"
        onScroll={onScroll}
        tabIndex={focusable ? 0 : undefined}
        role={ariaLabel || ariaLabelledBy ? 'region' : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        <div ref={contentRef} className="tl-scroll-area__content">
          {children}
        </div>
      </div>
    </div>
  )
})
