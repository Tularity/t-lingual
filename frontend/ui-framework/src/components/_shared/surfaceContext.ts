import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react'

/**
 * The labelling contract shared by Dialog and Drawer.
 *
 * Both are `role="dialog"` surfaces that must be named by their own heading,
 * and the wiring is identical: the surface owns two generated ids, the title
 * and description sub-components claim them, and the surface points
 * `aria-labelledby` / `aria-describedby` at whichever of the two actually
 * rendered. It lives here because the alternative — guessing — is worse in both
 * directions: always emitting `aria-labelledby` leaves a dangling IDREF and an
 * unnamed dialog when the consumer used `aria-label` instead, and never
 * emitting it makes the common case require manual ids at every call site.
 *
 * Registration is state rather than a DOM query so the attribute is present in
 * the same commit the heading is, not one paint later. It costs one extra
 * render when a dialog opens, which is the correct trade for a surface that
 * only mounts on an explicit user action.
 */
export interface OverlaySurface {
  titleId: string
  descriptionId: string
  hasTitle: boolean
  hasDescription: boolean
  setHasTitle: (present: boolean) => void
  setHasDescription: (present: boolean) => void
  /** Closes the surface. Wired to the header's close button. */
  close: () => void
  closeLabel: string
  showCloseButton: boolean
}

export const OverlaySurfaceContext = createContext<OverlaySurface | null>(null)

export function useOverlaySurface(component: string): OverlaySurface {
  const surface = useContext(OverlaySurfaceContext)
  if (!surface) {
    throw new Error(
      `[t-lingual/ui] <${component}> must be rendered inside the overlay it belongs to.`,
    )
  }
  return surface
}

export interface UseOverlaySurfaceValueOptions {
  /** Must be referentially stable; it ends up in the context value. */
  close: () => void
  closeLabel: string
  showCloseButton: boolean
}

export function useOverlaySurfaceValue({
  close,
  closeLabel,
  showCloseButton,
}: UseOverlaySurfaceValueOptions): OverlaySurface {
  const titleId = useId()
  const descriptionId = useId()
  const [hasTitle, setHasTitle] = useState(false)
  const [hasDescription, setHasDescription] = useState(false)

  return useMemo(
    () => ({
      titleId,
      descriptionId,
      hasTitle,
      hasDescription,
      setHasTitle,
      setHasDescription,
      close,
      closeLabel,
      showCloseButton,
    }),
    [titleId, descriptionId, hasTitle, hasDescription, close, closeLabel, showCloseButton],
  )
}

/**
 * Claims one of the surface's ids for a title or description element, and
 * releases it on unmount so a dialog whose heading is conditionally rendered
 * does not keep pointing at an id that is no longer in the document.
 */
export function useSurfaceLabelId(part: 'title' | 'description', component: string): string {
  const surface = useOverlaySurface(component)
  const register = part === 'title' ? surface.setHasTitle : surface.setHasDescription

  useEffect(() => {
    register(true)
    return () => register(false)
  }, [register])

  return part === 'title' ? surface.titleId : surface.descriptionId
}
