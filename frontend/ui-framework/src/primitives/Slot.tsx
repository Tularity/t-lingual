import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type Ref,
} from 'react'
import { cx } from '../utils/cx'

/**
 * Merges any number of refs into one callback ref.
 *
 * Returns the cleanup functions React 19 refs may produce, so a child that
 * relies on ref cleanup still gets it when it is rendered through a Slot.
 */
export function composeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T) => {
    const cleanups = refs.map((ref) => {
      if (typeof ref === 'function') return ref(node)
      if (ref && typeof ref === 'object') {
        ;(ref as { current: T | null }).current = node
      }
      return undefined
    })
    return () => {
      for (const cleanup of cleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    }
  }
}

export interface SlotProps extends HTMLAttributes<HTMLElement> {
  children?: React.ReactNode
}

/**
 * Renders its props onto its single child instead of a wrapper element.
 *
 * This is what backs `asChild` across the framework, and it exists to solve a
 * specific and recurring problem: a Button that must actually be an anchor for
 * routing, or a Tooltip trigger that must not add a <span> that breaks a flex
 * layout. The alternative — an `as` prop — cannot type the resulting props
 * correctly and forces every component to re-declare polymorphic generics.
 *
 * Merge rules, in the order that surprises people:
 * - Event handlers compose: the slot's handler runs first, then the child's.
 *   If the slot's handler calls `preventDefault`, the child's still runs; that
 *   is deliberate, because the child is the more specific author.
 * - `className` concatenates rather than overwrites.
 * - `style` merges, child wins on conflict.
 * - Everything else: the child's value wins, because the child was written by
 *   the consumer and the slot props are the framework's defaults.
 */
/**
 * Marks which of a Slot's children is the consumer's element.
 *
 * A component that renders decoration around its label — an icon, a spinner, a
 * trailing chevron — cannot hand all of that to `Slot` directly, because Slot
 * needs exactly one element to merge onto and would see three. Wrapping the
 * consumer's node in `Slottable` says "this one is the target"; Slot then
 * clones it and drops the surrounding decoration inside it, in place.
 *
 * Renders nothing itself. Slot consumes it before React ever sees it.
 */
export function Slottable({ children }: SlottableChildProps) {
  return <>{children}</>
}

interface SlottableChildProps {
  children?: React.ReactNode
}

function isSlottable(node: React.ReactNode): node is ReactElement<SlottableChildProps> {
  return isValidElement(node) && node.type === Slottable
}

export const Slot = forwardRef<HTMLElement, SlotProps>(function Slot(
  { children, ...slotProps },
  forwardedRef,
) {
  // The multi-child form: decoration around a <Slottable> holding the real
  // element. Resolve it down to the single-element case before merging.
  const nodes = Children.toArray(children)
  const slottable = nodes.find(isSlottable)

  // Resolve the multi-child form down to the single-element case rather than
  // recursing: the decoration around the Slottable becomes the target's own
  // children, with the placeholder swapped for whatever the consumer nested
  // inside their element.
  let resolved: ReactElement | null = null
  if (slottable) {
    const target = slottable.props.children
    if (!isValidElement(target)) {
      if (import.meta.env?.DEV) {
        console.error('[t-lingual/ui] `<Slottable>` expects a single React element child.')
      }
      return null
    }
    const targetChildren = (target.props as { children?: React.ReactNode }).children
    const placed = nodes.map((node) => (node === slottable ? targetChildren : node))
    resolved = cloneElement(target, undefined, ...placed)
  } else if (isValidElement(children)) {
    resolved = children
  }

  if (!resolved) {
    if (import.meta.env?.DEV && Children.count(children) > 1) {
      console.error(
        '[t-lingual/ui] `asChild` expects exactly one React element child, or several ' +
          `with the consumer's element wrapped in <Slottable>. Received ${Children.count(children)}.`,
      )
    }
    return null
  }

  const child = resolved as ReactElement<Record<string, unknown>>
  const childProps = child.props
  const merged: Record<string, unknown> = { ...slotProps }

  for (const key of Object.keys(childProps)) {
    const slotValue = (slotProps as Record<string, unknown>)[key]
    const childValue = childProps[key]

    if (/^on[A-Z]/.test(key) && typeof slotValue === 'function' && typeof childValue === 'function') {
      merged[key] = (...args: unknown[]) => {
        ;(slotValue as (...a: unknown[]) => void)(...args)
        ;(childValue as (...a: unknown[]) => void)(...args)
      }
    } else if (key === 'className') {
      merged[key] = cx(slotValue as string, childValue as string)
    } else if (key === 'style') {
      merged[key] = { ...(slotValue as object), ...(childValue as object) }
    } else {
      merged[key] = childValue
    }
  }

  const childRef = (child as unknown as { ref?: Ref<unknown> }).ref
  merged.ref = composeRefs(forwardedRef, childRef)

  return cloneElement(child, merged)
})

export interface SlottableProps {
  asChild?: boolean
  children?: React.ReactNode
}
