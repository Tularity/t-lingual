import { useCallback, useInsertionEffect, useRef } from 'react'

/**
 * Returns a referentially stable function that always calls the latest version
 * of `fn`.
 *
 * The point is to let a component subscribe to a DOM event, a timer or an
 * observer exactly once while still reading fresh props inside the handler —
 * without the handler identity being a dependency that tears the subscription
 * down and rebuilds it on every render.
 *
 * `useInsertionEffect` rather than `useLayoutEffect` for the assignment: it
 * runs before any layout effect in the tree, so a child's layout effect that
 * calls this handler during mount sees the current version rather than the
 * placeholder.
 */
// Two overloads rather than one optional parameter. A handler that is always
// supplied — a component's own `push`, say — must keep its exact return type;
// widening every call site to `Result | undefined` to accommodate the optional
// form would push a meaningless null check onto code that can never see one.
export function useEventCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result
export function useEventCallback<Args extends unknown[], Result>(
  fn: ((...args: Args) => Result) | undefined,
): (...args: Args) => Result | undefined
export function useEventCallback<Args extends unknown[], Result>(
  fn: ((...args: Args) => Result) | undefined,
): (...args: Args) => Result | undefined {
  const ref = useRef(fn)

  useInsertionEffect(() => {
    ref.current = fn
  })

  return useCallback((...args: Args) => ref.current?.(...args), [])
}
