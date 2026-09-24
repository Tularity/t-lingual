import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { cx } from '../../utils/cx'
import { Separator } from '../Separator/Separator'
import './Toolbar.css'

export type ToolbarOrientation = 'horizontal' | 'vertical'

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ToolbarOrientation
  /** Arrow keys wrap around at the ends. Defaults to `true`. */
  loop?: boolean
  /** Allow the items to wrap onto a second line. Defaults to `true`. */
  wrap?: boolean
}

export type ToolbarGroupProps = HTMLAttributes<HTMLDivElement>

export type ToolbarSeparatorProps = HTMLAttributes<HTMLDivElement>

/* Anything that can hold focus. `[tabindex]` is intentionally unqualified:
 * every item except the active one carries `tabindex="-1"` while the roving
 * index is in effect, so filtering those out would leave the toolbar with a
 * single findable item after the first sync. */
const ITEM_SELECTOR = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]'

const TEXT_ENTRY_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
])

const ToolbarOrientationContext = createContext<ToolbarOrientation>('horizontal')

function isTextEntry(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLElement && element.isContentEditable) return true
  if (element instanceof HTMLInputElement) return TEXT_ENTRY_INPUT_TYPES.has(element.type)
  return false
}

function getItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((element) => {
    // A natively disabled control cannot take focus, so including it would put
    // a dead stop in the middle of the ring. `aria-disabled` items are kept on
    // purpose: the APG wants a disabled toolbar item to stay discoverable so a
    // keyboard user can find out that it exists and why it is unavailable.
    if (element.hasAttribute('disabled')) return false
    // A nested toolbar runs its own roving index; its items belong to it.
    if (element.closest('[data-tl="toolbar"]') !== root) return false
    // Catches `display: none`, a collapsed ancestor and anything inside a
    // `[hidden]` subtree in one measurement.
    return element.getClientRects().length > 0
  })
}

function setRovingTabStop(items: HTMLElement[], active: HTMLElement): void {
  for (const item of items) item.tabIndex = item === active ? 0 : -1
}

/**
 * A grouped set of controls that behaves as one tab stop.
 *
 * WAI-ARIA Authoring Practices, toolbar pattern. Tab moves into the toolbar and
 * lands on whichever item was last used, and the next Tab leaves the toolbar
 * entirely rather than walking through it — that is the whole point of the
 * pattern, and it is what stops a fourteen-button session toolbar from costing
 * fourteen Tab presses to get past. Movement inside is by arrow key, with Home
 * and End jumping to the ends.
 *
 * The roving index is maintained by reading the DOM rather than by a context and
 * an item wrapper component. Consumers put arbitrary things in a toolbar —
 * Buttons, a Select, a router Link, a group of toggles — and asking each of them
 * to be wrapped in a `ToolbarItem` is a rule that will be forgotten, at which
 * point the forgotten control is silently unreachable. Querying for focusable
 * descendants cannot be forgotten. The sync runs after every render because that
 * is when items appear, disappear or become disabled, and for the ten-ish
 * elements in a real toolbar the query costs nothing worth measuring.
 *
 * Two deliberate refusals to handle a key. Arrow keys are left alone when focus
 * is in a text entry, because a search field in a toolbar has to be able to move
 * its own caret. And in a horizontal toolbar, Up and Down are never intercepted:
 * they belong to whatever the focused item is — a button that opens a menu
 * expects ArrowDown. Anything a nested widget has already handled is skipped
 * too, since the container handler runs on the bubble and honours
 * `defaultPrevented`; that is the escape hatch for a radio group inside a
 * toolbar, which owns its own arrow semantics.
 *
 * Direction is resolved from computed style, so ArrowRight moves to the
 * previous item under `dir="rtl"`. Arrow keys are physical directions, not
 * logical ones, and a right-to-left toolbar that walks left when you press right
 * is the most confusing possible outcome.
 */
