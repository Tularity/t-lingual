import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { useFieldContext } from '../Field/Field'
import './Select.css'

export type SelectSize = 'xs' | 'sm' | 'md' | 'lg'

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /**
   * Control height. This shadows the native `size` attribute, which asks for a
   * number of visible rows and turns the control into an open list box — a
   * different component, not a variant of this one.
   */
  size?: SelectSize
  /** Renders a disabled first option that reads as an empty state. */
  placeholder?: string
  invalid?: boolean
  fullWidth?: boolean
  /** Overrides the default chevron. Decorative; never receives pointer events. */
  chevron?: ReactNode
}

/**
 * A styled native `<select>`.
 *
 * WHY NOT A CUSTOM LISTBOX
 * ------------------------
 * On mobile the native control opens the platform picker — the iOS wheel, the
 * Android bottom sheet — which is dramatically better than anything a
 * div-based reimplementation produces: it is the interaction the user already
 * knows, it is sized for a thumb, and it never fights the on-screen keyboard or
 * the visual viewport. On the desktop the same element gets keyboard type-ahead
 * for free, including the multi-character matching that hand-rolled listboxes
 * almost always get wrong. The cost is that the open popup cannot be styled;
 * that is a price worth paying, and a searchable Combobox is the component to
 * reach for when the option list is genuinely too long for this one.
 *
 * The popup follows the theme without any work here because `color-scheme` is
 * set on the token layer and inherits down to the control.
 *
 * LAYOUT PROPS GO TO THE WRAPPER
 * ------------------------------
 * `className` and `style` land on the positioning wrapper rather than on the
 * `<select>`, because the wrapper is the box a consumer means when they size or
 * space this component; everything else, including `ref`, goes to the select so
 * form libraries and DOM measurement see the real control.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    size = 'md',
    placeholder,
    invalid,
    fullWidth = false,
    chevron,
    multiple,
    disabled,
    required,
    id,
    className,
    style,
    children,
    value,
    defaultValue,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()

  const controlId = id ?? field?.id
  const isDisabled = disabled ?? field?.disabled ?? false
  const isRequired = required ?? field?.required ?? false
  const isInvalid = invalid ?? field?.invalid ?? false

  if (
    import.meta.env?.DEV &&
    !field &&
    !controlId &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <Select> has no way to be labelled. Wrap it in a <Field>, ' +
        'give it an `id` that a <label for> points at, or pass `aria-label`.',
    )
  }

  return (
    <span
      data-tl="select"
      data-size={size}
      data-invalid={isInvalid || undefined}
      data-disabled={isDisabled || undefined}
      data-full-width={fullWidth || undefined}
      data-multiple={multiple || undefined}
      className={cx('tl-select', className)}
      style={style}
    >
      <select
        {...rest}
        ref={ref}
        id={controlId}
        className="tl-select__control"
        multiple={multiple}
        disabled={isDisabled}
        // Native `required` only when this control asked for it. A Field's
        // `required` is announced through `aria-required` instead, because the
        // UA's validation bubble cannot be styled or translated and would
        // compete with the error region the Field already renders.
        required={required}
        value={value}
        // Selecting the placeholder is the only way it stays visible: the
        // "ask for a reset" algorithm skips disabled options, so without this
        // the browser would open on the first real option instead.
        defaultValue={
          defaultValue ?? (placeholder !== undefined && value === undefined ? '' : undefined)
        }
        aria-required={isRequired || undefined}
        aria-invalid={isInvalid || undefined}
        // `cx` is a space joiner, which is exactly the shape of an ARIA id list.
        aria-describedby={cx(rest['aria-describedby'], field?.describedBy)}
      >
        {placeholder !== undefined && (
          // `disabled` is what stops it being chosen again once a real option
          // has been picked; `hidden` is what keeps it out of the open list in
          // the engines that honour it. An empty value is also what makes this
          // the element's placeholder label option, so `required` correctly
          // treats it as "nothing selected".
          <option value="" disabled hidden data-placeholder="">
            {placeholder}
          </option>
        )}
        {children}
      </select>

      {!multiple && (
        <span className="tl-select__chevron" aria-hidden="true">
          {chevron ?? <Icon name="chevronDown" />}
        </span>
      )}
    </span>
  )
})
