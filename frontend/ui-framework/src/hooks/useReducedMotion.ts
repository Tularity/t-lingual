import { useMediaQuery } from './useMediaQuery'

/**
 * True when the user has asked the OS to reduce motion.
 *
 * Most of the framework honours this through the motion multiplier tokens and
 * never needs the hook. It exists for the cases CSS genuinely cannot reach:
 * choosing whether to auto-scroll a live transcript smoothly or jump, and
 * whether to run a JS-driven animation at all.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}
