import { forwardRef, useMemo, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import { chartColor, finiteValues, niceTicks, useChartWidth } from './chartScale'
import { ChartLegend, type ChartSeries } from './LineChart'
import './Chart.css'

export interface BarChartProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string
  /** One bar group per category, in order. */
  categories: ReadonlyArray<string>
  series: ReadonlyArray<ChartSeries>
  /** Stack a category's series in one bar instead of side by side. */
  stacked?: boolean
  height?: number
  formatY?: (value: number) => string
  formatCategory?: (category: string, index: number) => string
  yTicks?: number
  /** About how many category labels to show. */
  xTicks?: number
  legend?: boolean
  emptyLabel?: ReactNode
  /** The screen-reader sentence for one series and its total. */
  describeSeries?: (label: string, total: string) => string
}

const MARGIN = { top: 10, right: 8, bottom: 22 }

/**
 * Amounts per category as bars — side by side, or stacked when the parts
 * add up to a whole worth reading. A hovered or focused category is shown
 * in full in a tooltip; the arrow keys move between categories.
 */
export const BarChart = forwardRef<HTMLDivElement, BarChartProps>(function BarChart(
  { label, categories, series, stacked = false, height = 200, formatY = String, formatCategory = (value) => value,
    yTicks = 4, xTicks = 8, legend, emptyLabel = 'No data yet', describeSeries = (name, total) => `${name}: total ${total}.`, className, ...rest },
  ref,
) {
  const [measure, width] = useChartWidth()
  const [active, setActive] = useState<number | null>(null)
  const count = categories.length
  const totals = useMemo(() => categories.map((_, index) => series.reduce((sum, item) => sum + Math.max(0, item.values[index] ?? 0), 0)), [categories, series])
  const all = useMemo(() => series.flatMap((item) => finiteValues(item.values)), [series])
  const ticks = niceTicks(0, stacked ? Math.max(1, ...totals) : Math.max(1, ...all), yTicks)
  const top = ticks[ticks.length - 1] ?? 1
  const tickLabels = ticks.map((tick) => formatY(tick))
  const left = Math.max(28, Math.max(...tickLabels.map((text) => text.length)) * 6.4 + 10)
  const plotWidth = Math.max(10, width - left - MARGIN.right)
  const plotHeight = Math.max(10, height - MARGIN.top - MARGIN.bottom)
  const band = count ? plotWidth / count : plotWidth
  const barWidth = Math.max(2, Math.min(38, band * (stacked || series.length === 1 ? 0.62 : 0.78) / (stacked ? 1 : Math.max(1, series.length))))
  const py = (value: number) => MARGIN.top + plotHeight - (value / (top || 1)) * plotHeight
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, xTicks)))
  const empty = all.every((value) => value === 0)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setActive((current) => Math.max(0, Math.min(count - 1, (current ?? count - 1) + (event.key === 'ArrowLeft' ? -1 : 1))))
    } else if (event.key === 'Escape') setActive(null)
  }

  return (
    <div ref={ref} data-tl="bar-chart" className={cx('tl-chart', className)} role="figure" aria-label={label} {...rest}>
      <div ref={measure} className="tl-chart__plot" style={{ height }} tabIndex={count ? 0 : undefined} onKeyDown={onKeyDown} onBlur={() => setActive(null)} onPointerLeave={() => setActive(null)}>
        {empty ? <p className="tl-chart__empty">{emptyLabel}</p> : null}
        <svg width={width} height={height} aria-hidden="true" focusable="false">
          {ticks.map((tick, index) => (
            <g key={tick} className="tl-chart__grid">
              <line x1={left} x2={left + plotWidth} y1={py(tick)} y2={py(tick)} />
              <text x={left - 6} y={py(tick)} textAnchor="end" dominantBaseline="middle">{tickLabels[index]}</text>
            </g>
          ))}
          {categories.map((category, index) => {
            const center = left + band * index + band / 2
            let stackTop = 0
            return (
              <g key={`${category}-${index}`} className="tl-chart__bars" data-active={active === index || undefined} onPointerEnter={() => setActive(index)}>
                <rect className="tl-chart__band" x={left + band * index} y={MARGIN.top} width={band} height={plotHeight} />
                {series.map((item, seriesIndex) => {
                  const value = Math.max(0, item.values[index] ?? 0)
                  if (!value) return null
                  const x = stacked ? center - barWidth / 2 : center - (barWidth * series.length) / 2 + barWidth * seriesIndex
                  const y = py(stacked ? stackTop + value : value)
                  const barHeight = Math.max(1, py(stacked ? stackTop : 0) - y)
                  stackTop += value
                  return <rect key={item.id} x={x + 0.5} y={y} width={Math.max(1, barWidth - 1)} height={barHeight} rx={Math.min(3, barWidth / 3)} fill={item.color ?? chartColor(seriesIndex)} />
                })}
                {index % labelEvery === 0 ? <text className="tl-chart__x" x={center} y={height - 6} textAnchor="middle">{formatCategory(category, index)}</text> : null}
              </g>
            )
          })}
        </svg>
        {active !== null ? (
          <div className="tl-chart__tooltip" style={{ left: left + band * active + band / 2, transform: left + band * active > width * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}>
            <strong>{formatCategory(categories[active]!, active)}</strong>
            {series.map((item, index) => (
              <span key={item.id}>
                <i style={{ background: item.color ?? chartColor(index) }} />
                {item.label}
                <b>{formatY(item.values[active] ?? 0)}</b>
              </span>
            ))}
            {stacked && series.length > 1 ? <span className="tl-chart__total">{formatY(totals[active] ?? 0)}</span> : null}
          </div>
        ) : null}
      </div>
      {legend ?? series.length > 1 ? <ChartLegend items={series.map((item, index) => ({ id: item.id, label: item.label, color: item.color ?? chartColor(index) }))} /> : null}
      <VisuallyHidden>
        {series.map((item) => `${describeSeries(item.label, formatY(finiteValues(item.values).reduce((sum, value) => sum + value, 0)))} `)}
      </VisuallyHidden>
    </div>
  )
})
