import { useI18n } from '../../app/i18n'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useRouter } from '../../app/router'
import { useAuth } from '../../app/auth'
import { rememberShare } from '../../app/pendingShare'
import { Brand } from '../../app/AppShell'
import { LOADING_STATE_DELAY } from '@t-lingual/ui'
import { Button, Card, EmptyState, Spinner } from '../../design-system'
import { errorMessage, languages } from '../../app/utils'

export function ShareLanding() {
  const {t}=useI18n()

  const { navigate } = useRouter()
  const { status } = useAuth()
  const token = useRef(window.location.hash.slice(1))
  const [error, setError] = useState('')
  const [needsAccount, setNeedsAccount] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const settled = status !== 'loading'
  const signedIn = status === 'authenticated'
  useEffect(() => {
    if (!settled) return
    let active = true
    window.history.replaceState(window.history.state, '', '/share')
    // Signed in, a link is opened as oneself and kept among what is shared
    // with one; otherwise it is opened as a guest, if the link allows guests.
    const opened = signedIn
      ? api.sharing.join(token.current).then(value => `/sessions/${encodeURIComponent(value.sessionId)}`)
      : api.sharing.redeem(token.current, browserTarget()).then(value => `/shared/${value.sessionId}`)
    opened.then(href => { if (active) navigate(href, { replace: true }) }).catch(caught => {
      if (!active) return
      if ((caught as { code?: string }).code?.toUpperCase() === 'SIGN_IN_REQUIRED') setNeedsAccount(true)
      else setError(errorMessage(caught))
    })
    return () => { active = false }
  }, [attempt, navigate, settled, signedIn])
  if (needsAccount) return <main className="auth-service-error"><Card><Brand /><EmptyState icon="lock" title={t("Sign in to open this conversation")} description={t("This link is only for people with an account here. Once you have signed in, it opens straight away.")} action={<Button variant="primary" icon="user" onClick={() => { rememberShare(token.current); navigate('/login') }}>{t("Sign in")}</Button>} /></Card></main>
  // Opening a share is a page load like any other, with nothing drawn over the
  // page; should it take a moment, a quiet word says what is happening. Only
  // a failure needs the card.
  if (!error) return <main className="app-boot" aria-label={t("Opening the shared conversation…")}><OpeningShare label={t("Opening the shared conversation…")} /></main>
  return <main className="auth-service-error"><Card><Brand /><EmptyState icon="warning" title={t("This share is unavailable")} description={error} action={<Button onClick={() => { setError(''); setAttempt(value => value + 1) }}>{t("Try again")}</Button>} /></Card></main>
}

/** The translation a guest starts with: the browser's language, where it is one of ours. */
function browserTarget() {
  const browserLanguage = navigator.language.toLowerCase()
  return languages.find(item => item.code.toLowerCase() === browserLanguage)?.code ?? languages.find(item => item.code.split('-')[0] === browserLanguage.split('-')[0])?.code ?? 'en'
}

function OpeningShare({ label }: { label: string }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADING_STATE_DELAY)
    return () => window.clearTimeout(timer)
  }, [])
  return <>
    <p className="sr-only" role="status">{label}</p>
    {shown && <span className="app-boot__wait" aria-hidden="true"><Spinner label="" />{label}</span>}
  </>
}
