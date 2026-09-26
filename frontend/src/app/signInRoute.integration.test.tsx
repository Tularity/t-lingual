import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { ThemeProvider, ToastProvider } from '../design-system'
import { AuthProvider } from './auth'
import { RouterProvider } from './router'
import { SIGN_IN_LEAVE_MS } from './stageTiming'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})
const future = '2099-01-01T00:00:00Z'
const user = { id: 'usr_code', username: 'recovering', displayName: 'Recovering', role: 'user' as const, status: 'active' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }

describe('signing in behind the curtain', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps a sign-in code on its way to security settings while the login page leaves', async () => {
    window.history.replaceState(null, '', '/login')
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/me')) return Promise.resolve(jsonResponse({ error: { code: 'SESSION_EXPIRED', message: 'Sign in required.' } }, 401))
      if (url.endsWith('/auth/code')) return Promise.resolve(jsonResponse({ kind: 'login', user, session: { expiresAt: future }, recoveryAuthorization: { authorizationToken: 'scoped-add-only', expiresAt: future } }))
      if (url.endsWith('/settings')) return Promise.resolve(jsonResponse({ defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false, showPartialTranscripts: true, compactTranscriptLayout: false }))
      return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not in this test.' } }, 404))
    }))

    render(<ThemeProvider><RouterProvider><ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider></RouterProvider></ThemeProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Use a temporary code' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Six-digit code' }), '123456')

    // The login page is still leaving, and must not pull the route back to itself…
    await waitFor(() => expect(document.querySelector('.app-curtain[data-stage="leave"]')).not.toBeNull())
    expect(window.location.pathname).toBe('/settings')
    // …nor, once it has gone, send the workspace anywhere but where the code led.
    await waitFor(() => expect(document.querySelector('.app-curtain[data-stage="play"]')).not.toBeNull(), { timeout: SIGN_IN_LEAVE_MS + 1000 })
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.hash).toBe('#security')
  })
})
