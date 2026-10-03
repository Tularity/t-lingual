import { useEffect, useMemo, useState } from 'react'
import { DataTable, Drawer, DrawerBody, DrawerFooter, DrawerHeader, DrawerTitle, SearchSelect, SegmentedControl, type DataTableColumn } from '@tular/ui'
import { api } from '../../api/client'
import type { CreateCodeInput, Invitation, User } from '../../api/contracts'
import { Badge, Button, Card, Dialog, EmptyState, Icon, Input, LoadingState, useToast } from '../../design-system'
import type { IconName } from '../../design-system/icons'
import { codeCreateScope } from '../../app/accessCodes'
import { useAuth } from '../../app/auth'
import { UserAvatar } from '../../app/UserAvatar'
import { useDataTableLabels, useTablePreferences } from '../../app/dataTable'
import { useI18n } from '../../app/i18n'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage } from '../../app/utils'
import { ADMIN_LIST_LIMIT, useAdminList, useAdminRefresh } from './AdminData'
import { actionTitle, auditDetail, durationWords, invitationRevokeScope, invitationStart, invitationStatus, numberCodes, type CodeStatus } from './adminModel'
import { CreatedCodeDialog } from './CreatedCodeDialog'
import './admin.css'
import './access-codes.css'

type Filter = 'all' | CodeStatus | 'expiring'
type Kind = CreateCodeInput['kind']

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** The usual lengths, one click each; any other length is set in a dialog. */
const lifetimes: Record<Kind, Array<{ seconds: number; label: string }>> = {
  registration: [{ seconds: 3600, label: '1 hour' }, { seconds: 86400, label: '24 hours' }, { seconds: 604800, label: '7 days' }],
  login: [{ seconds: 300, label: '5 minutes' }, { seconds: 600, label: '10 minutes' }, { seconds: 900, label: '15 minutes' }],
}
/** How long a code can last, as the server allows: a registration code up to 30 days, a sign-in code up to 15 minutes. */
const longest: Record<Kind, number> = { registration: 30 * 86400, login: 900 }
type Unit = 'minutes' | 'hours' | 'days'
const unitSeconds: Record<Unit, number> = { minutes: 60, hours: 3600, days: 86400 }
/** A length in the largest unit that divides it: 36 hours, not 1.5 days. */
function lengthParts(seconds: number): { amount: number; unit: Unit } {
  if (seconds % 86400 === 0) return { amount: seconds / 86400, unit: 'days' }
  if (seconds % 3600 === 0) return { amount: seconds / 3600, unit: 'hours' }
  return { amount: Math.round(seconds / 60), unit: 'minutes' }
}
const defaultLifetime: Record<Kind, number> = { registration: 86400, login: 600 }
const statusTone = { active: 'success', scheduled: 'info', used: 'accent', expired: 'neutral', revoked: 'neutral' } as const
const statusOrder: Record<CodeStatus, number> = { active: 0, scheduled: 1, used: 2, expired: 3, revoked: 4 }

