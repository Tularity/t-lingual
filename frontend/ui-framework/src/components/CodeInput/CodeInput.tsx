import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react'
import { cx } from '../../utils/cx'
import { composeRefs } from '../../primitives/Slot'
import { useFieldContext, useFieldControl } from '../Field/Field'
import './CodeInput.css'

export type CodeInputSize = 'md' | 'lg'

export interface CodeInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'size' | 'maxLength' | 'type' | 'children'> {
  /** How many characters the code has. */
  length?: number
  value: string
  onValueChange: (value: string) => void
  /** Called as the last character is entered, with the whole code. */
  onComplete?: (code: string) => void
  /** Digits only, or letters and digits (upper-cased as they are typed). */
  characters?: 'digits' | 'alphanumeric'
  /** Tiles per group, with a wider gap between groups; 0 for one run. */
  group?: number
  /** Overrides the enclosing Field's invalid state. A code turning invalid shakes. */
  invalid?: boolean
  /** The code is being checked: the tiles ripple, and it cannot be changed. */
  busy?: boolean
  size?: CodeInputSize
}

/**
 * A short code — a one-time sign-in code, say — entered into a row of large
 * tiles, one character each.
 *
 * DECISIONS WORTH KNOWING
 * -----------------------
 * - One field, many tiles. The tiles are only drawn; the typing goes into a
 *   single real, transparent `<input>` laid over them. That keeps everything a
 *   field does for free — paste, autofill from a text message
 *   (`autocomplete="one-time-code"`), undo, input methods, and a screen
 *   reader meeting one labelled field — which a row of separate inputs each
 *   has to fake, and usually gets wrong.
 *
 * - The caret lives at the end. A code is typed in order and corrected from
 *   the end, so arrow keys and clicks put the caret after the last character;
 *   the next tile to fill is the one that shows it.
 *
 * - `onComplete` fires from the change that fills the last tile, so a form
 *   can go on without a submit button — and does not fire again while the
 *   code stays whole.
 *
 * - A wrong code stays in view, marked, so it can be read back. Typing starts
 *   a fresh one; Backspace corrects it from the end. Pasting a whole code
 *   always replaces what is there, and completes.
 *
 * It consumes `FieldContext` for its id, description and invalid state, like
 * `Input`, and works with an `aria-label` alone.
 */
export const CodeInput = forwardRef<HTMLInputElement, CodeInputProps>(function CodeInput(
  {
    length = 6,
    value,
    onValueChange,
    onComplete,
    characters = 'digits',
    group = 3,
    invalid: invalidProp,
    busy = false,
    size = 'lg',
    disabled: disabledProp,
    id: idProp,
    className,
    style,
    onFocus,
    onBlur,
    onKeyDown,
    onSelect,
    onPaste,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const control = useFieldControl({ id: idProp, disabled: disabledProp, invalid: invalidProp, describedBy: rest['aria-describedby'] })
  const input = useRef<HTMLInputElement>(null)
  const setRefs = useMemo(() => composeRefs<HTMLInputElement>(ref, input), [ref])
  const [focused, setFocused] = useState(false)

  if (import.meta.env?.DEV && !field && !rest['aria-label'] && !rest['aria-labelledby'] && !idProp) {
    console.error('[t-lingual/ui] <CodeInput> has no accessible name. Wrap it in <Field label=…> or pass `aria-label`.')
  }

  const clean = (text: string) =>
    (characters === 'digits' ? text.replace(/\D/gu, '') : text.toUpperCase().replace(/[^A-Z0-9]/gu, '')).slice(0, length)
  const code = clean(value)

  const toEnd = () => {
    const node = input.current
    if (node && node === document.activeElement) node.setSelectionRange(node.value.length, node.value.length)
  }

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const next = clean(event.target.value)
    onValueChange(next)
    if (next.length === length && code.length < length) onComplete?.(next)
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    // The caret stays after the last character.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.preventDefault()
    // A whole code marked wrong is started afresh by the next character.
    else if (control.invalid && code.length === length && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && clean(event.key)) {
      event.preventDefault()
      onValueChange(clean(event.key))
    }
  }

  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    onPaste?.(event)
    if (event.defaultPrevented) return
    const pasted = clean(event.clipboardData.getData('text'))
    if (pasted.length !== length) return
    event.preventDefault()
    onValueChange(pasted)
    onComplete?.(pasted)
  }

  const locked = control.disabled || busy
  // The next tile to fill; a whole code has none.
  const active = focused && !locked && code.length < length ? code.length : -1
  const breaks = group > 0 ? Math.ceil(length / group) - 1 : 0
  return (
    <div
      className={cx('tl-code-input', className)}
      style={{ '--_length': length, '--_breaks': breaks, ...style } as CSSProperties}
      data-tl="code-input"
      data-size={size}
      data-invalid={control.invalid || undefined}
      data-busy={busy || undefined}
      data-disabled={control.disabled || undefined}
      data-complete={code.length === length || undefined}
      data-focused={(focused && !locked) || undefined}
    >
      <div className="tl-code-input__cells" aria-hidden="true">
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className="tl-code-input__cell"
            style={{ '--_i': i } as CSSProperties}
            data-filled={i < code.length || undefined}
            data-active={i === active || undefined}

            data-group-end={(group > 0 && (i + 1) % group === 0 && i < length - 1) || undefined}
          >
            {i < code.length && <span key={code[i]} className="tl-code-input__char">{code[i]}</span>}
          </span>
        ))}
      </div>
      <input
        {...rest}
        ref={setRefs}
        id={control.id}
        className="tl-code-input__control"
        data-tl="code-input-control"
        data-focus-ring="none"
        // A dialog or drawer it opens in starts focus here rather than on its first control.
        data-autofocus={rest.autoFocus || undefined}
        type="text"
        inputMode={characters === 'digits' ? 'numeric' : 'text'}
        autoComplete="one-time-code"
        autoCapitalize={characters === 'digits' ? 'off' : 'characters'}
        autoCorrect="off"
        spellCheck={false}
        pattern={characters === 'digits' ? '[0-9]*' : undefined}
        maxLength={length}
        value={code}
        disabled={control.disabled}
        readOnly={busy || rest.readOnly}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        aria-busy={busy || undefined}
        onChange={change}
        onKeyDown={keyDown}
        onPaste={paste}
        onSelect={(event) => { onSelect?.(event); toEnd() }}
        onFocus={(event) => { setFocused(true); onFocus?.(event) }}
        onBlur={(event) => { setFocused(false); onBlur?.(event) }}
      />
    </div>
  )
})
