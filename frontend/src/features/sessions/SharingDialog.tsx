import { useI18n } from '../../app/i18n'
import { useEffect, useState } from 'react'
import { AvatarGroup, Menu, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { Person, SessionShare } from '../../api/contracts'
import { useOptionalAuth } from '../../app/auth'
import { UserAvatar } from '../../app/UserAvatar'
import { Button, Dialog, Icon, Input, Select, SelectOption, useToast, type IconName } from '../../design-system'
import { errorMessage } from '../../app/utils'
import './sharing.css'

/** Who a new share is for: a link anyone can open, a link for signed-in people, or people by name. */
type Audience = 'anyone' | 'members' | 'people'

const AUDIENCES: Array<{ value: Audience; icon: IconName; title: string; detail: string }> = [
  { value: 'anyone', icon: 'link', title: 'Anyone with the link', detail: 'No account needed. They open it as a guest.' },
  { value: 'members', icon: 'users', title: 'Signed-in people with the link', detail: 'Only people with an account here. It stays in their Shared with you.' },
  { value: 'people', icon: 'user', title: 'Specific people', detail: 'Only people who have chosen to be found by name.' },
]

const ENDS = [['1', 'In 1 hour'], ['24', 'In 24 hours'], ['168', 'In 7 days'], ['never', 'No end date']] as const
const expiryFor = (value: string) => value === 'never' ? null : new Date(Date.now() + Number(value) * 3600000).toISOString()
const linkFor = (share: SessionShare) => `${window.location.origin}/share#${share.token}`

/**
 * Sharing one session: who may see it, and how long for.
 *
 * Always mounted, so it opens and closes with the dialog's own motion; what
 * it shows is read again each time it opens.
 */
export function SharingDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const { t, formatDate } = useI18n()
  const user = useOptionalAuth()?.user
  const { push } = useToast()
  const [clock, setClock] = useState(Date.now)
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setClock(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [open])
  const [shares, setShares] = useState<SessionShare[] | null>(null)
  const [audience, setAudience] = useState<Audience>('anyone')
  const [permission, setPermission] = useState<'view' | 'record'>('view')
  const [length, setLength] = useState('24')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ query: string; people: Person[] } | null>(null)
  const [recipient, setRecipient] = useState<Person | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [showEnded, setShowEnded] = useState(false)
  const [manual, setManual] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    api.sharing.list(sessionId).then((value) => { if (current) { setShares(value); setError('') } }).catch((caught) => { if (current) { setShares((known) => known ?? []); setError(errorMessage(caught)) } })
    return () => { current = false }
  }, [open, sessionId])
  const needle = query.trim()
  useEffect(() => {
    if (!open || audience !== 'people' || !needle) return
    let current = true
    const timer = window.setTimeout(() => {
      api.sharing.recipients(needle).then((people) => { if (current) setResults({ query: needle, people }) }).catch(() => { if (current) setResults({ query: needle, people: [] }) })
    }, 250)
    return () => { current = false; window.clearTimeout(timer) }
  }, [audience, needle, open])

  const ended = (share: SessionShare) => Boolean(share.revokedAt) || Boolean(share.expiresAt && new Date(share.expiresAt).getTime() <= clock)
  const active = (shares ?? []).filter((share) => !ended(share))
  const inactive = (shares ?? []).filter(ended)
  const withAccess = new Set(active.filter((share) => share.type === 'user').map((share) => share.userId))
  const found = results?.query === needle ? results.people.filter((person) => !withAccess.has(person.id)) : null
  const ready = audience !== 'people' || Boolean(recipient)

  const create = async () => {
    setBusy('create'); setError('')
    try {
      const value = await api.sharing.create(sessionId, audience === 'people'
        ? { type: 'user', userId: recipient!.id, permission, expiresAt: expiryFor(length) }
        : { type: 'link', audience, permission, expiresAt: expiryFor(length) })
      setShares((current) => [value, ...(current ?? [])])
      if (audience === 'people') { setRecipient(null); setQuery('') }
      push({ tone: 'success', title: audience === 'people' ? t('Access given') : t('Link created'), message: audience === 'people' ? undefined : t('Copy it from the list below.') })
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }
  const update = async (share: SessionShare, next: { permission?: 'view' | 'record'; expiresAt?: string | null }) => {
    setBusy(share.id); setError('')
    try {
      const value = await api.sharing.update(sessionId, share.id, { permission: next.permission ?? share.permission, expiresAt: next.expiresAt === undefined ? share.expiresAt : next.expiresAt })
      setShares((current) => (current ?? []).map((item) => item.id === value.id ? value : item))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }
  const revoke = async (share: SessionShare) => {
    setBusy(share.id); setError('')
    try {
      await api.sharing.revoke(sessionId, share.id)
      setShares((current) => (current ?? []).map((item) => item.id === share.id ? { ...item, revokedAt: new Date().toISOString(), token: undefined } : item))
      push({ tone: 'success', title: share.type === 'link' ? t('Link turned off') : t('Access removed') })
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }
  const copy = async (share: SessionShare) => {
    const link = linkFor(share)
    try { await navigator.clipboard.writeText(link); setManual(null); push({ tone: 'success', title: t('Link copied') }) }
    // Without clipboard access, the link is shown to be copied by hand.
    catch { setManual(share.id) }
  }

  const title = (share: SessionShare) => share.type === 'user' ? share.displayName || t('Workspace user') : share.audience === 'members' ? t('Signed-in people with the link') : t('Anyone with the link')
  const until = (share: SessionShare) => share.revokedAt ? t('Turned off') : share.expiresAt && new Date(share.expiresAt).getTime() <= clock ? t('Ended') : share.expiresAt ? t('Until {date}', { date: formatDate(share.expiresAt) }) : t('No end date')
  const row = (share: SessionShare) => {
    const off = ended(share)
    const members = share.members ?? []
    return <li key={share.id} className="share-access__row" data-inactive={off || undefined}>
      {share.type === 'user' && share.userId
        ? <UserAvatar user={{ id: share.userId, displayName: share.displayName || '', avatarVersion: share.avatarVersion }} sessionId={sessionId} size="md" alt="" />
        : <span className="share-access__icon" aria-hidden="true"><Icon name={share.audience === 'members' ? 'users' : 'link'} size={16} /></span>}
      <div className="share-access__text">
        <strong dir="auto">{title(share)}</strong>
        <span>{share.permission === 'record' ? t('Can record') : t('Read only')} · {until(share)}</span>
        {share.type === 'link' && share.audience === 'members' && !off && <span className="share-access__members">
          {members.length > 0 && <AvatarGroup size="sm" max={5} total={members.length}>{members.map((person) => <UserAvatar key={person.id} user={person} sessionId={sessionId} />)}</AvatarGroup>}
          {members.length === 0 ? t('Nobody has joined yet') : t(members.length === 1 ? '{count} person joined' : '{count} people joined', { count: members.length })}
        </span>}
        {manual === share.id && share.token && <Input label={t('Copy this link')} readOnly value={linkFor(share)} onFocus={(event) => event.currentTarget.select()} autoFocus />}
      </div>
      {!off && <div className="share-access__actions">
        {share.token && <Button size="sm" variant="ghost" icon="copy" onClick={() => void copy(share)}>{t('Copy link')}</Button>}
        <Menu placement="bottom-end" aria-label={t('Change sharing')} trigger={<Button size="sm" variant="ghost" icon="more" iconOnly aria-label={t('Change sharing for {name}', { name: title(share) })} disabled={Boolean(busy)} />}>
          <MenuGroup label={t('Access')}><MenuRadioGroup value={share.permission} onValueChange={(value) => void update(share, { permission: value as 'view' | 'record' })}><MenuRadioItem value="view">{t('Read only')}</MenuRadioItem><MenuRadioItem value="record">{t('Can record')}</MenuRadioItem></MenuRadioGroup></MenuGroup>
          <MenuGroup label={t('Ends')}>{ENDS.map(([value, label]) => <MenuItem key={value} onSelect={() => void update(share, { expiresAt: expiryFor(value) })}>{t(label)}</MenuItem>)}</MenuGroup>
          <MenuSeparator />
          <MenuItem destructive icon={<Icon name="close" size={16} />} onSelect={() => void revoke(share)}>{share.type === 'link' ? t('Turn off link') : t('Remove access')}</MenuItem>
        </Menu>
      </div>}
    </li>
  }

  return <Dialog open={open} onClose={onClose} size="md" title={t('Share session')} description={t('Only one person records at a time; you can stop or take over their recording.')} footer={<Button onClick={onClose}>{t('Done')}</Button>}>
    <section className="share-new" aria-labelledby="share-new-title">
      <h3 id="share-new-title">{t('Give access')}</h3>
      <div className="share-new__audiences" role="radiogroup" aria-label={t('Who it is for')}>
        {AUDIENCES.map((option) => <label key={option.value} className="share-new__audience" data-selected={audience === option.value || undefined}>
          <input type="radio" name="share-audience" value={option.value} checked={audience === option.value} disabled={busy === 'create'} onChange={() => setAudience(option.value)} />
          <Icon name={option.icon} size={18} />
          <span><strong>{t(option.title)}</strong><small>{t(option.detail)}</small></span>
        </label>)}
      </div>
      {audience === 'people' && <div className="share-new__people">
        <Input label={t('Find a person')} icon="search" placeholder={t('Name or username')} value={query} hint={t('People appear here once they turn on “Let others find me” in their settings.')} onChange={(event) => { setQuery(event.target.value); setRecipient(null) }} />
        {needle && <div className="share-new__results" role="group" aria-label={t('Matching people')} aria-busy={found === null || undefined}>
          {found === null ? <p className="share-new__note">{t('Searching…')}</p> : found.length === 0 ? <p className="share-new__note">{t('Nobody by that name can be found.')}</p> : found.map((person) => <button type="button" key={person.id} aria-pressed={recipient?.id === person.id} onClick={() => setRecipient(person)}>
            <UserAvatar user={person} size="sm" alt="" />
            <span className="share-new__person"><strong dir="auto">{person.displayName}</strong><small>@{person.username}</small></span>
            {recipient?.id === person.id && <Icon name="check" size={16} />}
          </button>)}
        </div>}
      </div>}
      <div className="share-new__fields">
        <Select fullWidth label={t('Access')} value={permission} onValueChange={(value) => setPermission(value as typeof permission)}><SelectOption value="view">{t('Read only')}</SelectOption><SelectOption value="record">{t('Can record')}</SelectOption></Select>
        <Select fullWidth label={t('Ends')} value={length} onValueChange={setLength}>{ENDS.map(([value, label]) => <SelectOption key={value} value={value}>{t(label)}</SelectOption>)}</Select>
      </div>
      <Button className="share-new__submit" variant="primary" icon={audience === 'people' ? 'user' : 'link'} loading={busy === 'create'} disabled={Boolean(busy) || !ready} onClick={() => void create()}>{audience === 'people' ? t('Give access') : t('Create link')}</Button>
    </section>
    {error && <p className="share-error" role="alert">{t(error)}</p>}
    <section className="share-access" aria-labelledby="share-access-title">
      <h3 id="share-access-title">{t('Who has access')}</h3>
      {shares === null ? <p className="share-new__note" role="status">{t('Loading shares…')}</p> : <ul className="share-access__list">
        {user && <li className="share-access__row">
          <UserAvatar user={user} size="md" alt="" />
          <div className="share-access__text"><strong dir="auto">{user.displayName}</strong><span>{t('You own this session')}</span></div>
        </li>}
        {active.map(row)}
        {showEnded && inactive.map(row)}
      </ul>}
      {shares !== null && active.length === 0 && <p className="share-new__note">{t('Nobody else has access yet.')}</p>}
      {inactive.length > 0 && <button type="button" className="share-access__ended" aria-expanded={showEnded} onClick={() => setShowEnded((value) => !value)}>
        <Icon name={showEnded ? 'chevronUp' : 'chevronDown'} size={14} />{t(showEnded ? 'Hide ended ({count})' : 'Show ended ({count})', { count: inactive.length })}
      </button>}
    </section>
  </Dialog>
}
