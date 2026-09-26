import { useI18n } from '../../app/i18n'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useRouter } from '../../app/router'
import { Brand } from '../../app/AppShell'
import { LOADING_STATE_DELAY } from '@t-lingual/ui'
import { Button, Card, EmptyState, Spinner } from '../../design-system'
import { errorMessage, languages } from '../../app/utils'

export function ShareLanding() {
  const {t}=useI18n()

  const { navigate } = useRouter()
  const token = useRef(window.location.hash.slice(1))
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    window.history.replaceState(window.history.state, '', '/share')
    const browserLanguage = navigator.language.toLowerCase()
    const target = languages.find(item => item.code.toLowerCase() === browserLanguage)?.code ?? languages.find(item => item.code.split('-')[0] === browserLanguage.split('-')[0])?.code ?? 'en'
    api.sharing.redeem(token.current, target).then(value => { if (active) navigate(`/shared/${value.sessionId}`, { replace: true }) }).catch(caught => { if (active) setError(errorMessage(caught)) })
    return () => { active = false }
  }, [attempt, navigate])
  // Opening a share is a page load like any other, with nothing drawn over the
  // page; should it take a moment, a quiet word says what is happening. Only
  // a failure needs the card.
  if (!error) return <main className="app-boot" aria-label={t("Opening the shared conversation…")}><OpeningShare label={t("Opening the shared conversation…")} /></main>
  return <main className="auth-service-error"><Card><Brand /><EmptyState icon="warning" title={t("This share is unavailable")} description={error} action={<Button onClick={() => { setError(''); setAttempt(value => value + 1) }}>{t("Try again")}</Button>} /></Card></main>
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