/** A `datetime-local` value for a moment, in this browser's time zone. */
function localInput(time: number) {
  const date = new Date(time - new Date(time).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

/**
 * Access codes: the one-time six-digit codes an administrator hands out, to
 * register a new account or to let an existing person sign in once.
 *
 * The page puts making a code beside the codes already made. The list says,
 * for every code, what it is for, whether it still works and until when, who
 * made it and who used it; a code opens into its whole history. The code
 * itself is shown once, when it is made, and never again — the server keeps
 * only a digest.
 */
export function AccessCodesPage() {
  const { t, formatDate } = useI18n()
  const { user: currentUser } = useAuth()
  const { push } = useToast()
  const labels = useDataTableLabels()
  const preferences = useTablePreferences('admin-codes', { hidden: ['starts', 'expires'] })
  const invites = useAdminList('invites')
  const users = useAdminList('users')
  const refresh = useAdminRefresh()
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<Invitation | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [created, setCreated] = useState<{ code: string; invitation: Invitation } | null>(null)

  const numbers = useMemo(() => numberCodes(invites.items), [invites.items])
  const person = (id: string | null | undefined) => id ? users.items.find((user) => user.id === id)?.displayName ?? t('A user') : t('Container CLI')
  const status = (invitation: Invitation) => invitationStatus(invitation, clock)
  const expiringSoon = (invitation: Invitation) => status(invitation) === 'active' && Date.parse(invitation.expiresAt) - clock < DAY
  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: invites.items.length, active: 0, scheduled: 0, used: 0, expired: 0, revoked: 0, expiring: 0 }
    for (const invitation of invites.items) {
      const current = invitationStatus(invitation, clock)
      result[current] += 1
      if (current === 'active' && Date.parse(invitation.expiresAt) - clock < DAY) result.expiring += 1
    }
    return result
  }, [invites.items, clock])
  const redeemedLately = invites.items.filter((invitation) => invitation.usedAt && clock - Date.parse(invitation.usedAt) < 30 * DAY).length

  const search = query.trim().toLocaleLowerCase().replace(/^#/u, '')
  const rows = invites.items.filter((invitation) => {
    if (filter === 'expiring' ? !expiringSoon(invitation) : filter !== 'all' && status(invitation) !== filter) return false
    if (!search) return true
    const text = `${numbers.get(invitation.id) ?? ''} ${person(invitation.createdBy)} ${invitation.targetUserId ? person(invitation.targetUserId) : ''} ${invitation.usedBy ? person(invitation.usedBy) : ''}`
    return text.toLocaleLowerCase().includes(search)
  })

  const revoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      const authorization = await authorizePasskeyAction(invitationRevokeScope(revokeTarget.id))
      await api.admin.revokeInvitation(authorization.authorizationToken, revokeTarget.id)
      const revokedAt = new Date().toISOString()
      invites.update((items) => items.map((item) => item.id === revokeTarget.id ? { ...item, revokedAt } : item))
      setDetail((current) => current?.id === revokeTarget.id ? { ...current, revokedAt } : current)
      setRevokeTarget(null); refresh('audit'); push({ tone: 'success', title: t('Access code revoked') })
    } catch (caught) { push({ tone: 'error', title: t('Access code wasn’t revoked'), message: errorMessage(caught) }) }
    finally { setRevoking(false) }
  }

  const purpose = (invitation: Invitation) => invitation.kind === 'login'
    ? t('Sign-in for {name}', { name: person(invitation.targetUserId) })
    : t('New account')
  const validity = (invitation: Invitation) => {
    const current = status(invitation)
    if (current === 'active') return t('Ends in {time}', { time: durationWords(Date.parse(invitation.expiresAt) - clock, t) })
    if (current === 'scheduled') return t('Starts in {time}', { time: durationWords(Date.parse(invitationStart(invitation)) - clock, t) })
    if (current === 'used') return t('Redeemed')
    if (current === 'revoked') return t('Revoked {date}', { date: formatDate(invitation.revokedAt!, { dateStyle: 'medium' }) })
    return t('Ended')
  }
  const revocable = (invitation: Invitation) => status(invitation) === 'active' || status(invitation) === 'scheduled'

  const columns: DataTableColumn<Invitation>[] = [
    { id: 'code', header: t('Code'), hideable: false, firstSort: 'descending', sortValue: (item) => numbers.get(item.id), width: '110px', cell: (item) => <button type="button" className="code-ref" onClick={(event) => { event.stopPropagation(); setDetail(item) }} aria-label={t('Details of access code #{number}', { number: numbers.get(item.id) ?? '' })}><Icon name={item.kind === 'login' ? 'key' : 'user'} size={15} /><span>#{numbers.get(item.id)}</span></button> },
    { id: 'purpose', header: t('For'), sortValue: purpose, cell: (item) => <bdi className="admin-nowrap">{purpose(item)}</bdi> },
    { id: 'status', header: t('Status'), sortValue: (item) => statusOrder[status(item)], cell: (item) => <span className="code-status"><Badge tone={statusTone[status(item)]}>{t(status(item).charAt(0).toUpperCase() + status(item).slice(1))}</Badge><small>{validity(item)}</small></span> },
    { id: 'starts', header: t('Starts'), sortValue: invitationStart, cell: (item) => <time className="admin-cell-date" dateTime={invitationStart(item)}>{formatDate(invitationStart(item))}</time> },
    { id: 'expires', header: t('Valid until'), sortValue: (item) => item.expiresAt, cell: (item) => <time className="admin-cell-date" dateTime={item.expiresAt}>{formatDate(item.expiresAt)}</time> },
    { id: 'created', header: t('Created'), firstSort: 'descending', sortValue: (item) => item.createdAt, cell: (item) => <span className="admin-cell-stack"><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time><small><bdi>{person(item.createdBy)}</bdi></small></span> },
    { id: 'redeemed', header: t('Redeemed by'), sortValue: (item) => item.usedBy ? person(item.usedBy) : null, cell: (item) => item.usedAt ? <span className="admin-cell-stack"><bdi>{person(item.usedBy)}</bdi><small><time dateTime={item.usedAt}>{formatDate(item.usedAt)}</time></small></span> : <span className="admin-cell-none">—</span> },
    { id: 'actions', header: <span className="sr-only">{t('Actions')}</span>, label: t('Actions'), hideable: false, align: 'end', width: '96px', cell: (item) => revocable(item) ? <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); setRevokeTarget(item) }}>{t('Revoke')}</Button> : null },
  ]

  const stats: Array<{ filter: Filter; label: string; value: number; icon: IconName }> = [
    { filter: 'active', label: t('Working now'), value: counts.active, icon: 'key' },
    { filter: 'scheduled', label: t('Scheduled'), value: counts.scheduled, icon: 'calendar' },
    { filter: 'expiring', label: t('Ending within a day'), value: counts.expiring, icon: 'clock' },
    { filter: 'used', label: t('Redeemed in 30 days'), value: redeemedLately, icon: 'check' },
  ]
  const filters: Array<{ value: Filter; label: string }> = [
    { value: 'all', label: t('All') }, { value: 'active', label: t('Active') }, { value: 'scheduled', label: t('Scheduled') },
    { value: 'used', label: t('Used') }, { value: 'expired', label: t('Expired') }, { value: 'revoked', label: t('Revoked') },
  ]

  return <div className="admin-page access-codes">
    <h1 className="sr-only">{t('Access codes')}</h1>
    <div className="access-codes__main">
      <div className="admin-section-heading"><div><h2>{t('Access codes')} <span className="admin-section-count">{t(invites.items.length === 1 ? '{count} code' : '{count} codes', { count: invites.items.length })}</span></h2><p>{t('Six-digit codes that work once: to register a new account, or to let someone sign in without their passkey. A code is shown only when it is made.')}</p></div></div>
      <div className="code-stats" role="group" aria-label={t('At a glance')}>{stats.map((stat) => <button key={stat.filter} type="button" className="code-stat" data-active={filter === stat.filter || undefined} aria-pressed={filter === stat.filter} onClick={() => setFilter((current) => current === stat.filter ? 'all' : stat.filter)}>
        <Icon name={stat.icon} size={17} /><strong>{invites.status === 'ready' ? stat.value : '—'}</strong><span>{stat.label}</span>
      </button>)}</div>
      <LoadingState loading={invites.status === 'loading' || invites.status === 'idle'} label={t('Loading access codes')}>
        {invites.status === 'error' ? <Card><EmptyState icon="warning" title={t('Access codes couldn’t be loaded')} description={invites.error} action={<Button icon="refresh" onClick={() => void invites.reload()}>{t('Try again')}</Button>} /></Card>
          : <DataTable caption={t('Access codes')} columns={columns} rows={rows} rowKey={(item) => item.id} labels={labels} {...preferences}
            defaultSort={{ column: 'created', direction: 'descending' }} resetPageKey={`${filter}|${search}`} stackBelow={760}
            rowProps={(item) => ({ interactive: true, selected: detail?.id === item.id, onClick: () => setDetail(item) })}
            footerNote={!invites.complete ? t('Loading more…') : invites.truncated ? t('Showing the latest {count}', { count: ADMIN_LIST_LIMIT }) : undefined}
            empty={<><Icon name="key" size={22} /><p>{invites.items.length ? t('No codes in this view') : t('No access codes yet. Make the first one to invite someone.')}</p></>}
            toolbar={<>
              <div className="code-filters" role="group" aria-label={t('Show codes')}>{filters.map((option) => <button key={option.value} type="button" data-active={(filter === option.value || (option.value === 'active' && filter === 'expiring')) || undefined} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}<small>{invites.status === 'ready' ? counts[option.value] : ''}</small></button>)}</div>
              <div className="admin-search admin-search--narrow"><Input dir="auto" label={t('Search codes')} icon="search" placeholder={t('Number or person')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            </>} />}
      </LoadingState>
    </div>
    <NewCodePanel users={users.items} usersReady={users.status === 'ready'} onCreated={(code, invitation) => { invites.update((items) => [invitation, ...items]); refresh('audit'); setCreated({ code, invitation }) }} currentUserId={currentUser?.id ?? null} />

    <CodeDetails invitation={detail} number={detail ? numbers.get(detail.id) : undefined} status={detail ? status(detail) : 'active'} purpose={detail ? purpose(detail) : ''} person={person} now={clock} onClose={() => setDetail(null)} onRevoke={(item) => setRevokeTarget(item)} />
    <CreatedCodeDialog created={created} number={created ? numbers.get(created.invitation.id) : undefined} person={person} onClose={() => setCreated(null)} />
    <Dialog open={!!revokeTarget} onClose={() => !revoking && setRevokeTarget(null)} title={t('Revoke this access code?')} description={t('Verify your passkey to make it stop working at once. It cannot be turned back on; make a new code instead.')} footer={<><Button disabled={revoking} onClick={() => setRevokeTarget(null)}>{t('Cancel')}</Button><Button variant="danger" icon="key" loading={revoking} onClick={() => void revoke()}>{t('Verify and revoke')}</Button></>}>
      <div className="delete-summary"><Icon name="key" size={20} /><div><strong>{t('Access code #{number}', { number: revokeTarget ? numbers.get(revokeTarget.id) ?? '' : '' })}</strong><span>{revokeTarget && purpose(revokeTarget)} · {revokeTarget && t('Valid until {date}', { date: formatDate(revokeTarget.expiresAt) })}</span></div></div>
    </Dialog>
  </div>
}

