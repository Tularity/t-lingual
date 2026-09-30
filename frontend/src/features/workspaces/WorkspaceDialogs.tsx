import { useId, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import { WORKSPACE_ICONS, type InterpretationSession, type Workspace, type WorkspaceIcon } from '../../api/contracts'
import { Button, Dialog, Icon, Input, Select, SelectOption, useToast } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { errorMessage } from '../../app/utils'
import { useWorkspaces, workspaceIcon } from '../../app/workspaces'
import './workspaces.css'

/** The longest name a workspace can have, as the server counts it. */
const NAME_LIMIT = 60

/** What each icon is called, for anyone who cannot see it. */
const ICON_NAMES: Record<WorkspaceIcon, string> = {
  folder: 'Folder', archive: 'Archive box', layers: 'Layers', bookmark: 'Bookmark',
  tag: 'Tag', star: 'Star', heart: 'Heart', flag: 'Flag',
  home: 'Home', building: 'Building', briefcase: 'Briefcase', user: 'Individual',
  users: 'Team', chat: 'Conversation', mail: 'Mail', phone: 'Phone',
  microphone: 'Microphone', headphones: 'Headphones', volume: 'Speaker', video: 'Video',
  film: 'Film', camera: 'Camera', music: 'Music', presentation: 'Presentation',
  languages: 'Languages', globe: 'Globe', mapPin: 'Place', plane: 'Travel',
  send: 'Send', calendar: 'Calendar', clock: 'Clock', target: 'Target',
  book: 'Book', graduationCap: 'Education', newspaper: 'News', lightbulb: 'Idea',
  spark: 'Spark', rocket: 'Launch', trophy: 'Trophy', palette: 'Design',
  scale: 'Law', stethoscope: 'Health', shield: 'Shield', database: 'Data',
  code: 'Code', terminal: 'Terminal', leaf: 'Nature', coffee: 'Coffee',
}

/** One icon out of the set a workspace can have: tiles that behave as radio buttons. */
function WorkspaceIconPicker({ value, onChange, disabled }: { value: WorkspaceIcon; onChange: (icon: WorkspaceIcon) => void; disabled?: boolean }) {
  const { t } = useI18n()
  const label = useId()
  return <div className="tl-field workspace-icons">
    <span id={label} className="tl-field__label">{t('Icon')}</span>
    <div role="radiogroup" aria-labelledby={label} className="workspace-icons__grid">{WORKSPACE_ICONS.map(icon => <label key={icon} className="workspace-icons__choice" title={t(ICON_NAMES[icon])}>
      <input type="radio" name={label} value={icon} checked={value === icon} disabled={disabled} onChange={() => onChange(icon)} aria-label={t(ICON_NAMES[icon])} />
      <Icon name={icon} size={18} />
    </label>)}</div>
  </div>
}

/**
 * What a dialog was opened for, kept as it was opened: fields start over each
 * time it opens, and its content stays put while it closes.
 */
function useSubject<T>(open: boolean, subject: T, reset: () => void): T {
  const [opened, setOpened] = useState({ open, subject })
  if (open !== opened.open) { setOpened({ open, subject: open ? subject : opened.subject }); if (open) reset() }
  return open && !opened.open ? subject : opened.subject
}

/** Names a new workspace and chooses its icon — or, given one, changes them. */
export function WorkspaceDialog({ open, workspace, onClose, onSaved }: { open: boolean; workspace?: Workspace; onClose: () => void; onSaved?: (workspace: Workspace) => void }) {
  const { t } = useI18n()
  const { push } = useToast()
  const workspaces = useWorkspaces()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<WorkspaceIcon>('folder')
  const [saving, setSaving] = useState(false)
  // An unnamed workspace starts with the name it is shown with, so changing
  // only its icon does not ask for a name first.
  const subject = useSubject(open, workspace, () => { setName(workspace ? workspaces.name(workspace) : ''); setIcon(workspaceIcon(workspace)) })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const saved = subject ? await workspaces.update(subject.id, { name, icon }) : await workspaces.create({ name, icon })
      push({ tone: 'success', title: subject ? t('Workspace updated') : t('Workspace created') })
      onClose(); onSaved?.(saved)
    } catch (caught) { push({ tone: 'error', title: subject ? t('Couldn’t update workspace') : t('Couldn’t create workspace'), message: t(errorMessage(caught)) }) }
    finally { setSaving(false) }
  }
  return <Dialog size="sm" open={open} onClose={() => !saving && onClose()} title={subject ? t('Edit workspace') : t('New workspace')} description={subject ? undefined : t('Keep related conversations together.')} footer={<><Button onClick={onClose} disabled={saving}>{t('Cancel')}</Button><Button type="submit" form="workspace-name" variant="primary" loading={saving} disabled={!name.trim()}>{subject ? t('Save changes') : t('Create workspace')}</Button></>}>
    <form id="workspace-name" className="workspace-form" onSubmit={(event) => void submit(event)}>
      <Input dir="auto" autoFocus disabled={saving} icon={icon} label={t('Workspace name')} placeholder={subject ? workspaces.name(subject) : t('e.g. Client calls')} maxLength={NAME_LIMIT} value={name} onChange={(event) => setName(event.target.value)} />
      <WorkspaceIconPicker value={icon} onChange={setIcon} disabled={saving} />
    </form>
  </Dialog>
}

