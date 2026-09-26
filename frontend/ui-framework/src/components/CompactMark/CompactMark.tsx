/* ---------------------------------------------------------------------------
 * THE COMPACT MARK
 *
 * The logo redrawn for the places the full drawing cannot go: inside a
 * button, beside a line of text, at favicon size. Same four pieces, same
 * palette, but upright, on a coarser lattice, and without the tail — see
 * compactMarkGeometry.ts for why each of those had to go.
 *
 * Its one animation, `wave`, is the small counterpart of the logo's large
 * collapse. The large one is allowed to take the logo apart because it plays
 * where nothing else is competing for attention. This one plays inside
 * controls, so it follows the opposite rule: the mark is recognisable in
 * every frame. Each loop is a relay of two gestures that never overlap. A
 * ripple crosses its cells — they shrink toward their own centres and round
 * off, exposing the lattice the pieces are cut from — from the lower-left
 * corner toward the upper right, the way the logo's tail leaves. The mark
 * then holds for a beat, whole, before the whole of it turns once, drawing in
 * a little so its corners never leave its own box, and lands straight into
 * the next ripple.
 *
 * Drawn with HTML boxes rather than SVG because the wave needs each cell to
 * move from its own resting corners (square where it joins its piece, round
 * where the piece turns) to a uniformly rounded tile, and only border-radius
 * can do that per corner with nothing but CSS. Every length is resolved to
 * pixels here rather than left relative, so no inherited font size or
 * descendant selector in a consumer's stylesheet can move a cell.
 * ------------------------------------------------------------------------- */
import { forwardRef, useMemo, useRef, type CSSProperties, type HTMLAttributes } from 'react'
import { composeRefs } from '../../primitives/Slot'
import { cx } from '../../utils/cx'
import {
  compactCutForSize,
  layoutCompactMark,
  type CompactMarkCell,
  type CompactMarkCut,
  type CompactMarkEdge,
} from './compactMarkGeometry'
import { useRoundingWindows } from './compactMarkRounding'
import './CompactMark.css'

export type CompactMarkTone = 'brand' | 'mono' | 'inherit'
export type CompactMarkMotion = 'wave'

export interface CompactMarkProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Edge length in px. Also selects the lattice — see `cut`. */
  size?: number
  /**
   * `brand` — the logo's own tonal amber, one shade per piece, for a neutral
   * surface where the mark stands for the organisation.
   * `mono` — every piece in the base amber.
   * `inherit` — every piece in `currentColor`, so the mark behaves like an
   * icon: inside an accent button, in a danger row, in print.
   */
  tone?: CompactMarkTone
  /** Animates the mark. Omit for the static drawing. */
  motion?: CompactMarkMotion
  /**
   * Overrides the lattice chosen from `size`. Exists so the lab can compare
   * both cuts at one size; a real call site should let the size decide.
   */
  cut?: CompactMarkCut
  /** Loop length in milliseconds, 2400 by default. */
  cycle?: number
  /**
   * Accessible name. Omit for a decorative mark (it is then `aria-hidden`);
   * supplying it makes the element `role="img"`.
   */
  label?: string
}

/**
 * Joined edges reach this far past their lattice line into the neighbour. Two
 * boxes that merely abut at a fractional pixel each antialias their own edge
 * and leave a faint seam, and a piece must read as one surface. Half a pixel
 * closes the seam and is too small to show as a lip beside a shrunken cell.
 */
const BLEED = 0.5

const px = (value: number) => `${Math.round(value * 100) / 100}px`

