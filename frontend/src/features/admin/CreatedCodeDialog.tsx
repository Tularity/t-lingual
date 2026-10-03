import { useState } from 'react'
import { copyTextToClipboard } from '@tular/ui'
import type { Invitation } from '../../api/contracts'
import { Button, Dialog, useToast } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { invitationStart } from './adminModel'
import './access-codes.css'

/** The one moment the code can be seen: large enough to read out, and easy to pass on. */
export function CreatedCodeDialog({ created, number, person, onClose }: { created: { code: string; invitation: Invitation } | null; number: number | undefined; person: (id: string | null | undefined) => string; onClose: () => void }) {
  const { t, formatDate } = useI18n()
  const { push } = useToast()
  const [shown, setShown] = useState(created)
  if (created && created !== shown) setShown(created)
  const item = created ?? shown
  const copy = async (text: string, title: string) => {
    try { await copyTextToClipboard(text); push({ tone: 'success', title }) }
    catch { push({ tone: 'error', title: t('Clipboard access was denied') }) }
  }
  const instructions = item ? [
    item.invitation.kind === 'login' ? t('Your one-time sign-in code for T-Lingual: {code}', { code: item.code }) : t('Your access code for T-Lingual: {code}', { code: item.code }),
    t('Open {address}, choose “Use a temporary code” and enter it.', { address: `${window.location.origin}/login` }),
    t('It works once, until {date}.', { date: formatDate(item.invitation.expiresAt) }),
  ].join('\n') : ''
  return <Dialog open={Boolean(created)} onClose={onClose} title={t('Copy this code now')} description={t('The six-digit code is shown once. Share it privately with its intended recipient.')} footer={<><Button onClick={onClose}>{t('Done')}</Button><Button icon="copy" onClick={() => void copy(instructions, t('Code and instructions copied'))}>{t('Copy with instructions')}</Button><Button variant="primary" icon="copy" onClick={() => item && void copy(item.code, t('Code copied'))}>{t('Copy code')}</Button></>}>
    {item && <div className="code-reveal">
      <button type="button" className="code-reveal__digits" aria-label={t('Copy code {code}', { code: item.code })} onClick={() => void copy(item.code, t('Code copied'))}>{item.code.split('').map((digit, index) => <span key={index}>{digit}</span>)}</button>
      <dl className="code-reveal__facts">
        {number !== undefined ? <div><dt>{t('Code')}</dt><dd>#{number}</dd></div> : null}
        <div><dt>{t('For')}</dt><dd><bdi>{item.invitation.kind === 'login' ? t('Sign-in for {name}', { name: person(item.invitation.targetUserId) }) : t('New account')}</bdi></dd></div>
        <div><dt>{t('Starts')}</dt><dd>{formatDate(invitationStart(item.invitation))}</dd></div>
        <div><dt>{t('Valid until')}</dt><dd>{formatDate(item.invitation.expiresAt)}</dd></div>
      </dl>
    </div>}
  </Dialog>
}
