import { useEffect, useState } from 'react'
import { InlineMessage, SegmentedControl } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { AdminUserSecurity, BrowserSession, CreateCodeInput, Invitation, Passkey, User } from '../../api/contracts'
import { codeCreateScope } from '../../app/accessCodes'
import { adminRemovalScope } from '../../app/adminChanges'
import { describeDevice } from '../../app/deviceName'
import { useI18n } from '../../app/i18n'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { Link } from '../../app/router'
import { errorMessage } from '../../app/utils'
import { Button, Dialog, EmptyState, Icon, LoadingState, buttonClassName, useToast } from '../../design-system'
import { useAdminRefresh } from './AdminData'
import { CreatedCodeDialog } from './CreatedCodeDialog'

const CODE_LENGTHS = [300, 600, 900] as const

type Removal = { kind: 'passkey'; item: Passkey } | { kind: 'session'; item: BrowserSession }

/**
 * How one person signs in, for an administrator: a one-time sign-in code to
 * let them in without a passkey, their passkeys, and the browsers signed in
 * with the account. Passkeys and browsers can only be taken away here —
 * adding one is the person's own to do.
 */
export function AdminUserSignIn({ user, self, onCodeMade }: { user: User; self: boolean; onCodeMade?: () => void }) {
  const { t, formatDate } = useI18n()
  const { push } = useToast()
  const refresh = useAdminRefresh()
  const [security, setSecurity] = useState<{ status: 'loading' | 'ready' | 'error'; value?: AdminUserSecurity; error?: string }>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [length, setLength] = useState<number>(600)
  const [making, setMaking] = useState(false)
  const [created, setCreated] = useState<{ code: string; invitation: Invitation } | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    let active = true
    api.admin.userSecurity(user.id)
      .then((value) => { if (active) setSecurity({ status: 'ready', value }) })
      .catch((caught) => { if (active) setSecurity({ status: 'error', error: errorMessage(caught) }) })
    return () => { active = false }
  }, [user.id, attempt])

  const device = (session: BrowserSession) => {
    const described = describeDevice(session.userAgent)
    return 'raw' in described ? described.raw || t('Unknown browser') : t('{browser} on {system}', described)
  }
  const canMakeCode = user.status === 'active'

  const makeCode = async () => {
    if (!canMakeCode || making) return
    setMaking(true)
    try {
      const input: CreateCodeInput = { kind: 'login', targetUserId: user.id, ttlSeconds: length }
      const authorization = await authorizePasskeyAction(await codeCreateScope(input))
      const result = await api.admin.createCode(authorization.authorizationToken, input)
      setCreated({ code: result.code, invitation: { id: result.id, kind: result.kind, targetUserId: result.targetUserId, notBefore: result.notBefore, expiresAt: result.expiresAt,
        createdAt: new Date().toISOString(), createdBy: null, usedAt: null, usedBy: null, revokedAt: null } })
      refresh('invites'); refresh('audit'); onCodeMade?.()
    } catch (caught) { push({ tone: 'error', title: t('Code could not be created'), message: errorMessage(caught) }) }
    finally { setMaking(false) }
  }

  const remove = async () => {
    if (!removal || removing) return
    setRemoving(true)
    try {
      const authorization = await authorizePasskeyAction(await adminRemovalScope(removal.kind, user.id, removal.item.id))
      if (removal.kind === 'passkey') await api.admin.deleteUserPasskey(authorization.authorizationToken, user.id, removal.item.id)
      else await api.admin.revokeUserSession(authorization.authorizationToken, user.id, removal.item.id)
      push({ tone: 'success', title: removal.kind === 'passkey' ? t('Passkey removed') : t('Browser signed out') })
      setRemoval(null); refresh('audit')
      setAttempt((count) => count + 1)
    } catch (caught) { push({ tone: 'error', title: removal.kind === 'passkey' ? t('Passkey wasn’t removed') : t('Browser wasn’t signed out'), message: errorMessage(caught) }) }
    finally { setRemoving(false) }
  }

  const value = security.value
  const passkeys = value?.passkeys ?? []
  const lastPasskey = removal?.kind === 'passkey' && passkeys.filter((key) => !key.compromisedAt).length <= 1
  return <div className="admin-drawer__section">
    {self ? <InlineMessage variant="info">{t('Your own passkeys and browsers are managed in your settings, with your own passkey.')} <Link href="/settings">{t('Open settings')}</Link></InlineMessage> : null}

    <h3>{t('Sign-in code')}</h3>
    <div className="admin-drawer__rows">
      <div className="admin-drawer__row admin-drawer__row--stack">
        {self ? <div><strong>{t('Sign yourself in once without a passkey')}</strong><p>{t('For another device: sign in there with the code, then add a passkey on it.')}</p></div>
          : <div><strong>{t('Let them in once without a passkey')}</strong><p>{t('For someone who lost their device: they sign in with the code, then add a new passkey.')}</p></div>}
        {canMakeCode ? <div className="signin-code">
          <SegmentedControl size="sm" aria-label={t('How long the code lasts')} value={String(length)} onChange={(next) => setLength(Number(next))}
            items={CODE_LENGTHS.map((seconds) => ({ value: String(seconds), label: t('{count} min', { count: seconds / 60 }) }))} />
          <Button variant="primary" icon="key" loading={making} onClick={() => void makeCode()}>{t('Verify and make code')}</Button>
          <Link className={buttonClassName({ variant: 'ghost', size: 'sm' })} href={`/admin/codes?for=${encodeURIComponent(user.id)}`}>{t('More options')}</Link>
        </div> : <p className="admin-drawer__note"><Icon name="info" size={15} />{t('Enable the account first: a disabled account can’t sign in.')}</p>}
      </div>
    </div>

    {security.status === 'error' ? <EmptyState icon="warning" title={t('Sign-in details couldn’t be loaded')} description={security.error ?? ''} action={<Button icon="refresh" onClick={() => { setSecurity({ status: 'loading' }); setAttempt((count) => count + 1) }}>{t('Try again')}</Button>} />
      : !value ? <LoadingState label={t('Loading sign-in details')} />
      : <>
        <h3>{t('Passkeys')} <span className="admin-drawer__count">{passkeys.length}</span></h3>
        {passkeys.length ? <ul className="admin-drawer__rows signin-list" aria-label={t('Passkeys')}>
          {passkeys.map((passkey) => <li key={passkey.id} className="admin-drawer__row">
            <span className="signin-list__icon"><Icon name="key" size={16} /></span>
            <div><strong><bdi>{passkey.name}</bdi>{passkey.compromisedAt ? <small className="signin-list__flag">{t('Flagged as cloned')}</small> : null}</strong>
              <p>{t('Added {date}', { date: formatDate(passkey.createdAt, { dateStyle: 'medium' }) })} · {passkey.lastUsedAt ? t('Last used {date}', { date: formatDate(passkey.lastUsedAt) }) : t('Never used')}</p></div>
            {!self ? <Button size="sm" variant="ghost" icon="trash" aria-label={t('Remove passkey {name}', { name: passkey.name })} onClick={() => setRemoval({ kind: 'passkey', item: passkey })}>{t('Remove')}</Button> : null}
          </li>)}
        </ul> : <p className="admin-drawer__note"><Icon name="info" size={15} />{t('No passkeys. They can sign in only with a sign-in code.')}</p>}

        <h3>{t('Signed-in browsers')} <span className="admin-drawer__count">{value.sessions.length}</span></h3>
        {value.sessions.length ? <ul className="admin-drawer__rows signin-list" aria-label={t('Signed-in browsers')}>
          {value.sessions.map((session) => <li key={session.id} className="admin-drawer__row">
            <span className="signin-list__icon"><Icon name="globe" size={16} /></span>
            <div><strong><bdi>{device(session)}</bdi>{session.current ? <small className="signin-list__flag signin-list__flag--here">{t('This browser')}</small> : null}</strong>
              <p>{t('Last active {date}', { date: formatDate(session.lastSeen) })} · {t('Signed in {date}', { date: formatDate(session.createdAt, { dateStyle: 'medium' }) })}{session.ipAddress ? <> · <bdi>{session.ipAddress}</bdi></> : null}</p></div>
            {!self ? <Button size="sm" variant="ghost" icon="logout" aria-label={t('Sign out {browser}', { browser: device(session) })} onClick={() => setRemoval({ kind: 'session', item: session })}>{t('Sign out')}</Button> : null}
          </li>)}
        </ul> : <p className="admin-drawer__note"><Icon name="info" size={15} />{t('Not signed in anywhere.')}</p>}
      </>}

    <Dialog open={!!removal} onClose={() => !removing && setRemoval(null)}
      title={removal?.kind === 'passkey' ? t('Remove this passkey?') : t('Sign this browser out?')}
      description={removal?.kind === 'passkey'
        ? t('It will no longer sign in to {name}’s account, and every browser signed in to the account is signed out.', { name: user.displayName })
        : t('{name} will need to sign in again on it.', { name: user.displayName })}
      footer={<><Button disabled={removing} onClick={() => setRemoval(null)}>{t('Cancel')}</Button><Button variant="danger" icon="key" loading={removing} onClick={() => void remove()}>{removal?.kind === 'passkey' ? t('Verify and remove') : t('Verify and sign out')}</Button></>}>
      <div className="delete-summary"><Icon name={removal?.kind === 'passkey' ? 'key' : 'globe'} size={20} /><strong><bdi>{removal ? removal.kind === 'passkey' ? removal.item.name : device(removal.item) : ''}</bdi></strong></div>
      {lastPasskey ? <InlineMessage variant="warning">{t('This is their only passkey. Until you give them a sign-in code, they can’t sign in.')}</InlineMessage> : null}
    </Dialog>
    <CreatedCodeDialog created={created} number={undefined} person={() => user.displayName} onClose={() => setCreated(null)} />
  </div>
}
