import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { cx } from '../../utils/cx'
import { Icon } from '../../icons/Icon'
import { Portal } from '../../primitives/Portal'
import { Slot, composeRefs } from '../../primitives/Slot'
import { useControllableState } from '../../hooks/useControllableState'
import { useDismiss } from '../../hooks/useDismiss'
import { useAnchoredPosition } from '../_shared/useAnchoredPosition'
import { useAttachedNode } from '../_shared/useAttachedNode'
import { usePresence } from '../_shared/usePresence'
import type { Placement } from '../_shared/position'
import './Menu.css'

/* eslint-disable react-hooks/refs -- Compiler false positive, scoped to this file.
 *
 * The rule flags `anchor.node`, `floating.ref` and `anchor.attach` as reads of a
 * ref during render. They are not: `useAttachedNode` returns `{ ref, node,
 * attach }` where `node` is React STATE, `attach` is a callback ref meant to be
 * handed to `ref=`, and `ref` is only ever passed along to a hook, never
 * dereferenced here. Dialog, Drawer, Popover and Tooltip use the identical
 * shape and lint clean; this file trips it because the compiler bails out
 * somewhere in a 600-line component and falls back to a conservative analysis
 * that treats the whole returned object as a ref.
 *
 * Verified before disabling: every `.current` write in this file (intentRef,
 * typeahead) happens inside an event handler, never during render. If that ever
 * stops being true, this comment is wrong and the disable must come out.
 */

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

/** Milliseconds of silence before the type-ahead buffer resets. */
const TYPEAHEAD_TIMEOUT = 500

/**
 * Every item, including the disabled ones.
 *
 * The APG is explicit that disabled menu items should stay in the arrow-key
 * sequence: skipping them hides the fact that the action exists at all, so a
 * keyboard user cannot discover that the option is there but unavailable, while
 * a sighted user reads it greyed out in front of them.
 */
function getItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
}

interface MenuContextValue {
  close: () => void
}

const MenuContext = createContext<MenuContextValue | null>(null)

function useMenuContext(component: string): MenuContextValue {
  const context = useContext(MenuContext)
  if (!context) {
    throw new Error(`[t-lingual/ui] <${component}> must be rendered inside a <Menu>.`)
  }
  return context
}

interface MenuRadioContextValue {
  value: string | undefined
  select: (value: string) => void
}

const MenuRadioContext = createContext<MenuRadioContextValue | null>(null)

export interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  /** The button that opens the menu. Rendered through `Slot`, so no wrapper. */
  trigger: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: Placement
  offset?: number
  padding?: number
  container?: HTMLElement | null
  children?: ReactNode
}

/**
 * A button-triggered action menu, following the WAI-ARIA menu button pattern.
 *
 * KEYBOARD
 * --------
 * Down/Up move with wraparound, Home and End jump to the ends, printable
 * characters jump by prefix, Escape closes and returns focus to the trigger,
 * and Tab closes without being swallowed so focus continues from the trigger to
 * whatever follows it in the page. Focus is real DOM focus on a roving
 * `tabindex="-1"` rather than `aria-activedescendant`, because that is what
 * makes the browser scroll the active item into view inside a long menu without
 * any scrolling code of our own.
 *
 * WHY OPENING WITH A MOUSE DOES NOT HIGHLIGHT THE FIRST ITEM
 * ----------------------------------------------------------
 * Opening from the keyboard puts focus on the first item; clicking the trigger
 * puts focus on the menu container and highlights nothing. It looks like an
 * inconsistency and it is the platform convention on every desktop OS, for a
 * reason worth keeping.
 *
 * A keyboard user has no other way to reach the items — the menu is a portal at
 * the end of <body>, so there is nothing to Tab to — and the keypress that
 * opened it (Enter, Space, Down) already expressed the intent to start
 * choosing. Preselecting the first item is what makes the very next Enter
 * useful.
 *
 * A mouse user is about to point at whichever item they want, and their pointer
 * is nowhere near the first one. Preselecting it would mean a stray Enter — or a
 * click that lands slightly off — activates an action they never looked at,
 * which is exactly the accident a destructive item at the top of a menu should
 * never invite. Focus still moves into the container, so Escape and the arrow
 * keys work immediately; it just does not point at anything yet.
 */
