import {
  forwardRef,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { useControllableState } from '../../hooks/useControllableState'
import { useFieldContext } from '../Field/Field'
import { Popover } from '../Popover/Popover'
import type { SelectSize } from '../Select/Select'
import '../Select/Select.css'
import './SearchSelect.css'

export interface SearchSelectOption {
  value: string
  /** What the row and, once chosen, the closed field show. */
  label: ReactNode
  /** The text a search matches, and what the list is read as. */
  textValue: string
  /** A quieter second line in the row: a username, an address. */
  description?: ReactNode
  /** Leading adornment, in the row and in the closed field. Decorative. */
  icon?: ReactNode
  disabled?: boolean
}

export interface SearchSelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange' | 'children'> {
  options: readonly SearchSelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Shown, quieter, while nothing is chosen. */
  placeholder?: ReactNode
  /** Placeholder, and accessible name, of the search box. */
  searchLabel?: string
  /** Shown in the list when the search matches nothing. */
  emptyLabel?: ReactNode
  size?: SelectSize
  fullWidth?: boolean
  invalid?: boolean
}

/** Folds case and accents away, so "chloe" finds "Chloé". */
function fold(text: string) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/**
 * A single choice from a list too long to scan: the closed field is a Select,
 * and opening it puts a search box above the choices.
 *
 * The search box is a combobox that owns the list — focus stays in it while
 * the arrow keys move an active row through `aria-activedescendant`, Enter
 * chooses, Escape closes — which is the APG pattern for a filtered list, and
 * why this is not a Menu with an input in it: a menu moves focus to its rows,
 * and a row cannot take typing.
 *
 * The chosen row carries the same leading bar as every other single-choice
 * list in the framework.
 */
export const SearchSelect = forwardRef<HTMLButtonElement, SearchSelectProps>(function SearchSelect(
  {
    options,
    value: valueProp,
    defaultValue,
    onValueChange,
    placeholder,
    searchLabel = 'Search',
    emptyLabel = 'No matches',
    size = 'md',
    fullWidth = false,
    invalid,
    disabled,
    id,
    className,
    style,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const autoId = useId()
  const controlId = id ?? field?.id ?? `${autoId}control`
  const valueId = `${autoId}value`
  const listId = `${autoId}list`
  const isDisabled = disabled ?? field?.disabled ?? false
  const isInvalid = invalid ?? field?.invalid ?? false
  const [value, setValue] = useControllableState<string | undefined>({
    value: valueProp,
    defaultValue,
    onChange: (next) => { if (next !== undefined) onValueChange?.(next) },
  })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | undefined>(undefined)
  const [width, setWidth] = useState<number>()
  const searchRef = useRef<HTMLInputElement>(null)

  const chosen = options.find((option) => option.value === value)
  const needle = fold(query.trim())
  const shown = useMemo(() => needle ? options.filter((option) => fold(option.textValue).includes(needle)) : options, [options, needle])
  const enabled = shown.filter((option) => !option.disabled)
  const activeOption = shown.find((option) => option.value === active && !option.disabled) ?? enabled[0]
  const optionId = (option: SearchSelectOption) => `${autoId}option-${options.indexOf(option)}`
  const nameSource = field?.labelId ?? rest['aria-labelledby'] ?? (rest['aria-label'] ? controlId : undefined)

  const changeOpen = (next: boolean) => {
    if (next) {
      setWidth(document.getElementById(controlId)?.getBoundingClientRect().width)
      setQuery('')
      setActive(value)
    }
    setOpen(next)
  }
  const choose = (option: SearchSelectOption) => {
    if (option.disabled) return
    setValue(option.value)
    changeOpen(false)
  }
  const move = (to: SearchSelectOption | undefined) => {
    if (!to) return
    setActive(to.value)
    document.getElementById(optionId(to))?.scrollIntoView?.({ block: 'nearest' })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const index = activeOption ? enabled.indexOf(activeOption) : -1
    if (event.key === 'ArrowDown') { event.preventDefault(); move(enabled[Math.min(enabled.length - 1, index + 1)]) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(enabled[Math.max(0, index - 1)]) }
    else if (event.key === 'Home' && event.ctrlKey) { event.preventDefault(); move(enabled[0]) }
    else if (event.key === 'End' && event.ctrlKey) { event.preventDefault(); move(enabled.at(-1)) }
    else if (event.key === 'Enter') { event.preventDefault(); if (activeOption) choose(activeOption) }
  }

  return (
    <span
      data-tl="search-select"
      data-size={size}
      data-invalid={isInvalid || undefined}
      data-disabled={isDisabled || undefined}
      data-full-width={fullWidth || undefined}
      className={cx('tl-select', 'tl-search-select', className)}
      style={style}
    >
      <Popover
        open={open}
        onOpenChange={changeOpen}
        placement="bottom-start"
        offset={4}
        initialFocus={searchRef}
        className="tl-search-select__panel"
        style={width ? ({ minInlineSize: `${width}px` } as CSSProperties) : undefined}
        trigger={
          <button
            {...rest}
            ref={ref}
            type="button"
            id={controlId}
            className="tl-select__control"
            disabled={isDisabled}
            data-empty={!chosen || undefined}
            aria-labelledby={nameSource ? `${nameSource} ${valueId}` : undefined}
            aria-invalid={isInvalid || undefined}
            aria-describedby={cx(rest['aria-describedby'], field?.describedBy)}
          >
            {chosen?.icon && <span className="tl-select__icon" aria-hidden="true">{chosen.icon}</span>}
            <span className="tl-select__face">
              <span id={valueId} className="tl-select__value">{chosen ? chosen.label : placeholder}</span>
            </span>
            <span className="tl-select__chevron" aria-hidden="true"><Icon name="chevronDown" /></span>
          </button>
        }
      >
        <label className="tl-search-select__search">
          <Icon name="search" size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            // Framework-owned, so an app's own focus rule for inputs passes it by:
            // the ring here is the search box's border, not the input's outline.
            data-tl="search-select-input"
            type="search"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(undefined) }}
            onKeyDown={onKeyDown}
          />
        </label>
        <div id={listId} role="listbox" aria-label={searchLabel} className="tl-search-select__list">
          {shown.map((option) => (
            <div
              key={option.value}
              id={optionId(option)}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-active={option === activeOption || undefined}
              className="tl-search-select__option"
              // The row is chosen with the pointer; focus stays in the search box.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              onPointerMove={() => { if (!option.disabled && active !== option.value) setActive(option.value) }}
            >
              {option.icon && <span className="tl-search-select__icon" aria-hidden="true">{option.icon}</span>}
              <span className="tl-search-select__text">
                <span className="tl-search-select__label">{option.label}</span>
                {option.description != null && <span className="tl-search-select__description">{option.description}</span>}
              </span>
            </div>
          ))}
          {shown.length === 0 && <p className="tl-search-select__empty" role="status">{emptyLabel}</p>}
        </div>
      </Popover>
    </span>
  )
})
