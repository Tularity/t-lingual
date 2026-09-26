import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { CollapseMark } from './CollapseMark'

describe('CollapseMark', () => {
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