export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  {
    trigger,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    placement = 'bottom-start',
    offset = 6,
    padding = 8,
    container,
    className,
    children,
    ...rest
  },
  ref,
) {
  const [open, setOpen] = useControllableState({
    value: openProp,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  })

  const anchor = useAttachedNode<HTMLElement>()
  const floating = useAttachedNode<HTMLDivElement>()
  const list = useAttachedNode<HTMLDivElement>()
  const intentRef = useRef<'first' | 'last' | 'pointer'>('pointer')
  const typeahead = useRef({ query: '', timer: 0 })

  const generatedMenuId = useId()
  const generatedTriggerId = useId()
  const menuId = rest.id ?? generatedMenuId

  const { mounted, status } = usePresence(open, floating.ref)
  const active = open && mounted && list.node !== null

  const close = useCallback(
    (focusTrigger: boolean) => {
      setOpen(false)
      // Synchronous, and before the exit animation finishes: focus must land on
      // the trigger while the browser still considers this the same user
      // gesture, or a Tab that closed the menu would start again from <body>.
      if (focusTrigger) anchor.node?.focus({ preventScroll: true })
    },
    [setOpen, anchor.node],
  )

  useAnchoredPosition({
    anchor: anchor.node,
    floating: floating.node,
    placement,
    offset,
    padding,
    onAnchorHidden: () => close(false),
  })

  useDismiss({
    enabled: active,
    ref: floating.ref,
    triggerRef: anchor.ref,
    onDismiss: () => close(false),
    // Escape is handled on the menu itself so it can restore focus to the
    // trigger; letting the generic handler close it would drop focus on <body>.
    onEscapeKey: false,
  })

  const menuNode = list.node
  useEffect(() => {
    if (!active || !menuNode) return
    if (intentRef.current === 'pointer') {
      menuNode.focus({ preventScroll: true })
      return
    }
    const items = getItems(menuNode)
    const target = intentRef.current === 'last' ? items[items.length - 1] : items[0]
    ;(target ?? menuNode).focus({ preventScroll: true })
  }, [active, menuNode])

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), [])

  const focusItemAt = (index: number) => {
    const items = getItems(menuNode)
    if (items.length === 0) return
    const wrapped = ((index % items.length) + items.length) % items.length
    // No preventScroll: bringing the item into view inside a long menu is
    // exactly what this call is for.
    items[wrapped].focus()
  }

  const runTypeahead = (key: string) => {
    const state = typeahead.current
    window.clearTimeout(state.timer)
    state.query += key.toLowerCase()
    state.timer = window.setTimeout(() => {
      state.query = ''
    }, TYPEAHEAD_TIMEOUT)

    const items = getItems(menuNode)
    if (items.length === 0) return

    const query = state.query
    const repeated = query.length > 1 && [...query].every((character) => character === query[0])
    const needle = repeated ? query[0] : query
    const current = items.indexOf(document.activeElement as HTMLElement)
    // A brand new query, or the same letter pressed again, should move past the
    // current item and cycle. Extending a longer query must be allowed to keep
    // matching the item it already found, so it starts from where it is.
    const from = current + (query.length === 1 || repeated ? 1 : 0)

    for (let step = 0; step < items.length; step += 1) {
      const index = (((from + step) % items.length) + items.length) % items.length
      const item = items[index]
      const text = (item.dataset.textValue ?? item.textContent ?? '').trim().toLowerCase()
      if (text.startsWith(needle)) {
        item.focus()
        return
      }
    }
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Attached after `{...rest}`, so a consumer's own handler has to be called
    // rather than replaced.
    rest.onKeyDown?.(event)
    const printable =
      event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
    // Space only starts a search when one is already running, so that it stays
    // available as the activation key on the item under focus.
    if (printable && (event.key !== ' ' || typeahead.current.query !== '')) {
      event.preventDefault()
      runTypeahead(event.key)
      return
    }

    const items = getItems(menuNode)
    const current = items.indexOf(document.activeElement as HTMLElement)

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusItemAt(current + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusItemAt(current <= 0 ? items.length - 1 : current - 1)
        break
      case 'Home':
        event.preventDefault()
        focusItemAt(0)
        break
      case 'End':
        event.preventDefault()
        focusItemAt(items.length - 1)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close(true)
        break
      case 'Tab':
        // Deliberately not prevented. The APG has Tab close the menu *and* move
        // focus onward, and `close` puts focus back on the trigger synchronously
        // before this handler returns — so the browser resolves the Tab from the
        // trigger and lands on whatever genuinely follows it in the page.
        close(true)
        break
      case 'Enter':
      case ' ':
        if (current >= 0) {
          event.preventDefault()
          items[current].click()
        }
        break
      default:
        break
    }
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (open) return
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      // preventDefault also suppresses the click a button would synthesise from
      // this key, which would otherwise re-enter as a pointer open and undo the
      // intent recorded here.
      event.preventDefault()
      intentRef.current = 'first'
      setOpen(true)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      intentRef.current = 'last'
      setOpen(true)
    }
  }

  const onTriggerClick = () => {
    if (open) {
      close(false)
      return
    }
    intentRef.current = 'pointer'
    setOpen(true)
  }

  const contextValue = useMemo<MenuContextValue>(() => ({ close: () => close(true) }), [close])

  if (import.meta.env?.DEV && !isValidElement(trigger)) {
    console.error('[t-lingual/ui] <Menu trigger> must be a single React element.')
  }

  let triggerNode: ReactNode = trigger
  let triggerId = generatedTriggerId
  if (isValidElement(trigger)) {
    const child = trigger as ReactElement<Record<string, unknown>>
    // The trigger's own id wins when it has one, so `aria-labelledby` on the
    // menu keeps pointing at a real element rather than at a generated id that
    // Slot's child-first merge would have discarded.
    if (typeof child.props.id === 'string') triggerId = child.props.id
    triggerNode = (
      <Slot ref={anchor.attach} onClick={onTriggerClick} onKeyDown={onTriggerKeyDown}>
        {cloneElement(child, {
          id: triggerId,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? menuId : undefined,
        })}
      </Slot>
    )
  }

  return (
    <>
      {triggerNode}
      {mounted && (
        <Portal container={container}>
          {/* The REQUESTED placement, owned by React, beside the measured
            * `data-side` the positioning hook writes later. The entrance's lift
            * vector has to exist at the element's first style computation, which
            * happens before the hook has measured anything — see Menu.css. */}
          <div
            ref={floating.attach}
            className="tl-menu"
            data-tl-anchor={triggerId}
            data-state={status}
            data-placement={placement}
          >
            <div
              {...rest}
              ref={composeRefs(ref, list.attach)}
              id={menuId}
              role="menu"
              aria-labelledby={rest['aria-labelledby'] ?? triggerId}
              aria-orientation="vertical"
              tabIndex={-1}
              data-tl="menu"
              data-state={status}
              className={cx('tl-menu__list', className)}
              onKeyDown={onMenuKeyDown}
            >
              <MenuContext.Provider value={contextValue}>{children}</MenuContext.Provider>
            </div>
          </div>
        </Portal>
      )}
    </>
  )
})

