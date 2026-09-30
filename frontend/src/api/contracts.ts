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
  /** Changes whenever the person's picture does; absent while they have none. */
  avatarVersion?: number
  /** Whether others can find this person by name to share with them. Off until they turn it on. */
  discoverable?: boolean
}

/** One person as another sees them: a name and a picture. */
export type Person = Pick<User, 'id' | 'username' | 'displayName' | 'avatarVersion'>

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
  /** The owner's workspace it is kept in; only its owner is told. */
  workspaceId?: string
}

/** The icons a workspace can be shown with, by the interface's names for them; the server keeps no other. */
export const WORKSPACE_ICONS = [
  'folder', 'archive', 'layers', 'bookmark', 'tag', 'star', 'heart', 'flag',
  'home', 'building', 'briefcase', 'user', 'users', 'chat', 'mail', 'phone',
  'microphone', 'headphones', 'volume', 'video', 'film', 'camera', 'music', 'presentation',
  'languages', 'globe', 'mapPin', 'plane', 'send', 'calendar', 'clock', 'target',
  'book', 'graduationCap', 'newspaper', 'lightbulb', 'spark', 'rocket', 'trophy', 'palette',
  'scale', 'stethoscope', 'shield', 'database', 'code', 'terminal', 'leaf', 'coffee',
] as const
export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number]

/** One of the user's own collections of sessions. */
export interface Workspace {
  id: string
  /** Empty for the first workspace until it is named: the interface names it. */
  name: string
  /** One of WORKSPACE_ICONS, or empty until one is chosen: the interface shows its default. */
  icon: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  /** When its owner pinned it; pinned workspaces come before the rest. */
  pinnedAt: string | null
  sessionCount: number
}

/** What the user chooses for a workspace. */
export interface WorkspaceInput { name: string; icon: string }

export interface WorkspaceListResponse {
  /** Oldest first. */
  items: Workspace[]
  /** Whether anyone has shared a session with this user. */
  hasShared: boolean
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
  presence?: PresenceList
  recognitionGaps?: RecognitionGap[]
}

/** Someone with a session open: signed in, with a name and maybe a picture, or a guest. */
export interface Presence {
  key: string
  name: string
  kind: 'user' | 'guest'
  userId?: string
  avatarVersion?: number
  isMe: boolean
  recording?: boolean
}

/** Who has a session open; `people` may stop short of `total` in a crowd. */
export interface PresenceList {
  people: Presence[]
  total: number
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
  /** The recording is this browser's own. */
  isMine?: boolean
  /** Recognition dropped out: recording goes on, and the missed stretch is recognized once it is back. */
  recognitionPaused?: boolean
  /** Paused only while audio that waited, as through a dropped connection, is saved to be recognized in its place. */
  recognitionCatchingUp?: boolean
}

/**
 * A stretch of recorded audio that recognition missed while it was away.
 * Its lines are recognized later from the saved audio and take sequence
 * numbers kept free for them, so they read in their place.
 */
export interface RecognitionGap {
  id: string
  sessionId: string
  startMs: number
  endMs: number
  sequenceFrom: number
  sequenceTo: number
  state: 'pending' | 'filling' | 'filled' | 'failed'
  attempts: number
  filledSegments: number
  createdAt: string
  updatedAt: string
}

/** Who a link lets in: whoever holds it, or only people signed in here. */
export type ShareAudience = 'anyone' | 'members'

export interface SessionShare {
  id: string
  sessionId: string
  type: 'user' | 'link'
  audience?: ShareAudience
  userId?: string
  displayName?: string
  avatarVersion?: number
  /** For a link: the signed-in people who have joined it. */
  members?: Person[]
  permission: 'view' | 'record'
  createdAt: string
  expiresAt: string | null
  revokedAt?: string | null
  token?: string
}

export interface ShareInput {
  type: 'user' | 'link'
  audience?: ShareAudience
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
  /** The workspace to keep it in; the most recently used when omitted. */
  workspaceId?: string
  title: string
  sourceLanguage: string
  targetLanguage?: string
  recognitionLanguages?: string[]
  diarization?: boolean
}