/** Making a code: what it is for, when it starts, how long it lasts — and, before anything is sent, what exactly will be made. */
function NewCodePanel({ users, usersReady, currentUserId, onCreated }: { users: User[]; usersReady: boolean; currentUserId: string | null; onCreated: (code: string, invitation: Invitation) => void }) {
  const { t, formatDate } = useI18n()
  const { push } = useToast()
  // Opened from someone in the people list (`?for=`): a sign-in code for them.
  const [preset] = useState(() => new URLSearchParams(window.location.search).get('for') ?? '')
  const [kind, setKind] = useState<Kind>(preset ? 'login' : 'registration')
  const [target, setTarget] = useState(preset)
  const [startMode, setStartMode] = useState<'now' | 'later'>('now')
  const [startAt, setStartAt] = useState('')
  const [lifetime, setLifetime] = useState<Record<Kind, number>>(defaultLifetime)
  const [creating, setCreating] = useState(false)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])

  const seconds = lifetime[kind]
  const custom = !lifetimes[kind].some((option) => option.seconds === seconds)
  const [customOpen, setCustomOpen] = useState(false)
  const scheduled = startMode === 'later' ? Date.parse(startAt) : NaN
  const startError = startMode === 'later' && (!Number.isFinite(scheduled) ? t('Choose when the code starts.') : scheduled <= clock ? t('Choose a time in the future.') : scheduled > clock + 30 * DAY ? t('A code can start at most 30 days ahead.') : '')
  const start = startMode === 'later' && Number.isFinite(scheduled) ? scheduled : clock
  const end = start + seconds * 1000
  const eligible = users.filter((user) => user.status === 'active')
  const targetName = users.find((user) => user.id === target)?.displayName
  const ready = !startError && (kind === 'registration' || Boolean(target))

  const chooseKind = (next: Kind) => { setKind(next); if (next === 'registration') setTarget('') }
  const create = async () => {
    if (!ready || creating) return
    setCreating(true)
    try {
      const input: CreateCodeInput = { kind, ...(kind === 'login' ? { targetUserId: target } : {}), ...(startMode === 'later' ? { notBefore: new Date(scheduled).toISOString() } : {}), ttlSeconds: seconds }
      const authorization = await authorizePasskeyAction(await codeCreateScope(input))
      const result = await api.admin.createCode(authorization.authorizationToken, input)
      const invitation: Invitation = { id: result.id, kind: result.kind, targetUserId: result.targetUserId, notBefore: result.notBefore, expiresAt: result.expiresAt, createdAt: new Date().toISOString(), createdBy: currentUserId, usedAt: null, usedBy: null, revokedAt: null }
      onCreated(result.code, invitation)
      setStartMode('now'); setStartAt('')
      push({ tone: 'success', title: t('Code created'), message: t('Copy the code now; it will not be shown again.') })
    } catch (caught) { push({ tone: 'error', title: t('Code could not be created'), message: errorMessage(caught) }) }
    finally { setCreating(false) }
  }

  return <aside className="new-code" aria-labelledby="new-code-title">
    <Card className="new-code__card">
      <header><span className="new-code__mark"><Icon name="plus" size={18} /></span><div><h2 id="new-code-title">{t('New access code')}</h2><p>{t('Made after you verify your passkey.')}</p></div></header>
      <div className="new-code__section" role="radiogroup" aria-label={t('What the code is for')}>
        {(['registration', 'login'] as const).map((value) => <label key={value} className="new-code__kind" data-selected={kind === value || undefined}>
          <input type="radio" name="code-kind" value={value} checked={kind === value} disabled={creating} onChange={() => chooseKind(value)} />
          <Icon name={value === 'login' ? 'key' : 'user'} size={18} />
          <span><strong>{value === 'login' ? t('Sign in once') : t('Register an account')}</strong><small>{value === 'login' ? t('Lets an existing person in without their passkey, to add a new one.') : t('Anyone with the code can create one new account.')}</small></span>
        </label>)}
      </div>
      {kind === 'login' && <div className="new-code__section">
        <span className="new-code__label" id="code-account-label">{t('Account')}</span>
        <SearchSelect fullWidth aria-labelledby="code-account-label" placeholder={usersReady ? t('Choose a person') : t('Loading people…')} value={target} disabled={creating || !usersReady} onValueChange={setTarget}
          searchLabel={t('Search by name or username')} emptyLabel={t('No matching people')}
          options={eligible.map((user) => ({ value: user.id, icon: <UserAvatar user={user} size="sm" alt="" />, label: <bdi>{user.displayName}</bdi>, description: <>@<bdi>{user.username}</bdi></>, textValue: `${user.displayName} ${user.username}` }))} />
      </div>}
      <div className="new-code__section">
        <span className="new-code__label" id="code-start-label">{t('Starts')}</span>
        <SegmentedControl aria-labelledby="code-start-label" size="sm" fullWidth value={startMode} disabled={creating} onChange={(value) => { setStartMode(value as 'now' | 'later'); if (value === 'later' && !startAt) setStartAt(localInput(Date.now() + HOUR)) }} items={[{ value: 'now', label: t('Right away') }, { value: 'later', label: t('At a set time') }]} />
        {startMode === 'later' && <Input type="datetime-local" label={t('Start time')} min={localInput(clock)} max={localInput(clock + 30 * DAY)} value={startAt} disabled={creating} error={startError || undefined} hint={t('In your time zone.')} onChange={(event) => setStartAt(event.target.value)} />}
      </div>
      <div className="new-code__section">
        <span className="new-code__label" id="code-lifetime-label">{t('Lasts')}</span>
        <div className="new-code__lifetimes">
          <div role="radiogroup" aria-labelledby="code-lifetime-label">{lifetimes[kind].map((option) => <label key={option.seconds} data-selected={seconds === option.seconds || undefined}>
            <input type="radio" name="code-lifetime" value={option.seconds} checked={seconds === option.seconds} disabled={creating} onChange={() => setLifetime((current) => ({ ...current, [kind]: option.seconds }))} />{t(option.label)}
          </label>)}</div>
          <button type="button" className="new-code__custom" data-selected={custom || undefined} disabled={creating} onClick={() => setCustomOpen(true)}>
            <Icon name="edit" size={13} />{custom ? t(`{count} ${lengthParts(seconds).unit}`, { count: lengthParts(seconds).amount }) : t('Custom…')}
          </button>
        </div>
      </div>
      <div className="new-code__summary" aria-live="polite">
        <Icon name="info" size={16} />
        <p>{kind === 'login' && !targetName ? t('Choose who the code is for.') : t(
          kind === 'login' ? startMode === 'now' ? '{name} can sign in once with it until {end}.' : '{name} can sign in once with it from {start} until {end}.'
            : startMode === 'now' ? 'One new account can be registered with it until {end}.' : 'One new account can be registered with it from {start} until {end}.',
          { name: targetName ?? '', start: formatDate(new Date(start).toISOString()), end: formatDate(new Date(end).toISOString()) })}</p>
      </div>
      <Button className="new-code__submit" variant="primary" icon="key" loading={creating} disabled={!ready} onClick={() => void create()}>{t('Verify and generate')}</Button>
    </Card>
    <LifetimeDialog open={customOpen} kind={kind} seconds={seconds} start={start} onClose={() => setCustomOpen(false)} onChoose={(chosen) => { setLifetime((current) => ({ ...current, [kind]: chosen })); setCustomOpen(false) }} />
  </aside>
}

