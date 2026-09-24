import {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { composeRefs } from '../../primitives/Slot'
import { Icon } from '../../icons/Icon'
import { Input, type InputProps } from '../Input/Input'
import { setNativeValue } from '../Input/inputValue'
import './SearchInput.css'

export interface SearchInputProps
  extends Omit<InputProps, 'type' | 'prefix' | 'interactivePrefix' | 'clearable'> {
  /** Leading glyph. Decorative — the label or `aria-label` carries the meaning. */
  icon?: ReactNode
}

/**
 * A search field: `type="search"`, a leading magnifier, a clear button that
 * appears once there is something to clear, and Escape to empty it.
 *
 * Everything visual comes from `Input`; this adds the search-specific keyboard
 * contract and the defaults (`autoComplete="off"`, `enterKeyHint="search"`)
 * that a search box wants and a generic text field does not.
 *
 * WHY ESCAPE IS HANDLED THE WAY IT IS
 * -----------------------------------
 * Escape clears the field only when the field has something in it. On an empty
 * field the key is left to propagate, because a search box very often lives
 * inside a dialog, a popover or a command palette, and Escape is that
 * container's dismiss key. Swallowing it unconditionally would trap the user in
 * an overlay they cannot close — which is why the handler stops propagation
 * only on the pass where it actually consumed the key.
 *
 * The current value is read off the DOM node rather than mirrored into state:
 * at the moment the key is pressed the node is the authority for both the
 * controlled and the uncontrolled case, and mirroring would add a render per
 * keystroke to answer a question asked once per Escape.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    {
      icon,
      onClear,
      onKeyDown,
      className,
      clearLabel = 'Clear search',
      ...rest
    },
    ref,
  ) {
    const innerRef = useRef<HTMLInputElement>(null)
    const mergedRef = useMemo(() => composeRefs<HTMLInputElement>(ref, innerRef), [ref])

    const handleKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || event.key !== 'Escape') return

        const node = innerRef.current
        if (!node || node.value === '') return

        event.preventDefault()
        event.stopPropagation()
        // Writing through the native setter is what makes this work for a
        // controlled field too: the consumer hears the clear as an ordinary
        // change and updates its own state.
        setNativeValue(node, '')
        onClear?.()
      },
      [onKeyDown, onClear],
    )

    return (
      <Input
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        {...rest}
        ref={mergedRef}
        type="search"
        data-tl="search-input"
        className={cx('tl-search-input', className)}
        clearable
        clearLabel={clearLabel}
        onClear={onClear}
        onKeyDown={handleKeyDown}
        prefix={icon ?? <Icon name="search" />}
      />
    )
  },
)
