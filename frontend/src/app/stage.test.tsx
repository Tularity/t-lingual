import { act, render, renderHook } from '@testing-library/react'
import { COLLAPSE_MARK_FRAME } from '@tular/ui'
import LOGO_SVG from '../../public/brand/tularity.svg?raw'
import FAVICON_SVG from '../../public/favicon.svg?raw'
import { Curtain } from './Curtain'
import { pageDirection, pageKey } from './pageTransition'
import { useStage } from './stage'
import { SIGN_OUT_CLOSE_MS, LIFT_MS, SIGN_IN_HURRIED_SECONDS, SIGN_IN_REVEAL_LIMIT_MS, SIGN_IN_LEAVE_MS, SIGN_IN_MAX_PASSES, SIGN_IN_SECONDS, signInEnds, signInSeconds } from './stageTiming'

type Status = 'loading' | 'anonymous' | 'authenticated' | 'error'

function stage(initial: Status) {
  return renderHook(({ status }: { status: Status }) => useStage(status), { initialProps: { status: initial } })
}

function reduceMotion() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }),
  })
}

describe('useStage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('covers nothing while a page loads, and shows what it resolved to at once', () => {
    const { result, rerender } = stage('loading')
    expect(result.current.curtain).toBeNull()
    rerender({ status: 'authenticated' })
    expect(result.current.shown).toBe('authenticated')
    expect(result.current.curtain).toBeNull()
    rerender({ status: 'loading' })
    expect(result.current.shown).toBe('loading')
    expect(result.current.curtain).toBeNull()
  })

  it('lets the login page leave, plays over the workspace, and reveals it only when told', () => {
    const { result, rerender } = stage('anonymous')
    rerender({ status: 'authenticated' })
    expect(result.current.shown).toBe('anonymous')
    expect(result.current.curtain).toMatchObject({ kind: 'enter', stage: 'leave' })
    act(() => vi.advanceTimersByTime(SIGN_IN_LEAVE_MS - 1))
    expect(result.current.shown).toBe('anonymous')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.shown).toBe('authenticated')
    expect(result.current.curtain).toMatchObject({ kind: 'enter', stage: 'play' })
    // However long it plays, the workspace waits for the animation.
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.curtain).toMatchObject({ stage: 'play' })
    act(() => result.current.finishSignIn())
    expect(result.current.curtain).toMatchObject({ kind: 'enter', stage: 'reveal' })
    // The curtain stays while its dots are drawn into the workspace's logo…
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.curtain).toMatchObject({ stage: 'reveal' })
    // …and goes once they are all in and the workspace is uncovered.
    act(() => result.current.endSignIn())
    expect(result.current.curtain).toBeNull()
  })

  it('takes a sign-in curtain down after a limit if the drawing never says it is done', () => {
    const { result, rerender } = stage('anonymous')
    rerender({ status: 'authenticated' })
    act(() => vi.advanceTimersByTime(SIGN_IN_LEAVE_MS))
    act(() => result.current.finishSignIn())
    act(() => vi.advanceTimersByTime(SIGN_IN_REVEAL_LIMIT_MS - 1))
    expect(result.current.curtain).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.curtain).toBeNull()
  })

  it('plays a sign-in for someone already signed in who chooses to go on', () => {
    const { result } = stage('authenticated')
    let played = false
    act(() => { played = result.current.enterWorkspace() })
    expect(played).toBe(true)
    expect(result.current.curtain).toMatchObject({ kind: 'enter', stage: 'leave' })
    act(() => vi.advanceTimersByTime(SIGN_IN_LEAVE_MS))
    expect(result.current.shown).toBe('authenticated')
    expect(result.current.curtain).toMatchObject({ kind: 'enter', stage: 'play' })
  })

  it('swaps to the login page only once the session has ended and the logo has assembled', () => {
    const { result, rerender } = stage('authenticated')
    act(() => result.current.beginSignOut())
    expect(result.current.curtain).toMatchObject({ kind: 'exit', stage: 'cover' })
    act(() => vi.advanceTimersByTime(100))
    rerender({ status: 'anonymous' })
    expect(result.current.shown).toBe('authenticated')
    act(() => vi.advanceTimersByTime(SIGN_OUT_CLOSE_MS - 100))
    expect(result.current.shown).toBe('anonymous')
    expect(result.current.curtain).toMatchObject({ kind: 'exit', stage: 'reveal' })
    act(() => vi.advanceTimersByTime(LIFT_MS))
    expect(result.current.curtain).toBeNull()
  })

  it('lifts the sign-out curtain back off the workspace when signing out fails', () => {
    const { result } = stage('authenticated')
    // The sign-out handler holds the callbacks from the moment it was clicked.
    const { beginSignOut, cancelSignOut } = result.current
    act(() => beginSignOut())
    act(() => cancelSignOut())
    expect(result.current.curtain).toMatchObject({ kind: 'exit', stage: 'reveal' })
    act(() => vi.advanceTimersByTime(LIFT_MS))
    expect(result.current.curtain).toBeNull()
    expect(result.current.shown).toBe('authenticated')
  })

  it('swaps at once when a session simply expires', () => {
    const { result, rerender } = stage('authenticated')
    rerender({ status: 'anonymous' })
    expect(result.current.shown).toBe('anonymous')
    expect(result.current.curtain).toBeNull()
  })

  it('gives reduced motion the plain swap', () => {
    reduceMotion()
    const { result, rerender } = stage('anonymous')
    rerender({ status: 'authenticated' })
    expect(result.current.shown).toBe('authenticated')
    expect(result.current.curtain).toBeNull()
    act(() => result.current.beginSignOut())
    expect(result.current.curtain).toBeNull()
    expect(result.current.enterWorkspace()).toBe(false)
  })
})

