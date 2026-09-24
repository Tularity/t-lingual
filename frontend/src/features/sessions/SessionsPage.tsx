import { useI18n } from '../../app/i18n'
import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { CreateSessionInput, InterpretationSession, InterpretationStatus } from '../../api/contracts'
import { Button, Card, Dialog, EmptyState, Icon, Input, Skeleton, useToast } from '../../design-system'
import { Link, useRouter } from '../../app/router'
import { errorMessage, formatDuration, languageName } from '../../app/utils'
import { readBrowserStorage, writeBrowserStorage } from '../../platform/storage'
import { RecognitionSetup } from './RecognitionSetup'
import { StatusBadge } from './StatusBadge'
import { LanguageFlag, languageDisplayName } from '../languages'
import { Menu, MenuItem, MenuSeparator } from '@t-lingual/ui'
import './sessions.css'

const pageSize = 200
function duration(session: InterpretationSession) { return session.startedAt && session.endedAt ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() : 0 }
function SessionLanguages({ session }: { session: InterpretationSession }) {
  const sources = session.recognitionLanguages?.length ? session.recognitionLanguages : [session.sourceLanguage]
  return <span className="session-card__language">{sources.map(code => <LanguageFlag key={code} code={code} />)}<Icon name="arrowRight" size={12} /><LanguageFlag code={session.targetLanguage} kind="target" /></span>
}
function relativeTime(timestamp: string, now: number, locale='en') {
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000))
  if (seconds < 60) return 'Just now'
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' })
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86400) return format.format(-Math.floor(seconds / 3600), 'hour')
  return format.format(-Math.floor(seconds / 86400), 'day')
}

function SessionSkeleton({ view }: { view: 'grid' | 'list' }) {
  const {t}=useI18n()
 return <div className={`session-results session-results--${view}`} role="status" aria-label={t("Loading sessions")}>{Array.from({ length: view === 'grid' ? 6 : 4 }, (_, index) => <Card className="session-skeleton" key={index}><div><Skeleton width="58%" height={20} /><Skeleton width="32%" height={12} /></div><Skeleton width="90%" height={14} /><Skeleton width="68%" height={14} /></Card>)}</div> }
const initialCreate: CreateSessionInput = { title: '', sourceLanguage: 'auto', recognitionLanguages: [], diarization: true }
type SessionView = InterpretationStatus | 'archived' | 'all'