/* -- Item internals -------------------------------------------------------- */

type ItemRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio'

interface MenuRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  innerRef: Ref<HTMLDivElement>
  itemRole: ItemRole
  checked?: boolean
  icon?: ReactNode
  shortcut?: ReactNode
  destructive?: boolean
  disabled?: boolean
  textValue?: string
  closeOnSelect: boolean
  onSelect?: () => void
}

/**
 * The shared row. Not exported: `MenuItem`, `MenuCheckboxItem` and
 * `MenuRadioItem` differ only in role, indicator and default close behaviour,
 * and three copies of this markup would be three places for the keyboard and
 * ARIA wiring to drift apart.
 */
function MenuRow({
  innerRef,
  itemRole,
  checked,
  icon,
  shortcut,
  destructive,
  disabled,
  textValue,
  closeOnSelect,
  onSelect,
  className,
  children,
  onClick,
  onPointerEnter,
  ...rest
}: MenuRowProps) {
  const menu = useMenuContext('MenuItem')
  const selectable = itemRole !== 'menuitem'

  return (
    <div
      {...rest}
      ref={innerRef}
      role={itemRole}
      tabIndex={-1}
      aria-checked={selectable ? Boolean(checked) : undefined}
      // aria-disabled rather than removing it from the sequence: the item stays
      // reachable and announced, and the handler below refuses the activation.
      aria-disabled={disabled || undefined}
      data-tl="menu-item"
      data-disabled={disabled || undefined}
      data-destructive={destructive || undefined}
      data-text-value={textValue ?? (typeof children === 'string' ? children : undefined)}
      className={cx('tl-menu__item', className)}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        onClick?.(event)
        onSelect?.()
        if (closeOnSelect) menu.close()
      }}
      onPointerEnter={(event: ReactPointerEvent<HTMLDivElement>) => {
        onPointerEnter?.(event)
        // Hovering moves the roving focus so that the highlight and the arrow
        // keys never disagree about which item is current. It does not raise a
        // focus ring, because the pointer was the last input device.
        event.currentTarget.focus({ preventScroll: true })
      }}
    >
      <span className="tl-menu__item-lead" aria-hidden="true">
        {selectable ? (
          <span className="tl-menu__check" data-checked={checked || undefined}>
            {itemRole === 'menuitemradio' ? (
              <span className="tl-menu__dot" />
            ) : (
              <Icon name="check" size={14} />
            )}
          </span>
        ) : (
          icon
        )}
      </span>
      <span className="tl-menu__item-label">{children}</span>
      {shortcut != null && <span className="tl-menu__item-shortcut">{shortcut}</span>}
    </div>
  )
}

