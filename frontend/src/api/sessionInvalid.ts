export const AUTH_SESSION_INVALID_EVENT = 't-lingual:auth-session-invalid'

export type AuthSessionInvalidDetail = {
  reason: 'expired' | 'account_disabled'
  message?: string
}

export function dispatchAuthSessionInvalid(detail: AuthSessionInvalidDetail) {
  window.dispatchEvent(new CustomEvent<AuthSessionInvalidDetail>(AUTH_SESSION_INVALID_EVENT, { detail }))
}

export function subscribeAuthSessionInvalid(listener: (detail: AuthSessionInvalidDetail) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<AuthSessionInvalidDetail>).detail)
  window.addEventListener(AUTH_SESSION_INVALID_EVENT, handle)
  return () => window.removeEventListener(AUTH_SESSION_INVALID_EVENT, handle)
}
