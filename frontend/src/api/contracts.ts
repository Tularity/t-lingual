export type Role = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'
/** Last recording outcome. Only archivedAt makes the conversation read-only. */
export type InterpretationStatus = 'created' | 'live' | 'completed' | 'failed'
export type TranslationStatus = 'not_requested' | 'pending' | 'succeeded' | 'failed'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  status: UserStatus
  createdAt: string
  updatedAt: string
}

export interface AuthSession {
  onboardingComplete?: boolean
  user: User
  session: { createdAt?: string; expiresAt: string }
}

export interface RegistrationInput { invitationCode?: string; registrationTicket?: string; username: string; displayName: string; credentialName?: string }
export type CodeResult = { kind: 'registration'; registrationTicket: string; expiresAt: string } | (AuthSession & {kind:'login'; recoveryAuthorization?: PasskeyAuthorizationResponse})
export interface CreateCodeInput {kind:'registration'|'login';targetUserId?:string;notBefore?:string;expiresAt?:string;ttlSeconds?:number}
export interface CreatedCode {id:string;code:string;kind:'registration'|'login';targetUserId?:string;notBefore:string;expiresAt:string}

export interface BrowserSession {
  id: string
  createdAt: string
  expiresAt: string
  lastSeen: string
  userAgent: string
  ipAddress: string
  current: boolean
}

export interface RevokeBrowserSessionsResponse {
  revoked: number
}

export interface OffsetPagination {
  limit?: number
  offset?: number
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string
  timeout?: number
  rpId?: string
  userVerification?: UserVerificationRequirement
  allowCredentials?: Array<Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string }>
}

export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string
  rp: PublicKeyCredentialRpEntity
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  timeout?: number
  attestation?: AttestationConveyancePreference
  authenticatorSelection?: AuthenticatorSelectionCriteria
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string }>
}

export interface RegistrationOptionsResponse {
  ceremonyToken: string
  expiresAt: string
  options: { publicKey: PublicKeyCredentialCreationOptionsJSON }
}

export interface LoginOptionsResponse {
  ceremonyToken: string
  expiresAt: string
  options: { publicKey: PublicKeyCredentialRequestOptionsJSON }
}

export interface PasskeyAuthorizationResponse {
	authorizationToken: string
	expiresAt: string
}

export interface SerializedCredential {
  id: string
  rawId: string
  type: PublicKeyCredentialType
  authenticatorAttachment: string | null
  clientExtensionResults: AuthenticationExtensionsClientOutputs
  response: Record<string, string | string[] | null>
}

export interface InterpretationSession {
  id: string
  title: string
  sourceLanguage: string
  targetLanguage: string
  /** Recognition candidates for multilingual conversation, distinct from translation output. */
  recognitionLanguages?: string[]
  diarization?: boolean
  status: InterpretationStatus
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  archivedAt?: string | null
  archiveReason?: 'manual' | 'inactivity'
  isOwner?: boolean
  permission?: 'view' | 'record'
  ownerName?: string
}

export interface Segment {
  id: string
  sessionId: string
  sequence: number
  sourceText: string
  translation: string
  translationStatus: TranslationStatus
  translationError?: string
  translatorRequestId?: string
  final: boolean
  startMs: number
  endMs: number
  createdAt: string
  speakerId?: string
  speakerLabel?: string
  languageSource?: 'session' | 'recognizer' | 'text' | 'translator'
  sourceDetection?: {method:string;confidence:number;rank:number;uncertain:boolean;contextUsed:boolean}
  translationPhase?: 'draft' | 'final'
  detectedLanguage?: string
  sourceRevision?: number
  translationTargetLanguage?: string
  translationRevision?: number
}

export interface SessionListResponse {
  items: InterpretationSession[]
  offset: number
  limit: number
}

export interface SessionDetailResponse {
  translationConfigured?: boolean
  session: InterpretationSession
  segments: Segment[]
  segmentPage: Omit<SegmentPageResponse, 'items'>
  access?: ViewerAccess
  recording?: RecordingState
}

export interface ViewerAccess {
  viewerId: string
  displayName: string
  isOwner: boolean
  permission: 'view' | 'record'
  targetLanguage: string
  languageOverridden?: boolean
  ownerName?: string
}

