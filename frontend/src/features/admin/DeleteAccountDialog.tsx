import { useState } from 'react'
import { InlineMessage } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { AccountStanding, User } from '../../api/contracts'
import { useI18n } from '../../app/i18n'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage } from '../../app/utils'
import { Button, Dialog, Icon, Input, useToast } from '../../design-system'
import { useInsightFormat } from '../insights/format'
import { userDeleteScope } from './adminModel'

/**
 * Deleting an account for good. What goes with it is said in numbers, the
 * username must be typed to go on, and the administrator's passkey authorizes
 * deleting this one account only. Disabling is offered as what keeps
 * everything.
 */
export function DeleteAccountDialog({ user, standing, open, onClose, onDeleted }: {
  user: User
  standing: AccountStanding | undefined
  open: boolean
  onClose: () => void
  onDeleted: (user: User) => void
}) {
  const { t } = useI18n()
  const { push } = useToast()
  const format = useInsightFormat()
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const confirmed = typed.trim() === user.username
  const close = () => { if (!deleting) { setTyped(''); onClose() } }

  const remove = async () => {
    if (!confirmed || deleting) return
    setDeleting(true)
    try {
      const authorization = await authorizePasskeyAction(userDeleteScope(user.id))
      await api.admin.deleteUser(authorization.authorizationToken, user.id)
      push({ tone: 'success', title: t('Account deleted'), message: t('{name} and everything the account held are gone.', { name: user.displayName }) })
      setTyped('')
      onDeleted(user)
    } catch (caught) { push({ tone: 'error', title: t('Account wasn’t deleted'), message: t(errorMessage(caught)) }) }
    finally { setDeleting(false) }
  }

  return <Dialog open={open} onClose={close} title={t('Delete {name}’s account?', { name: user.displayName })}
    description={t('This can’t be undone. To keep everything but stop them signing in, disable the account instead.')}
    footer={<><Button disabled={deleting} onClick={close}>{t('Cancel')}</Button><Button variant="danger" icon="key" disabled={!confirmed} loading={deleting} onClick={() => void remove()}>{t('Verify and delete')}</Button></>}>
    <div className="delete-account">
      <ul className="delete-account__list">
        <li><Icon name="folder" size={16} />{standing ? t(standing.sessions === 1 ? '{count} session, with its recordings, transcripts and translations' : '{count} sessions, with their recordings, transcripts and translations', { count: format.whole(standing.sessions) }) : t('Every session, with its recordings, transcripts and translations')}</li>
        {standing ? <li><Icon name="database" size={16} />{t('{size} of stored audio and text', { size: format.bytes(standing.storageBytes) })}</li> : null}
        <li><Icon name="grid" size={16} />{t('Their workspaces, and every link and invitation to their sessions')}</li>
        <li><Icon name="key" size={16} />{t('Their passkeys and signed-in browsers; any recording in their sessions stops')}</li>
      </ul>
      <InlineMessage variant="warning">{t('The activity log keeps what was done, and access codes they made or used stay listed.')}</InlineMessage>
      <Input label={t('Type {username} to confirm', { username: user.username })} value={typed} autoComplete="off" spellCheck={false}
        disabled={deleting} placeholder={user.username} onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void remove() }} />
    </div>
  </Dialog>
}
