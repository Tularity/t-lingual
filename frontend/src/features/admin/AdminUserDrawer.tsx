import { useEffect, useState, type FormEvent } from 'react'
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle, Select as PlainSelect, SelectOption as PlainOption } from '@tular/ui'
import { api } from '../../api/client'
import type { AdminUserDetail, LimitOverrides, User, UserLimits, UserSettings } from '../../api/contracts'
import { adminChange, type AdminChangeKind } from '../../app/adminChanges'
import { useAuth } from '../../app/auth'
import { useI18n } from '../../app/i18n'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { UserAvatar } from '../../app/UserAvatar'
import { errorMessage, languages } from '../../app/utils'
import { Badge, Button, EmptyState, Icon, Input, LoadingState, Select, SelectOption, Switch, Tabs, useToast } from '../../design-system'
import { LanguageSelect } from '../languages'
import { useRecognitionLanguages } from '../sessions/useRecognitionLanguages'
import { useInsightFormat } from '../insights/format'
import { Allowance, Figures } from '../insights/InsightParts'
import { useAdminRefresh } from './AdminData'
import { AdminUserSignIn } from './AdminUserSignIn'
import { DeleteAccountDialog } from './DeleteAccountDialog'
import './admin-user-drawer.css'

type Tab = 'overview' | 'limits' | 'signin' | 'profile' | 'preferences'
type NumericLimit = 'concurrentRecordings' | 'monthlyRecordingMinutes' | 'storageMb' | 'workspaces'
type LimitDraft = Record<NumericLimit, string> & { guestLinks: 'default' | 'on' | 'off' }

export const NUMERIC_LIMITS: Array<{ key: NumericLimit; min: number; max: number; unit?: 'min' | 'MB'; zeroMeansNone?: boolean }> = [
  { key: 'concurrentRecordings', min: 1, max: 16 },
  { key: 'monthlyRecordingMinutes', min: 0, max: 1_000_000, unit: 'min', zeroMeansNone: true },
  { key: 'storageMb', min: 0, max: 10_000_000, unit: 'MB', zeroMeansNone: true },
  { key: 'workspaces', min: 1, max: 100 },
]
const NUMERIC = NUMERIC_LIMITS

/** What each limit is called and what it does, in the reader's language. */
export function useLimitText() {
  const { t } = useI18n()
  const text: Record<NumericLimit, { label: string; hint: string }> = {
    concurrentRecordings: { label: t('Recordings at once'), hint: t('Counted against the session’s owner, whoever records in it.') },
    monthlyRecordingMinutes: { label: t('Recording minutes a month'), hint: t('Recording stops when the month’s minutes run out. 0 is no limit.') },
    storageMb: { label: t('Storage in MB'), hint: t('New recordings can’t start once this is full. 0 is no limit.') },
    workspaces: { label: t('Workspaces'), hint: t('How many workspaces the account may have.') },
  }
  return text
}

function draftOf(overrides: LimitOverrides): LimitDraft {
  return {
    concurrentRecordings: overrides.concurrentRecordings?.toString() ?? '', monthlyRecordingMinutes: overrides.monthlyRecordingMinutes?.toString() ?? '',
    storageMb: overrides.storageMb?.toString() ?? '', workspaces: overrides.workspaces?.toString() ?? '',
    guestLinks: overrides.guestLinks === null ? 'default' : overrides.guestLinks ? 'on' : 'off',
  }
}

/** The overrides a draft asks for, or the first field that is out of range. */
function overridesOf(draft: LimitDraft): { value: LimitOverrides } | { invalid: NumericLimit } {
  const value = { guestLinks: draft.guestLinks === 'default' ? null : draft.guestLinks === 'on' } as LimitOverrides
  for (const field of NUMERIC) {
    const text = draft[field.key].trim()
    if (!text) { value[field.key] = null; continue }
    const number = Number(text)
    if (!Number.isInteger(number) || number < field.min || number > field.max) return { invalid: field.key }
    value[field.key] = number
  }
  return { value }
}