export type UpdateSessionInput = Omit<CreateSessionInput, 'workspaceId'>

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

/**
 * What the recording browser saw since its last connection, sent with each
 * start so the server can say afterwards why a recording was interrupted.
 */
export interface LiveClientDiagnostics {
  /** Why this connection is made: a first start, or coming back after a drop. */
  reason: 'start' | 'reconnect'
  attempt: number
  /** How the previous connection ended, as the browser saw it. */
  lastClose?: { code: number; reason: string; afterMs: number }
  /** Time the page spent in the background, and without microphone sound, since recording began. */
  hiddenMs: number
  captureGapMs: number
  lostMs: number
  keptMs: number
  audioState: string
  visible: boolean
}
export type LiveNoteEvent = 'hidden' | 'visible' | 'capture_gap' | 'microphone_restarted' | 'microphone_blocked'
export type LiveClientMessage =
  /** Audio is 16-bit, half the bandwidth of the float32 it is kept in; pcm32f is still taken. */
  | { type: 'start'; audio: { encoding: 'pcm16' | 'pcm32f'; sampleRate: number; channels: 1 }; client?: LiveClientDiagnostics }
  | { type: 'end' | 'pause' | 'force_eou' | 'reset_stream' | 'ping' }
  /** Audio kept while the connection was down follows, faster than it was spoken. */
  | { type: 'catch_up'; ms: number }
  /** Something the recording browser noticed; the page going to the background lets the server wait longer for audio. */
  | { type: 'note'; event: LiveNoteEvent; ms?: number }

export type LiveServerMessage =
  | { type: 'ready'; sessionId: string; runId: string; chunkMs: number; offsetMs?: number }
  | { type: 'partial'; text: string; upstreamSequence: number; language?: string; segmentId?: string; sequence?: number; revision?: number; speakerId?: string; startMs?: number }
  | { type: 'final'; segment: Segment; upstreamSequence?: number; detectedLanguage?: string; backfill?: boolean }
  | { type: 'translation'; streamComplete?: boolean; draftComplete?: boolean; retracted?: boolean; phase?: 'draft' | 'final'; sourceRevision?: number; resolvedSourceLanguage?: string; sourceDetection?: Segment['sourceDetection']; targetLanguage?: string; segmentId: string; status: TranslationStatus; translation: string; error?: string; requestId?: string; revision?: number }
  | { type: 'speaker'; segmentId: string; speakerId: string; speakerLabel?: string }
  /** A saved line's text changed: the closing mark that arrived with the next line was given back to it. */
  | { type: 'source_text'; segmentId: string; sourceText: string }
  | { type: 'snapshot'; session: InterpretationSession; segments: Segment[]; access?: ViewerAccess; recording?: RecordingState; presence?: PresenceList; recognitionGaps?: RecognitionGap[] }
  | { type: 'recording'; recording: RecordingState }
  | { type: 'presence'; presence: PresenceList }
  /** Recognition paused, and why: gone away, or catching up on audio that waited. */
  | { type: 'recognition'; state: 'interrupted' | 'recovered'; sinceMs?: number; atMs?: number; reason?: 'unavailable' | 'catching_up' }
  | { type: 'gap'; gap: RecognitionGap }
  | { type: 'provider_error'; provider: 'asr' | 'translator'; code: string }
  | { type: 'stopped'; status: InterpretationStatus }
  | { type: 'error'; code: string; message: string }

export interface RecognitionCapabilities {
  configured: boolean
  /** Whether a recording could start now: recognition is up and has room. */
  available?: boolean
  languages: string[]
  automatic: boolean
  diarization: boolean
}

/** What one account may use; zero minutes or megabytes means no limit. */
export interface UserLimits {
  concurrentRecordings: number
  monthlyRecordingMinutes: number
  storageMb: number
  workspaces: number
  guestLinks: boolean
}

/**
 * Whether a session could be recorded now, and if not, why: the viewer may
 * not record, the session is archived, its owner's storage is full or
 * recording time used up, the owner is already recording as many sessions as
 * allowed, or recognition cannot take a new stream.
 */
