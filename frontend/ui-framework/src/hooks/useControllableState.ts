import { useEffect, useRef, useState } from 'react'
import { useEventCallback } from './useEventCallback'

export interface UseControllableStateOptions<T> {
  /** Controlled value. When not `undefined`, the hook never owns the state. */
  value?: T
  /** Initial value used only while uncontrolled. */
  defaultValue: T
  /** Called on every change, controlled or not. */
  onChange?: (value: T) => void
}

/**
 * Lets a component be controlled or uncontrolled through one API.
 *
 * The setter is referentially stable, which is what makes it safe in a
 * dependency array and in a callback handed to a child. That stability comes
 * from `useEventCallback` — which parks the latest closure in an insertion
 * effect — rather than from writing a ref during render. The distinction
 * matters under concurrent rendering: a render that React throws away still
 * runs its body, so a ref written there can be left holding a value from an
 * attempt the user never saw.
 *
 * The subtlety worth stating: a component must not switch modes mid-life. If
 * `value` starts defined and later becomes `undefined`, React silently falls
 * back to stale internal state and the component appears to freeze. That is a
 * consumer bug, and it is reported loudly in development rather than papered
 * over — a silent freeze is far harder to diagnose than a console error.
 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: UseControllableStateOptions<T>): [T, (next: T | ((current: T) => T)) => void] {
  const [uncontrolled, setUncontrolled] = useState<T>(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? (value as T) : uncontrolled

  const wasControlled = useRef(isControlled)
  useEffect(() => {
    if (!import.meta.env?.DEV) return
    if (wasControlled.current === isControlled) return
    console.error(
      `[t-lingual/ui] A component switched from ${
        wasControlled.current ? 'controlled to uncontrolled' : 'uncontrolled to controlled'
      }. Decide on one mode for the lifetime of the component; passing \`undefined\` ` +
        'to a controlled prop is the usual cause.',
    )
    wasControlled.current = isControlled
  }, [isControlled])

  const set = useEventCallback((next: T | ((previous: T) => T)) => {
    const resolved =
      typeof next === 'function' ? (next as (previous: T) => T)(current) : next
    if (Object.is(resolved, current)) return
    if (!isControlled) setUncontrolled(resolved)
    onChange?.(resolved)
  })

  return [current, set]
}
