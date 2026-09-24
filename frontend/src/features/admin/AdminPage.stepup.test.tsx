import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import { AdminPage, invitationCreateScope, invitationRevokeScope, userUpdateScope } from './AdminPage'

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

describe('administrative passkey step-up', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.authorizationBegin.mockResolvedValue({ ceremonyToken: 'ceremony', expiresAt: 'soon', options: { publicKey: {} } })
    mocks.authorizationFinish.mockImplementation(async () => ({ authorizationToken: `grant-${mocks.authorizationFinish.mock.calls.length}`, expiresAt: 'soon' }))
    mocks.getPasskey.mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    mocks.invitations.mockResolvedValue([existingInvitation])
    mocks.users.mockResolvedValue([currentUser, targetUser])
    mocks.audit.mockResolvedValue([])
    mocks.createCode.mockResolvedValue({
      id:'inv_created',kind:'registration',notBefore:now,expiresAt:'2099-01-01T00:00:00Z',
      code: '123456',
    })
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
    render(<ToastProvider><AdminPage /></ToastProvider>)

    await user.click(await screen.findByRole('button', { name: 'Verify and generate' }))
    await screen.findByRole('dialog', { name: 'Copy this code now' })
    expect(mocks.createCode).toHaveBeenCalledWith('grant-1', {kind:'registration',ttlSeconds:86400})
    await user.click(screen.getByRole('button', { name: 'Done' }))

    const existingRow = screen.getByText('Registration code 02').closest('[role="listitem"]')
    expect(existingRow).not.toBeNull()
    await user.click(within(existingRow as HTMLElement).getByRole('button', { name: 'Revoke' }))
    await user.click(screen.getByRole('button', { name: 'Verify and revoke' }))
    await waitFor(() => expect(mocks.revokeInvitation).toHaveBeenCalledWith('grant-2', 'inv_existing'))

    await user.click(screen.getByRole('tab', { name: 'People' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Target User' }), 'admin')
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

  it('leaves administration state unchanged when passkey verification is cancelled', async () => {
    mocks.authorizationBegin.mockRejectedValueOnce(new DOMException('Cancelled', 'NotAllowedError'))
    const user = userEvent.setup()
    render(<ToastProvider><AdminPage /></ToastProvider>)

    await user.click(await screen.findByRole('button', { name: 'Verify and generate' }))
    expect(await screen.findByText('Code could not be created')).toBeInTheDocument()
    expect(mocks.createCode).not.toHaveBeenCalled()
    expect(screen.getByText('Registration code 01')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Copy this code now' })).not.toBeInTheDocument()
  })

  it('filters invitation history without displaying internal invitation identifiers', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><AdminPage /></ToastProvider>)

    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Access overview')).not.toBeInTheDocument()
    expect(await screen.findByText('Registration code 01')).toBeInTheDocument()
    expect(screen.queryByText('inv_existing')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter invitations' }), 'used')
    expect(screen.getByText('No invitations in this view')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter invitations' }), 'active')
    expect(screen.getByText('Registration code 01')).toBeInTheDocument()
  })
})
