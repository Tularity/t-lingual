import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../design-system'
import { RouterProvider } from './router'
import { AppShell } from './AppShell'

const auth = vi.hoisted(() => ({
  logout: vi.fn(async () => undefined),
  user: {
    id: 'usr_1',
    username: 'listener',
    displayName: 'Listener',
    role: 'user' as const,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
}))

vi.mock('./auth', () => ({
  useAuth: () => ({ user: auth.user, logout: auth.logout }),
}))

function renderShell() {
  return render(
    <RouterProvider>
      <ToastProvider>
        <AppShell><h1>Current page</h1></AppShell>
      </ToastProvider>
    </RouterProvider>,
  )
}

function showMobileTrigger() {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')
  if (!trigger) throw new Error('Mobile navigation trigger was not rendered')
  const header = trigger.closest<HTMLElement>('.mobile-header')
  if (header) header.style.display = 'grid'
  return trigger
}

describe('application shell navigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/history')
    document.body.className = ''
  })

  it('treats the mobile drawer as a focus-trapped modal and restores focus on Escape', async () => {
    const user = userEvent.setup()
    renderShell()
    const trigger = showMobileTrigger()
    await user.click(trigger)

    const drawer = screen.getByRole('dialog', { name: 'Mobile navigation' })
    const close = within(drawer).getByRole('button', { name: 'Close navigation' })
    await waitFor(() => expect(close).toHaveFocus())
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(document.body).toHaveClass('mobile-drawer-open')

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(within(drawer).getByRole('button', { name: 'Sign out' })).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.body).not.toHaveClass('mobile-drawer-open')

    await user.click(trigger)
    await user.click(within(screen.getByRole('dialog', { name: 'Mobile navigation' })).getByRole('link', { name: 'History' }))
    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument()
  })

  it('moves focus to main content after drawer navigation', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(showMobileTrigger())
    const drawer = screen.getByRole('dialog', { name: 'Mobile navigation' })
    await user.click(within(drawer).getByRole('link', { name: 'Sessions' }))

    const main = screen.getByRole('main')
    await waitFor(() => expect(main).toHaveFocus())
    expect(window.location.pathname).toBe('/sessions')
  })
})
