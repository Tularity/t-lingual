import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import './Tabs.css'

/** See the note on the same constant in SegmentedControl: SSR-safe layout effect. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type TabsActivation = 'automatic' | 'manual'
export type TabsOrientation = 'horizontal' | 'vertical'
export type TabsVariant = 'line' | 'pill'
export type TabsSize = 'sm' | 'md' | 'lg'

interface TabsContextValue {
  baseId: string
  /** The tab that is actually selected: the requested value, or the fallback. */
  value: string | undefined
  /** What the consumer or the internal state asked for, before any fallback. */
  requestedValue: string | undefined
  select: (value: string) => void
  adoptFallback: (value: string | undefined) => void
  activation: TabsActivation
  orientation: TabsOrientation
  keepMounted: boolean
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext)
  if (!context) {
    // Thrown rather than reported in development only. Every piece of the ARIA
    // wiring — the ids, the selected state, the panel association — comes from
    // this context, so a subcomponent without it is not degraded, it is broken.
    throw new Error(`[t-lingual/ui] <${component}> must be rendered inside <Tabs>.`)
  }
  return context
}

/**
 * Whitespace is the separator in an `aria-controls` / `aria-labelledby` IDREF
 * list, so a tab value containing a space would produce an id that reads as two
 * references to elements that do not exist — and the association then fails
 * silently, with nothing in the DOM looking wrong.
 */
function scopedId(baseId: string, kind: 'tab' | 'panel', value: string): string {
  return `${baseId}-${kind}-${value.replace(/\s+/g, '-')}`
}

export interface TabsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  /**
   * `automatic` selects a tab as soon as focus reaches it, which is the APG
   * default and the better experience. Switch to `manual` when a panel is
   * expensive: arrowing across five tabs otherwise mounts five panels, and the
   * user only wanted the fifth.
   */
  activation?: TabsActivation
  orientation?: TabsOrientation
  variant?: TabsVariant
  size?: TabsSize
  /** Keeps unselected panels in the tree, hidden, so their state survives. */
  keepMounted?: boolean
}

/**
 * A tabbed interface, wired to the WAI-ARIA tabs pattern.
 *
 * Compound rather than a list of objects, because a panel is arbitrary content
 * and threading it through a prop turns every consumer into a render-prop
 * exercise. The parts share a context carrying the generated id base, the
 * selection, and the two behaviour switches.
 *
 * KEYBOARD
 * --------
 * A roving tabindex, so Tab moves past the whole tablist in one press and lands
 * in the panel — which is the point of the pattern and what a `tabindex="0"` on
 * every tab destroys. Arrow keys follow the declared orientation and are
 * mirrored under RTL for the horizontal case. Home and End jump to the ends.
 * Space and Enter are deliberately not handled: each tab is a real `<button>`,
 * so both keys already produce a click, and adding key handling would only
 * create a second path that can disagree with the first.
 *
 * SELECTION WHEN NOTHING IS SELECTED
 * ----------------------------------
 * A tablist with no selected tab is not a valid state, so TabList adopts the
 * first enabled tab before the first paint. It reads DOM order rather than a
 * registration list, because DOM order is the order the user sees and a
 * registration list drifts from it the moment a tab is rendered conditionally.
 * The fallback is held apart from the controllable state and does NOT fire
 * `onChange`: nobody chose it, and reporting it as a change makes an
 * uncontrolled Tabs look like it was clicked on mount.
 *
 * THE SLIDING INDICATOR
 * ---------------------
 * The active marker is one pseudo-element on the tab list, positioned from
 * four custom properties that TabList writes from the active tab's offset box
 * in a layout effect. One element moving between tabs is what lets the eye
 * follow a selection from the old tab to the new one; a marker drawn on each
 * tab can only appear and disappear. Measuring is what makes the earlier
 * border-based version's objection go away: the active tab is observed for
 * size, not just the list, so a label that reflows after a webfont loads moves
 * the bar with it.
 *
 * The list wraps rather than scrolls, so the marker is placed on both axes and
 * sits under whichever row the active tab landed on. Its transitions are gated
 * behind a two-step attribute — `measured` with the first geometry, `ready` a
 * frame later — because a transition that exists on the first paint animates
 * the bar in from the list's corner.
 */
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    value: valueProp,
    defaultValue,
    onChange,
    activation = 'automatic',
    orientation = 'horizontal',
    variant = 'line',
    size = 'md',
    keepMounted = false,
    className,
    ...rest
  },
  ref,
) {
  const baseId = useId()
  const [fallback, setFallback] = useState<string | undefined>(undefined)

  const [value, setValue] = useControllableState<string | undefined>({
    value: valueProp,
    defaultValue,
    // Narrowed rather than cast: the internal state is optional so that "not
    // resolved yet" can exist, but a caller only ever hears about a real
    // selection.
    onChange: (next) => {
      if (next !== undefined) onChange?.(next)
    },
  })

  const adoptFallback = useCallback((next: string | undefined) => {
    setFallback(next)
  }, [])

  // Clearing the fallback here rather than waiting for TabList to notice is what
  // keeps a click to one render: the fallback wins over the requested value
  // below, so leaving a stale one in place would show the old tab selected for
  // the frame between the click and the layout effect.
  const select = useCallback(
    (next: string) => {
      setFallback(undefined)
      setValue(next)
    },
    [setValue],
  )

  // The fallback takes precedence, because TabList only ever holds one while the
  // requested tab is absent from the DOM. Reading `value ?? fallback` instead
  // looks safer and is not: a selection pointing at a tab that has since been
  // removed would then leave the tablist with nothing selected and — since the
  // roving tabindex follows the selection — no tab stop at all.
  const selected = fallback ?? value

  // Memoised so a consumer who wraps their own Tab in `React.memo` actually
  // gets the skipped render they asked for; an object literal here would
  // invalidate every context consumer on each render of the tree above.
  const context = useMemo<TabsContextValue>(
    () => ({
      baseId,
      value: selected,
      requestedValue: value,
      select,
      adoptFallback,
      activation,
      orientation,
      keepMounted,
    }),
    [baseId, selected, value, select, adoptFallback, activation, orientation, keepMounted],
  )

  return (
    <TabsContext.Provider value={context}>
      <div
        ref={ref}
        data-tl="tabs"
        data-orientation={orientation}
        data-variant={variant}
        data-size={size}
        className={cx('tl-tabs', className)}
        {...rest}
      />
    </TabsContext.Provider>
  )
})

