import { useI18n } from '../../app/i18n'
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { CreateSessionInput, InterpretationSession, InterpretationStatus, Workspace } from '../../api/contracts'
import { Button, Dialog, EmptyState, Icon, Input, LoadingState, useToast } from '../../design-system'
import { Link, useRouter } from '../../app/router'
import { errorMessage, formatDuration, languageName, relativeTime } from '../../app/utils'
import { usePageWorkspace, useWorkspaces } from '../../app/workspaces'
import { DeleteWorkspaceDialog, MoveSessionDialog, WorkspaceDialog } from '../workspaces/WorkspaceDialogs'
import { readBrowserStorage, writeBrowserStorage } from '../../platform/storage'
import { RecognitionSetup } from './RecognitionSetup'
import { StatusBadge } from './StatusBadge'
import { LanguageFlag, languageDisplayName } from '../languages'
import { CompactMark, Menu, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, useEventCallback, useFlip, useRevealOnView } from '@t-lingual/ui'
import './sessions.css'
import { notifyStorageChanged } from '../../app/storageEvents'
import { useAccountStorage } from '../../app/accountStorage'

const pageSize = 200
/** Cards are shown a few at a time: another batch joins whenever the end of
 *  the list comes into view, so a long list never renders all at once. The
 *  whole page of data is still loaded, so search, sorting and counts see it. */
const cardBatch = 6
function duration(session: InterpretationSession) { return session.startedAt && session.endedAt ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() : 0 }
function SessionLanguages({ session }: { session: InterpretationSession }) {
  const sources = session.recognitionLanguages?.length ? session.recognitionLanguages : [session.sourceLanguage]
  return <span className="session-card__language">{sources.map(code => <LanguageFlag key={code} code={code} />)}<Icon name="arrowRight" size={12} /><LanguageFlag code={session.targetLanguage} kind="target" /></span>
}

const initialCreate: CreateSessionInput = { title: '', sourceLanguage: 'auto', recognitionLanguages: [], diarization: true }
type SessionView = InterpretationStatus | 'archived' | 'all'
/** What a sessions list shows: one of the user's workspaces, or what others have shared with them. */
export type SessionScope = { workspaceId: string } | { shared: true }

