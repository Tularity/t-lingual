import { forwardRef, useId, type SVGAttributes } from 'react'
import { cx } from '../../utils/cx'
import { finiteValues } from './chartScale'
import './Chart.css'

export interface SparklineProps extends Omit<SVGAttributes<SVGSVGElement>, 'values'> {
  values: ReadonlyArray<number | null | undefined>
  width?: number
  height?: number
  color?: string
  area?: boolean
  /** Floor of the scale; defaults to the lowest value or zero, whichever is lower. */
  min?: number
  max?: number
  /** Accessible name; omit where the number beside it says it all. */
  label?: string
  /**
   * Stretch across the container's width instead of drawing at `width`.
   * `width` then only sets the drawing's proportions; the line keeps its
   * weight however far it is stretched.
   */
  fluid?: boolean
}

/**
 * A trend at a glance, beside the number it belongs to. It has no axes and
 * makes no claim to precision: the figure next to it is the reading.
 */
export const Sparkline = forwardRef<SVGSVGElement, SparklineProps>(function Sparkline(
  { values, width = 96, height = 28, color = 'var(--tl-chart-1)', area = true, min, max, label, fluid, className, ...rest },
  ref,
) {
  const gradient = useId().replace(/:/g, '')
  const known = finiteValues(values)
  const low = min ?? Math.min(0, ...known)
  const high = max ?? Math.max(low + 1, ...known)
  const count = values.length
  const px = (index: number) => (count <= 1 ? width / 2 : (index / (count - 1)) * (width - 2) + 1)
  const py = (value: number) => height - 2 - ((value - low) / (high - low || 1)) * (height - 4)
  let line = ''
  let fill = ''
  let run: string[] = []
  let firstX = 0
  let lastX = 0
  const close = () => {
    if (run.length) {
      line += `M${run.join('L')}`
      fill += `M${firstX.toFixed(1)} ${height}L${run.join('L')}L${lastX.toFixed(1)} ${height}Z`
    }
    run = []
  }
  values.forEach((value, index) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (!run.length) firstX = px(index)
      lastX = px(index)
      run.push(`${px(index).toFixed(1)} ${py(Math.min(high, Math.max(low, value))).toFixed(1)}`)
    } else close()
  })
  close()
  return (
    <svg ref={ref} data-tl="sparkline" data-fluid={fluid || undefined} className={cx('tl-sparkline', className)} width={fluid ? undefined : width} height={height}
      viewBox={fluid ? `0 0 ${width} ${height}` : undefined} preserveAspectRatio={fluid ? 'none' : undefined}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false" {...rest}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && fill ? <path d={fill} fill={`url(#${gradient})`} /> : null}
      {line ? <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect={fluid ? 'non-scaling-stroke' : undefined} /> : null}
    </svg>
  )
})
