/* ---------------------------------------------------------------------------
 * THE COLLAPSE MARK
 *
 * The logo's large animation, for the places where the logo is the only thing
 * on screen while something loads. The four pieces fade in and assemble, then
 * the body collapses cell by cell from its upper-right corner, every cell
 * drifting off the way the logo's tail leaves until nothing is left, and the
 * sequence begins again. Unlike the compact mark's wave, it is allowed to take
 * the logo apart, because here nothing else competes for attention.
 *
 * Lingering — from the start, or from whenever it is told to — the cells
 * stay behind instead, as dots, which can then be sent into the logo
 * somewhere else on the page: the logo the screen is about to hand over to.
 *
 * Drawn to a canvas from the tracks in collapseMarkScene.ts, in a worker that
 * owns the canvas, so the geometry and the per-frame canvas hand-off both stay
 * off the main thread, which only posts the current phase once a frame. The
 * drawing code and the geometry live only in the worker's file, loaded when a
 * mark mounts, never with the page that merely might show one. A browser that
 * cannot hand a canvas to a worker shows the still instead, as reduced motion
 * does: a loading screen is the worst place to add main-thread work.
 *
 * The canvas is created inside the effect rather than rendered: control of a
 * canvas can be transferred once, and StrictMode runs effects twice.
 * ------------------------------------------------------------------------- */
import { forwardRef, useEffect, useMemo, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { composeRefs } from '../../primitives/Slot'
import { cx } from '../../utils/cx'
import type { CollapseMarkBox, CollapseMarkGather, CollapseMarkGatherEvent, CollapseMarkInks, CollapseMarkMessage } from './collapseMarkScene'
import { COLLAPSE_MARK_GONE } from './collapseMarkTiming'
import './CollapseMark.css'

export interface CollapseMarkProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * Width in px; the height follows the logo's 4:3 frame. Omit to size the
   * element from CSS instead — the drawing fits whatever box it is given.
   */
  size?: number
  /**
   * Seconds for one sequence, 12 by default (COLLAPSE_MARK_SECONDS). May be a
   * function of the current phase, asked every frame, for a pace that changes
   * as the sequence goes or as the world around it does.
   */
  duration?: number | ((phase: number) => number)
  /**
   * Rest on the last frame of the slice instead of looping. May be a function,
   * asked each time a pass reaches its end, to decide there and then whether
   * that pass is the last.
   */
  once?: boolean | (() => boolean)
  /** Called when a pass that is the last one comes to rest on its end. */
  onEnd?: () => void
  /**
   * The slice of the sequence to play, as phases from 0 (empty, before the
   * pieces arrive) to 1 (empty again, every cell gone). The pieces are
   * assembled and upright at 0.2, just before the collapse begins at 0.22;
   * so `to={0.2}` plays only the assembly and `from={0.2}` only the collapse.
   * The speed is still `duration` seconds per whole sequence.
   */
  from?: number
  to?: number
  /** Milliseconds to hold the first frame of the slice before it moves. */
  delay?: number
  /**
   * Let the collapse leave its cells behind: each shrinks only to a dot and
   * is thrown outward, slowing to a stop, and stays; every dot is at rest by
   * COLLAPSE_MARK_GONE. `true` lingers every pass from its start. A function
   * is asked every frame until it answers true, and the pass lingers from
   * that moment: cells already fading go on leaving, cells still on their way
   * are caught and brought to rest, cells yet to go become dots. A pass that
   * lingered and goes round again draws its dots back into the logo as it
   * reassembles. Given at all, the drawing is laid over the whole viewport,
   * still centred on this element's box, so the dots can be sent anywhere on
   * the page (`gatherTo`); it never takes a pointer event.
   */
  linger?: boolean | (() => boolean)
  /**
   * An element showing the static logo, into which a lingering pass sends its
   * dots — or a function asked for it when the time comes. The dots leave one
   * at a time in the order they became dots, each once it has all but
   * stopped, and are drawn in faster and faster, shrinking to that logo's
   * scale as they arrive (COLLAPSE_MARK_GATHER_STAGGER_MS apart, each for
   * COLLAPSE_MARK_GATHER_FLIGHT_MS). The logo is taken to fill the element as
   * an image would (contained, centred). A pass that sends its dots comes to
   * rest at its end rather than going round again.
   */
  gatherTo?: Element | null | (() => Element | null)
  /**
   * The phase from which a lingering pass may start sending its dots, while
   * the rest of it is still collapsing — COLLAPSE_MARK_GATHER_FROM, say, once
   * two thirds of the body have gone. By default only once the pass is over.
   */
  gatherFrom?: number
  /** Called as the first dot leaves, with the element it is going to. */
  onGather?: (logo: Element) => void
  /** Called when the last dot has arrived. */
  onGathered?: () => void
  /**
   * Shown in place of the animation when the user asks for reduced motion,
   * or the browser cannot draw it off the main thread. Pass the static logo:
   * the mark never draws a still of its own, so the static logo stays
   * whatever the product's logo file is.
   */
  still?: ReactNode
  /**
   * Accessible name. Omit for a decorative mark (it is then `aria-hidden`);
   * supplying it makes the element `role="img"`.
   */
  label?: string
}

