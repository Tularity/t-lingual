import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { holdReveals, releaseReveals, useReducedMotion } from '@t-lingual/ui'
import type { useAuth } from './auth'
import { LIFT_MS, SIGN_IN_LEAVE_MS, SIGN_IN_REVEAL_LIMIT_MS, SIGN_OUT_CLOSE_MS, type CurtainKind, type CurtainStage } from './stageTiming'

type Status = ReturnType<typeof useAuth>['status']

/** A point on the screen, in viewport px. */
export interface Point { x: number; y: number }

/** `origin`: where a sign-out closes onto — its button. */
export interface CurtainState { kind: CurtainKind; stage: CurtainStage; id: number; origin?: Point }

export interface Stage {
  /** The auth status the screen shows, which trails the real one while a curtain covers the change. */
  shown: Status
  curtain: CurtainState | null
  /**
   * Plays the sign-in's curtain for someone already signed in who chooses to
   * go on from the login page, exactly as though they had just signed in.
   * Returns false where it plays nothing (reduced motion).
   */
  enterWorkspace: () => boolean
  /** The sign-in's dots have begun to leave for the workspace's logo: it is uncovered. */
  finishSignIn: () => void
  /** …and they have all arrived, and it is uncovered in full: the curtain can go. */
  endSignIn: () => void
  /** Closes the workspace in a circle onto `origin` while the session ends. */
  beginSignOut: (origin?: Point) => void
  /** Lifts that curtain again when signing out failed. */
  cancelSignOut: () => void
}

/**
 * What the screen shows while the session changes hands.
 *
 * The real auth status changes in one render; the screen does not. Signing in
 * keeps the login page up until the curtain covers it, then swaps to the
 * workspace underneath and lifts. Signing out covers the workspace first and
 * swaps once the session has ended and the circle has closed — whichever is
 * later. A load lifts its curtain onto whatever it resolved to. A session that
 * simply expired, and anyone who asked for reduced motion, get the plain swap:
 * each page's own entrance still eases it in.
 */
export function useStage(status: Status): Stage {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(status)
  const [curtain, setCurtain] = useState<CurtainState | null>(null)
  /** The sign-out in progress: its curtain, and when the logo began assembling. */
  const [exit, setExit] = useState<{ id: number; startedAt: number } | null>(null)
  const [serial, setSerial] = useState(1)
  const [seen, setSeen] = useState(status)

  // The real status changed: decide, while rendering, what the screen does
  // about it. Anything that has to wait is left to the timers below.
  if (seen !== status) {
    setSeen(status)
    if (status === 'loading' || seen === 'loading') {
      // Loading, and what it resolves to, just show: a page finding out who is
      // signed in has nothing to cover.
      setShown(status)
    } else if (seen === 'anonymous' && status === 'authenticated' && !reduced) {
      setCurtain({ kind: 'enter', stage: 'leave', id: serial })
      setSerial(serial + 1)
    } else if (!(seen === 'authenticated' && status === 'anonymous' && exit)) {
      setShown(status)
    }
  }

  // Signing in: once the login page has slid away, the workspace mounts and
  // loads out of sight while the animation plays; its lists hold their
  // entrances until it is revealed.
  useEffect(() => {
    if (curtain?.kind !== 'enter' || curtain.stage !== 'leave') return
    const { id } = curtain
    const timer = window.setTimeout(() => {
      setShown('authenticated')
      setCurtain((current) => (current?.id === id ? { ...current, stage: 'play' } : current))
    }, SIGN_IN_LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [curtain])
  const playing = curtain?.kind === 'enter' && curtain.stage === 'play'
  useEffect(() => {
    if (!playing) return
    holdReveals()
    return releaseReveals
  }, [playing])

  // Signing out: the login page takes over once the session has ended and the
  // circle has closed, whichever comes later.
  useEffect(() => {
    if (!exit || status !== 'anonymous') return
    const { id, startedAt } = exit
    const timer = window.setTimeout(() => {
      setExit(null)
      setShown('anonymous')
      setCurtain((current) => (current?.id === id ? { ...current, stage: 'reveal' } : current))
    }, Math.max(0, SIGN_OUT_CLOSE_MS - (performance.now() - startedAt)))
    return () => window.clearTimeout(timer)
  }, [exit, status])

  // A lifting curtain goes once it has faded. A sign-in's goes when told its
  // dots have all been drawn into the workspace's logo and its circle has
  // opened (endSignIn) — or, failing that, after a limit.
  useEffect(() => {
    if (curtain?.stage !== 'reveal') return
    const { id } = curtain
    const timer = window.setTimeout(
      () => setCurtain((current) => (current?.id === id ? null : current)),
      curtain.kind === 'enter' ? SIGN_IN_REVEAL_LIMIT_MS : LIFT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [curtain])

  const finishSignIn = useCallback(() => {
    setCurtain((current) => (current?.kind === 'enter' && current.stage === 'play' ? { ...current, stage: 'reveal' } : current))
  }, [])
  const enterWorkspace = useCallback(() => {
    if (reduced) return false
    setCurtain({ kind: 'enter', stage: 'leave', id: serial })
    setSerial(serial + 1)
    return true
  }, [reduced, serial])
  const endSignIn = useCallback(() => {
    setCurtain((current) => (current?.kind === 'enter' && current.stage === 'reveal' ? null : current))
  }, [])

  const beginSignOut = useCallback((origin?: Point) => {
    if (reduced) return
    setExit({ id: serial, startedAt: performance.now() })
    setCurtain({ kind: 'exit', stage: 'cover', id: serial, origin })
    setSerial(serial + 1)
  }, [reduced, serial])

  // Reads nothing from the render it was made in: the caller holds the
  // version from the moment signing out began, before that sign-out existed.
  const cancelSignOut = useCallback(() => {
    setExit(null)
    setCurtain((current) => (current?.kind === 'exit' && current.stage === 'cover' ? { ...current, stage: 'reveal' } : current))
  }, [])

  return {
    shown,
    curtain,
    enterWorkspace,
    finishSignIn,
    endSignIn,
    beginSignOut,
    cancelSignOut,
  }
}

/** What the pages themselves may ask of the stage. */
export type StageControls = Pick<Stage, 'enterWorkspace' | 'beginSignOut' | 'cancelSignOut'>

const StageContext = createContext<StageControls>({
  enterWorkspace: () => false,
  beginSignOut: () => {},
  cancelSignOut: () => {},
})

export const StageProvider = StageContext.Provider
export const useStageControls = () => useContext(StageContext)
