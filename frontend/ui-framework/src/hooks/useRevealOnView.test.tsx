import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { REVEAL_STEP, useRevealOnView } from './useRevealOnView'

let observer: { callback: IntersectionObserverCallback; targets: Element[] } | null = null
class ManualObserver {
  constructor(callback: IntersectionObserverCallback) { observer = { callback, targets: [] } }
  observe(target: Element) { observer!.targets.push(target) }
  unobserve() {}
  disconnect() {}
}
function intersect(...items: Element[]) {
  act(() => observer!.callback(items.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), {} as IntersectionObserver))
}

function List({ count, after }: { count: number; after?: string }) {
  const root = useRef<HTMLDivElement>(null)
  useRevealOnView(root)
  return (
    <div ref={root} style={after ? ({ '--tl-reveal-after': after } as React.CSSProperties) : undefined}>
      {Array.from({ length: count }, (_, i) => <p key={i} data-tl-reveal="">Item {i}</p>)}
    </div>
  )
}

describe('useRevealOnView', () => {
  beforeEach(() => {
    observer = null
    vi.stubGlobal('IntersectionObserver', ManualObserver)
    vi.spyOn(performance, 'now').mockReturnValue(1000)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('hides the items before they are drawn, then brings them in one after another, in order', () => {
    const { getAllByText } = render(<List count={3} />)
    const items = getAllByText(/Item/)
    items.forEach((item) => expect(item).toHaveAttribute('data-tl-reveal', 'pending'))
    // Reported out of order, entered in document order.
    intersect(items[2], items[0], items[1])
    expect(items.map((item) => item.dataset.tlReveal)).toEqual(['shown', 'shown', 'shown'])
    expect(items.map((item) => item.style.getPropertyValue('--tl-reveal-wait'))).toEqual(['0ms', `${REVEAL_STEP}ms`, `${REVEAL_STEP * 2}ms`])
  })

  it('queues a later arrival behind the ones before it', () => {
    const { getAllByText } = render(<List count={3} />)
    const items = getAllByText(/Item/)
    intersect(items[0])
    intersect(items[1])
    expect(items[1].style.getPropertyValue('--tl-reveal-wait')).toBe(`${REVEAL_STEP}ms`)
  })

  it('holds every entrance until the moment its container asks for', () => {
    const { getAllByText } = render(<List count={2} after="200ms" />)
    const items = getAllByText(/Item/)
    intersect(...items)
    expect(items.map((item) => item.style.getPropertyValue('--tl-reveal-wait'))).toEqual(['200ms', `${200 + REVEAL_STEP}ms`])
  })

  it('picks up items added later', async () => {
    const { rerender, getAllByText } = render(<List count={1} />)
    rerender(<List count={2} />)
    await act(async () => {})
    expect(getAllByText(/Item/)[1]).toHaveAttribute('data-tl-reveal', 'pending')
  })

  it('still brings in items that were waiting when the effect ran again', () => {
    const { getAllByText } = render(<StrictMode><List count={2} /></StrictMode>)
    const items = getAllByText(/Item/)
    expect(observer!.targets).toEqual(expect.arrayContaining(items))
    intersect(...items)
    expect(items.map((item) => item.dataset.tlReveal)).toEqual(['shown', 'shown'])
  })

  it('hides nothing where items cannot be watched', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { getByText } = render(<List count={1} />)
    expect(getByText('Item 0')).toHaveAttribute('data-tl-reveal', '')
  })
})