/** The logo's ink tokens, read where the mark is, so the worker gets real colours. */
function readInks(element: Element): CollapseMarkInks {
  const style = getComputedStyle(element)
  const ink = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return [ink('--tl-logo-solid', '#f49c12'), ink('--tl-logo-base', '#e99a22'), ink('--tl-logo-light', '#f7b338')]
}

/** Whether a canvas can be handed to a worker here. */
const offThread = () =>
  typeof Worker !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'

/** The logo's 4:3 frame, contained and centred in a box, as an image shows it. */
function frameIn(rect: DOMRect) {
  const width = Math.min(rect.width, (rect.height * 4) / 3)
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width }
}

/** Dots drawn back into their own logo shrink to this share of their size. */
const HOME_SCALE = 0.4

/** The first dot leaves a gathering at once; a worker that has sent none by
 *  now is not drawing it, and the gathering is ended without it. */
const SILENT_GATHERING_MS = 4000

export const CollapseMark = forwardRef<HTMLDivElement, CollapseMarkProps>(function CollapseMark(
  {
    size, duration = 12, once = false, onEnd, from = 0, to = 1, delay = 0,
    linger = false, gatherTo = null, gatherFrom = COLLAPSE_MARK_GONE, onGather, onGathered, still, label, className, style, ...rest
  },
  ref,
) {
  const showStill = useReducedMotion() || !offThread()
  const host = useRef<HTMLDivElement>(null)
  const timing = useRef({ duration, once, onEnd, from, to, delay, linger, gatherTo, gatherFrom, onGather, onGathered })
  /** Restarts the clock after it has come to rest, for a gathering. */
  const wake = useRef<(() => void) | null>(null)
  useEffect(() => {
    timing.current = { duration, once, onEnd, from, to, delay, linger, gatherTo, gatherFrom, onGather, onGathered }
    wake.current?.()
  }, [duration, once, onEnd, from, to, delay, linger, gatherTo, gatherFrom, onGather, onGathered])
  /** Whether the drawing may leave its box: it may, wherever it could linger. */
  const spill = linger !== false

  // Standing still, a pass is still a pass: whoever waits for it to end is
  // told after the time it would have taken — and, with no dots to send, any
  // gathering is over as soon as it begins.
  useEffect(() => {
    if (!showStill) return
    const { duration: pace, from: start, to: end, delay: hold } = timing.current
    const seconds = typeof pace === 'function' ? pace(start) : pace
    const timer = window.setTimeout(() => {
      const { onEnd: ended, gatherTo: asked, onGather: gathering, onGathered: gathered } = timing.current
      ended?.()
      const logo = typeof asked === 'function' ? asked() : asked
      if (!logo) return
      gathering?.(logo)
      gathered?.()
    }, hold + (end - start) * seconds * 1000)
    return () => window.clearTimeout(timer)
  }, [showStill])

  useEffect(() => {
    const element = host.current
    if (showStill || !element) return
    const canvas = document.createElement('canvas')
    canvas.className = 'tl-collapse-mark__canvas'
    element.append(canvas)
    let bounds = canvas.getBoundingClientRect()
    /** Device pixels per CSS pixel of the canvas. */
    let ratio = devicePixelRatio
    let width = Math.round(bounds.width * ratio)
    let height = Math.round(bounds.height * ratio)
    // Lingering, the canvas covers the viewport and the frame is placed on it
    // where this element is.
    const place = (): CollapseMarkBox | undefined => {
      if (!spill) return undefined
      const own = element.getBoundingClientRect()
      return [(own.left - bounds.left) * ratio, (own.top - bounds.top) * ratio, own.width * ratio, own.height * ratio]
    }
    const offscreen = canvas.transferControlToOffscreen()
    const worker = new Worker(new URL('./collapseMark.worker.ts', import.meta.url), { type: 'module' })
    const post = (message: CollapseMarkMessage, transfer: Transferable[] = []) => worker.postMessage(message, transfer)
    post({ type: 'init', canvas: offscreen, inks: readInks(element), width, height, box: place() }, [offscreen])

    // Exact device pixels, so the drawing lands on the pixel grid.
    const remeasure = () => {
      bounds = canvas.getBoundingClientRect()
      post({ type: 'resize', width, height, box: place() })
    }
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target !== canvas) continue
              const device = entry.devicePixelContentBoxSize?.[0]
              width = device ? device.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio)
              height = device ? device.blockSize : Math.round(entry.contentRect.height * devicePixelRatio)
              ratio = entry.contentRect.width ? width / entry.contentRect.width : devicePixelRatio
            }
            remeasure()
          })
    // Safari hands a canvas to a worker but has no device-pixel box, and an
    // unknown box is a TypeError, not a no-op; there the content box, scaled
    // by devicePixelRatio above, stands in for it.
    try {
      observer?.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      observer?.observe(canvas)
    }
    if (spill) {
      observer?.observe(element)
      window.addEventListener('scroll', remeasure, { capture: true, passive: true })
    }

    /** Where a gathering goes: an element's logo, or this mark's own body. */
    const destination = (target: Element | null) => {
      const own = frameIn(element.getBoundingClientRect())
      const logo = target ? frameIn(target.getBoundingClientRect()) : own
      return {
        x: (logo.x - bounds.left) * ratio,
        y: (logo.y - bounds.top) * ratio,
        scale: target ? logo.width / (own.width || 1) : HOME_SCALE,
      }
    }

    // The clock. A long frame advances the sequence by at most 100 ms, so a
    // stall resumes where it left off instead of skipping ahead. A gathering
    // runs on wall time alongside it; the worker, which knows where every dot
    // is, decides when each leaves and says when the first has gone and the
    // last has arrived.
    let phase = timing.current.from
    let started = 0
    let previous = 0
    let frame = 0
    let resting = false
    /** Where this pass began to linger, once it has. */
    let lingerFrom: number | null = null
    /** This pass is sending its dots to a logo, so it will come to rest. */
    let sending = false
    let serial = 0
    let gathering: { id: number; since: number; to: ReturnType<typeof destination>; logo: Element | null; departed?: boolean } | null = null
    /** The worker failed — its script refused, or its drawing threw. */
    let broken = false
    // Whoever waits on a gathering is never left waiting on a worker that
    // cannot draw it: the gathering is over as soon as it is asked for.
    const giveUp = () => {
      if (!gathering) return
      const { logo: to, departed } = gathering
      gathering = null
      if (!to) return
      if (!departed) timing.current.onGather?.(to)
      timing.current.onGathered?.()
    }
    const lingers = () => {
      const { linger: asked } = timing.current
      return typeof asked === 'function' ? asked() : asked
    }
    const logo = () => {
      const { gatherTo: asked } = timing.current
      return typeof asked === 'function' ? asked() : asked
    }
    worker.onerror = (event) => {
      event.preventDefault()
      broken = true
      giveUp()
    }
    worker.onmessage = ({ data }: MessageEvent<CollapseMarkGatherEvent>) => {
      if (data.id !== gathering?.id) return
      const { logo: to } = gathering
      if (data.event === 'departed') gathering.departed = true
      if (data.event === 'departed' && to) timing.current.onGather?.(to)
      if (data.event === 'gathered') {
        gathering = null
        if (to) timing.current.onGathered?.()
      }
    }
    const tick = (now: number) => {
      frame = 0
      const { duration: pace, once: last, from: start, to: end, delay: hold, gatherFrom: sendFrom } = timing.current
      started ||= now
      if (!resting && now - started >= hold) {
        const seconds = typeof pace === 'function' ? pace(phase) : pace
        if (previous) phase += Math.min((now - previous) / 1000, 0.1) / seconds
        previous = now
      }
      let ended = false
      if (!resting && phase >= end) {
        resting = sending || (typeof last === 'function' ? last() : last)
        ended = resting
        if (resting) phase = end
        else {
          phase = start + ((phase - start) % (end - start))
          // Going round again, the last pass's dots are drawn back into the
          // logo as it reassembles.
          if (lingerFrom !== null) gathering = { id: ++serial, since: now, to: destination(null), logo: null }
          lingerFrom = null
        }
      }
      if (!resting && lingerFrom === null && lingers()) lingerFrom = phase
      let nothingToSend: Element | null = null
      if (!sending && (resting || (lingerFrom !== null && phase >= sendFrom))) {
        const to = logo()
        if (to) {
          sending = true
          // A pass that never lingered has nothing to send.
          if (lingerFrom === null) nothingToSend = to
          else gathering = { id: ++serial, since: now, to: destination(to), logo: to }
        }
      }
      const gather: CollapseMarkGather | undefined = gathering
        ? { id: gathering.id, since: gathering.since, now, ...gathering.to, previous: !gathering.logo }
        : undefined
      post({ type: 'draw', phase, frame: { lingerFrom, gather } })
      if (broken || (gathering && !gathering.departed && now - gathering.since > SILENT_GATHERING_MS)) giveUp()
      if (ended) timing.current.onEnd?.()
      if (nothingToSend) {
        timing.current.onGather?.(nothingToSend)
        timing.current.onGathered?.()
      }
      if (!resting || gathering) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    wake.current = () => {
      if (!frame) frame = requestAnimationFrame(tick)
    }

    return () => {
      wake.current = null
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('scroll', remeasure, { capture: true })
      worker.terminate()
      canvas.remove()
    }
  }, [showStill, spill])

  const setRefs = useMemo(() => composeRefs<HTMLDivElement>(ref, host), [ref])
  return (
    <div
      ref={setRefs}
      data-tl="collapse-mark"
      className={cx('tl-collapse-mark', className)}
      data-motion={showStill ? undefined : 'collapse'}
      data-linger={spill || undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ ...(size === undefined ? null : { width: `${size}px` }), ...style } as CSSProperties}
      {...rest}
    >
      {showStill && still}
    </div>
  )
})
