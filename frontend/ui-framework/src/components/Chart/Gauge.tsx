import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { meterLevel } from '../Meter/meterLevel'
import './Chart.css'

export interface GaugeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value: number
  min?: number
  max?: number
  /** As Meter: the bands, and which end of them is good. */
  low?: number
  high?: number
  optimum?: number
  /** Accessible name. */
  label: string
  /** What the dial says in its middle: the reading, formatted. */
  display?: ReactNode
  /** Plain words for the reading, for assistive technology. */
  valueText?: string
  /** A line under the reading: its unit, or what it is out of. */
  caption?: ReactNode
  size?: number
}

/**
 * A reading on a half dial. The same measurement as Meter — the same
 * `role="meter"` and the same band rules from `meterLevel` — drawn for a
 * dashboard where the number is the headline rather than a row's detail.
 */
export const Gauge = forwardRef<HTMLDivElement, GaugeProps>(function Gauge(
  { value, min = 0, max = 100, low, high, optimum, label, display, valueText, caption, size = 150, className, style, ...rest },
  ref,
) {
  const current = Math.min(Math.max(Number.isFinite(value) ? value : min, min), max)
  const fraction = max > min ? (current - min) / (max - min) : 0
  const level = meterLevel(current, { min, max, low, high, optimum })
  const stroke = Math.max(8, size * 0.09)
  const radius = (size - stroke) / 2
  const center = size / 2
  const height = center + stroke / 2 + 2
  const point = (share: number) => {
    const angle = Math.PI * (1 - share)
    return `${(center + radius * Math.cos(angle)).toFixed(2)} ${(center - radius * Math.sin(angle)).toFixed(2)}`
  }
  const track = `M${point(0)}A${radius} ${radius} 0 0 1 ${point(1)}`
  const fill = fraction > 0 ? `M${point(0)}A${radius} ${radius} 0 0 1 ${point(Math.min(0.9999, fraction))}` : ''
  return (
    <div ref={ref} data-tl="gauge" data-level={level} className={cx('tl-gauge', className)} role="meter" aria-label={label}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={current} aria-valuetext={valueText}
      style={{ ...style, width: size }} {...rest}>
      <svg width={size} height={height} aria-hidden="true" focusable="false">
        <path className="tl-gauge__track" d={track} strokeWidth={stroke} fill="none" strokeLinecap="round" />
        {fill ? <path className="tl-gauge__fill" d={fill} strokeWidth={stroke} fill="none" strokeLinecap="round" /> : null}
      </svg>
      <div className="tl-gauge__reading" style={{ top: center * 0.42 }}>
        <b>{display ?? current}</b>
        {caption != null ? <span>{caption}</span> : null}
      </div>
    </div>
  )
})
