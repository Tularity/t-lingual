import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { useControllableState } from '../../hooks/useControllableState'
import { useFieldContext } from '../Field/Field'
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem } from '../Menu/Menu'
import './Select.css'

export type SelectSize = 'xs' | 'sm' | 'md' | 'lg'

export interface SelectOptionProps {
  value: string
  /** What the row shows. Also what the closed field shows once chosen. */
  children?: ReactNode
  /** Leading adornment, in the row and in the closed field. Decorative. */
  icon?: ReactNode
  disabled?: boolean
  /** Type-ahead text, for a label that is not a plain string. */
  textValue?: string
}

/** One choice. Only meaningful inside a `Select`. */
export function SelectOption({ value, children, icon, disabled, textValue }: SelectOptionProps) {
  return (
    <MenuRadioItem value={value} icon={icon} disabled={disabled} textValue={textValue}>
      {children}
    </MenuRadioItem>
  )
}

export interface SelectGroupProps {
  /** Section heading; it names the group for assistive technology too. */
  label: ReactNode
  children?: ReactNode
}

/** A labelled run of options inside a `Select`. */
export function SelectGroup({ label, children }: SelectGroupProps) {
  return <MenuGroup label={label}>{children}</MenuGroup>
}

/** Every option element, in order, wherever it sits among groups and fragments. */
function collectOptions(children: ReactNode, into: ReactElement<SelectOptionProps>[] = []) {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    if (child.type === SelectOption) into.push(child as ReactElement<SelectOptionProps>)
    else if (child.type === SelectGroup || child.type === Fragment) {
      collectOptions((child.props as { children?: ReactNode }).children, into)
    }
  }
  return into
}

export interface SelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange' | 'children'> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** `SelectOption` and `SelectGroup` elements. */
  children?: ReactNode
  /** Control height; matches Button so the two share a baseline in a toolbar. */
  size?: SelectSize
  /** Shown, quieter, while no option carries the current value. */
  placeholder?: ReactNode
  invalid?: boolean
  fullWidth?: boolean
  /** Overrides the default chevron. Decorative. */
  chevron?: ReactNode
  /** Draws the closed field's content for a value, instead of the option's own. */
  renderValue?: (value: string) => ReactNode
  /** Submitted with a surrounding form under this name, as a hidden input. */
  name?: string
  /** Extra class for the open list, for a consumer that sizes its rows. */
  menuClassName?: string
}

/**
 * A single choice from a short list, drawn entirely by the framework.
 *
 * The closed control is a field like Input; opening it shows the framework's
 * own menu, with the chosen row marked by the same leading bar every
 * single-choice menu uses — never the platform's popup, whose look, font and
 * selection mark cannot be styled and would break with everything around it.
 * The menu inherits the Menu keyboard model (arrows, Home/End, type-ahead,
 * Escape back to the field, Tab onward), opens on the current choice, and is
 * never narrower than the field that opened it.
 *
 * The field's accessible name is its label followed by the current choice, so
 * a screen reader announces what is selected before the list is opened.
 *
 * LAYOUT PROPS GO TO THE WRAPPER
 * ------------------------------
 * `className` and `style` land on the wrapper, because that is the box a
 * consumer means when they size or space this component; everything else,
 * including `ref`, goes to the button that is the real control.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    value: valueProp,
    defaultValue,
    onValueChange,
    children,
    size = 'md',
    placeholder,
    invalid,
    disabled,
    fullWidth = false,
    chevron,
    renderValue,
    name,
    menuClassName,
    id,
    className,
    style,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const autoId = useId()
  const controlId = id ?? field?.id ?? `${autoId}select`
  const valueId = `${autoId}value`
  const isDisabled = disabled ?? field?.disabled ?? false
  const isInvalid = invalid ?? field?.invalid ?? false

  const [value, setValue] = useControllableState<string | undefined>({
    value: valueProp,
    defaultValue,
    onChange: (next) => {
      if (next !== undefined) onValueChange?.(next)
    },
  })
  const [open, setOpen] = useState(false)
  const [menuNode, setMenuNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number>()

  if (
    import.meta.env?.DEV &&
    !field &&
    !id &&
    !rest['aria-label'] &&
    !rest['aria-labelledby']
  ) {
    console.error(
      '[t-lingual/ui] <Select> has no way to be labelled. Wrap it in a <Field>, ' +
        'give it an `id` that a <label for> points at, or pass `aria-label`.',
    )
  }

  // Opens on the current choice, highlighted and scrolled into view, as a
  // select does. Runs after the menu's own opening focus, which it replaces.
  useEffect(() => {
    if (!open || !menuNode) return
    const current = menuNode.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
    current?.focus({ preventScroll: true })
    current?.scrollIntoView?.({ block: 'nearest' })
  }, [open, menuNode])

  const options = collectOptions(children)
  const chosen = options.find((option) => option.props.value === value) ?? null
  const empty = !chosen && renderValue === undefined
  const content = renderValue && value !== undefined ? renderValue(value) : chosen ? chosen.props.children : placeholder

  // The label, or whatever names the control, then the value. A control named
  // by `aria-label` refers to itself, which is how its own label gets read.
  const nameSource = field?.labelId ?? rest['aria-labelledby'] ?? (rest['aria-label'] ? controlId : undefined)

  return (
    <span
      data-tl="select"
      data-size={size}
      data-invalid={isInvalid || undefined}
      data-disabled={isDisabled || undefined}
      data-full-width={fullWidth || undefined}
      className={cx('tl-select', className)}
      style={style}
    >
      <Menu
        ref={setMenuNode}
        open={open}
        onOpenChange={(next) => {
          if (next) setWidth(document.getElementById(controlId)?.getBoundingClientRect().width)
          setOpen(next)
        }}
        placement="bottom-start"
        className={cx('tl-select__menu', menuClassName)}
        style={width ? ({ minInlineSize: `${width}px` } as CSSProperties) : undefined}
        trigger={
          <button
            {...rest}
            ref={ref}
            type="button"
            id={controlId}
            className="tl-select__control"
            disabled={isDisabled}
            data-empty={empty || undefined}
            aria-labelledby={nameSource ? `${nameSource} ${valueId}` : undefined}
            aria-invalid={isInvalid || undefined}
            aria-describedby={cx(rest['aria-describedby'], field?.describedBy)}
          >
            {chosen?.props.icon && !renderValue && (
              <span className="tl-select__icon" aria-hidden="true">
                {chosen.props.icon}
              </span>
            )}
            {/* The field is as wide as its widest choice, as a native select
              * is, so picking a shorter one never makes the layout jump: every
              * choice is laid, unseen, into the same grid cell as the value. A
              * full-width field has its width already and skips them. */}
            <span className="tl-select__face">
              <span id={valueId} className="tl-select__value">
                {content}
              </span>
              {!fullWidth &&
                options.map((option) => (
                  <span key={option.props.value} className="tl-select__sizer" aria-hidden="true">
                    {renderValue ? renderValue(option.props.value) : option.props.children}
                  </span>
                ))}
              {!fullWidth && placeholder != null && (
                <span className="tl-select__sizer" aria-hidden="true">
                  {placeholder}
                </span>
              )}
            </span>
            <span className="tl-select__chevron" aria-hidden="true">
              {chevron ?? <Icon name="chevronDown" />}
            </span>
          </button>
        }
      >
        <MenuRadioGroup value={value} onValueChange={setValue}>
          {children}
        </MenuRadioGroup>
      </Menu>
      {name && <input type="hidden" name={name} value={value ?? ''} />}
    </span>
  )
})