export interface TabListProps extends HTMLAttributes<HTMLDivElement> {
  /** Divides the available width evenly between the tabs. */
  fullWidth?: boolean
}

/**
 * Only this list's tabs, not those of a `<Tabs>` nested inside a panel. The
 * fallback and keyboard logic below read `[role="tab"]` unfiltered because a
 * nested tablist is never rendered inside the list itself; the indicator has
 * to be stricter, since a wrong match would slide the bar to a tab that is not
 * even in this strip.
 */
function ownTabs(list: HTMLElement): HTMLButtonElement[] {
  return Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
    (tab) => tab.closest('[role="tablist"]') === list,
  )
}

export const TabList = forwardRef<HTMLDivElement, TabListProps>(function TabList(
  { fullWidth = false, className, onKeyDown, ...rest },
  ref,
) {
  const { requestedValue, select, activation, orientation, adoptFallback } =
    useTabsContext('TabList')
  const listRef = useRef<HTMLDivElement | null>(null)

  const setListRef = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  // Intentionally has no dependency array. What is being validated is the DOM,
  // and a tab can be removed — a permission-gated one, typically — without any
  // value this component holds changing. Re-running on every commit is two
  // cheap queries and removes a whole class of "the selected tab vanished and
  // now nothing is selected" bug. Both branches settle in one extra render,
  // because adopting the same fallback twice is a no-op React bails out of.
  //
  // The requested value is what gets validated, never the resolved one: the
  // resolved value already includes the fallback, so checking it would find the
  // fallback tab present, clear the fallback, find the requested tab missing,
  // adopt again, and oscillate forever.
  useIsomorphicLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    if (requestedValue !== undefined && tabs.some((tab) => tab.dataset.value === requestedValue)) {
      adoptFallback(undefined)
      return
    }
    const first = tabs.find((tab) => !tab.disabled)
    adoptFallback(first?.dataset.value)
  })

  // Also without a dependency array, for the same reason as above: the thing
  // being measured is the DOM, and the active tab can change size or position
  // — a sibling removed, a label rewritten — without any value held here
  // changing. Running before paint is what keeps a click to a single slide
  // rather than a jump followed by a slide.
  useIsomorphicLayoutEffect(() => {
    const list = listRef.current
    if (!list) return

    const findActive = () => ownTabs(list).find((tab) => tab.dataset.state === 'active')

    const measure = () => {
      const active = findActive()
      if (!active) {
        // Between a tab being removed and the fallback being adopted there is
        // nothing to mark; hiding the bar is more honest than leaving it under
        // a tab that no longer exists.
        list.removeAttribute('data-indicator')
        return
      }
      // Offsets rather than client rects: they are relative to the list, which
      // is the pseudo-element's containing block, and they are integers, so a
      // re-measure that found nothing moved writes the same string and starts
      // no transition.
      list.style.setProperty('--_indicator-x', `${active.offsetLeft}px`)
      list.style.setProperty('--_indicator-y', `${active.offsetTop}px`)
      list.style.setProperty('--_indicator-w', `${active.offsetWidth}px`)
      list.style.setProperty('--_indicator-h', `${active.offsetHeight}px`)
      if (!list.hasAttribute('data-indicator')) list.setAttribute('data-indicator', 'measured')
    }

    measure()

    // The latch is the attribute itself rather than a one-shot ref. A ref set
    // by whichever frame fired first would promote a list that had no active
    // tab yet to measure — children arriving late, a controlled value not yet
    // in the strip — so the bar would animate in from the corner at zero width,
    // which is exactly what the delay exists to prevent. And once `measure` had
    // removed the attribute mid-life, nothing would ever re-arm the promotion,
    // leaving the indicator jumping instead of sliding for good.
    let frame = 0
    if (list.getAttribute('data-indicator') === 'measured') {
      frame = requestAnimationFrame(() => {
        if (list.getAttribute('data-indicator') === 'measured') {
          list.setAttribute('data-indicator', 'ready')
        }
      })
    }

    // A wrapped strip re-flows on viewport changes that need not resize the
    // list itself, so the window is listened to as well as observed.
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer) {
      observer.observe(list)
      // The list alone is not enough: a label that reflows after a webfont
      // loads, or a count changing inside the active tab, resizes the tab while
      // a width-constrained list stays exactly the same.
      const active = findActive()
      if (active) observer.observe(active)
    }

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  })

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return

    const target = event.target as HTMLElement
    // The listener sits on the list rather than on each tab, so the navigable
    // set is read from the DOM at the moment it is needed. Anything that is not
    // itself a tab is left alone, so a control a consumer placed beside the
    // tabs keeps its own arrow keys.
    if (target.getAttribute('role') !== 'tab') return

    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    ).filter((tab) => !tab.disabled)
    const current = tabs.indexOf(target as HTMLButtonElement)
    if (current === -1) return

    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    const vertical = orientation === 'vertical'
    // Only the axis matching the orientation is claimed. A horizontal tablist
    // that also swallowed Up and Down would take page scrolling with it.
    const forwardKey = vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight'
    const backwardKey = vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft'

    let next: number
    if (event.key === forwardKey) next = (current + 1) % tabs.length
    else if (event.key === backwardKey) next = (current - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return

    event.preventDefault()
    const node = tabs[next]
    node.focus()
    if (activation === 'automatic' && node.dataset.value !== undefined) {
      select(node.dataset.value)
    }
  }

  return (
    <div
      {...rest}
      ref={setListRef}
      role="tablist"
      aria-orientation={orientation}
      data-tl="tab-list"
      data-full-width={fullWidth || undefined}
      className={cx('tl-tabs__list', className)}
      onKeyDown={handleKeyDown}
    />
  )
})

