import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '../../api/contracts'
import { Button, Icon, LoadingState, useToast } from '../../design-system'
import { useI18n } from '../../app/i18n'
import { Link, useRouter } from '../../app/router'
import { errorMessage, relativeTime } from '../../app/utils'
import { useWorkspaces, workspaceIcon } from '../../app/workspaces'
import { Menu, MenuItem, MenuSeparator, useRevealOnView } from '@tular/ui'
import { DeleteWorkspaceDialog, WorkspaceDialog } from './WorkspaceDialogs'
import './workspaces.css'

/** Every workspace the user has, with what each holds and when it was last opened. */
export function WorkspacesPage() {
  const { t, locale, formatDate } = useI18n()
  const { navigate } = useRouter()
  const workspaces = useWorkspaces()
  const { refresh } = workspaces
  const { push } = useToast()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Workspace | null>(null)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const [clock, setClock] = useState(Date.now)
  const pageRef = useRef<HTMLDivElement>(null)
  useRevealOnView(pageRef)
  // The counts on this page are its point, so they are read afresh.
  useEffect(() => { void refresh().catch(() => undefined) }, [refresh])
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])
  const togglePin = async (item: Workspace) => {
    try {
      await workspaces.pin(item.id, !item.pinnedAt)
      push({ tone: 'success', title: t(item.pinnedAt ? 'Unpinned {name}' : 'Pinned {name} to the top', { name: workspaces.name(item) }) })
    } catch (caught) { push({ tone: 'error', title: t(item.pinnedAt ? 'Couldn’t unpin workspace' : 'Couldn’t pin workspace'), message: errorMessage(caught) }) }
  }
  return <div ref={pageRef} className="workspaces-page">
    <header className="workspaces-page__header">
      <div><h1 className="sr-only">{t('Workspaces')}</h1><p>{workspaces.status === 'ready' && t(workspaces.items.length === 1 ? '{count} workspace' : '{count} workspaces', { count: workspaces.items.length })}</p></div>
      <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{t('New workspace')}</Button>
    </header>
    <LoadingState loading={workspaces.status === 'loading'} fill size={200} label={t('Loading workspaces')}>
      {workspaces.status === 'error' ? <div className="load-error" role="alert"><Icon name="warning" size={26} /><div><h3>{t('Workspaces couldn’t be loaded')}</h3></div><Button onClick={() => void refresh()}>{t('Try again')}</Button></div>
        : <ul className="workspace-list" aria-label={t('Workspaces')}>{workspaces.ordered.map(item => <li key={item.id} className="workspace-row" data-pinned={item.pinnedAt ? '' : undefined} data-tl-reveal="">
          <Link className="workspace-row__link" href={`/workspaces/${item.id}`}><span className="workspace-row__symbol"><Icon name={workspaceIcon(item)} size={18} /></span><span className="workspace-row__name" dir="auto">{workspaces.name(item)}</span>{item.pinnedAt ? <span className="workspace-row__pinned" title={t('Pinned')}><Icon name="pin" size={14} /><span className="sr-only">{t('Pinned')}</span></span> : null}</Link>
          <span className="workspace-row__count">{t(item.sessionCount === 1 ? '{count} session' : '{count} sessions', { count: item.sessionCount })}</span>
          <time className="workspace-row__used" dateTime={item.lastUsedAt} title={formatDate(item.lastUsedAt)}>{t(relativeTime(item.lastUsedAt, clock, locale))}</time>
          <Menu placement="bottom-end" trigger={<Button variant="ghost" size="sm" icon="more" iconOnly aria-label={t('Actions for {name}', { name: workspaces.name(item) })} />}>
            <MenuItem icon={<Icon name="pin" size={16} />} onSelect={() => void togglePin(item)}>{item.pinnedAt ? t('Unpin') : t('Pin to the top')}</MenuItem>
            <MenuItem icon={<Icon name="edit" size={16} />} onSelect={() => setEditing(item)}>{t('Edit workspace')}</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Icon name="trash" size={16} />} destructive onSelect={() => setDeleting(item)}>{t('Delete workspace')}</MenuItem>
          </Menu>
        </li>)}</ul>}
    </LoadingState>
    <WorkspaceDialog open={creating} onClose={() => setCreating(false)} onSaved={(created) => navigate(`/workspaces/${created.id}`)} />
    <WorkspaceDialog open={Boolean(editing)} workspace={editing ?? undefined} onClose={() => setEditing(null)} />
    <DeleteWorkspaceDialog workspace={deleting} onClose={() => setDeleting(null)} />
  </div>
}
