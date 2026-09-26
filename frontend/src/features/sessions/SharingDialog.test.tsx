import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../design-system'
import type { SessionShare, ShareInput } from '../../api/contracts'
import { SharingDialog } from './SharingDialog'

/** Opens the dropdown labelled `label` and picks the option that reads `option`. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${label} `, 'u') }))
  await user.click(await screen.findByRole('menuitemradio', { name: option }))
}

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), revoke: vi.fn(), recipients: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { sharing: mocks } }))

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const link: SessionShare = {
  id: 'share_link', sessionId: 'session_one', type: 'link', permission: 'record', token: 'SECRET_LINK_TOKEN',
  createdAt: '2026-09-01T00:00:00Z', expiresAt: null, revokedAt: null,
}

describe('owner sharing dialog', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.list.mockResolvedValue([])
    mocks.create.mockImplementation(async (_id: string, input: ShareInput) => ({
      ...link, type: input.type, userId: input.userId, displayName: input.type === 'user' ? 'Sam Listener' : undefined,
      permission: input.permission, expiresAt: input.expiresAt, token: input.type === 'link' ? link.token : undefined,
    }))
    mocks.update.mockImplementation(async (_id: string, _shareId: string, input: Pick<ShareInput, 'permission' | 'expiresAt'>) => ({ ...link, ...input }))
    mocks.revoke.mockResolvedValue(undefined)
    mocks.recipients.mockResolvedValue([{ id: 'usr_sam', username: 'sam', displayName: 'Sam Listener' }])
  })

  afterEach(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('creates, copies, edits and revokes a link without exposing its token in a query URL', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ToastProvider><SharingDialog sessionId="session_one" open onClose={vi.fn()} /></ToastProvider>)

    await screen.findByText('Only you have access')
    await choose(user, 'Permission', 'Can record')
    await choose(user, 'Expires', 'Never')
    await user.click(screen.getByRole('button', { name: 'Create share link' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('session_one', {
      type: 'link', permission: 'record', expiresAt: null,
    }))
    expect(await screen.findByText('Anyone with this link')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share#SECRET_LINK_TOKEN`)

    await choose(user, 'Access permission', 'Read only')
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('session_one', 'share_link', { permission: 'view', expiresAt: null }))
    await choose(user, 'Change expiration', '1 hour from now')
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
    const expiry = mocks.update.mock.calls[1]?.[2]?.expiresAt as string
    expect(new Date(expiry).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(expiry).getTime()).toBeLessThan(Date.now() + 3_660_000)

    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('session_one', 'share_link'))
    expect(screen.getByText('Revoked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument()
  })

  it('searches recipients and grants a named user read-only access', async () => {
    const user = userEvent.setup()
    render(<ToastProvider><SharingDialog sessionId="session_one" open onClose={vi.fn()} /></ToastProvider>)

    await screen.findByText('Only you have access')
    await choose(user, 'Share with', 'A workspace user')
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Find a user' }), 'Sam')
    await waitFor(() => expect(mocks.recipients).toHaveBeenCalledWith('Sam'))
    await user.click(await screen.findByRole('button', { name: /Sam Listener/u }))
    await user.click(screen.getByRole('button', { name: 'Grant access' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('session_one', expect.objectContaining({
      type: 'user', userId: 'usr_sam', permission: 'view',
    })))
    expect(await screen.findByText('Sam Listener', { selector: '.share-row__heading strong' })).toBeInTheDocument()
  })
})
