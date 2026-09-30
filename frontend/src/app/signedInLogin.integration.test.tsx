import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { ThemeProvider, ToastProvider } from '../design-system'
import { AuthProvider } from './auth'
import { RouterProvider } from './router'
import { SIGN_IN_LEAVE_MS } from './stageTiming'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const signedIn = {
  user: { id: 'usr_1', username: 'listener', displayName: 'Robin Listener', role: 'user' as const, status: 'active' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  session: { expiresAt: '2099-01-01T00:00:00Z' },
}

function stubServer() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/auth/me')) return Promise.resolve(jsonResponse(signedIn))
    if (url.endsWith('/auth/logout')) return Promise.resolve(new Response(null, { status: 204 }))
    if (url.endsWith('/settings')) return Promise.resolve(jsonResponse({ defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false, showPartialTranscripts: true, compactTranscriptLayout: false, onboardingComplete: true }))
    return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not in this test.' } }, 404))
  }))
  return calls
}

const renderApp = () => render(<ThemeProvider><RouterProvider><ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider></RouterProvider></ThemeProvider>)

describe('the login page, signed in already', () => {
  beforeEach(() => window.history.replaceState(null, '', '/login'))
  afterEach(() => vi.unstubAllGlobals())

  it('stays open, greets the account by name and offers to go on as it', async () => {
    stubServer()
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Welcome back, Robin Listener' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('button', { name: 'Continue as Robin Listener' })).toBeInTheDocument()
    // Nothing to sign in with while an account is signed in.
    expect(screen.queryByRole('button', { name: 'Continue with a passkey' })).toBeNull()
  })

  it('goes on into the workspace behind the sign-in curtain, the login page leaving first', async () => {
    stubServer()
    renderApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Continue as Robin Listener' }))
    expect(document.querySelector('.app-curtain[data-kind="enter"][data-stage="leave"]')).not.toBeNull()
    expect(window.location.pathname).toBe('/sessions')
    // Still the login page while it slides away…
    expect(screen.getByRole('heading', { name: 'Welcome back, Robin Listener' })).toBeInTheDocument()
    // …then the workspace, under the curtain.
    await waitFor(() => expect(document.querySelector('.app-curtain[data-stage="play"]')).not.toBeNull(), { timeout: SIGN_IN_LEAVE_MS + 1000 })
    expect(document.querySelector('.app-frame')).not.toBeNull()
  })

  it('signs this account out to sign in with another', async () => {
    const calls = stubServer()
    renderApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with another account' }))
    expect(await screen.findByRole('button', { name: 'Continue with a passkey' })).toBeInTheDocument()
    expect(calls.some((url) => url.endsWith('/auth/logout'))).toBe(true)
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })

  it('opens the site at the welcome page, whether signed in or not', async () => {
    window.history.replaceState(null, '', '/')
    stubServer()
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Welcome back, Robin Listener' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
  })

  it('still sends a signed-in account away from registration', async () => {
    window.history.replaceState(null, '', '/register')
    stubServer()
    renderApp()
    await waitFor(() => expect(window.location.pathname).toBe('/sessions'))
  })
})