export interface TabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'type'> {
  value: string
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { value, className, onClick, ...rest },
  ref,
) {
  const context = useTabsContext('Tab')
  const selected = context.value === value

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    context.select(value)
  }

  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="tab"
      id={scopedId(context.baseId, 'tab', value)}
      aria-selected={selected}
      // Only the selected tab points at a panel, because only the selected
      // panel is in the accessibility tree. An unselected panel is either not
      // rendered at all or rendered `hidden`, and either way a reference to it
      // promises a relationship the user cannot follow. Guessing from
      // `keepMounted` was worse still: TabPanel takes a per-panel override that
      // this component cannot see, so the guess was wrong in both directions —
      // a dangling IDREF under `<Tabs keepMounted>` with `<TabPanel
      // keepMounted={false}>`, and a missing one in the mirror case.
      aria-controls={selected ? scopedId(context.baseId, 'panel', value) : undefined}
      // The roving tabindex. Exactly one tab is reachable with Tab; the arrow
      // keys move between the rest.
      tabIndex={selected ? 0 : -1}
      data-tl="tab"
      data-value={value}
      data-state={selected ? 'active' : 'inactive'}
      className={cx('tl-tabs__tab', className)}
      onClick={handleClick}
    />
  )
})

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string
  /** Overrides the `keepMounted` setting from `<Tabs>` for this panel alone. */
  keepMounted?: boolean
}

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { value, keepMounted, className, ...rest },
  ref,
) {
  const context = useTabsContext('TabPanel')
  const selected = context.value === value

  if (!selected && !(keepMounted ?? context.keepMounted)) return null

  return (
    <div
      {...rest}
      ref={ref}
      role="tabpanel"
      id={scopedId(context.baseId, 'panel', value)}
      aria-labelledby={scopedId(context.baseId, 'tab', value)}
      // `hidden` rather than unmounting is the whole of `keepMounted`: React
      // state and scroll position survive, and the panel leaves the
      // accessibility tree while it is not the selected one.
      hidden={!selected}
      // APG puts the panel in the tab sequence so a panel of plain text is
      // reachable at all — without it there is nothing to move focus to after
      // the tablist, and a scrollable panel cannot be scrolled from the
      // keyboard. It stays 0 unconditionally rather than being derived from
      // whether the content happens to hold a focusable element, because that
      // answer changes as the content does.
      tabIndex={0}
      data-tl="tab-panel"
      data-state={selected ? 'active' : 'inactive'}
      className={cx('tl-tabs__panel', className)}
    />
  )
})
