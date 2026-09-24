import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useMemo,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import './Field.css'

export interface FieldContextValue {
  /** The id the labelled control must adopt so `<label for>` resolves. */
  id: string
  /** Ids of the hint and error nodes, ready to go into `aria-describedby`. */
  describedBy: string | undefined
  invalid: boolean
  required: boolean
  disabled: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

/**
 * The wiring a control needs from its surrounding `Field`, or `null`.
 *
 * Returning `null` outside a Field rather than throwing is the whole point of
 * this inversion: an `Input` dropped into a toolbar with nothing but an
 * `aria-label` is a legitimate use, and a hook that throws would make the
 * control unusable there.
 */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext)
}

export interface FieldControlOverrides {
  id?: string
  disabled?: boolean
  required?: boolean
  invalid?: boolean
  /** An `aria-describedby` the consumer set directly on the control. */
  describedBy?: string
}

export interface FieldControlProps {
  id: string | undefined
  disabled: boolean
  required: boolean
  invalid: boolean
  describedBy: string | undefined
}

/**
 * Resolves the props a form control should render, given what its consumer
 * passed and what the enclosing Field provides.
 *
 * A value set directly on the control always wins. That ordering matters for
 * the case a Field cannot see: a composite control that is invalid for its own
 * reasons inside a Field that is otherwise fine.
 */
export function useFieldControl(overrides: FieldControlOverrides = {}): FieldControlProps {
  const field = useFieldContext()
  return {
    id: overrides.id ?? field?.id,
    disabled: overrides.disabled ?? field?.disabled ?? false,
    required: overrides.required ?? field?.required ?? false,
    invalid: overrides.invalid ?? field?.invalid ?? false,
    // The Field's own ids come first so the hint is read before whatever extra
    // description the consumer attached; announcement order follows the
    // attribute, not the DOM.
    describedBy: joinIds(field?.describedBy, overrides.describedBy),
  }
}

function joinIds(...ids: Array<string | undefined>): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id))
  return present.length > 0 ? present.join(' ') : undefined
}

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  /** Visible label. Omit only when the control carries its own accessible name. */
  label?: ReactNode
  /** Guidance shown before the control and read out as part of its description. */
  hint?: ReactNode
  /** Validation message. Its presence turns the field invalid unless `invalid` says otherwise. */
  error?: ReactNode
  /** Character/word count rendered opposite the error. */
  counter?: ReactNode
  required?: boolean
  optional?: boolean
  /** Text of the optional marker, so it can be translated. */
  optionalLabel?: ReactNode
  disabled?: boolean
  /** Overrides the invalid state that `error` would otherwise imply. */
  invalid?: boolean
  /** Keeps the label in the accessibility tree but off the screen. */
  labelHidden?: boolean
  /** Id given to the control. Generated when omitted. */
  controlId?: string
}

/**
 * Label, hint, error and id wiring for exactly one form control.
 *
 * WHY THIS EXISTS
 * ---------------
 * Baking the label into the control looks convenient until the first control
 * that has no label, or the first label that has to describe two controls. This
 * component owns the chrome and hands the control its identity through context,
 * so `Input`, `Textarea` and friends stay usable on their own and a group of
 * controls can be wrapped in `Fieldset` instead.
 *
 * ACCESSIBILITY NOTES
 * -------------------
 * - The error node is rendered on every pass, empty when there is nothing to
 *   say. A `role="alert"` region that is inserted at the moment it gains text
 *   is announced unreliably; one that already exists and is then filled is not.
 *   An empty block box with no padding is zero pixels tall, which is why the
 *   spacing here is margins on the children rather than a flex `gap` — a gap
 *   would reserve space around the empty node.
 *
 * - The error is wired through `aria-describedby`, never `aria-errormessage`.
 *   The latter is the semantically better attribute and is still not carried by
 *   enough of the screen-reader/browser matrix to be the only route to the text.
 *
 * - `required` sets `aria-required` on the control but deliberately not the
 *   native `required` attribute. Native constraint validation puts up the UA's
 *   own bubble, which cannot be styled or translated and competes with the
 *   error region below. A consumer who wants the browser to block submission
 *   sets `required` on the control itself, where it means what it says.
 *
 * - The asterisk is `aria-hidden`. Screen readers pronounce it as "star" or
 *   skip it entirely depending on punctuation settings, so the requirement is
 *   carried by `aria-required` and the asterisk is left as a visual convention.
 */
export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  {
    label,
    hint,
    error,
    counter,
    required = false,
    optional = false,
    optionalLabel = 'Optional',
    disabled = false,
    invalid,
    labelHidden = false,
    controlId,
    className,
    children,
    ...rest
  },
  ref,
) {
  if (import.meta.env?.DEV && required && optional) {
    console.error(
      '[t-lingual/ui] <Field> was given both `required` and `optional`. ' +
        'Pick one — the two markers contradict each other.',
    )
  }

  const autoId = useId()
  const id = controlId ?? `${autoId}control`
  const hintId = `${autoId}hint`
  const errorId = `${autoId}error`
  const isInvalid = invalid ?? Boolean(error)
  const hasHint = hint != null

  const context = useMemo<FieldContextValue>(
    () => ({
      id,
      // `errorId` is listed unconditionally. Its node is always present, and a
      // stable `aria-describedby` avoids mutating the attribute of a focused
      // control — several screen readers compute the description once on focus
      // and would never re-read it.
      describedBy: joinIds(hasHint ? hintId : undefined, errorId),
      invalid: isInvalid,
      required,
      disabled,
    }),
    [id, hasHint, hintId, errorId, isInvalid, required, disabled],
  )

  return (
    <div
      {...rest}
      ref={ref}
      data-tl="field"
      data-invalid={isInvalid || undefined}
      data-disabled={disabled || undefined}
      className={cx('tl-field', className)}
    >
      <FieldContext.Provider value={context}>
        {label != null && (
          <label
            htmlFor={id}
            className={cx('tl-field__label', labelHidden && 'tl-visually-hidden')}
          >
            {label}
            {required && (
              <span className="tl-field__marker" aria-hidden="true">
                *
              </span>
            )}
            {optional && !required && (
              <span className="tl-field__optional">{optionalLabel}</span>
            )}
          </label>
        )}

        {hint != null && (
          <p className="tl-field__hint" id={hintId}>
            {hint}
          </p>
        )}

        <div className="tl-field__control">{children}</div>

        <div className="tl-field__footer">
          <p className="tl-field__error" id={errorId} role="alert">
            {error}
          </p>
          {counter != null && (
            /* Not a live region, and hidden from assistive tech. A counter that
             * announced itself would speak over the character echo on every
             * keystroke; the limit belongs in `hint`, where it is read once. */
            <div className="tl-field__counter" aria-hidden="true">
              {counter}
            </div>
          )}
        </div>
      </FieldContext.Provider>
    </div>
  )
})
