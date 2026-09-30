import type { ApiService, InterpretationSession, ViewerAccess, SessionShare, ShareInput, ProviderEndpoints, Person } from './contracts'
import { dispatchAuthSessionInvalid } from './sessionInvalid'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'request_failed',
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)) })
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

class HttpApi implements ApiService {
  readonly mode = 'http' as const
  private readonly prefix = '/api/v1'

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await fetch(`${this.prefix}${path}`, { ...init, headers, credentials: 'include' })
    if (response.status === 204) return undefined as T
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const error = body.error as Record<string, unknown> | undefined
      const code = typeof error?.code === 'string' ? error.code : 'request_failed'
      const message = typeof error?.message === 'string' ? error.message : `Request failed (${response.status})`
      const isUnauthenticatedCeremony = path === '/auth/me'
        || path.startsWith('/auth/login/')
        || path.startsWith('/auth/register/')
        || path === '/passkeys/authorize/finish'
      if (response.status === 401 && !isUnauthenticatedCeremony) {
        dispatchAuthSessionInvalid({ reason: 'expired', message })
      } else if (response.status === 403 && code.toUpperCase() === 'ACCOUNT_DISABLED') {
        dispatchAuthSessionInvalid({ reason: 'account_disabled', message })
      }
      throw new ApiError(
        message,
        response.status,
        code,
        error?.details,
        response.headers.has('Retry-After') && Number.isFinite(Number(response.headers.get('Retry-After'))) ? Math.max(0,Number(response.headers.get('Retry-After'))) : undefined,
      )
    }
    return body as T
  }

  site = {content:()=>this.request<import('./contracts').SiteContent>('/site-content')}

  recognition = { capabilities: () => this.request<import('./contracts').RecognitionCapabilities>('/recognition/capabilities') }

  auth = {
    code: (code:string) => this.request<import('./contracts').CodeResult>('/auth/code', {method:'POST',body:JSON.stringify({code})}),
    me: () => this.request<Awaited<ReturnType<ApiService['auth']['me']>>>('/auth/me'),
    loginBegin: () => this.request<Awaited<ReturnType<ApiService['auth']['loginBegin']>>>('/auth/login/begin', { method: 'POST', body: '{}' }),
    loginFinish: (ceremonyToken: string, credential: Parameters<ApiService['auth']['loginFinish']>[1]) => this.request<Awaited<ReturnType<ApiService['auth']['loginFinish']>>>('/auth/login/finish', { method: 'POST', headers: { 'X-WebAuthn-Ceremony': ceremonyToken }, body: JSON.stringify(credential) }),
    registrationBegin: (input: Parameters<ApiService['auth']['registrationBegin']>[0]) => this.request<Awaited<ReturnType<ApiService['auth']['registrationBegin']>>>('/auth/register/begin', { method: 'POST', body: JSON.stringify(input) }),
    registrationFinish: (ceremonyToken: string, credential: Parameters<ApiService['auth']['registrationFinish']>[1]) => this.request<Awaited<ReturnType<ApiService['auth']['registrationFinish']>>>('/auth/register/finish', { method: 'POST', headers: { 'X-WebAuthn-Ceremony': ceremonyToken }, body: JSON.stringify(credential) }),
    logout: () => this.request<void>('/auth/logout', { method: 'POST' }),
  }

  browserSessions = {
    list: async () => (await this.request<{ items: Awaited<ReturnType<ApiService['browserSessions']['list']>> }>('/auth/sessions')).items,
    revoke: (id: string, authorizationToken?: string) => this.request<void>(`/auth/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authorizationToken ? { 'X-Passkey-Authorization': authorizationToken } : undefined,
    }),
    revokeOthers: (authorizationToken: string) => this.request<Awaited<ReturnType<ApiService['browserSessions']['revokeOthers']>>>('/auth/sessions/revoke-others', {
      method: 'POST', headers: { 'X-Passkey-Authorization': authorizationToken },
    }),
  }

  sessions = {
    list: (query: Parameters<ApiService['sessions']['list']>[0] = {}) => this.request<Awaited<ReturnType<ApiService['sessions']['list']>>>(`/view/sessions${queryString({ status: query.status, limit: query.limit, offset: query.offset, workspace: query.workspace, shared: query.shared ? 'true' : undefined })}`),
    move: (id: string, workspaceId: string) => this.request<InterpretationSession>(`/sessions/${encodeURIComponent(id)}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId }) }),
    create: (input: Parameters<ApiService['sessions']['create']>[0]) => this.request<Awaited<ReturnType<ApiService['sessions']['create']>>>('/sessions', { method: 'POST', body: JSON.stringify(input) }),
    get: (id: string) => this.request<Awaited<ReturnType<ApiService['sessions']['get']>>>(`/view/sessions/${encodeURIComponent(id)}`),
    update: (id: string, input: Parameters<ApiService['sessions']['update']>[1]) => this.request<Awaited<ReturnType<ApiService['sessions']['update']>>>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (id: string) => this.request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    archive: (id: string) => this.request<InterpretationSession>(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
    unarchive: (id: string) => this.request<InterpretationSession>(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'DELETE' }),
    recognition: (id: string, recognitionLanguages: string[], diarization?: boolean) => this.request<InterpretationSession>(`/view/sessions/${encodeURIComponent(id)}/recognition`, {method:'PUT',body:JSON.stringify({recognitionLanguages,...(diarization !== undefined ? {diarization} : {})})}),
    language: (id: string, targetLanguage: string) => this.request<ViewerAccess>(`/view/sessions/${encodeURIComponent(id)}/language`, { method: 'PUT', body: JSON.stringify({ targetLanguage }) }),
    stopRecorder: (id: string) => this.request<void>(`/view/sessions/${encodeURIComponent(id)}/recording/stop`, { method: 'POST' }),
    recordingAdmission: (id: string) => this.request<import('./contracts').RecordingAdmission>(`/view/sessions/${encodeURIComponent(id)}/recording-admission`),
    segments: (id: string, query: Parameters<ApiService['sessions']['segments']>[1] = {}) => this.request<Awaited<ReturnType<ApiService['sessions']['segments']>>>(`/view/sessions/${encodeURIComponent(id)}/segments${queryString({ atMs: query.atMs === undefined ? undefined : Math.floor(query.atMs), after: query.after, before: query.before, tail: query.tail ? 'true' : undefined, search: query.search, limit: query.limit })}`),
  }

  workspaces = {
    list: () => this.request<import('./contracts').WorkspaceListResponse>('/workspaces'),
    create: (input: import('./contracts').WorkspaceInput) => this.request<import('./contracts').Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ name: input.name, icon: input.icon }) }),
    update: (id: string, input: import('./contracts').WorkspaceInput) => this.request<import('./contracts').Workspace>(`/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: input.name, icon: input.icon }) }),
    remove: (id: string, moveTo?: string) => this.request<{ moved: number }>(`/workspaces/${encodeURIComponent(id)}${queryString({ moveTo })}`, { method: 'DELETE' }),
    use: (id: string) => this.request<void>(`/workspaces/${encodeURIComponent(id)}/use`, { method: 'POST' }),
    pin: (id: string, pinned: boolean) => this.request<import('./contracts').Workspace>(`/workspaces/${encodeURIComponent(id)}/pinned`, { method: 'PUT', body: JSON.stringify({ pinned }) }),
  }

  account = {
    updateProfile: (input: { displayName?: string; discoverable?: boolean }) => this.request<import('./contracts').User>('/account/profile', { method: 'PATCH', body: JSON.stringify({ displayName: input.displayName, discoverable: input.discoverable }) }),
    setAvatar: (image: Blob) => this.request<import('./contracts').User>('/account/avatar', { method: 'PUT', headers: { 'Content-Type': image.type }, body: image }),
    removeAvatar: () => this.request<import('./contracts').User>('/account/avatar', { method: 'DELETE' }),
    avatarUrl: (userId: string, version: number) => `${this.prefix}/users/${encodeURIComponent(userId)}/avatar?v=${version}`,
  }

  settings = {
    updateInterface: (input:Pick<import('./contracts').UserSettings,'interfaceLanguage'|'themePreference'>)=>this.request<import('./contracts').UserSettings>('/settings/interface',{method:'PATCH',body:JSON.stringify(input)}),
    get: () => this.request<Awaited<ReturnType<ApiService['settings']['get']>>>('/settings'),
    update: (input: Parameters<ApiService['settings']['update']>[0]) => this.request<Awaited<ReturnType<ApiService['settings']['update']>>>('/settings', { method: 'PUT', body: JSON.stringify(input) }),
  }
	passkeys = {
		list: async () => (await this.request<{ items: Awaited<ReturnType<ApiService['passkeys']['list']>> }>('/passkeys')).items,
		authorizationBegin: (scope?: string) => this.request<Awaited<ReturnType<ApiService['passkeys']['authorizationBegin']>>>('/passkeys/authorize/begin', { method: 'POST', body: scope ? JSON.stringify({ scope }) : undefined }),
		authorizationFinish: (ceremonyToken: string, credential: Parameters<ApiService['passkeys']['authorizationFinish']>[1]) => this.request<Awaited<ReturnType<ApiService['passkeys']['authorizationFinish']>>>('/passkeys/authorize/finish', { method: 'POST', headers: { 'X-WebAuthn-Ceremony': ceremonyToken }, body: JSON.stringify(credential) }),
		registrationBegin: (authorizationToken: string, input: Parameters<ApiService['passkeys']['registrationBegin']>[1]) => this.request<Awaited<ReturnType<ApiService['passkeys']['registrationBegin']>>>('/passkeys/begin', { method: 'POST', headers: { 'X-Passkey-Authorization': authorizationToken }, body: JSON.stringify(input) }),
		registrationFinish: (ceremonyToken: string, credential: Parameters<ApiService['passkeys']['registrationFinish']>[1]) => this.request<Awaited<ReturnType<ApiService['passkeys']['registrationFinish']>>>('/passkeys/finish', { method: 'POST', headers: { 'X-WebAuthn-Ceremony': ceremonyToken }, body: JSON.stringify(credential) }),
		remove: (authorizationToken: string, id: string) => this.request<void>(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-Passkey-Authorization': authorizationToken } }),
	}
  sharing = {
    list: async (id: string) => (await this.request<{ items: SessionShare[] }>(`/sessions/${encodeURIComponent(id)}/shares`)).items,
    create: (id: string, input: ShareInput) => this.request<SessionShare>(`/sessions/${encodeURIComponent(id)}/shares`, { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, shareId: string, input: Pick<ShareInput, 'permission' | 'expiresAt'>) => this.request<SessionShare>(`/sessions/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    revoke: (id: string, shareId: string) => this.request<void>(`/sessions/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' }),
    recipients: async (query: string) => (await this.request<{ items: Person[] }>(`/share-recipients${queryString({ q: query })}`)).items,
    redeem: (token: string, language: string) => this.request<{ sessionId: string }>('/share-access', { method: 'POST', body: JSON.stringify({ token, language }) }),
    join: (token: string) => this.request<{ sessionId: string }>('/share-membership', { method: 'POST', body: JSON.stringify({ token }) }),
    personAvatarUrl: (sessionId: string, userId: string, version: number) => `${this.prefix}/view/sessions/${encodeURIComponent(sessionId)}/people/${encodeURIComponent(userId)}/avatar?v=${version}`,
  }
  admin = {
    siteSettings:()=>this.request<import('./contracts').SiteSettings>('/admin/site-settings'),
    updateSiteSettings:(authorizationToken:string,input:import('./contracts').SiteSettings)=>this.request<import('./contracts').SiteSettings>('/admin/site-settings',{method:'PUT',headers:{'X-Passkey-Authorization':authorizationToken},body:JSON.stringify(input)}),
    createCode: (authorizationToken:string,input:import('./contracts').CreateCodeInput) => this.request<import('./contracts').CreatedCode>('/admin/codes', {method:'POST',headers:{'X-Passkey-Authorization':authorizationToken},body:JSON.stringify(input)}),
    providers: () => this.request<ProviderEndpoints>('/admin/providers'),
    updateProviders: (authorizationToken: string, input: ProviderEndpoints) => this.request<ProviderEndpoints>('/admin/providers', { method: 'PUT', headers: { 'X-Passkey-Authorization': authorizationToken }, body: JSON.stringify({ asrUrl: input.asrUrl, translatorUrl: input.translatorUrl }) }),
    invitations: async (query: Parameters<ApiService['admin']['invitations']>[0] = {}) => (await this.request<{ items: Awaited<ReturnType<ApiService['admin']['invitations']>> }>(`/admin/invitations${queryString({ limit: query.limit, offset: query.offset })}`)).items,
    createInvitation: (authorizationToken: string, input: Parameters<ApiService['admin']['createInvitation']>[1]) => this.request<Awaited<ReturnType<ApiService['admin']['createInvitation']>>>('/admin/invitations', { method: 'POST', headers: { 'X-Passkey-Authorization': authorizationToken }, body: JSON.stringify(input) }),
    revokeInvitation: (authorizationToken: string, id: string) => this.request<void>(`/admin/invitations/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: { 'X-Passkey-Authorization': authorizationToken } }),
    users: async (query: Parameters<ApiService['admin']['users']>[0] = {}) => (await this.request<{ items: Awaited<ReturnType<ApiService['admin']['users']>> }>(`/admin/users${queryString({ limit: query.limit, offset: query.offset })}`)).items,
    updateUser: (authorizationToken: string, id: string, input: Parameters<ApiService['admin']['updateUser']>[2]) => this.request<Awaited<ReturnType<ApiService['admin']['updateUser']>>>(`/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'X-Passkey-Authorization': authorizationToken }, body: JSON.stringify(input) }),
    audit: async (query: Parameters<ApiService['admin']['audit']>[0] = {}) => (await this.request<{ items: Awaited<ReturnType<ApiService['admin']['audit']>> }>(`/admin/audit${queryString({ limit: query.limit, offset: query.offset })}`)).items,
    userDetail: (id: string) => this.request<import('./contracts').AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`),
    deleteUser: (authorizationToken: string, id: string) => this.request<void>(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-Passkey-Authorization': authorizationToken } }),
    setUserLimits: (authorizationToken: string, id: string, body: string) => this.request<import('./contracts').AdminUserDetail['limits']>(`/admin/users/${encodeURIComponent(id)}/limits`, { method: 'PUT', headers: { 'X-Passkey-Authorization': authorizationToken }, body }),
    updateUserProfile: (authorizationToken: string, id: string, body: string) => this.request<import('./contracts').User>(`/admin/users/${encodeURIComponent(id)}/profile`, { method: 'PATCH', headers: { 'X-Passkey-Authorization': authorizationToken }, body }),
    updateUserSettings: (authorizationToken: string, id: string, body: string) => this.request<import('./contracts').UserSettings>(`/admin/users/${encodeURIComponent(id)}/settings`, { method: 'PUT', headers: { 'X-Passkey-Authorization': authorizationToken }, body }),
    usage: (query: import('./contracts').UsageQuery) => this.request<import('./contracts').SiteUsage>(`/admin/usage${queryString({ days: query.days, offset: query.offset, user: query.user })}`),
    operations: () => this.request<import('./contracts').OperationsReport>('/admin/operations'),
    userSecurity: (id: string) => this.request<import('./contracts').AdminUserSecurity>(`/admin/users/${encodeURIComponent(id)}/security`),
    deleteUserPasskey: (authorizationToken: string, userId: string, passkeyId: string) => this.request<void>(`/admin/users/${encodeURIComponent(userId)}/passkeys/${encodeURIComponent(passkeyId)}`, { method: 'DELETE', headers: { 'X-Passkey-Authorization': authorizationToken } }),
    revokeUserSession: (authorizationToken: string, userId: string, sessionId: string) => this.request<void>(`/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { 'X-Passkey-Authorization': authorizationToken } }),
    defaultLimits: () => this.request<import('./contracts').DefaultLimits>('/admin/limits'),
    setDefaultLimits: (authorizationToken: string, body: string) => this.request<import('./contracts').DefaultLimits>('/admin/limits', { method: 'PUT', headers: { 'X-Passkey-Authorization': authorizationToken }, body }),
  }
  usage = {
    mine: (query: import('./contracts').UsageQuery) => this.request<import('./contracts').AccountUsage>(`/account/usage${queryString({ days: query.days, offset: query.offset, workspace: query.workspace })}`),
    storage: () => this.request<import('./contracts').AccountStorage>('/account/storage'),
  }

  audio = {
    list: (id: string) => this.request<Awaited<ReturnType<ApiService['audio']['list']>>>(`/view/sessions/${encodeURIComponent(id)}/audio`),
    partUrl: (id: string, partId: string) => `${this.prefix}/view/sessions/${encodeURIComponent(id)}/audio/${encodeURIComponent(partId)}`,
    bundleUrl: (id: string) => `${this.prefix}/sessions/${encodeURIComponent(id)}/bundle`,
  }
  eventsUrl(sessionId: string) { return `${this.prefix}/view/sessions/${encodeURIComponent(sessionId)}/events` }
  liveSocketUrl(sessionId: string, takeover = false, resume = false) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}${this.prefix}/view/sessions/${encodeURIComponent(sessionId)}/record${queryString({ takeover: takeover ? 'true' : undefined, resume: resume ? 'true' : undefined })}`
  }
}

// The compile-time development gate removes the entire dynamic import in a
// production build, including seed creation and storage initialization.
export const api: ApiService = __TLINGUAL_DEVELOPMENT_MOCK__ ? new (await import('./mock')).MockApi() : new HttpApi()