describe('signing in’s pace', () => {
  it('runs at twice the pace, and five times it only from the tilt with the workspace loaded', () => {
    expect(signInSeconds(0.1, true)).toBe(SIGN_IN_SECONDS)
    expect(signInSeconds(0.21, true)).toBe(SIGN_IN_SECONDS)
    expect(signInSeconds(0.22, false)).toBe(SIGN_IN_SECONDS)
    expect(signInSeconds(0.22, true)).toBe(SIGN_IN_HURRIED_SECONDS)
    expect(signInSeconds(0.9, true)).toBe(SIGN_IN_HURRIED_SECONDS)
    expect(12 / SIGN_IN_SECONDS).toBe(2)
    expect(12 / SIGN_IN_HURRIED_SECONDS).toBe(5)
  })

  it('ends a pass only with the workspace loaded, going round again otherwise', () => {
    expect(signInEnds(1, true)).toBe(true)
    expect(signInEnds(1, false)).toBe(false)
    expect(signInEnds(SIGN_IN_MAX_PASSES, false)).toBe(true)
  })
})

describe('Curtain', () => {
  afterEach(() => vi.useRealTimers())

  it('is decorative, and falls back to the logo file where the collapse cannot play', () => {
    const { container } = render(<Curtain kind="enter" stage="cover" />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    // jsdom cannot hand a canvas to a worker, so the still is what renders.
    expect(container.querySelector('img')).toHaveAttribute('src', '/brand/tularity.svg')
  })
})

describe('page entrances', () => {
  it('treat one page under two spellings as one', () => {
    expect(pageKey('/workspaces/')).toBe('/workspaces')
    expect(pageKey('/workspaces')).toBe('/workspaces')
  })

  it('follow the sidebar order, and read going into a session as forward', () => {
    const order = ['wsp_a', 'wsp_b']
    expect(pageDirection('/workspaces/wsp_a', '/settings', order)).toBe(1)
    expect(pageDirection('/settings', '/workspaces/wsp_b', order)).toBe(-1)
    expect(pageDirection('/workspaces/wsp_a', '/workspaces/wsp_b', order)).toBe(1)
    expect(pageDirection('/workspaces/wsp_b', '/workspaces/wsp_a', order)).toBe(-1)
    expect(pageDirection('/workspaces/wsp_b', '/workspaces', order)).toBe(1)
    expect(pageDirection('/workspaces/wsp_b', '/sessions/ses_1', order)).toBe(1)
    expect(pageDirection('/live/ses_1', '/workspaces/wsp_a', order)).toBe(-1)
    expect(pageDirection('/setup', '/workspaces/wsp_a', order)).toBe(1)
  })
})

describe('the logo file', () => {
  it('is framed exactly as the collapse is, centred on the body square', () => {
    const viewBox = /viewBox="([^"]+)"/.exec(LOGO_SVG)?.[1]?.split(/\s+/).map(Number)
    expect(viewBox).toEqual([...COLLAPSE_MARK_FRAME])
  })

  it('is also the favicon', () => {
    expect(FAVICON_SVG).toBe(LOGO_SVG)
  })
})
