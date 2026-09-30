import { forwardRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { chartColor } from './chartScale'
import './Chart.css'

export interface DonutItem {
  id: string
  label: ReactNode
  /** Plain words for the item, where its label is not text. */
  textLabel?: string
  value: number
  color?: string
}

export interface DonutChartProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string
  items: ReadonlyArray<DonutItem>
  size?: number
  thickness?: number
  /** What the hole says while nothing is hovered: usually the total. */
  center?: ReactNode
  formatValue?: (value: number) => string
  legend?: boolean
  emptyLabel?: ReactNode
}

function arc(cx: number, cy: number, radius: number, start: number, end: number) {
  const point = (angle: number) => [cx + radius * Math.sin(angle), cy - radius * Math.cos(angle)] as const
  const [x1, y1] = point(start)
  const [x2, y2] = point(end)
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

/**
 * Parts of a whole. The legend beside it carries every part's value and
 * share, so the reading never depends on judging an angle; hovering a part,
 * in the ring or the legend, names it in the hole.
 */
export const DonutChart = forwardRef<HTMLDivElement, DonutChartProps>(function DonutChart(
  { label, items, size = 150, thickness = 18, center, formatValue = String, legend = true, emptyLabel = 'No data yet', className, ...rest },
  ref,
) {
  const [active, setActive] = useState<string | null>(null)
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  const radius = (size - thickness) / 2
  const gap = items.filter((item) => item.value > 0).length > 1 ? 0.025 : 0
  let angle = 0
  const segments = items.map((item, index) => {
    const share = total ? Math.max(0, item.value) / total : 0
    const start = angle
    angle += share * Math.PI * 2
    return { item, index, share, start, end: angle }
  })
  const hovered = segments.find((segment) => segment.item.id === active)
  const percent = (share: number) => `${Math.round(share * 100)}%`

  return (
    <div ref={ref} data-tl="donut-chart" className={cx('tl-donut', className)} role="figure" aria-label={label} {...rest}>
      <div className="tl-donut__ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} aria-hidden="true" focusable="false">
          <circle className="tl-donut__track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={thickness} fill="none" />
          {total > 0 && segments.map(({ item, index, share, start, end }) => share > 0 ? (
            share >= 0.9999
              ? <circle key={item.id} cx={size / 2} cy={size / 2} r={radius} strokeWidth={thickness} fill="none" stroke={item.color ?? chartColor(index)} />
              : <path key={item.id} d={arc(size / 2, size / 2, radius, start + gap / 2, Math.max(start + gap / 2 + 0.001, end - gap / 2))}
                  stroke={item.color ?? chartColor(index)} strokeWidth={thickness} fill="none" data-dim={active && active !== item.id || undefined}
                  onPointerEnter={() => setActive(item.id)} onPointerLeave={() => setActive(null)} />
          ) : null)}
        </svg>
        <div className="tl-donut__center">
          {total === 0 ? <span className="tl-donut__empty">{emptyLabel}</span> : hovered
            ? <><b>{formatValue(hovered.item.value)}</b><span>{hovered.item.label} · {percent(hovered.share)}</span></>
            : center}
        </div>
      </div>
      {legend ? (
        <ul className="tl-chart__legend tl-donut__legend">
          {segments.map(({ item, index, share }) => (
            <li key={item.id} data-active={active === item.id || undefined} onPointerEnter={() => setActive(item.id)} onPointerLeave={() => setActive(null)}>
              <i style={{ background: item.color ?? chartColor(index) }} aria-hidden="true" />
              <span>{item.label}</span>
              <b>{formatValue(item.value)}<small>{percent(share)}</small></b>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
})
