import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../api/client'
import { AuthProvider, useAuth } from './auth'
import { dispatchAuthSessionInvalid } from '../api/sessionInvalid'

const mocks = vi.hoisted(() => ({ me: vi.fn() }))

vi.mock('../api/client', () => {
  class MockApiError extends Error {
    constructor(message: string, readonly status: number) {
      super(message)
      this.name = 'ApiError'
    }
  }
  return {
    ApiError: MockApiError,
    api: {
      mode: 'http',
      auth: { me: mocks.me },
    },
  }
})

const authenticated = {
  user: {
    id: 'usr_1', username: 'listener', displayName: 'Listener', role: 'user' as const, status: 'active' as const,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  session: { expiresAt: '2026-01-02T00:00:00Z' },
}

function Probe() {
  const { status, failure, user, error, refresh } = useAuth()
  return <><output aria-label="status">{status}</output><output aria-label="failure">{failure ?? ''}</output><output aria-label="user">{user?.id ?? ''}</output><output aria-label="error">{error}</output><button onClick={() => void refresh()}>Retry</button></>
}

describe('authentication bootstrap', () => {
  beforeEach(() => mocks.me.mockReset())

  it('does not misrepresent a service failure as a signed-out session', async () => {
    mocks.me.mockRejectedValueOnce(new ApiError('Service unavailable', 503)).mockResolvedValueOnce(authenticated)
    render(<AuthProvider><Probe /></AuthProvider>)

    expect(await screen.findByText('error')).toBeInTheDocument()
    expect(screen.getByLabelText('error')).toHaveTextContent('Service unavailable')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('authenticated'))
  })

  it('treats an explicit unauthorized response as signed out', async () => {
    mocks.me.mockRejectedValueOnce(new ApiError('Sign in required', 401))
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('anonymous'))
    expect(screen.getByLabelText('error')).toBeEmptyDOMElement()
  })

  it('invalidates an authenticated session when a protected feature reports expiry', async () => {
    mocks.me.mockResolvedValueOnce(authenticated)
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('authenticated'))

    act(() => dispatchAuthSessionInvalid({ reason: 'expired', message: 'Session expired' }))

    expect(screen.getByLabelText('status')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('user')).toBeEmptyDOMElement()
    expect(screen.getByLabelText('error')).toBeEmptyDOMElement()
  })

  it('shows a distinct access state when the account is disabled', async () => {
    mocks.me.mockResolvedValueOnce(authenticated)
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByLabelText('status')).toHaveTextContent('authenticated'))

    act(() => dispatchAuthSessionInvalid({ reason: 'account_disabled', message: 'This account is disabled.' }))

    expect(screen.getByLabelText('status')).toHaveTextContent('error')
    expect(screen.getByLabelText('failure')).toHaveTextContent('account_disabled')
    expect(screen.getByLabelText('user')).toBeEmptyDOMElement()
    expect(screen.getByLabelText('error')).toHaveTextContent('This account is disabled.')
  })
})
