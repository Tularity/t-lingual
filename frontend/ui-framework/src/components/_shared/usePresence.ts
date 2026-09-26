import { useEffect, useState, type RefObject } from 'react'

export type PresenceStatus = 'entering' | 'entered' | 'exiting'

export interface Presence {
  /** Whether the surface should be in the tree at all. */
  mounted: boolean
  /** What `data-state` the surface should carry. */
  status: PresenceStatus
}

/**
 * Backstop for an exit whose animations never report finished — an interrupted
 * transition, a background tab throttling rAF. A stuck overlay holding a scroll
 * lock is worse than one that unmounts slightly early.
 */
const EXIT_TIMEOUT_MS = 1200

/**
 * Slack added to the longest running exit animation when that is what sets the
 * backstop instead of the constant above. A frame or two of scheduling delay
 * must not cut the final frames off an exit that was about to finish anyway.
 */
const EXIT_TIMEOUT_MARGIN_MS = 250

/**
 * Id prefix for an animation that is one window of a loop — finite as far as
 * the Web Animations API can tell, but re-armed for ever. Exit waits on
 * finite animations, so without this marker a loop built from windows would
 * hold a closing surface open until its next window ended; it is skipped like
 * an infinite loop is.
 */
export const LOOP_ANIMATION_PREFIX = 'tl-loop:'

/**
 * When an animation will report finished, in its own time space. Infinity for
 * a loop, which never will — `finished` on an `infinite` CSS animation is a
 * promise that never settles.
 */
function endTimeOf(animation: Animation): number {
  const end = animation.effect?.getComputedTiming().endTime
  return typeof end === 'number' ? end : 0
}

/**
 * Keeps an overlay in the DOM until its exit animation has actually finished.
 *
 * This exists because of an asymmetry that catches everyone: an ENTER animation
 * works with plain conditional rendering, but an EXIT animation cannot. The
 * moment `open` becomes false and React unmounts the node, there is nothing left
 * to transition — the panel vanishes while the scrim underneath it fades, and
 * the result looks broken rather than fast.
 *
 * HOW IT WORKS
 * ------------
 * Entering is pure CSS. The surface is rendered with `data-state="entering"`,
 * `@starting-style` supplies the from-values, and the browser interpolates to
 * the resting values on insertion. No JavaScript is involved and no duration is
 * duplicated outside the stylesheet. The promotion to `entered` two frames
 * later is bookkeeping for CSS that wants to distinguish the two — the resting
 * declarations are identical for both.
 *
 * Exiting flips `data-state` to `exiting`, then asks the DOM what is actually
 * running via `getAnimations({ subtree: true })` and waits on those `finished`
 * promises. So the duration lives only in CSS; nested animations — the scrim
 * and the panel, a toast's countdown — are awaited too; an element with no
 * animation unmounts on the next frame rather than after an arbitrary timeout;
 * and reduced motion, which shortens the CSS durations, is honoured for free.
 *
 * Loops are the exception. A spinner in the footer or a live mark in the header
 * is still running while the surface leaves, and its `finished` promise will
 * never settle, so waiting on it would hold the node — and the scroll lock —
 * until the backstop fired. Anything that can never finish is left out of the
 * wait; cancelling it under `[data-state='exiting']` is then a courtesy to the
 * eye rather than a correctness requirement.
 *
 * The backstop is a fixed constant, armed before the frame callback so a
 * throttled background tab still releases the overlay. When the enumerated
 * animations say they will outlast it — the lab slows every duration several
 * times over to film an exit — the timer is re-armed to their real end plus a
 * margin, so the constant is a floor for the pathological case and never cuts
 * a healthy exit short.
 *
 * TWO SMALLER DECISIONS
 * ---------------------
 * Mounting is adjusted during render rather than from an effect. React re-runs
 * the component immediately, before committing anything, so the surface reaches
 * the DOM a render earlier than the effect version would allow — the difference
 * between an overlay that appears at once and one that visibly arrives late.
 *
 * A surface that is open on first render settles straight into `entered`.
 * There is no entrance to animate when the thing was already there the first
 * time the user saw it, and driving it through `entering` would run the enter
 * transition on content the consumer asked to be open from the start.
 */
export function usePresence(open: boolean, ref: RefObject<HTMLElement | null>): Presence {
  const [mounted, setMounted] = useState(open)
  const [status, setStatus] = useState<PresenceStatus>(open ? 'entered' : 'entering')

  // Re-opening: either the node is gone and about to be re-inserted (so it
  // must be inserted as `entering` for `@starting-style` to apply), or it is
  // still mid-exit and simply reverses. Closing flips to `exiting` the same
  // way. All three are render-time adjustments so the attribute is right on
  // the very commit that shows or starts hiding the surface, rather than one
  // render later.
  if (open && !mounted) setMounted(true)
  if (open && status === 'exiting') setStatus('entering')
  if (!open && mounted && status !== 'exiting') setStatus('exiting')

  useEffect(() => {
    if (!open || status !== 'entering') return
    // One frame later the element exists and `@starting-style` has been
    // consumed; the frame after that, promoting to `entered` is a no-op
    // visually and only serves CSS that keys on the distinction.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setStatus('entered'))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [open, status])

  // Runs after the commit in which `data-state="exiting"` actually landed in
  // the DOM, so the exit transitions exist by the time they are enumerated.
  useEffect(() => {
    if (open || !mounted || status !== 'exiting') return

    // A re-open changes the deps and runs this cleanup before anything else,
    // so `cancelled` alone is enough to keep a stale exit from unmounting a
    // surface that has since been asked to stay.
    let cancelled = false
    const finish = () => {
      if (cancelled) return
      setMounted(false)
    }

    const node = ref.current
    if (!node || typeof node.getAnimations !== 'function') {
      finish()
      return
    }

    // Started outside the frame callback so a throttled background tab still
    // releases the overlay — rAF may not fire there at all.
    let timer = window.setTimeout(finish, EXIT_TIMEOUT_MS)
    // `getAnimations()` flushes pending style, so calling it in the frame after
    // the attribute change sees the transitions that change created.
    const frame = requestAnimationFrame(() => {
      const running = node
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            (animation.playState === 'running' || animation.playState === 'paused') &&
            Number.isFinite(endTimeOf(animation)) &&
            !animation.id?.startsWith(LOOP_ANIMATION_PREFIX),
        )
      if (running.length === 0) {
        finish()
        return
      }
      const longest = Math.max(...running.map(endTimeOf)) + EXIT_TIMEOUT_MARGIN_MS
      if (Number.isFinite(longest) && longest > EXIT_TIMEOUT_MS) {
        window.clearTimeout(timer)
        timer = window.setTimeout(finish, longest)
      }
      // allSettled, not all: a cancelled animation rejects, and a cancelled
      // exit still means the element is done animating out.
      void Promise.allSettled(running.map((animation) => animation.finished)).then(finish)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [open, mounted, status, ref])

  return { mounted, status }
}
