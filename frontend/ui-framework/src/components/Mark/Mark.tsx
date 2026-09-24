/* ---------------------------------------------------------------------------
 * THE MARK
 *
 * Tularity's logo, and therefore the framework's: this library serves one
 * organisation's products, so a shared brand asset is not a coupling to
 * apologise for. It is a component rather than a static SVG because it has to
 * do four things a file cannot: take its colour from whatever it sits on,
 * redraw itself heavier at small sizes, animate as a loading indicator, and
 * show a real progress value. `Spinner` is built on it, so every busy state in
 * the library is this shape.
 *
 * The geometry lives in markGeometry.ts; this file only decides which cut to
 * draw and hands each hatch line a number the stylesheet can address.
 * ------------------------------------------------------------------------- */
import { forwardRef, useMemo, type CSSProperties, type SVGAttributes } from 'react'
import { cx } from '../../utils/cx'
import { cutForSize, layoutMark, type MarkCut, type MarkTexture } from './markGeometry'
import './Mark.css'

export type MarkTone = 'brand' | 'mono' | 'inherit'
export type MarkLoading = 'sweep' | 'pulse' | 'progress'

export interface MarkProps extends Omit<SVGAttributes<SVGSVGElement>, 'children'> {
  /** Edge length in px. Also selects the optical cut — see `cut`. */
  size?: number
  /**
   * `brand` — the mark owns its colours: an amber hatch, the pieces that
   * border the T a shade deeper so the letter is outlined, and a scatter of
   * pieces in the brand brown. For a neutral surface where the mark is being
   * the brand: topbar, splash, docs.
   * `mono` — the same drawing in the base amber alone, for a size or a
   * surface where three inks would only be noise.
   * `inherit` — `currentColor`, behaving like an icon; the palette survives
   * as three opacities. For an accent-filled button, print, forced colours, or
   * inline in a run of text.
   */
  tone?: MarkTone
  /**
   * Animates the mark. `sweep` draws the lines in and wipes them out, for a
   * page or panel that is loading; `pulse` runs a brightness wave across the
   * hatch, quiet enough to sit inside a button; `progress` fills the lines in
   * order to a real value and is the only variant that is a display rather than
   * a loop. Omit for the static logo.
   */
  loading?: MarkLoading
  /** 0..1, only meaningful with `loading="progress"`. */
  progress?: number
  /**
   * Breathes the hatch in and out along its lines like a level meter — the
   * mark listening. For a live session's recording state, where a loader would
   * say "wait" and this says "go on".
   */
  live?: boolean
  /**
   * Overrides the cut chosen from `size`. Exists so the lab can put the cuts
   * side by side at one size; a real call site should let the size decide.
   */
  cut?: MarkCut
  /**
   * Overrides the cut's texture: `broken` is the display cut's seeded breaks,
   * `solid` unbroken lines. For comparison in the lab; a real call site should
   * let the cut decide.
   */
  texture?: MarkTexture
  /**
   * Loop length in milliseconds. Each variant has its own default — sweep
   * 2800, pulse 1500, live 1400 — chosen for a mark that is the focus of the
   * screen. `Spinner` shortens pulse a little, since at 14px the wave has less
   * distance to travel.
   */
  cycle?: number
  /**
   * Accessible name. Omit for a decorative mark (the default is `aria-hidden`,
   * right whenever adjacent text carries the meaning). Supplying it makes the
   * element `role="img"`.
   */
  label?: string
}

export const Mark = forwardRef<SVGSVGElement, MarkProps>(function Mark(
  {
    size = 24,
    tone = 'brand',
    loading,
    progress,
    live = false,
    cut,
    texture,
    cycle,
    label,
    className,
    style,
    ...rest
  },
  ref,
) {
  const resolvedCut = cut ?? cutForSize(size)
  const layout = useMemo(() => layoutMark(resolvedCut, texture), [resolvedCut, texture])

  // Stroke widths are attributes, deliberately, and the stylesheet declares
  // none. A CSS declaration always beats a presentation attribute, so a
  // `stroke-width` left in Mark.css would silently flatten the three cuts back
  // to one weight.
  const vars = {
    '--_lines': layout.lines,
    ...(progress === undefined ? null : { '--_progress': Math.min(1, Math.max(0, progress)) }),
    ...(cycle === undefined ? null : { '--_cycle': `${cycle}ms` }),
    ...style,
  } as CSSProperties

  return (
    <svg
      ref={ref}
      data-tl="mark"
      className={cx('tl-mark', className)}
      data-tone={tone}
      data-cut={resolvedCut}
      data-loading={loading}
      data-live={live || undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={vars}
      {...rest}
    >
      <g className="tl-mark__figure">
        {layout.segments.map((segment) => (
          <path
            key={`${segment.line}-${segment.piece}`}
            className="tl-mark__line"
            data-edge={segment.edge || undefined}
            data-ink={segment.ink}
            d={`M${segment.x1} ${segment.y1}L${segment.x2} ${segment.y2}`}
            strokeWidth={segment.width}
            // Normalises every piece onto a 0..1 run, so a dash offset draws it
            // end to end without the stylesheet knowing its real length.
            pathLength={1}
            style={{ '--_line': segment.line } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  )
})
