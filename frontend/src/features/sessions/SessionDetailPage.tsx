import { useI18n } from '../../app/i18n'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { SessionDetailResponse, Segment, LiveServerMessage } from '../../api/contracts'
import { Button, Card, Dialog, EmptyState, Icon, Input, LoadingState, buttonClassName, useToast } from '../../design-system'
import { Link, useRouter } from '../../app/router'
import { errorMessage, formatDuration, formatTimestamp } from '../../app/utils'
import { SegmentedControl, Menu, MenuItem } from '@t-lingual/ui'
import { SharingDialog } from './SharingDialog'
import { RecognitionLanguageMenu } from './RecognitionLanguageMenu'
import { SessionTransport } from './SessionTransport'
import { useSessionAudio } from './useSessionAudio'
import { LanguageSelect, languageDisplayName } from '../languages'
import { TranscriptPiPButton } from '../transcript/useTranscriptPiP'
import { TranscriptViewport } from '../transcript/TranscriptViewport'
import { StatusBadge } from './StatusBadge'
import { mergeTranscript, updateTranslation } from '../live/transcriptState'
import './detail.css'

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const {t,locale,formatDate}=useI18n()

  const [transportMode,setTransportMode]=useState<'record'|'playback'>('playback')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadState, setLoadState] = useState<{ sessionId: string; attempt: number; detail: SessionDetailResponse | null; error: string }>(() => ({ sessionId, attempt: 0, detail: null, error: '' }))
  const [shareOpen, setShareOpen] = useState(false)
  const [languageBusy, setLanguageBusy] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [copying, setCopying] = useState(false)
  const [query, setQuery] = useState('')
  const [immersive, setImmersive] = useState(false)
  const [largeText, setLargeText] = useState(false)
  const [readerWindow, setReaderWindow] = useState<Segment[]>([])
  const readerWindowRef = useRef<Segment[]>([])
  const readerWindowTargetRef = useRef<string | undefined>(undefined)
  const captureReaderWindow = (rows: Segment[]) => { readerWindowRef.current=rows; readerWindowTargetRef.current=loadState.detail?.session.targetLanguage; setReaderWindow(rows) }
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setImmersive(false) }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape) }, [])
  const [displayChoice, setDisplay] = useState<'parallel' | 'source' | 'translation' | null>(null)
  const requestGenerationRef = useRef(0); const { push } = useToast(); const { navigate } = useRouter()
  const isCurrentLoad = loadState.sessionId === sessionId && loadState.attempt === loadAttempt
  const detail = isCurrentLoad ? loadState.detail : null
  const error = isCurrentLoad ? loadState.error : ''
  const player=useSessionAudio(sessionId,`${detail?.session.status}:${detail?.recording?.active}`)
  useEffect(() => {
    let active = true
    const generation = requestGenerationRef.current + 1
    requestGenerationRef.current = generation
    api.sessions.get(sessionId).then((value) => {
      if (active && requestGenerationRef.current === generation) {
        if (value.session.archivedAt) setRenameOpen(false)
        setLoadState({ sessionId, attempt: loadAttempt, detail: value, error: '' })
      }
    }).catch((caught) => {
      if (active && requestGenerationRef.current === generation) setLoadState({ sessionId, attempt: loadAttempt, detail: null, error: errorMessage(caught) })
    })
    return () => { active = false; if (requestGenerationRef.current === generation) requestGenerationRef.current += 1 }
  }, [loadAttempt, sessionId])
  useEffect(() => {
    const refreshOnFocus = () => setLoadAttempt((current) => current + 1)
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [])
  const viewerTarget = detail?.session.targetLanguage
  useEffect(() => {
    if (__TLINGUAL_DEVELOPMENT_MOCK__ || !viewerTarget || typeof EventSource === 'undefined') return
    const events = new EventSource(api.eventsUrl(sessionId))
    let active = true
    events.onmessage = event => {
      let message: LiveServerMessage
      try {message=JSON.parse(event.data) as LiveServerMessage} catch {return}
      if (message.type !== 'translation' && message.type !== 'speaker' && message.type !== 'snapshot' && message.type !== 'recording' && message.type !== 'stopped') return
      if (message.type === 'translation' && message.targetLanguage && message.targetLanguage !== viewerTarget) return
      if (message.type === 'snapshot' && (message.access?.targetLanguage ?? message.session.targetLanguage) !== viewerTarget) return
      setLoadState(current => {
        if (!active || current.sessionId !== sessionId || !current.detail || current.detail.session.targetLanguage !== viewerTarget) return current
        if(message.type==='recording')return {...current,detail:{...current.detail,recording:message.recording,session:{...current.detail.session,status:message.recording.active?'live':current.detail.session.status==='live'?'completed':current.detail.session.status}}}
        if(message.type==='stopped')return {...current,detail:{...current.detail,recording:{active:false},session:{...current.detail.session,status:message.status}}}
        const currentSegments = current.detail.segments
        const matchingWindow = readerWindowTargetRef.current === viewerTarget ? readerWindowRef.current : []
        const visible = new Map([...matchingWindow, ...currentSegments].map(item => [item.id, item]))
        let updates: Segment[] = []
        if (message.type === 'translation') {
          const segment=visible.get(message.segmentId)
          if (segment) updates=updateTranslation([segment],message.segmentId,message.translation,message.status,message.revision,message.error,message.requestId,{translationPhase:message.phase,...(message.resolvedSourceLanguage?{detectedLanguage:message.resolvedSourceLanguage,languageSource:'translator' as const,sourceDetection:message.sourceDetection}:{})})
        } else if (message.type === 'speaker') {
          const segment=visible.get(message.segmentId)
          if (segment) updates=[{...segment,speakerId:message.speakerId,speakerLabel:message.speakerLabel}]
        } else updates=message.segments.filter(segment => visible.has(segment.id))
        if (!updates.length && message.type!=='snapshot') return current
        return {...current,detail:{...current.detail,...(message.type==='snapshot'?{session:{...current.detail.session,...message.session,targetLanguage:viewerTarget},access:message.access,recording:message.recording}:{}),segments:mergeTranscript(currentSegments,updates)}}
      })
    }
    let reconciling = false
    events.onerror = () => {
      if (reconciling) return
      reconciling=true
      const visible = readerWindowTargetRef.current === viewerTarget ? readerWindowRef.current : []
      const first = visible[0]?.sequence
      void Promise.all([
        api.sessions.get(sessionId),
        first === undefined ? Promise.resolve(null) : api.sessions.segments(sessionId, {after:Math.max(0,first-1),limit:40,...(query.trim() ? {search:query.trim()} : {})}),
      ]).then(([fresh,window]) => {
        if (!active || fresh.session.targetLanguage !== viewerTarget) return
        setLoadState(current => {
          if (current.sessionId !== sessionId || current.detail?.session.targetLanguage !== viewerTarget) return current
          return {...current,detail:{...fresh,segments:mergeTranscript(current.detail.segments,[...fresh.segments,...(window?.items ?? [])])}}
        })
      }).catch(caught => {
        if (!active) return
        events.close()
        setLoadState(current => current.sessionId === sessionId ? {...current,detail:null,error:errorMessage(caught)} : current)
      }).finally(() => {reconciling=false})
    }
    return () => {active=false;events.close()}
  }, [query,sessionId,viewerTarget])
  const readCompleteTranscript = async () => {
    if (!detail) return []
    const generation = requestGenerationRef.current
    const all: Segment[] = []
    let cursor = 0
    let more = true
    while (more) {
      const page = await api.sessions.segments(detail.session.id, { after: cursor, limit: 200 })
      if (requestGenerationRef.current !== generation) throw new DOMException('The session changed', 'AbortError')
      all.push(...page.items)
      if (page.hasMore && page.nextAfter <= cursor) throw new Error('Transcript pagination stopped unexpectedly.')
      cursor = page.nextAfter; more = page.hasMore
    }
    return [...new Map(all.map(segment => [segment.id, segment])).values()].sort((a, b) => a.sequence - b.sequence)
  }
  const copyTranscript = async () => {
    if (!detail || copying) return
    setCopying(true)
    const generation = requestGenerationRef.current
    try {
      const all = await readCompleteTranscript()
      await navigator.clipboard.writeText(all.map(segment => `${segment.sourceText}${segment.translationStatus === 'succeeded' && segment.translation ? `\n${segment.translation}` : ''}`).join('\n\n'))
      if (requestGenerationRef.current === generation) push({ tone: 'success', title: t("Complete transcript copied") })
    } catch (caught) { if (requestGenerationRef.current === generation) push({ tone: 'error', title: t("Couldn’t copy transcript"), message: errorMessage(caught) }) }
    finally { setCopying(false) }
  }
  const rename = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || detail.session.archivedAt || !renameTitle.trim()) return
    const requestSessionId = detail.session.id
    const generation = requestGenerationRef.current
    setRenaming(true)
    try {
      const updated = await api.sessions.update(requestSessionId, { title: renameTitle.trim(), sourceLanguage: detail.session.sourceLanguage, targetLanguage: detail.session.targetLanguage, ...(detail.session.recognitionLanguages ? { recognitionLanguages: detail.session.recognitionLanguages } : {}), ...(detail.session.diarization !== undefined ? { diarization: detail.session.diarization } : {}) })
      if (requestGenerationRef.current !== generation) return
      setLoadState((current) => current.sessionId === requestSessionId && current.detail ? { ...current, detail: { ...current.detail, session: {...updated,targetLanguage:current.detail.session.targetLanguage} } } : current)
      setRenameOpen(false)
      push({ tone: 'success', title: t("Session renamed") })
    } catch (caught) { push({ tone: 'error', title: t("Couldn’t rename session"), message: errorMessage(caught) }) }
    finally { setRenaming(false) }
  }
  const changeArchive = async () => {
    if (!detail || archiving || detail.session.status === 'live') return
    const currentSession = detail.session
    const generation = requestGenerationRef.current
    setArchiving(true)
    try {
      const updated = currentSession.archivedAt ? await api.sessions.unarchive(currentSession.id) : await api.sessions.archive(currentSession.id)
      if (requestGenerationRef.current !== generation) return
      setLoadState((current) => current.sessionId === currentSession.id && current.detail ? { ...current, detail: { ...current.detail, session: {...updated,targetLanguage:current.detail.session.targetLanguage} } } : current)
      push({ tone: 'success', title: currentSession.archivedAt ? t("Session restored") : t("Session archived") })
    } catch (caught) { if (requestGenerationRef.current === generation) push({ tone: 'error', title: currentSession.archivedAt ? t("Couldn’t restore session") : t("Couldn’t archive session"), message: errorMessage(caught) }) }
    finally { setArchiving(false) }
  }
  const continueRecording = async () => {
    if (!detail || continuing || detail.session.archivedAt) return
    const generation = requestGenerationRef.current
    setContinuing(true)
    try {
      const latest = await api.sessions.get(detail.session.id)
      if (requestGenerationRef.current !== generation) return
      if (latest.session.archivedAt) {
        setLoadState((current) => current.sessionId === detail.session.id && current.detail ? { ...current, detail: { ...current.detail, session: latest.session } } : current)
        push({ tone: 'info', title: t("Session was archived"), message: t("Restore it before continuing the recording.") })
        return
      }
      player.pause();navigate(`/live/${detail.session.id}`)
    } catch (caught) { if (requestGenerationRef.current === generation) push({ tone: 'error', title: t("Couldn’t open recording"), message: errorMessage(caught) }) }
    finally { setContinuing(false) }
  }
  const exportTranscript = async () => {
    if (!detail || exporting) return
    const generation = requestGenerationRef.current
    setExporting(true)
    try {
      const unique = await readCompleteTranscript()
      if (requestGenerationRef.current !== generation) return
      const lines = [detail.session.title, `${languageDisplayName(detail.session.sourceLanguage,locale)} → ${languageDisplayName(detail.session.targetLanguage,locale)}`, formatDate(detail.session.createdAt), '', ...unique.flatMap((segment) => [`[${formatTimestamp(segment.startMs)}] ${segment.sourceText}`, segment.translationStatus === 'succeeded' ? segment.translation : `[${segment.translationError || 'Translation unavailable'}]`, ''])]
      const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${detail.session.title.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'interpretation'}.txt`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      push({ tone: 'success', title: t("Transcript downloaded") })
    } catch (caught) { push({ tone: 'error', title: t("Couldn’t export transcript"), message: errorMessage(caught) }) }
    finally { setExporting(false) }
  }
  if (error) return <Card className="detail-error"><EmptyState icon="warning" title={t("Session unavailable")} description={error} action={<div className="detail-error__actions"><Link className={buttonClassName()} href="/history">{t("Back to history")}</Link><Button variant="primary" onClick={() => setLoadAttempt((current) => current + 1)}>{t("Try again")}</Button></div>} /></Card>
  if (!detail) return <LoadingState fill size={200} label={t("Loading session transcript")} />
  const display = displayChoice ?? (detail.translationConfigured === false ? 'source' : 'parallel')
  const { session, segments } = detail
  const owner = detail.access?.isOwner ?? api.mode === 'mock'
  const canRecord = detail.access?.permission === 'record' || api.mode === 'mock'
  const changeLanguage = async (targetLanguage: string) => {
    setLanguageBusy(true)
    try { await api.sessions.language(sessionId, targetLanguage); setLoadAttempt(value => value+1) }
    catch(caught) {push({tone:'error',title:t("Couldn’t change language"),message:errorMessage(caught)})} finally {setLanguageBusy(false)}
  }
  const elapsed = session.startedAt && session.endedAt ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() : 0
  return <LoadingState loading={false} fill size={200} label={t("Loading session transcript")}><div className="detail-page" data-immersive={immersive || undefined} data-reading-size={largeText ? 'large' : 'standard'}>
    <header className="detail-header"><div><div className="detail-title"><h1 dir="auto">{session.title}</h1><StatusBadge status={session.status} archivedAt={session.archivedAt} /></div></div><div className="detail-actions">{!canRecord && !session.archivedAt && <Link className={buttonClassName()} href={`/live/${session.id}`}>{t("Watch conversation")}</Link>}{owner && <Button icon={session.archivedAt ? 'play' : 'folder'} loading={archiving} disabled={session.status === 'live'} onClick={() => void changeArchive()}>{session.archivedAt ? t("Unarchive") : t("Archive")}</Button>}{owner && <Button icon="users" onClick={() => setShareOpen(true)}>{t("Share")}</Button>}<div className="detail-secondary-actions">{owner && <Button icon="edit" disabled={!!session.archivedAt} onClick={() => { setRenameTitle(session.title); setRenameOpen(true) }}>{t("Rename")}</Button>}<Button icon="copy" loading={copying} disabled={segments.length === 0} onClick={() => void copyTranscript()}>{t("Copy")}</Button><Button icon="download" loading={exporting} disabled={segments.length === 0} onClick={() => void exportTranscript()}>{t("Export")}</Button>{owner && <a className={buttonClassName()} href={api.audio.bundleUrl(sessionId)} aria-disabled={session.status==='live'||api.mode==='mock'} onClick={event=>{if(session.status==='live'||api.mode==='mock')event.preventDefault()}}>{t('Export session')}</a>}<Button icon="printer" aria-label={t("Print current transcript window")} title={t("Print the current reading window. Export downloads the complete transcript.")} onClick={() => window.print()}>{t("Print")}</Button></div><Menu placement="bottom-end" trigger={<Button className="detail-more" icon="more" iconOnly aria-label={t("Transcript actions")} />}> {owner && <MenuItem disabled={!!session.archivedAt} onSelect={() => { setRenameTitle(session.title); setRenameOpen(true) }}>{t("Rename")}</MenuItem>}<MenuItem disabled={segments.length === 0 || copying} onSelect={() => void copyTranscript()}>{t("Copy transcript")}</MenuItem><MenuItem disabled={segments.length === 0 || exporting} onSelect={() => void exportTranscript()}>{t("Export transcript")}</MenuItem>{owner && <MenuItem disabled={session.status==='live'||api.mode==='mock'} onSelect={()=>{window.location.assign(api.audio.bundleUrl(sessionId))}}>{t('Export session')}</MenuItem>}<MenuItem onSelect={() => window.print()}>{t("Print current window")}</MenuItem></Menu></div></header>
    {session.archivedAt && <div className="detail-archive-notice" role="status" title={t('Archived {date}',{date:formatDate(session.archivedAt)})}><Icon name="folder" size={16} /><strong>{t("Archived · read only")}</strong>{session.archiveReason === 'inactivity' && <span>{t("After inactivity")}</span>}</div>}
    <div className="detail-meta"><span className="detail-meta__languages"><RecognitionLanguageMenu value={session.recognitionLanguages?.length?session.recognitionLanguages:[session.sourceLanguage]} disabled={!owner||!!session.archivedAt||session.status==='live'} onSave={async languages=>{const updated=await api.sessions.recognition(sessionId,languages);setLoadState(current=>current.detail?{...current,detail:{...current.detail,session:{...updated,targetLanguage:current.detail.session.targetLanguage}}}:current)}} /><Icon name="arrowRight" size={13} /><LanguageSelect label={t("Your translation")} value={session.targetLanguage} disabled={languageBusy} onChange={value => void changeLanguage(value)} /></span><span><Icon name="history" size={13} />{formatDuration(elapsed)}</span><time dateTime={session.updatedAt} title={t('Created {date}',{date:formatDate(session.createdAt)})}>{t("Updated")}{' '}{formatDate(session.updatedAt, { dateStyle: 'medium' })}</time></div>
    <div className="detail-toolbar"><div className="detail-search"><Input label={t("Search transcript")} icon="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("Search the whole conversation…")} /></div><SegmentedControl aria-label={t("Transcript display")} value={display} onChange={value => setDisplay(value as typeof display)} items={[{ value: 'parallel', label: t("Both") }, { value: 'source', label: t("Source") }, { value: 'translation', label: t("Translation") }]} /><div className="reader-actions__tools"><TranscriptPiPButton segments={readerWindow} title={session.title} sourceLanguage={session.sourceLanguage} targetLanguage={session.targetLanguage} /><Button size="sm" variant="ghost" aria-pressed={largeText} onClick={() => setLargeText(value => !value)}>{t("Aa")}{' '}{largeText ? t("Standard text") : t("Larger text")}</Button><Button size="sm" variant="ghost" icon="external" aria-pressed={immersive} onClick={() => setImmersive(value => !value)}>{immersive ? t("Exit focus") : t("Focus view")}</Button></div></div>
    <section className="detail-reader"><TranscriptViewport key={session.targetLanguage} playback={transportMode==='playback'&&!detail.recording?.active&&player.ready.length?{timeMs:player.positionMs,playing:player.playing,seekToken:player.seekToken}:undefined} onSeekTime={player.ready.length?value=>{setTransportMode('playback');player.seek(value)}:undefined} onWindowChange={captureReaderWindow} sessionId={sessionId} segments={segments} initialHasMore={detail.segmentPage.hasMore} sourceLanguage={session.recognitionLanguages && session.recognitionLanguages.length > 1 ? 'auto' : session.sourceLanguage} targetLanguage={session.targetLanguage} display={display} query={query} emptyTitle={t("No final transcript")} emptyDescription={t("This session has not captured a complete phrase yet.")} /></section>
    <SessionTransport player={player} mode={transportMode} onModeChange={setTransportMode} recording={detail.recording?.active} recordingPanel={<div className="transcript-record-entry"><p>{t('Continue this conversation with a new recording.')}</p>{!session.archivedAt && canRecord && <Button variant="primary" icon={session.status === 'live' ? 'wave' : 'microphone'} loading={continuing} onClick={() => void continueRecording()}>{session.status === 'live' ? t("Return to live") : t("Continue recording")}</Button>}</div>} />
    {owner && shareOpen && <SharingDialog sessionId={sessionId} open={shareOpen} onClose={() => setShareOpen(false)} />}
    <Dialog open={renameOpen && !session.archivedAt} onClose={() => !renaming && setRenameOpen(false)} title={t("Rename session")} footer={<><Button onClick={() => setRenameOpen(false)} disabled={renaming}>{t("Cancel")}</Button><Button type="submit" form="rename-session" variant="primary" loading={renaming} disabled={!renameTitle.trim()}>{t("Save name")}</Button></>}><form id="rename-session" onSubmit={(event) => void rename(event)}><Input autoFocus label={t("Session title")} maxLength={120} value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} /></form></Dialog>
  </div></LoadingState>
}
