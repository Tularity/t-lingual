import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { CompactMark } from '../CompactMark/CompactMark'
import './Spinner.css'

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize
  /**
   * Announced by assistive tech. When omitted the spinner is decorative and
   * silent — correct when it sits inside a control that already announces its
   * busy state, which is the common case.
   */
  label?: string
}

/** Pixel size per step. The mark is laid out at these sizes rather than scaled
 *  to them, so the three smallest get the four-cell lattice and `lg` the
 *  five-cell one, and every gap between pieces stays at least a pixel wide. */
const SIZE_PX: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 22,
}

/**
 * Indeterminate activity — the compact brand mark, its cells rippling.
 *
 * It used to be a generic rotating arc. Every busy state in the library goes
 * through here, so that was the single largest surface in the product showing
 * a shape that could have belonged to anything; making it the mark costs
 * nothing and means the brand appears wherever the product is working.
 *
 * TONE. Always `inherit`, never `brand`. A spinner turns up inside buttons,
 * on accent fills, in disabled controls and in text, and in every one of those
 * it has to be whatever colour the thing around it is.
 *
 * MOTION. The mark's `wave`: a ripple crosses its cells, the mark holds for a
 * beat, then turns once and lands straight into the next ripple, so it is
 * whole or nearly whole in every frame and still reads as the logo at 12px. The mark's own tempo, not a
 * faster one: a spinner beating quicker than the same mark elsewhere on the
 * page would be two rhythms for one brand. The loop keeps running under
 * `prefers-reduced-motion` — a spinner that stops reads as "hung", the
 * opposite of what it exists to say. CompactMark.css gates its loop on
 * `no-preference`, so on its own the mark does stop; Spinner.css re-declares
 * the loop under `reduce`, for exactly this reason.
 */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size = 'md', label, className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      data-tl="spinner"
      data-size={size}
      className={cx('tl-spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      <CompactMark size={SIZE_PX[size]} tone="inherit" motion="wave" />
    </span>
  )
})