export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(function Toolbar(
  {
    orientation = 'horizontal',
    loop = true,
    wrap = true,
    className,
    children,
    onKeyDown,
    onFocus,
    ...rest
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLElement | null>(null)

  if (import.meta.env?.DEV && !rest['aria-label'] && !rest['aria-labelledby']) {
    console.error(
      '[t-lingual/ui] <Toolbar> needs `aria-label` or `aria-labelledby`. A toolbar takes its name ' +
        'from the author, and an unnamed one is announced only as "toolbar" with no indication of ' +
        'what it controls.',
    )
  }

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  // Keyed on `children` rather than left dependency-free. A stale tabindex is
  // either a dead tab stop or two live ones, so this has to re-run whenever the
  // item set can have changed — but `getItems` calls `getClientRects`, which
  // forces a layout flush, and there is no reason to pay for that on a parent
  // re-render that did not touch the toolbar's contents.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const items = getItems(root)
    if (items.length === 0) return

    const active =
      activeRef.current && items.includes(activeRef.current) ? activeRef.current : items[0]
    activeRef.current = active
    setRovingTabStop(items, active)
  }, [children])

  const handleFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    onFocus?.(event)
    const root = rootRef.current
    if (!root) return

    // Clicking an item, or tabbing in, has to move the tab stop with it —
    // otherwise the next Tab into the toolbar returns to a different item than
    // the one the user was just on.
    const items = getItems(root)
    const item = items.find((candidate) => candidate.contains(event.target as Node))
    if (!item) return
    activeRef.current = item
    setRovingTabStop(items, item)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return

    const root = rootRef.current
    if (!root) return

    const target = event.target as HTMLElement
    if (isTextEntry(target)) return

    const items = getItems(root)
    const index = items.findIndex((candidate) => candidate.contains(target))
    if (index === -1) return

    const rtl = getComputedStyle(root).direction === 'rtl'
    const forwardKey =
      orientation === 'horizontal' ? (rtl ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown'
    const backwardKey =
      orientation === 'horizontal' ? (rtl ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp'

    let next: number
    if (event.key === forwardKey) next = index + 1
    else if (event.key === backwardKey) next = index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else return

    if (next < 0) next = loop ? items.length - 1 : 0
    if (next >= items.length) next = loop ? 0 : items.length - 1

    const item = items[next]
    if (!item) return

    // Stops Home/End scrolling the page and the arrow keys scrolling a vertical
    // toolbar's container out from under the focus we are about to move.
    event.preventDefault()
    // The tabindex has to be 0 before `focus()`, or assistive technology reads
    // the item as unreachable at the moment it gains focus.
    setRovingTabStop(items, item)
    activeRef.current = item
    item.focus()
  }

  return (
    <ToolbarOrientationContext.Provider value={orientation}>
      <div
        ref={setRootRef}
        data-tl="toolbar"
        data-orientation={orientation}
        data-wrap={wrap ? 'wrap' : 'nowrap'}
        className={cx('tl-toolbar', className)}
        role="toolbar"
        aria-orientation={orientation}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        {...rest}
      >
        {children}
      </div>
    </ToolbarOrientationContext.Provider>
  )
})

/**
 * A related run of controls inside a toolbar.
 *
 * `role="group"` rather than nothing, so a name given to the group is announced
 * when focus enters it. The group is transparent to the roving index — it does
 * not restart numbering or trap arrows — because the APG treats a toolbar as one
 * flat ring of items regardless of how they are visually clustered.
 */
export const ToolbarGroup = forwardRef<HTMLDivElement, ToolbarGroupProps>(function ToolbarGroup(
  { className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-tl="toolbar-group"
      className={cx('tl-toolbar__group', className)}
      role="group"
      {...rest}
    />
  )
})

/**
 * The divider between two toolbar groups.
 *
 * Its orientation is the opposite of the toolbar's — the rule in a horizontal
 * toolbar is a vertical line — which is exactly the sort of inversion a consumer
 * gets wrong when asked to pass it by hand, so it is read from context instead.
 */
export const ToolbarSeparator = forwardRef<HTMLDivElement, ToolbarSeparatorProps>(
  function ToolbarSeparator({ className, ...rest }, ref) {
    const orientation = useContext(ToolbarOrientationContext)

    return (
      <Separator
        ref={ref}
        orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
        className={cx('tl-toolbar__separator', className)}
        {...rest}
      />
    )
  },
)
