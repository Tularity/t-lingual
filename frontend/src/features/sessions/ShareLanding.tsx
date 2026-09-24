import { useI18n } from '../../app/i18n'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useRouter } from '../../app/router'
import { Brand } from '../../app/AppShell'
import { Button, Card, EmptyState } from '../../design-system'
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
  return <main className="auth-service-error"><Card><Brand />{error ? <EmptyState icon="warning" title={t("This share is unavailable")} description={error} action={<Button onClick={() => { setError(''); setAttempt(value => value + 1) }}>{t("Try again")}</Button>} /> : <p role="status">{t("Opening the shared conversation…")}</p>}</Card></main>
}
