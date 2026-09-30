import { forwardRef, useId, useMemo, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import { chartColor, finiteValues, niceTicks, useChartWidth } from './chartScale'
import './Chart.css'

/** One line, bar set or stack of values, named for the legend and tooltip. */
export interface ChartSeries {
  id: string
  label: string
  /** One value per x position; null is a gap, not a zero. */
  values: ReadonlyArray<number | null | undefined>
  /** Any CSS colour; defaults to the series' place in the chart palette. */
  color?: string
  /** Shade the area under the line. */
  area?: boolean
  dashed?: boolean
}

export interface ChartThreshold {
  value: number
  label: string
}

export interface LineChartProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Accessible name of the whole chart. */
  label: string
  /** The x positions, in order: timestamps in milliseconds or labels. */
  x: ReadonlyArray<number | string>
  series: ReadonlyArray<ChartSeries>
  height?: number
  yMin?: number
  yMax?: number
  formatY?: (value: number) => string
  formatX?: (value: number | string, index: number) => string
  /** About how many value gridlines to draw. */
  yTicks?: number
  /** About how many x labels to show. */
  xTicks?: number
  legend?: boolean
  /** Dashed reference lines: a budget, a limit. */
  thresholds?: ReadonlyArray<ChartThreshold>
  emptyLabel?: ReactNode
  /** The screen-reader sentence for one series; `latest` and `highest` are null without data. */
  describeSeries?: (label: string, latest: string | null, highest: string | null) => string
}

const MARGIN = { top: 10, right: 12, bottom: 22 }

function describeInEnglish(label: string, latest: string | null, highest: string | null) {
  return latest === null ? `${label}: no data.` : `${label}: latest ${latest}, highest ${highest}.`
}

/**
 * Values over time as lines.
 *
 * Drawn at the container's own pixel width rather than a scaled viewBox, so
 * labels stay at the type size and strokes stay hairlines on a narrow card.
 * A null value breaks the line instead of dropping it to zero: a sample that
 * failed is missing, and drawing it as "nothing happened" would lie.
 *
 * The reading under the pointer is also reachable from the keyboard: the
 * chart takes focus and the arrow keys move along x, so the tooltip is not
 * information only a mouse can reach. A visually hidden summary gives each
 * series' latest and highest value to a screen reader.
 */
