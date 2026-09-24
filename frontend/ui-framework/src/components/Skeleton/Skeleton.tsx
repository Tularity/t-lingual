import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import './Skeleton.css'

export type SkeletonVariant = 'text' | 'circle' | 'rect'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant
  /** CSS length, or a number treated as px. */
  width?: number | string
  /** CSS length, or a number treated as px. Defaults per variant. */
  height?: number | string
  /** CSS length or a radius token. Defaults per variant. */
  radius?: number | string
  /** Renders a paragraph block. The last line is shortened. */
  lines?: number
}

function toLength(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * A loading placeholder shaped like the content it is standing in for.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * The painted bars are `aria-hidden`, and the container is not. That split is
 * the entire point of the component's structure. A skeleton screen has no
 * content — announcing it produces a run of empty group nodes, which is how a
 * screen reader user experiences "the page is full of blank boxes" and cannot
 * tell it apart from a page that has finished loading badly. Hiding the bars
 * removes that noise; keeping the container exposed with `aria-busy="true"`
 * preserves the one fact worth conveying, which is that the region is still
 * working.
 *
 * `aria-busy` on this element covers the skeleton itself. When the skeleton is
 * swapped for real content, the region that does the swapping should carry
 * `aria-busy` across the whole transition — a consumer that only marks the
 * placeholder loses the signal at exactly the moment the content arrives.
 *
 * MOTION
 * ------
 * The shimmer stops entirely under `prefers-reduced-motion`, which is one of
 * the few places in this framework that reaches for a media query instead of
 * the motion multiplier tokens. The multipliers scale a duration or a distance;
 * they cannot express "do not run this at all", and an infinite looping sweep
 * with no user control is precisely the non-essential motion WCAG 2.3.3 is
 * about. A static tint still reads as a placeholder.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { variant = 'text', width, height, radius, lines, className, style, ...rest },
  ref,
) {
  const count = variant === 'text' && lines && lines > 1 ? lines : 1

  // Cast rather than an index signature on CSSProperties: React writes any
  // `--*` key straight through to the inline style, and a value of `undefined`
  // is simply skipped, so the three optional props collapse into one object
  // with no conditional spreading.
  const vars = {
    ...style,
    '--_w': toLength(width),
    '--_h': toLength(height),
    '--_radius': toLength(radius),
  } as CSSProperties

  return (
    <div
      {...rest}
      ref={ref}
      data-tl="skeleton"
      data-variant={variant}
      aria-busy="true"
      className={cx('tl-skeleton', className)}
      style={vars}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="tl-skeleton__bar"
          // The final line of a paragraph almost never reaches the measure, and
          // a block of identical full-width bars reads as a table rather than
          // as prose. This is the only cue that says "text is coming".
          data-last={count > 1 && index === count - 1 ? '' : undefined}
          aria-hidden="true"
        />
      ))}
    </div>
  )
})
