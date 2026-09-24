import { useI18n } from '../../app/i18n'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { AuditEvent, CreatedInvitation, Invitation, User } from '../../api/contracts'
import { Badge, Button, Card, Dialog, EmptyState, Icon, Input, Select, Skeleton, Switch as FrameworkSwitch, Tabs, useToast } from '../../design-system'
import { useAuth } from '../../app/auth'
import { codeCreateScope } from '../../app/accessCodes'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage } from '../../app/utils'
import { ProvidersPanel } from './ProvidersPanel'
import './admin.css'
const SiteSettingsPanel=lazy(()=>import('./SiteSettingsPanel').then(module=>({default:module.SiteSettingsPanel})))

type AdminTab = 'invites' | 'users' | 'audit' | 'providers' | 'site'
type InviteStatus = 'all' | 'scheduled' | 'active' | 'used' | 'expired' | 'revoked'
const adminPageSize = 200
const adminTabs = [
  { value: 'invites' as const, label: 'Access codes', icon: 'key' as const },
  { value: 'users' as const, label: 'People', icon: 'users' as const },
  { value: 'providers' as const, label: 'Engines', icon: 'settings' as const },
  { value: 'site' as const, label: 'Site settings', icon: 'settings' as const },
  { value: 'audit' as const, label: 'Activity', icon: 'history' as const },
]

function Switch({ ariaLabel, label, checked, disabled, onChange }: { ariaLabel: string; label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <span className="admin-access"><FrameworkSwitch ariaLabel={ariaLabel} label={ariaLabel} checked={checked} disabled={disabled} onChange={onChange} /><span aria-hidden="true">{label}</span></span>
}

async function fetchAdminOverview() {
  const query = { limit: adminPageSize, offset: 0 }
  const [invites, users, audit] = await Promise.all([api.admin.invitations(query), api.admin.users(query), api.admin.audit(query)])
  return { invites, users, audit }
}

export function invitationCreateScope(expiresInHours: number) { return `admin:invitation:create:${expiresInHours}` }
export function invitationRevokeScope(invitationId: string) { return `admin:invitation:revoke:${invitationId}` }
export function userUpdateScope(userId: string, input: Partial<Pick<User, 'role' | 'status'>>) { return `admin:user:update:${userId}:${input.role ?? '-'}:${input.status ?? '-'}` }
export function summarizeAuditMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return ''
  return Object.entries(metadata as Record<string, unknown>).slice(0, 3).map(([key, value]) => {
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/gu, '').slice(0, 30)
    const rendered = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).slice(0, 80) : value === null ? 'null' : '[details]'
    return `${safeKey}: ${rendered}`
  }).join(' · ')
}

function invitationStatus(invitation: Invitation, now = Date.now()): Exclude<InviteStatus, 'all'> {
  if (invitation.revokedAt) return 'revoked'
  if (invitation.usedAt) return 'used'
  if (new Date(invitation.expiresAt).getTime() <= now) return 'expired'
  if(invitation.notBefore&&new Date(invitation.notBefore).getTime()>now)return 'scheduled'
  return 'active'
}

function actionTitle(action: string, t: (key: string, params?: Record<string, string | number>) => string) {
  const names: Record<string, string> = {
    'invitation.create': 'Invitation created', 'invitation.revoke': 'Invitation revoked',
    'site_settings.update': 'Site settings saved', 'invitation.use': 'Invitation redeemed', 'user.role.set': 'Role changed',
    'user.status.set': 'Account access changed',
  }
  return names[action] ? t(names[action]) : action.replace(/[._]/gu, ' ').replace(/^./u, (letter) => letter.toUpperCase())
}