/**
 * One account in full, beside the people list: what it has used, what it
 * may use, and the profile and preferences its owner otherwise keeps. Every
 * change asks for the administrator's passkey, scoped to that exact change.
 */
export function AdminUserDrawer({ user, onClose, onUserChange, onUserDeleted, onUpdateAccess, busy: accessBusy, defaultsVersion = 0, onEditDefaults }: {
  user: User | null
  onClose: () => void
  onUserChange: (user: User) => void
  /** The account was deleted: the panel closes, and the list drops it. */
  onUserDeleted?: (user: User) => void
  onUpdateAccess: (user: User, input: Partial<Pick<User, 'role' | 'status'>>) => void
  busy?: boolean
  /** Changes when the default limits change, so the panel reads them again. */
  defaultsVersion?: number
  /** Opens the default limits every account follows unless set apart. */
  onEditDefaults?: () => void
}) {
  const { t } = useI18n()
  // The drawer keeps showing the account it opened with while it slides away.
  const [shown, setShown] = useState(user)
  if (user && user !== shown) setShown(user)
  return <Drawer open={!!user} onOpenChange={(open) => { if (!open) onClose() }} side="right" size="lg" closeLabel={t('Close')} className="admin-user-drawer">
    {shown ? <DrawerContents key={shown.id} user={user ?? shown} onUserChange={onUserChange} onUserDeleted={(deleted) => { onClose(); onUserDeleted?.(deleted) }} onUpdateAccess={onUpdateAccess} accessBusy={!!accessBusy} defaultsVersion={defaultsVersion} onEditDefaults={onEditDefaults} /> : null}
  </Drawer>
}

