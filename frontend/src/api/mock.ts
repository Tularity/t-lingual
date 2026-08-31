import type {
  ApiService,
  AuditEvent,
  AuthSession,
  BrowserSession,
  InterpretationSession,
  Invitation,
  Passkey,
  Segment,
  User,
  UserSettings,
} from './contracts'
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from '../platform/storage'

const wait = (milliseconds = 220) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
/* @__NO_SIDE_EFFECTS__ */
const isoBefore = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const clone = <T,>(value: T): T => structuredClone(value)

const demoUser: User = {
  id: 'usr_demo', username: 'demo', displayName: 'Demo Interpreter', role: 'admin', status: 'active', createdAt: isoBefore(80_000), updatedAt: isoBefore(2),
}

let segmentData: Segment[] = [
  { id: 'seg_1', sessionId: 'ses_demo_1', sequence: 1, sourceText: 'Thank you for joining today. We will begin with a short overview.', translation: '感谢大家今天的参与。我们将先进行简短的概述。', translationStatus: 'succeeded', final: true, startMs: 500, endMs: 6_200, createdAt: isoBefore(1_479) },
  { id: 'seg_2', sessionId: 'ses_demo_1', sequence: 2, sourceText: 'Our goal is to make every conversation immediately understandable.', translation: '我们的目标是让每一次对话都能被即时理解。', translationStatus: 'succeeded', final: true, startMs: 6_600, endMs: 11_800, createdAt: isoBefore(1_478) },
  { id: 'seg_3', sessionId: 'ses_demo_2', sequence: 1, sourceText: 'First, let us walk through the implementation timeline and owners.', translation: '首先，我们来梳理实施时间线和负责人。', translationStatus: 'succeeded', final: true, startMs: 300, endMs: 5_400, createdAt: isoBefore(5_299) },
]

let sessionData: InterpretationSession[] = [
  { id: 'ses_demo_1', title: 'Weekly product sync', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'completed', createdAt: isoBefore(1_480), updatedAt: isoBefore(1_420), startedAt: isoBefore(1_479), endedAt: isoBefore(1_425) },
  { id: 'ses_demo_2', title: 'Customer onboarding — Sydney', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'completed', createdAt: isoBefore(5_300), updatedAt: isoBefore(5_240), startedAt: isoBefore(5_299), endedAt: isoBefore(5_268) },
  { id: 'ses_demo_3', title: 'Research interview 08', sourceLanguage: 'zh-Hans', targetLanguage: 'en', status: 'failed', createdAt: isoBefore(180), updatedAt: isoBefore(4), startedAt: isoBefore(179), endedAt: isoBefore(145) },
  { id: 'ses_demo_4', title: 'Untitled interpretation', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'created', createdAt: isoBefore(22), updatedAt: isoBefore(22), startedAt: null, endedAt: null },
]

