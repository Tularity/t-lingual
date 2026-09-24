import { forwardRef, useId, type FieldsetHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../../utils/cx'
import { VisuallyHidden } from '../../primitives/VisuallyHidden'
import './Fieldset.css'

export interface FieldsetProps extends FieldsetHTMLAttributes<HTMLFieldSetElement> {
  /** Names the group. Rendered as `<legend>`, which is what gives the group its accessible name. */
  legend: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  optional?: boolean
  optionalLabel?: ReactNode
  /** Overrides the invalid state that `error` would otherwise imply. */
  invalid?: boolean
  /** Keeps the legend in the accessibility tree but off the screen. */
  legendHidden?: boolean
}

/**
 * A genuine group of related controls: a set of radios, a pair of date inputs,
 * an address block.
 *
 * Reach for this only when one caption really does describe several controls.
 * A `<fieldset>` around a single input adds a group boundary that a screen
 * reader announces on entry and exit for no benefit — that case is `Field`.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - `disabled` is the native attribute rather than a simulation, because it is
 *   the only thing in HTML that disables an entire subtree. Note the one spec
 *   quirk it carries: controls inside the *first* `<legend>` stay enabled.
 *
 * - There is no `aria-required` here. `aria-required` is not allowed on
 *   `role="group"`, so a required group states its requirement in the
 *   accessible name instead: the visible asterisk is `aria-hidden` and a
 *   visually hidden "(required)" rides along inside the legend.
 *
 * - Same error strategy as `Field`: an always-present `role="alert"` node wired
 *   through `aria-describedby`, because a live region inserted at the moment it
 *   gains text is announced unreliably.
 */
export const Fieldset = forwardRef<HTMLFieldSetElement, FieldsetProps>(function Fieldset(
  {
    legend,
    hint,
    error,
    required = false,
    optional = false,
    optionalLabel = 'Optional',
    invalid,
    legendHidden = false,
    disabled = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  if (import.meta.env?.DEV && required && optional) {
    console.error(
      '[t-lingual/ui] <Fieldset> was given both `required` and `optional`. ' +
        'Pick one — the two markers contradict each other.',
    )
  }

  const autoId = useId()
  const hintId = `${autoId}hint`
  const errorId = `${autoId}error`
  const isInvalid = invalid ?? Boolean(error)

  const describedBy = [hint != null ? hintId : undefined, errorId]
    .filter((id): id is string => Boolean(id))
    .join(' ')

  return (
    <fieldset
      {...rest}
      ref={ref}
      disabled={disabled}
      data-tl="fieldset"
      data-invalid={isInvalid || undefined}
      data-disabled={disabled || undefined}
      className={cx('tl-fieldset', className)}
      // `cx` is a space joiner, which is exactly the shape of an ARIA id list.
      // Merged rather than assigned: this attribute is set after the rest
      // spread, so overwriting it would silently drop a description the
      // consumer attached. The group's own ids come first, matching Field, so
      // the hint is read before whatever extra description follows it.
      aria-describedby={cx(describedBy, rest['aria-describedby'])}
      aria-invalid={isInvalid || undefined}
    >
      <legend className={cx('tl-fieldset__legend', legendHidden && 'tl-visually-hidden')}>
        {legend}
        {required && (
          <>
            <span className="tl-fieldset__marker" aria-hidden="true">
              *
            </span>
            <VisuallyHidden> (required)</VisuallyHidden>
          </>
        )}
        {optional && !required && (
          <span className="tl-fieldset__optional">{optionalLabel}</span>
        )}
      </legend>

      {hint != null && (
        <p className="tl-fieldset__hint" id={hintId}>
          {hint}
        </p>
      )}

      <div className="tl-fieldset__body">{children}</div>

      <p className="tl-fieldset__error" id={errorId} role="alert">
        {error}
      </p>
    </fieldset>
  )
})