/* -- Items ----------------------------------------------------------------- */

export interface MenuItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** Leading adornment. Decorative — the label carries the meaning. */
  icon?: ReactNode
  /** Keyboard hint. Displaying it does not bind it; the app owns the binding. */
  shortcut?: ReactNode
  /** Marks an irreversible action. Never the only signal — see the CSS note. */
  destructive?: boolean
  disabled?: boolean
  /** Set false for an action that leaves the menu usable, like "add row". */
  closeOnSelect?: boolean
  onSelect?: () => void
  /** Type-ahead text, for a label that is not a plain string. */
  textValue?: string
}

export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { closeOnSelect = true, ...rest },
  ref,
) {
  return <MenuRow {...rest} innerRef={ref} itemRole="menuitem" closeOnSelect={closeOnSelect} />
})

export interface MenuCheckboxItemProps extends Omit<MenuItemProps, 'icon'> {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

/**
 * A togglable item.
 *
 * Selecting one leaves the menu open by default, which is the opposite of
 * `MenuItem`: a set of checkboxes is a set precisely because a user is likely
 * to want more than one of them, and closing after each toggle turns three
 * choices into three round trips.
 */
export const MenuCheckboxItem = forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem(
    { checked, defaultChecked = false, onCheckedChange, closeOnSelect = false, onSelect, ...rest },
    ref,
  ) {
    const [value, setValue] = useControllableState({
      value: checked,
      defaultValue: defaultChecked,
      onChange: onCheckedChange,
    })
    return (
      <MenuRow
        {...rest}
        innerRef={ref}
        itemRole="menuitemcheckbox"
        checked={value}
        closeOnSelect={closeOnSelect}
        onSelect={() => {
          setValue(!value)
          onSelect?.()
        }}
      />
    )
  },
)

export interface MenuRadioGroupProps extends HTMLAttributes<HTMLDivElement> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children?: ReactNode
}

export const MenuRadioGroup = forwardRef<HTMLDivElement, MenuRadioGroupProps>(
  function MenuRadioGroup(
    { value, defaultValue = '', onValueChange, className, children, ...rest },
    ref,
  ) {
    const [selected, setSelected] = useControllableState({
      value,
      defaultValue,
      onChange: onValueChange,
    })
    const context = useMemo<MenuRadioContextValue>(
      () => ({ value: selected, select: setSelected }),
      [selected, setSelected],
    )
    return (
      <div ref={ref} {...rest} role="group" className={cx('tl-menu__group', className)}>
        <MenuRadioContext.Provider value={context}>{children}</MenuRadioContext.Provider>
      </div>
    )
  },
)

export interface MenuRadioItemProps extends Omit<MenuItemProps, 'icon'> {
  value: string
}

export const MenuRadioItem = forwardRef<HTMLDivElement, MenuRadioItemProps>(
  function MenuRadioItem({ value, closeOnSelect = true, onSelect, ...rest }, ref) {
    const group = useContext(MenuRadioContext)
    if (!group) {
      throw new Error('[t-lingual/ui] <MenuRadioItem> must be inside a <MenuRadioGroup>.')
    }
    return (
      <MenuRow
        {...rest}
        innerRef={ref}
        itemRole="menuitemradio"
        checked={group.value === value}
        closeOnSelect={closeOnSelect}
        onSelect={() => {
          group.select(value)
          onSelect?.()
        }}
      />
    )
  },
)

/* -- Structure ------------------------------------------------------------- */

export interface MenuGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Section heading. Presentational in the tree; it names the group instead. */
  label?: ReactNode
  children?: ReactNode
}

export const MenuGroup = forwardRef<HTMLDivElement, MenuGroupProps>(function MenuGroup(
  { label, className, children, ...rest },
  ref,
) {
  const labelId = useId()
  return (
    <div
      ref={ref}
      {...rest}
      role="group"
      aria-labelledby={label != null ? labelId : undefined}
      className={cx('tl-menu__group', className)}
    >
      {label != null && (
        // role="presentation" keeps a bare element out of a menu's list of
        // allowed children while aria-labelledby still reads its text, so the
        // heading is announced once as the group's name rather than twice.
        <div id={labelId} role="presentation" className="tl-menu__group-label">
          {label}
        </div>
      )}
      {children}
    </div>
  )
})

export type MenuSeparatorProps = HTMLAttributes<HTMLDivElement>

export const MenuSeparator = forwardRef<HTMLDivElement, MenuSeparatorProps>(
  function MenuSeparator({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        {...rest}
        role="separator"
        aria-orientation="horizontal"
        className={cx('tl-menu__separator', className)}
      />
    )
  },
)
