import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserSession, Passkey } from '../../api/contracts'
import { canRemovePasskey, SecurityPanel } from './SecurityPanel'

const healthy: Passkey = {
  id: 'healthy', userId: 'user', name: 'Healthy key', createdAt: '2026-08-01T00:00:00Z', lastUsedAt: null,
}
const quarantined: Passkey = {
  id: 'quarantined', userId: 'user', name: 'Old cloned key', createdAt: '2026-07-01T00:00:00Z',
  lastUsedAt: '2026-08-02T00:00:00Z', compromisedAt: '2026-08-03T00:00:00Z',
}
const currentSession: BrowserSession = {
  id: 'current', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z',
  lastSeen: '2026-09-01T01:00:00Z', userAgent: 'Chrome on macOS', ipAddress: '203.0.113.8', current: true,
}
const otherSession: BrowserSession = {
  id: 'other', createdAt: '2026-08-31T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z',
  lastSeen: '2026-09-01T00:30:00Z', userAgent: 'Safari on iPhone', ipAddress: '198.51.100.9', current: false,
}

describe('security panel', () => {
  it('protects the final healthy passkey while allowing a quarantined key to be cleaned up', () => {
    expect(canRemovePasskey([healthy, quarantined], healthy)).toBe(false)
    expect(canRemovePasskey([healthy, quarantined], quarantined)).toBe(true)
    expect(canRemovePasskey([{ ...healthy, id: 'second' }, healthy], healthy)).toBe(true)

    render(<SecurityPanel
      passkeys={[healthy, quarantined]}
      browserSessions={[currentSession]}
      keyBusy={false}
      sessionBusyId={null}
      revokeOthersBusy={false}
      onAddPasskey={vi.fn()}
      onRemovePasskey={vi.fn()}
      onRevokeSession={vi.fn().mockResolvedValue(true)}
      onRevokeOthers={vi.fn().mockResolvedValue(true)}
    />)
    expect(screen.getByRole('button', { name: 'Remove Healthy key' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Old cloned key' })).toBeEnabled()
  })

  it('shows session details and confirms step-up protected revocation actions', async () => {
    const user = userEvent.setup()
    const revokeSession = vi.fn().mockResolvedValue(true)
    const revokeOthers = vi.fn().mockResolvedValue(true)
    render(<SecurityPanel
      passkeys={[healthy, { ...healthy, id: 'backup', name: 'Backup key' }]}
      browserSessions={[currentSession, otherSession]}
      keyBusy={false}
      sessionBusyId={null}
      revokeOthersBusy={false}
      onAddPasskey={vi.fn()}
      onRemovePasskey={vi.fn()}
      onRevokeSession={revokeSession}
      onRevokeOthers={revokeOthers}
    />)

    expect(screen.getByText('Chrome on macOS')).toBeInTheDocument()
    expect(screen.getByText('This browser')).toBeInTheDocument()
    expect(screen.getByText('198.51.100.9')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iPhone' }))
    expect(screen.getByText(/stolen session cookie/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify and sign out' }))
    expect(revokeSession).toHaveBeenCalledWith(otherSession)

    await user.click(screen.getByRole('button', { name: 'Sign out other browsers' }))
    expect(screen.getByText(/live interpretation streams/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify and sign out 1' }))
    expect(revokeOthers).toHaveBeenCalledTimes(1)
  })
})
