import { useI18n } from '../../app/i18n'
import { useEffect, useRef, useState } from 'react'
import { SegmentedControl } from '@t-lingual/ui'
import { Badge, Button, Card, EmptyState, Icon, Skeleton, buttonClassName } from '../../design-system'
import { api } from '../../api/client'
import { Link } from '../../app/router'
import { formatDuration } from '../../app/utils'
import { useLiveInterpretation, type LiveState } from './useLiveInterpretation'
import { SharingDialog } from '../sessions/SharingDialog'
import { RecognitionLanguageMenu } from '../sessions/RecognitionLanguageMenu'
import { SessionTransport } from '../sessions/SessionTransport'
import { useSessionAudio } from '../sessions/useSessionAudio'
import { LanguageSelect } from '../languages'
import { TranscriptPiPButton } from '../transcript/useTranscriptPiP'
import { TranscriptViewport } from '../transcript/TranscriptViewport'
import './live.css'

const stateLabel: Record<LiveState, string> = { idle: 'Ready', requesting: 'Microphone permission', connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', stopping: 'Finishing', ended: 'Saved', error: 'Interrupted' }
export function LivePage({ sessionId, guest = false }: { sessionId: string; guest?: boolean }) {
  const {t}=useI18n()

  const live = useLiveInterpretation(sessionId, guest)
  const { autoStart, session, start, state } = live
  const player=useSessionAudio(sessionId,state)
  const [transportMode,setTransportMode]=useState<'record'|'playback'>('record')
  const didAutoStart = useRef(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [displayChoice, setDisplay] = useState<'parallel' | 'source' | 'translation' | null>(null)
  const display = displayChoice ?? (live.translationConfigured === false ? 'source' : 'parallel')
  const [largeText, setLargeText] = useState(false)
  const demo = api.mode === 'mock'
  useEffect(() => { if (autoStart && session && (live.access?.permission === 'record' || demo) && !live.recording.active && state === 'idle' && !didAutoStart.current) { didAutoStart.current = true; void start() } }, [autoStart, demo, live.access?.permission, live.recording.active, session, start, state])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setImmersive(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  if (!session) {
    if (state === 'error') return <Card className="live-load-error"><EmptyState icon="warning" title={t("Live session unavailable")} description={live.error || 'The live session could not be loaded.'} action={<Button variant="primary" onClick={live.retryLoad}>{t("Try loading again")}</Button>} /></Card>
    return <div className="live-loading" role="status" aria-label={t("Loading live interpretation")}><Skeleton width="40%" height={31} /><Skeleton height={560} /></div>
  }
  const archived = Boolean(session.archivedAt)
  const saved = session.status === 'completed' || session.status === 'failed' || state === 'ended'
  const active = state === 'live' || state === 'reconnecting' || state === 'stopping'
  const owner = live.access?.isOwner ?? demo
  const canRecord = live.access?.permission === 'record' || demo
  const occupied = live.recording.active && !active && state !== 'connecting' && state !== 'requesting'
  const languageSet = session.recognitionLanguages?.length ? session.recognitionLanguages : [session.sourceLanguage]
  const label = archived ? 'Archived' : occupied ? 'Live' : live.paused ? 'Audio paused' : stateLabel[state]
  const speakers = [...new Set(live.segments.map(segment => segment.speakerId).filter(Boolean))]
  const latestSequence = live.segments.at(-1)?.sequence ?? 0
  return <div className="live-page" data-immersive={immersive || undefined} data-reading-size={largeText ? 'large' : 'standard'}>
    <header className="live-header">
      <div className="live-header__identity"><h1 dir="auto">{session.title}</h1><div className="live-languages"><RecognitionLanguageMenu value={languageSet} disabled={!owner||archived||live.recording.active||active} onSave={live.changeRecognition} /><Icon name="arrowRight" size={14} /><LanguageSelect label={t("Your translation")} value={session.targetLanguage} disabled={live.languageBusy} onChange={value => void live.changeLanguage(value)} />{session.diarization && <span className="live-speaker-mode"><Icon name="users" size={14} />{t("Speaker labels")}</span>}</div></div>
      <div className="live-session-state"><Badge tone={state === 'error' ? 'danger' : active ? 'accent' : 'neutral'} dot={state === 'live' && !live.paused}>{t(label)}</Badge><time>{formatDuration(live.elapsedMs) === 'Not started' ? '00:00' : formatDuration(live.elapsedMs)}</time>{demo && <span className="live-demo-note">{t("Prepared conversation")}</span>}<span className="sr-only" role="status">{t("Interpretation status:")}{' '}{t(label)}</span></div>
    </header>
    {archived && <div className="live-archive-notice"><Icon name="folder" size={17} /><span>{session.archiveReason === 'inactivity' ? t("Archived after inactivity.") : t("This session is archived.")} {t("Unarchive it to add more recordings; your existing transcript stays intact.")}</span></div>}
    {live.translationConfigured === false && <div className="translation-availability"><Icon name="globe" size={14} /><span>{t("Translation is not connected yet. Original captions are available.")}</span></div>}
    {live.error && <div className="live-notice" role={state === 'error' ? 'alert' : 'status'}><Icon name="warning" size={18} /><span>{t(live.error)}</span></div>}
    <div className="reader-actions"><SegmentedControl aria-label={t("Transcript display")} value={display} onChange={value => setDisplay(value as typeof display)} items={[{ value: 'parallel', label: t("Bilingual") }, { value: 'source', label: t("Original") }, { value: 'translation', label: t("Translation") }]} /><div className="reader-actions__tools">{owner && <Button size="sm" icon="users" onClick={() => setShareOpen(true)}>{t("Share")}</Button>}<TranscriptPiPButton segments={live.segments} title={session.title} sourceLanguage={languageSet.length > 1 ? 'auto' : session.sourceLanguage} targetLanguage={session.targetLanguage} paused={live.paused} /><Button size="sm" variant="ghost" aria-pressed={largeText} onClick={() => setLargeText(value => !value)}><span className="reader-text-icon">{t("Aa")}</span>{largeText ? t("Standard text") : t("Larger text")}</Button><Button size="sm" variant="ghost" icon="external" aria-pressed={immersive} onClick={() => setImmersive(value => !value)}>{immersive ? t("Exit focus") : t("Focus view")}</Button></div></div>
    <div className="live-reader"><TranscriptViewport sessionId={sessionId} segments={live.segments} sourceLanguage={languageSet.length > 1 ? 'auto' : session.sourceLanguage} targetLanguage={session.targetLanguage} key={session.targetLanguage} live={active||occupied} playback={transportMode==='playback'&&!active&&!occupied&&player.ready.length?{timeMs:player.positionMs,playing:player.playing,seekToken:player.seekToken}:undefined} onSeekTime={player.ready.length?value=>{setTransportMode('playback');player.seek(value)}:undefined} display={display} compact={live.compact} emptyTitle={state === 'idle' ? t("A conversation starts with a voice") : state === 'ended' ? t("No speech captured") : t("Listening for the first words…")} emptyDescription={demo ? t("Play the prepared conversation to follow language changes, speakers and growing translations.") : canRecord ? t("Start interpretation when you are ready. Your microphone stays off until then.") : t("The conversation will appear here when someone starts recording.")} /></div>
    <SessionTransport player={player} mode={transportMode} onModeChange={setTransportMode} recording={active||occupied||state==='requesting'||state==='connecting'} recordingPanel={<div className="live-dock"><div className="live-dock__signal"><span className="live-wave" data-active={active && !live.paused || undefined} aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</span><div><strong>{occupied ? t('{name} is recording',{name:live.recording.holderName || t('Another viewer')}) : live.paused ? t("Audio paused") : active ? demo ? t("Conversation in progress") : t("Listening to your microphone") : archived ? t("Archived · read-only") : saved ? t("Recording saved")  : demo ? t("Ready to play") : t("Ready to listen")}</strong><span>{demo ? t("Simulated audio · no microphone recording") : !canRecord ? t("Shared with you · read only") : occupied ? t("You are following the live conversation") : t("Only one participant records at a time")}</span></div></div><div className="live-dock__controls">{!canRecord ? <Badge>{t("Read only")}</Badge> : occupied ? <>{owner && <><Button onClick={() => void live.stopOtherRecorder()}>{t("Stop their recording")}</Button><Button variant="primary" onClick={() => {player.pause();void start(true)}}>{t("Take over recording")}</Button></>}</> : archived && owner ? <Button variant="primary" icon="history" loading={live.archiveBusy} onClick={() => void live.unarchive()}>{t("Unarchive to continue")}</Button> : archived ? <Badge>{t("Archived")}</Badge> : state === 'idle' || state === 'error' || state === 'ended' ? <>{saved && !guest && <Link className={buttonClassName()} href={`/history/${sessionId}`}>{t("View transcript")}</Link>}<Button variant="primary" icon="play" onClick={() => {player.pause();void start()}}>{saved || live.segments.length > 0 ? t("Continue recording") : demo ? t("Play demo sequence") : t("Start recording")}</Button></> : <>{state === 'live' && <Button icon={live.paused ? 'play' : 'pause'} onClick={live.togglePause}>{live.paused ? t("Resume audio") : t("Pause audio")}</Button>}<Button variant="danger" icon="stop" loading={state === 'stopping'} disabled={state === 'requesting'} onClick={() => void live.stop()}>{t("Stop recording")}</Button></>}</div></div>} />
    {owner && shareOpen && <SharingDialog sessionId={sessionId} open={shareOpen} onClose={() => setShareOpen(false)} />}
    <footer className="live-footnote"><span>{speakers.length ? `${t('{count} voices',{count:speakers.length})} · ` : ''}{latestSequence ? t('Latest phrase {number}',{number:latestSequence}) : t("Your conversation will appear above")}</span><span>{t("Words may refine while speech is in progress.")}</span></footer>
  </div>
}