export interface RecordingAdmission {
  allowed: boolean
  reason?: 'not_permitted' | 'archived' | 'storage_full' | 'recording_time_used' | 'recording_limit' | 'recognition_unavailable'
}

/** One account set apart from the defaults; null keeps a default. */
export type LimitOverrides = { [K in keyof UserLimits]: UserLimits[K] | null }

/** An account's use measured against its limits. */
export interface AccountStanding {
  monthRecordedSeconds: number
  storageBytes: number
  activeRecordings: number
  sessions: number
  workspaces: number
  lastSeen: string | null
}

/** How one account signs in, as an administrator sees it. */
export interface AdminUserSecurity {
  passkeys: Passkey[]
  sessions: BrowserSession[]
}

/** The limits of every account not set apart, and the built-in ones they started as. */
export interface DefaultLimits {
  defaults: UserLimits
  builtIn: UserLimits
}

export interface AdminUserDetail {
  user: User
  limits: { effective: UserLimits; overrides: LimitOverrides; defaults: UserLimits }
  settings: UserSettings
  standing: AccountStanding
}

export interface UsageDay {
  date: string
  recordedSeconds: number
  speechSeconds: number
  sessions: number
  segments: number
  sourceCharacters: number
  translations: number
  translationCharacters: number
  translationFailures: number
  shares: number
  activeUsers?: number
  signIns?: number
  newUsers?: number
  guestViews?: number
}

export interface UsageSlice { key: string; label?: string; value: number; count?: number }

export interface UsageReport {
  from: string
  to: string
  days: UsageDay[]
  languages: UsageSlice[]
  targets: UsageSlice[]
  workspaces: UsageSlice[]
  /** Speech seconds by weekday (0 = Sunday) and hour, in the reader's time. */
  hours: number[][]
  topSessions: Array<{ id: string; title: string; ownerName?: string; recordedSeconds: number; segments: number; createdAt: string }>
  speakers: UsageSlice[]
  audioBytes: number
  transcriptBytes: number
  users?: Array<{ id: string; displayName: string; username: string; avatarVersion?: number; recordedSeconds: number; sessions: number; translations: number; storageBytes: number; lastSeen: string | null }>
  translationFailures?: UsageSlice[]
  sessionStatuses?: UsageSlice[]
}

export interface UsageQuery { days: number; offset: number; workspace?: string; user?: string }

/**
 * How much room one account's recordings take and how much it has left.
 * `limitBytes` is zero without a storage limit; `availableBytes` is the
 * smaller of what the limit leaves and what the server's disk has free, or
 * null when neither is known.
 */
export interface AccountStorage {
  usedBytes: number
  audioBytes: number
  transcriptBytes: number
  limitBytes: number
  availableBytes: number | null
  sessions: number
  archivedSessions: number
  sessionsWithAudio: number
  workspaces: number
  workspaceLimit: number
}
export interface AccountUsage { report: UsageReport; limits: UserLimits; standing: AccountStanding }
export interface SiteUsage { report: UsageReport; user?: User; limits?: UserLimits; standing?: AccountStanding }

/** One provider's latest sample; `value` is its own report, as it gave it. */
export interface ProviderReading<T> { configured: boolean; reachable: boolean; error?: string; at: string; value: T | null }

export interface RecognitionLoad {
  observed_at_ms: number
  ready: boolean
  can_accept_new_session: boolean
  admission_reason: string
  health: string
  asr_backend: string
  slots: { active: number; free: number; max: number; rejected_total: number } | null
  queue: { sampled_sessions: number; complete: boolean; limit_ms: number; pending_ms_p50: number; pending_ms_p95: number; pending_ms_max: number; sessions_above_half_limit: number; sessions_at_limit: number } | null
  pressure: { state: string; signals: string[] | null }
  engine: { chunk_ms: number; tick_ms_p50: number; tick_ms_p95: number; tick_ms_max: number; tick_ms_avg: number; batch_size_max: number; active_slots: number; fatal_errors_total: number | null; vram_allocated_mb: number | null } | null
  worker: { alive: boolean; last_tick_age_ms: number | null; stalled: boolean; tick_errors_total: number } | null
  event_loop: { lag_ms_p95: number | null; saturated: boolean | null } | null
  input_dropped_ms_total: number | null
  input_drop_age_ms: number | null
}