export interface RecordingState {
  active: boolean
  holderId?: string
  holderName?: string
  holderIsOwner?: boolean
}

export interface SessionShare {
  id: string
  sessionId: string
  type: 'user' | 'link'
  userId?: string
  displayName?: string
  permission: 'view' | 'record'
  createdAt: string
  expiresAt: string | null
  revokedAt?: string | null
  token?: string
}

export interface ShareInput {
  type: 'user' | 'link'
  userId?: string
  permission: 'view' | 'record'
  expiresAt: string | null
}

export interface ProviderEndpoints {
  asrUrl: string
  translatorUrl: string
  asrConfigured?: boolean
  translatorConfigured?: boolean
}

export interface SegmentPageResponse {
  items: Segment[]
  nextAfter: number
  hasMore: boolean
  limit: number
  hasEarlier?: boolean
  hasLater?: boolean
  firstSequence?: number
  lastSequence?: number
}

export interface AudioPart {
  id: string
  sessionId: string
  startMs: number
  durationMs: number
  sampleRate: number
  channels: number
  bytes: number
  createdAt: string
  state: 'recording' | 'ready' | 'interrupted'
}

export interface SessionAudio { parts: AudioPart[]; durationMs: number }

export interface SegmentQuery {
  atMs?: number
  after?: number
  before?: number
  tail?: boolean
  limit?: number
  search?: string
}

export interface CreateSessionInput {
  title: string
  sourceLanguage: string
  targetLanguage?: string
  recognitionLanguages?: string[]
  diarization?: boolean
}

export type UpdateSessionInput = CreateSessionInput

export interface UserSettings {
  onboardingComplete?: boolean
  interfaceLanguage?: string
  themePreference?: 'system' | 'light' | 'dark'
  defaultSourceLanguage: string
  defaultTargetLanguage: string
  autoStartMicrophone: boolean
  showPartialTranscripts: boolean
  compactTranscriptLayout: boolean
  /** Hours without recording or changes before archive; zero disables it. */
  autoArchiveHours?: number
}

export interface Passkey {
  id: string
  userId: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  compromisedAt?: string | null
}

export interface Invitation {
  kind?: 'registration' | 'login'
  targetUserId?: string
  notBefore?: string
  id: string
  createdBy: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  usedBy: string | null
  revokedAt: string | null
}

export interface CreatedInvitation {
  invitation: Invitation
  code: string
}

export interface AuditEvent {
  id: string
  actorUserId: string | null
  action: string
  targetType: string
  targetId: string
  metadata: unknown
  createdAt: string
}

export type LiveClientMessage =
  | { type: 'start'; audio: { encoding: 'pcm32f'; sampleRate: number; channels: 1 } }
  | { type: 'end' | 'pause' | 'force_eou' | 'reset_stream' | 'ping' }

export type LiveServerMessage =
  | { type: 'ready'; sessionId: string; runId: string; chunkMs: number; offsetMs?: number }
  | { type: 'partial'; text: string; upstreamSequence: number; language?: string; segmentId?: string; sequence?: number; revision?: number; speakerId?: string; startMs?: number }
  | { type: 'final'; segment: Segment; upstreamSequence: number; detectedLanguage?: string }
  | { type: 'translation'; streamComplete?: boolean; draftComplete?: boolean; retracted?: boolean; phase?: 'draft' | 'final'; sourceRevision?: number; resolvedSourceLanguage?: string; sourceDetection?: Segment['sourceDetection']; targetLanguage?: string; segmentId: string; status: TranslationStatus; translation: string; error?: string; requestId?: string; revision?: number }
  | { type: 'speaker'; segmentId: string; speakerId: string; speakerLabel?: string }
  | { type: 'snapshot'; session: InterpretationSession; segments: Segment[]; access?: ViewerAccess; recording?: RecordingState }
  | { type: 'recording'; recording: RecordingState }
  | { type: 'provider_error'; provider: 'asr' | 'translator'; code: string }
  | { type: 'stopped'; status: InterpretationStatus }
  | { type: 'error'; code: string; message: string }

export interface RecognitionCapabilities { configured: boolean; languages: string[]; automatic: boolean; diarization: boolean }

export interface SiteSettings {
  registrationHelpMarkdown: string
  codeAttemptsPerMinute: number
}
export type SiteContent = Pick<SiteSettings, 'registrationHelpMarkdown'>

