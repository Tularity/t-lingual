export type Role = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'
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
  user: User
  session: { createdAt?: string; expiresAt: string }
}

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
  status: InterpretationStatus
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
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
}

export interface SessionListResponse {
  items: InterpretationSession[]
  offset: number
  limit: number
}

export interface SessionDetailResponse {
  session: InterpretationSession
  segments: Segment[]
  segmentPage: Omit<SegmentPageResponse, 'items'>
}

export interface SegmentPageResponse {
  items: Segment[]
  nextAfter: number
  hasMore: boolean
  limit: number
}

export interface CreateSessionInput {
  title: string
  sourceLanguage: string
  targetLanguage: string
}

export type UpdateSessionInput = CreateSessionInput

export interface UserSettings {
  defaultSourceLanguage: string
  defaultTargetLanguage: string
  autoStartMicrophone: boolean
  showPartialTranscripts: boolean
  compactTranscriptLayout: boolean
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
  | { type: 'ready'; sessionId: string; runId: string; chunkMs: number }
  | { type: 'partial'; text: string; upstreamSequence: number; language?: string }
  | { type: 'final'; segment: Segment; upstreamSequence: number; detectedLanguage?: string }
  | { type: 'translation'; segmentId: string; status: TranslationStatus; translation: string; error?: string; requestId?: string }
  | { type: 'provider_error'; provider: 'asr' | 'translator'; code: string }
  | { type: 'stopped'; status: InterpretationStatus }
  | { type: 'error'; code: string; message: string }

export interface ApiService {
  readonly mode: 'http' | 'mock'
  auth: {
    me(): Promise<AuthSession>
    loginBegin(): Promise<LoginOptionsResponse>
    loginFinish(ceremonyToken: string, credential: SerializedCredential): Promise<AuthSession>
    registrationBegin(input: { invitationCode: string; username: string; displayName: string; credentialName?: string }): Promise<RegistrationOptionsResponse>
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
    segments(id: string, query?: { after?: number; limit?: number }): Promise<SegmentPageResponse>
  }
  settings: { get(): Promise<UserSettings>; update(input: UserSettings): Promise<UserSettings> }
	passkeys: {
		list(): Promise<Passkey[]>
		authorizationBegin(scope?: string): Promise<LoginOptionsResponse>
		authorizationFinish(ceremonyToken: string, credential: SerializedCredential): Promise<PasskeyAuthorizationResponse>
		registrationBegin(authorizationToken: string, input: { name: string }): Promise<RegistrationOptionsResponse>
		registrationFinish(ceremonyToken: string, credential: SerializedCredential): Promise<Passkey>
		remove(authorizationToken: string, id: string): Promise<void>
	}
  admin: {
    invitations(query?: OffsetPagination): Promise<Invitation[]>
    createInvitation(authorizationToken: string, input: { expiresInHours: number }): Promise<CreatedInvitation>
    revokeInvitation(authorizationToken: string, id: string): Promise<void>
    users(query?: OffsetPagination): Promise<User[]>
    updateUser(authorizationToken: string, id: string, input: Partial<Pick<User, 'role' | 'status'>>): Promise<User>
    audit(query?: OffsetPagination): Promise<AuditEvent[]>
  }
  liveSocketUrl(sessionId: string): string
}
