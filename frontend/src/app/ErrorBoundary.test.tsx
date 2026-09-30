import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from './ErrorBoundary'

function Broken(): never { throw new TypeError('Type error') }

describe('a page that fails to render', () => {
  it('offers a reload and says what failed, for whoever reports it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<ErrorBoundary><Broken /></ErrorBoundary>)
    expect(screen.getByRole('heading', { name: 'This page needs a fresh start' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload workspace' })).toBeInTheDocument()
    await user.click(screen.getByText('Technical details'))
    expect(screen.getByText('TypeError: Type error')).toBeVisible()
    vi.restoreAllMocks()
  })
})
