import { useState } from 'react'
import { api } from '../../api/client'
import type { User } from '../../api/contracts'
import { Button, Dialog, Icon, useToast } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage } from '../../app/utils'
import { useAdminRefresh } from './AdminData'
import { userUpdateScope } from './adminModel'

/**
 * Changing someone's role or access, with the administrator's passkey.
 * Disabling asks first: it ends the person's sessions at once. `dialog` is
 * that question, to be rendered by the page using the hook.
 */
export function useAccessUpdate(onUpdated: (user: User) => void) {
  const { t } = useI18n()
  const { push } = useToast()
  const refresh = useAdminRefresh()
  const [busy, setBusy] = useState(false)
  const [disableTarget, setDisableTarget] = useState<User | null>(null)

  const apply = async (target: User, input: Partial<Pick<User, 'role' | 'status'>>) => {
    setBusy(true)
    try {
      const authorization = await authorizePasskeyAction(userUpdateScope(target.id, input))
      const updated = await api.admin.updateUser(authorization.authorizationToken, target.id, input)
      onUpdated(updated)
      setDisableTarget(null); refresh('audit'); push({ tone: 'success', title: t('User updated') })
    } catch (caught) { push({ tone: 'error', title: t('User wasn’t updated'), message: errorMessage(caught) }) }
    finally { setBusy(false) }
  }

  const update = (target: User, input: Partial<Pick<User, 'role' | 'status'>>) => {
    if (input.status === 'disabled') setDisableTarget(target)
    else void apply(target, input)
  }

  const dialog = <Dialog open={!!disableTarget} onClose={() => !busy && setDisableTarget(null)} title={t('Disable this account?')} description={t('Verify your passkey to end this person’s access immediately. Their stored sessions and transcripts remain private to them.')}
    footer={<><Button disabled={busy} onClick={() => setDisableTarget(null)}>{t('Cancel')}</Button><Button variant="danger" icon="key" loading={busy} onClick={() => disableTarget && void apply(disableTarget, { status: 'disabled' })}>{t('Verify and disable')}</Button></>}>
    <div className="delete-summary"><Icon name="user" size={20} /><strong><bdi>{disableTarget?.displayName}</bdi></strong></div>
  </Dialog>

  return { update, busy, dialog }
}
