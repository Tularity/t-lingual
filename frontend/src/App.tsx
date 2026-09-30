import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { AppShell, Brand, InterfaceMenus } from './app/AppShell'
import { Curtain } from './app/Curtain'
import { StageProvider, useStage } from './app/stage'
import { WorkspacesProvider, useWorkspaces } from './app/workspaces'
import { useI18n } from './app/i18n'
import { useAuth } from './app/auth'
import { matchPath, useRouter } from './app/router'
import { LoginPage, RegisterPage } from './features/auth/AuthPages'
import { SessionsPage } from './features/sessions/SessionsPage'
import { WorkspacesPage } from './features/workspaces/WorkspacesPage'
import { SessionDetailPage } from './features/sessions/SessionDetailPage'
import { ShareLanding } from './features/sessions/ShareLanding'
import { Link } from './app/router'
import { LivePage } from './features/live/LivePage'
import { QuickSetupPage } from './features/onboarding/QuickSetupPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { AdminRoute, adminSections, type AdminSection } from './features/admin/AdminRoute'
import { AdminDataProvider } from './features/admin/AdminData'
import { NotFoundPage } from './pages/NotFoundPage'
import { Button, Card, EmptyState, LoadingState } from './design-system'

const UsagePage = lazy(() => import('./features/insights/UsagePage').then((module) => ({ default: module.UsagePage })))

/** Goes to another address in place of this one, before anything is drawn. */
function Redirect({ to }: { to: string }) {
  const { navigate } = useRouter()
  useLayoutEffect(() => navigate(to, { replace: true }), [navigate, to])
  return null
}

/** Where signing in and every older address lead: the workspace used last. */
function WorkspaceHome() {
  const { t } = useI18n()
  const workspaces = useWorkspaces()
  if (workspaces.recent) return <Redirect to={`/workspaces/${workspaces.recent.id}`} />
  if (workspaces.status === 'error') return <Card><EmptyState icon="warning" title={t('Workspaces couldn’t be loaded')} description={t('Check your connection and try again.')} action={<Button variant="primary" onClick={() => void workspaces.refresh()}>{t('Try again')}</Button>} /></Card>
  return <LoadingState fill size={200} label={t('Loading your workspace')} />
}

/** One of the user's workspaces; one that is not theirs, or no longer exists, is not here. */
function WorkspaceRoute({ workspaceId }: { workspaceId: string }) {
  const workspaces = useWorkspaces()
  if (workspaces.status === 'ready' && !workspaces.find(workspaceId)) return <NotFoundPage />
  return <SessionsPage scope={{ workspaceId }} />
}