let settings: UserSettings = { defaultSourceLanguage: 'en', defaultTargetLanguage: 'zh-Hans', autoStartMicrophone: false, showPartialTranscripts: true, compactTranscriptLayout: false }
let passkeyData: Passkey[] = [
  { id: 'key_1', userId: demoUser.id, name: 'MacBook Touch ID', createdAt: isoBefore(42_000), lastUsedAt: isoBefore(9) },
  { id: 'key_2', userId: demoUser.id, name: 'Security key', createdAt: isoBefore(21_000), lastUsedAt: isoBefore(7_000) },
]
let browserSessionData: BrowserSession[] = [
  { id: 'browser_current', createdAt: isoBefore(180), expiresAt: isoBefore(-1_260), lastSeen: isoBefore(1), userAgent: 'Chrome on macOS', ipAddress: '203.0.113.18', current: true },
  { id: 'browser_phone', createdAt: isoBefore(2_800), expiresAt: isoBefore(-80), lastSeen: isoBefore(34), userAgent: 'Safari on iPhone', ipAddress: '198.51.100.42', current: false },
  { id: 'browser_office', createdAt: isoBefore(7_000), expiresAt: isoBefore(-200), lastSeen: isoBefore(1_240), userAgent: 'Edge on Windows', ipAddress: '192.0.2.64', current: false },
]
let invitationData: Invitation[] = [
  { id: 'inv_1', createdBy: demoUser.id, createdAt: isoBefore(2_900), expiresAt: isoBefore(-1_420), usedAt: null, usedBy: null, revokedAt: null },
  { id: 'inv_2', createdBy: demoUser.id, createdAt: isoBefore(8_000), expiresAt: isoBefore(4_000), usedAt: isoBefore(7_200), usedBy: 'usr_2', revokedAt: null },
]
const userData: User[] = [
  demoUser,
  { id: 'usr_2', username: 'alex', displayName: 'Alex Chen', role: 'user', status: 'active', createdAt: isoBefore(7_200), updatedAt: isoBefore(84) },
  { id: 'usr_3', username: 'marina', displayName: 'Marina Sato', role: 'user', status: 'disabled', createdAt: isoBefore(19_000), updatedAt: isoBefore(12_000) },
]
let auditData: AuditEvent[] = [
  { id: 'aud_1', actorUserId: demoUser.id, action: 'user.status.set', targetType: 'user', targetId: 'usr_3', metadata: { status: 'disabled' }, createdAt: isoBefore(12_000) },
  { id: 'aud_2', actorUserId: demoUser.id, action: 'invitation.create', targetType: 'invitation', targetId: 'inv_1', metadata: { expiresAt: isoBefore(-1_420) }, createdAt: isoBefore(2_900) },
]
function appendAudit(action: string, targetType: string, targetId: string, metadata: unknown) { auditData = [{ id: `aud_${crypto.randomUUID()}`, actorUserId: demoUser.id, action, targetType, targetId, metadata, createdAt: new Date().toISOString() }, ...auditData] }

