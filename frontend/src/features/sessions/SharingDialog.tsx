import { useI18n } from '../../app/i18n'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { SessionShare, User } from '../../api/contracts'
import { Button, Dialog, EmptyState, Input, Select, useToast } from '../../design-system'
import { errorMessage } from '../../app/utils'
import './sharing.css'

const expiryFor = (value: string) => value === 'never' ? null : new Date(Date.now() + Number(value) * 3600000).toISOString()

export function SharingDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const {t,formatDate}=useI18n()

  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer=window.setInterval(() => setClock(Date.now()),30000); return () => window.clearInterval(timer) }, [])
  const [shares, setShares] = useState<SessionShare[]>([])
  const [kind, setKind] = useState<'link' | 'user'>('link')
  const [permission, setPermission] = useState<'view' | 'record'>('view')
  const [expiry, setExpiry] = useState('24')
  const [query, setQuery] = useState('')
  const [recipients, setRecipients] = useState<Array<Pick<User, 'id' | 'username' | 'displayName'>>>([])
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const { push } = useToast()
  useEffect(() => { if (!open) return; let current = true; api.sharing.list(sessionId).then(value => { if (current) { setShares(value); setError('') } }).catch(caught => { if (current) setError(errorMessage(caught)) }).finally(() => { if (current) setLoading(false) }); return () => { current = false } }, [open, sessionId])
  useEffect(() => { if (!open || kind !== 'user' || !query.trim()) return; let current = true; const timer = window.setTimeout(() => { void api.sharing.recipients(query.trim()).then(value => { if (current) setRecipients(value) }).catch(() => { if (current) setRecipients([]) }) }, 250); return () => { current = false; window.clearTimeout(timer) } }, [kind, open, query])
  const create = async () => {
    setBusy('create'); setError('')
    try { const value = await api.sharing.create(sessionId, { type: kind, ...(kind === 'user' ? { userId: recipient } : {}), permission, expiresAt: expiryFor(expiry) }); setShares(current => [value, ...current]); push({ tone: 'success', title: kind === 'link' ? t("Share link created") : t("Access granted") }) }
    catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }
  const update = async (share: SessionShare, next: { permission?: 'view' | 'record'; expiresAt?: string | null }) => {
    setBusy(share.id); setError('')
    try { const value = await api.sharing.update(sessionId, share.id, { permission: next.permission ?? share.permission, expiresAt: next.expiresAt === undefined ? share.expiresAt : next.expiresAt }); setShares(current => current.map(item => item.id === value.id ? value : item)) }
    catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }
  const revoke = async (share: SessionShare) => {
    setBusy(share.id); setError('')
    try { await api.sharing.revoke(sessionId, share.id); setShares(current => current.map(item => item.id === share.id ? { ...item, revokedAt: new Date().toISOString() } : item)); push({ tone: 'success', title: t("Access revoked") }) }
    catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }
  const copy = async (share: SessionShare) => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/share#${share.token}`); push({ tone: 'success', title: t("Link copied") }) }
    catch { setError('Your browser could not copy the link. Allow clipboard access and try again.') }
  }
  return <Dialog open={open} onClose={onClose} title={t("Share session")} description={t("Invite viewers to the conversation. Only one person can record at a time; you can stop or take over their recording.")} footer={<Button onClick={onClose}>{t("Done")}</Button>}>
    <div className="share-create">
      <Select label={t("Share with")} value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="link">{t("Anyone with a link")}</option><option value="user">{t("A workspace user")}</option></Select>
      {kind === 'user' && <div className="share-recipient"><Input label={t("Find a user")} placeholder={t("Name or username")} value={query} onChange={event => { setQuery(event.target.value); setRecipient('') }} /><div className="share-results" role="group" aria-label={t("Matching users")}>{query.trim() && recipients.map(user => <button type="button" key={user.id} aria-pressed={recipient === user.id} onClick={() => setRecipient(user.id)}><strong>{user.displayName}</strong><span>@{user.username}</span></button>)}</div></div>}
      <div className="share-fields"><Select label={t("Permission")} value={permission} onChange={event => setPermission(event.target.value as typeof permission)}><option value="view">{t("Read only")}</option><option value="record">{t("Can record")}</option></Select><Select label={t("Expires")} value={expiry} onChange={event => setExpiry(event.target.value)}><option value="1">{t("In 1 hour")}</option><option value="24">{t("In 24 hours")}</option><option value="168">{t("In 7 days")}</option><option value="never">{t("Never")}</option></Select></div>
      <Button variant="primary" loading={busy === 'create'} disabled={Boolean(busy) || kind === 'user' && !recipient} onClick={() => void create()}>{kind === 'link' ? t("Create share link") : t("Grant access")}</Button>
    </div>
    {error && <p className="share-error" role="alert">{t(error)}</p>}
    <div className="share-list" aria-label={t("Existing shares")}>{loading ? <p role="status">{t("Loading shares…")}</p> : shares.length === 0 ? <EmptyState icon="users" title={t("Only you have access")} description={t("Add a person or create a link above.")} /> : shares.map(share => {
      const revoked = Boolean(share.revokedAt); const expired = Boolean(share.expiresAt && new Date(share.expiresAt).getTime() <= clock)
      return <article className="share-row" key={share.id} data-inactive={revoked || expired || undefined}>
        <div className="share-row__heading"><strong>{share.type === 'link' ? t("Anyone with this link") : share.displayName || t('Workspace user')}</strong><span>{revoked ? t("Revoked") : expired ? t("Expired") : share.expiresAt ? t('Until {date}',{date:formatDate(share.expiresAt)}) : t("Permanent access")}</span></div>
        {!revoked && <div className="share-row__controls"><Select label={t("Access permission")} value={share.permission} disabled={Boolean(busy)} onChange={event => void update(share, { permission: event.target.value as 'view' | 'record' })}><option value="view">{t("Read only")}</option><option value="record">{t("Can record")}</option></Select><Select label={t("Change expiration")} value="current" disabled={Boolean(busy)} onChange={event => void update(share, { expiresAt: expiryFor(event.target.value) })}><option value="current">{t("Keep expiration")}</option><option value="1">{t("1 hour from now")}</option><option value="24">{t("24 hours from now")}</option><option value="168">{t("7 days from now")}</option><option value="never">{t("Never expires")}</option></Select>{share.token && <Button size="sm" icon="copy" disabled={expired} onClick={() => void copy(share)}>{t("Copy link")}</Button>}<Button size="sm" variant="danger" loading={busy === share.id} disabled={Boolean(busy)} onClick={() => void revoke(share)}>{t("Revoke")}</Button></div>}
      </article>
    })}</div>
  </Dialog>
}
