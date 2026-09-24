import { useEffect, type RefObject } from 'react'
import { surfaceContains } from './surfaceContains'

/** Elements that can hold focus, minus the ones that only look like they can. */
const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    // `offsetParent === null` is the cheap visibility test, but it is also null
    // for `position: fixed` elements — which is exactly what a dialog is. The
    // rect check covers that case without a full getComputedStyle pass.
    if (element.hasAttribute('inert')) return false
    if (element.closest('[inert]')) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  })
}

export interface UseFocusTrapOptions {
  enabled: boolean
  ref: RefObject<HTMLElement | null>
  /** Focused on open. Defaults to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Restores focus to whatever had it before open. Defaults to true. */
  restoreFocus?: boolean
}

/**
 * Confines Tab to a subtree while it is open, and gives focus back on close.
 *
 * Restoring focus is the part that matters most and gets skipped most often.
 * When a dialog closes and focus is not returned, the browser sends it to
 * <body>, so the next Tab starts from the top of the page — a keyboard user who
 * opened a dialog from a control near the bottom of a long settings page is
 * dropped back at the header with no indication of what happened.
 *
 * The trap deliberately does not fight programmatic focus moves from inside the
 * subtree. It only intercepts Tab at the boundary; a component that moves focus
 * on purpose (a combobox pushing focus to its list) keeps working.
 */
export function useFocusTrap({
  enabled,
  ref,
  initialFocus,
  restoreFocus = true,
}: UseFocusTrapOptions): void {
  useEffect(() => {
    if (!enabled) return
    const container = ref.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    // Deferred a frame: on open the panel is often still mid-transition, and an
    // element with zero height fails the visibility filter above.
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocus?.current ??
        container.querySelector<HTMLElement>('[data-autofocus]') ??
        getFocusable(container)[0] ??
        container
      target.focus({ preventScroll: true })
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = getFocusable(container)
      if (focusable.length === 0) {
        // Nothing to tab to; keep focus on the container rather than letting it
        // escape to the page behind the scrim.
        event.preventDefault()
        container.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement

      if (event.shiftKey && (active === first || !surfaceContains(container, active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !surfaceContains(container, active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      if (restoreFocus && previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [enabled, ref, initialFocus, restoreFocus])
}