export interface RecognitionDiagnostics {
  ws_ingest: { msg_per_sec: number; mbytes: number; cpu_ms_per_sec: number }
  engine: { decode_streams_total: number; language_switch_total: number; reset_stream_total: number; force_barrier_total: number; c_api_errors: number }
  diar: { enabled: boolean; active_slots: number; max_speakers: number; step_ms_p50: number | null; step_ms_p95: number | null; budget_ms: number }
  embedding: { enabled: boolean; model: string; active_slots: number; embeddings_total: number }
  vram: { live: { allocated_mb: number; reserved_mb: number; max_allocated_mb: number; driver_used_mb: number; driver_total_mb: number }; by_stage: Array<{ stage: string; driver_used_mb: number }> | null }
  sessions: { max_slots: number; active: number; total_tracked: number }
}

export interface TranslatorStatus {
  status: string
  can_accept_now: boolean
  retry_after_seconds: number | null
  model: string
  capacity: { active: number; active_limit: number; queued: number; queue_limit: number; admitted: number; admitted_limit: number; available_admission: number }
  dependencies: { engine_ready: boolean; detector_ready: boolean }
  engine_metrics: { available: boolean; running: number | null; waiting: number | null; kv_cache_usage_ratio: number | null }
}

export interface GpuDevice {
  index: number
  name: string
  driver: string
  memoryTotalMb: number | null
  memoryUsedMb: number | null
  utilization: number | null
  memoryUtilization: number | null
  temperatureC: number | null
  powerDrawW: number | null
  powerLimitW: number | null
  fanSpeed: number | null
  smClockMhz: number | null
  memoryClockMhz: number | null
  pstate: string
}

/** One point of the monitoring history; null is a sample that was not taken. */
export interface OperationsSample {
  t: string
  asrUp: boolean
  asrActive: number | null
  asrMax: number | null
  asrPendingP95: number | null
  asrTickP95: number | null
  asrLagP95: number | null
  asrElevated: boolean
  trUp: boolean
  trActive: number | null
  trQueued: number | null
  trRunning: number | null
  trWaiting: number | null
  trKv: number | null
  gpuUtil: number | null
  gpuMemUsedMb: number | null
  gpuMemTotalMb: number | null
  gpuTempC: number | null
  gpuPowerW: number | null
  recordings: number
  watchers: number
}

export interface OperationsReport {
  snapshot: {
    sampledAt: string
    intervalSeconds: number
    asr: ProviderReading<RecognitionLoad>
    diagnostics: ProviderReading<RecognitionDiagnostics>
    translator: ProviderReading<TranslatorStatus>
    gpu: ProviderReading<GpuDevice[]>
    activity: { recordings: number; watchers: number; rooms: number }
    history: OperationsSample[]
  }
  backlog: { gapsPending: number; gapsFilling: number; gapsFailed: number; translationsRetrying: number }
}

