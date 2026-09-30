import type { Invitation } from '../../api/contracts'
import { invitationStatus, numberCodes, summarizeAuditMetadata } from './adminModel'

describe('audit metadata summary', () => {
  it('shows only bounded primitive fields and never serializes nested structures', () => {
    const summary = summarizeAuditMetadata({ status: 'disabled', nested: { secret: '<script>' }, 'unsafe key<>': true, fourth: 'hidden' })
    expect(summary).toBe('status: disabled · nested: [details] · unsafekey: true')
    expect(summary).not.toContain('<script>')
    expect(summary).not.toContain('fourth')
  })

  it('ignores arrays and non-object metadata', () => {
    expect(summarizeAuditMetadata(['role', 'admin'])).toBe('')
    expect(summarizeAuditMetadata('raw')).toBe('')
  })
})

const code = (id: string, createdAt: string, extra: Partial<Invitation> = {}): Invitation => ({ id, createdAt, createdBy: null, expiresAt: '2026-10-01T00:00:00Z', usedAt: null, usedBy: null, revokedAt: null, ...extra })

describe('access codes', () => {
  it('number in the order they were made, so a new code never renumbers the old ones', () => {
    const older = [code('inv_b', '2026-09-02T00:00:00Z'), code('inv_a', '2026-09-01T00:00:00Z')]
    const numbers = numberCodes(older)
    expect([numbers.get('inv_a'), numbers.get('inv_b')]).toEqual([1, 2])
    const later = numberCodes([code('inv_c', '2026-09-03T00:00:00Z'), ...older])
    expect([later.get('inv_a'), later.get('inv_b'), later.get('inv_c')]).toEqual([1, 2, 3])
  })

  it('say where they stand: revoked and used before expired, scheduled before they start', () => {
    const now = Date.parse('2026-09-20T00:00:00Z')
    expect(invitationStatus(code('a', '2026-09-01T00:00:00Z', { revokedAt: '2026-09-02T00:00:00Z', usedAt: '2026-09-02T00:00:00Z' }), now)).toBe('revoked')
    expect(invitationStatus(code('a', '2026-09-01T00:00:00Z', { usedAt: '2026-09-02T00:00:00Z', expiresAt: '2026-09-03T00:00:00Z' }), now)).toBe('used')
    expect(invitationStatus(code('a', '2026-09-01T00:00:00Z', { expiresAt: '2026-09-03T00:00:00Z' }), now)).toBe('expired')
    expect(invitationStatus(code('a', '2026-09-01T00:00:00Z', { notBefore: '2026-09-21T00:00:00Z' }), now)).toBe('scheduled')
    expect(invitationStatus(code('a', '2026-09-01T00:00:00Z'), now)).toBe('active')
  })
})
