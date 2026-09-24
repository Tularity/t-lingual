import { useI18n } from '../../app/i18n'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { ProviderEndpoints } from '../../api/contracts'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage } from '../../app/utils'
import { Badge, Button, EmptyState, Icon, Input, Skeleton, useToast } from '../../design-system'
import './providers.css'

type ProviderDraft = Pick<ProviderEndpoints, 'asrUrl' | 'translatorUrl'>

export async function providerUpdateScope(input: ProviderDraft) {
  const payload = JSON.stringify({ asrUrl: input.asrUrl.trim(), translatorUrl: input.translatorUrl.trim() })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `admin:providers:update:${hex}`
}

export function ProvidersPanel() {
  const { t } = useI18n()
  const { push } = useToast()
  const [saved, setSaved] = useState<ProviderEndpoints | null>(null)
  const [draft, setDraft] = useState<ProviderDraft>({ asrUrl: '', translatorUrl: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void api.admin.providers().then((value) => {
      if (!active) return
      setSaved(value)
      setDraft({ asrUrl: value.asrUrl, translatorUrl: value.translatorUrl })
      setError('')
    }).catch((caught: unknown) => { if (active) setError(errorMessage(caught)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const reload = async () => {
    setLoading(true)
    try {
      const value = await api.admin.providers()
      setSaved(value)
      setDraft({ asrUrl: value.asrUrl, translatorUrl: value.translatorUrl })
      setError('')
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setLoading(false) }
  }

  const next = { asrUrl: draft.asrUrl.trim(), translatorUrl: draft.translatorUrl.trim() }
  const changed = saved && (next.asrUrl !== saved.asrUrl || next.translatorUrl !== saved.translatorUrl)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!changed || saving) return
    setSaving(true)
    try {
      const scope = await providerUpdateScope(next)
      const authorization = await authorizePasskeyAction(scope)
      const updated = await api.admin.updateProviders(authorization.authorizationToken, next)
      setSaved(updated)
      setDraft({ asrUrl: updated.asrUrl, translatorUrl: updated.translatorUrl })
      push({ tone: 'success', title: t('Provider endpoints saved') })
    } catch (caught) {
      push({ tone: 'error', title: t('Provider endpoints weren’t saved'), message: errorMessage(caught) })
    } finally { setSaving(false) }
  }

  if (loading) return <div className="providers-loading" role="status" aria-label={t("Loading provider endpoints")}><Skeleton height={44} /><Skeleton height={245} /></div>
  if (error || !saved) return <EmptyState icon="warning" title={t("Provider endpoints unavailable")} description={error || t('Try loading the configuration again.')} action={<Button onClick={() => void reload()}>{t("Try again")}</Button>} />

  return <section className="providers-panel" aria-labelledby="providers-title">
    <div className="providers-panel__heading"><div><h2 id="providers-title">{t("Provider endpoints")}</h2><p>{t("Changes apply to new recordings. Existing recordings keep their selected providers.")}</p></div><Icon name="shield" size={22} aria-hidden="true" /></div>
    <form className="providers-panel__form" onSubmit={(event) => void submit(event)} aria-busy={saving}>
      <div className="providers-panel__row">
        <div className="providers-panel__identity"><span className="providers-panel__mark"><Icon name="wave" size={19} /></span><div><h3>{t("Speech recognition")}</h3><p>{t("ASR service endpoint")}</p></div></div>
        <Badge tone={(saved.asrConfigured ?? !!saved.asrUrl) ? 'success' : 'neutral'}>{(saved.asrConfigured ?? !!saved.asrUrl) ? t('Configured') : t('Not configured')}</Badge>
        <Input label="ASR URL" type="url" placeholder="https://asr.example.com" value={draft.asrUrl} onChange={(event) => setDraft((current) => ({ ...current, asrUrl: event.target.value }))} disabled={saving} autoComplete="url" hint={t("Leave empty to disable speech recognition for new recordings.")} />
      </div>
      <div className="providers-panel__row">
        <div className="providers-panel__identity"><span className="providers-panel__mark"><Icon name="globe" size={19} /></span><div><h3>{t("Translation")}</h3><p>{t("Translator service endpoint")}</p></div></div>
        <Badge tone={(saved.translatorConfigured ?? !!saved.translatorUrl) ? 'success' : 'neutral'}>{(saved.translatorConfigured ?? !!saved.translatorUrl) ? t('Configured') : t('Not configured')}</Badge>
        <Input label="Translator URL" type="url" placeholder="https://translator.example.com" value={draft.translatorUrl} onChange={(event) => setDraft((current) => ({ ...current, translatorUrl: event.target.value }))} disabled={saving} autoComplete="url" hint={t("Leave empty until a translation service is ready.")} />
      </div>
      <div className="providers-panel__actions"><Button type="button" disabled={!changed || saving} onClick={() => setDraft({ asrUrl: saved.asrUrl, translatorUrl: saved.translatorUrl })}>{t("Discard changes")}</Button><Button variant="primary" type="submit" icon="shield" disabled={!changed} loading={saving}>{t("Verify and save")}</Button></div>
    </form>
  </section>
}
