import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api } from '../api/client'
import type { AuthSession, SerializedCredential, User, RegistrationInput } from '../api/contracts'
import { subscribeAuthSessionInvalid } from '../api/sessionInvalid'
import { setRecoveryAuthorization } from './passkeyAuthorization'
import { createPasskey, getPasskey } from '../api/webauthn'

interface AuthValue {
  onboardingComplete: boolean
  completeOnboarding: ()=>Promise<void>
  user: User | null
  status: 'loading' | 'anonymous' | 'authenticated' | 'error'
  failure: 'service' | 'account_disabled' | null
  error: string
  code: (code:string)=>Promise<'registration'|'login'>
  registrationTicket: {ticket:string;expiresAt:string}|null
  recoveryExpiresAt: string|null
  recoveryInProgress: boolean
  setRecoveryInProgress: (value:boolean)=>void
  clearRecovery: ()=>void
  clearRegistrationTicket:()=>void
  login: () => Promise<void>
  register: (input: RegistrationInput) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  /** Takes in the signed-in account as the server returned it after a change to it. */
  accountUpdated: (user: User) => void
}

const AuthContext = createContext<AuthValue | null>(null)
const mockCredential: SerializedCredential = { id: 'mock-credential', rawId: 'bW9jaw', type: 'public-key', authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'bW9jaw' } }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [onboardingComplete,setOnboardingComplete]=useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [registrationTicket,setRegistrationTicket]=useState<{ticket:string;expiresAt:string}|null>(null)
  const [recoveryExpiresAt,setRecoveryExpiresAt]=useState<string|null>(null)
  const [recoveryInProgress,setRecoveryInProgress]=useState(false)
  const clearRecovery=useCallback(()=>{setRecoveryAuthorization(null);setRecoveryExpiresAt(null)},[])
  useEffect(()=>{if(!recoveryExpiresAt)return;const timer=window.setTimeout(clearRecovery,Math.min(2147483647,Math.max(0,Date.parse(recoveryExpiresAt)-Date.now())));return()=>window.clearTimeout(timer)},[clearRecovery,recoveryExpiresAt])
  const [status, setStatus] = useState<AuthValue['status']>('loading')
  const [failure, setFailure] = useState<AuthValue['failure']>(null)
  const [error, setError] = useState('')
  const acceptSession = useCallback((session: AuthSession) => {
    setOnboardingComplete(session.onboardingComplete??true)
    setUser(session.user)
    setError('')
    setFailure(null)
    setStatus('authenticated')
  }, [])
  const rejectSession = useCallback((caught: unknown) => {
    setRecoveryAuthorization(null);setRecoveryExpiresAt(null)
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
    setRecoveryAuthorization(null);setRecoveryExpiresAt(null)
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

  const code=useCallback(async (value:string)=>{
    const result=await api.auth.code(value)
    setRecoveryAuthorization(null);setRecoveryExpiresAt(null)
    if(result.kind==='registration') {
      setRegistrationTicket({ticket:result.registrationTicket,expiresAt:result.expiresAt})
    } else {
      setRegistrationTicket(null)
      setRecoveryAuthorization(result.recoveryAuthorization??null)
      setRecoveryExpiresAt(result.recoveryAuthorization?.expiresAt??null)
      acceptSession(result)
    }
    return result.kind
  },[acceptSession])
  const clearRegistrationTicket=useCallback(()=>setRegistrationTicket(null),[])
  const login = useCallback(async () => {
    setRegistrationTicket(null)
    setRecoveryAuthorization(null);setRecoveryExpiresAt(null)
    const options = await api.auth.loginBegin()
    const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await getPasskey(options.options.publicKey)
    const session = await api.auth.loginFinish(options.ceremonyToken, credential)
    setOnboardingComplete(session.onboardingComplete??true)
    setUser(session.user)
    setError('')
    setFailure(null)
    setStatus('authenticated')
  }, [])

  const register = useCallback(async (input: RegistrationInput) => {
    const options = await api.auth.registrationBegin({ ...input, ...(registrationTicket?{registrationTicket:registrationTicket.ticket}:{}), credentialName: 'Primary passkey' })
    const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await createPasskey(options.options.publicKey)
    const session = await api.auth.registrationFinish(options.ceremonyToken, credential)
    setRegistrationTicket(null)
    setOnboardingComplete(session.onboardingComplete??false)
    setUser(session.user)
    setError('')
    setFailure(null)
    setStatus('authenticated')
  }, [registrationTicket])

  const completeOnboarding=useCallback(async()=>{acceptSession(await api.auth.me())},[acceptSession])

  const logout = useCallback(async () => {
    await api.auth.logout()
    setRegistrationTicket(null)
    setRecoveryAuthorization(null);setRecoveryExpiresAt(null)
    setUser(null)
    setError('')
    setFailure(null)
    setStatus('anonymous')
  }, [])

  const accountUpdated = useCallback((next: User) => setUser((current) => current && current.id === next.id ? next : current), [])
  const value = useMemo(() => ({ user, status, failure, error, login, register, logout, refresh,accountUpdated,code,registrationTicket,recoveryExpiresAt,clearRegistrationTicket,onboardingComplete,completeOnboarding,recoveryInProgress,setRecoveryInProgress,clearRecovery }), [user, status, failure, error, login, register, logout, refresh,accountUpdated,code,registrationTicket,recoveryExpiresAt,clearRegistrationTicket,onboardingComplete,completeOnboarding,recoveryInProgress,clearRecovery])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}

/** The signed-in state where there is one; null outside the account's pages. */
export function useOptionalAuth() {
  return useContext(AuthContext)
}
