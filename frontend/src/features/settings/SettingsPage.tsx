import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { BrowserSession, Passkey, UserSettings } from '../../api/contracts'
import { createPasskey } from '../../api/webauthn'
import { loadLocalPreferences, saveLocalPreferences, type LocalPreferences } from '../../app/preferences'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { useAuth } from '../../app/auth'
import { useRouter } from '../../app/router'
import { Badge, Button, Card, Dialog, EmptyState, Icon, Input, PageHeader, Select, Skeleton, Switch, Tabs, useTheme, useToast } from '../../design-system'
import { errorMessage, languages } from '../../app/utils'
import { canRemovePasskey, SecurityPanel } from './SecurityPanel'
import './settings.css'

type SettingsTab = 'appearance' | 'interpretation' | 'audio' | 'security'
const tabItems = [
  { value: 'appearance' as const, label: 'Appearance', icon: 'sun' as const }, { value: 'interpretation' as const, label: 'Languages', icon: 'wave' as const },
  { value: 'audio' as const, label: 'Audio', icon: 'microphone' as const }, { value: 'security' as const, label: 'Security', icon: 'shield' as const },
]
const mockCredential = { id: 'mock-credential', rawId: 'bW9jaw', type: 'public-key' as const, authenticatorAttachment: null, clientExtensionResults: {}, response: { clientDataJSON: 'bW9jaw' } }

