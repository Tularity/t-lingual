import { useEffect, type RefObject } from 'react'
import { useEventCallback } from './useEventCallback'
import { surfaceContains } from './surfaceContains'

export interface UseDismissOptions {
  /** Only listens while true. */
  enabled: boolean
  /** Element that counts as "inside". */
  ref: RefObject<HTMLElement | null>
  /** Optional second element that also counts as inside — usually a trigger. */
  triggerRef?: RefObject<HTMLElement | null>
  onDismiss: () => void
  /** Set false for a popover that should survive an outside click. */
  onPointerDownOutside?: boolean
  /** Set false when an inner control owns Escape. */
  onEscapeKey?: boolean
}

/**
 * Closes a floating surface on Escape or an outside pointer press.
 *
 * Three decisions worth recording:
 *
 * - `pointerdown`, not `click`. A click fires only after pointerup, so pressing
 *   on the page and releasing on the popover would keep it open — and worse,
 *   the popover moving or unmounting between down and up means the click never
 *   arrives at all.
 * - The listener is attached in the CAPTURE phase. A trigger whose own handler
 *   calls `stopPropagation` would otherwise make the surface undismissable, and
 *   that is a common thing for an app to do without realising the consequence.
 * - Document listeners on the same node do not stop one another when a handler
 *   calls `stopPropagation`. A per-document surface stack gives Escape and
 *   outside presses only to the topmost interactive surface. A stacked modal
 *   also inerts the older surface, which must never dismiss behind it.
 */
interface DismissSurface {
  document: Document
  ref: RefObject<HTMLElement | null>
}
const surfaces: DismissSurface[] = []

function interactive(surface: DismissSurface): boolean {
  const node = surface.ref.current
  return Boolean(node?.isConnected && !node.closest('[inert], [aria-hidden="true"]'))
}
function topmost(surface: DismissSurface): boolean {
  for (let index = surfaces.length - 1; index >= 0; index -= 1) {
    const candidate = surfaces[index]
    if (candidate?.document === surface.document && interactive(candidate)) return candidate === surface
  }
  return false
}

export function useDismiss({
  enabled,
  ref,
  triggerRef,
  onDismiss,
  onPointerDownOutside = true,
  onEscapeKey = true,
}: UseDismissOptions): void {
  const dismiss = useEventCallback(onDismiss)

  useEffect(() => {
    if (!enabled) return
    const ownerDocument = ref.current?.ownerDocument ?? document
    const surface: DismissSurface = { document: ownerDocument, ref }
    surfaces.push(surface)

    const onPointerDown = (event: PointerEvent) => {
      if (!topmost(surface)) return
      const target = event.target as Node | null
      if (!target) return
      // A target detached from the document (a menu item that unmounted on
      // click) reports `contains() === false` and would read as "outside".
      if (!target.isConnected) return
      if (surfaceContains(ref.current, target)) return
      if (surfaceContains(triggerRef?.current, target)) return
      dismiss()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !topmost(surface)) return
      event.stopPropagation()
      dismiss()
    }

    if (onPointerDownOutside) {
      ownerDocument.addEventListener('pointerdown', onPointerDown, true)
    }
    if (onEscapeKey) {
      ownerDocument.addEventListener('keydown', onKeyDown)
    }
    return () => {
      ownerDocument.removeEventListener('pointerdown', onPointerDown, true)
      ownerDocument.removeEventListener('keydown', onKeyDown)
      const index = surfaces.indexOf(surface)
      if (index >= 0) surfaces.splice(index, 1)
    }
  }, [enabled, ref, triggerRef, dismiss, onPointerDownOutside, onEscapeKey])
}
