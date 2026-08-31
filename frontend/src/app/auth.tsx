import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api } from '../api/client'
import type { AuthSession, SerializedCredential, User } from '../api/contracts'
import { subscribeAuthSessionInvalid } from '../api/sessionInvalid'
import { createPasskey, getPasskey } from '../api/webauthn'

interface AuthValue {
  user: User | null
  status: 'loading' | 'anonymous' | 'authenticated' | 'error'
  failure: 'service' | 'account_disabled' | null
  error: string
  login: () => Promise<void>
  register: (input: { invitationCode: string; username: string; displayName: string }) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)
const mockCredential: SerializedCredential = { id: 'mock-credential', rawId: 'bW9jaw', type: 'public-key', authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'bW9jaw' } }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthValue['status']>('loading')
  const [failure, setFailure] = useState<AuthValue['failure']>(null)
  const [error, setError] = useState('')
  const acceptSession = useCallback((session: AuthSession) => {
    setUser(session.user)
    setError('')
    setFailure(null)
    setStatus('authenticated')
  }, [])
  const rejectSession = useCallback((caught: unknown) => {
    setUser(null)
    if (__TLINGUAL_DEVELOPMENT_MOCK__ || (caught instanceof ApiError && caught.status === 401)) {
      setError('')
      setFailure(null)
      setStatus('anonymous')
    } else if (caught instanceof ApiError && caught.status === 403 && caught.code.toUpperCase() === 'ACCOUNT_DISABLED') {
      setError(caught.message || 'This account has been disabled. Contact an administrator for access.')
      setFailure('account_disabled')
      setStatus('error')
    } else {
      setError(caught instanceof Error ? caught.message : 'The authentication service could not be reached.')
      setFailure('service')
      setStatus('error')
    }
  }, [])
  const refresh = useCallback(async () => {
    setStatus('loading')
    setError('')
    setFailure(null)
    try {
      const session = await api.auth.me()
      acceptSession(session)
    } catch (caught) {
      rejectSession(caught)
    }
  }, [acceptSession, rejectSession])
  useEffect(() => {
    let active = true
    void api.auth.me().then((session) => {
      if (active) acceptSession(session)
    }).catch((caught: unknown) => {
      if (active) rejectSession(caught)
    })
    return () => { active = false }
  }, [acceptSession, rejectSession])
  useEffect(() => subscribeAuthSessionInvalid((detail) => {
    setUser(null)
    if (detail.reason === 'account_disabled') {
      setError(detail.message || 'This account has been disabled. Contact an administrator for access.')
      setFailure('account_disabled')
      setStatus('error')
      return
    }
    setError('')
    setFailure(null)
    setStatus('anonymous')
  }), [])

  const login = useCallback(async () => {
    const options = await api.auth.loginBegin()
    const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await getPasskey(options.options.publicKey)
    const session = await api.auth.loginFinish(options.ceremonyToken, credential)
    setUser(session.user)
    setError('')
    setFailure(null)
    setStatus('authenticated')
  }, [])

  const register = useCallback(async (input: { invitationCode: string; username: string; displayName: string }) => {
    const options = await api.auth.registrationBegin({ ...input, credentialName: 'Primary passkey' })
    const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await createPasskey(options.options.publicKey)
    const session = await api.auth.registrationFinish(options.ceremonyToken, credential)
    setUser(session.user)
    setError('')
    setFailure(null)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    await api.auth.logout()
    setUser(null)
    setError('')
    setFailure(null)
    setStatus('anonymous')
  }, [])

  const value = useMemo(() => ({ user, status, failure, error, login, register, logout, refresh }), [user, status, failure, error, login, register, logout, refresh])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
