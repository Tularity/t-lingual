import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { meterLevel } from './meterLevel'
import './Meter.css'

export type MeterSize = 'sm' | 'md' | 'lg'

export interface MeterProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value: number
  min?: number
  max?: number
  /** Boundary of the low band. Defaults to `min` (no low band). */
  low?: number
  /** Boundary of the high band. Defaults to `max` (no high band). */
  high?: number
  /** Where "good" is. Below `low`, above `high`, or between them. */
  optimum?: number
  size?: MeterSize
  /** Accessible name. Required unless `aria-labelledby` names it instead. */
  label?: string
  /** Human phrasing of the value: "4.2 GB of 5 GB used". */
  valueText?: string
}

/**
 * A level, not a task.
 *
 * THIS IS NOT PROGRESS, AND THE DIFFERENCE IS NOT COSMETIC
 * -------------------------------------------------------
 * A progressbar describes an operation moving toward completion; it is expected
 * to change, it is expected to end, and a screen reader treats it as a busy
 * indicator — some announce it periodically while it runs, and some suppress
 * other output while an element in the same region is busy. A meter describes a
 * static measurement of something that is simply true right now: disk quota,
 * transcription confidence, input level. Announcing that as busy tells the user
 * an operation is underway when nothing is happening at all, and a meter that
 * reaches 100% is at capacity rather than finished — often the worst outcome
 * rather than the best. Reach for Progress when the number is going somewhere
 * and for Meter when it is a reading.
 *
 * The band colour is derived by `meterLevel` from HTML's own `<meter>` rules,
 * so `optimum` decides which end is good. Colour is not the only signal: the
 * fill length carries the value and `valueText` carries the reading, so a user
 * who cannot separate the amber band from the red one still gets the number.
 *
 * `role="meter"` on a div rather than a native `<meter>`: the native element
 * cannot be restyled to the system's shape without a different set of
 * vendor pseudo-elements per engine, and it gives nothing back that the role
 * does not already carry.
 */
export const Meter = forwardRef<HTMLDivElement, MeterProps>(function Meter(
  {
    value,
    min = 0,
    max = 100,
    low,
    high,
    optimum,
    size = 'md',
    label,
    valueText,
    className,
    style,
    ...rest
  },
  ref,
) {
  if (
    import.meta.env?.DEV &&
    !label &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <Meter> needs `label` or `aria-labelledby`. ' +
        'A bare number with no name attached is not a measurement of anything.',
    )
  }

  const current = Math.min(Math.max(value, min), max)
  const span = max - min
  const fraction = span > 0 ? (current - min) / span : 0
  const level = meterLevel(current, { min, max, low, high, optimum })

  return (
    <div
      ref={ref}
      data-tl="meter"
      data-level={level}
      data-size={size}
      className={cx('tl-meter', className)}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={current}
      aria-valuetext={valueText}
      style={{ ...style, '--_fraction': fraction } as CSSProperties}
      {...rest}
    >
      <span className="tl-meter__fill" />
    </div>
  )
})
