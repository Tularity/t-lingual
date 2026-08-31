import { render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { ToastProvider } from '../design-system'
import { AuthProvider } from './auth'
import { RouterProvider } from './router'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const authenticated = {
  user: {
    id: 'usr_1', username: 'listener', displayName: 'Listener', role: 'user' as const, status: 'active' as const,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  session: { expiresAt: '2026-01-02T00:00:00Z' },
}

describe('expired feature session handling', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns to passkey sign-in after a workspace request receives 401', async () => {
    window.history.replaceState(null, '', '/sessions')
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/me')) return Promise.resolve(jsonResponse(authenticated))
      if (url.endsWith('/sessions?limit=200')) return Promise.resolve(jsonResponse({ error: { code: 'SESSION_EXPIRED', message: 'Sign in again.' } }, 401))
      if (url.endsWith('/settings')) return Promise.resolve(jsonResponse({
        defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false,
        showPartialTranscripts: true, compactTranscriptLayout: false,
      }))
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<RouterProvider><ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider></RouterProvider>)

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/me'))).toHaveLength(1)
  })
})
