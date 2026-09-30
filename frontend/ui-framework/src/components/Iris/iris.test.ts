import { afterEach, describe, expect, it, vi } from 'vitest'
import { IRIS_EDGE, iris, irisTransition } from './iris'

function cover(box = { left: 0, top: 0, width: 400, height: 300 }) {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) })
  return element
}

describe('iris', () => {
  afterEach(() => vi.restoreAllMocks())

  it('cuts its opening around the point, in the element’s own coordinates', () => {
    const element = cover({ left: 100, top: 50, width: 400, height: 300 })
    iris(element, { x: 130, y: 90, stops: [{ radius: 0, at: 0 }, { radius: 40, at: 200 }] })
    expect(element).toHaveClass('tl-iris')
    expect(element.style.getPropertyValue('--tl-iris-x')).toBe('30px')
    expect(element.style.getPropertyValue('--tl-iris-y')).toBe('40px')
  })

  it('moves the radius through its stops, each at its own time and on its own curve', () => {
    const element = cover()
    const animate = vi.fn(() => ({}) as Animation)
    element.animate = animate
    iris(element, {
      x: 0, y: 0,
      stops: [{ radius: 0, at: 0, easing: 'ease-out' }, { radius: 50, at: 300 }, { radius: 'cover', at: 1200 }],
    })
    const [keyframes, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions]
    expect(options).toMatchObject({ duration: 1200, fill: 'both' })
    expect(keyframes.map((k) => k.offset)).toEqual([0, 0.25, 1])
    expect(keyframes[0]).toMatchObject({ '--tl-iris-radius': '0px', easing: 'ease-out' })
    // 'cover' clears the farthest corner, soft edge and all.
    expect(keyframes[2]['--tl-iris-radius']).toBe(`${500 + IRIS_EDGE}px`)
  })

  it('simply sits at its last stop where it cannot be animated', () => {
    const element = cover()
    Object.defineProperty(element, 'animate', { value: undefined })
    expect(iris(element, { x: 0, y: 0, stops: [{ radius: 'cover', at: 0 }, { radius: 0, at: 700 }] })).toBeNull()
    expect(element.style.getPropertyValue('--tl-iris-radius')).toBe('0px')
  })
})

describe('irisTransition', () => {
  it('just applies the update where the browser has no view transitions', async () => {
    const update = vi.fn()
    await irisTransition(update, { x: 10, y: 10 })
    expect(update).toHaveBeenCalledOnce()
    expect(document.documentElement).not.toHaveAttribute('data-tl-iris')
  })

  it('opens the new state from the point, over the old, and tidies up after', async () => {
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const doc = document as Document & { startViewTransition?: unknown }
    doc.startViewTransition = vi.fn((update: () => void) => {
      update()
      return { ready: Promise.resolve(), finished }
    })
    const animate = vi.fn()
    document.documentElement.animate = animate
    const update = vi.fn()
    const done = irisTransition(update, { x: 12, y: 34, duration: 500 })
    expect(update).toHaveBeenCalledOnce()
    expect(document.documentElement).toHaveAttribute('data-tl-iris')
    expect(document.documentElement.style.getPropertyValue('--tl-iris-x')).toBe('12px')
    await Promise.resolve()
    expect(animate).toHaveBeenCalledWith(
      expect.objectContaining({ '--tl-iris-radius': ['0px', expect.stringMatching(/px$/)] }),
      expect.objectContaining({ duration: 500, fill: 'forwards', pseudoElement: '::view-transition-new(root)' }),
    )
    finish()
    await done
    expect(document.documentElement).not.toHaveAttribute('data-tl-iris')
    delete doc.startViewTransition
  })
})
