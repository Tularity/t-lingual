import { useCallback, useRef, useState, type RefCallback, type RefObject } from 'react'

export interface AttachedNode<T extends HTMLElement> {
  /** For the hooks that take a ref object: useFocusTrap, useDismiss, usePresence. */
  ref: RefObject<T | null>
  /** Non-null once the element is in the document. Safe as an effect dependency. */
  node: T | null
  /** Put this on the element. */
  attach: RefCallback<T>
}

/**
 * A ref that also re-renders when the element attaches.
 *
 * This exists because of a timing trap that every overlay in this group walks
 * into. A portalled surface is not in the document during the commit in which
 * `open` first becomes true — `Portal` deliberately defers its mount by one
 * render so it never touches `document` during the first pass. (`usePresence`
 * is not the cause: it mounts during render, in the same pass.) An effect keyed
 * on `open` therefore runs, reads `ref.current`, finds `null`, returns — and
 * never runs again, because none of its dependencies change when the node
 * finally appears.
 *
 * The symptom is not a crash. It is a menu that opens without focus moving into
 * it and a popover that renders in the top-left corner, both of which look like
 * CSS problems and are not. Depending on the node itself makes "the surface is
 * now in the document" an actual state change that effects can wait for.
 */
export function useAttachedNode<T extends HTMLElement>(): AttachedNode<T> {
  const ref = useRef<T | null>(null)
  const [node, setNode] = useState<T | null>(null)

  const attach = useCallback<RefCallback<T>>((next) => {
    ref.current = next
    setNode(next)
    // React 19 ref cleanup. Clearing on detach is what stops a closed overlay
    // from holding its old node alive until the next time it opens.
    return () => {
      ref.current = null
      setNode(null)
    }
  }, [])

  return { ref, node, attach }
}