export interface SiteSettings {
  registrationHelpMarkdown: string
  codeAttemptsPerMinute: number
  /** The least time between live translations of a line still being spoken; 0 asks again at once. */
  draftTranslationIntervalMs: number
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
    /** Everything visible, or one of the user's workspaces, or only what was shared with them. */
    list(query?: { status?: InterpretationStatus; limit?: number; offset?: number; workspace?: string; shared?: boolean }): Promise<SessionListResponse>
    /** Keeps one of the user's sessions in another of their workspaces. */
    move(id: string, workspaceId: string): Promise<InterpretationSession>
    create(input: CreateSessionInput): Promise<InterpretationSession>
    get(id: string): Promise<SessionDetailResponse>
    update(id: string, input: UpdateSessionInput): Promise<InterpretationSession>
    remove(id: string): Promise<void>
    archive(id: string): Promise<InterpretationSession>
    unarchive(id: string): Promise<InterpretationSession>
    recognition(id: string, languages: string[], diarization?: boolean): Promise<InterpretationSession>
    language(id: string, targetLanguage: string): Promise<ViewerAccess>
    stopRecorder(id: string): Promise<void>
    /** Asked while a recording could be started, so the page can say why it can't. */
    recordingAdmission(id: string): Promise<RecordingAdmission>
    segments(id: string, query?: SegmentQuery): Promise<SegmentPageResponse>
  }
  workspaces: {
    list(): Promise<WorkspaceListResponse>
    create(input: WorkspaceInput): Promise<Workspace>
    /** Sets both its name and its icon. */
    update(id: string, input: WorkspaceInput): Promise<Workspace>
    /** `moveTo` receives its sessions; required whenever it has any. */
    remove(id: string, moveTo?: string): Promise<{ moved: number }>
    /** Records that the user has just opened it. */
    use(id: string): Promise<void>
    /** Pins it above the other workspaces, or unpins it. */
    pin(id: string, pinned: boolean): Promise<Workspace>
  }
  account: {
    /** Changes the name the signed-in person is shown by, or whether others can find them, or both. */
    updateProfile(input: { displayName?: string; discoverable?: boolean }): Promise<User>
    /** Keeps a PNG or JPEG picture for the signed-in person. */
    setAvatar(image: Blob): Promise<User>
    removeAvatar(): Promise<User>
    /** Where a person's picture is read from: by its owner, administrators, and — once they can be found — anyone signed in. */
    avatarUrl(userId: string, version: number): string
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
    /** One account in full, for the people page's side panel. */
    userDetail(id: string): Promise<AdminUserDetail>
    /** Deletes an account and everything it holds; authorized for that account only. */
    deleteUser(authorizationToken: string, id: string): Promise<void>
    /** Each change is sent exactly as its passkey authorization was scoped: see adminChanges. */
    setUserLimits(authorizationToken: string, id: string, body: string): Promise<AdminUserDetail['limits']>
    updateUserProfile(authorizationToken: string, id: string, body: string): Promise<User>
    updateUserSettings(authorizationToken: string, id: string, body: string): Promise<UserSettings>
    usage(query: UsageQuery): Promise<SiteUsage>
    operations(): Promise<OperationsReport>
    /** One account's passkeys and signed-in browsers. */
    userSecurity(id: string): Promise<AdminUserSecurity>
    /** Removals are authorized for one passkey or browser: see adminRemovalScope. */
    deleteUserPasskey(authorizationToken: string, userId: string, passkeyId: string): Promise<void>
    revokeUserSession(authorizationToken: string, userId: string, sessionId: string): Promise<void>
    defaultLimits(): Promise<DefaultLimits>
    /** Sent exactly as its passkey authorization was scoped: see defaultLimitsChange. */
    setDefaultLimits(authorizationToken: string, body: string): Promise<DefaultLimits>
  }
  usage: {
    mine(query: UsageQuery): Promise<AccountUsage>
    /** The signed-in account's storage, for the sidebar. */
    storage(): Promise<AccountStorage>
  }
  sharing: {
    list(sessionId: string): Promise<SessionShare[]>
    create(sessionId: string, input: ShareInput): Promise<SessionShare>
    update(sessionId: string, shareId: string, input: Pick<ShareInput, 'permission' | 'expiresAt'>): Promise<SessionShare>
    revoke(sessionId: string, shareId: string): Promise<void>
    /** People who have chosen to be found, by name. */
    recipients(query: string): Promise<Person[]>
    /** Opens a link as a guest; a link for signed-in people only is refused with SIGN_IN_REQUIRED. */
    redeem(token: string, language: string): Promise<{ sessionId: string }>
    /** Opens a link as the signed-in person, who keeps access while the link lasts. */
    join(token: string): Promise<{ sessionId: string }>
    /** The picture of someone who may see a session, for someone else who may. */
    personAvatarUrl(sessionId: string, userId: string, version: number): string
  }
  audio: {
    list(sessionId: string): Promise<SessionAudio>
    partUrl(sessionId: string, partId: string): string
    bundleUrl(sessionId: string): string
  }
  eventsUrl(sessionId: string): string
  /** `resume` goes on with this browser's own recording after its connection dropped. */
  liveSocketUrl(sessionId: string, takeover?: boolean, resume?: boolean): string
}
