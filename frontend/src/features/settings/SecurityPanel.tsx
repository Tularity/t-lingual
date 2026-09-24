import { useState } from 'react'
import type { BrowserSession, Passkey } from '../../api/contracts'
import { Badge, Button, Card, Dialog, EmptyState, Icon } from '../../design-system'
import { useI18n } from '../../app/i18n'

interface SecurityPanelProps {
  passkeys: Passkey[]
  browserSessions: BrowserSession[]
  keyBusy: boolean
  sessionBusyId: string | null
  revokeOthersBusy: boolean
  onAddPasskey: () => void
  onRemovePasskey: (passkey: Passkey) => void
  onRevokeSession: (session: BrowserSession) => Promise<boolean>
  onRevokeOthers: () => Promise<boolean>
}

export function canRemovePasskey(passkeys: Passkey[], target: Passkey) {
  const healthyPasskeys = passkeys.filter((passkey) => !passkey.compromisedAt).length
  return target.compromisedAt ? healthyPasskeys >= 1 : healthyPasskeys >= 2
}

export function SecurityPanel({
  passkeys,
  browserSessions,
  keyBusy,
  sessionBusyId,
  revokeOthersBusy,
  onAddPasskey,
  onRemovePasskey,
  onRevokeSession,
  onRevokeOthers,
}: SecurityPanelProps) {
  const { t, formatDate: localDate } = useI18n()
  const [targetSession, setTargetSession] = useState<BrowserSession | null>(null)
  const [revokeOthersOpen, setRevokeOthersOpen] = useState(false)
  const otherSessionCount = browserSessions.filter((session) => !session.current).length
  const sessionActionBusy = sessionBusyId !== null || revokeOthersBusy
  const securityActionBusy = keyBusy || sessionActionBusy

  const confirmSessionRevoke = async () => {
    if (!targetSession) return
    if (await onRevokeSession(targetSession)) setTargetSession(null)
  }
  const confirmRevokeOthers = async () => {
    if (await onRevokeOthers()) setRevokeOthersOpen(false)
  }

  return (
    <section className="security-settings" aria-labelledby="security-title">
      <div className="settings-heading settings-heading--action">
        <div>
          <h2 id="security-title">{t("Your passkeys")}</h2>
          <p>{t("Keep passkeys on two devices. An administrator can provide a temporary sign-in code if you lose access.")}</p>
        </div>
        <Button variant="primary" icon="plus" disabled={securityActionBusy} onClick={onAddPasskey}>{t("Add passkey")}</Button>
      </div>
      {passkeys.length === 0 ? (
        <Card>
          <EmptyState
            icon="key"
            title={t("No passkeys found")}
            description={t("This account needs a passkey before it can sign in again.")}
            action={<Button variant="primary" disabled={securityActionBusy} onClick={onAddPasskey}>{t("Add passkey")}</Button>}
          />
        </Card>
      ) : (
        <Card className="passkey-list">
          {passkeys.map((passkey) => {
            const removable = canRemovePasskey(passkeys, passkey)
            const lockedReasonId = `passkey-${passkey.id}-locked`
            return (
              <div className="passkey-row" key={passkey.id}>
                <span className="passkey-row__icon">
                  <Icon name={passkey.compromisedAt ? 'warning' : 'key'} size={20} />
                </span>
                <div>
                  <strong>
                    <bdi>{passkey.name}</bdi> {passkey.compromisedAt && <Badge tone="danger">{t("Quarantined")}</Badge>}
                  </strong>
                  <p>
                    {passkey.compromisedAt
                      ? t('A counter anomaly was detected {date}. This passkey cannot sign in again.', { date: localDate(passkey.compromisedAt) })
                      : <>{t("Added")} {localDate(passkey.createdAt, { dateStyle: 'medium' })} · {passkey.lastUsedAt ? t('Last used {date}', { date: localDate(passkey.lastUsedAt) }) : t('Never used')}</>}
                  </p>
                </div>
                {!removable && <span id={lockedReasonId} className="sr-only">{t("Keep at least one healthy passkey that can sign in.")}</span>}
                <Button
                  variant="ghost"
                  icon="trash"
                  iconOnly
                  aria-label={t('Remove {name}', { name: passkey.name })}
                  aria-describedby={removable ? undefined : lockedReasonId}
                  disabled={!removable || securityActionBusy}
                  onClick={() => onRemovePasskey(passkey)}
                />
              </div>
            )
          })}
        </Card>
      )}

      <div className="settings-heading settings-heading--action security-sessions-heading">
        <div>
          <h2>{t("Signed-in browsers")}</h2>
          <p>{t("Review where your account is active. Session tokens are never shown here.")}</p>
        </div>
        {otherSessionCount === 0 && <span id="revoke-others-reason" className="sr-only">{t("No other browsers are signed in.")}</span>}
        <Button
          variant="secondary"
          icon="shield"
          disabled={otherSessionCount === 0 || securityActionBusy}
          aria-describedby={otherSessionCount === 0 ? 'revoke-others-reason' : undefined}
          onClick={() => setRevokeOthersOpen(true)}
        >
          {t("Sign out other browsers")}
        </Button>
      </div>
      {browserSessions.length === 0 ? (
        <Card>
          <EmptyState
            icon="shield"
            title={t("No active browsers")}
            description={t("This sign-in may have expired. Refresh the page or sign in again.")}
          />
        </Card>
      ) : (
        <Card className="browser-session-list">
          {browserSessions.map((session) => (
            <article className="browser-session-row" key={session.id}>
              <span className={`browser-session-row__icon${session.current ? ' browser-session-row__icon--current' : ''}`}>
                <Icon name={session.current ? 'shield' : 'user'} size={20} />
              </span>
              <div className="browser-session-row__body">
                <div className="browser-session-row__title">
                  <strong><bdi>{session.userAgent || t('Unknown browser')}</bdi></strong>
                  {session.current && <Badge tone="success">{t("This browser")}</Badge>}
                </div>
                <dl className="browser-session-meta">
                  <div><dt>{t("IP address")}</dt><dd><bdi>{session.ipAddress || t('Unavailable')}</bdi></dd></div>
                  <div><dt>{t("Last active")}</dt><dd>{localDate(session.lastSeen)}</dd></div>
                  <div><dt>{t("Expires")}</dt><dd>{localDate(session.expiresAt, { dateStyle: 'medium' })}</dd></div>
                </dl>
              </div>
              <Button
                variant={session.current ? 'secondary' : 'ghost'}
                size="sm"
                icon="logout"
                loading={sessionBusyId === session.id}
                disabled={securityActionBusy && sessionBusyId !== session.id}
                aria-label={session.current ? t('Sign out this browser') : t('Sign out {browser}', { browser: session.userAgent || t('unknown browser') })}
                onClick={() => setTargetSession(session)}
              >
                {t("Sign out")}
              </Button>
            </article>
          ))}
        </Card>
      )}

      <Dialog
        open={targetSession !== null}
        onClose={() => !sessionActionBusy && setTargetSession(null)}
        title={targetSession?.current ? t('Sign out this browser?') : t('Sign out this browser session?')}
        description={targetSession?.current
          ? t('Your current session will end immediately and you’ll return to passkey sign-in.')
          : t('Verify a passkey to protect your other signed-in browsers from a stolen session cookie.')}
        footer={<>
          <Button disabled={sessionActionBusy} onClick={() => setTargetSession(null)}>{t("Cancel")}</Button>
          <Button
            variant="danger"
            icon={targetSession?.current ? 'logout' : 'key'}
            loading={targetSession !== null && sessionBusyId === targetSession.id}
            onClick={() => void confirmSessionRevoke()}
          >
            {targetSession?.current ? t('Sign out') : t('Verify and sign out')}
          </Button>
        </>}
      >
        <div className="session-revoke-summary">
          <Icon name="user" size={20} />
          <div>
            <strong><bdi>{targetSession?.userAgent || t('Unknown browser')}</bdi></strong>
            <span><bdi>{targetSession?.ipAddress || t('IP unavailable')}</bdi></span>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={revokeOthersOpen}
        onClose={() => !revokeOthersBusy && setRevokeOthersOpen(false)}
        title={t("Sign out every other browser?")}
        description={t("Verify a passkey to end all other browser sessions immediately. This browser will stay signed in.")}
        footer={<>
          <Button disabled={revokeOthersBusy} onClick={() => setRevokeOthersOpen(false)}>{t("Cancel")}</Button>
          <Button variant="danger" icon="key" loading={revokeOthersBusy} onClick={() => void confirmRevokeOthers()}>
            {t("Verify and sign out")} {otherSessionCount}
          </Button>
        </>}
      >
        <div className="security-callout">
          <Icon name="shield" size={20} />
          <p>{t("Any live interpretation streams opened in those browsers will also be disconnected.")}</p>
        </div>
      </Dialog>
    </section>
  )
}
