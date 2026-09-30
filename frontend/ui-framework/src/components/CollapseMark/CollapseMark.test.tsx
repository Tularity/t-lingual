import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { CollapseMark } from './CollapseMark'

/** A browser that hands canvases to workers: a worker that only listens, frames stepped by hand. */
function offThreadBrowser({ devicePixelBox }: { devicePixelBox: boolean }) {
  const workers: Array<{ posted: unknown[]; onmessage: ((event: MessageEvent) => void) | null; onerror: ((event: { preventDefault(): void }) => void) | null }> = []
  const observed: Array<{ target: Element; box?: string }> = []
  const frames: FrameRequestCallback[] = []
  // jsdom has no canvas transfer at all, so there is nothing to spy on: it is given one.
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: () => ({}) })
  vi.stubGlobal('Worker', class {
    posted: unknown[] = []
    onmessage = null
    onerror = null
    constructor() { workers.push(this) }
    postMessage(message: unknown) { this.posted.push(message) }
    terminate() {}
  })
  vi.stubGlobal('ResizeObserver', class {
    observe(target: Element, options?: { box?: string }) {
      // As Safari does: an unknown box is a TypeError, not a no-op.
      if (options?.box === 'device-pixel-content-box' && !devicePixelBox) throw new TypeError('Type error')
      observed.push({ target, box: options?.box })
    }
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const step = (now: number) => { const due = frames.splice(0); for (const frame of due) frame(now) }
  return { workers, observed, step }
}

describe('CollapseMark', () => {
  afterEach(() => {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('animates in a browser without the device-pixel box, measuring the content box instead', () => {
    const browser = offThreadBrowser({ devicePixelBox: false })
    const { container } = render(<CollapseMark />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(browser.observed).toContainEqual({ target: canvas, box: undefined })
    expect(browser.workers[0]?.posted[0]).toMatchObject({ type: 'init' })
  })

  it('ends a gathering its worker can no longer draw, so nobody waits on it for ever', () => {
    const browser = offThreadBrowser({ devicePixelBox: true })
    const logo = document.createElement('img')
    const onGather = vi.fn()
    const onGathered = vi.fn()
    render(<CollapseMark linger once to={0.5} duration={1} gatherTo={() => logo} onGather={onGather} onGathered={onGathered} />)
    act(() => { for (let now = 0; now <= 1_000; now += 100) browser.step(now) })
    // The dots are on their way, and the worker never says they have left.
    expect(onGathered).not.toHaveBeenCalled()
    const preventDefault = vi.fn()
    act(() => browser.workers[0]!.onerror!({ preventDefault }))
    expect(preventDefault).toHaveBeenCalled()
    expect(onGather).toHaveBeenCalledWith(logo)
    expect(onGathered).toHaveBeenCalledOnce()
  })

  it('ends a gathering its worker never answers, and waits on one that has begun', () => {
    const browser = offThreadBrowser({ devicePixelBox: true })
    const logo = document.createElement('img')
    const onGathered = vi.fn()
    const answered = document.createElement('img')
    const onAnsweredGathered = vi.fn()
    render(<><CollapseMark linger once to={0.5} duration={1} gatherTo={() => logo} onGathered={onGathered} /><CollapseMark linger once to={0.5} duration={1} gatherTo={() => answered} onGathered={onAnsweredGathered} /></>)
    act(() => { for (let now = 0; now <= 1_000; now += 100) browser.step(now) })
    // The second worker's first dot leaves; the first worker says nothing at all.
    const second = browser.workers[1]!
    const draw = second.posted.findLast((message) => (message as { frame?: { gather?: { id: number } } }).frame?.gather) as { frame: { gather: { id: number } } }
    act(() => second.onmessage!(new MessageEvent('message', { data: { id: draw.frame.gather.id, event: 'departed' } })))
    act(() => { for (let now = 1_100; now <= 4_000; now += 100) browser.step(now) })
    expect(onGathered).not.toHaveBeenCalled()
    act(() => { for (let now = 4_100; now <= 6_000; now += 100) browser.step(now) })
    expect(onGathered).toHaveBeenCalledOnce()
    expect(onAnsweredGathered).not.toHaveBeenCalled()
  })

  it('is a 4:3 box sized by width, decorative unless labelled', () => {
    const { container } = render(<CollapseMark size={240} />)
    const mark = container.querySelector<HTMLElement>('[data-tl="collapse-mark"]')!
    expect(mark.style.width).toBe('240px')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark).not.toHaveAttribute('role')
  })

  it('takes an accessible name as an image', () => {
    const { getByRole } = render(<CollapseMark label="Loading" />)
    expect(getByRole('img', { name: 'Loading' })).toBeInTheDocument()
  })

  it('shows the still it is given where it cannot animate off the main thread', () => {
    // jsdom has neither a worker nor canvas transfer.
    const { container, getByAltText } = render(<CollapseMark still={<img src="/logo.svg" alt="Logo" />} />)
    expect(getByAltText('Logo')).toBeInTheDocument()
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('[data-tl="collapse-mark"]')).not.toHaveAttribute('data-motion')
  })

  it('still ends its pass, and has nothing to gather, where it cannot animate', () => {
    vi.useFakeTimers()
    try {
      const logo = document.createElement('img')
      const onEnd = vi.fn()
      const onGather = vi.fn()
      const onGathered = vi.fn()
      render(<CollapseMark linger once to={0.5} duration={2} onEnd={onEnd} gatherTo={() => logo} onGather={onGather} onGathered={onGathered} />)
      act(() => vi.advanceTimersByTime(999))
      expect(onEnd).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(onEnd).toHaveBeenCalledOnce()
      // With no dots to send, the gathering begins and ends at once.
      expect(onGather).toHaveBeenCalledWith(logo)
      expect(onGathered).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
