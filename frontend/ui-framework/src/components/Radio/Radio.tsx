import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useMemo,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import { useFieldContext } from '../Field/Field'
import './Radio.css'

export type RadioSize = 'sm' | 'md' | 'lg'
/** `card` presents each option as a bordered tile rather than a bare row. */
export type RadioVariant = 'default' | 'card'
export type RadioGroupOrientation = 'horizontal' | 'vertical'

interface RadioGroupContextValue {
  name: string
  value: string
  select: (next: string) => void
  size: RadioSize
  variant: RadioVariant
  disabled: boolean
  /**
   * The group's own `required`, which is what arms the native attribute on each
   * option. A Field's `required` is announced as `aria-required` on the group
   * instead and deliberately does not reach here.
   */
  required: boolean
  invalid: boolean
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

export interface RadioGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /**
   * The shared form-control name. Generated when omitted, which is fine for a
   * group read through `onValueChange` but wrong for native form submission —
   * pass a real name whenever the surrounding `<form>` is what reads the value.
   */
  name?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  orientation?: RadioGroupOrientation
  variant?: RadioVariant
  size?: RadioSize
  /** Visible group label. Also becomes the group's accessible name. */
  label?: ReactNode
  disabled?: boolean
  required?: boolean
  invalid?: boolean
}

/**
 * A set of mutually exclusive options.
 *
 * The group owns the name and the value; the children are native
 * `<input type="radio">` elements that all share that name. That is the whole
 * reason this is not a div-based reimplementation: a named radio group already
 * gets the WAI-ARIA radio group keyboard contract from the browser — arrow keys
 * move between options and check as they go, the group is a single tab stop,
 * and focus wraps at the ends — and every hand-rolled version of that has to
 * re-derive roving tabindex, which is where the bugs live. Nothing here
 * intercepts arrow keys.
 *
 * NAMING
 * ------
 * A group needs an explicit name, and a surrounding `Field` cannot supply one
 * on its own: `<label for>` names a labelable element, and a `<div>` carrying
 * `role="radiogroup"` is not one — engines disagree about whether to honour it
 * anyway, so relying on it ships a name that exists in Chrome and not in
 * Safari. The group still adopts the Field's id, which costs nothing and picks
 * the association up wherever it is honoured, but `label` (or `aria-label`) is
 * the route that actually works, and development builds say so.
 */
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    name,
    value,
    defaultValue,
    onValueChange,
    orientation = 'vertical',
    variant = 'default',
    size = 'md',
    label,
    disabled,
    required,
    invalid,
    id,
    className,
    children,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const reactId = useId()
  const groupId = id ?? field?.id ?? reactId
  // Built from the React id rather than from `groupId`, which may have come
  // from a consumer or a Field and is therefore not guaranteed to be unique to
  // this instance the way a derived label id has to be.
  const labelId = `${reactId}-label`

  // The empty string is the "nothing selected yet" sentinel. A radio whose
  // value is the empty string is not a thing anyone ships, and the alternative
  // — widening the state to `string | undefined` — leaks an optional through
  // every consumer's change handler for no gain.
  const [selected, setSelected] = useControllableState<string>({
    value,
    defaultValue: defaultValue ?? '',
    onChange: onValueChange,
  })

  const isDisabled = disabled ?? field?.disabled ?? false
  const isRequired = required ?? field?.required ?? false
  const isInvalid = invalid ?? field?.invalid ?? false
  const groupName = name ?? groupId

  const context = useMemo<RadioGroupContextValue>(
    () => ({
      name: groupName,
      value: selected,
      select: setSelected,
      size,
      variant,
      disabled: isDisabled,
      // The group's own opt-in, not the Field-resolved value: this is what arms
      // the native `required` on each option, and a Field's `required` is meant
      // to be announced through `aria-required` below rather than to summon the
      // UA's validation bubble over the Field's own error region.
      required: required ?? false,
      invalid: isInvalid,
    }),
    [groupName, selected, setSelected, size, variant, isDisabled, required, isInvalid],
  )

  if (
    import.meta.env?.DEV &&
    label == null &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <RadioGroup> has no accessible name. Pass `label`, ' +
        '`aria-label` or `aria-labelledby`. A surrounding <Field> label is not ' +
        'enough on its own — `<label for>` does not name a radiogroup.',
    )
  }

  return (
    <div
      {...rest}
      ref={ref}
      id={groupId}
      data-tl="radio-group"
      data-orientation={orientation}
      data-variant={variant}
      data-size={size}
      data-disabled={isDisabled || undefined}
      className={cx('tl-radio-group', className)}
      role="radiogroup"
      aria-orientation={orientation}
      aria-labelledby={rest['aria-labelledby'] ?? (label != null ? labelId : undefined)}
      aria-describedby={cx(rest['aria-describedby'], field?.describedBy)}
      aria-required={isRequired || undefined}
      aria-invalid={isInvalid || undefined}
    >
      {label != null && (
        <span className="tl-radio-group__label" id={labelId}>
          {label}
        </span>
      )}
      <div className="tl-radio-group__items">
        <RadioGroupContext.Provider value={context}>{children}</RadioGroupContext.Provider>
      </div>
    </div>
  )
})

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'value' | 'children'> {
  /** The value this option contributes to its group. */
  value: string
  label?: ReactNode
  description?: ReactNode
  size?: RadioSize
  variant?: RadioVariant
  invalid?: boolean
}

