import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider, useAuth } from '../../app/auth'
import { RouterProvider, useRouter } from '../../app/router'
import { I18nTextProvider } from '../../app/i18n'
import { ThemeProvider } from '../../design-system/theme'
import { setRecoveryAuthorization } from '../../app/passkeyAuthorization'
import { LoginPage, RegisterPage } from './AuthPages'

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const unauthenticated = () => response({ error: { code: 'SESSION_EXPIRED', message: 'Sign in required.' } }, 401)
const future = '2099-01-01T00:00:00Z'
const user = { id: 'usr_code_user', username: 'code-user', displayName: 'Code User', role: 'user', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
function StateProbe() {
  const { path } = useRouter()
  const { status, user: current, registrationTicket, recoveryExpiresAt } = useAuth()
  return <><output aria-label="route">{path}</output><output aria-label="auth-status">{status}</output><output aria-label="account">{current?.id ?? ''}</output><output aria-label="ticket">{registrationTicket?.ticket ?? ''}</output><output aria-label="recovery-expiry">{recoveryExpiresAt ?? ''}</output></>
}
function AuthRoute() {
  const { path } = useRouter()
  return <>{path === '/register' ? <RegisterPage /> : <LoginPage />}<StateProbe /></>
}
function renderRealCodeFlow() {
  return render(<AuthProvider><ThemeProvider><I18nTextProvider locale="en"><RouterProvider><AuthRoute /></RouterProvider></I18nTextProvider></ThemeProvider></AuthProvider>)
}
beforeEach(() => { window.history.replaceState(null, '', '/login'); setRecoveryAuthorization(null) })
afterEach(() => { vi.unstubAllGlobals(); setRecoveryAuthorization(null) })

describe('single code input through the real AuthProvider and HTTP adapter', () => {
  it('posts exactly one six-digit code and enters registration profile without creating a session', async () => {
    const requests: Array<[string, RequestInit]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push([url, init])
      if (url === '/api/v1/auth/me') return unauthenticated()
      if (url === '/api/v1/auth/code') return response({ kind: 'registration', registrationTicket: 'sealed-registration-ticket', expiresAt: future })
      throw new Error(`unexpected request ${url}`)
    }))
    renderRealCodeFlow()
    await waitFor(() => expect(screen.getByLabelText('auth-status')).toHaveTextContent('anonymous'))
    await userEvent.click(screen.getByRole('button',{name:'Use a temporary code'}))
    await userEvent.type(screen.getByRole('textbox', { name: 'Six-digit code' }), '123456')
    await waitFor(() => expect(screen.getByLabelText('route')).toHaveTextContent('/register'))
    expect(screen.getByLabelText('ticket')).toHaveTextContent('sealed-registration-ticket')
    expect(screen.getByRole('textbox', { name: 'Username' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeInTheDocument()
    expect(screen.getByLabelText('auth-status')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('account')).toBeEmptyDOMElement()
    const codeCalls = requests.filter(([url]) => url === '/api/v1/auth/code')
    expect(codeCalls).toHaveLength(1)
    expect(JSON.parse(String(codeCalls[0]![1].body))).toEqual({ code: '123456' })
    expect(codeCalls[0]![1].method).toBe('POST')
    expect(codeCalls[0]![1].credentials).toBe('include')
    expect(new Headers(codeCalls[0]![1].headers).get('Content-Type')).toBe('application/json')
  })

  it('accepts a login result directly into authenticated security settings', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/api/v1/auth/me' ? unauthenticated() :
      response({ kind: 'login', user, session: { expiresAt: future }, recoveryAuthorization: { authorizationToken: 'scoped-add-only', expiresAt: future } }))
    vi.stubGlobal('fetch', fetchMock)
    renderRealCodeFlow()
    await waitFor(() => expect(screen.getByLabelText('auth-status')).toHaveTextContent('anonymous'))
    await userEvent.click(screen.getByRole('button',{name:'Use a temporary code'}))
    await userEvent.type(screen.getByRole('textbox', { name: 'Six-digit code' }), '654321')
    await waitFor(() => expect(screen.getByLabelText('route')).toHaveTextContent('/settings'))
    expect(window.location.hash).toBe('#security')
    expect(screen.getByLabelText('auth-status')).toHaveTextContent('authenticated')
    expect(screen.getByLabelText('account')).toHaveTextContent('usr_code_user')
    expect(screen.getByLabelText('recovery-expiry')).toHaveTextContent(future)
    expect(screen.getByLabelText('ticket')).toBeEmptyDOMElement()
  })

  it.each([{ label: 'future', code: '123456' }, { label: 'invalid', code: '000001' }])('shows a  code error without navigation', async ({ code }) => {
    const fetchMock = vi.fn(async (url: string) => url === '/api/v1/auth/me' ? unauthenticated() :
      response({ error: { code: 'INVALID_CODE', message: 'The code is invalid, not yet active, expired, used, or revoked.' } }, 422))
    vi.stubGlobal('fetch', fetchMock)
    renderRealCodeFlow()
    await waitFor(() => expect(screen.getByLabelText('auth-status')).toHaveTextContent('anonymous'))
    await userEvent.click(screen.getByRole('button',{name:'Use a temporary code'}))
    await userEvent.type(screen.getByRole('textbox', { name: 'Six-digit code' }), code)
    expect(await screen.findByText('The code is invalid, not yet active, expired, used, or revoked.')).toBeInTheDocument()
    expect(screen.getByLabelText('route')).toHaveTextContent('/login')
    expect(screen.getByLabelText('auth-status')).toHaveTextContent('anonymous')
    expect(screen.getByRole('textbox', { name: 'Six-digit code' })).toHaveValue(code)
  })
})
