import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { ToastProvider } from '../../design-system'
import { AdminDataProvider } from './AdminData'
import { AccessCodesPage } from './AccessCodesPage'
import { PeoplePage } from './PeoplePage'
import { invitationCreateScope, invitationRevokeScope, userUpdateScope } from './adminModel'

/** Opens the dropdown named `label` and picks the option that reads `option`. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`, 'u') }))
  await user.click(await screen.findByRole('menuitemradio', { name: option }))
}

const mocks = vi.hoisted(() => ({
  authorizationBegin: vi.fn(),
  authorizationFinish: vi.fn(),
  invitations: vi.fn(),
  createCode: vi.fn(),
  revokeInvitation: vi.fn(),
  users: vi.fn(),
  updateUser: vi.fn(),
  audit: vi.fn(),
  getPasskey: vi.fn(),
}))

const now = '2026-09-01T00:00:00Z'
const currentUser = { id: 'admin_1', username: 'admin', displayName: 'Administrator', role: 'admin' as const, status: 'active' as const, createdAt: now, updatedAt: now }
const targetUser = { id: 'user_1', username: 'listener', displayName: 'Target User', role: 'user' as const, status: 'active' as const, createdAt: now, updatedAt: now }
const existingInvitation = { id: 'inv_existing', createdBy: currentUser.id, createdAt: now, expiresAt: '2099-01-01T00:00:00Z', usedAt: null, usedBy: null, revokedAt: null }

vi.mock('../../api/client', () => ({
  api: {
    mode: 'mock',
    passkeys: { authorizationBegin: mocks.authorizationBegin, authorizationFinish: mocks.authorizationFinish },
    admin: {
      invitations: mocks.invitations,
      createCode: mocks.createCode,
      revokeInvitation: mocks.revokeInvitation,
      users: mocks.users,
      updateUser: mocks.updateUser,
      audit: mocks.audit,
    },
  },
}))

vi.mock('../../api/webauthn', () => ({ getPasskey: mocks.getPasskey }))

vi.mock('../../app/auth', () => ({ useAuth: () => ({ user: currentUser }) }))

function renderAdmin(page: ReactNode) {
  return render(<ToastProvider><AdminDataProvider userId={currentUser.id}>{page}</AdminDataProvider></ToastProvider>)
}

describe('administrative passkey step-up', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    localStorage.clear()
    mocks.authorizationBegin.mockResolvedValue({ ceremonyToken: 'ceremony', expiresAt: 'soon', options: { publicKey: {} } })
    mocks.authorizationFinish.mockImplementation(async () => ({ authorizationToken: `grant-${mocks.authorizationFinish.mock.calls.length}`, expiresAt: 'soon' }))
    mocks.getPasskey.mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    mocks.invitations.mockResolvedValue([existingInvitation])
    mocks.users.mockResolvedValue([currentUser, targetUser])
    mocks.audit.mockResolvedValue([])
    mocks.createCode.mockResolvedValue({ id: 'inv_created', kind: 'registration', notBefore: now, expiresAt: '2099-01-01T00:00:00Z', code: '123456' })
    mocks.revokeInvitation.mockResolvedValue(undefined)
    mocks.updateUser.mockImplementation(async (_grant: string, _id: string, input: Record<string, unknown>) => ({ ...targetUser, ...input, updatedAt: now }))
  })

  it('uses the backend canonical operation scopes, including default invitation expiry', () => {
    expect(invitationCreateScope(0)).toBe('admin:invitation:create:0')
    expect(invitationRevokeScope('inv_1')).toBe('admin:invitation:revoke:inv_1')
    expect(userUpdateScope('user_1', { role: 'admin' })).toBe('admin:user:update:user_1:admin:-')
    expect(userUpdateScope('user_1', { status: 'disabled' })).toBe('admin:user:update:user_1:-:disabled')
  })

  it('obtains a fresh one-time grant before each create, revoke, role, and status mutation', async () => {
    const user = userEvent.setup()
    const codes = renderAdmin(<AccessCodesPage />)

    await user.click(await screen.findByRole('button', { name: 'Verify and generate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Copy this code now' })
    expect(within(dialog).getByRole('button', { name: 'Copy code 123456' })).toHaveTextContent('123456')
    expect(mocks.createCode).toHaveBeenCalledWith('grant-1', { kind: 'registration', ttlSeconds: 86400 })
    await user.click(screen.getByRole('button', { name: 'Done' }))

    const existingRow = screen.getByRole('button', { name: 'Details of access code #1' }).closest('tr')
    expect(existingRow).not.toBeNull()
    await user.click(within(existingRow as HTMLElement).getByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Verify and revoke' }))
    await waitFor(() => expect(mocks.revokeInvitation).toHaveBeenCalledWith('grant-2', 'inv_existing'))
    codes.unmount()

    renderAdmin(<PeoplePage />)
    await screen.findByText('Target User')
    await choose(user, 'Role for Target User', 'Administrator')
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith('grant-3', 'user_1', { role: 'admin' }))

    await user.click(screen.getByRole('switch', { name: 'Account access for Target User' }))
    await user.click(screen.getByRole('button', { name: 'Verify and disable' }))
    await waitFor(() => expect(mocks.updateUser).toHaveBeenLastCalledWith('grant-4', 'user_1', { status: 'disabled' }))

    expect(mocks.authorizationBegin.mock.calls).toEqual([
      ['admin:code:create:324970af4c903c496087e8e76f982a6c8c8267a739ab322bcfe41da0fcbb7de5'],
      ['admin:invitation:revoke:inv_existing'],
      ['admin:user:update:user_1:admin:-'],
      ['admin:user:update:user_1:-:disabled'],
    ])
    expect(mocks.authorizationFinish).toHaveBeenCalledTimes(4)
  })

  it('makes a sign-in code for a chosen person, oneself included, and says what it will make first', async () => {
    const user = userEvent.setup()
    mocks.createCode.mockResolvedValue({ id: 'inv_login', kind: 'login', targetUserId: 'user_1', notBefore: now, expiresAt: '2099-01-01T00:00:00Z', code: '654321' })
    renderAdmin(<AccessCodesPage />)
    await screen.findByRole('button', { name: 'Details of access code #1' })
    await user.click(screen.getByRole('radio', { name: /Sign in once/ }))
    expect(screen.getByRole('button', { name: 'Verify and generate' })).toBeDisabled()
    expect(screen.getByText('Choose who the code is for.')).toBeInTheDocument()
    // An administrator can make one for themselves, to sign in on another device.
    await user.click(screen.getByRole('button', { name: /^Account/ }))
    const search = await screen.findByRole('combobox', { name: 'Search by name or username' })
    expect(screen.getByRole('option', { name: /Administrator/ })).toBeInTheDocument()
    await user.type(search, 'listen')
    await user.click(await screen.findByRole('option', { name: /Target User/ }))
    expect(screen.getByText(/Target User can sign in once with it/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: '15 minutes' }))
    await user.click(screen.getByRole('button', { name: 'Verify and generate' }))
    await waitFor(() => expect(mocks.createCode).toHaveBeenCalledWith('grant-1', { kind: 'login', targetUserId: 'user_1', ttlSeconds: 900 }))
  })

  it('opens ready to make a sign-in code for the person it was opened for', async () => {
    const user = userEvent.setup()
    window.history.pushState(null, '', '/admin/codes?for=user_1')
    try {
      mocks.createCode.mockResolvedValue({ id: 'inv_login', kind: 'login', targetUserId: 'user_1', notBefore: now, expiresAt: '2099-01-01T00:00:00Z', code: '654321' })
      renderAdmin(<AccessCodesPage />)
      await screen.findByRole('button', { name: 'Details of access code #1' })
      expect(screen.getByRole('radio', { name: /Sign in once/ })).toBeChecked()
      expect(await screen.findByText(/Target User can sign in once with it/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Verify and generate' }))
      await waitFor(() => expect(mocks.createCode).toHaveBeenCalledWith('grant-1', { kind: 'login', targetUserId: 'user_1', ttlSeconds: 600 }))
    } finally { window.history.pushState(null, '', '/') }
  })

  it('sets any other length in a dialog, within what the server allows', async () => {
    const user = userEvent.setup()
    renderAdmin(<AccessCodesPage />)
    await screen.findByRole('button', { name: 'Details of access code #1' })
    await user.click(screen.getByRole('button', { name: 'Custom…' }))
    const length = await screen.findByRole('spinbutton', { name: 'Length' })
    await user.clear(length)
    await user.type(length, '31')
    await user.click(screen.getByRole('radio', { name: 'Days' }))
    expect(screen.getByText('At most 30 days.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use this length' })).toBeDisabled()
    await user.clear(length)
    await user.type(length, '36')
    await user.click(screen.getByRole('radio', { name: 'Hours' }))
    await user.click(screen.getByRole('button', { name: 'Use this length' }))
    expect(await screen.findByRole('button', { name: /36 hours/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify and generate' }))
    await waitFor(() => expect(mocks.createCode).toHaveBeenCalledWith('grant-1', { kind: 'registration', ttlSeconds: 129600 }))
  })

  it('leaves administration state unchanged when passkey verification is cancelled', async () => {
    mocks.authorizationBegin.mockRejectedValueOnce(new DOMException('Cancelled', 'NotAllowedError'))
    const user = userEvent.setup()
    renderAdmin(<AccessCodesPage />)

    await user.click(await screen.findByRole('button', { name: 'Verify and generate' }))
    expect(await screen.findByText('Code could not be created')).toBeInTheDocument()
    expect(mocks.createCode).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Details of access code #1' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Copy this code now' })).not.toBeInTheDocument()
  })

  it('filters codes without displaying internal identifiers, and opens a code into its history', async () => {
    const user = userEvent.setup()
    renderAdmin(<AccessCodesPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Access codes' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Details of access code #1' })).toBeInTheDocument()
    expect(screen.queryByText('inv_existing')).not.toBeInTheDocument()
    const filters = screen.getByRole('group', { name: 'Show codes' })
    await user.click(within(filters).getByRole('button', { name: /^Used/ }))
    expect(screen.getByText('No codes in this view')).toBeInTheDocument()
    await user.click(within(filters).getByRole('button', { name: /^Active/ }))
    await user.click(screen.getByRole('button', { name: 'Details of access code #1' }))
    const drawer = await screen.findByRole('dialog', { name: 'Access code #1' })
    expect(within(drawer).getByText('Made')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Revoke code' })).toBeInTheDocument()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
  })
})
