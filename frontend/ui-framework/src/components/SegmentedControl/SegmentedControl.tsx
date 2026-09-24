import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../utils/cx'
import { useControllableState } from '../../hooks/useControllableState'
import { useEventCallback } from '../../hooks/useEventCallback'
import './SegmentedControl.css'

/**
 * The indicator has to be positioned from measured geometry before the browser
 * paints, or it visibly jumps into place. Choosing the hook once per
 * environment keeps that true on the client without emitting React's
 * "useLayoutEffect does nothing on the server" warning during SSR.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface SegmentedControlItem {
  value: string
  label: ReactNode
  /** Decorative adornment beside the label. */
  icon?: ReactNode
  disabled?: boolean
}

export type SegmentedControlSize = 'sm' | 'md' | 'lg'

export interface SegmentedControlProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  items: SegmentedControlItem[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  size?: SegmentedControlSize
  /** Stretches to the container and divides the width evenly between segments. */
  fullWidth?: boolean
  /** Disables every segment at once, without editing each item. */
  disabled?: boolean
}

function wrapIndex(index: number, count: number): number {
  return ((index % count) + count) % count
}

/**
 * A short list of mutually exclusive choices rendered as a single control.
 *
 * WHY RADIOGROUP AND NOT TABLIST
 * ------------------------------
 * The two look identical and behave almost identically, which is why this gets
 * built wrong so often. `tablist` carries a promise: each tab owns a panel,
 * announced through `aria-controls`, and a screen-reader user is told they can
 * move into that panel. A segmented control has no panel — it picks a value,
 * the same way a set of radio buttons does — so `radiogroup` is the honest
 * role, and it is also the one that makes arrow keys select rather than merely
 * move.
 *
 * That difference is deliberate and matches the APG radio-group pattern: arrow
 * keys change the selection, they do not just move focus. Only one segment is
 * ever in the tab order (the checked one, or the first when nothing is checked
 * yet), so Tab enters and leaves the whole control in one press rather than
 * walking through every option.
 *
 * Left and Right are swapped under an RTL document, because "next" follows
 * reading order; Up and Down are not, because they follow layout order and the
 * control is laid out along the inline axis in both directions.
 *
 * The buttons are real `<button>` elements with `role="radio"` rather than
 * `<input type="radio">`: a native radio cannot hold arbitrary content, and
 * styling one into this shape means hiding it and rebuilding every state it
 * used to give for free. A button keeps the activation semantics — Space and
 * Enter both fire a click — and needs nothing hidden.
 */
