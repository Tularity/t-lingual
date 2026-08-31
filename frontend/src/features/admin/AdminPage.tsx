import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AuditEvent, CreatedInvitation, Invitation, User } from '../../api/contracts'
import { Badge, Button, Card, Dialog, EmptyState, Icon, Input, PageHeader, Select, Skeleton, Switch, Tabs, useToast } from '../../design-system'
import { useAuth } from '../../app/auth'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage, formatDate } from '../../app/utils'
import './admin.css'

type AdminTab = 'invites' | 'users' | 'audit'
const adminPageSize = 200
async function fetchAdminOverview() {
  const firstPage = { limit: adminPageSize, offset: 0 }
  const [invites, users, audit] = await Promise.all([
    api.admin.invitations(firstPage),
    api.admin.users(firstPage),
    api.admin.audit(firstPage),
  ])
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
export function AdminPage() {
  const { user: currentUser } = useAuth(); const { push } = useToast()
  const [tab, setTab] = useState<AdminTab>('invites'); const [invites, setInvites] = useState<Invitation[]>([]); const [users, setUsers] = useState<User[]>([]); const [audit, setAudit] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [expiry, setExpiry] = useState('24'); const [creating, setCreating] = useState(false)
  const [hasMore, setHasMore] = useState<Record<AdminTab, boolean>>({ invites: false, users: false, audit: false }); const [loadingMore, setLoadingMore] = useState<AdminTab | null>(null)
  const [created, setCreated] = useState<CreatedInvitation | null>(null); const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null); const [disableTarget, setDisableTarget] = useState<User | null>(null); const [mutating, setMutating] = useState(false); const [query, setQuery] = useState('')
  const adminBusy = creating || mutating
  const applyOverview = useCallback((overview: Awaited<ReturnType<typeof fetchAdminOverview>>) => {
    setInvites(overview.invites)
    setUsers(overview.users)
    setAudit(overview.audit)
    setHasMore({ invites: overview.invites.length === adminPageSize, users: overview.users.length === adminPageSize, audit: overview.audit.length === adminPageSize })
  }, [])
  const load = async () => {
    setLoading(true)
    setError('')
    try { applyOverview(await fetchAdminOverview()) }
    catch (caught) { setError(errorMessage(caught)) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let active = true
    void fetchAdminOverview().then((overview) => {
      if (active) applyOverview(overview)
    }).catch((caught: unknown) => {
      if (active) setError(errorMessage(caught))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [applyOverview])
  const refreshAudit = () => { void api.admin.audit({ limit: adminPageSize, offset: 0 }).then((items) => { setAudit(items); setHasMore((current) => ({ ...current, audit: items.length === adminPageSize })) }).catch(() => undefined) }
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
    } catch (caught) { push({ tone: 'error', title: 'More records could not be loaded', message: errorMessage(caught) }) }
    finally { setLoadingMore(null) }
  }
  const createInvitation = async () => { setCreating(true); try { const expiresInHours = Number(expiry); const authorization = await authorizePasskeyAction(invitationCreateScope(expiresInHours)); const result = await api.admin.createInvitation(authorization.authorizationToken, { expiresInHours }); setCreated(result); setInvites((current) => [result.invitation, ...current]); refreshAudit(); push({ tone: 'success', title: 'Invitation created', message: 'Copy the code now; it will not be shown again.' }) } catch (caught) { push({ tone: 'error', title: 'Invitation wasn’t created', message: errorMessage(caught) }) } finally { setCreating(false) } }
  const copyCode = async (code: string) => { try { await navigator.clipboard.writeText(code); push({ tone: 'success', title: 'Invitation code copied' }) } catch { push({ tone: 'error', title: 'Clipboard access was denied' }) } }
  const revoke = async () => { if (!revokeTarget) return; setMutating(true); try { const authorization = await authorizePasskeyAction(invitationRevokeScope(revokeTarget.id)); await api.admin.revokeInvitation(authorization.authorizationToken, revokeTarget.id); setInvites((current) => current.map((item) => item.id === revokeTarget.id ? { ...item, revokedAt: new Date().toISOString() } : item)); setRevokeTarget(null); refreshAudit(); push({ tone: 'success', title: 'Invitation revoked' }) } catch (caught) { push({ tone: 'error', title: 'Invitation wasn’t revoked', message: errorMessage(caught) }) } finally { setMutating(false) } }
  const updateUser = async (target: User, input: Partial<Pick<User, 'role' | 'status'>>) => { setMutating(true); try { const authorization = await authorizePasskeyAction(userUpdateScope(target.id, input)); const updated = await api.admin.updateUser(authorization.authorizationToken, target.id, input); setUsers((current) => current.map((item) => item.id === target.id ? updated : item)); setDisableTarget(null); refreshAudit(); push({ tone: 'success', title: 'User updated' }) } catch (caught) { push({ tone: 'error', title: 'User wasn’t updated', message: errorMessage(caught) }) } finally { setMutating(false) } }
  const filteredUsers = users.filter((user) => `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <>
    <PageHeader eyebrow="Administration" title="Workspace access" description="Create single-use invitations and manage roles. Every change requires fresh passkey verification." />
    <Tabs label="Administration sections" value={tab} onChange={setTab} panelId={!loading && !error ? 'administration-panel' : undefined} items={[{ value: 'invites', label: 'Invitation codes', icon: 'key' }, { value: 'users', label: 'Users', icon: 'users' }, { value: 'audit', label: 'Activity', icon: 'history' }]} />
    {loading ? <div className="admin-loading" role="status" aria-label="Loading administration"><Skeleton height={130} /><Skeleton height={340} /></div> : error ? <Card><EmptyState icon="warning" title="Administration unavailable" description={error} action={<Button onClick={() => void load()}>Try again</Button>} /></Card> : <div id="administration-panel" className="admin-panel" role="tabpanel" aria-label={`${tab === 'invites' ? 'Invitation codes' : tab === 'users' ? 'Users' : 'Activity'} administration`} aria-busy={adminBusy || loadingMore !== null}>
      {tab === 'invites' && <><Card className="invite-create" raised><div className="invite-create__icon"><Icon name="key" size={25} /></div><div><h2>Create an invitation</h2><p>Verify a passkey to create one single-use six-digit registration code.</p></div><Select label="Expires after" value={expiry} disabled={adminBusy} onChange={(event) => setExpiry(event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></Select><Button variant="primary" icon="key" loading={creating} disabled={mutating} onClick={() => void createInvitation()}>Verify and generate</Button></Card><div className="admin-section-heading"><div><h2>Recent invitations</h2><p>Clear codes are returned once at creation and never retained.</p></div><Badge tone="neutral">{invites.filter((invite) => !invite.usedAt && !invite.revokedAt && new Date(invite.expiresAt) > new Date()).length} active</Badge></div>{invites.length === 0 ? <Card><EmptyState icon="key" title="No invitations yet" description="Generate a code when you’re ready to invite the first user." /></Card> : <Card className="invite-list" role="list">{invites.map((invite) => { const expired = new Date(invite.expiresAt) <= new Date(); const status = invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : expired ? 'expired' : 'active'; return <div className="invite-row" role="listitem" key={invite.id}><span className="invite-id"><Icon name="key" size={16} /><bdi>{invite.id.length > 14 ? `${invite.id.slice(0, 14)}…` : invite.id}</bdi></span><div className="invite-row__details"><strong>{status === 'used' ? (invite.usedBy ? <>Used by <bdi>{invite.usedBy}</bdi></> : 'Used') : status === 'active' ? `Expires ${formatDate(invite.expiresAt)}` : status.charAt(0).toUpperCase() + status.slice(1)}</strong><span>Created {formatDate(invite.createdAt)}</span></div><Badge tone={status === 'active' ? 'success' : status === 'used' ? 'info' : 'neutral'} dot={status === 'active'}>{status}</Badge>{status === 'active' ? <Button variant="ghost" size="sm" disabled={adminBusy} onClick={() => setRevokeTarget(invite)}>Revoke</Button> : <span className="invite-row__action" />}</div>})}</Card>}{hasMore.invites && <div className="admin-load-more"><Button loading={loadingMore === 'invites'} onClick={() => void loadMore('invites')}>Load more invitations</Button></div>}</>}
      {tab === 'users' && <><div className="admin-section-heading admin-section-heading--users"><div><h2>Users</h2><p>Disabling a user revokes all of their browser sessions.</p></div><div className="admin-user-search"><Input dir="auto" label="Search users" icon="search" placeholder="Search people…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="sr-only" aria-live="polite">{filteredUsers.length} users shown</span></div></div>{filteredUsers.length === 0 ? <Card><EmptyState icon="search" title="No matching users" description={hasMore.users ? 'No match among the users loaded so far. Load more users, then search again.' : 'Try another name or username.'} /></Card> : <Card className="user-table"><div className="user-table__header"><span>User</span><span>Activity</span><span>Role</span><span>Enabled</span></div>{filteredUsers.map((user) => { const isSelf = currentUser?.id === user.id; return <div className="user-row" key={user.id}><div className="admin-user"><span>{user.displayName.charAt(0).toUpperCase()}</span><div><strong><bdi>{user.displayName}</bdi>{isSelf && <Badge tone="accent">You</Badge>}</strong><small>@<bdi>{user.username}</bdi></small></div></div><div className="user-activity"><strong>Joined {formatDate(user.createdAt, { dateStyle: 'medium' })}</strong><small>Updated {formatDate(user.updatedAt)}</small></div><Select label={`Role for ${user.displayName}`} value={user.role} disabled={isSelf || adminBusy} onChange={(event) => void updateUser(user, { role: event.target.value as User['role'] })}><option value="user">User</option><option value="admin">Admin</option></Select><Switch ariaLabel={`Account access for ${user.displayName}`} label={user.status === 'disabled' ? 'Disabled' : 'Enabled'} checked={user.status === 'active'} disabled={isSelf || adminBusy} onChange={(enabled) => { if (!enabled) setDisableTarget(user); else void updateUser(user, { status: 'active' }) }} /></div>})}</Card>}{hasMore.users && <div className="admin-load-more"><Button loading={loadingMore === 'users'} onClick={() => void loadMore('users')}>Load more users</Button></div>}</>}
      {tab === 'audit' && <><div className="admin-section-heading"><div><h2>Administrative activity</h2><p>Server-recorded role, status and invitation actions.</p></div><Badge tone="neutral">{audit.length} events</Badge></div>{audit.length === 0 ? <Card><EmptyState icon="history" title="No activity yet" description="Administrative changes will be recorded here." /></Card> : <Card className="audit-list">{audit.map((event) => <article className="audit-row" key={event.id}><span className="audit-row__icon"><Icon name={event.action.startsWith('user.') ? 'user' : 'key'} size={18} /></span><div className="audit-row__main"><strong><bdi>{event.action.split('.').join(' ')}</bdi></strong><p><bdi>{event.targetType}</bdi> · <bdi>{event.targetId}</bdi></p>{summarizeAuditMetadata(event.metadata) && <small dir="auto">{summarizeAuditMetadata(event.metadata)}</small>}</div><div className="audit-row__actor"><span>{event.actorUserId ? <>Actor <bdi>{event.actorUserId}</bdi></> : 'Container CLI'}</span><time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time></div></article>)}</Card>}{hasMore.audit && <div className="admin-load-more"><Button loading={loadingMore === 'audit'} onClick={() => void loadMore('audit')}>Load more activity</Button></div>}</>}
    </div>}
    <Dialog open={!!created} onClose={() => setCreated(null)} title="Copy this invitation now" description="For security, the clear code is shown only once and cannot be recovered later." footer={<><Button onClick={() => setCreated(null)}>Done</Button><Button variant="primary" icon="copy" onClick={() => created && void copyCode(created.code)}>Copy code</Button></>}><button type="button" className="confirm-code" aria-label={created ? `Copy invitation code ${created.code}` : 'Copy invitation code'} onClick={() => created && void copyCode(created.code)}>{created?.code}</button></Dialog>
    <Dialog open={!!revokeTarget} onClose={() => !mutating && setRevokeTarget(null)} title="Revoke invitation?" description="Verify a passkey to make this invitation stop working immediately." footer={<><Button disabled={mutating} onClick={() => setRevokeTarget(null)}>Cancel</Button><Button variant="danger" icon="key" loading={mutating} onClick={() => void revoke()}>Verify and revoke</Button></>}><div className="delete-summary"><Icon name="key" size={20} /><strong><bdi>{revokeTarget?.id}</bdi></strong></div></Dialog>
    <Dialog open={!!disableTarget} onClose={() => !mutating && setDisableTarget(null)} title="Disable this user?" description="Verify a passkey to revoke their access immediately. Their isolated sessions remain stored." footer={<><Button disabled={mutating} onClick={() => setDisableTarget(null)}>Cancel</Button><Button variant="danger" icon="key" loading={mutating} onClick={() => disableTarget && void updateUser(disableTarget, { status: 'disabled' })}>Verify and disable</Button></>}><div className="delete-summary"><Icon name="user" size={20} /><strong><bdi>{disableTarget?.displayName}</bdi></strong></div></Dialog>
  </>
}