function DrawerContents({ user, onUserChange, onUserDeleted, onUpdateAccess, accessBusy, defaultsVersion, onEditDefaults }: { user: User; onUserChange: (user: User) => void; onUserDeleted: (user: User) => void; onUpdateAccess: (user: User, input: Partial<Pick<User, 'role' | 'status'>>) => void; accessBusy: boolean; defaultsVersion: number; onEditDefaults?: () => void }) {
  const { t, formatDate } = useI18n()
  const { user: currentUser } = useAuth()
  const { push } = useToast()
  const refresh = useAdminRefresh()
  const format = useInsightFormat()
  const [tab, setTab] = useState<Tab>('overview')
  const [detail, setDetail] = useState<{ status: 'loading' | 'ready' | 'error'; value?: AdminUserDetail; error?: string }>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState<AdminChangeKind | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let active = true
    api.admin.userDetail(user.id)
      .then((value) => { if (active) setDetail({ status: 'ready', value }) })
      .catch((caught) => { if (active) setDetail({ status: 'error', error: errorMessage(caught) }) })
    return () => { active = false }
  }, [user.id, attempt, defaultsVersion])

  /** Sends one change exactly as its passkey authorization was scoped. */
  const change = async <T,>(kind: AdminChangeKind, value: unknown, send: (token: string, body: string) => Promise<T>) => {
    setSaving(kind)
    try {
      const { body, scope } = await adminChange(kind, user.id, value)
      const authorization = await authorizePasskeyAction(scope)
      const result = await send(authorization.authorizationToken, body)
      refresh('audit')
      push({ tone: 'success', title: t('Changes saved') })
      return result
    } catch (caught) {
      push({ tone: 'error', title: t('Changes weren’t saved'), message: errorMessage(caught) })
      return undefined
    } finally { setSaving(null) }
  }

  const self = user.id === currentUser?.id
  const value = detail.value
  return <>
    <DrawerHeader>
      <div className="admin-drawer__identity">
        <UserAvatar user={user} size="lg" alt="" />
        <div>
          <DrawerTitle><bdi>{user.displayName}</bdi></DrawerTitle>
          <DrawerDescription>@<bdi>{user.username}</bdi></DrawerDescription>
          <div className="admin-drawer__badges">
            <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role === 'admin' ? t('Administrator') : t('Member')}</Badge>
            <Badge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status === 'active' ? t('Enabled') : t('Disabled')}</Badge>
            {self ? <Badge tone="info">{t('You')}</Badge> : null}
          </div>
        </div>
      </div>
      <Tabs label={t('Account sections')} value={tab} onChange={setTab} panelId="admin-drawer-panel" items={[
        { value: 'overview', label: t('Overview'), icon: 'chart' },
        { value: 'limits', label: t('Limits'), icon: 'sliders' },
        { value: 'signin', label: t('Sign-in'), icon: 'key' },
        { value: 'profile', label: t('Profile'), icon: 'user' },
        { value: 'preferences', label: t('Preferences'), icon: 'settings' },
      ]} />
    </DrawerHeader>
    <DrawerBody>
      <div id="admin-drawer-panel" role="tabpanel" className="admin-drawer__panel">
        {detail.status === 'error' ? <EmptyState icon="warning" title={t('This account couldn’t be loaded')} description={detail.error ?? ''} action={<Button icon="refresh" onClick={() => { setDetail({ status: 'loading' }); setAttempt((count) => count + 1) }}>{t('Try again')}</Button>} />
          : !value ? <LoadingState label={t('Loading account')} />
          : tab === 'overview' ? <div className="admin-drawer__section">
            <h3>{t('This month')}</h3>
            <Allowance limits={value.limits.effective} standing={value.standing} format={format} />
            <h3>{t('Account')}</h3>
            <Figures items={[
              { label: t('Sessions'), value: format.whole(value.standing.sessions) },
              { label: t('Member since'), value: formatDate(user.createdAt, { dateStyle: 'medium' }) },
              { label: t('Last seen'), value: value.standing.lastSeen ? formatDate(value.standing.lastSeen) : t('Never') },
              { label: t('Last changed'), value: formatDate(user.updatedAt, { dateStyle: 'medium' }) },
            ]} />
            <h3>{t('Role and access')}</h3>
            <div className="admin-drawer__rows">
              <div className="admin-drawer__row"><div><strong>{t('Role')}</strong><p>{t('Administrators manage people, access codes and the service.')}</p></div>
                <PlainSelect size="sm" aria-label={t('Role')} value={user.role} disabled={self || accessBusy} onValueChange={(role) => onUpdateAccess(user, { role: role as User['role'] })}><PlainOption value="user">{t('Member')}</PlainOption><PlainOption value="admin">{t('Administrator')}</PlainOption></PlainSelect></div>
              <div className="admin-drawer__row"><div><strong>{t('Account access')}</strong><p>{t('Disabling an account ends its active sessions.')}</p></div>
                <Switch ariaLabel={t('Account access for {name}', { name: user.displayName })} label={user.status === 'active' ? t('Enabled') : t('Disabled')} checked={user.status === 'active'} disabled={self || accessBusy} onChange={(enabled) => onUpdateAccess(user, { status: enabled ? 'active' : 'disabled' })} /></div>
            </div>
            {self ? <p className="admin-drawer__note"><Icon name="info" size={15} />{t('You can’t change your own role or access.')}</p> : null}
            {!self ? <>
              <h3>{t('Delete account')}</h3>
              <div className="admin-drawer__rows admin-drawer__rows--danger">
                <div className="admin-drawer__row"><div><strong>{t('Delete this account')}</strong><p>{t('Removes the account and everything it holds, for good. Disabling it keeps everything.')}</p></div>
                  <Button variant="danger" icon="trash" onClick={() => setDeleting(true)}>{t('Delete account')}</Button></div>
              </div>
              <DeleteAccountDialog user={user} standing={value.standing} open={deleting} onClose={() => setDeleting(false)} onDeleted={(deleted) => { setDeleting(false); refresh('audit'); refresh('invites'); onUserDeleted(deleted) }} />
            </> : null}
          </div>
          : tab === 'signin' ? <AdminUserSignIn user={user} self={self} />
          : tab === 'limits' ? <LimitsForm key={defaultsVersion} detail={value} saving={saving === 'limits'} format={format} onEditDefaults={onEditDefaults}
            onSave={async (overrides) => {
              const limits = await change('limits', overrides, (token, body) => api.admin.setUserLimits(token, user.id, body))
              if (limits) setDetail({ status: 'ready', value: { ...value, limits } })
            }} />
          : tab === 'profile' ? <ProfileForm user={user} saving={saving === 'profile'}
            onSave={async (profile) => {
              const updated = await change('profile', profile, (token, body) => api.admin.updateUserProfile(token, user.id, body))
              if (updated) { onUserChange(updated); setDetail({ status: 'ready', value: { ...value, user: updated } }) }
            }} />
          : <PreferencesForm settings={value.settings} saving={saving === 'settings'}
            onSave={async (settings) => {
              const updated = await change('settings', settings, (token, body) => api.admin.updateUserSettings(token, user.id, body))
              if (updated) setDetail({ status: 'ready', value: { ...value, settings: updated } })
            }} />}
      </div>
    </DrawerBody>
  </>
}

