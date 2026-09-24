import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { composeRefs } from '../../primitives/Slot'
import { Icon } from '../../icons/Icon'
import { useFieldContext } from '../Field/Field'
import './Checkbox.css'

export type CheckboxSize = 'sm' | 'md' | 'lg'

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'children'> {
  size?: CheckboxSize
  /** The accessible name. Rendered beside the box and clickable. */
  label?: ReactNode
  /** Secondary line under the label, wired up as `aria-describedby`. */
  description?: ReactNode
  /**
   * The third state: neither checked nor unchecked, used by a "select all" that
   * governs a partial selection.
   */
  indeterminate?: boolean
  invalid?: boolean
}

/**
 * A real `<input type="checkbox">` with a drawn box on top of it.
 *
 * The input is not replaced, it is made transparent and stacked over the
 * visual. That is what keeps every native behaviour the framework would
 * otherwise have to reimplement badly: focus and the tab order, label
 * association, participation in a `<form>` and in its constraint validation,
 * autofill, and the `:checked` / `:indeterminate` selectors that drive the
 * appearance without a single line of state. `appearance: none` is deliberately
 * not used — once the element is transparent it buys nothing.
 *
 * `children` is omitted from the props because the rest spread lands on a void
 * element; the label is a prop instead.
 *
 * The whole row is the `<label>`, so the pointer target includes the text. When
 * there is no label the transparent input is inflated instead, which keeps the
 * 24x24 minimum of WCAG 2.2 SC 2.5.8 without making the drawn box bigger.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    size = 'md',
    label,
    description,
    indeterminate = false,
    invalid,
    disabled,
    required,
    id,
    className,
    style,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const inputRef = useRef<HTMLInputElement>(null)
  const setRefs = useMemo(() => composeRefs<HTMLInputElement>(ref, inputRef), [ref])

  const reactId = useId()
  const inputId = id ?? field?.id ?? reactId
  const labelId = `${reactId}-label`
  const descriptionId = `${reactId}-description`

  const isDisabled = disabled ?? field?.disabled ?? false
  const isRequired = required ?? field?.required ?? false
  const isInvalid = invalid ?? field?.invalid ?? false

  // There is no `indeterminate` content attribute — it exists only as an IDL
  // property on the element — so JSX cannot express it and it has to be written
  // to the node after render. Writing it is also what makes the platform report
  // `aria-checked="mixed"`, which is why no ARIA is set here: doing both would
  // be a second source of truth that can drift.
  //
  // Re-asserted on every commit rather than keyed on `[indeterminate]`, because
  // the user agent clears the property itself when the box is clicked. With a
  // dependency list the prop and the DOM would then disagree until the prop
  // happened to change, and the box would show a tick while the API still says
  // mixed. This mirrors how React re-asserts `checked` on a controlled input.
  useEffect(() => {
    const node = inputRef.current
    if (node) node.indeterminate = indeterminate
  })

  // A Field is an accepted source of the name: the input adopts the Field's id
  // above, so the Field's `<label for>` resolves to this control and a labelless
  // Checkbox inside one is correct rather than broken.
  if (
    import.meta.env?.DEV &&
    !field &&
    label == null &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <Checkbox> needs `label`, `aria-label` or `aria-labelledby`.',
    )
  }

  const hasText = label != null || description != null

  return (
    <label
      data-tl="checkbox"
      data-size={size}
      data-disabled={isDisabled || undefined}
      data-invalid={isInvalid || undefined}
      data-has-text={hasText || undefined}
      className={cx('tl-checkbox', className)}
      style={style}
      htmlFor={inputId}
    >
      <span className="tl-checkbox__control">
        <input
          {...rest}
          ref={setRefs}
          type="checkbox"
          id={inputId}
          className="tl-checkbox__input"
          disabled={isDisabled}
          // Native `required` only when this control asked for it. A Field's
          // `required` is announced through `aria-required` instead, because
          // the UA's validation bubble cannot be styled or translated and would
          // compete with the error region the Field already renders.
          required={required}
          aria-required={isRequired || undefined}
          aria-invalid={isInvalid || undefined}
          aria-describedby={cx(
            rest['aria-describedby'],
            field?.describedBy,
            description != null ? descriptionId : undefined,
          )}
          // The description sits inside the <label>, so the implicit name would
          // otherwise swallow it and announce the whole paragraph as the
          // control's name. Naming the label element explicitly keeps the two
          // apart; without a description the implicit association is enough.
          aria-labelledby={
            rest['aria-labelledby'] ??
            (label != null && description != null ? labelId : undefined)
          }
        />
        <span className="tl-checkbox__box" aria-hidden="true">
          <Icon name="check" className="tl-checkbox__glyph tl-checkbox__glyph--check" />
          <Icon name="minus" className="tl-checkbox__glyph tl-checkbox__glyph--dash" />
        </span>
      </span>

      {hasText && (
        <span className="tl-checkbox__text">
          {label != null && (
            <span className="tl-checkbox__label" id={labelId}>
              {label}
            </span>
          )}
          {description != null && (
            <span className="tl-checkbox__description" id={descriptionId}>
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  )
})
