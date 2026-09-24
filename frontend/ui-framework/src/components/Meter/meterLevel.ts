export type MeterLevel = 'neutral' | 'optimum' | 'suboptimal' | 'poor'

export interface MeterThresholds {
  min: number
  max: number
  low?: number
  high?: number
  optimum?: number
}

/**
 * Maps a measurement onto the band it falls in.
 *
 * The banding rules are HTML's own, taken from the `<meter>` element rather
 * than invented, because "low" and "high" are not the same as "bad" and "good"
 * and the direction depends entirely on where the optimum sits. Disk usage is
 * best near zero; a battery, a confidence score and a microphone level are best
 * near the top; a room temperature is best in the middle and wrong in both
 * directions. One `optimum` value expresses all three, and the three branches
 * below are what makes the same component colour every one of them correctly.
 *
 * The `neutral` band is the one addition. HTML's defaults (`low = min`,
 * `high = max`, `optimum` at the midpoint) put every value in the optimum band,
 * so a meter with no thresholds configured would render solid green and claim a
 * judgement the caller never made. Without thresholds this returns `neutral`
 * and the component paints the accent instead.
 */
export function meterLevel(value: number, thresholds: MeterThresholds): MeterLevel {
  const { min, max, low, high, optimum } = thresholds

  if (low === undefined && high === undefined && optimum === undefined) {
    return 'neutral'
  }

  // Each bound is clamped into the range and then into its neighbour, matching
  // the constraint-fixing HTML performs on out-of-order attributes: a `low`
  // above `high` is a typo, not a request to invert the scale.
  const lowBound = Math.min(Math.max(low ?? min, min), max)
  const highBound = Math.min(Math.max(high ?? max, lowBound), max)
  const optimumPoint = Math.min(Math.max(optimum ?? (min + max) / 2, min), max)

  if (optimumPoint < lowBound) {
    if (value <= lowBound) return 'optimum'
    if (value <= highBound) return 'suboptimal'
    return 'poor'
  }

  if (optimumPoint > highBound) {
    if (value >= highBound) return 'optimum'
    if (value >= lowBound) return 'suboptimal'
    return 'poor'
  }

  // Optimum sits in the middle band, so there is no "worst" end — being under
  // and being over are equally suboptimal and neither gets the alarm colour.
  return value >= lowBound && value <= highBound ? 'optimum' : 'suboptimal'
}
