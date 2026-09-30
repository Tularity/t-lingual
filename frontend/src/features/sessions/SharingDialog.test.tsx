import { render, screen, waitFor, within } from '@testing-library/react'
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
vi.mock('../../api/client', () => ({ api: {
  sharing: { ...mocks, personAvatarUrl: () => '/person.png' },
  account: { avatarUrl: () => '/avatar.png' },
} }))
vi.mock('../../app/auth', () => ({ useOptionalAuth: () => ({ user: { id: 'usr_owner', username: 'owner', displayName: 'Olive Owner', role: 'user', status: 'active', createdAt: '', updatedAt: '' } }) }))

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const link: SessionShare = {
  id: 'share_link', sessionId: 'session_one', type: 'link', audience: 'members', permission: 'record', token: 'SECRET_LINK_TOKEN',
  createdAt: '2026-09-01T00:00:00Z', expiresAt: null, revokedAt: null, members: [],
}
const row = (name: string) => screen.findByText(name, { selector: '.share-access__text strong' })

describe('owner sharing dialog', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.list.mockResolvedValue([])
    mocks.create.mockImplementation(async (_id: string, input: ShareInput) => ({
      ...link, type: input.type, audience: input.audience, userId: input.userId, displayName: input.type === 'user' ? 'Sam Listener' : undefined,
      permission: input.permission, expiresAt: input.expiresAt, token: input.type === 'link' ? link.token : undefined,
    }))
    mocks.update.mockImplementation(async (_id: string, _shareId: string, input: Pick<ShareInput, 'permission' | 'expiresAt'>) => ({ ...link, ...input }))
    mocks.revoke.mockResolvedValue(undefined)
    mocks.recipients.mockResolvedValue([])
  })

  afterEach(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('reads who has access only while open, and keeps its place in the page while closed', async () => {
    const { rerender } = render(<ToastProvider><SharingDialog sessionId="session_one" open={false} onClose={vi.fn()} /></ToastProvider>)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<ToastProvider><SharingDialog sessionId="session_one" open onClose={vi.fn()} /></ToastProvider>)
    expect(await screen.findByText('Nobody else has access yet.')).toBeInTheDocument()
    expect(mocks.list).toHaveBeenCalledWith('session_one')
    expect(await row('Olive Owner')).toBeInTheDocument()
  })

  it('makes a link for signed-in people, copies it, changes it and turns it off', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ToastProvider><SharingDialog sessionId="session_one" open onClose={vi.fn()} /></ToastProvider>)

    await screen.findByText('Nobody else has access yet.')
    expect(screen.getByRole('radio', { name: /^Anyone with the link/u })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /^Signed-in people with the link/u }))
    await choose(user, 'Access', 'Can record')
    await choose(user, 'Ends', 'No end date')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('session_one', {
      type: 'link', audience: 'members', permission: 'record', expiresAt: null,
    }))
    expect(await row('Signed-in people with the link')).toBeInTheDocument()
    expect(screen.getByText('Nobody has joined yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share#SECRET_LINK_TOKEN`)

    const more = () => user.click(screen.getByRole('button', { name: 'Change sharing for Signed-in people with the link' }))
    await more()
    await user.click(await screen.findByRole('menuitemradio', { name: 'Read only' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('session_one', 'share_link', { permission: 'view', expiresAt: null }))
    await more()
    await user.click(await screen.findByRole('menuitem', { name: 'In 1 hour' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
    const expiry = mocks.update.mock.calls[1]?.[2]?.expiresAt as string
    expect(new Date(expiry).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(expiry).getTime()).toBeLessThan(Date.now() + 3_660_000)

    await more()
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off link' }))
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('session_one', 'share_link'))
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Show ended (1)' }))
    expect(screen.getByText(/Turned off/u)).toBeInTheDocument()
  })

  it('finds only people without access yet, and gives one of them read-only access', async () => {
    const user = userEvent.setup()
    mocks.list.mockResolvedValue([{ ...link, id: 'share_ada', type: 'user', audience: undefined, token: undefined, members: undefined, userId: 'usr_ada', displayName: 'Ada Already' }])
    mocks.recipients.mockResolvedValue([{ id: 'usr_ada', username: 'ada', displayName: 'Ada Already' }, { id: 'usr_sam', username: 'sam', displayName: 'Sam Listener' }])
    render(<ToastProvider><SharingDialog sessionId="session_one" open onClose={vi.fn()} /></ToastProvider>)

    expect(await row('Ada Already')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /^Specific people/u }))
    expect(screen.getByRole('button', { name: 'Give access' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Find a person' }), 'a')
    await waitFor(() => expect(mocks.recipients).toHaveBeenCalledWith('a'))
    const results = await screen.findByRole('group', { name: 'Matching people' })
    expect(within(results).queryByRole('button', { name: /Ada Already/u })).not.toBeInTheDocument()
    await user.click(await within(results).findByRole('button', { name: /Sam Listener/u }))
    await user.click(screen.getByRole('button', { name: 'Give access' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('session_one', expect.objectContaining({
      type: 'user', userId: 'usr_sam', permission: 'view',
    })))
    expect(await row('Sam Listener')).toBeInTheDocument()
  })

  it('shows who has joined a link for signed-in people', async () => {
    mocks.list.mockResolvedValue([{ ...link, members: [{ id: 'usr_a', username: 'a', displayName: 'Ann' }, { id: 'usr_b', username: 'b', displayName: 'Ben' }] }])
    render(<ToastProvider><SharingDialog sessionId="session_one" open onClose={vi.fn()} /></ToastProvider>)
    expect(await screen.findByText('2 people joined')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Ann' })).toBeInTheDocument()
  })
})
