import { useI18n } from '../../app/i18n'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import type { SessionDetailResponse, Segment, LiveServerMessage } from '../../api/contracts'
import { Button, Card, Dialog, EmptyState, Icon, Input, LoadingState, buttonClassName, useToast } from '../../design-system'
import { Link, useRouter } from '../../app/router'
import { errorMessage, formatDuration, formatTimestamp } from '../../app/utils'
import { useOptionalWorkspaces, usePageWorkspace } from '../../app/workspaces'
import { MoveSessionDialog } from '../workspaces/WorkspaceDialogs'
import { SegmentedControl, Menu, MenuCheckboxItem, MenuItem, MenuSeparator } from '@t-lingual/ui'
import { SharingDialog } from './SharingDialog'
import { PresenceStack } from './PresenceStack'
import { RecognitionLanguageMenu } from './RecognitionLanguageMenu'
import { PlaybackBar } from './PlaybackBar'
import { useSessionAudio } from './useSessionAudio'
import { LanguageSelect, languageDisplayName } from '../languages'
import { useTranscriptPiP } from '../transcript/useTranscriptPiP'
import { TranscriptViewport } from '../transcript/TranscriptViewport'
import { StatusBadge } from './StatusBadge'
import { mergeTranscript, updateTranslation } from '../live/transcriptState'
import { mergeGap } from '../live/useLiveInterpretation'
import { refusalText, useRecordingAdmission } from '../live/useRecordingAdmission'
import './detail.css'

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const {t,locale,formatDate}=useI18n()

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
  // Recording can continue only while recognition can take it.
  const admission = useRecordingAdmission(sessionId, !!detail && !detail.session.archivedAt && !detail.recording?.active && (detail.access?.permission === 'record' || api.mode === 'mock'))
  const refusal = admission && !admission.allowed && admission.reason ? refusalText(admission.reason, detail?.access?.isOwner ?? api.mode === 'mock') : null
  const error = isCurrentLoad ? loadState.error : ''
  // The breadcrumb names the workspace keeping this session — or, for a
  // session someone shared, says so. It holds through a reload.
  const known = loadState.sessionId === sessionId ? loadState.detail?.session : undefined
  usePageWorkspace(known ? known.workspaceId ? { id: known.workspaceId } : { shared: true } : null)
  const workspaces = useOptionalWorkspaces()
  const [moveOpen, setMoveOpen] = useState(false)
  const player=useSessionAudio(sessionId,`${detail?.session.status}:${detail?.recording?.active}`)
  // Picture-in-picture follows the reading window; it lives in the reading options menu.
  const pip=useTranscriptPiP({segments:readerWindow,title:detail?.session.title??'',sourceLanguage:detail?.session.sourceLanguage??'auto',targetLanguage:detail?.session.targetLanguage??'en'})
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
      // New lines belong to the live page; here only lines recognized late,
      // from audio recognition missed, join the saved transcript in their place.
      if (message.type !== 'translation' && message.type !== 'speaker' && message.type !== 'source_text' && message.type !== 'snapshot' && message.type !== 'recording' && message.type !== 'stopped' && message.type !== 'presence' && message.type !== 'gap' && !(message.type === 'final' && message.backfill)) return
      if (message.type === 'translation' && message.targetLanguage && message.targetLanguage !== viewerTarget) return
      if (message.type === 'snapshot' && (message.access?.targetLanguage ?? message.session.targetLanguage) !== viewerTarget) return
      setLoadState(current => {
        if (!active || current.sessionId !== sessionId || !current.detail || current.detail.session.targetLanguage !== viewerTarget) return current
        if(message.type==='recording')return {...current,detail:{...current.detail,recording:message.recording,session:{...current.detail.session,status:message.recording.active?'live':current.detail.session.status==='live'?'completed':current.detail.session.status}}}
        if(message.type==='stopped')return {...current,detail:{...current.detail,recording:{active:false},session:{...current.detail.session,status:message.status}}}
        if(message.type==='presence')return {...current,detail:{...current.detail,presence:message.presence}}
        if(message.type==='gap')return {...current,detail:{...current.detail,recognitionGaps:mergeGap(current.detail.recognitionGaps ?? [],message.gap)}}
        if(message.type==='final')return {...current,detail:{...current.detail,segments:mergeTranscript(current.detail.segments,[message.segment])}}
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
        } else if (message.type === 'source_text') {
          const segment=visible.get(message.segmentId)
          if (segment) updates=[{...segment,sourceText:message.sourceText}]
        } else updates=message.segments.filter(segment => visible.has(segment.id))
        if (!updates.length && message.type!=='snapshot') return current
        return {...current,detail:{...current.detail,...(message.type==='snapshot'?{session:{...current.detail.session,...message.session,targetLanguage:viewerTarget},access:message.access,recording:message.recording,...(message.presence?{presence:message.presence}:{}),...(message.recognitionGaps?{recognitionGaps:message.recognitionGaps}:{})}:{}),segments:mergeTranscript(currentSegments,updates)}}
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
  if (error) return <Card className="detail-error"><EmptyState icon="warning" title={t("Session unavailable")} description={error} action={<div className="detail-error__actions"><Link className={buttonClassName()} href="/sessions">{t("Back to your workspace")}</Link><Button variant="primary" onClick={() => setLoadAttempt((current) => current + 1)}>{t("Try again")}</Button></div>} /></Card>
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
  const canRename = owner && !session.archivedAt
  const openRename = () => { setRenameTitle(session.title); setRenameOpen(true) }
  const empty = segments.length === 0
  const recordingActive = !!detail.recording?.active
  return <LoadingState loading={false} fill size={200} label={t("Loading session transcript")}><div className="detail-page" data-immersive={immersive || undefined} data-reading-size={largeText ? 'large' : 'standard'}>
    {/* The session: its name (click to rename), its state and languages; and
      * only two actions in view — sharing, and everything else in one menu. */}
    <header className="detail-header">
        <div className="detail-title">
          <h1 dir="auto">{canRename ? <button type="button" className="detail-title__rename" aria-describedby="detail-rename-hint" onClick={openRename}><span>{session.title}</span><Icon name="edit" size={15} /></button> : session.title}</h1>
          {canRename && <span id="detail-rename-hint" hidden>{t("Rename session")}</span>}
          <StatusBadge status={session.status} archivedAt={session.archivedAt} />
        </div>
        <div className="detail-meta">
          <span className="detail-meta__languages"><RecognitionLanguageMenu value={session.recognitionLanguages?.length?session.recognitionLanguages:[session.sourceLanguage]} disabled={!owner||!!session.archivedAt||session.status==='live'} onSave={async languages=>{const updated=await api.sessions.recognition(sessionId,languages);setLoadState(current=>current.detail?{...current,detail:{...current.detail,session:{...updated,targetLanguage:current.detail.session.targetLanguage}}}:current)}} /><Icon name="arrowRight" size={13} /><LanguageSelect label={t("Your translation")} value={session.targetLanguage} disabled={languageBusy} onChange={value => void changeLanguage(value)} /></span>
          {elapsed > 0 && <span><Icon name="clock" size={13} />{formatDuration(elapsed)}</span>}
          <time dateTime={session.updatedAt} title={t('Created {date}',{date:formatDate(session.createdAt)})}>{t("Updated")}{' '}{formatDate(session.updatedAt, { dateStyle: 'medium' })}</time>
          {session.archivedAt && <span className="detail-meta__archived" title={t('Archived {date}',{date:formatDate(session.archivedAt)})}><Icon name="folder" size={13} />{t("Archived · read only")}{session.archiveReason === 'inactivity' && <> · {t("After inactivity")}</>}</span>}
        </div>
      <div className="detail-actions">
        {!canRecord && !session.archivedAt && <Link className={buttonClassName()} href={`/live/${session.id}`}>{t("Watch conversation")}</Link>}
        <PresenceStack sessionId={sessionId} presence={detail.presence} />
        {owner && <Button icon="users" aria-label={t("Share")} onClick={() => setShareOpen(true)}><span className="detail-actions__label">{t("Share")}</span></Button>}
        <Menu placement="bottom-end" aria-label={t("More actions")} trigger={<Button icon="more" iconOnly aria-label={t("More actions")} title={t("More actions")} />}>
          <MenuItem icon={<Icon name="copy" size={16} />} disabled={empty || copying} onSelect={() => void copyTranscript()}>{t("Copy transcript")}</MenuItem>
          <MenuItem icon={<Icon name="download" size={16} />} disabled={empty || exporting} onSelect={() => void exportTranscript()}>{t("Export transcript")}</MenuItem>
          {owner && <MenuItem icon={<Icon name="headphones" size={16} />} disabled={session.status==='live'||api.mode==='mock'} onSelect={()=>{window.location.assign(api.audio.bundleUrl(sessionId))}}>{t('Export session')}</MenuItem>}
          <MenuItem icon={<Icon name="printer" size={16} />} onSelect={() => window.print()}>{t("Print current window")}</MenuItem>
          {owner && <><MenuSeparator />{workspaces && workspaces.items.length > 1 && <MenuItem icon={<Icon name="arrowRight" size={16} />} disabled={session.status === 'live'} onSelect={() => setMoveOpen(true)}>{t("Move to another workspace")}</MenuItem>}<MenuItem icon={<Icon name={session.archivedAt ? 'play' : 'folder'} size={16} />} disabled={session.status === 'live' || archiving} onSelect={() => void changeArchive()}>{session.archivedAt ? t("Unarchive session") : t("Archive session")}</MenuItem></>}
        </Menu>
      </div>
    </header>
    {/* The transcript, with what changes how it reads across its top. */}
    <section className="detail-reader">
      <div className="detail-tools">
        <div className="detail-search"><Input label={t("Search transcript")} icon="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("Search the whole conversation…")} /></div>
        <SegmentedControl aria-label={t("Transcript display")} value={display} onChange={value => setDisplay(value as typeof display)} items={[{ value: 'parallel', label: t("Both") }, { value: 'source', label: t("Source") }, { value: 'translation', label: t("Translation") }]} />
        <div className="detail-tools__end">
          {immersive && <Button size="sm" variant="ghost" icon="close" onClick={() => setImmersive(false)}>{t("Exit focus")}</Button>}
          <Menu placement="bottom-end" aria-label={t("Reading options")} trigger={<Button size="sm" variant="ghost" icon="sliders" iconOnly aria-label={t("Reading options")} title={t("Reading options")} />}>
            <MenuCheckboxItem checked={largeText} onCheckedChange={setLargeText}>{t("Larger text")}</MenuCheckboxItem>
            <MenuCheckboxItem checked={immersive} onCheckedChange={setImmersive}>{t("Focus view")}</MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem icon={<Icon name="external" size={16} />} disabled={!pip.supported} onSelect={pip.toggle}>{pip.isOpen ? t('Close picture-in-picture') : t('Picture-in-picture')}</MenuItem>
          </Menu>
        </div>
        {pip.error && <p className="detail-tools__note" role="alert">{t(pip.error)}</p>}
      </div>
      <TranscriptViewport bare key={session.targetLanguage} playback={!recordingActive&&player.ready.length?{timeMs:player.positionMs,playing:player.playing,seekToken:player.seekToken}:undefined} onSeekTime={!recordingActive&&player.ready.length?value=>player.seek(value):undefined} onWindowChange={captureReaderWindow} sessionId={sessionId} segments={segments} gaps={detail.recognitionGaps} initialHasMore={detail.segmentPage.hasMore} sourceLanguage={session.recognitionLanguages && session.recognitionLanguages.length > 1 ? 'auto' : session.sourceLanguage} targetLanguage={session.targetLanguage} display={display} query={query} emptyTitle={t("No final transcript")} emptyDescription={t("This session has not captured a complete phrase yet.")} />
    </section>
    {/* Its audio, and the way to carry the conversation on. */}
    <PlaybackBar player={player} recording={recordingActive} action={!session.archivedAt && canRecord && <Button variant={recordingActive ? 'primary' : 'secondary'} icon={session.status === 'live' ? 'wave' : 'microphone'} loading={continuing} disabled={!recordingActive && !!refusal} title={!recordingActive && refusal ? t(refusal.notice) : undefined} onClick={() => void continueRecording()}>{session.status === 'live' ? t("Return to live") : t("Continue recording")}</Button>} />
    {pip.portal}
    {owner && workspaces && <MoveSessionDialog session={moveOpen ? session : null} onClose={() => setMoveOpen(false)} onMoved={(moved) => setLoadState((current) => current.detail ? { ...current, detail: { ...current.detail, session: { ...current.detail.session, workspaceId: moved.workspaceId } } } : current)} />}
    {owner && <SharingDialog sessionId={sessionId} open={shareOpen} onClose={() => setShareOpen(false)} />}
    <Dialog open={renameOpen && !session.archivedAt} onClose={() => !renaming && setRenameOpen(false)} title={t("Rename session")} footer={<><Button onClick={() => setRenameOpen(false)} disabled={renaming}>{t("Cancel")}</Button><Button type="submit" form="rename-session" variant="primary" loading={renaming} disabled={!renameTitle.trim()}>{t("Save name")}</Button></>}><form id="rename-session" onSubmit={(event) => void rename(event)}><Input autoFocus label={t("Session title")} maxLength={120} value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} /></form></Dialog>
  </div></LoadingState>
}
