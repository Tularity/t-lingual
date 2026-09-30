import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { ToastProvider } from '../../design-system'
import { AdminDataProvider } from './AdminData'
import { AdminUserSignIn } from './AdminUserSignIn'
import { DefaultLimitsDialog } from './DefaultLimitsDialog'
import { describeDevice } from '../../app/deviceName'

const mocks = vi.hoisted(() => ({
  authorizationBegin: vi.fn(), authorizationFinish: vi.fn(), getPasskey: vi.fn(),
  userSecurity: vi.fn(), deleteUserPasskey: vi.fn(), revokeUserSession: vi.fn(), createCode: vi.fn(),
  defaultLimits: vi.fn(), setDefaultLimits: vi.fn(),
}))
const now = '2026-09-01T00:00:00Z'
const person = { id: 'usr_1', username: 'listener', displayName: 'Target User', role: 'user' as const, status: 'active' as const, createdAt: now, updatedAt: now }

vi.mock('../../api/client', () => ({
  api: {
    mode: 'mock',
    passkeys: { authorizationBegin: mocks.authorizationBegin, authorizationFinish: mocks.authorizationFinish },
    admin: {
      users: async () => [], invitations: async () => [], audit: async () => [],
      userSecurity: mocks.userSecurity, deleteUserPasskey: mocks.deleteUserPasskey, revokeUserSession: mocks.revokeUserSession,
      createCode: mocks.createCode, defaultLimits: mocks.defaultLimits, setDefaultLimits: mocks.setDefaultLimits,
    },
  },
}))
vi.mock('../../api/webauthn', () => ({ getPasskey: mocks.getPasskey }))
vi.mock('../../app/router', () => ({ Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }))

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const wrap = (node: ReactNode) => render(<ToastProvider><AdminDataProvider userId="admin_1">{node}</AdminDataProvider></ToastProvider>)
const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('how someone signs in, for an administrator', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.authorizationBegin.mockResolvedValue({ ceremonyToken: 'ceremony', expiresAt: 'soon', options: { publicKey: {} } })
    mocks.authorizationFinish.mockImplementation(async () => ({ authorizationToken: `grant-${mocks.authorizationFinish.mock.calls.length}`, expiresAt: 'soon' }))
    mocks.getPasskey.mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    mocks.userSecurity.mockResolvedValue({
      passkeys: [{ id: 'cred_only', userId: 'usr_1', name: 'Laptop', createdAt: now, lastUsedAt: null }],
      sessions: [{ id: 'ses_1', createdAt: now, expiresAt: now, lastSeen: now, userAgent: chrome, ipAddress: '192.0.2.1', current: false }],
    })
    mocks.deleteUserPasskey.mockResolvedValue(undefined)
    mocks.revokeUserSession.mockResolvedValue(undefined)
  })

  it('names browsers in words and signs one out with a passkey for that browser alone', async () => {
    const user = userEvent.setup()
    wrap(<AdminUserSignIn user={person} self={false} />)
    const browsers = await screen.findByRole('list', { name: 'Signed-in browsers' })
    expect(within(browsers).getByText('Chrome on Windows')).toBeInTheDocument()
    await user.click(within(browsers).getByRole('button', { name: 'Sign out Chrome on Windows' }))
    await user.click(screen.getByRole('button', { name: 'Verify and sign out' }))
    await waitFor(() => expect(mocks.revokeUserSession).toHaveBeenCalledWith('grant-1', 'usr_1', 'ses_1'))
    expect(mocks.authorizationBegin).toHaveBeenCalledWith(`admin:user:session:usr_1:${await sha256('ses_1')}`)
  })

  it('warns before removing someone’s only passkey, and removes it with a passkey for that one', async () => {
    const user = userEvent.setup()
    wrap(<AdminUserSignIn user={person} self={false} />)
    await user.click(await screen.findByRole('button', { name: 'Remove passkey Laptop' }))
    expect(screen.getByText(/This is their only passkey/u)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify and remove' }))
    await waitFor(() => expect(mocks.deleteUserPasskey).toHaveBeenCalledWith('grant-1', 'usr_1', 'cred_only'))
    expect(mocks.authorizationBegin).toHaveBeenCalledWith(`admin:user:passkey:usr_1:${await sha256('cred_only')}`)
  })

  it('makes a one-time sign-in code for them and shows it once', async () => {
    mocks.createCode.mockResolvedValue({ id: 'inv_new', code: '482913', kind: 'login', targetUserId: 'usr_1', notBefore: now, expiresAt: '2026-09-01T00:05:00Z' })
    const user = userEvent.setup()
    wrap(<AdminUserSignIn user={person} self={false} />)
    expect(await screen.findByRole('link', { name: 'More options' })).toHaveAttribute('href', '/admin/codes?for=usr_1')
    await user.click(screen.getByRole('radio', { name: '5 min' }))
    await user.click(screen.getByRole('button', { name: 'Verify and make code' }))
    await waitFor(() => expect(mocks.createCode).toHaveBeenCalledWith('grant-1', { kind: 'login', targetUserId: 'usr_1', ttlSeconds: 300 }))
    expect(await screen.findByRole('button', { name: 'Copy code 482913' })).toBeInTheDocument()
  })

  it('leaves an administrator’s own passkeys and browsers to their settings', async () => {
    wrap(<AdminUserSignIn user={{ ...person, id: 'admin_1' }} self />)
    await screen.findByRole('list', { name: 'Passkeys' })
    expect(screen.queryByRole('button', { name: /Remove passkey/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sign out/u })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '/settings')
    // A sign-in code for oneself, for another device, is allowed.
    expect(screen.getByText('Sign yourself in once without a passkey')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify and make code' })).toBeEnabled()
  })
})

