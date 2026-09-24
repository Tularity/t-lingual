import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribes to a media query.
 *
 * `useSyncExternalStore` rather than `useState` + effect: it gives a correct
 * server snapshot, and it removes the one-frame window after mount where the
 * component has rendered with a guessed value that the effect then corrects —
 * a flash that is very visible on a layout that switches between a sidebar and
 * a drawer.
 */
export function useMediaQuery(query: string, serverFallback = false): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const list = window.matchMedia(query)
      // Safari only gained addEventListener on MediaQueryList in 14. The
      // fallback costs one branch and buys back several years of iOS.
      if (list.addEventListener) {
        list.addEventListener('change', notify)
        return () => list.removeEventListener('change', notify)
      }
      list.addListener(notify)
      return () => list.removeListener(notify)
    },
    [query],
  )

  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia(query).matches
        : serverFallback,
    () => serverFallback,
  )
}
