import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The client-vs-server answer never changes within a session, so nothing to subscribe to. */
const subscribeNever = () => () => {}

export interface PortalProps {
  children: ReactNode
  /** Defaults to `document.body`. */
  container?: HTMLElement | null
}

/**
 * Renders children into a different part of the DOM.
 *
 * Overlays portal to <body> so they escape any ancestor that creates a
 * containing block or a clip — `overflow: hidden`, `transform`, `filter`,
 * `contain`, or a `position: sticky` header. A dropdown inside a scrolling
 * table that gets clipped at the table edge is the canonical symptom, and no
 * amount of z-index fixes it because the problem is the stacking/clip context,
 * not the paint order.
 *
 * Mount is deferred one render so nothing touches `document` during the first
 * pass. This keeps the component safe to render on a server and avoids the
 * hydration mismatch that portalling on the very first client render produces.
 *
 * That deferral has a consequence worth stating here, because it is invisible
 * from the call site: children are NOT in the document during the commit in
 * which the portal first renders, so an effect in a parent that reads a ref
 * pointing inside this subtree finds `null` — and, since a ref object's identity
 * never changes, that effect is never re-run when the node does attach. Anything
 * that needs to act on a portalled element must therefore depend on the node
 * itself rather than on a ref; `useAttachedNode` in components/_shared exists
 * for exactly that, and every overlay in this package uses it.
 */
export function Portal({ children, container }: PortalProps) {
  // `useSyncExternalStore` rather than a `setState` in an effect. Both defer the
  // mount by one render, but this one expresses the actual question — "is there
  // a document yet" — as a store with a distinct server snapshot, instead of a
  // cascading render that the compiler correctly flags as an effect writing
  // state for no external reason.
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )

  if (!mounted) return null
  const target = container ?? (typeof document !== 'undefined' ? document.body : null)
  if (!target) return null
  return createPortal(children, target)
}
