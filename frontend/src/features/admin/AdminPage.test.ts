import { summarizeAuditMetadata } from './AdminPage'

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