function mockOptions() {
  return {
    ceremonyToken: crypto.randomUUID(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    options: { publicKey: { challenge: 'dC1saW5ndWFsLW1vY2stY2hhbGxlbmdl', timeout: 60_000, rp: { name: 'T Lingual', id: window.location.hostname }, user: { id: 'dXNyX2RlbW8', name: demoUser.username, displayName: demoUser.displayName }, pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }, { type: 'public-key' as const, alg: -257 }], authenticatorSelection: { residentKey: 'preferred' as const, userVerification: 'required' as const } } },
  }
}
function authSession(): AuthSession { return { user: clone(demoUser), session: { createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } }

export class MockApi implements ApiService {
  readonly mode = 'mock' as const
  private pendingPasskeyName = 'New passkey'
  private readonly pendingAuthorizationScopes = new Map<string, string>()
  private readonly authorizationGrants = new Map<string, string>()
  private consumeAuthorization(token: string, expectedScope: string) {
    const actualScope = this.authorizationGrants.get(token)
    this.authorizationGrants.delete(token)
    if (actualScope !== expectedScope) throw new Error('Passkey authorization is missing, expired, already used, or scoped to another action')
  }
  auth = {
    me: async () => { await wait(120); if (readBrowserStorage('session', 't-lingual:mock-auth') !== 'yes') throw new Error('Not signed in'); return authSession() },
    loginBegin: async () => { await wait(); const result = mockOptions(); return { ceremonyToken: result.ceremonyToken, expiresAt: result.expiresAt, options: { publicKey: { challenge: result.options.publicKey.challenge, timeout: result.options.publicKey.timeout, rpId: result.options.publicKey.rp.id, userVerification: 'required' as const } } } },
    loginFinish: async () => { await wait(); writeBrowserStorage('session', 't-lingual:mock-auth', 'yes'); return authSession() },
    registrationBegin: async (input: { invitationCode: string; username: string; displayName: string }) => { await wait(); if (!/^\d{6}$/u.test(input.invitationCode)) throw new Error('Enter a valid six-digit invitation code.'); const result = mockOptions(); return { ...result, options: { publicKey: { ...result.options.publicKey, user: { ...result.options.publicKey.user, name: input.username, displayName: input.displayName } } } } },
    registrationFinish: async () => { await wait(); writeBrowserStorage('session', 't-lingual:mock-auth', 'yes'); return authSession() },
    logout: async () => { await wait(100); removeBrowserStorage('session', 't-lingual:mock-auth') },
  }
  browserSessions = {
    list: async () => { await wait(); return clone(browserSessionData) },
    revoke: async (id: string, authorizationToken?: string) => {
      await wait()
      const target = browserSessionData.find((session) => session.id === id)
      if (!target) throw new Error('Browser session not found')
      if (!target.current) this.consumeAuthorization(authorizationToken ?? '', 'passkey_management')
      browserSessionData = browserSessionData.filter((session) => session.id !== id)
      if (target.current) removeBrowserStorage('session', 't-lingual:mock-auth')
    },
    revokeOthers: async (authorizationToken: string) => {
      await wait()
      this.consumeAuthorization(authorizationToken, 'passkey_management')
      const revoked = browserSessionData.filter((session) => !session.current).length
      browserSessionData = browserSessionData.filter((session) => session.current)
      return { revoked }
    },
  }
  sessions = {
    list: async (query: Parameters<ApiService['sessions']['list']>[0] = {}) => { await wait(); const offset = query.offset ?? 0; const limit = query.limit ?? 50; const matching = sessionData.filter((item) => !query.status || item.status === query.status); return { items: clone(matching.slice(offset, offset + limit)), offset, limit } },
    create: async (input: Parameters<ApiService['sessions']['create']>[0]) => { await wait(); const now = new Date().toISOString(); const session: InterpretationSession = { id: `int_${crypto.randomUUID()}`, ...input, status: 'created', createdAt: now, updatedAt: now, startedAt: null, endedAt: null }; sessionData = [session, ...sessionData]; return clone(session) },
    get: async (id: string) => { await wait(); const session = sessionData.find((item) => item.id === id); if (!session) throw new Error('Session not found'); const segments = clone(segmentData.filter((segment) => segment.sessionId === id).slice(0, 50)); return { session: clone(session), segments, segmentPage: { nextAfter: segments.at(-1)?.sequence ?? 0, hasMore: false, limit: 50 } } },
    update: async (id: string, input: Parameters<ApiService['sessions']['update']>[1]) => { await wait(); const session = sessionData.find((item) => item.id === id); if (!session) throw new Error('Session not found'); Object.assign(session, input, { updatedAt: new Date().toISOString() }); return clone(session) },
    remove: async (id: string) => { await wait(); sessionData = sessionData.filter((item) => item.id !== id); segmentData = segmentData.filter((item) => item.sessionId !== id) },
    segments: async (id: string, query: { after?: number; limit?: number } = {}) => { await wait(); const limit = query.limit ?? 100; const matching = segmentData.filter((segment) => segment.sessionId === id && segment.sequence > (query.after ?? -1)); const items = clone(matching.slice(0, limit)); return { items, nextAfter: items.at(-1)?.sequence ?? (query.after ?? 0), hasMore: matching.length > items.length, limit } },
  }
  settings = { get: async () => { await wait(); return clone(settings) }, update: async (input: UserSettings) => { await wait(); settings = clone(input); return clone(settings) } }
	passkeys = {
		list: async () => { await wait(); return clone(passkeyData) },
		authorizationBegin: async (scope = 'passkey_management') => { await wait(); const result = mockOptions(); this.pendingAuthorizationScopes.set(result.ceremonyToken, scope); return { ceremonyToken: result.ceremonyToken, expiresAt: result.expiresAt, options: { publicKey: { challenge: result.options.publicKey.challenge, timeout: result.options.publicKey.timeout, rpId: result.options.publicKey.rp.id, userVerification: 'required' as const } } } },
		authorizationFinish: async (ceremonyToken: string) => { await wait(); const scope = this.pendingAuthorizationScopes.get(ceremonyToken); this.pendingAuthorizationScopes.delete(ceremonyToken); if (!scope) throw new Error('Passkey authorization ceremony is missing or expired'); const authorizationToken = crypto.randomUUID(); this.authorizationGrants.set(authorizationToken, scope); return { authorizationToken, expiresAt: new Date(Date.now() + 120_000).toISOString() } },
		registrationBegin: async (authorizationToken: string, input: { name: string }) => { await wait(); this.consumeAuthorization(authorizationToken, 'passkey_management'); this.pendingPasskeyName = input.name; return mockOptions() },
		registrationFinish: async () => { await wait(); const item: Passkey = { id: `key_${crypto.randomUUID()}`, userId: demoUser.id, name: this.pendingPasskeyName, createdAt: new Date().toISOString(), lastUsedAt: null }; passkeyData = [...passkeyData, item]; return clone(item) },
		remove: async (authorizationToken: string, id: string) => { await wait(); this.consumeAuthorization(authorizationToken, 'passkey_management'); passkeyData = passkeyData.filter((key) => key.id !== id); removeBrowserStorage('session', 't-lingual:mock-auth') },
	}
  admin = {
    invitations: async (query: Parameters<ApiService['admin']['invitations']>[0] = {}) => { await wait(); const offset = query.offset ?? 0; return clone(invitationData.slice(offset, offset + (query.limit ?? 50))) },
    createInvitation: async (authorizationToken: string, { expiresInHours }: { expiresInHours: number }) => { await wait(); this.consumeAuthorization(authorizationToken, `admin:invitation:create:${expiresInHours}`); const invitation: Invitation = { id: `inv_${crypto.randomUUID()}`, createdBy: demoUser.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInHours * 3_600_000).toISOString(), usedAt: null, usedBy: null, revokedAt: null }; invitationData = [invitation, ...invitationData]; appendAudit('invitation.create', 'invitation', invitation.id, { expiresAt: invitation.expiresAt }); return { invitation: clone(invitation), code: String(Math.floor(100_000 + Math.random() * 900_000)) } },
    revokeInvitation: async (authorizationToken: string, id: string) => { await wait(); this.consumeAuthorization(authorizationToken, `admin:invitation:revoke:${id}`); const item = invitationData.find((invitation) => invitation.id === id); if (item) item.revokedAt = new Date().toISOString(); appendAudit('invitation.revoke', 'invitation', id, {}) },
    users: async (query: Parameters<ApiService['admin']['users']>[0] = {}) => { await wait(); const offset = query.offset ?? 0; return clone(userData.slice(offset, offset + (query.limit ?? 50))) },
    updateUser: async (authorizationToken: string, id: string, input: Parameters<ApiService['admin']['updateUser']>[2]) => { await wait(); this.consumeAuthorization(authorizationToken, `admin:user:update:${id}:${input.role ?? '-'}:${input.status ?? '-'}`); const item = userData.find((user) => user.id === id); if (!item) throw new Error('User not found'); Object.assign(item, input, { updatedAt: new Date().toISOString() }); if (input.role) appendAudit('user.role.set', 'user', id, { role: input.role }); if (input.status) appendAudit('user.status.set', 'user', id, { status: input.status }); return clone(item) },
    audit: async (query: Parameters<ApiService['admin']['audit']>[0] = {}) => { await wait(); const offset = query.offset ?? 0; return clone(auditData.slice(offset, offset + (query.limit ?? 50))) },
  }
  liveSocketUrl(sessionId: string) { return `ws://mock.invalid/${encodeURIComponent(sessionId)}` }
}
