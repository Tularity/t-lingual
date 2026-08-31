import { useEffect, type ReactNode } from 'react'
import { AppShell, Brand } from './app/AppShell'
import { useAuth } from './app/auth'
import { matchPath, useRouter } from './app/router'
import { LoginPage, RegisterPage } from './features/auth/AuthPages'
import { SessionsPage } from './features/sessions/SessionsPage'
import { SessionDetailPage } from './features/sessions/SessionDetailPage'
import { LivePage } from './features/live/LivePage'
import { SettingsPage } from './features/settings/SettingsPage'
import { AdminPage } from './features/admin/AdminPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { Button, Card, EmptyState } from './design-system'

export default function App() {
  const { status, user, error, failure, refresh } = useAuth()
  const { path, navigate } = useRouter()
  const isAuthPath = path === '/login' || path === '/register'
  useEffect(() => {
    if (status === 'anonymous' && !isAuthPath) navigate('/login', { replace: true })
    if (status === 'authenticated' && isAuthPath) navigate('/sessions', { replace: true })
  }, [isAuthPath, navigate, status])
  if (status === 'loading') return <main className="app-boot" aria-label="Loading T Lingual"><Brand /><span className="app-boot__wave" aria-hidden="true"><i /><i /><i /><i /><i /></span><span className="sr-only" role="status">Loading your workspace</span></main>
  if (status === 'error') return <main className="auth-service-error"><Card><EmptyState icon="warning" title={failure === 'account_disabled' ? 'Your account is disabled' : 'T Lingual is temporarily unavailable'} description={error || 'Your sign-in status could not be verified. No account changes were made.'} action={<Button variant="primary" onClick={() => void refresh()}>{failure === 'account_disabled' ? 'Check access again' : 'Try again'}</Button>} /></Card></main>
  if (status === 'anonymous') return path === '/register' ? <RegisterPage /> : <LoginPage />
  if (isAuthPath) return null

  let page: ReactNode
  const liveParams = matchPath('/live/:sessionId', path)
  const detailParams = matchPath('/history/:sessionId', path)
  if (path === '/' || path === '/sessions') page = <SessionsPage key="sessions" />
  else if (path === '/history') page = <SessionsPage key="history" historyOnly />
  else if (liveParams?.sessionId) page = <LivePage key={liveParams.sessionId} sessionId={liveParams.sessionId} />
  else if (detailParams?.sessionId) page = <SessionDetailPage key={detailParams.sessionId} sessionId={detailParams.sessionId} />
  else if (path === '/settings') page = <SettingsPage />
  else if (path === '/admin') page = user?.role === 'admin' ? <AdminPage /> : <NotFoundPage forbidden />
  else page = <NotFoundPage />
  return <AppShell>{page}</AppShell>
}
