import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { LOADING_STATE_DELAY, LoadingState } from './LoadingState'

describe('LoadingState', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('announces the wait at once and shows its plate only after the delay', () => {
    const { container } = render(<LoadingState label="Loading sessions" still={<img alt="" src="/logo.svg" />} />)
    expect(screen.getByRole('status', { name: 'Loading sessions' })).toBeInTheDocument()
    expect(container.querySelector('.tl-loading-state__plate')).toBeNull()
    act(() => vi.advanceTimersByTime(LOADING_STATE_DELAY))
    const plate = container.querySelector('.tl-loading-state__plate')!
    expect(plate).not.toBeNull()
    // The label is written under the logo, and not read twice.
    expect(plate).toHaveTextContent('Loading sessions')
    expect(plate.querySelector('p')).toHaveAttribute('aria-hidden', 'true')
    // jsdom cannot hand a canvas to a worker, so the still is what renders.
    expect(plate.querySelector('img')).toHaveAttribute('src', '/logo.svg')
  })

  it('becomes its content when the wait is over, and stops being a status region', () => {
    const { rerender, container } = render(
      <LoadingState loading label="Loading settings">
        <p>Settings</p>
      </LoadingState>,
    )
    expect(screen.queryByText('Settings')).toBeNull()
    act(() => vi.advanceTimersByTime(LOADING_STATE_DELAY))
    rerender(
      <LoadingState loading={false} label="Loading settings">
        <p>Settings</p>
      </LoadingState>,
    )
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('.tl-loading-state__plate')).toBeNull()
  })

  it('starts a new wait hidden again', () => {
    const { rerender, container } = render(<LoadingState loading label="Loading" />)
    act(() => vi.advanceTimersByTime(LOADING_STATE_DELAY))
    rerender(<LoadingState loading={false} label="Loading" />)
    rerender(<LoadingState loading label="Loading" />)
    expect(container.querySelector('.tl-loading-state__plate')).toBeNull()
    act(() => vi.advanceTimersByTime(LOADING_STATE_DELAY))
    expect(container.querySelector('.tl-loading-state__plate')).not.toBeNull()
  })

  it('holds a panel open, or fills a page', () => {
    const { rerender } = render(<LoadingState label="Loading" />)
    expect(screen.getByRole('status')).not.toHaveAttribute('data-fill')
    rerender(<LoadingState label="Loading" fill />)
    expect(screen.getByRole('status')).toHaveAttribute('data-fill')
  })
})
