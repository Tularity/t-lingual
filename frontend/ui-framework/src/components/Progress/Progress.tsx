import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import './Progress.css'

export type ProgressVariant = 'accent' | 'success' | 'danger' | 'warning' | 'info'
export type ProgressSize = 'sm' | 'md' | 'lg'

export interface ProgressProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  value?: number
  min?: number
  max?: number
  /** Work is happening but its extent is unknown. Suppresses `aria-valuenow`. */
  indeterminate?: boolean
  variant?: ProgressVariant
  size?: ProgressSize
  /** Accessible name. Required unless `aria-labelledby` names it instead. */
  label?: string
  /** Human phrasing of the value: "3 of 12 files". */
  valueText?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * A task advancing toward completion.
 *
 * INDETERMINATE REPORTS NO VALUE
 * ------------------------------
 * The tempting shortcut is to leave `aria-valuenow={0}` on and let the
 * animation carry the "we do not know" message. That is a lie with a number
 * attached: a screen reader announces "0 percent", which is a specific factual
 * claim about how much of the upload has finished, and the component has no
 * basis for it. Omitting `aria-valuenow` entirely is what the ARIA spec defines
 * as indeterminate, and it is announced as "busy" instead. So `indeterminate`
 * removes the attribute rather than zeroing it.
 *
 * `aria-valuemin` and `aria-valuemax` stay in both modes: the scale is known
 * even when the position on it is not.
 *
 * The bar is `<div role="progressbar">` rather than `<progress>` because the
 * native element cannot be styled to a design system's shape without three
 * vendor-prefixed pseudo-element stacks that disagree with each other, and it
 * offers nothing in return that the role does not already provide.
 */
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  {
    value = 0,
    min = 0,
    max = 100,
    indeterminate = false,
    variant = 'accent',
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
      '[t-lingual/ui] <Progress> needs `label` or `aria-labelledby`. ' +
        'An unnamed progressbar announces a percentage with nothing attached to it.',
    )
  }

  const span = max - min
  const current = clamp(value, min, max)
  // A zero-width range would divide by zero; treating it as complete is the
  // only reading that is not simply wrong.
  const fraction = span > 0 ? (current - min) / span : 1

  return (
    <div
      ref={ref}
      data-tl="progress"
      data-variant={variant}
      data-size={size}
      data-indeterminate={indeterminate || undefined}
      className={cx('tl-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : current}
      aria-valuetext={valueText}
      style={{ ...style, '--_fraction': fraction } as CSSProperties}
      {...rest}
    >
      <span className="tl-progress__indicator" />
    </div>
  )
})