/**
 * One option of a `RadioGroup`.
 *
 * Built the same way as `Checkbox`: a real input made transparent and stacked
 * over a drawn dial, so focus, label association and form participation stay
 * native. Inside a group it takes its name, size, presentation and checked
 * state from context; on its own it is an ordinary controlled or uncontrolled
 * radio and the consumer supplies `name` and `checked` themselves.
 *
 * The root is the `<label>` rather than a wrapper div, which is what makes the
 * `card` variant work: the entire tile is then the hit target with no click
 * handler and no JS involved.
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  {
    value,
    label,
    description,
    size: sizeProp,
    variant: variantProp,
    invalid,
    name: nameProp,
    disabled,
    required,
    checked: checkedProp,
    defaultChecked,
    onChange,
    id,
    className,
    style,
    ...rest
  },
  ref,
) {
  const group = useContext(RadioGroupContext)
  const field = useFieldContext()

  const reactId = useId()
  const inputId = id ?? reactId
  const labelId = `${reactId}-label`
  const descriptionId = `${reactId}-description`

  const size = sizeProp ?? group?.size ?? 'md'
  const variant = variantProp ?? group?.variant ?? 'default'
  const isDisabled = disabled ?? group?.disabled ?? field?.disabled ?? false
  const isInvalid = invalid ?? group?.invalid ?? field?.invalid ?? false
  // A Field's `required` is deliberately absent from this chain. Requiredness of
  // a radio set belongs on the group, where `RadioGroup` already publishes it as
  // `aria-required`; repeating it as a native attribute on every option arms the
  // UA's validation bubble, which is exactly what `Field` documents it does not
  // want. An option only carries `required` when it or its group asked for it.
  const isRequired = required ?? group?.required ?? false

  if (import.meta.env?.DEV) {
    if (label == null && !rest['aria-label'] && !rest['aria-labelledby']) {
      console.error('[t-lingual/ui] <Radio> needs `label`, `aria-label` or `aria-labelledby`.')
    }
    if (group && defaultChecked !== undefined) {
      console.error(
        '[t-lingual/ui] <Radio defaultChecked> is ignored inside a <RadioGroup>. ' +
          'Set the group\'s `defaultValue` instead — the group owns the selection.',
      )
    }
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    // A radio only fires `change` on the option that has just become checked,
    // so there is no need to guard against clearing the group here.
    if (group) group.select(value)
    onChange?.(event)
  }

  const hasText = label != null || description != null

  return (
    <label
      data-tl="radio"
      data-size={size}
      data-variant={variant}
      data-disabled={isDisabled || undefined}
      data-invalid={isInvalid || undefined}
      data-has-text={hasText || undefined}
      className={cx('tl-radio', className)}
      style={style}
      htmlFor={inputId}
    >
      <span className="tl-radio__control">
        <input
          {...rest}
          ref={ref}
          type="radio"
          id={inputId}
          className="tl-radio__input"
          name={nameProp ?? group?.name}
          value={value}
          disabled={isDisabled}
          required={isRequired}
          checked={group ? group.value === value : checkedProp}
          defaultChecked={group ? undefined : defaultChecked}
          onChange={handleChange}
          aria-invalid={isInvalid || undefined}
          aria-describedby={cx(
            rest['aria-describedby'],
            // Inside a group the Field's description already hangs off the
            // radiogroup; repeating it on every option is just noise.
            group ? undefined : field?.describedBy,
            description != null ? descriptionId : undefined,
          )}
          // Same reason as Checkbox: the description lives inside the <label>,
          // so implicit naming would read it out as part of the option's name.
          aria-labelledby={
            rest['aria-labelledby'] ??
            (label != null && description != null ? labelId : undefined)
          }
        />
        <span className="tl-radio__box" aria-hidden="true">
          <span className="tl-radio__dot" />
        </span>
      </span>

      {hasText && (
        <span className="tl-radio__text">
          {label != null && (
            <span className="tl-radio__label" id={labelId}>
              {label}
            </span>
          )}
          {description != null && (
            <span className="tl-radio__description" id={descriptionId}>
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  )
})