describe('the default limits', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.authorizationBegin.mockResolvedValue({ ceremonyToken: 'ceremony', expiresAt: 'soon', options: { publicKey: {} } })
    mocks.authorizationFinish.mockResolvedValue({ authorizationToken: 'grant-1', expiresAt: 'soon' })
    mocks.getPasskey.mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    const builtIn = { concurrentRecordings: 1, monthlyRecordingMinutes: 0, storageMb: 0, workspaces: 100, guestLinks: true }
    mocks.defaultLimits.mockResolvedValue({ defaults: builtIn, builtIn })
    mocks.setDefaultLimits.mockImplementation(async (_token: string, body: string) => ({ defaults: JSON.parse(body), builtIn }))
  })

  it('saves new defaults with a passkey for exactly those values', async () => {
    const saved = vi.fn()
    const user = userEvent.setup()
    wrap(<DefaultLimitsDialog open onClose={() => undefined} onSaved={saved} />)
    const minutes = await screen.findByRole('spinbutton', { name: 'Recording minutes a month' })
    await user.clear(minutes)
    await user.type(minutes, '600')
    await user.click(screen.getByRole('button', { name: 'Verify and save' }))
    await waitFor(() => expect(mocks.setDefaultLimits).toHaveBeenCalledTimes(1))
    const body = mocks.setDefaultLimits.mock.calls[0]![1]
    expect(JSON.parse(body)).toEqual({ concurrentRecordings: 1, monthlyRecordingMinutes: 600, storageMb: 0, workspaces: 100, guestLinks: true })
    expect(mocks.authorizationBegin).toHaveBeenCalledWith(`admin:limits:update:${await sha256(body)}`)
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ monthlyRecordingMinutes: 600 }))
  })

  it('refuses a default outside its range', async () => {
    const user = userEvent.setup()
    wrap(<DefaultLimitsDialog open onClose={() => undefined} onSaved={() => undefined} />)
    const workspaces = await screen.findByRole('spinbutton', { name: 'Workspaces' })
    await user.clear(workspaces)
    await user.type(workspaces, '0')
    await user.click(screen.getByRole('button', { name: 'Verify and save' }))
    expect(await screen.findByText('Use a whole number from 1 to 100.')).toBeInTheDocument()
    expect(mocks.authorizationBegin).not.toHaveBeenCalled()
  })
})

describe('naming a browser', () => {
  it('reads common browsers and systems, and keeps anything else as it came', () => {
    expect(describeDevice(chrome)).toEqual({ browser: 'Chrome', system: 'Windows' })
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Safari', system: 'iPhone' })
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toEqual({ browser: 'Edge', system: 'macOS' })
    expect(describeDevice('curl/8.4.0')).toEqual({ raw: 'curl/8.4.0' })
  })
})
