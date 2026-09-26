/* ---------------------------------------------------------------------------
 * ROUNDING, ONLY WHILE IT CHANGES
 *
 * Every moving part of the wave is a transform the compositor runs on its
 * own, except one: the tile rounding its corners in the dip. Border-radius
 * cannot be composited, so as a CSS loop it keeps the main thread producing a
 * frame on every vsync for as long as the mark is on screen — even through
 * the nine tenths of each loop when a cell's corners sit still at zero.
 * Measured, that was most of the main-thread cost of a spinner, and six
 * loading buttons saturated a slowed-down CPU on it alone.
 *
 * So once the page has settled into the CSS loop, this takes the rounding
 * over with one Web Animation per cell that holds exactly the CSS keyframes
 * but is only in effect for the rounding's own tenth of the loop; for the rest
 * it sits in its end delay, where the browser has nothing to update. Each is
 * placed on the same document timeline as that cell's CSS dip, from the dip's
 * own start time and delay, so the two sample the same instant and the pixels
 * are the same as the CSS version — checked frame by frame at 12 to 192px and
 * at 1x and 2x.
 *
 * It only takes over from the framework's own, running dip. A mark with no
 * loop (reduced motion), a paused or frozen one, or one whose keyframes a
 * consumer has replaced keeps the CSS rounding, which is always declared and
 * is what a browser without the Web Animations API gets.
 * ------------------------------------------------------------------------- */
import { useEffect, type RefObject } from 'react'
import { LOOP_ANIMATION_PREFIX } from '../_shared/usePresence'

/** The CSS dip each window is aligned to. */
export const DIP_ANIMATION = 'tl-compact-mark-dip'

/**
 * The share of the loop the rounding moves in: the last keyframe of
 * `tl-compact-mark-round` in CompactMark.css, which holds zero from there on.
 */
export const ROUND_SPAN = 0.1

const EASE = 'cubic-bezier(0.45, 0, 0.55, 1)'

/**
 * `tl-compact-mark-round` rescaled to its window: 5.5% of the loop is 0.55 of
 * the 10% window. The stylesheet stays the source of truth; a test holds
 * these two in step.
 */
export const ROUND_KEYFRAMES: Keyframe[] = [
  { borderRadius: '0', offset: 0, easing: EASE },
  { borderRadius: '45%', offset: 0.55, easing: EASE },
  { borderRadius: '0', offset: 1 },
]

/** Start of the loop that `now` falls in, for a loop whose first begins at `firstBegin`. */
export function loopStart(now: number, firstBegin: number, cycle: number): number {
  return firstBegin + Math.floor((now - firstBegin) / cycle) * cycle
}

const isOwnDip = (animation: Animation) =>
  typeof CSSAnimation !== 'undefined' &&
  animation instanceof CSSAnimation &&
  animation.animationName === DIP_ANIMATION

/**
 * Takeovers are batched per frame: every mark that wants to (re)align reads
 * first, then all of them write. Reading the running animations flushes
 * style, and the attribute and new animations dirty it again, so marks that
 * each read and then wrote in turn forced a full style pass per mark — on a
 * page mounting a hundred and forty of them, a freeze of several seconds.
 * Batched, a frame pays for one.
 */
type Read = () => (() => void) | void
const queued = new Set<Read>()
let batchFrame = 0
function enqueue(read: Read) {
  queued.add(read)
  if (!batchFrame) batchFrame = requestAnimationFrame(runBatch)
}
function runBatch() {
  batchFrame = 0
  const reads = [...queued]
  queued.clear()
  const writes = reads.map((read) => read())
  for (const write of writes) write?.()
}

/**
 * Keeps each cell's rounding in a window aligned to its CSS dip, and marks the
 * root `data-rounding="scripted"` while the windows are in charge so the CSS
 * rounding steps aside. The attribute is set on the element directly rather
 * than through state: taking over re-renders nothing. `key` must change
 * whenever the loop's timing or cells do.
 */
export function useRoundingWindows(ref: RefObject<HTMLElement | null>, active: boolean, key: string): void {
  useEffect(() => {
    const root = ref.current
    if (!active || !root || typeof root.animate !== 'function') return
    let windows: Animation[] = []
    let disposed = false

    const setScripted = (on: boolean) => {
      if (on) root.setAttribute('data-rounding', 'scripted')
      else root.removeAttribute('data-rounding')
    }
    const stop = () => {
      for (const round of windows) round.cancel()
      windows = []
    }
    const handBack = () => {
      stop()
      setScripted(false)
    }

    // Reads what the CSS is doing and returns what to write; writes nothing.
    const read: Read = () => {
      if (disposed) return
      const cells = [...root.querySelectorAll<HTMLElement>('.tl-compact-mark__cell')]
      const dipOf = new Map<Element | null, Animation>()
      for (const animation of root.getAnimations({ subtree: true })) {
        if (isOwnDip(animation)) dipOf.set((animation.effect as KeyframeEffect).target, animation)
      }
      const dips = cells.map((cell) => dipOf.get(cell))
      if (!cells.length || dips.some((dip) => !dip || dip.playState !== 'running')) return handBack
      // A dip that has not started yet has no start time to align to; take
      // over once every one of them is under way.
      if (dips.some((dip) => dip!.pending || dip!.startTime === null)) {
        void Promise.all(dips.map((dip) => dip!.ready)).then(() => enqueue(read), () => {})
        return
      }
      const plan = cells.map((cell, i) => {
        const timing = dips[i]!.effect!.getTiming()
        return {
          fill: cell.querySelector<HTMLElement>('.tl-compact-mark__fill')!,
          cycle: Number(timing.duration),
          firstBegin: Number(dips[i]!.startTime) + Number(timing.delay ?? 0),
        }
      })
      return () => {
        if (disposed) return
        stop()
        windows = plan.map(({ fill, cycle, firstBegin }) => {
          const round = fill.animate(ROUND_KEYFRAMES, {
            duration: cycle * ROUND_SPAN,
            endDelay: cycle * (1 - ROUND_SPAN),
            fill: 'none',
          })
          // A loop's window, which presence must not wait on.
          round.id = `${LOOP_ANIMATION_PREFIX}compact-mark-round`
          const arm = () => {
            round.startTime = loopStart(Number(document.timeline.currentTime), firstBegin, cycle)
          }
          arm()
          round.onfinish = arm
          return round
        })
        setScripted(true)
      }
    }

    // The CSS loop starting (again) is the cue to realign; it being cancelled
    // — reduced motion switched on, or a surface closing around the mark —
    // hands the rounding straight back.
    const onStart = (event: AnimationEvent) => {
      if (event.animationName === DIP_ANIMATION) enqueue(read)
    }
    const onCancel = (event: AnimationEvent) => {
      if (event.animationName === DIP_ANIMATION) handBack()
    }

    root.addEventListener('animationstart', onStart)
    root.addEventListener('animationcancel', onCancel)
    enqueue(read)
    return () => {
      disposed = true
      queued.delete(read)
      root.removeEventListener('animationstart', onStart)
      root.removeEventListener('animationcancel', onCancel)
      handBack()
    }
  }, [ref, active, key])
}
