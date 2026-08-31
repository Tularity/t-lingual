import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { CreateSessionInput, InterpretationSession, InterpretationStatus } from '../../api/contracts'
import { Button, Card, Dialog, EmptyState, Icon, Input, PageHeader, Select, Skeleton, useToast } from '../../design-system'
import { Link, useRouter } from '../../app/router'
import { errorMessage, formatDate, formatDuration, languageName, languages } from '../../app/utils'
import { readBrowserStorage, writeBrowserStorage } from '../../platform/storage'
import { StatusBadge } from './StatusBadge'
import './sessions.css'

const pageSize = 200
function duration(session: InterpretationSession) { return session.startedAt && session.endedAt ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() : 0 }
function SessionSkeleton({ view }: { view: 'grid' | 'list' }) { return <div className={`session-results session-results--${view}`} role="status" aria-label="Loading sessions">{Array.from({ length: view === 'grid' ? 6 : 4 }, (_, index) => <Card className="session-skeleton" key={index}><div><Skeleton width="58%" height={20} /><Skeleton width="32%" height={12} /></div><Skeleton width="90%" height={14} /><Skeleton width="68%" height={14} /></Card>)}</div> }
const initialCreate: CreateSessionInput = { title: '', sourceLanguage: 'en', targetLanguage: 'zh-Hans' }