export default function App() {
  const { status: authStatus, user, error, failure, refresh, onboardingComplete, recoveryExpiresAt, recoveryInProgress } = useAuth()
  const { path, navigate } = useRouter()
  const { t } = useI18n()
  // Everything below renders the status the screen shows, which trails the
  // real one while a curtain covers the change (see stage.tsx).
  const stage = useStage(authStatus)
  const status = stage.shown
  const { enterWorkspace, beginSignOut, cancelSignOut } = stage
  const stageControls = useMemo(() => ({ enterWorkspace, beginSignOut, cancelSignOut }), [enterWorkspace, beginSignOut, cancelSignOut])
  // The login page, sliding away as a sign-in begins: it stays in place while
  // it leaves, even once the route has moved on to the workspace.
  const leaving = stage.curtain?.kind === 'enter' && stage.curtain.stage === 'leave'
  // Signing out clears the user before the curtain has covered the workspace;
  // the page underneath keeps the account it was drawn for until then.
  const [shownUser, setShownUser] = useState(user)
  if (user && user !== shownUser) setShownUser(user)
  const sharedParams = matchPath('/shared/:sessionId', path)
  const isSharePath = path === '/share' || Boolean(sharedParams)
  // The site's front door is the welcome page, signed in or not: `/` is `/login`.
  const onLogin = path === '/login' || path === '/'
  const isAuthPath = onLogin || path === '/register'
  useEffect(() => {
    const section = path.startsWith('/live/') ? 'Live interpretation' : path.startsWith('/sessions/') ? 'Transcript' : path === '/workspaces' ? 'Workspaces' : path === '/shared-with-you' ? 'Shared with you' : path === '/setup' ? 'Quick setup' : path === '/settings' ? 'Settings' : path === '/usage' ? 'Usage' : path.startsWith('/admin') ? adminSections.find((section) => section.path === path)?.label ?? 'Administration' : path === '/register' ? 'Create your account' : onLogin ? 'Welcome back' : 'Sessions'
    document.title = `${t(section)} · t-lingual`
  }, [path, onLogin, t])
  // Signed in, the login page stays open: it offers to go on as this account
  // or to sign in with another. Registration has nothing to offer by then.
  const pendingSetup = onboardingComplete === false && path !== '/setup' && !onLogin && !(path === '/settings' && (recoveryExpiresAt || recoveryInProgress))
  // The front door has one address.
  useEffect(() => { if (path === '/') navigate('/login', { replace: true }) }, [path, navigate])
  useEffect(() => {
    // A sign-in still covered by its curtain shows the login page, but has
    // already been sent where it is going; only a real sign-out goes to login.
    if (status === 'anonymous' && authStatus !== 'authenticated' && !isAuthPath && !isSharePath) navigate('/login', { replace: true })
    if(status==='authenticated'&&!isSharePath){
      if(pendingSetup)navigate('/setup',{replace:true})
      else if(path==='/register')navigate(onboardingComplete===false?'/setup':'/sessions',{replace:true})
    }
  }, [authStatus, isAuthPath, isSharePath, navigate, status, onboardingComplete, path, pendingSetup])
  const view = renderView()
  return <StageProvider value={stageControls}>
    <WorkspacesProvider userId={status === 'authenticated' ? shownUser?.id ?? '' : ''}>
      <AdminDataProvider userId={status === 'authenticated' && shownUser?.role === 'admin' ? shownUser.id : ''}>{view}</AdminDataProvider>
    </WorkspacesProvider>
    {stage.curtain && !isSharePath && <Curtain key={stage.curtain.id} kind={stage.curtain.kind} stage={stage.curtain.stage} origin={stage.curtain.origin} onSignedIn={stage.finishSignIn} onSettled={stage.endSignIn} />}
  </StageProvider>

  function renderView(): ReactNode {
  if (path === '/share') return <ShareLanding />
  if (sharedParams?.sessionId) return <div className="guest-shell"><header><Brand /><div className="guest-shell__actions"><InterfaceMenus /><Link href={user ? '/sessions' : '/login'}>{user ? t('Your workspace') : t('Sign in')}</Link></div></header><main><LivePage key={sharedParams.sessionId} sessionId={sharedParams.sessionId} guest={!user} /></main></div>
  if (status === 'loading') return <main className="app-boot" aria-label={t('Loading T Lingual')}><span className="sr-only" role="status">{t('Loading your workspace')}</span></main>
  if (status === 'error') return <main className="auth-service-error"><Card><EmptyState icon="warning" title={failure === 'account_disabled' ? t('Your account is disabled') : t('T Lingual is temporarily unavailable')} description={error || t('Your sign-in status could not be verified. No account changes were made.')} action={<Button variant="primary" onClick={() => void refresh()}>{failure === 'account_disabled' ? t('Check access again') : t('Try again')}</Button>} /></Card></main>
  // The account the login page offers to go on as: the one the screen shows
  // signed in, so a sign-in's own form never turns into it as it leaves.
  const account = status === 'authenticated' ? shownUser : null
  if (status === 'anonymous' || leaving || onLogin) return path === '/register' && !account ? <RegisterPage /> : <LoginPage account={account} />
  if (path === '/register' || pendingSetup) return null

  let page: ReactNode
  const liveParams = matchPath('/live/:sessionId', path)
  const detailParams = matchPath('/sessions/:sessionId', path)
  const workspaceParams = matchPath('/workspaces/:workspaceId', path)
  const earlierDetail = matchPath('/history/:sessionId', path)
  // Sessions and history were once lists of their own; both now live in workspaces.
  if (path === '/sessions' || path === '/history') page = <WorkspaceHome />
  else if (earlierDetail?.sessionId) page = <Redirect to={`/sessions/${encodeURIComponent(earlierDetail.sessionId)}`} />
  else if (path === '/workspaces') page = <WorkspacesPage />
  else if (workspaceParams?.workspaceId) page = <WorkspaceRoute key={workspaceParams.workspaceId} workspaceId={workspaceParams.workspaceId} />
  else if (path === '/shared-with-you') page = <SessionsPage key="shared" scope={{ shared: true }} />
  else if (liveParams?.sessionId) page = <LivePage key={liveParams.sessionId} sessionId={liveParams.sessionId} />
  else if (detailParams?.sessionId) page = <SessionDetailPage key={detailParams.sessionId} sessionId={detailParams.sessionId} />
  else if (path === '/setup') page = <QuickSetupPage />
  else if (path === '/settings') page = <SettingsPage />
  else if (path === '/usage') page = <Suspense fallback={<LoadingState label={t('Loading usage')} />}><UsagePage /></Suspense>
  // Administration is a set of pages; its own address leads to the first.
  else if (path === '/admin') page = shownUser?.role === 'admin' ? <Redirect to={adminSections[0].path} /> : <NotFoundPage forbidden />
  else if (adminSections.some((section) => section.path === path)) page = shownUser?.role === 'admin' ? <AdminRoute path={path as AdminSection} /> : <NotFoundPage forbidden />
  else page = <NotFoundPage />
  return <AppShell>{page}</AppShell>
  }
}
