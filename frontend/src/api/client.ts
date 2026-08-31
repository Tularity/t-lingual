import type { ApiService } from './contracts'
import { MockApi } from './mock'
import { dispatchAuthSessionInvalid } from './sessionInvalid'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'request_failed',
    readonly details?: unknown,
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
    if (init.body) headers.set('Content-Type', 'application/json')
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
      )
    }
    return body as T
  }

  auth = {
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
    list: (query: Parameters<ApiService['sessions']['list']>[0] = {}) => this.request<Awaited<ReturnType<ApiService['sessions']['list']>>>(`/sessions${queryString({ status: query.status, limit: query.limit, offset: query.offset })}`),
    create: (input: Parameters<ApiService['sessions']['create']>[0]) => this.request<Awaited<ReturnType<ApiService['sessions']['create']>>>('/sessions', { method: 'POST', body: JSON.stringify(input) }),
    get: (id: string) => this.request<Awaited<ReturnType<ApiService['sessions']['get']>>>(`/sessions/${encodeURIComponent(id)}`),
    update: (id: string, input: Parameters<ApiService['sessions']['update']>[1]) => this.request<Awaited<ReturnType<ApiService['sessions']['update']>>>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (id: string) => this.request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    segments: (id: string, query: Parameters<ApiService['sessions']['segments']>[1] = {}) => this.request<Awaited<ReturnType<ApiService['sessions']['segments']>>>(`/sessions/${encodeURIComponent(id)}/segments${queryString({ after: query.after, limit: query.limit })}`),
  }

  settings = {
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
  admin = {
    invitations: async (query: Parameters<ApiService['admin']['invitations']>[0] = {}) => (await this.request<{ items: Awaited<ReturnType<ApiService['admin']['invitations']>> }>(`/admin/invitations${queryString({ limit: query.limit, offset: query.offset })}`)).items,
    createInvitation: (authorizationToken: string, input: Parameters<ApiService['admin']['createInvitation']>[1]) => this.request<Awaited<ReturnType<ApiService['admin']['createInvitation']>>>('/admin/invitations', { method: 'POST', headers: { 'X-Passkey-Authorization': authorizationToken }, body: JSON.stringify(input) }),
    revokeInvitation: (authorizationToken: string, id: string) => this.request<void>(`/admin/invitations/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: { 'X-Passkey-Authorization': authorizationToken } }),
    users: async (query: Parameters<ApiService['admin']['users']>[0] = {}) => (await this.request<{ items: Awaited<ReturnType<ApiService['admin']['users']>> }>(`/admin/users${queryString({ limit: query.limit, offset: query.offset })}`)).items,
    updateUser: (authorizationToken: string, id: string, input: Parameters<ApiService['admin']['updateUser']>[2]) => this.request<Awaited<ReturnType<ApiService['admin']['updateUser']>>>(`/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'X-Passkey-Authorization': authorizationToken }, body: JSON.stringify(input) }),
    audit: async (query: Parameters<ApiService['admin']['audit']>[0] = {}) => (await this.request<{ items: Awaited<ReturnType<ApiService['admin']['audit']>> }>(`/admin/audit${queryString({ limit: query.limit, offset: query.offset })}`)).items,
  }

  liveSocketUrl(sessionId: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}${this.prefix}/sessions/${encodeURIComponent(sessionId)}/live`
  }
}

export const api: ApiService = __TLINGUAL_DEVELOPMENT_MOCK__ ? new MockApi() : new HttpApi()