export function SessionsPage({ historyOnly = false }: { historyOnly?: boolean }) {
  const { navigate } = useRouter(); const { push } = useToast()
  const [items, setItems] = useState<InterpretationSession[]>([])
  const [statusSelection, setStatusSelection] = useState<{ historyOnly: boolean; value: InterpretationStatus | 'all' }>(() => ({ historyOnly, value: 'all' }))
  const statusView = statusSelection.historyOnly === historyOnly ? statusSelection.value : 'all'
  const [query, setQuery] = useState(''); const deferredQuery = useDeferredValue(query)
  const [view, setView] = useState<'grid' | 'list'>(() => readBrowserStorage('local', 't-lingual:session-view') === 'list' ? 'list' : 'grid')
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('')
  const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false)
  const [createOpen, setCreateOpen] = useState(false); const [createInput, setCreateInput] = useState(initialCreate); const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<InterpretationSession | null>(null); const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([api.sessions.list({ limit: pageSize }), api.settings.get().catch(() => null)]).then(([response, preferences]) => {
      if (!active) return; setItems(response.items); setHasMore(response.items.length === response.limit)
      if (preferences) setCreateInput((current) => ({ ...current, sourceLanguage: preferences.defaultSourceLanguage, targetLanguage: preferences.defaultTargetLanguage }))
    }).catch((caught) => { if (active) setLoadError(errorMessage(caught)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  const scopedItems = useMemo(() => historyOnly ? items.filter((item) => item.status === 'completed' || item.status === 'failed') : items, [historyOnly, items])
  const visible = useMemo(() => {
    const search = deferredQuery.trim().toLocaleLowerCase()
    return scopedItems.filter((item) => {
      if (statusView !== 'all' && item.status !== statusView) return false
      return !search || item.title.toLocaleLowerCase().includes(search)
    })
  }, [deferredQuery, scopedItems, statusView])
  const reload = () => { setLoading(true); api.sessions.list({ limit: pageSize }).then((response) => { setItems(response.items); setHasMore(response.items.length === response.limit); setLoadError('') }).catch((caught) => setLoadError(errorMessage(caught))).finally(() => setLoading(false)) }
  const loadMore = async () => {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const response = await api.sessions.list({ limit: pageSize, offset: items.length })
      setItems((current) => [...current, ...response.items])
      setHasMore(response.items.length === response.limit)
    } catch (caught) { push({ tone: 'error', title: 'More sessions could not be loaded', message: errorMessage(caught) }) }
    finally { setLoadingMore(false) }
  }
  const changeView = (next: 'grid' | 'list') => { setView(next); writeBrowserStorage('local', 't-lingual:session-view', next) }
  const submitCreate = async (event: FormEvent) => {
    event.preventDefault(); setCreating(true)
    try { const created = await api.sessions.create({ ...createInput, title: createInput.title.trim() || 'Untitled interpretation' }); setCreateOpen(false); setCreateInput((current) => ({ ...initialCreate, sourceLanguage: current.sourceLanguage, targetLanguage: current.targetLanguage })); push({ tone: 'success', title: 'Session created', message: 'Microphone access starts only after you press Start.' }); navigate(`/live/${created.id}`) }
    catch (caught) { push({ tone: 'error', title: 'Couldn’t create session', message: errorMessage(caught) }) }
    finally { setCreating(false) }
  }
  const remove = async () => {
    if (!deleteTarget) return; setDeleting(true)
    try { await api.sessions.remove(deleteTarget.id); setItems((current) => current.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(null); push({ tone: 'success', title: 'Session deleted' }) }
    catch (caught) { push({ tone: 'error', title: 'Couldn’t delete session', message: errorMessage(caught) }) }
    finally { setDeleting(false) }
  }
  const viewOptions: Array<{ value: InterpretationStatus | 'all'; label: string; icon: 'home' | 'microphone' | 'check' | 'warning' | 'wave' }> = historyOnly ? [{ value: 'all', label: 'All history', icon: 'home' }, { value: 'completed', label: 'Completed', icon: 'check' }, { value: 'failed', label: 'Interrupted', icon: 'warning' }] : [{ value: 'all', label: 'All sessions', icon: 'home' }, { value: 'created', label: 'Ready', icon: 'wave' }, { value: 'live', label: 'Live', icon: 'microphone' }, { value: 'completed', label: 'Completed', icon: 'check' }]

  return <>
    <PageHeader eyebrow={historyOnly ? 'Archive' : 'Your workspace'} title={historyOnly ? 'Interpretation history' : 'Sessions'} description={historyOnly ? 'Review completed source transcripts and translations from your workspace.' : 'Start a live interpretation or return to a conversation in your private workspace.'} actions={<Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>New interpretation</Button>} />
    <div className="sessions-layout"><aside className="folder-panel" aria-label="Session views"><p className="folder-panel__label">Views</p>{viewOptions.map((option) => <button key={option.value} type="button" className="folder-link" data-active={statusView === option.value || undefined} aria-pressed={statusView === option.value} onClick={() => setStatusSelection({ historyOnly, value: option.value })}><Icon name={option.icon} size={17} /><span>{option.label}</span><small>{option.value === 'all' ? scopedItems.length : scopedItems.filter((item) => item.status === option.value).length}</small></button>)}</aside><section className="sessions-content" aria-label="Sessions" aria-busy={loading || loadingMore}>
      <div className="session-toolbar"><div className="session-search"><Input dir="auto" label="Search sessions" icon="search" placeholder="Search session titles…" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="sr-only" aria-live="polite">{!loading && `${visible.length} ${visible.length === 1 ? 'result' : 'results'}`}</span></div><div className="view-toggle" role="group" aria-label="View options"><Button variant={view === 'grid' ? 'secondary' : 'ghost'} icon="grid" iconOnly size="sm" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => changeView('grid')} /><Button variant={view === 'list' ? 'secondary' : 'ghost'} icon="list" iconOnly size="sm" aria-label="List view" aria-pressed={view === 'list'} onClick={() => changeView('list')} /></div></div>
      {loading ? <SessionSkeleton view={view} /> : loadError ? <Card className="load-error"><Icon name="warning" size={26} /><div><h3>Sessions couldn’t be loaded</h3><p dir="auto">{loadError}</p></div><Button onClick={reload}>Try again</Button></Card> : visible.length === 0 ? <Card><EmptyState icon={query ? 'search' : 'wave'} title={query ? 'No matching sessions' : historyOnly ? 'No history yet' : 'Your first conversation starts here'} description={query ? 'Try a broader title search or choose another view.' : historyOnly ? 'Completed and interrupted sessions will appear here.' : 'Create a session, select your languages and start speaking when ready.'} action={!query && !historyOnly && <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>Create session</Button>} /></Card> : <div className={`session-results session-results--${view}`}>{visible.map((session) => <Card key={session.id} interactive className="session-card"><Link className="session-card__link" href={session.status === 'created' || session.status === 'live' ? `/live/${session.id}` : `/history/${session.id}`}><div className="session-card__title"><span className="session-card__symbol"><Icon name={session.status === 'live' ? 'microphone' : 'wave'} size={20} /></span><div><h2 dir="auto">{session.title}</h2><p>{formatDate(session.updatedAt)}</p></div></div><p className="session-card__preview">{session.status === 'created' ? 'No transcript yet. This session is ready to begin.' : session.status === 'live' ? 'Interpretation is currently in progress.' : 'Open the persisted transcript and translation history.'}</p><div className="session-card__meta"><span>{languageName(session.sourceLanguage)} <Icon name="arrowRight" size={13} /> {languageName(session.targetLanguage)}</span><span>{formatDuration(duration(session))}</span></div></Link><div className="session-card__top"><StatusBadge status={session.status} /><Button variant="ghost" size="sm" icon="trash" iconOnly aria-label={`Delete ${session.title}`} disabled={session.status === 'live'} onClick={() => setDeleteTarget(session)} /></div></Card>)}</div>}
      {!loading && !loadError && hasMore && <div className="session-load-more"><Button loading={loadingMore} onClick={() => void loadMore()}>Load more sessions</Button></div>}
    </section></div>
    <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} title="New interpretation" description="Nothing is streamed until you explicitly start the microphone." footer={<><Button onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button><Button type="submit" form="create-session" variant="primary" loading={creating}>Create and continue</Button></>}><form id="create-session" className="create-session-form" aria-busy={creating} onSubmit={(event) => void submitCreate(event)}><Input dir="auto" autoFocus disabled={creating} label="Session title" optional placeholder="Untitled interpretation" maxLength={120} value={createInput.title} onChange={(event) => setCreateInput({ ...createInput, title: event.target.value })} /><div className="create-session-form__languages"><Select disabled={creating} label="Spoken language" value={createInput.sourceLanguage} onChange={(event) => { const sourceLanguage = event.target.value; const targetLanguage = sourceLanguage === createInput.targetLanguage ? languages.find((language) => language.code !== sourceLanguage)?.code ?? 'en' : createInput.targetLanguage; setCreateInput({ ...createInput, sourceLanguage, targetLanguage }) }}><option value="auto">Detect automatically</option>{languages.map((language) => <option value={language.code} key={language.code}>{language.label}</option>)}</Select><Select disabled={creating} label="Translate to" value={createInput.targetLanguage} onChange={(event) => setCreateInput({ ...createInput, targetLanguage: event.target.value })}>{languages.filter((language) => language.code !== createInput.sourceLanguage).map((language) => <option value={language.code} key={language.code}>{language.label}</option>)}</Select></div></form></Dialog>
    <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)} title="Delete this session?" description="This permanently removes the transcript and translation from your workspace." footer={<><Button onClick={() => setDeleteTarget(null)} disabled={deleting}>Keep session</Button><Button variant="danger" icon="trash" loading={deleting} onClick={() => void remove()}>Delete session</Button></>}><div className="delete-summary"><Icon name="warning" size={21} /><div><strong dir="auto">{deleteTarget?.title}</strong><span>{deleteTarget && formatDate(deleteTarget.createdAt)}</span></div></div></Dialog>
  </>
}