export function SessionsPage({ scope }: { scope: SessionScope }) {
  const {t,locale,formatDate}=useI18n()

  const { navigate } = useRouter(); const { push } = useToast()
  const workspaces = useWorkspaces()
  // A full storage allows no new session, as it allows no recording.
  const { quotaFull } = useAccountStorage()
  const workspaceId = 'workspaceId' in scope ? scope.workspaceId : ''
  const workspace = workspaces.find(workspaceId)
  const togglePin = async (target: Workspace) => {
    try {
      await workspaces.pin(target.id, !target.pinnedAt)
      push({ tone: 'success', title: t(target.pinnedAt ? 'Unpinned {name}' : 'Pinned {name} to the top', { name: workspaces.name(target) }) })
    } catch (caught) { push({ tone: 'error', title: t(target.pinnedAt ? 'Couldn’t unpin workspace' : 'Couldn’t pin workspace'), message: errorMessage(caught) }) }
  }
  // Opening a workspace is what keeps it in the sidebar.
  const { use: markUsed } = workspaces
  useEffect(() => { if (workspaceId) markUsed(workspaceId) }, [workspaceId, markUsed])
  usePageWorkspace(workspaceId ? { id: workspaceId } : { shared: true })
  const [workspaceAction, setWorkspaceAction] = useState<'edit' | 'delete' | null>(null)
  const [moveTarget, setMoveTarget] = useState<InterpretationSession | null>(null)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])
  const [items, setItems] = useState<InterpretationSession[]>([])
  const [statusView, setStatusView] = useState<SessionView>('all')
  const resultsRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(''); const deferredQuery = useDeferredValue(query)
  const [sort, setSort] = useState<'recent' | 'oldest' | 'title' | 'duration'>('recent')
  const [view, setView] = useState<'grid' | 'list'>(() => readBrowserStorage('local', 't-lingual:session-view') === 'list' ? 'list' : 'grid')
  // A new view of the list starts at its top — before the cards are measured
  // for their moves, so they move to where they will be seen.
  useLayoutEffect(() => { if (resultsRef.current) resultsRef.current.scrollTop = 0 }, [deferredQuery, statusView, view])
  // Changing the category, the order or the layout moves the cards in view to
  // their new places; cards that come into view fade in after them.
  const flip = useFlip(resultsRef)
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('')
  const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false); const [moreFailed, setMoreFailed] = useState(false)
  const [createOpen, setCreateOpen] = useState(false); const [createInput, setCreateInput] = useState<CreateSessionInput>(() => api.mode === 'mock' ? { ...initialCreate, sourceLanguage: 'auto', recognitionLanguages: [], diarization: true } : initialCreate); const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<InterpretationSession | null>(null); const [deleting, setDeleting] = useState(false)
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null)

  // The server lists only this scope; it never sends another account's workspace.
  const listQuery = useMemo(() => workspaceId ? { workspace: workspaceId } : { shared: true }, [workspaceId])
  useEffect(() => {
    let active = true
    Promise.all([api.sessions.list({ ...listQuery, limit: pageSize }), api.settings.get().catch(() => null)]).then(([response, preferences]) => {
      if (!active) return; setItems(response.items); setHasMore(response.items.length === response.limit)
      if (preferences && api.mode !== 'mock') setCreateInput((current) => ({ ...current, sourceLanguage: preferences.defaultSourceLanguage, recognitionLanguages: preferences.defaultSourceLanguage === 'auto' ? [] : [preferences.defaultSourceLanguage] }))
    }).catch((caught) => { if (active) setLoadError(errorMessage(caught)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [listQuery])
  useEffect(() => {
    let active = true
    const refreshOnFocus = () => {
      void api.sessions.list({ ...listQuery, limit: pageSize }).then((response) => {
        if (!active) return
        setItems((current) => {
          if (response.items.length < pageSize) return response.items
          const refreshedIds = new Set(response.items.map((item) => item.id))
          return [...response.items, ...current.slice(pageSize).filter((item) => !refreshedIds.has(item.id))]
        })
        if (response.items.length < pageSize) setHasMore(false)
      }).catch(() => undefined)
    }
    window.addEventListener('focus', refreshOnFocus)
    return () => { active = false; window.removeEventListener('focus', refreshOnFocus) }
  }, [listQuery])
  const scopedItems = items
  const visible = useMemo(() => {
    const search = deferredQuery.trim().toLocaleLowerCase()
    const matching = scopedItems.filter((item) => {
      if (statusView === 'archived' && !item.archivedAt) return false
      if (statusView !== 'all' && statusView !== 'archived' && (item.archivedAt || item.status !== statusView)) return false
      return !search || `${item.title} ${[...(item.recognitionLanguages?.length?item.recognitionLanguages:[item.sourceLanguage]),item.targetLanguage].map(code=>`${languageName(code)} ${t(languageDisplayName(code,locale))}`).join(' ')}`.toLocaleLowerCase().includes(search)
    })
    return matching.sort((left, right) => sort === 'title' ? left.title.localeCompare(right.title) : sort === 'duration' ? duration(right) - duration(left) : sort === 'oldest' ? new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime() : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  }, [deferredQuery, scopedItems, sort, statusView,locale,t])
  const reload = () => { setLoading(true); api.sessions.list({ ...listQuery, limit: pageSize }).then((response) => { setItems(response.items); setHasMore(response.items.length === response.limit); setLoadError('') }).catch((caught) => setLoadError(errorMessage(caught))).finally(() => setLoading(false)) }
  const loadMore = useEventCallback(async () => {
    if (!hasMore || loadingMore) return
    setLoadingMore(true); setMoreFailed(false)
    try {
      const response = await api.sessions.list({ ...listQuery, limit: pageSize, offset: items.length })
      setItems((current) => [...current, ...response.items])
      setHasMore(response.items.length === response.limit)
    } catch (caught) { setMoreFailed(true); push({ tone: 'error', title: t("More sessions could not be loaded"), message: errorMessage(caught) }) }
    finally { setLoadingMore(false) }
  })
  // The shown batches start over whenever what the list shows changes.
  const listKey = `${deferredQuery}|${statusView}|${sort}|${view}`
  const [batches, setBatches] = useState({ key: listKey, count: cardBatch })
  if (batches.key !== listKey) setBatches({ key: listKey, count: cardBatch })
  const shownCount = batches.key === listKey ? batches.count : cardBatch
  const moreToShow = shownCount < visible.length
  // Reaching the end of the list brings in the next batch — or, when every
  // loaded card is out, the next page from the server. Re-observed after each
  // change, so a screen that still has room keeps filling.
  const listEnd = useRef<HTMLDivElement>(null)
  const reachEnd = useEventCallback(() => {
    if (moreToShow) setBatches((current) => ({ ...current, count: current.count + cardBatch }))
    else if (hasMore && !moreFailed) void loadMore()
  })
  useEffect(() => {
    const end = listEnd.current
    if (!end || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) reachEnd() }, { rootMargin: '0px 0px 120px 0px' })
    observer.observe(end)
    return () => observer.disconnect()
  }, [reachEnd, shownCount, visible.length, hasMore, loadingMore, moreFailed])
  // Cards fade in one after another as they come into view.
  useRevealOnView(resultsRef)
  const changeView = (next: 'grid' | 'list') => { flip.capture(); setView(next); writeBrowserStorage('local', 't-lingual:session-view', next) }
  const changeSort = (next: typeof sort) => { flip.capture(); setSort(next) }
  const changeStatus = (next: SessionView) => { flip.capture(); setStatusView(next) }
  const submitCreate = async (event: FormEvent) => {
    event.preventDefault(); setCreating(true)
    try { const created = await api.sessions.create({ ...createInput, diarization:true, title: createInput.title.trim() || 'Untitled interpretation', workspaceId: workspaceId || undefined }); setCreateOpen(false); setCreateInput(current => ({ ...current, title: '' })); push({ tone: 'success', title: t("Session created"), message: t("Microphone access starts only after you press Start.") }); navigate(`/live/${created.id}`) }
    catch (caught) { notifyStorageChanged(); push({ tone: 'error', title: t("Couldn’t create session"), message: t(errorMessage(caught)) }) }
    finally { setCreating(false) }
  }
  const remove = async () => {
    if (!deleteTarget) return; setDeleting(true)
    try { await api.sessions.remove(deleteTarget.id); setItems((current) => current.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(null); notifyStorageChanged(); push({ tone: 'success', title: t("Session deleted") }) }
    catch (caught) { push({ tone: 'error', title: t("Couldn’t delete session"), message: errorMessage(caught) }) }
    finally { setDeleting(false) }
  }
  const changeArchive = async (session: InterpretationSession) => {
    if (archiveBusyId || session.status === 'live') return
    setArchiveBusyId(session.id)
    try {
      const updated = session.archivedAt ? await api.sessions.unarchive(session.id) : await api.sessions.archive(session.id)
      setItems((current) => current.map((item) => item.id === session.id ? updated : item))
      push({ tone: 'success', title: session.archivedAt ? t("Session restored") : t("Session archived") })
    } catch (caught) { push({ tone: 'error', title: session.archivedAt ? t("Couldn’t restore session") : t("Couldn’t archive session"), message: errorMessage(caught) }) }
    finally { setArchiveBusyId(null) }
  }
  const viewOptions: Array<{ value: SessionView; label: string; icon: 'home' | 'microphone' | 'check' | 'warning' | 'wave' | 'folder' }> = [{ value: 'all', label: t("All sessions"), icon: 'home' }, { value: 'created', label: t("Ready"), icon: 'wave' }, { value: 'live', label: t("Live"), icon: 'microphone' }, { value: 'completed', label: t("Saved"), icon: 'check' }, { value: 'failed', label: t("Interrupted"), icon: 'warning' }, { value: 'archived', label: t("Archived"), icon: 'folder' }]
  const counts = { all: scopedItems.length, created: scopedItems.filter((item) => !item.archivedAt && item.status === 'created').length, live: scopedItems.filter((item) => !item.archivedAt && item.status === 'live').length, completed: scopedItems.filter((item) => !item.archivedAt && item.status === 'completed').length, failed: scopedItems.filter((item) => !item.archivedAt && item.status === 'failed').length, archived: scopedItems.filter((item) => !!item.archivedAt).length }
  const sessionHref = (session: InterpretationSession) => session.isOwner === false ? `/live/${session.id}` : !session.archivedAt && (session.status === 'created' || session.status === 'live') ? `/live/${session.id}` : `/sessions/${session.id}`
  const renderSession = (session: InterpretationSession) => <article key={session.id} className="session-card" data-tl-reveal="" data-tl-flip={session.id}>
    <header className="session-card__top"><StatusBadge status={session.status} archivedAt={session.archivedAt} />{session.isOwner !== false && <Menu trigger={<Button variant="ghost" size="sm" icon="more" iconOnly aria-label={`Actions for ${session.title}`} />} placement="bottom-end">{workspaces.items.length > 1 && <MenuItem icon={<Icon name="arrowRight" size={16} />} disabled={session.status === 'live'} onSelect={() => setMoveTarget(session)}>{t("Move to another workspace")}</MenuItem>}<MenuItem icon={<Icon name={session.archivedAt ? 'play' : 'folder'} size={16} />} disabled={session.status === 'live' || !!archiveBusyId} onSelect={() => void changeArchive(session)}>{session.archivedAt ? t("Unarchive session") : t("Archive session")}</MenuItem><MenuSeparator /><MenuItem icon={<Icon name="trash" size={16} />} destructive disabled={session.status === 'live' || !!archiveBusyId} onSelect={() => setDeleteTarget(session)}>{t("Delete session")}</MenuItem></Menu>}</header>
    <Link className="session-card__link" href={sessionHref(session)}><span className="session-card__symbol"><Icon name={session.archivedAt ? 'folder' : session.status === 'live' ? 'microphone' : 'wave'} size={18} /></span><h2 dir="auto" title={session.title}>{session.title}</h2></Link>
    <div className="session-card__meta"><SessionLanguages session={session} />{duration(session) > 0 && <span className="session-card__duration" title={t("Conversation duration")}>{formatDuration(duration(session))}</span>}<time className="session-card__updated" dateTime={session.updatedAt} title={formatDate(session.updatedAt)}>{t(relativeTime(session.updatedAt, clock,locale))}</time></div>
  </article>

  return <div className="sessions-page">
    <h1 className="sr-only">{workspaceId ? workspaces.name(workspace) : t("Shared with you")}</h1>
    <div className="sessions-layout"><section className="sessions-content" aria-label={t("Sessions")} aria-busy={loading || loadingMore}>
      <div className="session-toolbar"><div className="session-search"><Input dir="auto" label={t("Search sessions")} icon="search" placeholder={t("Search title or language…")} value={query} onChange={(event) => setQuery(event.target.value)} /><span className="sr-only" aria-live="polite">{!loading && t(visible.length===1?'{count} result':'{count} results',{count:visible.length})}</span></div><div className="session-toolbar__right"><Menu aria-label={t("View options")} placement="bottom-end" trigger={<Button className="session-view-menu" variant="secondary" icon="columns" iconOnly aria-label={t("View options")} title={t("View options")} />}>
        <MenuGroup label={t("Sort by")}><MenuRadioGroup value={sort} onValueChange={(value) => changeSort(value as typeof sort)}><MenuRadioItem value="recent">{t("Recently updated")}</MenuRadioItem><MenuRadioItem value="oldest">{t("Oldest first")}</MenuRadioItem><MenuRadioItem value="title">{t("Title A–Z")}</MenuRadioItem><MenuRadioItem value="duration">{t("Longest first")}</MenuRadioItem></MenuRadioGroup></MenuGroup>
        <MenuSeparator />
        <MenuGroup label={t("Layout")}><MenuRadioGroup value={view} onValueChange={(value) => changeView(value as typeof view)}><MenuRadioItem value="grid" icon={<Icon name="grid" size={16} />}>{t("Grid view")}</MenuRadioItem><MenuRadioItem value="list" icon={<Icon name="list" size={16} />}>{t("List view")}</MenuRadioItem></MenuRadioGroup></MenuGroup>
      </Menu>{workspaceId && <Menu aria-label={t("Workspace options")} placement="bottom-end" trigger={<Button variant="secondary" icon="more" iconOnly aria-label={t("Workspace options")} title={t("Workspace options")} />}>
        {workspace && <MenuItem icon={<Icon name="pin" size={16} />} onSelect={() => void togglePin(workspace)}>{workspace.pinnedAt ? t('Unpin') : t('Pin to the top')}</MenuItem>}
        <MenuItem icon={<Icon name="edit" size={16} />} onSelect={() => setWorkspaceAction('edit')}>{t("Edit workspace")}</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Icon name="trash" size={16} />} destructive onSelect={() => setWorkspaceAction('delete')}>{t("Delete workspace")}</MenuItem>
      </Menu>}{workspaceId && <Button className="session-create" variant="primary" icon="plus" aria-label={t("New interpretation")} disabled={quotaFull} title={quotaFull ? t('Your storage is full') : undefined} onClick={() => setCreateOpen(true)}><span className="session-create__full">{t("New interpretation")}</span><span className="session-create__short">{t("New")}</span></Button>}</div></div>
      {quotaFull && workspaceId ? <div className="storage-full-notice" role="status"><Icon name="database" size={17} /><span>{t('Your storage is full, so you can’t create sessions or record in yours. Delete sessions you no longer need to make room.')}</span><Link href="/usage">{t('See your usage')}</Link></div> : null}
      <nav className="folder-panel" aria-label={t("Session views")}>{viewOptions.map((option) => <button key={option.value} type="button" className="folder-link" data-active={statusView === option.value || undefined} aria-pressed={statusView === option.value} onClick={() => changeStatus(option.value)}><Icon name={option.icon} size={17} /><span>{t(option.label)}</span><small>{loading ? '—' : counts[option.value]}</small></button>)}</nav>
      <div ref={resultsRef} className="session-results-scroll" role="region" aria-label={t("Session results")} tabIndex={0}>
      <LoadingState loading={loading} fill size={200} label={t("Loading sessions")}>{loading ? null : loadError ? <div className="load-error" role="alert"><Icon name="warning" size={26} /><div><h3>{t("Sessions couldn’t be loaded")}</h3><p dir="auto">{t(loadError)}</p></div><Button onClick={reload}>{t("Try again")}</Button></div> : visible.length === 0 ? <div className="session-empty"><EmptyState icon={query ? 'search' : 'wave'} title={query || statusView !== 'all' ? t("No matching sessions") : !workspaceId ? t("Nothing shared with you yet") : t("Your first conversation starts here")} description={query || statusView !== 'all' ? t("Try another search or choose a different view.") : !workspaceId ? t("Sessions others share with you appear here.") : t("Create a session, select your languages and start speaking when ready.")} action={query || statusView !== 'all' ? <Button onClick={() => { setQuery(''); setStatusView('all') }}>{t("Clear filters")}</Button> : workspaceId && <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>{t("Create session")}</Button>} /></div> : <div className={`session-results session-results--${view}`}>{visible.slice(0, shownCount).map(renderSession)}</div>}</LoadingState>
      {!loading && !loadError && (moreToShow || hasMore) && <div ref={listEnd} className="session-more" role="status">{moreFailed ? <Button icon="refresh" onClick={() => void loadMore()}>{t("Try again")}</Button> : <><CompactMark size={16} tone="inherit" motion="wave" /><span>{t("Loading more sessions")}</span></>}</div>}
      </div>
    </section></div>
    <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} title={t("New interpretation")} description={api.mode === 'mock' ? t("Demo conversations use prepared speech in seven supported languages.") : t("Choose the languages you expect to hear and how you want to follow the conversation.")} footer={<><Button onClick={() => setCreateOpen(false)} disabled={creating}>{t("Cancel")}</Button><Button type="submit" form="create-session" variant="primary" loading={creating}>{t("Create and continue")}</Button></>}><form id="create-session" className="create-session-form" aria-busy={creating} onSubmit={(event) => void submitCreate(event)}><Input dir="auto" autoFocus disabled={creating} label={t("Session title")} optional placeholder={t("e.g. Product discussion")} maxLength={120} value={createInput.title} onChange={(event) => setCreateInput({ ...createInput, title: event.target.value })} /><RecognitionSetup value={createInput} onChange={setCreateInput} disabled={creating} /><p className="create-session-form__note"><Icon name="shield" size={15} />{t("Private until you choose to share it.")}</p></form></Dialog>
    <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)} title={t("Delete this session?")} description={t("This permanently removes the transcript and translation from your workspace.")} footer={<><Button onClick={() => setDeleteTarget(null)} disabled={deleting}>{t("Keep session")}</Button><Button variant="danger" icon="trash" loading={deleting} onClick={() => void remove()}>{t("Delete session")}</Button></>}><div className="delete-summary"><Icon name="warning" size={21} /><div><strong dir="auto">{deleteTarget?.title}</strong><span>{deleteTarget && formatDate(deleteTarget.createdAt)}</span></div></div></Dialog>
    <MoveSessionDialog session={moveTarget} onClose={() => setMoveTarget(null)} onMoved={(moved) => setItems((current) => current.filter((item) => item.id !== moved.id))} />
    {workspace && <WorkspaceDialog open={workspaceAction === 'edit'} workspace={workspace} onClose={() => setWorkspaceAction(null)} />}
    <DeleteWorkspaceDialog workspace={workspaceAction === 'delete' ? workspace ?? null : null} onClose={() => setWorkspaceAction(null)} onDeleted={(movedTo) => { const next = movedTo ?? workspaces.items.find((item) => item.id !== workspaceId)?.id; if (next) navigate(`/workspaces/${next}`, { replace: true }) }} />
  </div>
}
