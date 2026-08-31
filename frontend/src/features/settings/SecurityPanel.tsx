import { useState } from 'react'
import type { BrowserSession, Passkey } from '../../api/contracts'
import { Badge, Button, Card, Dialog, EmptyState, Icon } from '../../design-system'
import { formatDate } from '../../app/utils'

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
          <h2 id="security-title">Your passkeys</h2>
          <p>Passkeys are the only way to sign in. Keep at least two on different devices.</p>
        </div>
        <Button variant="primary" icon="plus" disabled={securityActionBusy} onClick={onAddPasskey}>Add passkey</Button>
      </div>
      {passkeys.length === 0 ? (
        <Card>
          <EmptyState
            icon="key"
            title="No passkeys found"
            description="This account needs a passkey before it can sign in again."
            action={<Button variant="primary" disabled={securityActionBusy} onClick={onAddPasskey}>Add passkey</Button>}
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
                    <bdi>{passkey.name}</bdi> {passkey.compromisedAt && <Badge tone="danger">Quarantined</Badge>}
                  </strong>
                  <p>
                    {passkey.compromisedAt
                      ? `A counter anomaly was detected ${formatDate(passkey.compromisedAt)}. This passkey cannot sign in again.`
                      : <>Added {formatDate(passkey.createdAt, { dateStyle: 'medium' })} · {passkey.lastUsedAt ? `Last used ${formatDate(passkey.lastUsedAt)}` : 'Never used'}</>}
                  </p>
                </div>
                {!removable && <span id={lockedReasonId} className="sr-only">Keep at least one healthy passkey that can sign in.</span>}
                <Button
                  variant="ghost"
                  icon="trash"
                  iconOnly
                  aria-label={`Remove ${passkey.name}`}
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
          <h2>Signed-in browsers</h2>
          <p>Review where your account is active. Session tokens are never shown here.</p>
        </div>
        {otherSessionCount === 0 && <span id="revoke-others-reason" className="sr-only">No other browsers are signed in.</span>}
        <Button
          variant="secondary"
          icon="shield"
          disabled={otherSessionCount === 0 || securityActionBusy}
          aria-describedby={otherSessionCount === 0 ? 'revoke-others-reason' : undefined}
          onClick={() => setRevokeOthersOpen(true)}
        >
          Sign out other browsers
        </Button>
      </div>
      {browserSessions.length === 0 ? (
        <Card>
          <EmptyState
            icon="shield"
            title="No active browsers"
            description="This sign-in may have expired. Refresh the page or sign in again."
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
                  <strong><bdi>{session.userAgent || 'Unknown browser'}</bdi></strong>
                  {session.current && <Badge tone="success">This browser</Badge>}
                </div>
                <dl className="browser-session-meta">
                  <div><dt>IP address</dt><dd><bdi>{session.ipAddress || 'Unavailable'}</bdi></dd></div>
                  <div><dt>Last active</dt><dd>{formatDate(session.lastSeen)}</dd></div>
                  <div><dt>Expires</dt><dd>{formatDate(session.expiresAt, { dateStyle: 'medium' })}</dd></div>
                </dl>
              </div>
              <Button
                variant={session.current ? 'secondary' : 'ghost'}
                size="sm"
                icon="logout"
                loading={sessionBusyId === session.id}
                disabled={securityActionBusy && sessionBusyId !== session.id}
                aria-label={session.current ? 'Sign out this browser' : `Sign out ${session.userAgent || 'unknown browser'}`}
                onClick={() => setTargetSession(session)}
              >
                Sign out
              </Button>
            </article>
          ))}
        </Card>
      )}

      <Dialog
        open={targetSession !== null}
        onClose={() => !sessionActionBusy && setTargetSession(null)}
        title={targetSession?.current ? 'Sign out this browser?' : 'Sign out this browser session?'}
        description={targetSession?.current
          ? 'Your current session will end immediately and you’ll return to passkey sign-in.'
          : 'Verify a passkey to protect your other signed-in browsers from a stolen session cookie.'}
        footer={<>
          <Button disabled={sessionActionBusy} onClick={() => setTargetSession(null)}>Cancel</Button>
          <Button
            variant="danger"
            icon={targetSession?.current ? 'logout' : 'key'}
            loading={targetSession !== null && sessionBusyId === targetSession.id}
            onClick={() => void confirmSessionRevoke()}
          >
            {targetSession?.current ? 'Sign out' : 'Verify and sign out'}
          </Button>
        </>}
      >
        <div className="session-revoke-summary">
          <Icon name="user" size={20} />
          <div>
            <strong><bdi>{targetSession?.userAgent || 'Unknown browser'}</bdi></strong>
            <span><bdi>{targetSession?.ipAddress || 'IP unavailable'}</bdi></span>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={revokeOthersOpen}
        onClose={() => !revokeOthersBusy && setRevokeOthersOpen(false)}
        title="Sign out every other browser?"
        description="Verify a passkey to end all other browser sessions immediately. This browser will stay signed in."
        footer={<>
          <Button disabled={revokeOthersBusy} onClick={() => setRevokeOthersOpen(false)}>Cancel</Button>
          <Button variant="danger" icon="key" loading={revokeOthersBusy} onClick={() => void confirmRevokeOthers()}>
            Verify and sign out {otherSessionCount}
          </Button>
        </>}
      >
        <div className="security-callout">
          <Icon name="shield" size={20} />
          <p>Any live interpretation streams opened in those browsers will also be disconnected.</p>
        </div>
      </Dialog>
    </section>
  )
}
