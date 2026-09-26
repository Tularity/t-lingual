import { describe, expect, it } from 'vitest'
import css from './CompactMark.css?raw'
import { DIP_ANIMATION, ROUND_KEYFRAMES, ROUND_SPAN, loopStart } from './compactMarkRounding'

/** Offset, border-radius and easing of every keyframe in one @keyframes block. */
function keyframes(name: string) {
  const start = css.indexOf(`@keyframes ${name} {`)
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  let end = start
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) { end = i; break }
  }
  const body = css.slice(css.indexOf('{', start) + 1, end)
  return [...body.matchAll(/([\d.%,\s]+)\{([^}]*)\}/g)].flatMap(([, selector, declarations]) =>
    selector.split(',').map((offset) => ({
      offset: parseFloat(offset) / 100,
      radius: /border-radius:\s*([^;]+);/.exec(declarations)?.[1].trim(),
      easing: /animation-timing-function:\s*([^;]+);/.exec(declarations)?.[1].trim(),
    })),
  )
}

describe('rounding windows', () => {
  // The windows replay the CSS rounding; if either side is retuned alone the
  // pixels stop matching, so the stylesheet is read and compared here.
  it('replay tl-compact-mark-round exactly, rescaled to their window', () => {
    const frames = keyframes('tl-compact-mark-round')
    const moving = frames.filter((f) => f.offset <= ROUND_SPAN)
    const held = frames.filter((f) => f.offset > ROUND_SPAN)
    expect(moving.map((f) => +(f.offset / ROUND_SPAN).toFixed(6))).toEqual(ROUND_KEYFRAMES.map((k) => k.offset))
    expect(moving.map((f) => (f.radius === '0' ? '0' : f.radius))).toEqual(ROUND_KEYFRAMES.map((k) => k.borderRadius))
    expect(moving.map((f) => f.easing?.replace(/\s+/g, ' '))).toEqual(
      ROUND_KEYFRAMES.map((k) => k.easing?.replace(/\s+/g, ' ')),
    )
    // After the window the CSS holds zero, which is what a window in its end
    // delay leaves behind.
    expect(held.every((f) => f.radius === '0')).toBe(true)
  })

  it('align to the dip the stylesheet actually declares', () => {
    expect(css).toContain(`@keyframes ${DIP_ANIMATION} {`)
    expect(css).toMatch(/\.tl-compact-mark\[data-rounding='scripted'\] \.tl-compact-mark__fill \{\s*--_run: none;/)
  })

  it('find the start of the loop an instant falls in', () => {
    expect(loopStart(1000, 1000, 2400)).toBe(1000)
    expect(loopStart(3399, 1000, 2400)).toBe(1000)
    expect(loopStart(3400, 1000, 2400)).toBe(3400)
    // Negative delays put the first loop before the animation's start time.
    expect(loopStart(500, -1500, 2400)).toBe(-1500)
    expect(loopStart(-1600, -1500, 2400)).toBe(-3900)
  })
})
