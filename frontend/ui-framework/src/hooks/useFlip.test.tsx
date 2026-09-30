import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useFlip } from './useFlip'

/** Where each item is laid out, by key: a row of 100px items, in order; the box shows 300px. */
let order: string[] = []
const place = (key: string) => {
  const at = order.indexOf(key) * 100
  return { left: at, top: 0, right: at + 100, bottom: 50, width: 100, height: 50, x: at, y: 0, toJSON: () => ({}) } as DOMRect
}

const api: { current: { capture: () => void; set: (keys: string[]) => void } | null } = { current: null }
function List({ initial }: { initial: string[] }) {
  const root = useRef<HTMLDivElement>(null)
  const [keys, setKeys] = useState(initial)
  const flip = useFlip(root)
  useLayoutEffect(() => { api.current = { capture: flip.capture, set: setKeys } }, [flip.capture])
  return <div ref={root} data-root="">{keys.map((key) => <p key={key} data-tl-flip={key} data-tl-reveal="shown">{key}</p>)}</div>
}

describe('useFlip', () => {
  const animate = vi.fn(() => ({ finished: new Promise(() => {}) }) as unknown as Animation)
  beforeEach(() => {
    animate.mockClear()
    Element.prototype.animate = animate
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.root !== undefined) return { left: 0, top: 0, right: 300, bottom: 50, width: 300, height: 50, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      // A stand-in copy has lost its key; it is placed by its text instead.
      return place(this.dataset.tlFlip ?? this.textContent ?? '')
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(Element.prototype, 'animate')
  })

  function change(next: string[]) {
    act(() => {
      api.current!.capture()
      order = next
      api.current!.set(next)
    })
  }

  it('moves an item that was in view from where it was to where it is', () => {
    order = ['a', 'b', 'c']
    const { getByText } = render(<List initial={order} />)
    change(['b', 'a', 'c'])
    const moves = animate.mock.calls.filter((call) => (call as unknown[])[0] && JSON.stringify((call as unknown[])[0]).includes('translate'))
    const moved = animate.mock.contexts.filter((_, i) => moves.includes(animate.mock.calls[i]))
    expect(moved).toContain(getByText('a'))
    expect(moved).toContain(getByText('b'))
    // 'a' was at 0 and is now at 100: it starts 100px to the left.
    const forA = animate.mock.calls[animate.mock.contexts.indexOf(getByText('a'))] as unknown as [Keyframe[]]
    expect(forA[0][0].transform).toBe('translate(-100px, 0px)')
    // 'c' has not moved.
    expect(animate.mock.contexts).not.toContain(getByText('c'))
  })

  it('lets an item brought into view make a fresh entrance', () => {
    order = ['a', 'b', 'c', 'd']
    const { getByText } = render(<List initial={order} />)
    // 'd' was at 300, out of view; now it is first.
    change(['d', 'a', 'b', 'c'])
    expect(getByText('d')).toHaveAttribute('data-tl-reveal', '')
    expect(getByText('d').style.getPropertyValue('--tl-reveal-after')).toMatch(/ms$/)
  })

  it('fades out a copy of an item that was in view and has gone, then removes it', () => {
    order = ['a', 'b', 'c']
    const { container } = render(<List initial={order} />)
    change(['a', 'c'])
    const copy = [...container.querySelectorAll('p')].find((p) => p.textContent === 'b')!
    expect(copy).toBeDefined()
    expect(copy).toHaveAttribute('aria-hidden', 'true')
    expect(copy).not.toHaveAttribute('data-tl-flip')
    expect(animate.mock.contexts).toContain(copy)
  })

  it('does nothing without a captured change', () => {
    order = ['a', 'b']
    render(<List initial={order} />)
    act(() => { order = ['b', 'a']; api.current!.set(['b', 'a']) })
    expect(animate).not.toHaveBeenCalled()
  })
})