export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl(
    {
      items,
      value: valueProp,
      defaultValue,
      onChange,
      size = 'md',
      fullWidth = false,
      disabled = false,
      className,
      ...rest
    },
    ref,
  ) {
    if (
      import.meta.env?.DEV &&
      !rest['aria-label'] &&
      !rest['aria-labelledby']
    ) {
      console.error(
        '[t-lingual/ui] <SegmentedControl> is a radiogroup and needs `aria-label` or ' +
          '`aria-labelledby`. Without one, the group announces as a bare set of radios ' +
          'with nothing to say what is being chosen.',
      )
    }

    const [value, setValue] = useControllableState<string | undefined>({
      value: valueProp,
      defaultValue,
      // Narrowing here rather than casting the consumer's handler: the internal
      // state is optional so the "nothing chosen yet" case can exist, but a
      // caller only ever hears about a real selection.
      onChange: (next) => {
        if (next !== undefined) onChange?.(next)
      },
    })

    const listRef = useRef<HTMLDivElement | null>(null)
    const itemRefs = useRef(new Map<string, HTMLButtonElement>())
    const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null)
    const [animate, setAnimate] = useState(false)

    const setRootRef = useCallback(
      (node: HTMLDivElement | null) => {
        listRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      },
      [ref],
    )

    const measure = useEventCallback(() => {
      const active = value !== undefined ? itemRefs.current.get(value) : undefined
      if (!listRef.current || !active) {
        setIndicator(null)
        return
      }
      const x = active.offsetLeft
      const w = active.offsetWidth
      // Returning the previous object when nothing moved is what keeps this
      // safe to call from a ResizeObserver: a fresh object every time would
      // re-render, which would re-observe, which would call this again.
      setIndicator((previous) =>
        previous && previous.x === x && previous.w === w ? previous : { x, w },
      )
    })

    useIsomorphicLayoutEffect(() => {
      measure()
    }, [measure, value, items.length])

    useEffect(() => {
      if (typeof ResizeObserver === 'undefined') return
      const list = listRef.current
      if (!list) return
      const observer = new ResizeObserver(() => measure())
      observer.observe(list)
      // The container alone is not enough when `fullWidth` pins its size: a
      // label that reflows after a webfont loads changes the segment's width
      // while the group's stays exactly the same.
      const active = value !== undefined ? itemRefs.current.get(value) : undefined
      if (active) observer.observe(active)
      return () => observer.disconnect()
    }, [measure, value, items.length])

    useEffect(() => {
      // Transitions stay off until after the first painted frame. The indicator
      // is measured in a layout effect, so enabling them any earlier makes the
      // control open by sliding out of its own left edge.
      const id = requestAnimationFrame(() => setAnimate(true))
      return () => cancelAnimationFrame(id)
    }, [])

    const selectedIndex = items.findIndex((item) => item.value === value)
    // APG: when no radio is checked the first focusable one is the group's tab
    // stop, so the control can still be reached with a single Tab press.
    const tabStopIndex =
      selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => !item.disabled)

    const select = (index: number) => {
      const item = items[index]
      if (!item || item.disabled || disabled) return
      setValue(item.value)
    }

    const focusAndSelect = (index: number) => {
      const item = items[index]
      if (!item || item.disabled) return
      select(index)
      itemRefs.current.get(item.value)?.focus()
    }

    const stepFrom = (from: number, delta: number) => {
      const count = items.length
      if (count === 0) return
      // With nothing selected, stepping backwards should land on the last
      // segment rather than the second-to-last, which a raw -1 origin gives.
      const origin = from >= 0 ? from : delta > 0 ? -1 : 0
      for (let i = 1; i <= count; i += 1) {
        const index = wrapIndex(origin + delta * i, count)
        if (!items[index].disabled) {
          focusAndSelect(index)
          return
        }
      }
    }

    const stepToEdge = (delta: 1 | -1) => {
      const count = items.length
      for (let i = 0; i < count; i += 1) {
        const index = delta === 1 ? i : count - 1 - i
        if (!items[index].disabled) {
          focusAndSelect(index)
          return
        }
      }
    }

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      const rtl =
        listRef.current !== null && getComputedStyle(listRef.current).direction === 'rtl'

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          stepFrom(index, rtl ? -1 : 1)
          break
        case 'ArrowLeft':
          event.preventDefault()
          stepFrom(index, rtl ? 1 : -1)
          break
        case 'ArrowDown':
          event.preventDefault()
          stepFrom(index, 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          stepFrom(index, -1)
          break
        // Home and End are beyond the APG radio pattern, which does not list
        // them. They are harmless additions that cost a keystroke instead of a
        // held arrow key, and they match what Tabs in this framework does.
        case 'Home':
          event.preventDefault()
          stepToEdge(1)
          break
        case 'End':
          event.preventDefault()
          stepToEdge(-1)
          break
        default:
          break
      }
    }

    return (
      <div
        {...rest}
        ref={setRootRef}
        role="radiogroup"
        aria-disabled={disabled || undefined}
        data-tl="segmented-control"
        data-size={size}
        data-full-width={fullWidth || undefined}
        data-disabled={disabled || undefined}
        className={cx('tl-segmented', className)}
      >
        <span
          className="tl-segmented__indicator"
          aria-hidden="true"
          data-measured={indicator ? '' : undefined}
          data-animate={animate ? '' : undefined}
          style={
            indicator
              ? ({ '--_x': `${indicator.x}px`, '--_w': `${indicator.w}px` } as CSSProperties)
              : undefined
          }
        />

        {items.map((item, index) => (
          <button
            key={item.value}
            ref={(node) => {
              if (node) itemRefs.current.set(item.value, node)
              else itemRefs.current.delete(item.value)
            }}
            type="button"
            role="radio"
            aria-checked={item.value === value}
            disabled={disabled || item.disabled}
            tabIndex={index === tabStopIndex ? 0 : -1}
            data-value={item.value}
            className="tl-segmented__item"
            onClick={() => select(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {item.icon && (
              <span className="tl-segmented__icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="tl-segmented__label">{item.label}</span>
          </button>
        ))}
      </div>
    )
  },
)
