import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { COLLAPSE_MARK_GATHER_FROM, COLLAPSE_MARK_GONE, CollapseMark, IRIS_EDGE, iris, useLoadsSettled } from '@tular/ui'
import { LIFT_MS, LOGO_INHALE_MS, LOGO_SETTLE_MS, LOGO_SWELL_MS, SIGN_IN_CIRCLE_MS, SIGN_IN_OPEN_MS, SIGN_IN_WINDOW_MS, SIGN_OUT_CLOSE_MS, signInEnds, signInSeconds, type CurtainKind, type CurtainStage } from './stageTiming'
import type { Point } from './stage'
import './curtain.css'

const still = <img src="/brand/tularity.svg" alt="" />

/**
 * The layer drawn over the page while the session changes hands.
 *
 * `enter` is signing in: the login page slides away, the logo's collapse
 * plays on a plain backdrop while the workspace loads out of sight, and once
 * it has loaded the dots the collapse leaves behind are drawn into the
 * workspace's logo while a circle opening from that logo uncovers it. `exit`
 * is signing out: the workspace closes in a circle onto the sign-out button
 * while the session ends, and the login page fades in.
 */
/**
 * Signing in's animation: the whole sequence, at twice the collapse's own
 * pace — and at five times it from the tilt on, the moment the workspace has
 * loaded, never before the tilt. Until the workspace has loaded the
 * collapse is the one every loader plays, its cells carried off; from the
 * moment it has, the cells still on their way are caught, and those yet to
 * go come apart, as dots thrown outward and slowing to a stop. Loaded, and
 * with a third of the body still standing, the earliest dots start to leave
 * for the workspace's logo, one after another as each comes to rest, while
 * the rest of the collapse plays on; the logo draws in, swells as they land
 * and settles. Still loading when a pass ends, the pass was an ordinary one,
 * and it goes round again (see signInSeconds and signInEnds). `onGather` is
 * told which logo the dots are going to as the first leaves; `onGathered`,
 * when the last has arrived.
 */
function SignInMark({ onGather, onGathered }: { onGather: (logo: Element) => void; onGathered: () => void }) {
  const settled = useLoadsSettled()
  const loaded = useRef(settled)
  useEffect(() => {
    loaded.current = settled
  }, [settled])
  const passes = useRef(0)
  const pace = useCallback((phase: number) => signInSeconds(phase, loaded.current), [])
  const last = useCallback(() => {
    passes.current += 1
    return signInEnds(passes.current, loaded.current)
  }, [])
  const lingers = useCallback(() => loaded.current, [])
  const own = useRef<HTMLDivElement>(null)
  // The logo the workspace shows — the sidebar's, or the header's on a narrow
  // screen; with none in view the dots are drawn into their own.
  const logo = useCallback(() => [...document.querySelectorAll('.app-frame .brand__mark')].find(visible) ?? own.current, [])
  const gather = useCallback((target: Element) => {
    if (target !== own.current) answer(target)
    onGather(target)
  }, [onGather])
  return (
    <CollapseMark
      ref={own}
      className="app-curtain__mark"
      still={still}
      to={COLLAPSE_MARK_GONE}
      duration={pace}
      once={last}
      linger={lingers}
      gatherTo={logo}
      gatherFrom={COLLAPSE_MARK_GATHER_FROM}
      onGather={gather}
      onGathered={onGathered}
    />
  )
}

function visible(element: Element) {
  const box = element.getBoundingClientRect()
  return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight
}

/** The receiving logo's answer to the dots: it draws in as they are pulled
 *  towards it, swells as they land, then settles back, overshooting once. */
function answer(logo: Element) {
  if (typeof logo.animate !== 'function') return
  const total = LOGO_INHALE_MS + LOGO_SWELL_MS + LOGO_SETTLE_MS
  const at = (ms: number) => ms / total
  logo.animate(
    [
      { scale: 1, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
      { scale: 0.93, offset: at(LOGO_INHALE_MS), easing: 'cubic-bezier(0.5, 0, 0.75, 0)' },
      { scale: 1.2, offset: at(LOGO_INHALE_MS + LOGO_SWELL_MS), easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
      { scale: 0.96, offset: at(LOGO_INHALE_MS + LOGO_SWELL_MS + LOGO_SETTLE_MS * 0.4), easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
      { scale: 1.02, offset: at(LOGO_INHALE_MS + LOGO_SWELL_MS + LOGO_SETTLE_MS * 0.72), easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
      { scale: 1 },
    ],
    { duration: total },
  )
}

/**
 * The workspace uncovered, from its logo outward. As the dots set off, a
 * small round window opens in the backdrop over the logo; from the first
 * arrival it widens — gently at first, fastest midway, easing out past the
 * farthest corner — until nothing of the backdrop is left.
 */
function uncover(backdrop: HTMLElement | null, logo: Element) {
  if (!backdrop) return
  const box = logo.getBoundingClientRect()
  const window = Math.min(box.width, (box.height * 4) / 3) * 0.62 + IRIS_EDGE
  iris(backdrop, {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    stops: [
      { radius: 0, at: 0, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
      { radius: window, at: SIGN_IN_WINDOW_MS },
      { radius: window * 1.15, at: LOGO_INHALE_MS, easing: 'cubic-bezier(0.55, 0, 0.3, 1)' },
      { radius: 'cover', at: LOGO_INHALE_MS + SIGN_IN_OPEN_MS },
    ],
  })
}

/** The workspace closed onto the sign-out button: the whole screen shrinks
 *  into a circle there — slowly at first, quickest midway, settling as it
 *  shuts. */
function closeOnto(backdrop: HTMLElement | null, origin: Point | undefined) {
  if (!backdrop) return
  const { x, y } = origin ?? { x: innerWidth / 2, y: innerHeight / 2 }
  iris(backdrop, {
    x, y,
    stops: [
      { radius: 'cover', at: 0, easing: 'cubic-bezier(0.55, 0, 0.35, 1)' },
      { radius: 0, at: SIGN_OUT_CLOSE_MS },
    ],
  })
}

/**
 * `origin` is where a sign-out closes onto. `onSignedIn` is told when a
 * sign-in starts to uncover the workspace, and `onSettled` when it has
 * uncovered it in full and every dot has arrived.
 */
export function Curtain({ kind, stage, origin, onSignedIn, onSettled }: {
  kind: CurtainKind
  stage: CurtainStage
  origin?: Point
  onSignedIn?: () => void
  onSettled?: () => void
}) {
  const backdrop = useRef<HTMLDivElement>(null)
  // A sign-out's circle starts closing before its first frame is painted.
  useLayoutEffect(() => {
    if (kind === 'exit') closeOnto(backdrop.current, origin)
  }, [kind, origin])

  // A sign-in is settled once both its circle has opened and its dots are in.
  const waitingOn = useRef(2)
  const circle = useRef(0)
  useEffect(() => () => window.clearTimeout(circle.current), [])
  const settle = () => {
    waitingOn.current -= 1
    if (waitingOn.current === 0) onSettled?.()
  }
  const gather = (logo: Element) => {
    uncover(backdrop.current, logo)
    circle.current = window.setTimeout(settle, SIGN_IN_CIRCLE_MS)
    onSignedIn?.()
  }

  return (
    <div className="app-curtain" data-kind={kind} data-stage={stage} style={{ '--_lift': `${LIFT_MS}ms` } as CSSProperties} aria-hidden="true">
      <div ref={backdrop} className="app-curtain__backdrop" />
      {kind === 'enter' && stage !== 'leave' && <SignInMark onGather={gather} onGathered={settle} />}
    </div>
  )
}
