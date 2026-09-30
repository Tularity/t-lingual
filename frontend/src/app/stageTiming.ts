/* Timings of the screen-wide transitions, in one place so the orchestration
 * and the CSS that plays them cannot disagree. */
import { COLLAPSE_MARK_COLLAPSE_START, COLLAPSE_MARK_GATHER_FLIGHT_MS, COLLAPSE_MARK_GATHER_STAGGER_MS } from '@t-lingual/ui'

/** Signing in and signing out. A page that loads, or reloads, shows nothing
 *  over itself while it finds out who is signed in. */
export type CurtainKind = 'enter' | 'exit'
/** `leave` and `play` belong to signing in only: the login page leaving, then
 *  the animation playing over the workspace until it may be revealed. */
export type CurtainStage = 'cover' | 'leave' | 'play' | 'reveal'


/** Signing in: the whole login page slides left and fades out — over 440 ms
 *  in auth.css, counted from the first frame it is painted in, which comes a
 *  little after this timer starts; the rest is the margin that lets its last
 *  frames be seen before the workspace takes its place. */
export const SIGN_IN_LEAVE_MS = 480
/** Then the full collapse plays, at twice its own pace… */
export const SIGN_IN_SECONDS = 6
/** …and at five times it from the tilt on, once the workspace has loaded —
 *  never before the tilt. */
export const SIGN_IN_HURRIED_SECONDS = 2.4
/** A workspace still loading when a pass ends waits for another pass; after
 *  this many the workspace is shown anyway, still loading in its own way. */
export const SIGN_IN_MAX_PASSES = 3
/** The receiving logo draws in a little from the moment the first dot leaves
 *  until it arrives… */
export const LOGO_INHALE_MS = COLLAPSE_MARK_GATHER_FLIGHT_MS
/** …swells as the dots land, a whole body's worth of them… */
export const LOGO_SWELL_MS = 48 * COLLAPSE_MARK_GATHER_STAGGER_MS
/** …then settles back, overshooting once. */
export const LOGO_SETTLE_MS = 520
/** The workspace is not faded in. As the first dot sets off — the earliest,
 *  while a third of the body is still standing — a small round window opens
 *  in the backdrop over the workspace's logo, so it is seen to have somewhere
 *  to go… */
export const SIGN_IN_WINDOW_MS = 320
/** …and from the first arrival it widens, as a circle, until the whole
 *  workspace is uncovered. */
export const SIGN_IN_OPEN_MS = 900
/** From the first dot leaving until the circle has opened. */
export const SIGN_IN_CIRCLE_MS = LOGO_INHALE_MS + SIGN_IN_OPEN_MS
/** The curtain goes once every dot has arrived and the circle has opened —
 *  and, should the drawing ever fail to say so, after this long regardless. */
export const SIGN_IN_REVEAL_LIMIT_MS = 4000

/** Signing in's pace at a phase: hurried only from the tilt on, and only once
 *  the workspace has loaded. */
export const signInSeconds = (phase: number, loaded: boolean) =>
  phase >= COLLAPSE_MARK_COLLAPSE_START && loaded ? SIGN_IN_HURRIED_SECONDS : SIGN_IN_SECONDS
/** Whether the pass that has just ended (the `passes`-th) is signing in's last. */
export const signInEnds = (passes: number, loaded: boolean) => loaded || passes >= SIGN_IN_MAX_PASSES

/** Signing out: the workspace closes in a circle onto the sign-out button,
 *  slowly at first, quickest midway, settling as it shuts… */
export const SIGN_OUT_CLOSE_MS = 720
/** …and once it has, and the session has ended, the login page simply fades
 *  in over this long — as does the workspace again if signing out failed. */
export const LIFT_MS = 420