export function SessionsPage({ historyOnly = false }: { historyOnly?: boolean }) {
  const {t,locale,formatDate}=useI18n()

  const { navigate } = useRouter(); const { push } = useToast()
  const [clock, setClock] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])
  const [items, setItems] = useState<InterpretationSession[]>([])
  const [statusSelection, setStatusSelection] = useState<{ historyOnly: boolean; value: SessionView }>(() => ({ historyOnly, value: 'all' }))
  const statusView = statusSelection.historyOnly === historyOnly ? statusSelection.value : 'all'
  const resultsRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(''); const deferredQuery = useDeferredValue(query)
  const [sort, setSort] = useState<'recent' | 'oldest' | 'title' | 'duration'>('recent')
  const [view, setView] = useState<'grid' | 'list'>(() => readBrowserStorage('local', 't-lingual:session-view') === 'list' ? 'list' : 'grid')
  useEffect(() => { if (resultsRef.current) resultsRef.current.scrollTop = 0 }, [deferredQuery, statusView, view])
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('')
  const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false)
  const [createOpen, setCreateOpen] = useState(false); const [createInput, setCreateInput] = useState<CreateSessionInput>(() => api.mode === 'mock' ? { ...initialCreate, sourceLanguage: 'auto', recognitionLanguages: [], diarization: true } : initialCreate); const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<InterpretationSession | null>(null); const [deleting, setDeleting] = useState(false)
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([api.sessions.list({ limit: pageSize }), api.settings.get().catch(() => null)]).then(([response, preferences]) => {
      if (!active) return; setItems(response.items); setHasMore(response.items.length === response.limit)
      if (preferences && api.mode !== 'mock') setCreateInput((current) => ({ ...current, sourceLanguage: preferences.defaultSourceLanguage, recognitionLanguages: preferences.defaultSourceLanguage === 'auto' ? [] : [preferences.defaultSourceLanguage] }))
    }).catch((caught) => { if (active) setLoadError(errorMessage(caught)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    const refreshOnFocus = () => {
      void api.sessions.list({ limit: pageSize }).then((response) => {
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
  }, [])
  const scopedItems = useMemo(() => historyOnly ? items.filter((item) => item.archivedAt || item.status === 'completed' || item.status === 'failed') : items, [historyOnly, items])
  const visible = useMemo(() => {
    const search = deferredQuery.trim().toLocaleLowerCase()
    const matching = scopedItems.filter((item) => {
      if (statusView === 'archived' && !item.archivedAt) return false
      if (statusView !== 'all' && statusView !== 'archived' && (item.archivedAt || item.status !== statusView)) return false
      return !search || `${item.title} ${[...(item.recognitionLanguages?.length?item.recognitionLanguages:[item.sourceLanguage]),item.targetLanguage].map(code=>`${languageName(code)} ${t(languageDisplayName(code,locale))}`).join(' ')}`.toLocaleLowerCase().includes(search)
    })
    return matching.sort((left, right) => sort === 'title' ? left.title.localeCompare(right.title) : sort === 'duration' ? duration(right) - duration(left) : sort === 'oldest' ? new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime() : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  }, [deferredQuery, scopedItems, sort, statusView,locale,t])
  const reload = () => { setLoading(true); api.sessions.list({ limit: pageSize }).then((response) => { setItems(response.items); setHasMore(response.items.length === response.limit); setLoadError('') }).catch((caught) => setLoadError(errorMessage(caught))).finally(() => setLoading(false)) }
  const loadMore = async () => {
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const response = await api.sessions.list({ limit: pageSize, offset: items.length })
      setItems((current) => [...current, ...response.items])
      setHasMore(response.items.length === response.limit)
    } catch (caught) { push({ tone: 'error', title: t("More sessions could not be loaded"), message: errorMessage(caught) }) }
    finally { setLoadingMore(false) }
  }
  const changeView = (next: 'grid' | 'list') => { setView(next); writeBrowserStorage('local', 't-lingual:session-view', next) }
  const submitCreate = async (event: FormEvent) => {
    event.preventDefault(); setCreating(true)
    try { const created = await api.sessions.create({ ...createInput, diarization:true, title: createInput.title.trim() || 'Untitled interpretation' }); setCreateOpen(false); setCreateInput(current => ({ ...current, title: '' })); push({ tone: 'success', title: t("Session created"), message: t("Microphone access starts only after you press Start.") }); navigate(`/live/${created.id}`) }
    catch (caught) { push({ tone: 'error', title: t("Couldn’t create session"), message: errorMessage(caught) }) }
    finally { setCreating(false) }
  }
  const remove = async () => {
    if (!deleteTarget) return; setDeleting(true)
    try { await api.sessions.remove(deleteTarget.id); setItems((current) => current.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(null); push({ tone: 'success', title: t("Session deleted") }) }
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
  const viewOptions: Array<{ value: SessionView; label: string; icon: 'home' | 'microphone' | 'check' | 'warning' | 'wave' | 'folder' }> = historyOnly ? [{ value: 'all', label: t("All history"), icon: 'home' }, { value: 'completed', label: t("Saved"), icon: 'check' }, { value: 'failed', label: t("Interrupted"), icon: 'warning' }, { value: 'archived', label: t("Archived"), icon: 'folder' }] : [{ value: 'all', label: t("All sessions"), icon: 'home' }, { value: 'created', label: t("Ready"), icon: 'wave' }, { value: 'live', label: t("Live"), icon: 'microphone' }, { value: 'completed', label: t("Saved"), icon: 'check' }, { value: 'failed', label: t("Interrupted"), icon: 'warning' }, { value: 'archived', label: t("Archived"), icon: 'folder' }]
  const counts = { all: scopedItems.length, created: scopedItems.filter((item) => !item.archivedAt && item.status === 'created').length, live: scopedItems.filter((item) => !item.archivedAt && item.status === 'live').length, completed: scopedItems.filter((item) => !item.archivedAt && item.status === 'completed').length, failed: scopedItems.filter((item) => !item.archivedAt && item.status === 'failed').length, archived: scopedItems.filter((item) => !!item.archivedAt).length }
  const sessionHref = (session: InterpretationSession) => session.isOwner === false ? `/live/${session.id}` : !session.archivedAt && (session.status === 'created' || session.status === 'live') ? `/live/${session.id}` : `/history/${session.id}`
  const renderSession = (session: InterpretationSession) => <article key={session.id} className="session-card">
    <header className="session-card__top"><StatusBadge status={session.status} archivedAt={session.archivedAt} />{session.isOwner !== false && <Menu trigger={<Button variant="ghost" size="sm" icon="more" iconOnly aria-label={`Actions for ${session.title}`} />} placement="bottom-end"><MenuItem icon={<Icon name={session.archivedAt ? 'play' : 'folder'} size={16} />} disabled={session.status === 'live' || !!archiveBusyId} onSelect={() => void changeArchive(session)}>{session.archivedAt ? t("Unarchive session") : t("Archive session")}</MenuItem><MenuSeparator /><MenuItem icon={<Icon name="trash" size={16} />} destructive disabled={session.status === 'live' || !!archiveBusyId} onSelect={() => setDeleteTarget(session)}>{t("Delete session")}</MenuItem></Menu>}</header>
    <Link className="session-card__link" href={sessionHref(session)}><span className="session-card__symbol"><Icon name={session.archivedAt ? 'folder' : session.status === 'live' ? 'microphone' : 'wave'} size={18} /></span><h2 dir="auto" title={session.title}>{session.title}</h2></Link>
    <div className="session-card__meta"><SessionLanguages session={session} />{duration(session) > 0 && <span className="session-card__duration" title={t("Conversation duration")}>{formatDuration(duration(session))}</span>}<time className="session-card__updated" dateTime={session.updatedAt} title={formatDate(session.updatedAt)}>{t(relativeTime(session.updatedAt, clock,locale))}</time></div>
  </article>

  return <div className="sessions-page">
    <h1 className="sr-only">{historyOnly ? t("Interpretation history") : t("Sessions")}</h1>
    <div className="sessions-layout"><section className="sessions-content" aria-label={t("Sessions")} aria-busy={loading || loadingMore}>
      <div className="session-toolbar"><div className="session-search"><Input dir="auto" label={t("Search sessions")} icon="search" placeholder={t("Search title or language…")} value={query} onChange={(event) => setQuery(event.target.value)} /><span className="sr-only" aria-live="polite">{!loading && t(visible.length===1?'{count} result':'{count} results',{count:visible.length})}</span></div><div className="session-toolbar__right"><label className="session-sort"><span>{t("Sort by")}</span><select aria-label={t("Sort sessions")} value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="recent">{t("Recently updated")}</option><option value="oldest">{t("Oldest first")}</option><option value="title">{t("Title A–Z")}</option><option value="duration">{t("Longest first")}</option></select><Icon name="chevronDown" size={15} /></label><div className="view-toggle" role="group" aria-label={t("View options")}><Button variant={view === 'grid' ? 'secondary' : 'ghost'} icon="grid" iconOnly size="sm" aria-label={t("Grid view")} aria-pressed={view === 'grid'} onClick={() => changeView('grid')} /><Button variant={view === 'list' ? 'secondary' : 'ghost'} icon="list" iconOnly size="sm" aria-label={t("List view")} aria-pressed={view === 'list'} onClick={() => changeView('list')} /></div><Button className="session-create" variant="primary" icon="plus" aria-label={t("New interpretation")} onClick={() => setCreateOpen(true)}><span className="session-create__full">{t("New interpretation")}</span><span className="session-create__short">{t("New")}</span></Button></div></div>
      <nav className="folder-panel" aria-label={t("Session views")}>{viewOptions.map((option) => <button key={option.value} type="button" className="folder-link" data-active={statusView === option.value || undefined} aria-pressed={statusView === option.value} onClick={() => setStatusSelection({ historyOnly, value: option.value })}><Icon name={option.icon} size={17} /><span>{t(option.label)}</span><small>{loading ? '—' : counts[option.value]}</small></button>)}</nav>
      <div ref={resultsRef} className="session-results-scroll" role="region" aria-label={t("Session results")} tabIndex={0}>
      {loading ? <SessionSkeleton view={view} /> : loadError ? <div className="load-error" role="alert"><Icon name="warning" size={26} /><div><h3>{t("Sessions couldn’t be loaded")}</h3><p dir="auto">{t(loadError)}</p></div><Button onClick={reload}>{t("Try again")}</Button></div> : visible.length === 0 ? <div className="session-empty"><EmptyState icon={query ? 'search' : 'wave'} title={query || statusView !== 'all' ? t("No matching sessions") : historyOnly ? t("No history yet") : t("Your first conversation starts here")} description={query || statusView !== 'all' ? t("Try another search or choose a different view.") : historyOnly ? t("Saved, interrupted and archived sessions appear here.") : t("Create a session, select your languages and start speaking when ready.")} action={query || statusView !== 'all' ? <Button onClick={() => { setQuery(''); setStatusSelection({ historyOnly, value: 'all' }) }}>{t("Clear filters")}</Button> : !historyOnly && <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>{t("Create session")}</Button>} /></div> : <div className={`session-results session-results--${view}`}>{visible.map(renderSession)}</div>}
      {!loading && !loadError && hasMore && <div className="session-load-more"><Button loading={loadingMore} onClick={() => void loadMore()}>{t("Load more sessions")}</Button></div>}
      </div>
    </section></div>
    <Dialog open={createOpen} onClose={() => !creating && setCreateOpen(false)} title={t("New interpretation")} description={api.mode === 'mock' ? t("Demo conversations use prepared speech in seven supported languages.") : t("Choose the languages you expect to hear and how you want to follow the conversation.")} footer={<><Button onClick={() => setCreateOpen(false)} disabled={creating}>{t("Cancel")}</Button><Button type="submit" form="create-session" variant="primary" loading={creating}>{t("Create and continue")}</Button></>}><form id="create-session" className="create-session-form" aria-busy={creating} onSubmit={(event) => void submitCreate(event)}><Input dir="auto" autoFocus disabled={creating} label={t("Session title")} optional placeholder={t("e.g. Product discussion")} maxLength={120} value={createInput.title} onChange={(event) => setCreateInput({ ...createInput, title: event.target.value })} /><RecognitionSetup value={createInput} onChange={setCreateInput} disabled={creating} /><p className="create-session-form__note"><Icon name="shield" size={15} />{t("Private until you choose to share it.")}</p></form></Dialog>
    <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)} title={t("Delete this session?")} description={t("This permanently removes the transcript and translation from your workspace.")} footer={<><Button onClick={() => setDeleteTarget(null)} disabled={deleting}>{t("Keep session")}</Button><Button variant="danger" icon="trash" loading={deleting} onClick={() => void remove()}>{t("Delete session")}</Button></>}><div className="delete-summary"><Icon name="warning" size={21} /><div><strong dir="auto">{deleteTarget?.title}</strong><span>{deleteTarget && formatDate(deleteTarget.createdAt)}</span></div></div></Dialog>
  </div>
}