/** Any other length a code may last, within what the server allows for its kind. */
function LifetimeDialog({ open, kind, seconds, start, onClose, onChoose }: { open: boolean; kind: Kind; seconds: number; start: number; onClose: () => void; onChoose: (seconds: number) => void }) {
  const { t, formatDate } = useI18n()
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<Unit>('hours')
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { const parts = lengthParts(seconds); setAmount(String(parts.amount)); setUnit(kind === 'login' ? 'minutes' : parts.unit) }
  }
  const units: Unit[] = kind === 'login' ? ['minutes'] : ['minutes', 'hours', 'days']
  const value = Number(amount)
  const chosen = Number.isInteger(value) ? value * unitSeconds[unit] : NaN
  const error = !amount.trim() || !Number.isInteger(value) || value < 1 ? t('Enter a whole number.')
    : chosen < 60 ? t('At least 1 minute.')
    : chosen > longest[kind] ? (kind === 'login' ? t('At most 15 minutes.') : t('At most 30 days.'))
    : ''
  return <Dialog size="sm" open={open} onClose={onClose} title={t('How long it lasts')} description={kind === 'login' ? t('A sign-in code lasts from 1 to 15 minutes.') : t('A registration code lasts from 1 minute to 30 days.')} footer={<><Button onClick={onClose}>{t('Cancel')}</Button><Button type="submit" form="code-lifetime" variant="primary" disabled={Boolean(error)}>{t('Use this length')}</Button></>}>
    <form id="code-lifetime" className="lifetime-form" onSubmit={(event) => { event.preventDefault(); if (!error) onChoose(chosen) }}>
      <div className="lifetime-form__row">
        <Input autoFocus type="number" inputMode="numeric" min={1} step={1} label={t('Length')} value={amount} error={amount && error ? error : undefined} onChange={(event) => setAmount(event.target.value)} />
        {units.length > 1 ? <SegmentedControl aria-label={t('Unit')} value={unit} onChange={(next) => setUnit(next as Unit)} items={units.map((item) => ({ value: item, label: t(item === 'minutes' ? 'Minutes' : item === 'hours' ? 'Hours' : 'Days') }))} /> : <span className="lifetime-form__unit">{t('Minutes')}</span>}
      </div>
      {!error && <p className="lifetime-form__preview"><Icon name="clock" size={15} />{t('Works until {date}.', { date: formatDate(new Date(start + chosen * 1000).toISOString()) })}</p>}
    </form>
  </Dialog>
}

