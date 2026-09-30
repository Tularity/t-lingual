import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import { AdminDataProvider } from './AdminData'
import { PeoplePage } from './PeoplePage'

const mocks = vi.hoisted(() => ({
  authorizationBegin: vi.fn(),
  authorizationFinish: vi.fn(),
  users: vi.fn(),
  audit: vi.fn(),
  updateUser: vi.fn(),
  userDetail: vi.fn(),
  setUserLimits: vi.fn(),
  updateUserProfile: vi.fn(),
  updateUserSettings: vi.fn(),
  deleteUser: vi.fn(),
  getPasskey: vi.fn(),
}))

const now = '2026-09-01T00:00:00Z'
const currentUser = { id: 'admin_1', username: 'admin', displayName: 'Administrator', role: 'admin' as const, status: 'active' as const, createdAt: now, updatedAt: now }
const targetUser = { id: 'user_1', username: 'listener', displayName: 'Target User', role: 'user' as const, status: 'active' as const, discoverable: true, createdAt: now, updatedAt: now }
const defaults = { concurrentRecordings: 1, monthlyRecordingMinutes: 0, storageMb: 0, workspaces: 100, guestLinks: true }
const none = { concurrentRecordings: null, monthlyRecordingMinutes: null, storageMb: null, workspaces: null, guestLinks: null }
const settings = { defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false, showPartialTranscripts: true, compactTranscriptLayout: false, autoArchiveHours: 24 }

vi.mock('../../api/client', () => ({
  api: {
    mode: 'mock',
    passkeys: { authorizationBegin: mocks.authorizationBegin, authorizationFinish: mocks.authorizationFinish },
    admin: {
      users: mocks.users, audit: mocks.audit, updateUser: mocks.updateUser, userDetail: mocks.userDetail,
      setUserLimits: mocks.setUserLimits, updateUserProfile: mocks.updateUserProfile, updateUserSettings: mocks.updateUserSettings,
      deleteUser: mocks.deleteUser,
    },
  },
}))
vi.mock('../../api/webauthn', () => ({ getPasskey: mocks.getPasskey }))
vi.mock('../../app/auth', () => ({ useAuth: () => ({ user: currentUser }) }))

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function openTarget() {
  const user = userEvent.setup()
  render(<ToastProvider><AdminDataProvider userId={currentUser.id}><PeoplePage /></AdminDataProvider></ToastProvider>)
  await user.click(await screen.findByRole('button', { name: 'Open Target User' }))
  const drawer = await screen.findByRole('dialog')
  await within(drawer).findByText('This month')
  return { user, drawer }
}