function LimitsForm({ detail, saving, format, onSave, onEditDefaults }: { detail: AdminUserDetail; saving: boolean; format: ReturnType<typeof useInsightFormat>; onSave: (overrides: LimitOverrides) => Promise<void>; onEditDefaults?: () => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(() => draftOf(detail.limits.overrides))
  const [invalid, setInvalid] = useState<NumericLimit | null>(null)
  const saved = draftOf(detail.limits.overrides)
  const changed = (Object.keys(draft) as Array<keyof LimitDraft>).some((key) => draft[key].trim() !== saved[key])
  const defaults = detail.limits.defaults
  const text = useLimitText()
  // An empty field shows, greyed, the default it follows — in the field's own unit.
  const defaultText = (field: (typeof NUMERIC)[number], limits: UserLimits) => field.zeroMeansNone && limits[field.key] === 0 ? t('No limit') : format.whole(limits[field.key])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = overridesOf(draft)
    if ('invalid' in result) { setInvalid(result.invalid); return }
    setInvalid(null)
    await onSave(result.value)
  }
  return <form className="admin-drawer__section" noValidate onSubmit={(event) => void submit(event)} aria-busy={saving}>
    <p className="admin-drawer__lead">{t('An empty limit follows the default, shown in grey. Changes apply to the next recording; one already running keeps going.')}
      {onEditDefaults ? <> <button type="button" className="admin-drawer__link" onClick={onEditDefaults}>{t('Change the defaults for everyone')}</button></> : null}</p>
    <div className="admin-drawer__rows">
      {NUMERIC.map((field) => <div key={field.key} className="admin-drawer__row admin-drawer__row--field">
        <div><strong>{text[field.key].label}</strong><p>{text[field.key].hint}</p></div>
        <Input type="number" inputMode="numeric" min={field.min} max={field.max} step={1} label={text[field.key].label}
          placeholder={defaultText(field, defaults)} value={draft[field.key]} clearable clearLabel={t('Back to the default')}
          suffix={<span className="limit-suffix">{field.unit ? <span>{field.unit === 'min' ? t('min') : field.unit}</span> : null}{draft[field.key].trim() ? null : <span className="limit-suffix__default">{t('Default')}</span>}</span>}
          error={invalid === field.key ? t('Use a whole number from {min} to {max}.', { min: format.whole(field.min), max: format.whole(field.max) }) : undefined}
          onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
      </div>)}
      <div className="admin-drawer__row admin-drawer__row--field">
        <div><strong>{t('Links for guests')}</strong><p>{t('Whether the account may share sessions with people who aren’t signed in. Turning this off closes links already shared.')}</p></div>
        <Select fullWidth label={t('Links for guests')} value={draft.guestLinks} onValueChange={(value) => setDraft({ ...draft, guestLinks: value as LimitDraft['guestLinks'] })}>
          <SelectOption value="default">{t('Default ({value})', { value: defaults.guestLinks ? t('Allowed') : t('Not allowed') })}</SelectOption>
          <SelectOption value="on">{t('Allowed')}</SelectOption>
          <SelectOption value="off">{t('Not allowed')}</SelectOption>
        </Select>
      </div>
    </div>
    <div className="admin-drawer__actions">
      <Button type="button" disabled={!changed || saving} onClick={() => { setDraft(saved); setInvalid(null) }}>{t('Discard changes')}</Button>
      <Button type="submit" variant="primary" icon="key" disabled={!changed} loading={saving}>{t('Verify and save')}</Button>
    </div>
  </form>
}

