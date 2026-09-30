import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OperationsReport, UsageReport } from '../../api/contracts'
import { ToastProvider } from '../../design-system'
import { OperationsPage } from './OperationsPage'
import { UsagePage } from './UsagePage'

const mocks = vi.hoisted(() => ({ mine: vi.fn(), operations: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { mode: 'http', usage: { mine: mocks.mine }, admin: { operations: mocks.operations } } }))
vi.mock('../../app/workspaces', () => ({ useWorkspaces: () => ({ items: [{ id: 'ws_1', name: '' }, { id: 'ws_2', name: 'Research' }], name: (item: { name: string }) => item.name || 'My workspace' }) }))
vi.mock('../../app/router', () => ({ Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

function report(fields: Partial<UsageReport> = {}): UsageReport {
  const day = { recordedSeconds: 3_600, speechSeconds: 2_700, sessions: 2, segments: 500, sourceCharacters: 18_000, translations: 600, translationCharacters: 20_000, translationFailures: 3, shares: 1 }
  return {
    from: '2026-09-26', to: '2026-09-27', days: [{ date: '2026-09-26', ...day }, { date: '2026-09-27', ...day }],
    languages: [{ key: 'en', value: 5_400, count: 1_000 }], targets: [{ key: 'fr', value: 40_000, count: 1_200 }],
    workspaces: [{ key: 'ws_1', label: '', value: 7_200, count: 4 }], hours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    topSessions: [{ id: 'ses_1', title: 'Weekly sync', recordedSeconds: 3_600, segments: 400, createdAt: '2026-09-26T08:00:00Z' }],
    speakers: [], audioBytes: 460_800_000, transcriptBytes: 160_000, ...fields,
  }
}

const standing = { monthRecordedSeconds: 7_200, storageBytes: 500 << 20, activeRecordings: 0, sessions: 4, workspaces: 2, lastSeen: null }

describe('the usage page', () => {
  beforeEach(() => { mocks.mine.mockReset() })

  it('totals the period, measures it against the allowance, and reads another period on request', async () => {
    mocks.mine.mockResolvedValue({ report: report(), limits: { concurrentRecordings: 1, monthlyRecordingMinutes: 600, storageMb: 0, workspaces: 100, guestLinks: false }, standing })
    render(<ToastProvider><UsagePage /></ToastProvider>)
    const totals = await screen.findByRole('group', { name: 'Totals for this period' })
    expect(within(totals).getByText('2 h')).toBeInTheDocument()
    expect(within(totals).getByText('6 failed')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Recording this month' })).toHaveAttribute('aria-valuetext', '2 h of 10 h')
    expect(screen.getByText('Not allowed')).toBeInTheDocument()
    // The first workspace is named by the interface until it is renamed.
    expect(within(screen.getByRole('list', { name: 'Workspaces' })).getByText('My workspace')).toBeInTheDocument()
    expect(mocks.mine).toHaveBeenLastCalledWith(expect.objectContaining({ days: 30, workspace: undefined }))
    await userEvent.click(screen.getByRole('radio', { name: '7 days' }))
    await waitFor(() => expect(mocks.mine).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7 })))
  })
})

function operations(fields: Partial<OperationsReport['snapshot']> = {}): OperationsReport {
  const at = '2026-09-27T12:00:00Z'
  return {
    snapshot: {
      sampledAt: at, intervalSeconds: 5,
      asr: { configured: true, reachable: false, error: 'connection refused', at, value: null },
      diagnostics: { configured: true, reachable: false, at, value: null },
      translator: { configured: false, reachable: false, at, value: null },
      gpu: { configured: false, reachable: false, at, value: null },
      activity: { recordings: 1, watchers: 3, rooms: 1 }, history: [], ...fields,
    },
    backlog: { gapsPending: 2, gapsFilling: 0, gapsFailed: 0, translationsRetrying: 5 },
  }
}

describe('the operations page', () => {
  beforeEach(() => { mocks.operations.mockReset() })

  it('says plainly what it cannot read, and what is waiting to be caught up', async () => {
    mocks.operations.mockResolvedValue(operations())
    render(<ToastProvider><OperationsPage /></ToastProvider>)
    const status = await screen.findByRole('group', { name: 'Service status' })
    expect(within(status).getByText('Unreachable')).toBeInTheDocument()
    expect(within(status).getByText('Not set up')).toBeInTheDocument()
    expect(within(status).getByText('2 gaps')).toBeInTheDocument()
    expect(within(status).getByText('5 translations to retry')).toBeInTheDocument()
    expect(screen.getByText('Speech recognition couldn’t be reached: connection refused')).toBeInTheDocument()
    expect(screen.getByText(/nvidia-smi isn’t available/u)).toBeInTheDocument()
  })

  it('stops reading while paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mocks.operations.mockResolvedValue(operations())
      render(<ToastProvider><OperationsPage /></ToastProvider>)
      await screen.findByRole('group', { name: 'Service status' })
      await vi.advanceTimersByTimeAsync(5_100)
      await waitFor(() => expect(mocks.operations).toHaveBeenCalledTimes(2))
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Pause' }))
      const calls = mocks.operations.mock.calls.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.operations).toHaveBeenCalledTimes(calls)
    } finally { vi.useRealTimers() }
  })
})