function auditDetail(event: AuditEvent, t: (key: string, params?: Record<string, string | number>) => string, localDate: (value: string) => string) {
  if (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) return ''
  const metadata = event.metadata as Record<string, unknown>
  if (event.action === 'user.role.set' && (metadata.role === 'admin' || metadata.role === 'user')) return t('Role set to {role}', { role: metadata.role === 'admin' ? t('Administrator') : t('Member') })
  if (event.action === 'user.status.set' && (metadata.status === 'active' || metadata.status === 'disabled')) return t('Access {status}', { status: metadata.status === 'active' ? t('enabled') : t('disabled') })
  if (event.action === 'invitation.create' && typeof metadata.expiresAt === 'string' && Number.isFinite(Date.parse(metadata.expiresAt))) return t('Expires {date}', { date: localDate(metadata.expiresAt) })
  return ''
}

export function AdminPage() {
  const { t, formatDate: localDate } = useI18n()
  const { user: currentUser } = useAuth()
  const { push } = useToast()
  const [tab, setTab] = useState<AdminTab>('invites')
  const [invites, setInvites] = useState<Invitation[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expiry, setExpiry] = useState('24')
  const [codeDialogOrigin,setCodeDialogOrigin]=useState<{x:number;y:number}>()
  const [codeKind,setCodeKind]=useState<'registration'|'login'>('registration')
  const [codeUser,setCodeUser]=useState('')
  const [notBefore,setNotBefore]=useState('')
  const [loginMinutes,setLoginMinutes]=useState('10')
  const [creating, setCreating] = useState(false)
  const [hasMore, setHasMore] = useState<Record<AdminTab, boolean>>({ invites: false, users: false, audit: false, providers: false, site:false })
  const [loadingMore, setLoadingMore] = useState<AdminTab | null>(null)
  const [created, setCreated] = useState<CreatedInvitation | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null)
  const [disableTarget, setDisableTarget] = useState<User | null>(null)
  const [mutating, setMutating] = useState(false)
  const [query, setQuery] = useState('')
  const [inviteFilter, setInviteFilter] = useState<InviteStatus>('all')
  const [auditFilter, setAuditFilter] = useState('all')
  const [clock, setClock] = useState(Date.now)
  const adminBusy = creating || mutating
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])

  const applyOverview = useCallback((overview: Awaited<ReturnType<typeof fetchAdminOverview>>) => {
    setInvites(overview.invites)
    setUsers(overview.users)
    setAudit(overview.audit)
    setHasMore({ invites: overview.invites.length === adminPageSize, users: overview.users.length === adminPageSize, audit: overview.audit.length === adminPageSize, providers: false, site:false })
  }, [])
  const load = async () => {
    setLoading(true); setError('')
    try { applyOverview(await fetchAdminOverview()) }
    catch (caught) { setError(errorMessage(caught)) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let active = true
    void fetchAdminOverview().then((overview) => { if (active) applyOverview(overview) })
      .catch((caught: unknown) => { if (active) setError(errorMessage(caught)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [applyOverview])

  const refreshAudit = () => {
    void api.admin.audit({ limit: adminPageSize, offset: 0 }).then((items) => {
      setAudit(items)
      setHasMore((current) => ({ ...current, audit: items.length === adminPageSize }))
    }).catch(() => undefined)
  }
  const loadMore = async (section: AdminTab) => {
    if (!hasMore[section] || loadingMore) return
    setLoadingMore(section)
    try {
      if (section === 'invites') {
        const items = await api.admin.invitations({ limit: adminPageSize, offset: invites.length })
        setInvites((current) => [...current, ...items]); setHasMore((current) => ({ ...current, invites: items.length === adminPageSize }))
      } else if (section === 'users') {
        const items = await api.admin.users({ limit: adminPageSize, offset: users.length })
        setUsers((current) => [...current, ...items]); setHasMore((current) => ({ ...current, users: items.length === adminPageSize }))
      } else {
        const items = await api.admin.audit({ limit: adminPageSize, offset: audit.length })
        setAudit((current) => [...current, ...items]); setHasMore((current) => ({ ...current, audit: items.length === adminPageSize }))
      }
    } catch (caught) { push({ tone: 'error', title: t('More records could not be loaded'), message: errorMessage(caught) }) }
    finally { setLoadingMore(null) }
  }

  const createInvitation = async () => {
    setCreating(true)
    try {
      const input={kind:codeKind,...(codeKind==='login'?{targetUserId:codeUser}:{}),...(notBefore?{notBefore:new Date(notBefore).toISOString()}:{}),ttlSeconds:codeKind==='login'?Number(loginMinutes)*60:Number(expiry)*3600}
      const authorization=await authorizePasskeyAction(await codeCreateScope(input))
      const result=await api.admin.createCode(authorization.authorizationToken,input)
      const invitation:Invitation={id:result.id,kind:result.kind,targetUserId:result.targetUserId,notBefore:result.notBefore,expiresAt:result.expiresAt,createdAt:new Date().toISOString(),createdBy:currentUser?.id??null,usedAt:null,usedBy:null,revokedAt:null}
      setCreated({code:result.code,invitation});setInvites(current=>[invitation,...current]);refreshAudit()
      push({tone:'success',title:t('Code created'),message:t('Copy the code now; it will not be shown again.')})
    } catch (caught) { push({ tone: 'error', title: t('Code could not be created'), message: errorMessage(caught) }) }
    finally { setCreating(false) }
  }
  const copyCode = async (code: string) => {
    try { await copyTextToClipboard(code); push({ tone: 'success', title: t('Invitation code copied') }) }
    catch { push({ tone: 'error', title: t('Clipboard access was denied') }) }
  }
  const revoke = async () => {
    if (!revokeTarget) return
    setMutating(true)
    try {
      const authorization = await authorizePasskeyAction(invitationRevokeScope(revokeTarget.id))
      await api.admin.revokeInvitation(authorization.authorizationToken, revokeTarget.id)
      setInvites((current) => current.map((item) => item.id === revokeTarget.id ? { ...item, revokedAt: new Date().toISOString() } : item))
      setRevokeTarget(null); refreshAudit(); push({ tone: 'success', title: t('Invitation revoked') })
    } catch (caught) { push({ tone: 'error', title: t('Invitation wasn’t revoked'), message: errorMessage(caught) }) }
    finally { setMutating(false) }
  }
  const updateUser = async (target: User, input: Partial<Pick<User, 'role' | 'status'>>) => {
    setMutating(true)
    try {
      const authorization = await authorizePasskeyAction(userUpdateScope(target.id, input))
      const updated = await api.admin.updateUser(authorization.authorizationToken, target.id, input)
      setUsers((current) => current.map((item) => item.id === target.id ? updated : item))
      setDisableTarget(null); refreshAudit(); push({ tone: 'success', title: t('User updated') })
    } catch (caught) { push({ tone: 'error', title: t('User wasn’t updated'), message: errorMessage(caught) }) }
    finally { setMutating(false) }
  }

  const activeCount = invites.filter((invite) => invitationStatus(invite, clock) === 'active').length
  const filteredInvites = invites.filter((invite) => inviteFilter === 'all' || invitationStatus(invite, clock) === inviteFilter)
  const filteredUsers = users.filter((user) => `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const filteredAudit = audit.filter((event) => auditFilter === 'all' || event.action.startsWith(auditFilter))
  const displayUser = (id: string | null) => id ? users.find((user) => user.id === id)?.displayName ?? t('A user') : t('Container CLI')
  const describeTarget = (event: AuditEvent) => {
    if (event.targetType === 'user') return displayUser(event.targetId)
    if (event.targetType === 'invitation') {
      const invite = invites.find((item) => item.id === event.targetId)
      return invite ? t('Invitation from {date}', { date: localDate(invite.createdAt, { dateStyle: 'medium' }) }) : t('Invitation')
    }
    return event.targetType.replace(/[_-]/gu, ' ')
  }
  const loadMoreButton = (section: AdminTab, label: string) => hasMore[section] && <div className="admin-load-more"><Button loading={loadingMore === section} onClick={() => void loadMore(section)}>{t(label)}</Button></div>

  return <>
    <h1 className="sr-only">{t("Administration")}</h1>
    <div className="admin-topline"><Tabs label={t("Administration sections")} value={tab} onChange={setTab} panelId={!loading && !error ? 'administration-panel' : undefined} items={adminTabs.map((item) => ({ ...item, label: t(item.label) }))} /></div>
    {loading ? <div className="admin-loading" role="status" aria-label={t("Loading administration")}><Skeleton height={130} /><Skeleton height={340} /></div> : error ? <Card><EmptyState icon="warning" title={t("Administration unavailable")} description={error} action={<Button icon="refresh" onClick={() => void load()}>{t("Try again")}</Button>} /></Card> : <div id="administration-panel" className="admin-panel" role="tabpanel" aria-label={t('{section} administration', { section: t(adminTabs.find((item) => item.value === tab)?.label ?? 'Administration') })} aria-busy={adminBusy || loadingMore !== null}>
      {tab === 'providers' && <ProvidersPanel />}
      {tab === 'site' && <Suspense fallback={<Skeleton height={320}/>}><SiteSettingsPanel /></Suspense>}
      {tab === 'invites' && <>
        <Card className="invite-create invite-create--codes" raised>
          <div className="invite-create__icon"><Icon name="key" size={24}/></div>
          <div className="invite-create__copy"><h2>{t('Create an access code')}</h2><p>{t('One code field handles new accounts and temporary sign-in. Every code can be used once.')}</p></div>
          <div className="invite-create__fields">
            <Select label={t('Code purpose')} value={codeKind} disabled={adminBusy} onChange={event=>setCodeKind(event.target.value as typeof codeKind)}><option value="registration">{t('Register a new account')}</option><option value="login">{t('Sign in to an existing account')}</option></Select>
            {codeKind==='login'&&<Select label={t('Account to sign in')} value={codeUser} disabled={adminBusy} onChange={event=>setCodeUser(event.target.value)}><option value="">{t('Choose a user')}</option>{users.filter(user=>user.status==='active').map(user=><option key={user.id} value={user.id}>{user.displayName} · @{user.username}</option>)}</Select>}
            <Input type="datetime-local" label={t('Active from (optional)')} hint={t('Leave empty to activate immediately. Times use your local timezone.')} value={notBefore} disabled={adminBusy} onChange={event=>setNotBefore(event.target.value)}/>
            {codeKind==='registration'?<Select label={t('Code valid for')} value={expiry} disabled={adminBusy} onChange={event=>setExpiry(event.target.value)}><option value="1">{t('1 hour')}</option><option value="24">{t('24 hours')}</option><option value="72">{t('3 days')}</option><option value="168">{t('7 days')}</option></Select>:<Select label={t('Code valid for')} value={loginMinutes} disabled={adminBusy} onChange={event=>setLoginMinutes(event.target.value)}>{['5','10','15'].map(value=><option key={value} value={value}>{t('{count} minutes',{count:Number(value)})}</option>)}</Select>}
          </div>
          <Button variant="primary" icon="plus" loading={creating} disabled={mutating||codeKind==='login'&&!codeUser} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setCodeDialogOrigin({x:rect.left+rect.width/2,y:rect.top+rect.height/2});void createInvitation()}}>{t('Verify and generate')}</Button>
        </Card>
        <div className="admin-section-heading"><div><h2>{t("Access code history")} <span className="admin-section-count">{activeCount} {t("active")}</span></h2><p>{t("Codes are only visible when first generated. You can revoke unused codes here.")}</p></div><Select label={t("Filter invitations")} value={inviteFilter} onChange={(event) => setInviteFilter(event.target.value as InviteStatus)}><option value="all">{t("All invitations")}</option><option value="active">{t("Active")}</option><option value="scheduled">{t("Scheduled")}</option><option value="used">{t("Used")}</option><option value="expired">{t("Expired")}</option><option value="revoked">{t("Revoked")}</option></Select></div>
        {filteredInvites.length === 0 ? <Card><EmptyState icon="key" title={invites.length ? t('No invitations in this view') : t('No invitations yet')} description={invites.length ? t('Choose another status to see invitations.') : t('Generate a code to invite the first person.')} /></Card> : <Card className="invite-list" role="list" aria-label={t("Access code history")}>{filteredInvites.map((invite, index) => {
          const status = invitationStatus(invite, clock)
          const usedName = invite.usedBy ? displayUser(invite.usedBy) : t('a user')
          return <div className="invite-row" role="listitem" key={invite.id}>
            <span className="invite-row__mark" aria-hidden="true"><Icon name={status === 'used' ? 'check' : 'key'} size={18} /></span>
            <div className="invite-row__details"><strong>{invite.kind==='login'?t('Sign-in code'):t('Registration code')} {String(invites.indexOf(invite) + 1 || index + 1).padStart(2, '0')}</strong>{invite.targetUserId&&<span>{t('For {name}',{name:displayUser(invite.targetUserId)})}</span>}<span>{t("Created")} <time dateTime={invite.createdAt}>{localDate(invite.createdAt)}</time>{invite.createdBy ? t(' by {name}', { name: displayUser(invite.createdBy) }) : t(' from the container CLI')}</span><small>{status === 'used' ? t('Redeemed by {name}', { name: usedName }) : status === 'scheduled' ? t('Active from {date}',{date:localDate(invite.notBefore!)}) : status === 'active' ? t('Expires {date}', { date: localDate(invite.expiresAt) }) : status === 'expired' ? t('Expired {date}', { date: localDate(invite.expiresAt) }) : t('Revoked {date}', { date: localDate(invite.revokedAt!) })}</small></div>
            <Badge tone={status === 'active' ? 'success' : status === 'used' ? 'info' : 'neutral'} dot={status === 'active'}>{t(status.charAt(0).toUpperCase() + status.slice(1))}</Badge>
            {(status === 'active'||status==='scheduled') && <Button variant="ghost" size="sm" disabled={adminBusy} onClick={() => setRevokeTarget(invite)}>{t("Revoke")}</Button>}
          </div>
        })}</Card>}
        {loadMoreButton('invites', 'Load more invitations')}
      </>}
      {tab === 'users' && <>
        <div className="admin-section-heading admin-section-heading--users"><div><h2>{t("People")} <span className="admin-section-count">{users.length}{hasMore.users ? '+' : ''} {t("loaded")}</span></h2><p>{t("Changes require your passkey. Disabling an account ends its active sessions.")}</p></div><div className="admin-user-search"><Input dir="auto" label={t("Search users")} icon="search" placeholder={t("Search by name or username")} value={query} onChange={(event) => setQuery(event.target.value)} /><span className="sr-only" aria-live="polite">{filteredUsers.length} {t("users shown")}</span></div></div>
        {filteredUsers.length === 0 ? <Card><EmptyState icon="search" title={users.length ? t('No matching people') : t('No people yet')} description={hasMore.users ? t('No match among loaded people. Load more to extend this search.') : t('Try another name or username.')} /></Card> : <Card className="user-table"><div className="user-table__header"><span>{t("Person")}</span><span>{t("Member since")}</span><span>{t("Role")}</span><span>{t("Access")}</span></div>{filteredUsers.map((user) => {
          const isSelf = currentUser?.id === user.id
          return <div className="user-row" key={user.id}>
            <div className="admin-user"><span aria-hidden="true">{user.displayName.charAt(0).toUpperCase()}</span><div><strong><bdi>{user.displayName}</bdi>{isSelf && <Badge tone="accent">{t("You")}</Badge>}</strong><small>@<bdi>{user.username}</bdi></small></div></div>
            <div className="user-activity"><strong>{localDate(user.createdAt, { dateStyle: 'medium' })}</strong><small>{t("Updated")} {localDate(user.updatedAt)}</small></div>
            <Select label={t('Role for {name}', { name: user.displayName })} value={user.role} disabled={isSelf || adminBusy} onChange={(event) => void updateUser(user, { role: event.target.value as User['role'] })}><option value="user">{t("Member")}</option><option value="admin">{t("Administrator")}</option></Select>
            <Switch ariaLabel={t('Account access for {name}', { name: user.displayName })} label={user.status === 'disabled' ? t('Disabled') : t('Enabled')} checked={user.status === 'active'} disabled={isSelf || adminBusy} onChange={(enabled) => { if (!enabled) setDisableTarget(user); else void updateUser(user, { status: 'active' }) }} />
          </div>
        })}</Card>}
        {loadMoreButton('users', 'Load more people')}
      </>}
      {tab === 'audit' && <>
        <div className="admin-section-heading"><div><h2>{t("Access activity")} <span className="admin-section-count">{audit.length}{hasMore.audit ? '+' : ''} {t("events")}</span></h2><p>{t("Recent invitation, role and account status changes recorded by the server.")}</p></div><Select label={t("Filter activity")} value={auditFilter} onChange={(event) => setAuditFilter(event.target.value)}><option value="all">{t("All activity")}</option><option value="invitation.">{t("Invitations")}</option><option value="user.">{t("Accounts")}</option></Select></div>
        {filteredAudit.length === 0 ? <Card><EmptyState icon="history" title={audit.length ? t('No activity in this view') : t('No activity yet')} description={audit.length ? t('Choose another activity type.') : t('Access changes will appear here after the first action.')} /></Card> : <Card className="audit-list">{filteredAudit.map((event) => <article className="audit-row" key={event.id}>
          <span className="audit-row__icon"><Icon name={event.action.startsWith('user.') ? 'user' : 'key'} size={18} /></span>
          <div className="audit-row__main"><strong>{actionTitle(event.action, t)}</strong><p><bdi>{describeTarget(event)}</bdi></p>{auditDetail(event, t, localDate) && <small>{auditDetail(event, t, localDate)}</small>}</div>
          <div className="audit-row__actor"><span>{t("By")} <bdi>{displayUser(event.actorUserId)}</bdi></span><time dateTime={event.createdAt}>{localDate(event.createdAt)}</time></div>
        </article>)}</Card>}
        {loadMoreButton('audit', 'Load more activity')}
      </>}
    </div>}
    <Dialog open={!!created} origin={codeDialogOrigin} onClose={() => setCreated(null)} title={t("Copy this code now")} description={t("The six-digit code is shown once. Share it privately with its intended recipient.")} footer={<><Button onClick={() => setCreated(null)}>{t("Done")}</Button><Button variant="primary" icon="copy" onClick={() => created && void copyCode(created.code)}>{t("Copy code")}</Button></>}><button type="button" className="confirm-code" aria-label={t("Copy code")} onClick={() => created && void copyCode(created.code)}>{created?.code}</button><p className="confirm-code-hint">{created&&t('Active from {date}',{date:localDate(created.invitation.notBefore??created.invitation.createdAt)})}<br/>{t("Expires")} {created && localDate(created.invitation.expiresAt)} {t("· One use only")}</p></Dialog>
    <Dialog open={!!revokeTarget} onClose={() => !mutating && setRevokeTarget(null)} title={t("Revoke invitation?")} description={t("Verify your passkey to make this unused invitation stop working immediately.")} footer={<><Button disabled={mutating} onClick={() => setRevokeTarget(null)}>{t("Cancel")}</Button><Button variant="danger" icon="key" loading={mutating} onClick={() => void revoke()}>{t("Verify and revoke")}</Button></>}><div className="delete-summary"><Icon name="key" size={20} /><strong>{t("Created")} {revokeTarget && localDate(revokeTarget.createdAt)}</strong></div></Dialog>
    <Dialog open={!!disableTarget} onClose={() => !mutating && setDisableTarget(null)} title={t("Disable this account?")} description={t("Verify your passkey to end this person’s access immediately. Their stored sessions and transcripts remain private to them.")} footer={<><Button disabled={mutating} onClick={() => setDisableTarget(null)}>{t("Cancel")}</Button><Button variant="danger" icon="key" loading={mutating} onClick={() => disableTarget && void updateUser(disableTarget, { status: 'disabled' })}>{t("Verify and disable")}</Button></>}><div className="delete-summary"><Icon name="user" size={20} /><strong><bdi>{disableTarget?.displayName}</bdi></strong></div></Dialog>
  </>
}