/**
 * Deletes a workspace. Its sessions are never deleted with it: when it holds
 * any, the user chooses the workspace they move to, and nothing is deleted
 * until they have. The last workspace cannot be deleted at all.
 */
export function DeleteWorkspaceDialog({ workspace, onClose, onDeleted }: { workspace: Workspace | null; onClose: () => void; onDeleted?: (movedTo: string | undefined) => void }) {
  const { t } = useI18n()
  const { push } = useToast()
  const workspaces = useWorkspaces()
  const [target, setTarget] = useState('')
  const [deleting, setDeleting] = useState(false)
  // The count decides whether a destination is needed, so it is read afresh.
  const subject = useSubject(Boolean(workspace), workspace, () => { setTarget(''); void workspaces.refresh().catch(() => undefined) })
  const current = subject ? workspaces.find(subject.id) ?? subject : null
  const others = workspaces.items.filter(item => item.id !== current?.id)
  const count = current?.sessionCount ?? 0
  const needsTarget = count > 0
  const submit = async () => {
    if (!current || deleting || (needsTarget && !target)) return
    setDeleting(true)
    try {
      const movedTo = needsTarget ? target : undefined
      await workspaces.remove(current.id, movedTo)
      const destination = workspaces.find(movedTo)
      push({ tone: 'success', title: t('Workspace deleted'), message: movedTo && destination ? t(count === 1 ? '1 session moved to {name}' : '{count} sessions moved to {name}', { count, name: workspaces.name(destination) }) : undefined })
      onClose(); onDeleted?.(movedTo)
    } catch (caught) {
      push({ tone: 'error', title: t('Couldn’t delete workspace'), message: t(errorMessage(caught)) })
      void workspaces.refresh().catch(() => undefined)
    } finally { setDeleting(false) }
  }
  const last = others.length === 0
  return <Dialog size="sm" open={Boolean(workspace)} onClose={() => !deleting && onClose()} title={last ? t('Keep at least one workspace') : t('Delete this workspace?')} description={last ? t('Every account keeps one workspace. Create another before deleting this one.') : needsTarget ? t('Its sessions are kept: choose the workspace they move to.') : t('This workspace is empty. Deleting it removes only the workspace.')} footer={last ? <Button variant="primary" onClick={onClose}>{t('Got it')}</Button> : <><Button onClick={onClose} disabled={deleting}>{t('Keep workspace')}</Button><Button variant="danger" icon="trash" loading={deleting} disabled={needsTarget && !target} onClick={() => void submit()}>{t('Delete workspace')}</Button></>}>
    <div className="workspace-delete">
      <div className="workspace-delete__summary"><Icon name={workspaceIcon(current ?? undefined)} size={20} /><div><strong dir="auto">{workspaces.name(current ?? undefined)}</strong><span>{t(count === 1 ? '{count} session' : '{count} sessions', { count })}</span></div></div>
      {!last && needsTarget && <Select label={t('Move its sessions to')} placeholder={t('Choose a workspace')} value={target} onValueChange={setTarget} fullWidth disabled={deleting}>{others.map(item => <SelectOption key={item.id} value={item.id} icon={<Icon name={workspaceIcon(item)} size={16} />}>{workspaces.name(item)}</SelectOption>)}</Select>}
    </div>
  </Dialog>
}

/** Keeps one of the user's sessions in another of their workspaces. */
export function MoveSessionDialog({ session, onClose, onMoved }: { session: InterpretationSession | null; onClose: () => void; onMoved?: (session: InterpretationSession) => void }) {
  const { t } = useI18n()
  const { push } = useToast()
  const workspaces = useWorkspaces()
  const [target, setTarget] = useState('')
  const [moving, setMoving] = useState(false)
  const subject = useSubject(Boolean(session), session, () => setTarget(''))
  const others = workspaces.items.filter(item => item.id !== subject?.workspaceId)
  const submit = async () => {
    if (!subject || !target || moving) return
    setMoving(true)
    try {
      const moved = await api.sessions.move(subject.id, target)
      push({ tone: 'success', title: t('Session moved'), message: t('Now in {name}', { name: workspaces.name(workspaces.find(target)) }) })
      void workspaces.refresh().catch(() => undefined)
      onClose(); onMoved?.(moved)
    } catch (caught) { push({ tone: 'error', title: t('Couldn’t move session'), message: t(errorMessage(caught)) }) }
    finally { setMoving(false) }
  }
  return <Dialog size="sm" open={Boolean(session)} onClose={() => !moving && onClose()} title={t('Move to another workspace')} footer={<><Button onClick={onClose} disabled={moving}>{t('Cancel')}</Button><Button variant="primary" loading={moving} disabled={!target} onClick={() => void submit()}>{t('Move session')}</Button></>}>
    <div className="workspace-delete">
      <div className="workspace-delete__summary workspace-delete__summary--quiet"><Icon name="wave" size={20} /><div><strong dir="auto">{subject?.title}</strong><span>{t('In {name}', { name: workspaces.name(workspaces.find(subject?.workspaceId)) })}</span></div></div>
      <Select label={t('Move to')} placeholder={t('Choose a workspace')} value={target} onValueChange={setTarget} fullWidth disabled={moving}>{others.map(item => <SelectOption key={item.id} value={item.id} icon={<Icon name={workspaceIcon(item)} size={16} />}>{workspaces.name(item)}</SelectOption>)}</Select>
    </div>
  </Dialog>
}
