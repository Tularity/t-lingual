import { authorizePasskeyAction, recoveryAuthorizationExpiresAt, setRecoveryAuthorization } from './passkeyAuthorization'
import type { SerializedCredential } from '../api/contracts'

const mocks = vi.hoisted(() => ({ getPasskey: vi.fn() }))
vi.mock('../api/webauthn', () => ({ getPasskey: mocks.getPasskey }))
const credential: SerializedCredential = { id: 'credential-id', rawId: 'cmF3', type: 'public-key', authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'Y2xpZW50' } }
const future = '2099-01-01T00:00:00Z'
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  setRecoveryAuthorization(null)
  mocks.getPasskey.mockReset().mockResolvedValue(credential)
})
afterEach(() => { setRecoveryAuthorization(null); vi.unstubAllGlobals() })

function stubAuthorizationHTTP() {
  const calls: Array<[string, RequestInit]> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init])
    if (url === '/api/v1/passkeys/authorize/begin') return json({ ceremonyToken: 'ceremony-for-step-up', expiresAt: future, options: { publicKey: { challenge: 'AQI' } } })
    if (url === '/api/v1/passkeys/authorize/finish') return json({ authorizationToken: 'verified-passkey-grant', expiresAt: future })
    throw new Error(`unexpected request ${url}`)
  }))
  return calls
}

describe('scoped one-time recovery authorization', () => {
  it('keeps the recovery grant for add only; admin and generic management still require WebAuthn', async () => {
    const calls = stubAuthorizationHTTP()
    setRecoveryAuthorization({ authorizationToken: 'recovery-add-only', expiresAt: future })
    const adminScope = `admin:code:create:${'a'.repeat(64)}`
    await expect(authorizePasskeyAction(adminScope)).resolves.toMatchObject({ authorizationToken: 'verified-passkey-grant' })
    await expect(authorizePasskeyAction()).resolves.toMatchObject({ authorizationToken: 'verified-passkey-grant' })
    expect(recoveryAuthorizationExpiresAt()).toBe(future)
    expect(calls.filter(([url]) => url.endsWith('/authorize/begin'))).toHaveLength(2)
    expect(calls.filter(([url]) => url.endsWith('/authorize/finish'))).toHaveLength(2)
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ scope: adminScope })
    expect(calls[1]![0]).toBe('/api/v1/passkeys/authorize/finish')
    expect(new Headers(calls[1]![1].headers).get('X-WebAuthn-Ceremony')).toBe('ceremony-for-step-up')
    expect(JSON.parse(String(calls[1]![1].body))).toEqual(credential)
    expect(calls[2]![1].body).toBeUndefined()
    expect(mocks.getPasskey).toHaveBeenCalledTimes(2)
    await expect(authorizePasskeyAction('passkeys:add')).resolves.toMatchObject({ authorizationToken: 'recovery-add-only' })
    expect(recoveryAuthorizationExpiresAt()).toBe(future)
    expect(calls).toHaveLength(4)
    setRecoveryAuthorization(null)
    await expect(authorizePasskeyAction('passkeys:add')).resolves.toMatchObject({ authorizationToken: 'verified-passkey-grant' })
    expect(calls).toHaveLength(6)
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ scope: 'passkeys:add' })
    expect(mocks.getPasskey).toHaveBeenCalledTimes(3)
  })

  it('retains proof for a cancelled enrollment retry until successful completion clears it', async () => {
    const calls = stubAuthorizationHTTP()
    setRecoveryAuthorization({authorizationToken:'retryable-enrollment',expiresAt:future})
    await expect(authorizePasskeyAction('passkeys:add')).resolves.toMatchObject({authorizationToken:'retryable-enrollment'})
    await expect(authorizePasskeyAction('passkeys:add')).resolves.toMatchObject({authorizationToken:'retryable-enrollment'})
    expect(calls).toHaveLength(0)
    setRecoveryAuthorization(null)
    await expect(authorizePasskeyAction('passkeys:add')).resolves.toMatchObject({authorizationToken:'verified-passkey-grant'})
    expect(calls).toHaveLength(2)
  })

  it('does not use an expired recovery grant and falls back to passkey verification', async () => {
    const calls = stubAuthorizationHTTP()
    setRecoveryAuthorization({ authorizationToken: 'expired-add', expiresAt: '2020-01-01T00:00:00Z' })
    await expect(authorizePasskeyAction('passkeys:add')).resolves.toMatchObject({ authorizationToken: 'verified-passkey-grant' })
    expect(calls.filter(([url]) => url.endsWith('/authorize/begin'))).toHaveLength(1)
    expect(recoveryAuthorizationExpiresAt()).toBeNull()
  })
})
