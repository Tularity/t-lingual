import { api } from './client'
import type { SerializedCredential, UserSettings } from './contracts'
import { AUTH_SESSION_INVALID_EVENT, type AuthSessionInvalidDetail } from './sessionInvalid'

const credential: SerializedCredential = { id: 'credential-id', rawId: 'cmF3', type: 'public-key', authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'Y2xpZW50' } }
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('HTTP API contract', () => {
  it('sends the ceremony token only in the header and credential as the finish body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user: { id: 'u' }, session: { expiresAt: 'soon' } }))
    vi.stubGlobal('fetch', fetchMock)
    await api.auth.loginFinish('ceremony-secret', credential)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/auth/login/finish')
    expect(new Headers(init.headers).get('X-WebAuthn-Ceremony')).toBe('ceremony-secret')
    expect(JSON.parse(String(init.body))).toEqual(credential)
    expect(String(init.body)).not.toContain('ceremony-secret')
  })

  it('uses the backend session detail and segment endpoints', async () => {
    const detail = { session: { id: 'int_1' }, segments: [{ id: 'seg_1' }] }
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(detail)).mockResolvedValueOnce(jsonResponse({ items: detail.segments }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.sessions.get('int_1')).resolves.toEqual(detail)
    await expect(api.sessions.segments('int_1')).resolves.toEqual({ items: detail.segments })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/view/sessions/int_1', '/api/v1/view/sessions/int_1/segments'])
  })

  it('writes the exact flat camelCase settings shape', async () => {
    const settings: UserSettings = { defaultSourceLanguage: 'auto', defaultTargetLanguage: 'en', autoStartMicrophone: false, showPartialTranscripts: true, compactTranscriptLayout: false }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(settings))
    vi.stubGlobal('fetch', fetchMock)
    await api.settings.update(settings)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual(settings)
  })

  it('uses owner-scoped browser session routes and step-up headers', async () => {
    const browser = {
      id: 'browser_1', createdAt: 'created', expiresAt: 'expires', lastSeen: 'seen',
      userAgent: 'Test browser', ipAddress: '192.0.2.8', current: true,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [browser] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ revoked: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.browserSessions.list()).resolves.toEqual([browser])
    await api.browserSessions.revoke('browser_current')
    await api.browserSessions.revoke('browser_other', 'single-session-grant')
    await expect(api.browserSessions.revokeOthers('all-other-grant')).resolves.toEqual({ revoked: 2 })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/auth/sessions',
      '/api/v1/auth/sessions/browser_current',
      '/api/v1/auth/sessions/browser_other',
      '/api/v1/auth/sessions/revoke-others',
    ])
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
    expect(new Headers(calls[1]![1].headers).get('X-Passkey-Authorization')).toBeNull()
    expect(new Headers(calls[2]![1].headers).get('X-Passkey-Authorization')).toBe('single-session-grant')
    expect(new Headers(calls[3]![1].headers).get('X-Passkey-Authorization')).toBe('all-other-grant')
  })

  it('carries pagination through workspace and administration list requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], offset: 200, limit: 200 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], offset: 400, limit: 200 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], offset: 600, limit: 200 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], offset: 800, limit: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api.sessions.list({ limit: 200, offset: 200 })
    await api.admin.invitations({ limit: 200, offset: 400 })
    await api.admin.users({ limit: 200, offset: 600 })
    await api.admin.audit({ limit: 200, offset: 800 })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/view/sessions?limit=200&offset=200',
      '/api/v1/admin/invitations?limit=200&offset=400',
      '/api/v1/admin/users?limit=200&offset=600',
      '/api/v1/admin/audit?limit=200&offset=800',
    ])
  })

  it('sends one-time passkey authorization on every administrative mutation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ invitation: { id: 'invite_1' }, code: '123456' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'user_1', role: 'admin', status: 'active' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.admin.createInvitation('grant-create', { expiresInHours: 24 })
    await api.admin.revokeInvitation('grant-revoke', 'invite_1')
    await api.admin.updateUser('grant-user', 'user_1', { role: 'admin' })

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
    expect(calls.map(([url]) => url)).toEqual([
      '/api/v1/admin/invitations',
      '/api/v1/admin/invitations/invite_1/revoke',
      '/api/v1/admin/users/user_1',
    ])
    expect(calls.map(([, init]) => new Headers(init.headers).get('X-Passkey-Authorization'))).toEqual([
      'grant-create', 'grant-revoke', 'grant-user',
    ])
  })

  it('binds passkey authorization ceremonies to the requested operation scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ceremonyToken: 'ceremony', expiresAt: 'soon', options: { publicKey: {} } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.passkeys.authorizationBegin('admin:invitation:create:24')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/passkeys/authorize/begin')
    expect(JSON.parse(String(init.body))).toEqual({ scope: 'admin:invitation:create:24' })
  })

  it('announces protected-request and authorization-begin expiry without treating finish failure as logout', async () => {
    const invalidations: AuthSessionInvalidDetail[] = []
    const listener = (event: Event) => invalidations.push((event as CustomEvent<AuthSessionInvalidDetail>).detail)
    window.addEventListener(AUTH_SESSION_INVALID_EVENT, listener)
    const unauthorized = jsonResponse({ error: { code: 'SESSION_EXPIRED', message: 'Sign in again.' } }, 401)
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(
      jsonResponse({ error: { code: 'PASSKEY_VERIFICATION_FAILED', message: 'Passkey verification failed.' } }, 401),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.sessions.list()).rejects.toMatchObject({ status: 401 })
    expect(invalidations).toEqual([{ reason: 'expired', message: 'Sign in again.' }])
    await expect(api.passkeys.authorizationBegin()).rejects.toMatchObject({ status: 401 })
    expect(invalidations).toHaveLength(2)
    await expect(api.passkeys.authorizationFinish('ceremony', credential)).rejects.toMatchObject({ status: 401 })
    expect(invalidations).toHaveLength(2)
    window.removeEventListener(AUTH_SESSION_INVALID_EVENT, listener)
  })

  it('announces an account disabled response distinctly', async () => {
    const listener = vi.fn()
    window.addEventListener(AUTH_SESSION_INVALID_EVENT, listener)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'ACCOUNT_DISABLED', message: 'This account is disabled.' } }, 403),
    ))

    await expect(api.settings.get()).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_DISABLED' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0]?.[0] as CustomEvent<AuthSessionInvalidDetail>).detail).toEqual({
      reason: 'account_disabled',
      message: 'This account is disabled.',
    })
    window.removeEventListener(AUTH_SESSION_INVALID_EVENT, listener)
  })
})