function ProfileForm({ user, saving, onSave }: { user: User; saving: boolean; onSave: (change: { displayName?: string; discoverable?: boolean; removeAvatar?: boolean }) => Promise<void> }) {
  const { t } = useI18n()
  const [name, setName] = useState(user.displayName)
  const [discoverable, setDiscoverable] = useState(user.discoverable !== false)
  const [removeAvatar, setRemoveAvatar] = useState(false)
  const trimmed = name.trim()
  const nameInvalid = !trimmed || [...trimmed].length > 80
  const change = {
    ...(trimmed !== user.displayName ? { displayName: trimmed } : {}),
    ...(discoverable !== (user.discoverable !== false) ? { discoverable } : {}),
    ...(removeAvatar ? { removeAvatar: true } : {}),
  }
  const changed = Object.keys(change).length > 0
  return <form className="admin-drawer__section" onSubmit={(event) => { event.preventDefault(); if (!nameInvalid) void onSave(change).then(() => setRemoveAvatar(false)) }} aria-busy={saving}>
    <p className="admin-drawer__lead">{t('Correct how this person appears to others. Their username and passkeys can’t be changed here.')}</p>
    <div className="admin-drawer__rows">
      <div className="admin-drawer__row admin-drawer__row--field"><div><strong>{t('Display name')}</strong><p>{t('Shown on sessions they own and beside what they say.')}</p></div>
        <Input dir="auto" label={t('Display name')} value={name} maxLength={80} error={nameInvalid ? t('Use a name of up to 80 characters.') : undefined} onChange={(event) => setName(event.target.value)} /></div>
      <div className="admin-drawer__row"><div><strong>{t('Findable by name')}</strong><p>{t('Whether people sharing a session can find this account by name.')}</p></div>
        <Switch ariaLabel={t('Findable by name')} label={discoverable ? t('On') : t('Off')} checked={discoverable} onChange={setDiscoverable} /></div>
      {user.avatarVersion ? <div className="admin-drawer__row"><div><strong>{t('Profile photo')}</strong><p>{t('Remove a photo that shouldn’t be shown. They can add another.')}</p></div>
        <Switch ariaLabel={t('Remove profile photo')} label={removeAvatar ? t('Remove') : t('Keep')} checked={removeAvatar} onChange={setRemoveAvatar} /></div> : null}
    </div>
    <div className="admin-drawer__actions">
      <Button type="button" disabled={!changed || saving} onClick={() => { setName(user.displayName); setDiscoverable(user.discoverable !== false); setRemoveAvatar(false) }}>{t('Discard changes')}</Button>
      <Button type="submit" variant="primary" icon="key" disabled={!changed || nameInvalid} loading={saving}>{t('Verify and save')}</Button>
    </div>
  </form>
}