describe('an administrator opening someone in the people list', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    localStorage.clear()
    mocks.authorizationBegin.mockResolvedValue({ ceremonyToken: 'ceremony', expiresAt: 'soon', options: { publicKey: {} } })
    mocks.authorizationFinish.mockImplementation(async () => ({ authorizationToken: `grant-${mocks.authorizationFinish.mock.calls.length}`, expiresAt: 'soon' }))
    mocks.getPasskey.mockResolvedValue({ id: 'credential', type: 'public-key', response: {} })
    mocks.users.mockResolvedValue([currentUser, targetUser])
    mocks.audit.mockResolvedValue([])
    mocks.userDetail.mockResolvedValue({ user: targetUser, limits: { effective: defaults, overrides: none, defaults }, settings,
      standing: { monthRecordedSeconds: 600, storageBytes: 1 << 20, activeRecordings: 0, sessions: 3, workspaces: 1, lastSeen: now } })
    mocks.setUserLimits.mockImplementation(async (_token: string, _id: string, body: string) => ({ effective: { ...defaults, ...Object.fromEntries(Object.entries(JSON.parse(body)).filter(([, value]) => value !== null)) }, overrides: JSON.parse(body), defaults }))
    mocks.updateUserProfile.mockImplementation(async (_token: string, _id: string, body: string) => ({ ...targetUser, ...JSON.parse(body) }))
  })

  it('sets a limit with a passkey scoped to exactly the body it sends', async () => {
    const { user, drawer } = await openTarget()
    await user.click(within(drawer).getByRole('tab', { name: 'Limits' }))
    await user.type(within(drawer).getByRole('spinbutton', { name: 'Recordings at once' }), '3')
    await user.click(within(drawer).getByRole('button', { name: 'Verify and save' }))
    await waitFor(() => expect(mocks.setUserLimits).toHaveBeenCalledTimes(1))
    const [token, id, body] = mocks.setUserLimits.mock.calls[0]!
    expect([token, id]).toEqual(['grant-1', 'user_1'])
    expect(JSON.parse(body)).toEqual({ ...none, concurrentRecordings: 3 })
    expect(mocks.authorizationBegin).toHaveBeenCalledWith(`admin:user:limits:user_1:${await sha256(body)}`)
  })

  it('refuses a limit outside its range without asking for a passkey', async () => {
    const { user, drawer } = await openTarget()
    await user.click(within(drawer).getByRole('tab', { name: 'Limits' }))
    await user.type(within(drawer).getByRole('spinbutton', { name: 'Recordings at once' }), '40')
    await user.click(within(drawer).getByRole('button', { name: 'Verify and save' }))
    expect(await within(drawer).findByText('Use a whole number from 1 to 16.')).toBeInTheDocument()
    expect(mocks.authorizationBegin).not.toHaveBeenCalled()
    expect(mocks.setUserLimits).not.toHaveBeenCalled()
  })

  it('changes only the profile fields that were edited', async () => {
    const { user, drawer } = await openTarget()
    await user.click(within(drawer).getByRole('tab', { name: 'Profile' }))
    const name = within(drawer).getByRole('textbox', { name: 'Display name' })
    await user.clear(name)
    await user.type(name, 'Renamed Person')
    await user.click(within(drawer).getByRole('button', { name: 'Verify and save' }))
    await waitFor(() => expect(mocks.updateUserProfile).toHaveBeenCalledTimes(1))
    const body = mocks.updateUserProfile.mock.calls[0]![2]
    expect(JSON.parse(body)).toEqual({ displayName: 'Renamed Person' })
    expect(mocks.authorizationBegin).toHaveBeenCalledWith(`admin:user:profile:user_1:${await sha256(body)}`)
    expect(await within(drawer).findByRole('heading', { name: 'Renamed Person' })).toBeInTheDocument()
  })

  it('deletes an account only once its username is typed, with a passkey for that account', async () => {
    mocks.deleteUser.mockResolvedValue(undefined)
    const { user, drawer } = await openTarget()
    await user.click(within(drawer).getByRole('button', { name: 'Delete account' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Target User’s account?' })
    expect(within(dialog).getByText('3 sessions, with their recordings, transcripts and translations')).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Verify and delete' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Type listener to confirm' }), 'listen')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Type listener to confirm' }), 'er')
    await user.click(confirm)
    await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledWith('grant-1', 'user_1'))
    expect(mocks.authorizationBegin).toHaveBeenCalledWith('admin:user:delete:user_1')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Target User' })).not.toBeInTheDocument())
  })

  it('offers no deletion of one’s own account', async () => {
    const user = userEvent.setup()
    mocks.userDetail.mockResolvedValue({ user: currentUser, limits: { effective: defaults, overrides: none, defaults }, settings,
      standing: { monthRecordedSeconds: 0, storageBytes: 0, activeRecordings: 0, sessions: 0, workspaces: 1, lastSeen: now } })
    render(<ToastProvider><AdminDataProvider userId={currentUser.id}><PeoplePage /></AdminDataProvider></ToastProvider>)
    await user.click(await screen.findByRole('button', { name: 'Open Administrator' }))
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('This month')
    expect(within(drawer).queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument()
  })

  it('opens from anywhere on a row but not from the row’s own controls', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><AdminDataProvider userId={currentUser.id}><PeoplePage /></AdminDataProvider></ToastProvider>)
    const row = (await screen.findByRole('button', { name: 'Open Target User' })).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('switch', { name: 'Account access for Target User' }))
    expect(screen.getByRole('dialog', { name: 'Disable this account?' })).toBeInTheDocument()
    expect(mocks.userDetail).not.toHaveBeenCalled()
  })
})
