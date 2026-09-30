import { useCallback, useEffect, useState } from 'react'

/**
 * Round tick values covering [min, max] in about `count` steps of 1, 2 or 5
 * times a power of ten — the steps a reader can add up in their head.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (max < min) [min, max] = [max, min]
  if (max === min) {
    if (max === 0) return [0, 1]
    const pad = Math.abs(max) * 0.5
    min -= pad
    max += pad
  }
  const rough = (max - min) / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(rough))
  const fraction = rough / power
  const step = (fraction >= 7.5 ? 10 : fraction >= 3.5 ? 5 : fraction >= 1.5 ? 2 : 1) * power
  const start = Math.floor(min / step + 1e-9) * step
  const end = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let value = start; value <= end + step * 1e-6; value += step) ticks.push(Number(value.toPrecision(12)))
  return ticks.length > 1 ? ticks : [start, start + step]
}

/** The nth categorical series colour. */
export function chartColor(index: number) {
  return `var(--tl-chart-${(((index % 8) + 8) % 8) + 1})`
}

/** Finite values only: the domain of a series with gaps. */
export function finiteValues(values: ReadonlyArray<number | null | undefined>) {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

/**
 * The width a chart has to draw in, kept in step with its box. Charts draw
 * in real pixels rather than scaling a fixed viewBox, so labels stay at the
 * type size and lines at their stroke width whatever the container.
 */
export function useChartWidth(fallback = 480) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0)
      if (measured > 0) setWidth(measured)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  const ref = useCallback((element: HTMLElement | null) => setNode(element), [])
  return [ref, width] as const
}
