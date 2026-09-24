import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { BrowserSession, Passkey, UserSettings } from '../../api/contracts'
import { createPasskey } from '../../api/webauthn'
import { loadLocalPreferences, saveLocalPreferences, type LocalPreferences } from '../../app/preferences'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { useAuth } from '../../app/auth'
import { useRouter } from '../../app/router'
import { Badge, Button, Card, Dialog, EmptyState, Icon, Input, Select, Skeleton, Switch as FrameworkSwitch, Tabs, useTheme, useToast } from '../../design-system'
import { errorMessage, languages } from '../../app/utils'
import { canRemovePasskey, SecurityPanel } from './SecurityPanel'
import { AudioCaptureSettings } from './AudioCaptureSettings'
import { LanguageSelect } from '../languages'
import { useRecognitionLanguages } from '../sessions/useRecognitionLanguages'
import { useI18n } from '../../app/i18n'
import { InterfaceLanguageMenu } from '../../app/i18n/InterfaceLanguageMenu'
import './settings.css'

type SettingsTab = 'account' | 'appearance' | 'interpretation' | 'sessions' | 'audio' | 'security'
const tabItems = [
  { value: 'account' as const, label: 'Account', icon: 'user' as const },
  { value: 'appearance' as const, label: 'Appearance', icon: 'sun' as const }, { value: 'interpretation' as const, label: 'Languages', icon: 'wave' as const },
  { value: 'sessions' as const, label: 'Sessions', icon: 'history' as const },
  { value: 'audio' as const, label: 'Audio', icon: 'microphone' as const }, { value: 'security' as const, label: 'Security', icon: 'shield' as const },
]
const mockCredential = { id: 'mock-credential', rawId: 'bW9jaw', type: 'public-key' as const, authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'bW9jaw' } }

