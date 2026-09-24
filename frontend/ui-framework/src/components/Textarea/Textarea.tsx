import {
  forwardRef,
  useCallback,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type TextareaHTMLAttributes,
} from 'react'
import { cx } from '../../utils/cx'
import { useFieldContext, useFieldControl } from '../Field/Field'
import { toText } from '../Input/inputValue'
import './Textarea.css'

export type TextareaSize = 'sm' | 'md' | 'lg'
export type TextareaVariant = 'default' | 'subtle' | 'ghost'
export type TextareaResize = 'none' | 'vertical' | 'both'

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'prefix'> {
  size?: TextareaSize
  variant?: TextareaVariant
  /** Overrides the enclosing Field's invalid state. */
  invalid?: boolean
  /** Grows the control to fit its content. Forces `resize` to `none`. */
  autoResize?: boolean
  /** Height at rest, in lines. */
  minRows?: number
  /** Ceiling for `autoResize`, in lines. Past it the control scrolls. */
  maxRows?: number
  /** Ignored while `autoResize` is on. */
  resize?: TextareaResize
  /** Class for the `<textarea>` itself; `className` styles the surrounding box. */
  controlClassName?: string
}

interface SizerStyle extends CSSProperties {
  '--_max-rows'?: number
}

/**
 * A multi-line text control, with the same Field wiring as `Input`.
 *
 * AUTO-RESIZE
 * -----------
 * The growth is done by CSS, not by measurement. The control and a `::after`
 * pseudo-element on its wrapper occupy the same single-cell grid; the
 * pseudo-element replicates the value through `content: attr(...)` and is
 * invisible, so the grid row is always exactly as tall as the text and the
 * stretched textarea follows it.
 *
 * The obvious alternative — read `scrollHeight` in an effect and write `height`
 * back — costs a forced synchronous layout on every keystroke, and doing that
 * inside an effect means the browser paints the old height first, so fast
 * typing visibly lags the caret. The replicated element has neither problem
 * because the browser never leaves its own layout pass. What it costs instead
 * is one attribute write per keystroke and a mirror of the value in state,
 * which is why `autoResize` is opt-in rather than the default.
 *
 * One known limit: an uncontrolled control whose value is changed by something
 * other than the user (a `ref.current.value = …` assignment) will not re-mirror
 * until the next input event, because nothing tells React that it happened.
 * `Input`'s `setNativeValue` is the supported way to do that.
 *
 * `field-sizing: content` will replace all of this when Firefox and Safari have
 * it; today it is Chromium-only, and a control that grows in one browser and
 * not the others is worse than one that grows nowhere.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    size = 'md',
    variant = 'default',
    invalid: invalidProp,
    autoResize = false,
    minRows = 3,
    maxRows,
    resize = 'vertical',
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
      '[t-lingual/ui] <Textarea> has no accessible name. Wrap it in <Field label=…>, ' +
        'pass `aria-label`/`aria-labelledby`, or give it an `id` that your own ' +
        '<label for> points at. A `placeholder` is not a label.',
    )
  }

  const [typed, setTyped] = useState(() => toText(defaultValue))
  const mirror = value !== undefined ? toText(value) : typed

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setTyped(event.target.value)
      onChange?.(event)
    },
    [onChange],
  )

  const sizerStyle: SizerStyle | undefined =
    autoResize && maxRows != null ? { '--_max-rows': maxRows } : undefined

  return (
    <div
      data-tl="textarea"
      data-size={size}
      data-variant={variant}
      data-invalid={control.invalid || undefined}
      data-disabled={control.disabled || undefined}
      data-readonly={readOnly || undefined}
      data-auto-resize={autoResize || undefined}
      data-clamped={(autoResize && maxRows != null) || undefined}
      data-resize={autoResize ? 'none' : resize}
      className={cx('tl-textarea', className)}
      style={style}
    >
      <div
        className="tl-textarea__sizer"
        style={sizerStyle}
        // The trailing space is not cosmetic: `content` collapses a lone
        // trailing newline, so without it the control fails to grow on the
        // keystroke that opens a new line and only catches up on the next one.
        data-replicated-value={autoResize ? `${mirror} ` : undefined}
      >
        <textarea
          {...rest}
          ref={ref}
          id={control.id}
          rows={minRows}
          className={cx('tl-textarea__control', controlClassName)}
          data-tl="textarea-control"
          data-focus-ring="none"
          disabled={control.disabled}
          readOnly={readOnly}
          // Native `required` only when this control asked for it; a Field's
          // `required` is announced through `aria-required` instead, so the UA
          // validation bubble never competes with the Field's error region.
          required={requiredProp}
          aria-required={control.required || undefined}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          value={value}
          defaultValue={defaultValue}
          onChange={autoResize ? handleChange : onChange}
        />
      </div>
    </div>
  )
})
