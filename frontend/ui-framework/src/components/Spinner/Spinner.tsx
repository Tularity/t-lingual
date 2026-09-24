import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { Mark } from '../Mark/Mark'
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

/** Pixel size per step. The mark is drawn at these, not scaled to them, which
 *  is what lets it pick its heaviest cut for the three smallest. */
const SIZE_PX: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 22,
}

/**
 * Indeterminate activity — the brand mark, pulsing.
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
 * MOTION. `pulse` rather than `sweep`: nothing moves and no row is ever
 * missing, so the mark stays a mark at 12px, and a brightness wave is quiet
 * enough to sit beside a label without competing with it. The loop keeps
 * running under `prefers-reduced-motion` — a spinner that stops reads as
 * "hung", the opposite of what it exists to say. Mark.css gates every one of
 * the mark's loops on `no-preference`, so on its own the mark does stop;
 * Spinner.css re-declares this one loop under `reduce`, for exactly this
 * reason.
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
      <Mark size={SIZE_PX[size]} tone="inherit" loading="pulse" cycle={1200} />
    </span>
  )
})
