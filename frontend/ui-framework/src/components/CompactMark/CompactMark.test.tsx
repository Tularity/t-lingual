import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CompactMark } from './CompactMark'
import { Spinner } from '../Spinner/Spinner'

const cells = (root: Element) => [...root.querySelectorAll<HTMLElement>('.tl-compact-mark__cell')]

describe('CompactMark', () => {
  it('is decorative by default and an image when named', () => {
    const { container, rerender } = render(<CompactMark />)
    const root = container.firstElementChild!
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.getAttribute('role')).toBeNull()
    rerender(<CompactMark label="Tularity" />)
    expect(root.getAttribute('role')).toBe('img')
    expect(root.getAttribute('aria-label')).toBe('Tularity')
    expect(root.hasAttribute('aria-hidden')).toBe(false)
  })

  it('lets the size choose the lattice unless a cut is given', () => {
    const { container, rerender } = render(<CompactMark size={16} />)
    const root = container.firstElementChild!
    expect(root.getAttribute('data-cut')).toBe('4')
    expect(cells(root)).toHaveLength(16)
    rerender(<CompactMark size={32} />)
    expect(cells(root)).toHaveLength(25)
    rerender(<CompactMark size={32} cut={4} />)
    expect(cells(root)).toHaveLength(16)
  })

  // Relative units would let a consumer's descendant selector or inherited
  // font size move the cells; the lab's own chrome did exactly that once.
  it('resolves every cell to pixels', () => {
    const { container } = render(<CompactMark size={20} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.width).toBe('20px')
    for (const cell of cells(root)) {
      for (const value of [cell.style.left, cell.style.top, cell.style.width, cell.style.height]) {
        expect(value).toMatch(/^-?[\d.]+px$/)
      }
    }
  })

  it('keeps the gap at least a pixel wide at the smallest size', () => {
    // The top row of the 4x4 is `aaab`: the third cell is the L, the fourth
    // the band, so the space between them is a gap between two pieces.
    const { container } = render(<CompactMark size={12} />)
    const [, , l, band] = cells(container.firstElementChild!)
    expect([l.dataset.piece, band.dataset.piece]).toEqual(['a', 'b'])
    const end = parseFloat(l.style.left) + parseFloat(l.style.width)
    expect(parseFloat(band.style.left) - end).toBeGreaterThanOrEqual(1)
  })

  it('animates only when asked and carries its tone and loop length', () => {
    const { container, rerender } = render(<CompactMark />)
    const root = container.firstElementChild as HTMLElement
    expect(root.hasAttribute('data-motion')).toBe(false)
    expect(root.getAttribute('data-tone')).toBe('brand')
    rerender(<CompactMark motion="wave" tone="inherit" cycle={1400} />)
    expect(root.getAttribute('data-motion')).toBe('wave')
    expect(root.getAttribute('data-tone')).toBe('inherit')
    expect(root.style.getPropertyValue('--_cycle')).toBe('1400ms')
    expect(cells(root).every((cell) => cell.style.getPropertyValue('--_phase') !== '')).toBe(true)
    // The turn belongs to one element that carries every cell, so the ripple
    // runs in the mark's own frame and the pieces turn as one.
    const figure = root.querySelector('.tl-compact-mark__figure')!
    expect(figure.parentElement).toBe(root)
    expect(cells(root).every((cell) => cell.parentElement === figure)).toBe(true)
    // No Web Animations here, so the CSS rounding stays in charge.
    expect(root.hasAttribute('data-rounding')).toBe(false)
  })
})

describe('Spinner', () => {
  it('is the compact mark, waving in the colour of its surroundings', () => {
    const { container } = render(<Spinner size="lg" label="Connecting" />)
    const spinner = container.firstElementChild!
    expect(spinner.getAttribute('role')).toBe('status')
    const mark = spinner.querySelector('[data-tl="compact-mark"]')!
    expect(mark.getAttribute('data-motion')).toBe('wave')
    expect(mark.getAttribute('data-tone')).toBe('inherit')
    expect(mark.getAttribute('data-cut')).toBe('5')
    // The spinner announces; the mark inside it must not announce again.
    expect(mark.getAttribute('aria-hidden')).toBe('true')
  })
})