export const LineChart = forwardRef<HTMLDivElement, LineChartProps>(function LineChart(
  { label, x, series, height = 200, yMin, yMax, formatY = String, formatX = (value) => String(value), yTicks = 4,
    xTicks = 5, legend, thresholds = [], emptyLabel = 'No data yet', describeSeries = describeInEnglish, className, ...rest },
  ref,
) {
  const [measure, width] = useChartWidth()
  const [active, setActive] = useState<number | null>(null)
  const gradientId = useId().replace(/:/g, '')
  const all = useMemo(() => series.flatMap((item) => finiteValues(item.values)), [series])
  const ticks = useMemo(() => {
    const low = yMin ?? Math.min(0, ...all, ...thresholds.map((line) => line.value))
    const high = yMax ?? Math.max(...(all.length ? all : [1]), ...thresholds.map((line) => line.value))
    return niceTicks(low, high, yTicks)
  }, [all, thresholds, yMin, yMax, yTicks])
  const bottom = ticks[0] ?? 0
  const top = ticks[ticks.length - 1] ?? 1
  const tickLabels = ticks.map((tick) => formatY(tick))
  const left = Math.max(28, Math.max(...tickLabels.map((text) => text.length)) * 6.4 + 10)
  const plotWidth = Math.max(10, width - left - MARGIN.right)
  const plotHeight = Math.max(10, height - MARGIN.top - MARGIN.bottom)
  const count = x.length
  const px = (index: number) => left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth)
  const py = (value: number) => MARGIN.top + plotHeight - ((value - bottom) / (top - bottom || 1)) * plotHeight
  const baseline = py(Math.max(bottom, Math.min(0, top)))

  const paths = series.map((item) => {
    let line = ''
    let area = ''
    let run: Array<[number, number]> = []
    const close = () => {
      if (run.length) {
        line += run.map(([cx, cy], index) => `${index ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`).join('')
        const first = run[0]!
        const last = run[run.length - 1]!
        area += `M${first[0].toFixed(1)} ${baseline.toFixed(1)}` + run.map(([cx, cy]) => `L${cx.toFixed(1)} ${cy.toFixed(1)}`).join('') + `L${last[0].toFixed(1)} ${baseline.toFixed(1)}Z`
      }
      run = []
    }
    item.values.forEach((value, index) => {
      if (typeof value === 'number' && Number.isFinite(value)) run.push([px(index), py(Math.min(top, Math.max(bottom, value)))])
      else close()
    })
    close()
    return { line, area }
  })

  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, xTicks)))
  const showLegend = legend ?? series.length > 1
  const pick = (event: PointerEvent<SVGRectElement>) => {
    if (!count) return
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = box.width ? (event.clientX - box.left) / box.width : 0
    setActive(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 }
    if (event.key in moves) {
      event.preventDefault()
      setActive((current) => Math.max(0, Math.min(count - 1, (current ?? count - 1) + moves[event.key]!)))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : count - 1)
    } else if (event.key === 'Escape') setActive(null)
  }

  return (
    <div ref={ref} data-tl="line-chart" className={cx('tl-chart', className)} role="figure" aria-label={label} {...rest}>
      <div ref={measure} className="tl-chart__plot" style={{ height }} tabIndex={count ? 0 : undefined} onKeyDown={onKeyDown} onBlur={() => setActive(null)}>
        {all.length === 0 ? <p className="tl-chart__empty">{emptyLabel}</p> : null}
        <svg width={width} height={height} aria-hidden="true" focusable="false">
          <defs>
            {series.map((item, index) => (
              <linearGradient key={item.id} id={`${gradientId}-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={item.color ?? chartColor(index)} stopOpacity="0.22" />
                <stop offset="100%" stopColor={item.color ?? chartColor(index)} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((tick, index) => (
            <g key={tick} className="tl-chart__grid">
              <line x1={left} x2={left + plotWidth} y1={py(tick)} y2={py(tick)} />
              <text x={left - 6} y={py(tick)} textAnchor="end" dominantBaseline="middle">{tickLabels[index]}</text>
            </g>
          ))}
          {x.map((value, index) => index % labelEvery === 0 || index === count - 1 && count > 1 && (count - 1) % labelEvery > labelEvery / 2
            ? <text key={index} className="tl-chart__x" x={px(index)} y={height - 6} textAnchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}>{formatX(value, index)}</text>
            : null)}
          {thresholds.map((line) => (
            <g key={line.label} className="tl-chart__threshold">
              <line x1={left} x2={left + plotWidth} y1={py(line.value)} y2={py(line.value)} />
              <text x={left + plotWidth} y={py(line.value) - 4} textAnchor="end">{line.label}</text>
            </g>
          ))}
          {series.map((item, index) => (
            <g key={item.id} className="tl-chart__series" data-dashed={item.dashed || undefined}>
              {item.area && paths[index]!.area ? <path d={paths[index]!.area} fill={`url(#${gradientId}-${index})`} /> : null}
              <path d={paths[index]!.line} fill="none" stroke={item.color ?? chartColor(index)} />
            </g>
          ))}
          {active !== null ? (
            <g className="tl-chart__cursor">
              <line x1={px(active)} x2={px(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />
              {series.map((item, index) => {
                const value = item.values[active]
                return typeof value === 'number' && Number.isFinite(value)
                  ? <circle key={item.id} cx={px(active)} cy={py(Math.min(top, Math.max(bottom, value)))} r="3.5" fill={item.color ?? chartColor(index)} />
                  : null
              })}
            </g>
          ) : null}
          <rect className="tl-chart__hit" x={left} y={MARGIN.top} width={plotWidth} height={plotHeight} onPointerMove={pick} onPointerLeave={() => setActive(null)} />
        </svg>
        {active !== null ? (
          <div className="tl-chart__tooltip" style={{ left: Math.min(px(active), width - 8), transform: px(active) > width * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}>
            <strong>{formatX(x[active]!, active)}</strong>
            {series.map((item, index) => {
              const value = item.values[active]
              return (
                <span key={item.id}>
                  <i style={{ background: item.color ?? chartColor(index) }} />
                  {item.label}
                  <b>{typeof value === 'number' && Number.isFinite(value) ? formatY(value) : '—'}</b>
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
      {showLegend ? <ChartLegend items={series.map((item, index) => ({ id: item.id, label: item.label, color: item.color ?? chartColor(index), dashed: item.dashed }))} /> : null}
      <VisuallyHidden>
        {series.map((item) => {
          const values = finiteValues(item.values)
          return `${values.length ? describeSeries(item.label, formatY(values[values.length - 1]!), formatY(Math.max(...values))) : describeSeries(item.label, null, null)} `
        })}
      </VisuallyHidden>
    </div>
  )
})

export interface ChartLegendItem {
  id: string
  label: ReactNode
  color: string
  dashed?: boolean
  detail?: ReactNode
}

/** The key to a chart's colours: every series named beside its swatch. */
export function ChartLegend({ items, className }: { items: ReadonlyArray<ChartLegendItem>; className?: string }) {
  return (
    <ul className={cx('tl-chart__legend', className)}>
      {items.map((item) => (
        <li key={item.id}>
          <i data-dashed={item.dashed || undefined} style={{ background: item.color }} aria-hidden="true" />
          <span>{item.label}</span>
          {item.detail != null ? <b>{item.detail}</b> : null}
        </li>
      ))}
    </ul>
  )
}