export interface ApiService {
  site: {content():Promise<SiteContent>}
  recognition: { capabilities(): Promise<RecognitionCapabilities> }
  readonly mode: 'http' | 'mock'
  auth: {
    me(): Promise<AuthSession>
    code(code: string): Promise<CodeResult>
    loginBegin(): Promise<LoginOptionsResponse>
    loginFinish(ceremonyToken: string, credential: SerializedCredential): Promise<AuthSession>
    registrationBegin(input: RegistrationInput): Promise<RegistrationOptionsResponse>
    registrationFinish(ceremonyToken: string, credential: SerializedCredential): Promise<AuthSession>
    logout(): Promise<void>
  }
  browserSessions: {
    list(): Promise<BrowserSession[]>
    revoke(id: string, authorizationToken?: string): Promise<void>
    revokeOthers(authorizationToken: string): Promise<RevokeBrowserSessionsResponse>
  }
  sessions: {
    list(query?: { status?: InterpretationStatus; limit?: number; offset?: number }): Promise<SessionListResponse>
    create(input: CreateSessionInput): Promise<InterpretationSession>
    get(id: string): Promise<SessionDetailResponse>
    update(id: string, input: UpdateSessionInput): Promise<InterpretationSession>
    remove(id: string): Promise<void>
    archive(id: string): Promise<InterpretationSession>
    unarchive(id: string): Promise<InterpretationSession>
    recognition(id: string, languages: string[], diarization?: boolean): Promise<InterpretationSession>
    language(id: string, targetLanguage: string): Promise<ViewerAccess>
    stopRecorder(id: string): Promise<void>
    segments(id: string, query?: SegmentQuery): Promise<SegmentPageResponse>
  }
  settings: { get(): Promise<UserSettings>; update(input: UserSettings): Promise<UserSettings>; updateInterface(input:Pick<UserSettings,'interfaceLanguage'|'themePreference'>):Promise<UserSettings> }
	passkeys: {
		list(): Promise<Passkey[]>
		authorizationBegin(scope?: string): Promise<LoginOptionsResponse>
		authorizationFinish(ceremonyToken: string, credential: SerializedCredential): Promise<PasskeyAuthorizationResponse>
		registrationBegin(authorizationToken: string, input: { name: string }): Promise<RegistrationOptionsResponse>
		registrationFinish(ceremonyToken: string, credential: SerializedCredential): Promise<Passkey>
		remove(authorizationToken: string, id: string): Promise<void>
	}
  admin: {
    siteSettings():Promise<SiteSettings>
    updateSiteSettings(authorizationToken:string,input:SiteSettings):Promise<SiteSettings>
    createCode(authorizationToken:string,input:CreateCodeInput):Promise<CreatedCode>
    providers(): Promise<ProviderEndpoints>
    updateProviders(authorizationToken: string, input: ProviderEndpoints): Promise<ProviderEndpoints>
    invitations(query?: OffsetPagination): Promise<Invitation[]>
    createInvitation(authorizationToken: string, input: { expiresInHours: number }): Promise<CreatedInvitation>
    revokeInvitation(authorizationToken: string, id: string): Promise<void>
    users(query?: OffsetPagination): Promise<User[]>
    updateUser(authorizationToken: string, id: string, input: Partial<Pick<User, 'role' | 'status'>>): Promise<User>
    audit(query?: OffsetPagination): Promise<AuditEvent[]>
  }
  sharing: {
    list(sessionId: string): Promise<SessionShare[]>
    create(sessionId: string, input: ShareInput): Promise<SessionShare>
    update(sessionId: string, shareId: string, input: Pick<ShareInput, 'permission' | 'expiresAt'>): Promise<SessionShare>
    revoke(sessionId: string, shareId: string): Promise<void>
    recipients(query: string): Promise<Array<Pick<User, 'id' | 'username' | 'displayName'>>>
    redeem(token: string, language: string): Promise<{ sessionId: string }>
  }
  audio: {
    list(sessionId: string): Promise<SessionAudio>
    partUrl(sessionId: string, partId: string): string
    bundleUrl(sessionId: string): string
  }
  eventsUrl(sessionId: string): string
  liveSocketUrl(sessionId: string, takeover?: boolean): string
}