export function SettingsPage() {
  const { mode, setMode } = useTheme()
	const { push } = useToast()
	const { refresh } = useAuth()
	const { navigate } = useRouter()
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [local, setLocal] = useState<LocalPreferences>(loadLocalPreferences)
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [browserSessions, setBrowserSessions] = useState<BrowserSession[]>([])
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [removeKey, setRemoveKey] = useState<Passkey | null>(null)
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null)
  const [revokeOthersBusy, setRevokeOthersBusy] = useState(false)

  useEffect(() => {
    let active = true
    const deviceRequest = navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]) : Promise.resolve([] as MediaDeviceInfo[])
    Promise.all([api.settings.get(), api.passkeys.list(), api.browserSessions.list(), deviceRequest]).then(([next, keys, sessions, mediaDevices]) => {
      if (!active) return; setSettings(next); setPasskeys(keys); setBrowserSessions(sessions); setDevices(mediaDevices.filter((device) => device.kind === 'audioinput'))
    }).catch((caught) => { if (active) setError(errorMessage(caught)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

	const save = async () => {
    if (!settings) return; setSaving(true)
    const storedLocally = saveLocalPreferences(local)
    try {
      const result = await api.settings.update(settings)
      setSettings(result)
      push(storedLocally
        ? { tone: 'success', title: 'Settings saved', message: 'New sessions will use these preferences.' }
        : { tone: 'info', title: 'Settings saved for this visit', message: 'Browser storage is unavailable, so microphone choices may reset after this tab closes.' })
    }
    catch (caught) {
      push({
        tone: 'error',
        title: 'Account settings weren’t saved',
        message: storedLocally
          ? `Microphone choices were saved on this browser. ${errorMessage(caught)}`
          : `Microphone choices remain available for this visit. ${errorMessage(caught)}`,
      })
    }
    finally { setSaving(false) }
	}
	const authorizePasskeyChange = async () => {
		return authorizePasskeyAction()
	}
	const addPasskey = async (event: FormEvent) => {
		event.preventDefault(); if (!newKeyName.trim()) return; setKeyBusy(true)
		try { const authorization = await authorizePasskeyChange(); const begin = await api.passkeys.registrationBegin(authorization.authorizationToken, { name: newKeyName.trim() }); const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await createPasskey(begin.options.publicKey); const created = await api.passkeys.registrationFinish(begin.ceremonyToken, credential); setPasskeys((current) => [...current, created]); setNewKeyOpen(false); setNewKeyName(''); push({ tone: 'success', title: 'Passkey added' }) }
    catch (caught) { push({ tone: 'error', title: 'Passkey wasn’t added', message: errorMessage(caught) }) }
    finally { setKeyBusy(false) }
  }
  const remove = async () => {
    if (!removeKey || !canRemovePasskey(passkeys, removeKey)) return; setKeyBusy(true)
		try { const authorization = await authorizePasskeyChange(); await api.passkeys.remove(authorization.authorizationToken, removeKey.id); setPasskeys((current) => current.filter((key) => key.id !== removeKey.id)); setRemoveKey(null); await refresh(); navigate('/login', { replace: true }); push({ tone: 'success', title: 'Passkey removed', message: 'For safety, sign in again with a remaining passkey.' }) }
    catch (caught) { push({ tone: 'error', title: 'Passkey wasn’t removed', message: errorMessage(caught) }) }
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
        push({ tone: 'success', title: 'Signed out', message: 'Use a passkey when you’re ready to return.' })
      } else {
        push({ tone: 'success', title: 'Browser signed out', message: 'Its session and live streams were revoked.' })
      }
      return true
    } catch (caught) {
      push({ tone: 'error', title: 'Browser wasn’t signed out', message: errorMessage(caught) })
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
        title: result.revoked === 1 ? '1 browser signed out' : `${result.revoked} browsers signed out`,
        message: 'This browser remains signed in.',
      })
      return true
    } catch (caught) {
      push({ tone: 'error', title: 'Other browsers weren’t signed out', message: errorMessage(caught) })
      return false
    } finally {
      setRevokeOthersBusy(false)
    }
  }

  return <>
    <PageHeader eyebrow="Preferences" title="Settings" description="Appearance and microphone device stay on this browser; interpretation defaults follow your account." actions={tab !== 'security' && <Button variant="primary" icon="check" loading={saving} disabled={!settings} onClick={() => void save()}>Save changes</Button>} />
    <Tabs items={tabItems} value={tab} onChange={setTab} label="Settings sections" panelId={!loading && !error && settings ? 'settings-panel' : undefined} />
    {loading ? <div className="settings-loading" role="status" aria-label="Loading settings"><Skeleton height={120} /><Skeleton height={240} /></div> : error || !settings ? <Card><EmptyState icon="warning" title="Settings unavailable" description={error || 'Your settings could not be loaded.'} action={<Button onClick={() => window.location.reload()}>Reload</Button>} /></Card> : <div id="settings-panel" className="settings-panel" role="tabpanel" aria-label={`${tabItems.find((item) => item.value === tab)?.label ?? 'Current'} settings`}>
      {tab === 'appearance' && <section aria-labelledby="appearance-title"><div className="settings-heading"><h2 id="appearance-title">Appearance</h2><p>Theme preference applies only in this browser.</p></div><Card className="settings-card"><div className="setting-row setting-row--stack"><div><h3>Colour theme</h3><p>System follows your operating system automatically.</p></div><div className="theme-choices" role="group" aria-label="Colour theme">{(['system', 'light', 'dark'] as const).map((theme) => <button type="button" key={theme} className="theme-choice" aria-pressed={mode === theme} onClick={() => setMode(theme)}><span className={`theme-preview theme-preview--${theme}`}><i /><i /><i /></span><strong>{theme.charAt(0).toUpperCase() + theme.slice(1)}</strong><span className="theme-choice__check"><Icon name="check" size={13} /></span></button>)}</div></div><div className="setting-row"><div><h3>Compact transcripts</h3><p>Reduce spacing to fit more lines on screen.</p></div><Switch ariaLabel="Compact transcripts" label={settings.compactTranscriptLayout ? 'On' : 'Off'} checked={settings.compactTranscriptLayout} onChange={(checked) => setSettings({ ...settings, compactTranscriptLayout: checked })} /></div></Card></section>}
      {tab === 'interpretation' && <section aria-labelledby="language-title"><div className="settings-heading"><h2 id="language-title">Interpretation defaults</h2><p>Used as the starting choice for every new session.</p></div><Card className="settings-card"><div className="setting-row"><div><h3>Spoken language</h3><p>Choose automatic detection or an expected language.</p></div><Select label="Spoken language" value={settings.defaultSourceLanguage} onChange={(event) => { const source = event.target.value; const target = source === settings.defaultTargetLanguage ? languages.find((language) => language.code !== source)?.code ?? 'en' : settings.defaultTargetLanguage; setSettings({ ...settings, defaultSourceLanguage: source, defaultTargetLanguage: target }) }}><option value="auto">Detect automatically</option>{languages.map((language) => <option key={language.code} value={language.code}>{language.label} · {language.native}</option>)}</Select></div><div className="setting-row"><div><h3>Translation language</h3><p>The target requested from the translation service.</p></div><Select label="Translate to" value={settings.defaultTargetLanguage} onChange={(event) => setSettings({ ...settings, defaultTargetLanguage: event.target.value })}>{languages.filter((language) => language.code !== settings.defaultSourceLanguage).map((language) => <option key={language.code} value={language.code}>{language.label} · {language.native}</option>)}</Select></div><div className="setting-row"><div><h3>Show partial speech</h3><p>Display interim recognition while a phrase is still being spoken.</p></div><Switch ariaLabel="Show partial speech" label={settings.showPartialTranscripts ? 'On' : 'Off'} checked={settings.showPartialTranscripts} onChange={(checked) => setSettings({ ...settings, showPartialTranscripts: checked })} /></div><div className="settings-info"><Icon name="spark" size={18} /><div><strong>Recognition and translation remain separate</strong><p>A failed translation never removes the persisted source transcript.</p></div></div></Card></section>}
      {tab === 'audio' && <section aria-labelledby="audio-title"><div className="settings-heading"><h2 id="audio-title">Microphone</h2><p>Device choices stay in this browser. Audio is never stored in these settings.</p></div><Card className="settings-card"><div className="setting-row"><div><h3>Input device</h3><p>Browser permission may be required to show device names.</p></div><Select label="Microphone" value={local.inputDeviceId} onChange={(event) => setLocal({ ...local, inputDeviceId: event.target.value })}><option value="default">System default</option>{devices.filter((device) => device.deviceId !== 'default').map((device, index) => <option dir="auto" key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</Select></div><div className="setting-row"><div><h3>Echo cancellation</h3><p>Reduce feedback from speakers during calls.</p></div><Switch ariaLabel="Echo cancellation" label={local.echoCancellation ? 'On' : 'Off'} checked={local.echoCancellation} onChange={(checked) => setLocal({ ...local, echoCancellation: checked })} /></div><div className="setting-row"><div><h3>Noise suppression</h3><p>Reduce steady background noise before streaming.</p></div><Switch ariaLabel="Noise suppression" label={local.noiseSuppression ? 'On' : 'Off'} checked={local.noiseSuppression} onChange={(checked) => setLocal({ ...local, noiseSuppression: checked })} /></div><div className="setting-row"><div><h3>Start microphone automatically</h3><p>When enabled, entering a newly created live session immediately asks for permission.</p></div><Switch ariaLabel="Start microphone automatically" label={settings.autoStartMicrophone ? 'On' : 'Off'} checked={settings.autoStartMicrophone} onChange={(checked) => setSettings({ ...settings, autoStartMicrophone: checked })} /></div><div className="audio-contract"><span className="audio-contract__wave"><Icon name="wave" size={24} /></span><div><strong>Native browser audio</strong><p>Live audio uses mono Float32 PCM at the browser’s native sample rate. No model runs here.</p></div><Badge tone="neutral">pcm32f · mono</Badge></div></Card></section>}
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
		<Dialog open={newKeyOpen} onClose={() => !keyBusy && setNewKeyOpen(false)} title="Add a passkey" description="First verify an existing passkey, then create the new one on this device, a nearby device or a security key." footer={<><Button disabled={keyBusy} onClick={() => setNewKeyOpen(false)}>Cancel</Button><Button form="add-passkey" type="submit" variant="primary" icon="key" loading={keyBusy}>Verify and continue</Button></>}><form id="add-passkey" aria-busy={keyBusy} onSubmit={(event) => void addPasskey(event)}><Input dir="auto" autoFocus required disabled={keyBusy} label="Passkey name" hint="Use a name you’ll recognise later." placeholder="e.g. Office security key" maxLength={64} value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} /></form></Dialog>
		<Dialog open={!!removeKey} onClose={() => !keyBusy && setRemoveKey(null)} title="Remove this passkey?" description="Verify a remaining passkey to continue. All signed-in browsers will be signed out after removal." footer={<><Button disabled={keyBusy} onClick={() => setRemoveKey(null)}>Cancel</Button><Button variant="danger" loading={keyBusy} onClick={() => void remove()}>Verify and remove</Button></>}><div className="delete-summary"><Icon name="key" size={20} /><strong><bdi>{removeKey?.name}</bdi></strong></div></Dialog>
  </>
}
