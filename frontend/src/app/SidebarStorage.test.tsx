import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { AccountStorage } from '../api/contracts'
import { SidebarStorage } from './SidebarStorage'
import { AccountStorageProvider } from './accountStorage'
import { notifyStorageChanged } from './storageEvents'

const mocks = vi.hoisted(() => ({ storage: vi.fn() }))
vi.mock('../api/client', () => ({ api: { usage: { storage: mocks.storage } } }))
vi.mock('./router', () => ({ Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }))

const GB = 1024 ** 3
function storage(fields: Partial<AccountStorage> = {}): AccountStorage {
  return { usedBytes: 3 * GB, audioBytes: 3 * GB - 5_000_000, transcriptBytes: 5_000_000, limitBytes: 10 * GB, availableBytes: 7 * GB,
    sessions: 12, archivedSessions: 2, sessionsWithAudio: 9, workspaces: 3, workspaceLimit: 100, ...fields }
}

describe('the storage in the sidebar', () => {
  beforeEach(() => { mocks.storage.mockReset() })

  it('shows what is used against the limit and what is left, and what it holds on hover', async () => {
    mocks.storage.mockResolvedValue(storage())
    const user = userEvent.setup()
    render(<AccountStorageProvider userId="usr_1"><SidebarStorage /></AccountStorageProvider>)
    const link = await screen.findByRole('link', { name: /Storage: 3 GB of 10 GB\. 7 GB left/u })
    expect(link).toHaveAttribute('href', '/usage')
    expect(screen.getByRole('meter', { name: 'Storage' })).toHaveAttribute('aria-valuemax', String(10 * GB))
    await user.hover(link)
    const card = await screen.findByRole('tooltip')
    expect(card).toHaveTextContent('12 (2 archived)')
    expect(card).toHaveTextContent('Sessions with recordings9')
    expect(card).toHaveTextContent('3 of 100')
  })

  it('without a limit, measures against what the disk has free', async () => {
    mocks.storage.mockResolvedValue(storage({ limitBytes: 0, availableBytes: 97 * GB }))
    render(<AccountStorageProvider userId="usr_1"><SidebarStorage /></AccountStorageProvider>)
    expect(await screen.findByRole('link', { name: /Storage: 3 GB used\. 97 GB left/u })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Storage' })).toHaveAttribute('aria-valuemax', String(100 * GB))
  })

  it('says when it is full, since new recordings can’t start', async () => {
    mocks.storage.mockResolvedValue(storage({ usedBytes: 11 * GB, availableBytes: 0 }))
    render(<AccountStorageProvider userId="usr_1"><SidebarStorage /></AccountStorageProvider>)
    expect(await screen.findByRole('link', { name: /Full: new recordings can’t start/u })).toHaveTextContent('Full')
  })

  it('reads again when something changed what the account stores, and shows nothing it could not read', async () => {
    mocks.storage.mockRejectedValueOnce(new Error('offline'))
    const { container } = render(<AccountStorageProvider userId="usr_1"><SidebarStorage /></AccountStorageProvider>)
    await waitFor(() => expect(mocks.storage).toHaveBeenCalledTimes(1))
    expect(container).toBeEmptyDOMElement()
    mocks.storage.mockResolvedValue(storage({ usedBytes: 4 * GB, availableBytes: 6 * GB }))
    act(() => notifyStorageChanged())
    expect(await screen.findByRole('link', { name: /4 GB of 10 GB/u })).toBeInTheDocument()
  })
})
