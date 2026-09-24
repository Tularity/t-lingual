/* ---------------------------------------------------------------------------
 * ANCHORED POSITIONING
 *
 * Popover, Tooltip and Menu share this instead of the framework taking a
 * positioning dependency. What a library like floating-ui buys is a long tail
 * this package does not have: virtual reference elements, arbitrary clipping
 * boundaries, auto-placement across all twelve sides, iframe-aware coordinate
 * spaces, and a middleware pipeline. What the three components actually need is
 * flip and shift against the viewport, which is the arithmetic below.
 *
 * Everything is in VIEWPORT coordinates — the space `getBoundingClientRect`
 * already reports in — and every floating surface is `position: fixed`. That
 * single decision is what keeps this file short: no offsetParent walk, no
 * accumulating scroll offsets, and no detection of a transformed ancestor
 * silently becoming the containing block, which is the bug that eats a week
 * when an absolutely positioned dropdown is inside a `transform`ed card.
 *
 * The function is pure and synchronous so it can be reasoned about and tested
 * without a DOM: measurement and the write back to the element belong to
 * `useAnchoredPosition`, not here.
 * ------------------------------------------------------------------------- */

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Align = 'start' | 'center' | 'end'
export type Placement = Side | `${Side}-${Align}`

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Only the *size* of the floating box is an input — its position is what this
 * function returns, so asking a caller to supply `x`/`y` for it would mean
 * inventing two numbers that are then thrown away.
 */
export type Size = Pick<Rect, 'width' | 'height'>

export interface PositionOptions {
  /** Trigger geometry, in viewport coordinates. */
  anchor: Rect
  /** Untransformed size of the surface being placed. */
  floating: Size
  /** Requested side, optionally with cross-axis alignment. */
  placement?: Placement
  /** Gap between the anchor and the surface, along the main axis. */
  offset?: number
  /** Viewport inset kept clear on every edge. */
  padding?: number
  /** Defaults to the layout viewport. Pass explicitly to test without a DOM. */
  boundary?: Size
}

export interface PositionResult {
  x: number
  y: number
  /** Resolved placement, which differs from the request when it flipped. */
  placement: Placement
  side: Side
  align: Align
  /** Anchor centre relative to the surface's own top-left, for an arrow. */
  arrowX: number
  arrowY: number
  /** Room left on the resolved side; a caller turns these into a max-size. */
  availableWidth: number
  availableHeight: number
  /** True once the anchor has scrolled entirely out of the boundary. */
  anchorHidden: boolean
}

const OPPOSITE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

function isVertical(side: Side): boolean {
  return side === 'top' || side === 'bottom'
}

