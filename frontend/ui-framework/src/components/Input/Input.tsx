import {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { composeRefs } from '../../primitives/Slot'
import { Icon } from '../../icons/Icon'
import { useFieldContext, useFieldControl } from '../Field/Field'
import { setNativeValue, toText } from './inputValue'
import './Input.css'

export type InputSize = 'sm' | 'md' | 'lg'
export type InputVariant = 'default' | 'subtle' | 'ghost'

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: InputSize
  variant?: InputVariant
  /** Leading adornment: a currency symbol, a protocol, an icon. */
  prefix?: ReactNode
  /** Trailing adornment: a unit, a visibility toggle, a count. */
  suffix?: ReactNode
  /** Set when `prefix` contains something the user can operate. */
  interactivePrefix?: boolean
  /** Set when `suffix` contains something the user can operate. */
  interactiveSuffix?: boolean
  /** Overrides the enclosing Field's invalid state. */
  invalid?: boolean
  /** Shows a clear button whenever the control holds a value. */
  clearable?: boolean
  /** Called after the value has been cleared. */
  onClear?: () => void
  /** Accessible name of the clear button. */
  clearLabel?: string
  /** Glyph inside the clear button. */
  clearIcon?: ReactNode
  /** Class for the `<input>` itself; `className` styles the surrounding box. */
  controlClassName?: string
  /**
   * Test and style hook on the box. Controls built on top of `Input` — such as
   * `SearchInput` — override it so they are addressable as themselves rather
   * than disappearing into the generic input selector.
   */
  'data-tl'?: string
}

/**
 * A single-line text control.
 *
 * It consumes `FieldContext` for its id, description, required and invalid
 * state, and works with none of that present — an `Input` with an `aria-label`
 * in a toolbar is a first-class use, not a degraded one.
 *
 * DECISIONS WORTH KNOWING
 * -----------------------
 * - The visible box is the wrapper, not the `<input>`. That is what lets an
 *   adornment sit inside the border and share the focus ring. The consequence
 *   is that `className` and `style` land on the wrapper while every other prop
 *   lands on the control, because `width` and `margin` are what people reach
 *   for and they belong to the box. `controlClassName` is the escape hatch.
 *
 * - The focus ring is drawn on the wrapper, so the control opts out of the
 *   framework's automatic ring with `data-focus-ring="none"`. Without that opt
 *   out there would be two rings, one of them hugging the bare text field.
 *
 * - The wrapper focuses the control when the padding or a decorative adornment
 *   is clicked, which is the behaviour a full-bleed `<label>` would give. It
 *   checks the event target for an enclosing operable element first, so an
 *   interactive adornment keeps its own click. This is why a decorative
 *   adornment is `pointer-events: none` in CSS — the click has to reach the
 *   wrapper for the handler to see it at all.
 *
 * - `required` from a Field becomes `aria-required` only. The native attribute
 *   is set only when the consumer puts `required` on this control directly, so
 *   that opting into the UA's validation bubble stays an explicit choice.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    variant = 'default',
    prefix,
    suffix,
    interactivePrefix = false,
    interactiveSuffix = false,
    invalid: invalidProp,
    clearable = false,
    onClear,
    clearLabel = 'Clear',
    clearIcon,
    controlClassName,
    className,
    style,
    disabled: disabledProp,
    required: requiredProp,
    readOnly = false,
    id: idProp,
    value,
    defaultValue,
    onChange,
    type = 'text',
    'data-tl': dataTl = 'input',
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const control = useFieldControl({
    id: idProp,
    disabled: disabledProp,
    required: requiredProp,
    invalid: invalidProp,
    describedBy: rest['aria-describedby'],
  })

  if (
    import.meta.env?.DEV &&
    !field &&
    !rest['aria-label'] &&
    !rest['aria-labelledby'] &&
    !idProp
  ) {
    console.error(
      '[t-lingual/ui] <Input> has no accessible name. Wrap it in <Field label=…>, ' +
        'pass `aria-label`/`aria-labelledby`, or give it an `id` that your own ' +
        '<label for> points at. A `placeholder` is not a label.',
    )
  }

  const innerRef = useRef<HTMLInputElement>(null)
  const mergedRef = useMemo(() => composeRefs<HTMLInputElement>(ref, innerRef), [ref])

  // Only the emptiness of the value matters here, and only for the clear
  // button. A controlled control reads it off the prop; an uncontrolled one
  // cannot be read during render, so its emptiness is tracked from the events
  // it emits — including the synthetic one `setNativeValue` dispatches.
  const [typedSomething, setTypedSomething] = useState(() => toText(defaultValue) !== '')
  const hasValue = value !== undefined ? toText(value) !== '' : typedSomething

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setTypedSomething(event.target.value !== '')
      onChange?.(event)
    },
    [onChange],
  )

  const clear = useCallback(() => {
    const node = innerRef.current
    if (!node) return
    setNativeValue(node, '')
    onClear?.()
    // The button is about to unmount with focus inside it. Moving focus back to
    // the control keeps the keyboard user where they were instead of dumping
    // them at the top of the document.
    node.focus()
  }, [onClear])

  const focusOnBoxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const node = innerRef.current
    const target = event.target as Element | null
    if (!node || !target) return

    // Anything the user can operate keeps its own click; only dead space in the
    // box forwards focus. The containment test matters because `closest` keeps
    // walking past the box — a form control inside a focusable card would
    // otherwise look like an adornment and suppress the behaviour entirely.
    const operable = target.closest('button, a, input, select, textarea, label, [tabindex]')
    if (operable && event.currentTarget.contains(operable)) return

    event.preventDefault()
    node.focus()
  }, [])

  const showClear = clearable && hasValue && !control.disabled && !readOnly

  return (
    <div
      data-tl={dataTl}
      data-size={size}
      data-variant={variant}
      data-invalid={control.invalid || undefined}
      data-disabled={control.disabled || undefined}
      data-readonly={readOnly || undefined}
      className={cx('tl-input', className)}
      style={style}
      onMouseDown={focusOnBoxClick}
    >
      {prefix != null && (
        <span
          className="tl-input__adornment"
          data-side="start"
          data-interactive={interactivePrefix || undefined}
          aria-hidden={interactivePrefix ? undefined : true}
        >
          {prefix}
        </span>
      )}

      <input
        {...rest}
        ref={mergedRef}
        type={type}
        id={control.id}
        className={cx('tl-input__control', controlClassName)}
        data-tl="input-control"
        data-focus-ring="none"
        disabled={control.disabled}
        readOnly={readOnly}
        // Native `required` only when this control asked for it; the Field's
        // `required` is announced through `aria-required` instead.
        required={requiredProp}
        aria-required={control.required || undefined}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        value={value}
        defaultValue={defaultValue}
        // Pass the consumer's handler straight through unless the clear button
        // needs to watch the value. Always interposing would also silence
        // React's warning about a `value` with no `onChange`, which is a real
        // bug report the consumer should keep getting.
        onChange={clearable ? handleChange : onChange}
      />

      {suffix != null && (
        <span
          className="tl-input__adornment"
          data-side="end"
          data-interactive={interactiveSuffix || undefined}
          aria-hidden={interactiveSuffix ? undefined : true}
        >
          {suffix}
        </span>
      )}

      {showClear && (
        <button
          type="button"
          className="tl-input__clear"
          data-tl="input-clear"
          aria-label={clearLabel}
          onClick={clear}
        >
          {clearIcon ?? <Icon name="close" />}
        </button>
      )}
    </div>
  )
})
