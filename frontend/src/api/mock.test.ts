import type { SerializedCredential } from './contracts'

const credential: SerializedCredential = { id: 'demo', rawId: 'ZGVtbw', type: 'public-key', authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'ZGVtbw' } }

async function freshApi() {
  vi.resetModules()
  const { MockApi } = await import('./mock')
  return new MockApi()
}

async function tick<T>(promise: Promise<T>) {
  const settled = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
  await vi.advanceTimersByTimeAsync(300)
  const result = await settled
  if (!result.ok) throw result.error
  return result.value
}

async function login(api: Awaited<ReturnType<typeof freshApi>>) {
  const begin = await tick(api.auth.loginBegin())
  return tick(api.auth.loginFinish(begin.ceremonyToken, credential))
}

async function grant(api: Awaited<ReturnType<typeof freshApi>>, scope: string) {
  const begin = await tick(api.passkeys.authorizationBegin(scope))
  return (await tick(api.passkeys.authorizationFinish(begin.ceremonyToken, credential))).authorizationToken
}

describe('explicit development API', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('persists a workspace, settings and transcript after module reload', async () => {
    const api = await freshApi()
    await login(api)
    const session = await tick(api.sessions.create({ title: 'Interview', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }))
    const settings = await tick(api.settings.get())
    await tick(api.settings.update({ ...settings, compactTranscriptLayout: true }))
    api.startDevelopmentLive(session.id)
    api.saveDevelopmentSegment({ id: 'demo-segment', sessionId: session.id, sequence: 1, sourceText: 'Hello', translation: '你好', translationStatus: 'succeeded', final: true, startMs: 0, endMs: 900, createdAt: new Date().toISOString() })
    api.finishDevelopmentLive(session.id)

    const reloaded = await freshApi()
    expect((await tick(reloaded.sessions.get(session.id))).session).toMatchObject({ status: 'completed', startedAt: expect.any(String), endedAt: expect.any(String) })
    expect((await tick(reloaded.sessions.segments(session.id))).items).toMatchObject([{ sourceText: 'Hello', translation: '你好' }])
    expect((await tick(reloaded.settings.get())).compactTranscriptLayout).toBe(true)
  })

  it('requires a real unused invitation and isolates the registered workspace', async () => {
    const api = await freshApi()
    await login(api)
    const administratorSessions = await tick(api.sessions.list())
    const token = await grant(api, 'admin:invitation:create:24')
    const created = await tick(api.admin.createInvitation(token, { expiresInHours: 24 }))
    const staleGrant = await grant(api, 'passkey_management')
    await tick(api.auth.logout())
    await expect(tick(api.auth.registrationBegin({ invitationCode: '123456', username: 'newuser', displayName: 'New User' }))).rejects.toThrow('invalid')
    const begin = await tick(api.auth.registrationBegin({ invitationCode: created.code, username: 'newuser', displayName: 'New User' }))
    const registered = await tick(api.auth.registrationFinish(begin.ceremonyToken, credential))
    expect(registered.user.role).toBe('user')
    expect((await tick(api.sessions.list())).items).toHaveLength(0)
    await expect(tick(api.sessions.get(administratorSessions.items[0]!.id))).rejects.toThrow('not found')
    await expect(tick(api.admin.users())).rejects.toThrow('Administrator')
    await expect(tick(api.passkeys.registrationBegin(staleGrant, { name: 'Other user key' }))).rejects.toThrow('scoped')
    await expect(tick(api.auth.registrationBegin({ invitationCode: created.code, username: 'another', displayName: 'Another' }))).rejects.toThrow('used')
    expect(window.localStorage.getItem('t-lingual:development-data:v5')).not.toContain(created.code)
  })

  it('keeps administrative changes and single-use grants across refresh', async () => {
    const api = await freshApi()
    await login(api)
    const token = await grant(api, 'admin:user:update:usr_2:admin:-')
    await tick(api.admin.updateUser(token, 'usr_2', { role: 'admin' }))
    await expect(tick(api.admin.updateUser(token, 'usr_2', { role: 'admin' }))).rejects.toThrow('already used')
    const reloaded = await freshApi()
    expect((await tick(reloaded.admin.users())).find((user) => user.id === 'usr_2')?.role).toBe('admin')
    expect((await tick(reloaded.admin.audit())).at(0)?.action).toBe('user.role.set')
  })

  it('sets limits only with a grant for exactly that change, and keeps them across refresh', async () => {
    const { adminChange } = await import('../app/adminChanges')
    const api = await freshApi()
    await login(api)
    const change = await adminChange('limits', 'usr_2', { concurrentRecordings: 2, monthlyRecordingMinutes: null, storageMb: null, workspaces: null, guestLinks: false })
    const other = await adminChange('limits', 'usr_2', { concurrentRecordings: 9, monthlyRecordingMinutes: null, storageMb: null, workspaces: null, guestLinks: false })
    await expect(tick(api.admin.setUserLimits(await grant(api, other.scope), 'usr_2', change.body))).rejects.toThrow('scoped to another action')
    const limits = await tick(api.admin.setUserLimits(await grant(api, change.scope), 'usr_2', change.body))
    expect(limits.effective).toMatchObject({ concurrentRecordings: 2, guestLinks: false, workspaces: 100 })
    const reloaded = await freshApi()
    expect((await tick(reloaded.admin.userDetail('usr_2'))).limits.overrides).toMatchObject({ concurrentRecordings: 2, guestLinks: false, storageMb: null })
    expect((await tick(reloaded.admin.audit())).at(0)?.action).toBe('user.limits.set')
  })

  it('changes the defaults every account without its own limits follows', async () => {
    const { defaultLimitsChange } = await import('../app/adminChanges')
    const api = await freshApi()
    await login(api)
    const change = await defaultLimitsChange({ concurrentRecordings: 2, monthlyRecordingMinutes: 300, storageMb: 0, workspaces: 10, guestLinks: false })
    await tick(api.admin.setDefaultLimits(await grant(api, change.scope), change.body))
    const reloaded = await freshApi()
    const detail = await tick(reloaded.admin.userDetail('usr_2'))
    expect(detail.limits.defaults).toMatchObject({ concurrentRecordings: 2, workspaces: 10, guestLinks: false })
    expect(detail.limits.effective).toMatchObject({ concurrentRecordings: 2, monthlyRecordingMinutes: 300 })
    expect((await tick(reloaded.admin.defaultLimits())).builtIn.concurrentRecordings).toBe(1)
  })

  it('takes a passkey or a browser away from someone only with a grant for that one', async () => {
    const { adminRemovalScope } = await import('../app/adminChanges')
    const api = await freshApi()
    await login(api)
    const security = await tick(api.admin.userSecurity('usr_2'))
    expect(security.passkeys.length).toBeGreaterThan(0)
    expect(security.sessions.length).toBeGreaterThan(0)
    const [browser] = security.sessions
    await expect(tick(api.admin.revokeUserSession(await grant(api, await adminRemovalScope('session', 'usr_2', 'browser_other')), 'usr_2', browser!.id))).rejects.toThrow('scoped to another action')
    await tick(api.admin.revokeUserSession(await grant(api, await adminRemovalScope('session', 'usr_2', browser!.id)), 'usr_2', browser!.id))
    const [passkey] = security.passkeys
    await tick(api.admin.deleteUserPasskey(await grant(api, await adminRemovalScope('passkey', 'usr_2', passkey!.id)), 'usr_2', passkey!.id))
    const after = await tick(api.admin.userSecurity('usr_2'))
    expect(after.passkeys.map((key) => key.id)).not.toContain(passkey!.id)
    expect(after.sessions).toEqual([])
    expect((await tick(api.admin.audit())).slice(0, 2).map((event) => event.action)).toEqual(['user.passkey.delete', 'user.session.revoke'])
  })

  it('reports the account’s storage against its limit', async () => {
    const { adminChange } = await import('../app/adminChanges')
    const api = await freshApi()
    const identity = await login(api)
    const open = await tick(api.usage.storage())
    expect(open.limitBytes).toBe(0)
    expect(open.usedBytes).toBe(open.audioBytes + open.transcriptBytes)
    expect(open.sessions).toBeGreaterThan(0)
    const change = await adminChange('limits', identity.user.id, { concurrentRecordings: null, monthlyRecordingMinutes: null, storageMb: 1024, workspaces: null, guestLinks: null })
    await tick(api.admin.setUserLimits(await grant(api, change.scope), identity.user.id, change.body))
    const limited = await tick(api.usage.storage())
    expect(limited.limitBytes).toBe(1024 * 1024 * 1024)
    expect(limited.availableBytes).toBe(Math.max(0, limited.limitBytes - limited.usedBytes))
  })

  it('makes no new session and records nothing of an account whose storage is full', async () => {
    const { adminChange } = await import('../app/adminChanges')
    const api = await freshApi()
    const identity = await login(api)
    const [owned] = (await tick(api.sessions.list({ limit: 1 }))).items
    expect((await tick(api.sessions.recordingAdmission(owned!.id))).allowed).toBe(true)
    const change = await adminChange('limits', identity.user.id, { concurrentRecordings: null, monthlyRecordingMinutes: null, storageMb: 1, workspaces: null, guestLinks: null })
    await tick(api.admin.setUserLimits(await grant(api, change.scope), identity.user.id, change.body))
    expect(await tick(api.sessions.recordingAdmission(owned!.id))).toEqual({ allowed: false, reason: 'storage_full' })
    await expect(tick(api.sessions.create({ title: 'One more', sourceLanguage: 'en', targetLanguage: 'fr' }))).rejects.toThrow('Your storage is full')
  })

  it('deletes an account with its sessions only with a grant for that account, never one’s own', async () => {
    const api = await freshApi()
    const identity = await login(api)
    await expect(tick(api.admin.deleteUser(await grant(api, `admin:user:delete:${identity.user.id}`), identity.user.id))).rejects.toThrow('own account')
    await expect(tick(api.admin.deleteUser(await grant(api, 'admin:user:delete:usr_3'), 'usr_2'))).rejects.toThrow('scoped to another action')
    await tick(api.admin.deleteUser(await grant(api, 'admin:user:delete:usr_2'), 'usr_2'))
    const reloaded = await freshApi()
    expect((await tick(reloaded.admin.users())).some((user) => user.id === 'usr_2')).toBe(false)
    expect((await tick(reloaded.admin.audit())).at(0)?.action).toBe('user.delete')
  })

  it('reports usage for the period asked, one’s own or everyone’s', async () => {
    const api = await freshApi()
    await login(api)
    const mine = await tick(api.usage.mine({ days: 7, offset: 480 }))
    expect(mine.report.days).toHaveLength(7)
    expect(mine.report.users).toBeUndefined()
    const site = await tick(api.admin.usage({ days: 30, offset: 480 }))
    expect(site.report.days).toHaveLength(30)
    expect(site.report.users?.length).toBeGreaterThan(1)
    const person = await tick(api.admin.usage({ days: 30, offset: 480, user: 'usr_2' }))
    expect(person.user?.id).toBe('usr_2')
    expect(person.limits?.concurrentRecordings).toBe(1)
  })

  it('ships a lived-in transcript archive and settles translations interrupted by stop', async () => {
    const api = await freshApi()
    await login(api)
    const sessions = (await tick(api.sessions.list())).items
    expect(sessions.length).toBeGreaterThanOrEqual(10)
    const lengths = await Promise.all(sessions.map((session) => tick(api.sessions.segments(session.id)).then((page) => page.items.length)))
    expect(lengths.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(30)
    const created = await tick(api.sessions.create({ title: 'Stop test', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }))
    api.startDevelopmentLive(created.id)
    api.saveDevelopmentSegment({ id: 'pending', sessionId: created.id, sequence: 1, sourceText: 'Hello', translation: '', translationStatus: 'pending', final: true, startMs: 0, endMs: 900, createdAt: new Date().toISOString() })
    api.finishDevelopmentLive(created.id)
    expect((await tick(api.sessions.get(created.id))).segments[0]).toMatchObject({ translationStatus: 'failed', translationError: expect.stringContaining('paused') })
  })

  it('degrades to in-memory demo state when browser storage writes are blocked', async () => {
    const api = await freshApi()
    await login(api)
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage disabled', 'SecurityError') })
    try {
      const created = await tick(api.sessions.create({ title: 'Private browsing', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }))
      expect((await tick(api.sessions.get(created.id))).session.title).toBe('Private browsing')
    } finally { blocked.mockRestore() }
  })
  it('resumes stopped sessions and only archive blocks new recordings', async () => {
    const api = await freshApi(); await login(api)
    const session = await tick(api.sessions.create({ title: 'Persistent conversation', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }))
    api.startDevelopmentLive(session.id)
    api.saveDevelopmentSegment({ id: 'earlier', sessionId: session.id, sequence: 1, sourceText: 'Keep this', translation: '保留', translationStatus: 'succeeded', final: true, startMs: 0, endMs: 2500, createdAt: new Date().toISOString() })
    api.finishDevelopmentLive(session.id)
    await vi.advanceTimersByTimeAsync(3_600_000)
    api.startDevelopmentLive(session.id)
    expect(api.nextDevelopmentSequence(session.id)).toBe(2)
    expect(api.developmentPosition(session.id)).toBe(2500)
    await expect(tick(api.sessions.archive(session.id))).rejects.toThrow('Stop recording')
    api.finishDevelopmentLive(session.id)
    expect((await tick(api.sessions.archive(session.id))).archivedAt).toBeTruthy()
    expect(() => api.startDevelopmentLive(session.id)).toThrow('Unarchive')
    await expect(tick(api.sessions.update(session.id, { title: 'Changed', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }))).rejects.toThrow('Unarchive')
    await tick(api.sessions.unarchive(session.id))
    expect(api.startDevelopmentLive(session.id).archivedAt).toBeNull()
    expect((await tick(api.sessions.segments(session.id))).items[0]?.sourceText).toBe('Keep this')
    api.finishDevelopmentLive(session.id)
  })

  it('automatically archives after the user interval and gives unarchived sessions a new interval', async () => {
    const api = await freshApi(); await login(api)
    const preferences = await tick(api.settings.get())
    expect(preferences.autoArchiveHours).toBe(24)
    const session = await tick(api.sessions.create({ title: 'Tomorrow', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }))
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect((await tick(api.sessions.get(session.id))).session).toMatchObject({ archiveReason: 'inactivity', archivedAt: expect.any(String) })
    await tick(api.sessions.unarchive(session.id))
    expect((await tick(api.sessions.get(session.id))).session.archivedAt).toBeNull()
    await tick(api.settings.update({ ...preferences, autoArchiveHours: 0 }))
    await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000)
    expect((await tick(api.sessions.get(session.id))).session.archivedAt).toBeNull()
  })

  it('persists provider settings behind exact one-use step-up without rewriting transcript translations', async () => {
    const api = await freshApi()
    await login(api)
    const candidate = { asrUrl: 'https://asr.example.test', translatorUrl: '' }
    const scopeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(candidate)))
    const scope = `admin:providers:update:${Array.from(new Uint8Array(scopeDigest), byte => byte.toString(16).padStart(2, '0')).join('')}`
    const grantToken = await grant(api, scope)
    expect(await tick(api.admin.updateProviders(grantToken, candidate))).toMatchObject({ ...candidate, asrConfigured: true, translatorConfigured: false })
    await expect(tick(api.admin.updateProviders(grantToken, candidate))).rejects.toThrow('already used')
    const detail = await tick(api.sessions.get('ses_demo_1'))
    const original = detail.segments[0]!.translation
    const access = await tick(api.sessions.language('ses_demo_1', 'fr'))
    expect(access.targetLanguage).toBe('fr')
    expect(original).not.toBe('')
    expect((await tick(api.sessions.get('ses_demo_1'))).segments[0]!.translation).toBe('')
    expect((await tick(api.sessions.get('ses_demo_1'))).session.targetLanguage).toBe('fr')
    expect((await tick(api.sessions.get('ses_demo_1'))).access?.targetLanguage).toBe('fr')
    const reloaded = await freshApi()
    expect(await tick(reloaded.admin.providers())).toMatchObject(candidate)
    expect((await tick(reloaded.sessions.get('ses_demo_1'))).access?.targetLanguage).toBe('fr')
  })

})