function clamp(value: number, min: number, max: number): number {
  // A surface wider than the space available produces max < min. Pinning to the
  // start edge is the only sane answer; Math.min/Math.max alone would silently
  // return the *end* edge and push the surface off the opposite side.
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function parsePlacement(placement: Placement): [Side, Align] {
  const dash = placement.indexOf('-')
  if (dash === -1) return [placement as Side, 'center']
  return [placement.slice(0, dash) as Side, placement.slice(dash + 1) as Align]
}

function viewportSize(): Size {
  if (typeof document === 'undefined') return { width: 0, height: 0 }
  const root = document.documentElement
  // clientWidth, not innerWidth: the latter includes the classic scrollbar
  // gutter, and a panel placed flush to that edge ends up underneath it.
  return { width: root.clientWidth, height: root.clientHeight }
}

function coordsFor(
  side: Side,
  align: Align,
  anchor: Rect,
  floating: Size,
  offset: number,
): { x: number; y: number } {
  if (isVertical(side)) {
    const y =
      side === 'top'
        ? anchor.y - floating.height - offset
        : anchor.y + anchor.height + offset
    const x =
      align === 'start'
        ? anchor.x
        : align === 'end'
          ? anchor.x + anchor.width - floating.width
          : anchor.x + anchor.width / 2 - floating.width / 2
    return { x, y }
  }

  const x =
    side === 'left' ? anchor.x - floating.width - offset : anchor.x + anchor.width + offset
  const y =
    align === 'start'
      ? anchor.y
      : align === 'end'
        ? anchor.y + anchor.height - floating.height
        : anchor.y + anchor.height / 2 - floating.height / 2
  return { x, y }
}

/** How far the surface pokes past the boundary on the side it was placed. */
function mainAxisOverflow(
  side: Side,
  coords: { x: number; y: number },
  floating: Size,
  boundary: Size,
  padding: number,
): number {
  switch (side) {
    case 'top':
      return padding - coords.y
    case 'bottom':
      return coords.y + floating.height - (boundary.height - padding)
    case 'left':
      return padding - coords.x
    case 'right':
      return coords.x + floating.width - (boundary.width - padding)
  }
}

/** Room between the anchor and the boundary edge on a given side. */
function spaceOn(side: Side, anchor: Rect, boundary: Size, offset: number, padding: number): number {
  const raw =
    side === 'top'
      ? anchor.y
      : side === 'bottom'
        ? boundary.height - (anchor.y + anchor.height)
        : side === 'left'
          ? anchor.x
          : boundary.width - (anchor.x + anchor.width)
  return Math.max(0, raw - offset - padding)
}

/**
 * Places a floating box against an anchor, flipping to the opposite side when
 * the requested one overflows and then shifting along the cross axis to stay
 * in view.
 */
export function computePosition({
  anchor,
  floating,
  placement = 'bottom',
  offset = 8,
  padding = 8,
  boundary = viewportSize(),
}: PositionOptions): PositionResult {
  const [preferred, align] = parsePlacement(placement)

  let side = preferred
  let coords = coordsFor(preferred, align, anchor, floating, offset)
  const overflow = mainAxisOverflow(preferred, coords, floating, boundary, padding)

  if (overflow > 0) {
    const opposite = OPPOSITE[preferred]
    const flipped = coordsFor(opposite, align, anchor, floating, offset)
    const flippedOverflow = mainAxisOverflow(opposite, flipped, floating, boundary, padding)
    // Flip only when the other side is genuinely better. A surface taller than
    // the viewport overflows both ways; flipping it then just moves the problem
    // and makes the panel jump sides as the page scrolls past the midpoint.
    if (flippedOverflow < overflow) {
      side = opposite
      coords = flipped
    }
  }

  let { x, y } = coords
  if (isVertical(side)) {
    x = clamp(x, padding, boundary.width - floating.width - padding)
  } else {
    y = clamp(y, padding, boundary.height - floating.height - padding)
  }

  // Whole pixels. A surface landing on a half pixel resamples its text and its
  // 1px border, which reads as a blurry panel next to a crisp trigger.
  x = Math.round(x)
  y = Math.round(y)

  return {
    x,
    y,
    placement: align === 'center' ? side : (`${side}-${align}` as Placement),
    side,
    align,
    arrowX: anchor.x + anchor.width / 2 - x,
    arrowY: anchor.y + anchor.height / 2 - y,
    availableWidth: isVertical(side)
      ? Math.max(0, boundary.width - padding * 2)
      : spaceOn(side, anchor, boundary, offset, padding),
    availableHeight: isVertical(side)
      ? spaceOn(side, anchor, boundary, offset, padding)
      : Math.max(0, boundary.height - padding * 2),
    anchorHidden: isAnchorHidden(anchor, boundary),
  }
}

/**
 * Whether the anchor has scrolled out of the boundary.
 *
 * Both degenerate cases answer "no", and that is the important part. A zero
 * sized anchor and a zero sized boundary are the same thing here — an absence
 * of layout information, which happens before first layout, inside a
 * `content-visibility: hidden` subtree, and in every jsdom test — not evidence
 * that the trigger has gone anywhere. Reading them as "hidden" makes callers
 * close a surface the instant it opens, which presents as an overlay that
 * flashes and vanishes rather than as a measurement bug.
 */
function isAnchorHidden(anchor: Rect, boundary: Size): boolean {
  if (boundary.width <= 0 || boundary.height <= 0) return false
  if (anchor.width <= 0 && anchor.height <= 0) return false
  return (
    anchor.y + anchor.height <= 0 ||
    anchor.y >= boundary.height ||
    anchor.x + anchor.width <= 0 ||
    anchor.x >= boundary.width
  )
}