function Switch({ ariaLabel, label, checked, onChange, disabled }: { ariaLabel: string; label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <span className="settings-toggle"><FrameworkSwitch ariaLabel={ariaLabel} label={ariaLabel} checked={checked} disabled={disabled} onChange={onChange} /><span aria-hidden="true">{label}</span></span>
}

export function SettingsPage() {
  const { mode } = useTheme()
  const { t, languagePreference, setThemePreference, formatDate: localDate } = useI18n()
	const { push } = useToast()
	const { refresh, user, recoveryExpiresAt, setRecoveryInProgress, clearRecovery, onboardingComplete } = useAuth()
	const { navigate } = useRouter()
  const [tab, setTab] = useState<SettingsTab>(()=>window.location.hash==='#security'?'security':'account')
  const recognition=useRecognitionLanguages(tab==='interpretation')
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [local, setLocal] = useState<LocalPreferences>(loadLocalPreferences)
  const [savedSettings, setSavedSettings] = useState<UserSettings | null>(null)
  const [savedLocal, setSavedLocal] = useState<LocalPreferences>(loadLocalPreferences)
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [browserSessions, setBrowserSessions] = useState<BrowserSession[]>([])
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [recovered,setRecovered]=useState(false)
  const [recoveryClock,setRecoveryClock]=useState(Date.now)
  useEffect(()=>{if(!recoveryExpiresAt)return;const timer=window.setInterval(()=>{setRecoveryClock(Date.now());if(Date.now()>=Date.parse(recoveryExpiresAt))window.clearInterval(timer)},1000);return()=>window.clearInterval(timer)},[recoveryExpiresAt])
  const [removeKey, setRemoveKey] = useState<Passkey | null>(null)
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null)
  const [revokeOthersBusy, setRevokeOthersBusy] = useState(false)
  const [devicesBusy, setDevicesBusy] = useState(false)
  const changed = settings !== null && (JSON.stringify(settings) !== JSON.stringify(savedSettings) || JSON.stringify(local) !== JSON.stringify(savedLocal))
  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    setDevicesBusy(true)
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput')) }
    catch (caught) { push({ tone: 'error', title: t('Microphones could not be listed'), message: errorMessage(caught) }) }
    finally { setDevicesBusy(false) }
  }

  useEffect(() => {
    let active = true
    const deviceRequest = navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]) : Promise.resolve([] as MediaDeviceInfo[])
    Promise.all([api.settings.get(), api.passkeys.list(), api.browserSessions.list(), deviceRequest]).then(([next, keys, sessions, mediaDevices]) => {
      if (!active) return; setSettings(next); setSavedSettings(next); setPasskeys(keys); setBrowserSessions(sessions); setDevices(mediaDevices.filter((device) => device.kind === 'audioinput'))
    }).catch((caught) => { if (active) setError(errorMessage(caught)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

	const save = async () => {
    if (!settings) return; setSaving(true)
    const storedLocally = saveLocalPreferences(local)
    try {
      const result = await api.settings.update({ ...settings, interfaceLanguage: languagePreference, themePreference: mode } as UserSettings)
      setSettings(result)
      setSavedSettings(result)
      setSavedLocal(local)
      push(storedLocally
        ? { tone: 'success', title: t('Settings saved'), message: t('New sessions will use these preferences.') }
        : { tone: 'info', title: t('Settings saved for this visit'), message: t('Browser storage is unavailable, so microphone choices may reset after this tab closes.') })
    }
    catch (caught) {
      push({
        tone: 'error',
        title: t('Account settings weren’t saved'),
        message: storedLocally
          ? `${t('Microphone choices were saved on this browser.')} ${errorMessage(caught)}`
          : `${t('Microphone choices remain available for this visit.')} ${errorMessage(caught)}`,
      })
    }
    finally { setSaving(false) }
	}
	const authorizePasskeyChange = async () => {
		return authorizePasskeyAction()
	}
	const addPasskey = async (event: FormEvent) => {
		event.preventDefault(); if (!newKeyName.trim()) return; setKeyBusy(true); if(recoveryExpiresAt)setRecoveryInProgress?.(true)
		try { const authorization = await authorizePasskeyAction('passkeys:add'); const begin = await api.passkeys.registrationBegin(authorization.authorizationToken, { name: newKeyName.trim() }); const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await createPasskey(begin.options.publicKey); const created = await api.passkeys.registrationFinish(begin.ceremonyToken, credential); setPasskeys((current) => [...current, created]); setNewKeyOpen(false); setNewKeyName(''); setRecovered(true); clearRecovery?.(); if(onboardingComplete===false)navigate('/setup'); push({ tone: 'success', title: t('Passkey added') }) }
    catch (caught) { push({ tone: 'error', title: t('Passkey wasn’t added'), message: errorMessage(caught) }) }
    finally { setKeyBusy(false);setRecoveryInProgress?.(false) }
  }
  const remove = async () => {
    if (!removeKey || !canRemovePasskey(passkeys, removeKey)) return; setKeyBusy(true)
		try { const authorization = await authorizePasskeyChange(); await api.passkeys.remove(authorization.authorizationToken, removeKey.id); setPasskeys((current) => current.filter((key) => key.id !== removeKey.id)); setRemoveKey(null); await refresh(); navigate('/login', { replace: true }); push({ tone: 'success', title: t('Passkey removed'), message: t('For safety, sign in again with a remaining passkey.') }) }
    catch (caught) { push({ tone: 'error', title: t('Passkey wasn’t removed'), message: errorMessage(caught) }) }
    finally { setKeyBusy(false) }
  }
  const revokeBrowserSession = async (session: BrowserSession) => {
    setSessionBusyId(session.id)
    try {
      const authorization = session.current ? undefined : await authorizePasskeyChange()
      await api.browserSessions.revoke(session.id, authorization?.authorizationToken)
      setBrowserSessions((current) => current.filter((item) => item.id !== session.id))
      if (session.current) {
        await refresh()
        navigate('/login', { replace: true })
        push({ tone: 'success', title: t('Signed out'), message: t('Use a passkey when you’re ready to return.') })
      } else {
        push({ tone: 'success', title: t('Browser signed out'), message: t('Its session and live streams were revoked.') })
      }
      return true
    } catch (caught) {
      push({ tone: 'error', title: t('Browser wasn’t signed out'), message: errorMessage(caught) })
      return false
    } finally {
      setSessionBusyId(null)
    }
  }
  const revokeOtherBrowserSessions = async () => {
    setRevokeOthersBusy(true)
    try {
      const authorization = await authorizePasskeyChange()
      const result = await api.browserSessions.revokeOthers(authorization.authorizationToken)
      setBrowserSessions((current) => current.filter((session) => session.current))
      push({
        tone: 'success',
        title: t('{count} browsers signed out', { count: result.revoked }),
        message: t('This browser remains signed in.'),
      })
      return true
    } catch (caught) {
      push({ tone: 'error', title: t('Other browsers weren’t signed out'), message: errorMessage(caught) })
      return false
    } finally {
      setRevokeOthersBusy(false)
    }
  }

  return <>
    <h1 className="sr-only">{t("Settings")}</h1>
    <div className="settings-topline">
      <Tabs items={tabItems.map((item) => ({ ...item, label: t(item.label) }))} value={tab} onChange={setTab} label={t("Settings sections")} panelId={!loading && !error && settings ? 'settings-panel' : undefined} />

    </div>
    {loading ? <div className="settings-loading" role="status" aria-label={t("Loading settings")}><Skeleton height={120} /><Skeleton height={240} /></div> : error || !settings ? <Card><EmptyState icon="warning" title={t("Settings unavailable")} description={error || t('Your settings could not be loaded.')} action={<Button onClick={() => window.location.reload()}>{t("Reload")}</Button>} /></Card> : <div id="settings-panel" className="settings-panel" role="tabpanel" aria-label={t('{section} settings', { section: t(tabItems.find((item) => item.value === tab)?.label ?? 'Current') })}>
      {tab === 'account' && <section aria-labelledby="account-title"><div className="settings-heading"><h2 id="account-title">{t("Your account")}</h2><p>{t("This identity belongs to your private workspace.")}</p></div><div className="account-profile"><span className="account-profile__avatar" aria-hidden="true">{user?.displayName?.charAt(0).toUpperCase() || 'T'}</span><div><strong><bdi>{user?.displayName || t('Your workspace')}</bdi></strong><span><bdi>{user ? `@${user.username}` : t('Signed in with a passkey')}</bdi></span></div><Badge tone={user?.role === 'admin' ? 'accent' : 'neutral'}>{user?.role === 'admin' ? t('Administrator') : t('Member')}</Badge></div><Card className="settings-card"><dl className="account-details"><div><dt>{t("Username")}</dt><dd><bdi>{user ? `@${user.username}` : t('Unavailable')}</bdi></dd></div><div><dt>{t("Display name")}</dt><dd><bdi>{user?.displayName || t('Unavailable')}</bdi></dd></div><div><dt>{t("Access")}</dt><dd>{t("Passkey or temporary code")}</dd></div><div><dt>{t("Member since")}</dt><dd>{user?.createdAt ? localDate(user.createdAt, { dateStyle: 'long' }) : t('Unavailable')}</dd></div></dl></Card><div className="account-assurance"><Icon name="shield" size={19} /><p>{t("Sessions, transcripts, preferences and credentials are private to this account. You can review passkeys and signed-in browsers under Security.")}</p><Button variant="ghost" size="sm" icon="arrowRight" onClick={() => setTab('security')}>{t("Security settings")}</Button></div></section>}
      {tab === 'appearance' && <section aria-labelledby="appearance-title"><div className="settings-heading"><h2 id="appearance-title">{t("Appearance")}</h2><p>{t("Theme preference applies immediately in this browser.")}</p></div><Card className="settings-card"><div className="setting-row"><div><h3>{t("Interface language")}</h3><p>{t("Choose the language used for menus and settings. This does not change interpretation languages.")}</p></div><InterfaceLanguageMenu compact={false} /></div><div className="setting-row setting-row--stack"><div><h3>{t("Colour theme")}</h3><p>{t("System follows your operating system automatically.")}</p></div><div className="theme-choices" role="group" aria-label={t("Colour theme")}>{(['system', 'light', 'dark'] as const).map((theme) => <button type="button" key={theme} className="theme-choice" aria-pressed={mode === theme} onClick={() => setThemePreference(theme)}><span className={`theme-preview theme-preview--${theme}`}><i /><i /><i /></span><strong>{t(theme.charAt(0).toUpperCase() + theme.slice(1))}</strong><span className="theme-choice__check"><Icon name="check" size={13} /></span></button>)}</div></div><div className="setting-row"><div><h3>{t("Compact transcripts")}</h3><p>{t("Reduce spacing to fit more lines on screen.")}</p></div><Switch ariaLabel={t("Compact transcripts")} label={settings.compactTranscriptLayout ? t('On') : t('Off')} checked={settings.compactTranscriptLayout} onChange={(checked) => setSettings({ ...settings, compactTranscriptLayout: checked })} /></div></Card></section>}
      {tab === 'interpretation' && <section aria-labelledby="language-title"><div className="settings-heading"><h2 id="language-title">{t("Interpretation defaults")}</h2><p>{t("Used as the starting choice for every new session.")}</p></div><Card className="settings-card"><div className="setting-row"><div><h3>{t("Default recognition language")}</h3><p>{t("Choose automatic detection or the language expected in new recordings.")}</p></div><LanguageSelect label={t("Default recognition language")} value={settings.defaultSourceLanguage} includeAuto languages={recognition.choices} disabled={recognition.loading||!!recognition.error} error={recognition.error?t(recognition.error):undefined} onChange={(source) => setSettings({ ...settings, defaultSourceLanguage: source })} /></div><div className="setting-row"><div><h3>{t("Your translation language")}</h3><p>{t("Your preferred translation for new conversations. Other viewers choose their own language.")}</p></div><LanguageSelect label={t("Translate to")} value={settings.defaultTargetLanguage} languages={languages} onChange={(target) => setSettings({ ...settings, defaultTargetLanguage: target })} /></div><div className="setting-row"><div><h3>{t("Show partial speech")}</h3><p>{t("Display interim recognition while a phrase is still being spoken.")}</p></div><Switch ariaLabel={t("Show partial speech")} label={settings.showPartialTranscripts ? t('On') : t('Off')} checked={settings.showPartialTranscripts} onChange={(checked) => setSettings({ ...settings, showPartialTranscripts: checked })} /></div><div className="settings-info"><Icon name="spark" size={18} /><div><strong>{t("Recognition and translation remain separate")}</strong><p>{t("A failed translation never removes the persisted source transcript.")}</p></div></div></Card></section>}
      {tab === 'sessions' && <section aria-labelledby="sessions-title"><div className="settings-heading"><h2 id="sessions-title">{t("Session lifecycle")}</h2><p>{t("Saved sessions remain available for more recording until you archive them.")}</p></div><Card className="settings-card"><div className="setting-row"><div><h3>{t("Archive after inactivity")}</h3><p>{t("Automatically make a session read only when it has no new recording or changes for this long.")}</p></div><Select label={t("Archive after inactivity")} value={String(settings.autoArchiveHours ?? 24)} onChange={(event) => setSettings({ ...settings, autoArchiveHours: Number(event.target.value) })}><option value="6">{t("6 hours")}</option><option value="24">{t("24 hours")}</option><option value="72">{t("3 days")}</option><option value="168">{t("7 days")}</option><option value="0">{t("Never")}</option></Select></div><div className="settings-retention-note"><Icon name="folder" size={18} /><p>{t("Archived conversations remain in your history. You can unarchive them to record again. Viewing a transcript does not reset the inactivity period.")}</p></div></Card></section>}
      {tab === 'audio' && <section aria-labelledby="audio-title"><div className="settings-heading settings-heading--action"><div><h2 id="audio-title">{t("Microphone")}</h2><p>{t("Device choices stay in this browser. Audio is never stored in these settings.")}</p></div><Button size="sm" icon="refresh" loading={devicesBusy} onClick={() => void refreshDevices()}>{t("Refresh devices")}</Button></div><Card className="settings-card"><div className="setting-row"><div><h3>{t("Input device")}</h3><p>{t("Browser permission may be required to show device names.")}</p></div><Select label={t("Microphone")} value={local.inputDeviceId} onChange={(event) => setLocal({ ...local, inputDeviceId: event.target.value })}><option value="default">{t("System default")}</option>{local.inputDeviceId !== 'default' && !devices.some((device) => device.deviceId === local.inputDeviceId) && <option value={local.inputDeviceId}>{t("Previously selected device (unavailable)")}</option>}{devices.filter((device) => device.deviceId !== 'default').map((device, index) => <option dir="auto" key={device.deviceId} value={device.deviceId}>{device.label || t('Microphone {number}', { number: index + 1 })}</option>)}</Select></div><AudioCaptureSettings value={local} onChange={setLocal} disabled={saving}/><div className="setting-row"><div><h3>{t("Echo cancellation")}</h3><p>{t("Reduce feedback from speakers during calls.")}</p></div><Switch ariaLabel={t("Echo cancellation")} disabled={local.captureMode==='studio'} label={local.echoCancellation ? t('On') : t('Off')} checked={local.echoCancellation} onChange={(checked) => setLocal({ ...local, echoCancellation: checked })} /></div><div className="setting-row"><div><h3>{t("Noise suppression")}</h3><p>{t("Reduce steady background noise before streaming.")}</p></div><Switch ariaLabel={t("Noise suppression")} disabled={local.captureMode==='studio'} label={local.noiseSuppression ? t('On') : t('Off')} checked={local.noiseSuppression} onChange={(checked) => setLocal({ ...local, noiseSuppression: checked })} /></div><div className="setting-row"><div><h3>{t("Start microphone automatically")}</h3><p>{t("When enabled, entering a newly created live session immediately asks for permission.")}</p></div><Switch ariaLabel={t("Start microphone automatically")} label={settings.autoStartMicrophone ? t('On') : t('Off')} checked={settings.autoStartMicrophone} onChange={(checked) => setSettings({ ...settings, autoStartMicrophone: checked })} /></div><div className="audio-contract"><span className="audio-contract__wave"><Icon name="wave" size={24} /></span><div><strong>{t("Ready for clear conversations")}</strong><p>{t("Choose a quiet space and keep your microphone close. Your audio is sent only while interpretation is running.")}</p></div><Badge tone="neutral">{t("Browser audio")}</Badge></div></Card></section>}
      {tab === 'security' && recoveryExpiresAt && !recovered && Date.parse(recoveryExpiresAt)>recoveryClock && <div className="settings-info" role="status"><Icon name="key" size={20}/><p>{t('Your temporary code verified this sign-in. Add a new passkey now to keep access to your account.')}</p></div>}
      {tab === 'security' && <SecurityPanel
        passkeys={passkeys}
        browserSessions={browserSessions}
        keyBusy={keyBusy}
        sessionBusyId={sessionBusyId}
        revokeOthersBusy={revokeOthersBusy}
        onAddPasskey={() => setNewKeyOpen(true)}
        onRemovePasskey={setRemoveKey}
        onRevokeSession={revokeBrowserSession}
        onRevokeOthers={revokeOtherBrowserSessions}
      />}
    </div>}
    {!loading && !error && settings && <div className="settings-footer"><Button variant="primary" size="sm" icon="check" loading={saving} disabled={!changed} onClick={() => void save()}>{t("Save changes")}</Button></div>}
		<Dialog open={newKeyOpen} onClose={() => !keyBusy && setNewKeyOpen(false)} title={t("Add a passkey")} description={recoveryExpiresAt&&!recovered&&Date.parse(recoveryExpiresAt)>recoveryClock?t("Use your device’s screen lock, a nearby phone or a hardware security key. Keep access to this device until setup finishes."):t("First verify an existing passkey, then create the new one on this device, a nearby device or a security key.")} footer={<><Button disabled={keyBusy} onClick={() => setNewKeyOpen(false)}>{t("Cancel")}</Button><Button form="add-passkey" type="submit" variant="primary" icon="key" loading={keyBusy}>{t("Verify and continue")}</Button></>}><form id="add-passkey" aria-busy={keyBusy} onSubmit={(event) => void addPasskey(event)}><Input dir="auto" autoFocus required disabled={keyBusy} label={t("Passkey name")} hint={t("Use a name you’ll recognise later.")} placeholder={t("e.g. Office security key")} maxLength={64} value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} /></form></Dialog>
		<Dialog open={!!removeKey} onClose={() => !keyBusy && setRemoveKey(null)} title={t("Remove this passkey?")} description={t("Verify a remaining passkey to continue. All signed-in browsers will be signed out after removal.")} footer={<><Button disabled={keyBusy} onClick={() => setRemoveKey(null)}>{t("Cancel")}</Button><Button variant="danger" loading={keyBusy} onClick={() => void remove()}>{t("Verify and remove")}</Button></>}><div className="delete-summary"><Icon name="key" size={20} /><strong><bdi>{removeKey?.name}</bdi></strong></div></Dialog>
  </>
}
