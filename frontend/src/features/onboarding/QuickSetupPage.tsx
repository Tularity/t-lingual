import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { UserSettings } from '../../api/contracts'
import { useAuth } from '../../app/auth'
import { useI18n } from '../../app/i18n'
import { InterfaceLanguageMenu } from '../../app/i18n/InterfaceLanguageMenu'
import { useRouter } from '../../app/router'
import { errorMessage, languages } from '../../app/utils'
import { Badge, Button, Card, EmptyState, Icon, LoadingState, useTheme, useToast } from '../../design-system'
import { LanguageSelect } from '../languages'
import { useRecognitionLanguages } from '../sessions/useRecognitionLanguages'
import './quick-setup.css'

interface QuickSetupPageProps { onComplete?: () => void }
const themeChoices = [
  { value: 'system' as const, icon: 'sun' as const, label: 'System' },
  { value: 'light' as const, icon: 'sun' as const, label: 'Light' },
  { value: 'dark' as const, icon: 'moon' as const, label: 'Dark' },
]

/** Personal defaults only: UI language, translation, recognition, and theme. */
export function QuickSetupPage({ onComplete }: QuickSetupPageProps) {
  const { t, setThemePreference } = useI18n()
  const { mode } = useTheme()
  const { completeOnboarding } = useAuth()
  const { navigate } = useRouter()
  const { push } = useToast()
  const recognition = useRecognitionLanguages()
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [source, setSource] = useState('auto')
  const [target, setTarget] = useState('en')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    void api.settings.get().then(value => {
      if (!active) return
      setSettings(value)
      setSource(value.defaultSourceLanguage || 'auto')
      setTarget(languages.some(language => language.code === value.defaultTargetLanguage) ? value.defaultTargetLanguage : 'en')
      setLoadError('')
    }).catch(caught => { if (active) setLoadError(errorMessage(caught)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [attempt])

  // A saved fixed source can become unavailable after an ASR deployment change.
  const sourceAvailable = source === 'auto' || recognition.loading || Boolean(recognition.choices.find(choice => choice.code === source))
  const effectiveSource = sourceAvailable ? source : 'auto'
  const choices = recognition.choices
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!settings || saving || !effectiveSource || !target) return
    setSaving(true); setSaveError('')
    try {
      // Read immediately before PUT so theme/interface PATCH writes are not replaced by a stale form snapshot.
      const latest = await api.settings.get()
      const payload: UserSettings = { ...latest, defaultSourceLanguage: effectiveSource, defaultTargetLanguage: target, onboardingComplete: true }
      delete payload.interfaceLanguage
      delete payload.themePreference
      await api.settings.update(payload)
      await completeOnboarding()
      push({ tone: 'success', title: t('Your workspace is ready') })
      if (onComplete) onComplete()
      else navigate('/sessions', { replace: true })
    } catch (caught) { setSaveError(errorMessage(caught)) }
    finally { setSaving(false) }
  }

  return <section className="quick-setup" aria-labelledby="quick-setup-title">
    <div className="quick-setup__intro">
      <span className="quick-setup__eyebrow"><Icon name="spark" size={16} />{t('A few choices to get started')}</span>
      <h1 id="quick-setup-title">{t('Make this space yours')}</h1>
      <p>{t('Choose how you want to read and follow conversations. You can change these choices later in Settings.')}</p>
      <div className="quick-setup__steps" aria-label={t('Setup steps')}><span>01 <b>{t('Interface')}</b></span><span>02 <b>{t('Languages')}</b></span><span>03 <b>{t('Appearance')}</b></span></div>
    </div>
    <LoadingState loading={loading} label={t('Loading preferences')}>{loading ? null : loadError || !settings ? <Card><EmptyState icon="warning" title={t('Preferences could not be loaded')} description={loadError || t('Try again to continue setup.')} action={<Button icon="refresh" onClick={() => { setLoading(true); setAttempt(value => value + 1) }}>{t('Try again')}</Button>} /></Card>
        : <form className="quick-setup__form" onSubmit={event => void save(event)} aria-busy={saving}>
          <div className="quick-setup__grid">
            <Card className="quick-setup__card"><div className="quick-setup__card-title"><span>01</span><div><h2>{t('Interface language')}</h2><p>{t('Menus and settings use this language. Speech and translation choices remain independent.')}</p></div></div><InterfaceLanguageMenu compact={false} /></Card>
            <Card className="quick-setup__card"><div className="quick-setup__card-title"><span>02</span><div><h2>{t('Your translation language')}</h2><p>{t('New conversations will show your preferred translation. Other viewers can choose for themselves.')}</p></div></div><LanguageSelect label={t('Your translation language')} value={target} languages={languages} onChange={setTarget} disabled={saving} /></Card>
            <Card className="quick-setup__card"><div className="quick-setup__card-title"><span>03</span><div><h2>{t('Default recognition language')}</h2><p>{t('Choose automatic recognition or the language you expect to hear most often.')}</p></div></div><LanguageSelect label={t('Default recognition language')} value={effectiveSource} languages={choices} includeAuto onChange={setSource} disabled={saving} />{recognition.loading && <span className="quick-setup__subtle" role="status">{t('Loading recognition languages…')}</span>}{recognition.error && <div className="quick-setup__hint" role="status"><Icon name="info" size={16} />{t('Recognition service is temporarily unavailable. Automatic recognition remains selected.')} <button type="button" onClick={recognition.retry}>{t('Retry')}</button></div>}{!sourceAvailable && <p className="quick-setup__hint">{t('Your previous recognition language is unavailable; automatic recognition will be saved.')}</p>}</Card>
            <Card className="quick-setup__card"><div className="quick-setup__card-title"><span>04</span><div><h2>{t('Colour theme')}</h2><p>{t('Optional. System follows your device; you can change this at any time.')}</p></div></div><div className="quick-setup__themes" role="group" aria-label={t('Colour theme')}>{themeChoices.map(choice => <button type="button" key={choice.value} className="quick-setup__theme" aria-pressed={mode === choice.value} onClick={() => setThemePreference(choice.value)}><Icon name={choice.value === 'system' ? 'sunMoon' : choice.icon} size={19} /><span>{t(choice.label)}</span>{mode === choice.value && <Icon name="check" size={15} />}</button>)}</div></Card>
          </div>
          <div className="quick-setup__footer"><div><Badge tone="accent">{t('Private by default')}</Badge><span>{t('Your choices belong to your account.')}</span></div><Button type="submit" variant="primary" icon="arrowRight" loading={saving} disabled={recognition.loading || !target || !effectiveSource}>{t('Save and continue')}</Button></div>
          {saveError && <p className="quick-setup__error" role="alert"><Icon name="warning" size={17} />{t('Could not save your choices.')} <span dir="auto">{saveError}</span></p>}
        </form>}</LoadingState>
  </section>
}
