import type {
  ApiService,
  AuditEvent,
  AuthSession,
  BrowserSession,
  InterpretationSession,
  Invitation,
  Passkey,
  ProviderEndpoints,
  Segment,
  SerializedCredential,
  User,
  UserSettings,
  ViewerAccess,
} from './contracts'
import { siteSettingsScope } from '../app/siteSettings'
import type { SiteSettings } from './contracts'
import { codeCreateScope } from '../app/accessCodes'
import type { RegistrationInput, CodeResult, CreateCodeInput, CreatedCode } from './contracts'
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from '../platform/storage'

const wait = (milliseconds = 220) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
/* @__NO_SIDE_EFFECTS__ */
const isoBefore = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const clone = <T,>(value: T): T => structuredClone(value)
const dataKey = 't-lingual:development-data:v4'
const authKey = 't-lingual:mock-auth'
const seedInvitationDigest = '7c2523c985881fb2c2b4cfbe917eb12c4c4b61e898ad4e7160cfca487ca3c4f3'
const now = () => new Date().toISOString()

async function codeDigest(code: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const demoUser: User = {
  id: 'usr_demo', username: 'demo', displayName: 'Alex Morgan', role: 'admin', status: 'active', createdAt: isoBefore(80_000), updatedAt: isoBefore(2),
}

let segmentData: Segment[] = [
  { id: 'seg_1', sessionId: 'ses_demo_1', sequence: 1, sourceText: 'Thank you for joining today. We will begin with a short overview.', translation: '感谢大家今天的参与。我们将先进行简短的概述。', translationStatus: 'succeeded', final: true, startMs: 500, endMs: 6_200, createdAt: isoBefore(1_479) },
  { id: 'seg_2', sessionId: 'ses_demo_1', sequence: 2, sourceText: 'Our goal is to make every conversation immediately understandable.', translation: '我们的目标是让每一次对话都能被即时理解。', translationStatus: 'succeeded', final: true, startMs: 6_600, endMs: 11_800, createdAt: isoBefore(1_478) },
  { id: 'seg_3', sessionId: 'ses_demo_2', sequence: 1, sourceText: 'First, let us walk through the implementation timeline and owners.', translation: '首先，我们来梳理实施时间线和负责人。', translationStatus: 'succeeded', final: true, startMs: 300, endMs: 5_400, createdAt: isoBefore(5_299) },
  { id: 'seg_4', sessionId: 'ses_demo_1', sequence: 3, sourceText: 'The mobile experience will be ready for the next round of customer testing.', translation: '移动端体验将在下一轮客户测试前准备就绪。', translationStatus: 'succeeded', final: true, startMs: 12_200, endMs: 18_600, createdAt: isoBefore(1_477) },
  { id: 'seg_5', sessionId: 'ses_demo_1', sequence: 4, sourceText: 'We are collecting feedback in both English and Chinese so every team can participate.', translation: '我们同时收集英文和中文反馈，让每个团队都能参与。', translationStatus: 'succeeded', final: true, startMs: 19_000, endMs: 25_500, createdAt: isoBefore(1_476) },
  { id: 'seg_6', sessionId: 'ses_demo_2', sequence: 2, sourceText: 'You will receive an invitation to your private workspace after this call.', translation: '本次通话结束后，您会收到私人工作区的邀请。', translationStatus: 'succeeded', final: true, startMs: 5_800, endMs: 11_700, createdAt: isoBefore(5_298) },
  { id: 'seg_7', sessionId: 'ses_demo_2', sequence: 3, sourceText: 'Each conversation keeps its own transcript, which you can review at any time.', translation: '每段对话都会保留独立的转录，您可以随时查看。', translationStatus: 'succeeded', final: true, startMs: 12_000, endMs: 18_200, createdAt: isoBefore(5_297) },
  { id: 'seg_8', sessionId: 'ses_demo_3', sequence: 1, sourceText: '您能介绍一下团队平时如何记录跨语言的访谈吗？', translation: 'Could you describe how your team usually records interviews across languages?', translationStatus: 'succeeded', final: true, startMs: 400, endMs: 5_800, createdAt: isoBefore(178) },
  { id: 'seg_9', sessionId: 'ses_demo_3', sequence: 2, sourceText: '我们希望整理过程中能保留说话人的原意。', translation: '', translationStatus: 'failed', translationError: 'Translation provider was interrupted.', final: true, startMs: 6_300, endMs: 11_100, createdAt: isoBefore(177) },
]
const extraLines: Array<[string, number, string, string, number]> = [
  ['ses_demo_1', 5, 'The next milestone is a usability review with customers in three regions.', '下一个里程碑是与三个地区的客户进行可用性评审。', 31_000],
  ['ses_demo_1', 6, 'Our research team will compare the findings and share a consolidated report.', '研究团队会对比研究结果，并分享一份综合报告。', 38_000],
  ['ses_demo_1', 7, 'We also need to confirm which languages are most important for the initial release.', '我们还需要确认首发版本最重要的语言。', 45_000],
  ['ses_demo_1', 8, 'Please send any accessibility concerns by the end of the week.', '请在本周结束前反馈无障碍体验方面的问题。', 52_000],
  ['ses_demo_1', 9, 'I will close with the decisions and action items.', '最后我会总结决定和待办事项。', 59_000],
  ['ses_demo_2', 4, 'Only invited colleagues can register an account.', '只有收到邀请的同事才能注册账号。', 25_000],
  ['ses_demo_2', 5, 'You can create a new session and choose the spoken and target languages.', '您可以创建新会话，并选择原语言和目标语言。', 32_000],
  ['ses_demo_2', 6, 'When a conversation ends, its final transcript is available in history.', '对话结束后，最终转录会保存在历史记录中。', 39_000],
  ['ses_demo_2', 7, 'We will follow up with an example session after this introduction.', '本次介绍之后，我们会用一个示例会话继续演示。', 46_000],
  ['ses_demo_5', 1, 'Good morning. Today we are reviewing the launch checklist.', '早上好。今天我们一起检查发布清单。', 500],
  ['ses_demo_5', 2, 'The support guide is ready in English and Chinese.', '支持指南已经准备好英文和中文版。', 7_200],
  ['ses_demo_5', 3, 'We still need approval for the final customer communication.', '最后的客户通知还需要审批。', 14_100],
  ['ses_demo_5', 4, 'I will send the updated checklist this afternoon.', '今天下午我会发出更新后的清单。', 21_000],
  ['ses_demo_6', 1, '今天的访谈主要讨论跨团队协作。', 'Today’s interview focuses on collaboration between teams.', 800],
  ['ses_demo_6', 2, '每个团队都可以分享自己的工作流程。', 'Each team can share its own workflow.', 7_500],
  ['ses_demo_6', 3, '请先说说你们遇到的沟通障碍。', 'Please begin with the communication barriers you encounter.', 14_300],
  ['ses_demo_6', 4, '我们会在下周整理访谈结果。', 'We will summarize the interviews next week.', 21_100],
  ['ses_demo_7', 1, 'Bonjour à tous. Nous allons commencer la présentation.', 'Hello everyone. We will begin the presentation.', 500],
  ['ses_demo_7', 2, 'Notre équipe a terminé le premier prototype.', 'Our team has completed the first prototype.', 7_000],
  ['ses_demo_7', 3, 'Les premiers résultats sont encourageants.', 'The initial results are encouraging.', 14_000],
  ['ses_demo_7', 4, 'Merci pour vos questions et vos commentaires.', 'Thank you for your questions and feedback.', 21_000],
  ['ses_demo_8', 1, 'The design review will focus on readability and keyboard navigation.', '设计评审将重点关注可读性和键盘导航。', 500],
  ['ses_demo_8', 2, 'We have tested the new layout on phones and larger screens.', '我们已经在手机和大屏设备上测试了新版布局。', 7_000],
  ['ses_demo_8', 3, 'The remaining issues are documented for the next iteration.', '剩余的问题已记录下来，供下一轮迭代处理。', 14_000],
  ['ses_demo_8', 4, 'Let us review the proposed changes together.', '我们一起来看看拟议的改动。', 21_000],
  ['ses_demo_9', 1, '最初の議題は新しい顧客向けガイドです。', 'The first item is the new customer guide.', 500],
  ['ses_demo_9', 2, '来週、更新版を共有する予定です。', 'We plan to share an updated version next week.', 7_000],
  ['ses_demo_9', 3, '質問があれば、いつでもご連絡ください。', 'Please contact us whenever you have questions.', 14_000],
]
segmentData = [...segmentData, ...extraLines.map(([sessionId, sequence, sourceText, translation, startMs]) => ({ id: `seg_${sessionId}_${sequence}`, sessionId, sequence, sourceText, translation, translationStatus: 'succeeded' as const, final: true, startMs, endMs: startMs + 5_200, createdAt: isoBefore(1_200) }))]

let sessionData: InterpretationSession[] = [
  { id: 'ses_demo_1', title: 'Weekly product sync', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'completed', createdAt: isoBefore(1_480), updatedAt: isoBefore(1_420), startedAt: isoBefore(1_479), endedAt: isoBefore(1_425) },
  { id: 'ses_demo_2', title: 'Customer onboarding — Sydney', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'completed', createdAt: isoBefore(5_300), updatedAt: isoBefore(5_240), startedAt: isoBefore(5_299), endedAt: isoBefore(5_268) },
  { id: 'ses_demo_3', title: 'Research interview 08', sourceLanguage: 'zh-Hans', targetLanguage: 'en', status: 'failed', createdAt: isoBefore(180), updatedAt: isoBefore(4), startedAt: isoBefore(179), endedAt: isoBefore(145) },
  { id: 'ses_demo_4', title: 'Untitled interpretation', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'created', createdAt: isoBefore(22), updatedAt: isoBefore(22), startedAt: null, endedAt: null },
  { id: 'ses_demo_5', title: 'Launch readiness briefing', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'completed', createdAt: isoBefore(360), updatedAt: isoBefore(332), startedAt: isoBefore(359), endedAt: isoBefore(332) },
  { id: 'ses_demo_6', title: 'Operations research interview', sourceLanguage: 'zh-Hans', targetLanguage: 'en', status: 'completed', createdAt: isoBefore(2_890), updatedAt: isoBefore(2_862), startedAt: isoBefore(2_889), endedAt: isoBefore(2_862) },
  { id: 'ses_demo_7', title: 'Paris partner presentation', sourceLanguage: 'fr', targetLanguage: 'en', status: 'completed', createdAt: isoBefore(7_280), updatedAt: isoBefore(7_253), startedAt: isoBefore(7_279), endedAt: isoBefore(7_253) },
  { id: 'ses_demo_8', title: 'Accessibility design review', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'completed', createdAt: isoBefore(10_200), updatedAt: isoBefore(10_172), startedAt: isoBefore(10_199), endedAt: isoBefore(10_172) },
  { id: 'ses_demo_9', title: 'Tokyo customer follow-up', sourceLanguage: 'ja', targetLanguage: 'en', status: 'completed', createdAt: isoBefore(16_100), updatedAt: isoBefore(16_078), startedAt: isoBefore(16_099), endedAt: isoBefore(16_078) },
  { id: 'ses_demo_10', title: 'Quarterly planning', sourceLanguage: 'en', targetLanguage: 'zh-Hans', status: 'created', createdAt: isoBefore(56), updatedAt: isoBefore(56), startedAt: null, endedAt: null },
]

// A long, mixed-language conversation exercises bidirectional reading windows.
const previewHistory = sessionData.find(session => session.id === 'ses_demo_1')!
previewHistory.recognitionLanguages = ['en', 'zh-Hans']; previewHistory.diarization = true
for (const ready of sessionData.filter(session => session.status === 'created')) {
  ready.recognitionLanguages = ['en', 'zh-Hans']; ready.diarization = true
}
const historyPhrases = segmentData.filter(segment => segment.sessionId === 'ses_demo_1')
segmentData = segmentData.filter(segment => segment.sessionId !== 'ses_demo_1')
for (let index = 0; index < 144; index++) {
  const original = historyPhrases[index % historyPhrases.length]!
  const chinese = index % 3 === 1
  segmentData.push({ ...original, id: `seg_history_${index + 1}`, sequence: index + 1,
    sourceText: chinese ? original.translation : original.sourceText,
    translation: original.translation, detectedLanguage: chinese ? 'zh-Hans' : 'en',
    speakerId: `speaker_${Math.floor(index / 2) % 3 + 1}`, sourceRevision: 100, translationRevision: 100,
    startMs: index * 22000, endMs: index * 22000 + 11000,
  })
}

const settings: UserSettings = { onboardingComplete:true, defaultSourceLanguage: 'en', defaultTargetLanguage: 'zh-Hans', autoStartMicrophone: false, showPartialTranscripts: true, compactTranscriptLayout: false, autoArchiveHours: 24 }
let passkeyData: Passkey[] = [
  { id: 'key_1', userId: demoUser.id, name: 'MacBook Touch ID', createdAt: isoBefore(42_000), lastUsedAt: isoBefore(9) },
  { id: 'key_2', userId: demoUser.id, name: 'Security key', createdAt: isoBefore(21_000), lastUsedAt: isoBefore(7_000) },
]
const browserSessionData: BrowserSession[] = [
  { id: 'browser_current', createdAt: isoBefore(180), expiresAt: isoBefore(-1_260), lastSeen: isoBefore(1), userAgent: 'Chrome on macOS', ipAddress: '203.0.113.18', current: true },
  { id: 'browser_phone', createdAt: isoBefore(2_800), expiresAt: isoBefore(-80), lastSeen: isoBefore(34), userAgent: 'Safari on iPhone', ipAddress: '198.51.100.42', current: false },
  { id: 'browser_office', createdAt: isoBefore(7_000), expiresAt: isoBefore(-200), lastSeen: isoBefore(1_240), userAgent: 'Edge on Windows', ipAddress: '192.0.2.64', current: false },
]
let invitationData: Invitation[] = [
  { id: 'inv_demo_seed', createdBy: demoUser.id, createdAt: isoBefore(20), expiresAt: isoBefore(-525_600), usedAt: null, usedBy: null, revokedAt: null },
  { id: 'inv_1', createdBy: demoUser.id, createdAt: isoBefore(2_900), expiresAt: isoBefore(-1_420), usedAt: null, usedBy: null, revokedAt: null },
  { id: 'inv_2', createdBy: demoUser.id, createdAt: isoBefore(8_000), expiresAt: isoBefore(4_000), usedAt: isoBefore(7_200), usedBy: 'usr_2', revokedAt: null },
]
let userData: User[] = [
  demoUser,
  { id: 'usr_2', username: 'alex', displayName: 'Alex Chen', role: 'user', status: 'active', createdAt: isoBefore(7_200), updatedAt: isoBefore(84) },
  { id: 'usr_3', username: 'marina', displayName: 'Marina Sato', role: 'user', status: 'disabled', createdAt: isoBefore(19_000), updatedAt: isoBefore(12_000) },
]
let auditData: AuditEvent[] = [
  { id: 'aud_1', actorUserId: demoUser.id, action: 'user.status.set', targetType: 'user', targetId: 'usr_3', metadata: { status: 'disabled' }, createdAt: isoBefore(12_000) },
  { id: 'aud_2', actorUserId: demoUser.id, action: 'invitation.create', targetType: 'invitation', targetId: 'inv_1', metadata: { expiresAt: isoBefore(-1_420) }, createdAt: isoBefore(2_900) },
]
interface DemoData {
  version: 4
  sessions: InterpretationSession[]
  segments: Segment[]
  owners: Record<string, string>
  users: User[]
  settings: Record<string, UserSettings>
  passkeys: Passkey[]
  browserSessions: Record<string, BrowserSession[]>
  invitations: Invitation[]
  invitationDigests: Record<string, string>
  audit: AuditEvent[]
  siteSettings?: SiteSettings
  providerEndpoints?: ProviderEndpoints
  viewerLanguages?: Record<string, Record<string, string>>
}
let owners: Record<string, string> = Object.fromEntries(sessionData.map((session) => [session.id, demoUser.id]))
let userSettings: Record<string, UserSettings> = { [demoUser.id]: settings }
let browsersByUser: Record<string, BrowserSession[]> = { [demoUser.id]: browserSessionData }
let invitationDigests: Record<string, string> = { inv_demo_seed: seedInvitationDigest }
let providerEndpoints: ProviderEndpoints = { asrUrl: '', translatorUrl: '', asrConfigured: false, translatorConfigured: false }
let siteSettings:SiteSettings={registrationHelpMarkdown:'# How to register\n\n1. Ask an administrator for a registration code.\n2. Choose **Use a temporary code** on the sign-in page.\n3. Enter the six-digit code, choose your account name and create a passkey.\n4. Choose your languages in quick setup.\n',codeAttemptsPerMinute:3}
let codeAttempts:{started:number;count:number}={started:0,count:0}
let viewerLanguages: Record<string, Record<string, string>> = {}
function persist() {
  const data: DemoData = { version: 4, sessions: sessionData, segments: segmentData, owners, users: userData, settings: userSettings, passkeys: passkeyData, browserSessions: browsersByUser, invitations: invitationData, invitationDigests, audit: auditData, providerEndpoints, viewerLanguages, siteSettings }
  writeBrowserStorage('local', dataKey, JSON.stringify(data))
}
function restore() {
  try {
    const raw = readBrowserStorage('local', dataKey)
    if (!raw) return
    const saved = JSON.parse(raw) as DemoData
    if (saved.version !== 4 || !Array.isArray(saved.sessions) || !Array.isArray(saved.segments) || !Array.isArray(saved.users) || !saved.owners || !saved.settings || !saved.browserSessions || !Array.isArray(saved.passkeys) || !Array.isArray(saved.invitations) || !saved.invitationDigests || !Array.isArray(saved.audit)) return
    sessionData = saved.sessions; segmentData = saved.segments; owners = saved.owners
    userData = saved.users; userSettings = saved.settings; passkeyData = saved.passkeys
    browsersByUser = saved.browserSessions; invitationData = saved.invitations
    invitationDigests = saved.invitationDigests; auditData = saved.audit
    providerEndpoints = saved.providerEndpoints ?? providerEndpoints
    viewerLanguages = saved.viewerLanguages ?? {}
    siteSettings = saved.siteSettings ?? siteSettings
  } catch { /* Invalid or unavailable browser storage starts a fresh demo. */ }
}
restore()
function appendAudit(actorUserId: string, action: string, targetType: string, targetId: string, metadata: unknown) {
  auditData = [{ id: `aud_${crypto.randomUUID()}`, actorUserId, action, targetType, targetId, metadata, createdAt: now() }, ...auditData]
  persist()
}

function mockOptions() {
  return {
    ceremonyToken: crypto.randomUUID(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    options: { publicKey: { challenge: 'dC1saW5ndWFsLW1vY2stY2hhbGxlbmdl', timeout: 60_000, rp: { name: 'T Lingual', id: window.location.hostname }, user: { id: 'dXNyX2RlbW8', name: demoUser.username, displayName: demoUser.displayName }, pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }, { type: 'public-key' as const, alg: -257 }], authenticatorSelection: { residentKey: 'preferred' as const, userVerification: 'required' as const } } },
  }
}
function authSession(user: User): AuthSession { return { user: clone(user), onboardingComplete:userSettings[user.id]?.onboardingComplete??true, session: { createdAt: now(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } }

export class MockApi implements ApiService {
  readonly mode = 'mock' as const
  private readonly recordingClocks = new Map<string, { started: number; offset: number }>()
  private pendingPasskeyName = 'New passkey'
  private pendingLogin = new Set<string>()
  private registrationTickets = new Map<string,{id:string;expiresAt:string}>()
  private countCodeAttempt() {
    const nowMs=Date.now()
    if(!codeAttempts.started||nowMs-codeAttempts.started>=60000)codeAttempts={started:nowMs,count:0}
    if(codeAttempts.count>=siteSettings.codeAttemptsPerMinute)throw Object.assign(new Error('Too many authentication attempts. Try again later.'),{status:429,retryAfterSeconds:Math.ceil((60000-(nowMs-codeAttempts.started))/1000)})
    codeAttempts.count++
  }
  private pendingRegistration = new Map<string, { invitationId: string; username: string; displayName: string; credentialName: string }>()
  private pendingPasskeyCeremony = new Set<string>()
  private readonly pendingAuthorizationScopes = new Map<string, { scope: string; userId: string }>()
  private readonly authorizationGrants = new Map<string, { scope: string; userId: string }>()
  private currentUser() {
    const id = readBrowserStorage('session', authKey)
    const user = userData.find((item) => item.id === (id === 'yes' ? demoUser.id : id))
    if (!user || user.status !== 'active') throw new Error('Not signed in')
    return user
  }
  private adminUser() {
    const user = this.currentUser()
    if (user.role !== 'admin') throw new Error('Administrator access required')
    return user
  }
  private archiveInactive(userId: string) {
    const hours = userSettings[userId]?.autoArchiveHours ?? 24
    if (hours === 0) return
    const cutoff = Date.now() - hours * 3_600_000
    let changed = false
    for (const session of sessionData) {
      if (owners[session.id] === userId && !session.archivedAt && session.status !== 'live' && new Date(session.updatedAt).getTime() <= cutoff) {
        session.archivedAt = now(); session.archiveReason = 'inactivity'; changed = true
      }
    }
    if (changed) persist()
  }
  private viewerTarget(session: InterpretationSession) { const user=this.currentUser(); return viewerLanguages[user.id]?.[session.id] ?? userSettings[user.id]?.defaultTargetLanguage ?? session.targetLanguage }
  private viewerSegments(session: InterpretationSession, items: Segment[]) { const target=this.viewerTarget(session); return items.map(item => (item.translationTargetLanguage ?? session.targetLanguage) === target ? item : {...item,translation:'',translationStatus:'not_requested' as const,translationError:undefined,translationRevision:undefined}) }
  private ownedSession(id: string) {
    const user = this.currentUser()
    this.archiveInactive(user.id)
    const session = sessionData.find((item) => item.id === id && owners[id] === user.id)
    if (!session) throw new Error('Session not found')
    return session
  }
  private consumeAuthorization(token: string, expectedScope: string) {
    const grant = this.authorizationGrants.get(token)
    this.authorizationGrants.delete(token)
    if (grant?.scope !== expectedScope || grant.userId !== this.currentUser().id) throw new Error('Passkey authorization is missing, expired, already used, or scoped to another action')
  }
  site = {content:async()=>({registrationHelpMarkdown:siteSettings.registrationHelpMarkdown})}

  recognition = { capabilities: async () => ({configured:true,languages:['en','zh-Hans','ar','bg','cs','da','de','el','es','et','fi','fr','he','hi','hr','hu','it','ja','ko','lt','lv','mt','nb','nn','nl','pl','pt','ro','ru','sk','sl','sv','th','tr','uk','vi'],automatic:true,diarization:true}) }

  auth = {
    code: async (code:string):Promise<CodeResult> => {
      await wait();this.countCodeAttempt()
      const digest=await codeDigest(code.trim())
      const invitation=invitationData.find(item=>invitationDigests[item.id]===digest&&!item.usedAt&&!item.revokedAt&&Date.parse(item.expiresAt)>Date.now()&&(!item.notBefore||Date.parse(item.notBefore)<=Date.now()))
      if(!invitation)throw new Error('The code is invalid, not yet active, expired, used, or revoked.')
      if(invitation.kind==='login') {
        const user=userData.find(item=>item.id===invitation.targetUserId&&item.status==='active')
        if(!user)throw new Error('The code is invalid, not yet active, expired, used, or revoked.')
        invitation.usedAt=now();invitation.usedBy=user.id;delete invitationDigests[invitation.id]
        writeBrowserStorage('session',authKey,user.id)
        const authorizationToken=crypto.randomUUID(),expiresAt=new Date(Date.now()+120000).toISOString()
        this.authorizationGrants.set(authorizationToken,{scope:'passkeys:add',userId:user.id})
        persist()
        return {...authSession(user),kind:'login',recoveryAuthorization:{authorizationToken,expiresAt}}
      }
      const registrationTicket=crypto.randomUUID(),expiresAt=new Date(Math.min(Date.now()+300000,Date.parse(invitation.expiresAt))).toISOString()
      this.registrationTickets.set(registrationTicket,{id:invitation.id,expiresAt})
      return {kind:'registration',registrationTicket,expiresAt}
    },
    me: async () => { await wait(120); return authSession(this.currentUser()) },
    loginBegin: async () => { await wait(); const result = mockOptions(); this.pendingLogin.add(result.ceremonyToken); return { ceremonyToken: result.ceremonyToken, expiresAt: result.expiresAt, options: { publicKey: { challenge: result.options.publicKey.challenge, timeout: result.options.publicKey.timeout, rpId: result.options.publicKey.rp.id, userVerification: 'required' as const } } } },
    loginFinish: async (ceremonyToken: string, credential: SerializedCredential) => { void credential; await wait(); if (!this.pendingLogin.delete(ceremonyToken)) throw new Error('Passkey ceremony expired'); writeBrowserStorage('session', authKey, demoUser.id); return authSession(this.currentUser()) },
    registrationBegin: async (input: RegistrationInput) => {
      await wait();if(input.invitationCode&&!input.registrationTicket)this.countCodeAttempt()
      const ticket=input.registrationTicket?this.registrationTickets.get(input.registrationTicket):undefined
      const digest=input.invitationCode?await codeDigest(input.invitationCode):''
      const invitation=invitationData.find(item=>(ticket?ticket.id===item.id&&Date.parse(ticket.expiresAt)>Date.now():invitationDigests[item.id]===digest)&&item.kind!=='login'&&!item.usedAt&&!item.revokedAt&&Date.parse(item.expiresAt)>Date.now()&&(!item.notBefore||Date.parse(item.notBefore)<=Date.now()))
      if(!invitation)throw new Error('The code is invalid, not yet active, expired, used, or revoked.')
      const username = input.username.trim()
      const displayName = input.displayName.trim()
      if (!/^[a-z][a-z0-9_-]{2,31}$/iu.test(username) || !displayName || userData.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new Error('Choose an available username of at least three characters and a display name.')
      const result = mockOptions()
      this.pendingRegistration.set(result.ceremonyToken, { invitationId: invitation.id, username, displayName, credentialName: input.credentialName?.trim() || 'Primary passkey' })
      return { ...result, options: { publicKey: { ...result.options.publicKey, user: { ...result.options.publicKey.user, name: username, displayName } } } }
    },
    registrationFinish: async (ceremonyToken: string, credential: SerializedCredential) => {
      void credential
      await wait()
      const pending = this.pendingRegistration.get(ceremonyToken)
      this.pendingRegistration.delete(ceremonyToken)
      const invitation = invitationData.find((item) => item.id === pending?.invitationId)
      if (!pending || !invitation || invitation.usedAt || invitation.revokedAt || new Date(invitation.expiresAt).getTime() <= Date.now() || userData.some((user) => user.username.toLowerCase() === pending.username.toLowerCase())) throw new Error('Registration could not be completed. Start again with a valid invitation.')
      const user: User = { id: `usr_${crypto.randomUUID()}`, username: pending.username, displayName: pending.displayName, role: 'user', status: 'active', createdAt: now(), updatedAt: now() }
      userData = [...userData, user]
      invitation.usedAt = now(); invitation.usedBy = user.id
      delete invitationDigests[invitation.id]
      userSettings[user.id] = {...clone(settings),onboardingComplete:false}
      passkeyData = [...passkeyData, { id: `key_${crypto.randomUUID()}`, userId: user.id, name: pending.credentialName, createdAt: now(), lastUsedAt: now() }]
      browsersByUser[user.id] = [{ id: `browser_${crypto.randomUUID()}`, createdAt: now(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), lastSeen: now(), userAgent: navigator.userAgent, ipAddress: '127.0.0.1', current: true }]
      persist(); writeBrowserStorage('session', authKey, user.id)
      return authSession(user)
    },
    logout: async () => {
      await wait(100)
      const user = this.currentUser()
      for (const session of sessionData) {
        if (owners[session.id] === user.id && session.status === 'live') this.finishDevelopmentLive(session.id)
      }
      removeBrowserStorage('session', authKey)
    },
  }
  browserSessions = {
    list: async () => { await wait(); return clone(browsersByUser[this.currentUser().id] ?? []) },
    revoke: async (id: string, authorizationToken?: string) => {
      await wait()
      const user = this.currentUser()
      const current = browsersByUser[user.id] ?? []
      const target = current.find((session) => session.id === id)
      if (!target) throw new Error('Browser session not found')
      if (!target.current) this.consumeAuthorization(authorizationToken ?? '', 'passkey_management')
      browsersByUser[user.id] = current.filter((session) => session.id !== id)
      persist()
      if (target.current) removeBrowserStorage('session', authKey)
    },
    revokeOthers: async (authorizationToken: string) => {
      await wait()
      this.consumeAuthorization(authorizationToken, 'passkey_management')
      const user = this.currentUser()
      const current = browsersByUser[user.id] ?? []
      const revoked = current.filter((session) => !session.current).length
      browsersByUser[user.id] = current.filter((session) => session.current)
      persist()
      return { revoked }
    },
  }
  sessions = {
    list: async (query: Parameters<ApiService['sessions']['list']>[0] = {}) => { await wait(); const user = this.currentUser(); this.archiveInactive(user.id); const offset = query.offset ?? 0; const limit = query.limit ?? 50; const matching = sessionData.filter((item) => owners[item.id] === user.id && (!query.status || item.status === query.status)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); return { items: clone(matching.slice(offset, offset + limit).map(session=>({...session,targetLanguage:this.viewerTarget(session)}))), offset, limit } },
    create: async (input: Parameters<ApiService['sessions']['create']>[0]) => { await wait(); const user = this.currentUser(); const timestamp = now(); const session: InterpretationSession = { id: `int_${crypto.randomUUID()}`, ...input, diarization:true, targetLanguage: input.targetLanguage ?? userSettings[user.id]?.defaultTargetLanguage ?? 'en', status: 'created', createdAt: timestamp, updatedAt: timestamp, startedAt: null, endedAt: null }; sessionData = [session, ...sessionData]; owners[session.id] = user.id; persist(); return clone(session) },
    get: async (id: string) => { await wait(); const session = this.ownedSession(id); const user = this.currentUser(); const matching = segmentData.filter((segment) => segment.sessionId === id).sort((a, b) => a.sequence - b.sequence); const segments = clone(this.viewerSegments(session, matching.slice(0, 50))); const access: ViewerAccess = { viewerId: user.id, displayName: user.displayName, isOwner: true, permission: 'record', targetLanguage: this.viewerTarget(session), languageOverridden: !!viewerLanguages[user.id]?.[id] }; return { session: clone({ ...session, targetLanguage: access.targetLanguage, isOwner: true, permission: 'record' as const }), segments, segmentPage: { nextAfter: segments.at(-1)?.sequence ?? 0, hasMore: matching.length > segments.length, limit: 50 }, access, recording: { active: session.status === 'live', holderId: session.status === 'live' ? user.id : undefined, holderName: session.status === 'live' ? user.displayName : undefined, holderIsOwner: session.status === 'live' } } },
    update: async (id: string, input: Parameters<ApiService['sessions']['update']>[1]) => { await wait(); const session = this.ownedSession(id); if (session.status === 'live') throw new Error('A live session cannot be edited'); if (session.archivedAt) throw new Error('Unarchive this session before making changes'); Object.assign(session, input, { targetLanguage: input.targetLanguage ?? session.targetLanguage, updatedAt: now() }); persist(); return clone(session) },
    remove: async (id: string) => { await wait(); const session = this.ownedSession(id); if (session.status === 'live') throw new Error('A live session cannot be deleted'); sessionData = sessionData.filter((item) => item.id !== id); segmentData = segmentData.filter((item) => item.sessionId !== id); delete owners[id]; persist() },
    archive: async (id: string) => { await wait(); const session = this.ownedSession(id); if (session.status === 'live') throw new Error('Stop recording before archiving this session'); if (!session.archivedAt) { session.archivedAt = now(); session.archiveReason = 'manual'; session.updatedAt = session.archivedAt; persist() } return clone(session) },
    unarchive: async (id: string) => { await wait(); const session = this.ownedSession(id); if (session.archivedAt) { session.archivedAt = null; delete session.archiveReason; session.updatedAt = now(); persist() } return clone(session) },
    recognition: async (id: string, recognitionLanguages: string[], diarization?: boolean) => { await wait(); const session=this.ownedSession(id); if(session.status==='live') throw new Error('Stop recording before changing recognition languages'); if(session.archivedAt) throw new Error('Unarchive this session before making changes'); if(!recognitionLanguages.length) throw new Error('Choose at least one recognition language'); session.recognitionLanguages=[...recognitionLanguages]; session.sourceLanguage=recognitionLanguages.length===1 ? recognitionLanguages[0]! : 'auto'; if(diarization!==undefined)session.diarization=diarization;session.updatedAt=now();persist();return clone({...session,targetLanguage:this.viewerTarget(session)}) },
    language: async (id: string, targetLanguage: string): Promise<ViewerAccess> => { await wait(); const session = this.ownedSession(id); const user = this.currentUser(); const selected = targetLanguage.trim(); if (!selected) throw new Error('Choose a translation language'); const selectedByUser = viewerLanguages[user.id] ?? {}; selectedByUser[id] = selected; viewerLanguages[user.id] = selectedByUser; persist(); return { viewerId: user.id, displayName: user.displayName, isOwner: true, permission: 'record', targetLanguage: selected, languageOverridden: selected !== session.targetLanguage } },
    stopRecorder: async (id: string) => { await wait(); const session = this.ownedSession(id); if (session.status === 'live') this.finishDevelopmentLive(id) },
    segments: async (id: string, query: Parameters<ApiService['sessions']['segments']>[1] = {}) => {
      await wait(); const session=this.ownedSession(id)
      const limit = Math.max(1, Math.min(200, query.limit ?? 40))
      const needle = query.search?.trim().toLocaleLowerCase()
      const all = segmentData.filter(segment => segment.sessionId === id && (!needle || `${segment.sourceText} ${segment.translation}`.toLocaleLowerCase().includes(needle))).sort((a, b) => a.sequence - b.sequence)
      const atSequence = query.atMs === undefined ? undefined : [...all].reverse().find(item => item.startMs <= query.atMs!)?.sequence ?? 0
      const matching = query.before !== undefined ? all.filter(item => item.sequence < query.before!) : all.filter(item => item.sequence > (atSequence !== undefined ? Math.max(-1, atSequence-Math.floor(limit/4)-1) : query.after ?? -1))
      const items = clone(this.viewerSegments(session, query.tail || query.before !== undefined ? matching.slice(-limit) : matching.slice(0, limit)))
      const firstSequence = items[0]?.sequence ?? 0, lastSequence = items.at(-1)?.sequence ?? 0
      const hasEarlier = all.some(item => item.sequence < firstSequence)
      const hasLater = all.some(item => item.sequence > lastSequence)
      return { items, nextAfter: lastSequence || query.after || 0, hasMore: query.before !== undefined || query.tail ? hasEarlier : hasLater, hasEarlier, hasLater, firstSequence, lastSequence, limit }
    },
  }
  settings = {
    get:async()=>{await wait();return {...clone(userSettings[this.currentUser().id]??settings),autoArchiveHours:userSettings[this.currentUser().id]?.autoArchiveHours??24}},
    update:async(input:UserSettings)=>{await wait();const id=this.currentUser().id,prior=userSettings[id]??settings,hours=input.autoArchiveHours??24;if(!Number.isInteger(hours)||hours<0||hours>8760)throw new Error('Choose a valid auto-archive interval');const next={...prior,...input,interfaceLanguage:input.interfaceLanguage??prior.interfaceLanguage,themePreference:input.themePreference??prior.themePreference,onboardingComplete:!!prior.onboardingComplete||!!input.onboardingComplete,autoArchiveHours:hours};userSettings[id]=next;persist();return clone(next)},
    updateInterface:async(input:Pick<UserSettings,'interfaceLanguage'|'themePreference'>)=>{await wait();const id=this.currentUser().id;const next={...(userSettings[id]??settings),...input};userSettings[id]=next;persist();return clone(next)},
  }

	passkeys = {
		list: async () => { await wait(); const user = this.currentUser(); return clone(passkeyData.filter((key) => key.userId === user.id)) },
		authorizationBegin: async (scope = 'passkey_management') => { await wait(); const user = this.currentUser(); const result = mockOptions(); this.pendingAuthorizationScopes.set(result.ceremonyToken, { scope, userId: user.id }); return { ceremonyToken: result.ceremonyToken, expiresAt: result.expiresAt, options: { publicKey: { challenge: result.options.publicKey.challenge, timeout: result.options.publicKey.timeout, rpId: result.options.publicKey.rp.id, userVerification: 'required' as const } } } },
		authorizationFinish: async (ceremonyToken: string, credential: SerializedCredential) => { void credential; await wait(); const grant = this.pendingAuthorizationScopes.get(ceremonyToken); this.pendingAuthorizationScopes.delete(ceremonyToken); if (!grant || grant.userId !== this.currentUser().id) throw new Error('Passkey authorization ceremony is missing or expired'); const authorizationToken = crypto.randomUUID(); this.authorizationGrants.set(authorizationToken, grant); return { authorizationToken, expiresAt: new Date(Date.now() + 120_000).toISOString() } },
		registrationBegin: async (authorizationToken: string, input: { name: string }) => { await wait(); this.currentUser(); this.consumeAuthorization(authorizationToken, this.authorizationGrants.get(authorizationToken)?.scope==='passkeys:add'?'passkeys:add':'passkey_management'); this.pendingPasskeyName = input.name.trim() || 'New passkey'; const result = mockOptions(); this.pendingPasskeyCeremony.add(result.ceremonyToken); return result },
		registrationFinish: async (ceremonyToken: string, credential: SerializedCredential) => { void credential; await wait(); if (!this.pendingPasskeyCeremony.delete(ceremonyToken)) throw new Error('Passkey registration ceremony expired'); const item: Passkey = { id: `key_${crypto.randomUUID()}`, userId: this.currentUser().id, name: this.pendingPasskeyName, createdAt: now(), lastUsedAt: null }; passkeyData = [...passkeyData, item]; persist(); return clone(item) },
		remove: async (authorizationToken: string, id: string) => { await wait(); const user = this.currentUser(); this.consumeAuthorization(authorizationToken, 'passkey_management'); if (!passkeyData.some((key) => key.id === id && key.userId === user.id)) throw new Error('Passkey not found'); if (passkeyData.filter((key) => key.userId === user.id).length <= 1) throw new Error('Keep at least one passkey'); passkeyData = passkeyData.filter((key) => key.id !== id); persist(); removeBrowserStorage('session', authKey) },
	}
  admin = {
    siteSettings:async()=>{await wait();this.adminUser();return clone(siteSettings)},
    updateSiteSettings:async(authorizationToken:string,input:SiteSettings)=>{await wait();const actor=this.adminUser();this.consumeAuthorization(authorizationToken,await siteSettingsScope(input));if(!input.registrationHelpMarkdown.trim()||new TextEncoder().encode(input.registrationHelpMarkdown).length>8192||!Number.isInteger(input.codeAttemptsPerMinute)||input.codeAttemptsPerMinute<1||input.codeAttemptsPerMinute>10)throw new Error('Check the registration help and code attempt limit.');siteSettings={registrationHelpMarkdown:input.registrationHelpMarkdown,codeAttemptsPerMinute:input.codeAttemptsPerMinute};appendAudit(actor.id,'site_settings.update','site_settings','site',{codeAttemptsPerMinute:input.codeAttemptsPerMinute});persist();return clone(siteSettings)},
    createCode: async (authorizationToken:string,input:CreateCodeInput):Promise<CreatedCode> => {
      await wait();const actor=this.adminUser();this.consumeAuthorization(authorizationToken,await codeCreateScope(input))
      if(input.kind==='login'&&!userData.some(user=>user.id===input.targetUserId&&user.status==='active'))throw new Error('Choose an active user.')
      const start=input.notBefore?Math.max(Date.now(),Date.parse(input.notBefore)):Date.now()
      const ttl=input.ttlSeconds??(input.kind==='login'?600:86400)
      const end=input.expiresAt?Date.parse(input.expiresAt):start+ttl*1000
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=Date.now()||end-start<60000||end-start>(input.kind==='login'?900000:30*86400000))throw new Error('Choose a valid code lifetime.')
      const invitation:Invitation={id:`inv_${crypto.randomUUID()}`,kind:input.kind,targetUserId:input.targetUserId,notBefore:new Date(start).toISOString(),createdBy:actor.id,createdAt:now(),expiresAt:new Date(end).toISOString(),usedAt:null,usedBy:null,revokedAt:null}
      const code=String(crypto.getRandomValues(new Uint32Array(1))[0]!%900000+100000)
      invitationDigests[invitation.id]=await codeDigest(code);invitationData=[invitation,...invitationData];appendAudit(actor.id,'invitation.create','invitation',invitation.id,{kind:input.kind,notBefore:invitation.notBefore,expiresAt:invitation.expiresAt});persist()
      return {id:invitation.id,kind:input.kind,code,targetUserId:input.targetUserId,notBefore:invitation.notBefore!,expiresAt:invitation.expiresAt}
    },
    providers: async () => { await wait(); this.adminUser(); return clone(providerEndpoints) },
    updateProviders: async (authorizationToken: string, input: ProviderEndpoints) => {
      await wait(); const actor = this.adminUser()
      const candidate = { asrUrl: input.asrUrl.trim(), translatorUrl: input.translatorUrl.trim() }
      for (const value of Object.values(candidate)) {
        if (!value) continue
        let parsed: URL
        try { parsed = new URL(value) } catch { throw new Error('Provider endpoint must be an absolute HTTP or HTTPS URL') }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value.includes('?') || value.includes('#')) throw new Error('Provider endpoint cannot contain credentials, query, or fragment')
      }
      const scope = `admin:providers:update:${await codeDigest(JSON.stringify(candidate))}`
      this.consumeAuthorization(authorizationToken, scope)
      providerEndpoints = { ...candidate, asrConfigured: !!candidate.asrUrl, translatorConfigured: !!candidate.translatorUrl }
      appendAudit(actor.id, 'provider.update', 'provider', 'current', { asrConfigured: providerEndpoints.asrConfigured, translatorConfigured: providerEndpoints.translatorConfigured })
      return clone(providerEndpoints)
    },
    invitations: async (query: Parameters<ApiService['admin']['invitations']>[0] = {}) => { await wait(); this.adminUser(); const offset = query.offset ?? 0; return clone(invitationData.slice(offset, offset + (query.limit ?? 50))) },
    createInvitation: async (authorizationToken: string, { expiresInHours }: { expiresInHours: number }) => { await wait(); const actor = this.adminUser(); this.consumeAuthorization(authorizationToken, `admin:invitation:create:${expiresInHours}`); if (expiresInHours < 1 || expiresInHours > 168) throw new Error('Invitation expiry must be between 1 and 168 hours'); const invitation: Invitation = { id: `inv_${crypto.randomUUID()}`, createdBy: actor.id, createdAt: now(), expiresAt: new Date(Date.now() + expiresInHours * 3_600_000).toISOString(), usedAt: null, usedBy: null, revokedAt: null }; const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 900_000 + 100_000); invitationDigests[invitation.id] = await codeDigest(code); invitationData = [invitation, ...invitationData]; appendAudit(actor.id, 'invitation.create', 'invitation', invitation.id, { expiresAt: invitation.expiresAt }); return { invitation: clone(invitation), code } },
    revokeInvitation: async (authorizationToken: string, id: string) => { await wait(); const actor = this.adminUser(); this.consumeAuthorization(authorizationToken, `admin:invitation:revoke:${id}`); const item = invitationData.find((invitation) => invitation.id === id); if (!item || item.revokedAt || item.usedAt) throw new Error('Active invitation not found'); item.revokedAt = now(); delete invitationDigests[id]; appendAudit(actor.id, 'invitation.revoke', 'invitation', id, {}) },
    users: async (query: Parameters<ApiService['admin']['users']>[0] = {}) => { await wait(); this.adminUser(); const offset = query.offset ?? 0; return clone(userData.slice(offset, offset + (query.limit ?? 50))) },
    updateUser: async (authorizationToken: string, id: string, input: Parameters<ApiService['admin']['updateUser']>[2]) => { await wait(); const actor = this.adminUser(); this.consumeAuthorization(authorizationToken, `admin:user:update:${id}:${input.role ?? '-'}:${input.status ?? '-'}`); const item = userData.find((user) => user.id === id); if (!item) throw new Error('User not found'); if (actor.id === id) throw new Error('You cannot change your own access'); if((input.role&&input.role!==item.role)||(input.status&&input.status!==item.status)){for(const code of invitationData){if(code.kind==='login'&&code.targetUserId===id&&!code.usedAt&&!code.revokedAt){code.revokedAt=now();delete invitationDigests[code.id]}}} Object.assign(item, input, { updatedAt: now() }); if (input.role) appendAudit(actor.id, 'user.role.set', 'user', id, { role: input.role }); if (input.status) appendAudit(actor.id, 'user.status.set', 'user', id, { status: input.status }); persist(); return clone(item) },
    audit: async (query: Parameters<ApiService['admin']['audit']>[0] = {}) => { await wait(); this.adminUser(); const offset = query.offset ?? 0; return clone(auditData.slice(offset, offset + (query.limit ?? 50))) },
  }
  /** Explicit development mode only. Shares the same persisted workspace as the demo API. */
  startDevelopmentLive(sessionId: string) {
    const session = this.ownedSession(sessionId)
    if (session.archivedAt) throw new Error('Unarchive this session to continue recording')
    const source = session.sourceLanguage === 'auto' ? 'en' : session.sourceLanguage
    const supported = ['en','zh-Hans','ar','bg','cs','da','de','el','es','et','fi','fr','he','hi','hr','hu','it','ja','ko','lt','lv','mt','nb','nn','nl','pl','pt','ro','ru','sk','sl','sv','th','tr','uk','vi']
    if (!supported.includes(source) || (session.targetLanguage !== '' && !supported.includes(session.targetLanguage))) throw new Error('The development transcript preview supports English, Chinese, French, Spanish, German, Japanese, and Korean.')
    if (session.status !== 'live' || !this.recordingClocks.has(sessionId)) this.recordingClocks.set(sessionId, { started: Date.now(), offset: Math.max(0, ...segmentData.filter(segment => segment.sessionId === sessionId).map(segment => segment.endMs)) })
    session.status = 'live'; session.startedAt ??= now(); session.endedAt = null; session.updatedAt = now(); persist()
    return clone({...session,targetLanguage:this.viewerTarget(session)})
  }
  developmentPosition(sessionId: string) {
    this.ownedSession(sessionId)
    const clock = this.recordingClocks.get(sessionId)
    return clock ? clock.offset + Math.max(0, Date.now() - clock.started) : 0
  }
  nextDevelopmentSequence(sessionId: string) {
    this.ownedSession(sessionId)
    return Math.max(0, ...segmentData.filter((item) => item.sessionId === sessionId).map((item) => item.sequence)) + 1
  }
  saveDevelopmentSegment(segment: Segment) {
    const session = this.ownedSession(segment.sessionId)
    if (session.status !== 'live' || session.archivedAt) return
    const index = segmentData.findIndex((item) => item.id === segment.id)
    if (index === -1) segmentData = [...segmentData, clone(segment)]
    else segmentData[index] = clone(segment)
    session.updatedAt = now(); persist()
  }
  settleDevelopmentPending(sessionId: string) {
    this.ownedSession(sessionId)
    segmentData = segmentData.map((segment) => segment.sessionId === sessionId && segment.translationStatus === 'pending'
      ? { ...segment, translationStatus: 'failed', translationError: 'The prepared sequence paused before this translation arrived.' }
      : segment)
    persist()
    return clone(segmentData.filter((segment) => segment.sessionId === sessionId).slice(-80))
  }
  finishDevelopmentLive(sessionId: string) {
    const session = this.ownedSession(sessionId)
    if (session.status !== 'live') return clone(session)
    this.settleDevelopmentPending(sessionId)
    this.recordingClocks.delete(sessionId)
    session.status = 'completed'; session.endedAt = now(); session.updatedAt = session.endedAt; persist()
    return clone(session)
  }
  sharing = {
    list: async () => { throw new Error('Sharing is unavailable in the prepared demo workspace.') },
    create: async () => { throw new Error('Sharing is unavailable in the prepared demo workspace.') },
    update: async () => { throw new Error('Sharing is unavailable in the prepared demo workspace.') },
    revoke: async () => { throw new Error('Sharing is unavailable in the prepared demo workspace.') },
    recipients: async () => { throw new Error('Sharing is unavailable in the prepared demo workspace.') },
    redeem: async () => { throw new Error('Sharing is unavailable in the prepared demo workspace.') },
  }
  audio = {
    list: async (id: string) => {await wait();this.ownedSession(id);return {parts:[],durationMs:0}},
    partUrl: (id: string,partId: string) => `/api/v1/view/sessions/${encodeURIComponent(id)}/audio/${encodeURIComponent(partId)}`,
    bundleUrl: (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}/bundle`,
  }
  eventsUrl(sessionId: string) { return `https://mock.invalid/events/${encodeURIComponent(sessionId)}` }
  liveSocketUrl(sessionId: string, takeover = false) { return `ws://mock.invalid/${encodeURIComponent(sessionId)}${takeover ? '?takeover=true' : ''}` }
}