/** Everything known about one code, in the order it happened. */
function CodeDetails({ invitation, number, status, purpose, person, now, onClose, onRevoke }: { invitation: Invitation | null; number: number | undefined; status: CodeStatus; purpose: string; person: (id: string | null | undefined) => string; now: number; onClose: () => void; onRevoke: (invitation: Invitation) => void }) {
  const { t } = useI18n()
  const [shown, setShown] = useState(invitation)
  if (invitation && invitation !== shown) setShown(invitation)
  const item = invitation ?? shown
  return <Drawer open={Boolean(invitation)} onOpenChange={(open) => { if (!open) onClose() }} side="right" size="sm" closeLabel={t('Close')}>
    <DrawerHeader><DrawerTitle>{t('Access code #{number}', { number: number ?? '' })}</DrawerTitle></DrawerHeader>
    <DrawerBody>{item && <CodeHistory item={item} status={status} purpose={purpose} person={person} now={now} />}</DrawerBody>
    {item && (status === 'active' || status === 'scheduled') && <DrawerFooter><Button variant="danger" icon="close" onClick={() => onRevoke(item)}>{t('Revoke code')}</Button></DrawerFooter>}
  </Drawer>
}

/** The code's life so far, and what the server recorded about it; activity is read only once a code is opened. */
function CodeHistory({ item, status, purpose, person, now }: { item: Invitation; status: CodeStatus; purpose: string; person: (id: string | null | undefined) => string; now: number }) {
  const { t, formatDate } = useI18n()
  const audit = useAdminList('audit')
  const related = audit.items.filter((event) => event.targetId === item.id)
  const steps: Array<{ icon: IconName; label: string; at: string; by?: string; tone?: 'done' | 'future' | 'stop' }> = [
    { icon: 'plus', label: t('Made'), at: item.createdAt, by: person(item.createdBy), tone: 'done' },
    { icon: 'play', label: Date.parse(invitationStart(item)) > now ? t('Starts working') : t('Started working'), at: invitationStart(item), tone: Date.parse(invitationStart(item)) > now ? 'future' : 'done' },
    ...(item.usedAt ? [{ icon: 'check' as const, label: t('Redeemed'), at: item.usedAt, by: person(item.usedBy), tone: 'done' as const }] : []),
    ...(item.revokedAt ? [{ icon: 'close' as const, label: t('Revoked'), at: item.revokedAt, tone: 'stop' as const }] : []),
    ...(!item.usedAt && !item.revokedAt ? [{ icon: 'clock' as const, label: Date.parse(item.expiresAt) > now ? t('Stops working') : t('Stopped working'), at: item.expiresAt, tone: Date.parse(item.expiresAt) > now ? 'future' as const : 'stop' as const }] : []),
  ]
  return <div className="code-details">
      <div className="code-details__summary"><Badge tone={statusTone[status]}>{t(status.charAt(0).toUpperCase() + status.slice(1))}</Badge><strong><bdi>{purpose}</bdi></strong></div>
      <ol className="code-timeline">{steps.map((step, index) => <li key={index} data-tone={step.tone}>
        <span className="code-timeline__icon" aria-hidden="true"><Icon name={step.icon} size={14} /></span>
        <div><strong>{step.label}</strong><time dateTime={step.at}>{formatDate(step.at)}</time>{step.by && <small>{t('By {name}', { name: step.by })}</small>}</div>
      </li>)}</ol>
      <section className="code-details__activity"><h3>{t('Recorded activity')}</h3>{audit.status !== 'ready' ? <p>{t('Loading activity')}</p> : related.length === 0 ? <p>{t('Nothing recorded for this code.')}</p> : <ul>{related.map((event) => <li key={event.id}><strong>{actionTitle(event.action, t)}</strong><span><bdi>{person(event.actorUserId)}</bdi> · <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time></span>{auditDetail(event, t, formatDate) && <small>{auditDetail(event, t, formatDate)}</small>}</li>)}</ul>}</section>
      <p className="code-details__note"><Icon name="shield" size={15} />{t('The code itself is not stored and cannot be shown again.')}</p>
    </div>
}
