import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppShell, Brand, InterfaceMenus } from './app/AppShell'
import { Curtain } from './app/Curtain'
import { StageProvider, useStage } from './app/stage'
import { useI18n } from './app/i18n'
import { useAuth } from './app/auth'
import { matchPath, useRouter } from './app/router'
import { LoginPage, RegisterPage } from './features/auth/AuthPages'
import { SessionsPage } from './features/sessions/SessionsPage'
import { SessionDetailPage } from './features/sessions/SessionDetailPage'
import { ShareLanding } from './features/sessions/ShareLanding'
import { Link } from './app/router'
import { LivePage } from './features/live/LivePage'
import { QuickSetupPage } from './features/onboarding/QuickSetupPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { AdminPage } from './features/admin/AdminPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { Button, Card, EmptyState } from './design-system'

export default function App() {
  const { status: authStatus, user, error, failure, refresh, onboardingComplete, recoveryExpiresAt, recoveryInProgress } = useAuth()
  const { path, navigate } = useRouter()
  const { t } = useI18n()
  // Everything below renders the status the screen shows, which trails the
  // real one while a curtain covers the change (see stage.tsx).
  const stage = useStage(authStatus)
  const status = stage.shown
  const { beginSignOut, cancelSignOut } = stage
  const signOutStage = useMemo(() => ({ beginSignOut, cancelSignOut }), [beginSignOut, cancelSignOut])
  // Signing out clears the user before the curtain has covered the workspace;
  // the page underneath keeps the account it was drawn for until then.
  const [shownUser, setShownUser] = useState(user)
  if (user && user !== shownUser) setShownUser(user)
  const sharedParams = matchPath('/shared/:sessionId', path)
  const isSharePath = path === '/share' || Boolean(sharedParams)
  const isAuthPath = path === '/login' || path === '/register'
  useEffect(() => {
    const section = path.startsWith('/live/') ? 'Live interpretation' : path.startsWith('/history/') ? 'Transcript' : path === '/history' ? 'History' : path === '/setup' ? 'Quick setup' : path === '/settings' ? 'Settings' : path === '/admin' ? 'Administration' : path === '/register' ? 'Create your account' : path === '/login' ? 'Welcome back' : 'Sessions'
    document.title = `${t(section)} · t-lingual`
  }, [path, t])
  useEffect(() => {
    // A sign-in still covered by its curtain shows the login page, but has
    // already been sent where it is going; only a real sign-out goes to login.
    if (status === 'anonymous' && authStatus !== 'authenticated' && !isAuthPath && !isSharePath) navigate('/login', { replace: true })
    if(status==='authenticated'&&!isSharePath){
      if(onboardingComplete===false&&path!=='/setup'&&!(path==='/settings'&&(recoveryExpiresAt||recoveryInProgress)))navigate('/setup',{replace:true})
      else if(isAuthPath)navigate(onboardingComplete===false?'/setup':'/sessions',{replace:true})
    }
  }, [authStatus, isAuthPath, isSharePath, navigate, status, onboardingComplete, path, recoveryExpiresAt, recoveryInProgress])
  const view = renderView()
  return <StageProvider value={signOutStage}>
    {view}
    {stage.curtain && !isSharePath && <Curtain key={stage.curtain.id} kind={stage.curtain.kind} stage={stage.curtain.stage} origin={stage.curtain.origin} onSignedIn={stage.finishSignIn} onSettled={stage.endSignIn} />}
  </StageProvider>

  function renderView(): ReactNode {
  if (path === '/share') return <ShareLanding />
  if (sharedParams?.sessionId) return <div className="guest-shell"><header><Brand /><div className="guest-shell__actions"><InterfaceMenus /><Link href={user ? '/sessions' : '/login'}>{user ? t('Your workspace') : t('Sign in')}</Link></div></header><main><LivePage key={sharedParams.sessionId} sessionId={sharedParams.sessionId} guest={!user} /></main></div>
  if (status === 'loading') return <main className="app-boot" aria-label={t('Loading T Lingual')}><span className="sr-only" role="status">{t('Loading your workspace')}</span></main>
  if (status === 'error') return <main className="auth-service-error"><Card><EmptyState icon="warning" title={failure === 'account_disabled' ? t('Your account is disabled') : t('T Lingual is temporarily unavailable')} description={error || t('Your sign-in status could not be verified. No account changes were made.')} action={<Button variant="primary" onClick={() => void refresh()}>{failure === 'account_disabled' ? t('Check access again') : t('Try again')}</Button>} /></Card></main>
  if (status === 'anonymous') return path === '/register' ? <RegisterPage /> : <LoginPage />
  if (isAuthPath || onboardingComplete===false&&path!=='/setup'&&!(path==='/settings'&&(recoveryExpiresAt||recoveryInProgress))) return null

  let page: ReactNode
  const liveParams = matchPath('/live/:sessionId', path)
  const detailParams = matchPath('/history/:sessionId', path)
  if (path === '/' || path === '/sessions') page = <SessionsPage key="sessions" />
  else if (path === '/history') page = <SessionsPage key="history" historyOnly />
  else if (liveParams?.sessionId) page = <LivePage key={liveParams.sessionId} sessionId={liveParams.sessionId} />
  else if (detailParams?.sessionId) page = <SessionDetailPage key={detailParams.sessionId} sessionId={detailParams.sessionId} />
  else if (path === '/setup') page = <QuickSetupPage />
  else if (path === '/settings') page = <SettingsPage />
  else if (path === '/admin') page = shownUser?.role === 'admin' ? <AdminPage /> : <NotFoundPage forbidden />
  else page = <NotFoundPage />
  return <AppShell>{page}</AppShell>
  }
}