function cellStyle(cell: CompactMarkCell, pitch: number, halfGap: number, size: number): CSSProperties {
  const { row, col, edges, radii, scoops } = cell
  // Signed distance from the lattice line to the box edge, positive inward.
  const shift = (kind: CompactMarkEdge) => (kind === 'inset' ? halfGap : kind === 'join' ? -BLEED : 0)
  const step = pitch * size
  const left = col * step + shift(edges.left)
  const top = row * step + shift(edges.top)
  const width = step - shift(edges.left) - shift(edges.right)
  const height = step - shift(edges.top) - shift(edges.bottom)

  // A scoop is centred on the lattice point at that corner, which a joined
  // box overshoots by the bleed on both axes.
  const corners: [number, number][] = [
    [-left + col * step, -top + row * step],
    [(col + 1) * step - left, -top + row * step],
    [(col + 1) * step - left, (row + 1) * step - top],
    [-left + col * step, (row + 1) * step - top],
  ]
  // The cut is never smaller than the bleed's own corner. Both sides of a
  // scooped corner join, so the box overshoots the lattice point by the bleed
  // on both axes, and at small sizes that overshoot is further from the point
  // than half a gap — it would survive the cut as a speck of ink sitting in
  // the junction of two gaps. Cutting wider only rounds the inner corner a
  // little more, and only at sizes where that corner is under a pixel anyway.
  const cut = Math.max(halfGap, BLEED * Math.SQRT2 + 0.1)
  const masks = scoops.flatMap((on, i) =>
    on
      ? [
          // A little feather either side: a hard gradient stop is not
          // antialiased and would draw the fillet as a stair.
          `radial-gradient(circle at ${px(corners[i][0])} ${px(corners[i][1])}, transparent ${px(cut - 0.35)}, #000 ${px(cut + 0.35)})`,
        ]
      : [],
  )

  return {
    left: px(left),
    top: px(top),
    width: px(width),
    height: px(height),
    borderRadius: radii.map((r) => px(r * size)).join(' '),
    // The lattice centre, not the box centre: an inset box is off-centre by a
    // quarter gap, and scaling about its own middle would leave the shrunken
    // cells visibly off the grid they are meant to reveal.
    transformOrigin: `${px(step / 2 - shift(edges.left))} ${px(step / 2 - shift(edges.top))}`,
    ...(masks.length
      ? {
          maskImage: masks.join(', '),
          WebkitMaskImage: masks.join(', '),
          maskComposite: 'intersect',
          WebkitMaskComposite: 'source-in',
        }
      : null),
    ['--_phase' as string]: Math.round(cell.phase * 1e4) / 1e4,
  }
}

export const CompactMark = forwardRef<HTMLSpanElement, CompactMarkProps>(function CompactMark(
  { size = 16, tone = 'brand', motion, cut, cycle, label, className, style, ...rest },
  ref,
) {
  const resolvedCut = cut ?? compactCutForSize(size)
  const layout = layoutCompactMark(resolvedCut)
  // The gap is floored so it never drops under one CSS pixel; a thinner gap
  // antialiases into a pale seam, and a gap that is half there is worse than
  // no gap at all.
  const halfGap = Math.max((layout.gap * size) / 2, 0.5)
  const cells = useMemo(
    () => layout.cells.map((cell) => cellStyle(cell, layout.pitch, halfGap, size)),
    [layout, halfGap, size],
  )
  const root = useRef<HTMLSpanElement>(null)
  const setRefs = useMemo(() => composeRefs<HTMLSpanElement>(ref, root), [ref])
  // See compactMarkRounding.ts: keeps the main thread idle outside the dips.
  useRoundingWindows(root, motion === 'wave', `${resolvedCut}:${size}:${cycle ?? ''}`)

  return (
    <span
      ref={setRefs}
      data-tl="compact-mark"
      className={cx('tl-compact-mark', className)}
      data-tone={tone}
      data-cut={resolvedCut}
      data-motion={motion}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={
        {
          width: px(size),
          height: px(size),
          ...(cycle === undefined ? null : { '--_cycle': `${cycle}ms` }),
          ...style,
        } as CSSProperties
      }
      {...rest}
    >
      <span className="tl-compact-mark__figure">
        {layout.cells.map((cell, i) => (
          <span
            key={`${cell.row}-${cell.col}`}
            className="tl-compact-mark__cell"
            data-piece={cell.piece}
            style={cells[i]}
          >
            <span className="tl-compact-mark__fill" />
          </span>
        ))}
      </span>
    </span>
  )
})