function PreferencesForm({ settings, saving, onSave }: { settings: UserSettings; saving: boolean; onSave: (settings: UserSettings) => Promise<void> }) {
  const { t } = useI18n()
  const recognition = useRecognitionLanguages(true)
  const [draft, setDraft] = useState(settings)
  const fields: Array<keyof UserSettings> = ['defaultSourceLanguage', 'defaultTargetLanguage', 'autoStartMicrophone', 'showPartialTranscripts', 'compactTranscriptLayout', 'autoArchiveHours']
  const changed = fields.some((key) => draft[key] !== settings[key])
  const toggle = (key: 'autoStartMicrophone' | 'showPartialTranscripts' | 'compactTranscriptLayout', title: string, hint: string) =>
    <div className="admin-drawer__row"><div><strong>{title}</strong><p>{hint}</p></div><Switch ariaLabel={title} label={draft[key] ? t('On') : t('Off')} checked={draft[key]} onChange={(checked) => setDraft({ ...draft, [key]: checked })} /></div>
  return <form className="admin-drawer__section" onSubmit={(event) => { event.preventDefault(); void onSave({ defaultSourceLanguage: draft.defaultSourceLanguage, defaultTargetLanguage: draft.defaultTargetLanguage,
    autoStartMicrophone: draft.autoStartMicrophone, showPartialTranscripts: draft.showPartialTranscripts, compactTranscriptLayout: draft.compactTranscriptLayout, autoArchiveHours: draft.autoArchiveHours ?? 24 }) }} aria-busy={saving}>
    <p className="admin-drawer__lead">{t('The choices this person otherwise makes in their own settings. Their interface language and theme stay theirs.')}</p>
    <div className="admin-drawer__rows">
      <div className="admin-drawer__row admin-drawer__row--field"><div><strong>{t('Default recognition language')}</strong><p>{t('The starting choice for their new sessions.')}</p></div>
        <LanguageSelect label={t('Default recognition language')} value={draft.defaultSourceLanguage} includeAuto languages={recognition.choices} disabled={recognition.loading || !!recognition.error} onChange={(source) => setDraft({ ...draft, defaultSourceLanguage: source })} /></div>
      <div className="admin-drawer__row admin-drawer__row--field"><div><strong>{t('Translation language')}</strong><p>{t('What they read by default.')}</p></div>
        <LanguageSelect label={t('Translate to')} value={draft.defaultTargetLanguage} languages={languages} onChange={(target) => setDraft({ ...draft, defaultTargetLanguage: target })} /></div>
      <div className="admin-drawer__row admin-drawer__row--field"><div><strong>{t('Archive after inactivity')}</strong><p>{t('When their sessions become read only.')}</p></div>
        <Select fullWidth label={t('Archive after inactivity')} value={String(draft.autoArchiveHours ?? 24)} onValueChange={(value) => setDraft({ ...draft, autoArchiveHours: Number(value) })}>
          <SelectOption value="6">{t('6 hours')}</SelectOption><SelectOption value="24">{t('24 hours')}</SelectOption><SelectOption value="72">{t('3 days')}</SelectOption><SelectOption value="168">{t('7 days')}</SelectOption><SelectOption value="0">{t('Never')}</SelectOption>
        </Select></div>
      {toggle('showPartialTranscripts', t('Show partial speech'), t('Display interim recognition while a phrase is still being spoken.'))}
      {toggle('compactTranscriptLayout', t('Compact transcripts'), t('Reduce spacing to fit more lines on screen.'))}
      {toggle('autoStartMicrophone', t('Start microphone automatically'), t('When enabled, entering a newly created live session immediately asks for permission.'))}
    </div>
    <div className="admin-drawer__actions">
      <Button type="button" disabled={!changed || saving} onClick={() => setDraft(settings)}>{t('Discard changes')}</Button>
      <Button type="submit" variant="primary" icon="key" disabled={!changed} loading={saving}>{t('Verify and save')}</Button>
    </div>
  </form>
}
