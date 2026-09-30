import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { DefaultLimits, UserLimits } from '../../api/contracts'
import { defaultLimitsChange } from '../../app/adminChanges'
import { useI18n } from '../../app/i18n'
import { authorizePasskeyAction } from '../../app/passkeyAuthorization'
import { errorMessage } from '../../app/utils'
import { Button, Dialog, EmptyState, Input, LoadingState, Select, SelectOption, useToast } from '../../design-system'
import { useInsightFormat } from '../insights/format'
import { useAdminRefresh } from './AdminData'
import { NUMERIC_LIMITS, useLimitText } from './AdminUserDrawer'

type Draft = Record<(typeof NUMERIC_LIMITS)[number]['key'], string> & { guestLinks: boolean }

const draftOf = (limits: UserLimits): Draft => ({
  concurrentRecordings: String(limits.concurrentRecordings), monthlyRecordingMinutes: String(limits.monthlyRecordingMinutes),
  storageMb: String(limits.storageMb), workspaces: String(limits.workspaces), guestLinks: limits.guestLinks,
})

/**
 * The limits every account follows unless an administrator gave it its own.
 * A change reaches every such account at once, from its next recording.
 */
export function DefaultLimitsDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (defaults: UserLimits) => void }) {
  const { t } = useI18n()
  const { push } = useToast()
  const refresh = useAdminRefresh()
  const format = useInsightFormat()
  const text = useLimitText()
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; value?: DefaultLimits; error?: string }>({ status: 'loading' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let active = true
    api.admin.defaultLimits()
      .then((value) => { if (active) { setState({ status: 'ready', value }); setDraft(draftOf(value.defaults)); setInvalid(null) } })
      .catch((caught) => { if (active) setState({ status: 'error', error: errorMessage(caught) }) })
    return () => { active = false }
  }, [open, attempt])

  const saved = state.value ? draftOf(state.value.defaults) : null
  const changed = !!draft && !!saved && (Object.keys(draft) as Array<keyof Draft>).some((key) => draft[key] !== saved[key])
  const builtIn = state.value?.builtIn
  const shown = (key: keyof UserLimits, value: number, zeroMeansNone?: boolean) => zeroMeansNone && value === 0 ? t('No limit') : format.whole(value)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || saving) return
    const limits = { guestLinks: draft.guestLinks } as UserLimits
    for (const field of NUMERIC_LIMITS) {
      const number = Number(draft[field.key].trim())
      if (!draft[field.key].trim() || !Number.isInteger(number) || number < field.min || number > field.max) { setInvalid(field.key); return }
      limits[field.key] = number
    }
    setInvalid(null)
    const ordered: UserLimits = { concurrentRecordings: limits.concurrentRecordings, monthlyRecordingMinutes: limits.monthlyRecordingMinutes, storageMb: limits.storageMb, workspaces: limits.workspaces, guestLinks: limits.guestLinks }
    setSaving(true)
    try {
      const { body, scope } = await defaultLimitsChange(ordered)
      const authorization = await authorizePasskeyAction(scope)
      const result = await api.admin.setDefaultLimits(authorization.authorizationToken, body)
      setState({ status: 'ready', value: result }); setDraft(draftOf(result.defaults))
      refresh('audit'); onSaved(result.defaults)
      push({ tone: 'success', title: t('Default limits saved'), message: t('Every account without its own value follows them from its next recording.') })
      onClose()
    } catch (caught) { push({ tone: 'error', title: t('Default limits weren’t saved'), message: errorMessage(caught) }) }
    finally { setSaving(false) }
  }

  return <Dialog open={open} onClose={() => !saving && onClose()} size="md" title={t('Default limits')}
    description={t('What every account may use unless you gave it its own limits. A change reaches all of them at once.')}
    footer={<>
      {builtIn && draft ? <Button type="button" variant="ghost" disabled={saving} onClick={() => { setDraft(draftOf(builtIn)); setInvalid(null) }}>{t('Use the built-in defaults')}</Button> : null}
      <Button type="button" disabled={saving} onClick={onClose}>{t('Cancel')}</Button>
      <Button type="submit" form="default-limits" variant="primary" icon="key" disabled={!changed} loading={saving}>{t('Verify and save')}</Button>
    </>}>
    {state.status === 'error' ? <EmptyState icon="warning" title={t('Default limits couldn’t be loaded')} description={state.error ?? ''} action={<Button icon="refresh" onClick={() => { setState({ status: 'loading' }); setAttempt((count) => count + 1) }}>{t('Try again')}</Button>} />
      : !draft || !builtIn ? <LoadingState label={t('Loading default limits')} />
      : <form id="default-limits" className="admin-drawer__rows default-limits" noValidate onSubmit={(event) => void submit(event)} aria-busy={saving}>
        {NUMERIC_LIMITS.map((field) => <div key={field.key} className="admin-drawer__row admin-drawer__row--field">
          <div><strong>{text[field.key].label}</strong><p>{text[field.key].hint} {t('Built in: {value}.', { value: shown(field.key, builtIn[field.key], field.zeroMeansNone) })}</p></div>
          <Input type="number" inputMode="numeric" min={field.min} max={field.max} step={1} label={text[field.key].label} value={draft[field.key]}
            suffix={field.unit ? <span className="limit-suffix">{field.unit === 'min' ? t('min') : field.unit}</span> : undefined}
            error={invalid === field.key ? t('Use a whole number from {min} to {max}.', { min: format.whole(field.min), max: format.whole(field.max) }) : undefined}
            onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
        </div>)}
        <div className="admin-drawer__row admin-drawer__row--field">
          <div><strong>{t('Links for guests')}</strong><p>{t('Whether accounts may share sessions with people who aren’t signed in. Turning this off closes links already shared.')}</p></div>
          <Select fullWidth label={t('Links for guests')} value={draft.guestLinks ? 'on' : 'off'} onValueChange={(value) => setDraft({ ...draft, guestLinks: value === 'on' })}>
            <SelectOption value="on">{t('Allowed')}</SelectOption>
            <SelectOption value="off">{t('Not allowed')}</SelectOption>
          </Select>
        </div>
      </form>}
  </Dialog>
}
