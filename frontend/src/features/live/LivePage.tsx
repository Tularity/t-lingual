import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, EmptyState, Icon, Skeleton, buttonClassName } from '../../design-system'
import { Link } from '../../app/router'
import { formatDuration, languageName } from '../../app/utils'
import { useLiveInterpretation, type LiveState } from './useLiveInterpretation'
import './live.css'

const statePresentation: Record<LiveState, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' | 'info' }> = {
  idle: { label: 'Ready', tone: 'neutral' }, requesting: { label: 'Requesting microphone', tone: 'info' }, connecting: { label: 'Connecting', tone: 'info' }, live: { label: 'Live', tone: 'danger' }, reconnecting: { label: 'Reconnecting', tone: 'accent' }, stopping: { label: 'Finishing', tone: 'info' }, ended: { label: 'Ended', tone: 'success' }, error: { label: 'Interrupted', tone: 'danger' },
}

function LevelMeter({ active }: { active: boolean }) {
  return <span className="level-meter" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <span key={index} data-active={active || undefined} />)}</span>
}

export function LivePage({ sessionId }: { sessionId: string }) {
  const live = useLiveInterpretation(sessionId)
  const { autoStart, session, start, state } = live
  const didAutoStart = useRef(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const [followingLatest, setFollowingLatest] = useState(true)
  useEffect(() => { if (autoStart && session && state === 'idle' && !didAutoStart.current) { didAutoStart.current = true; void start() } }, [autoStart, session, start, state])
  const latestSegment = live.segments.at(-1)
  useEffect(() => {
    const feed = feedRef.current
    if (feed && followLatestRef.current) feed.scrollTop = feed.scrollHeight
  }, [latestSegment?.translation, latestSegment?.translationStatus, live.partial, live.segments.length])
  const updateFollowState = () => {
    const feed = feedRef.current
    if (!feed) return
    const follows = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 72
    followLatestRef.current = follows
    setFollowingLatest(follows)
  }
  const jumpToLatest = () => {
    const feed = feedRef.current
    if (!feed) return
    followLatestRef.current = true; setFollowingLatest(true); feed.scrollTop = feed.scrollHeight; feed.focus()
  }
  const presentation = statePresentation[live.state]
  if (!live.session) {
    if (live.state === 'error') return <Card className="live-load-error"><EmptyState icon="warning" title="Live session unavailable" description={live.error || 'The live session could not be loaded.'} action={<Button variant="primary" onClick={live.retryLoad}>Try loading again</Button>} /></Card>
    return <div className="live-loading" role="status" aria-label="Loading live interpretation"><Skeleton width="40%" height={31} /><Skeleton width="100%" height={560} /></div>
  }
  const terminalSession = live.session.status === 'completed' || live.session.status === 'failed'
  return <div className="live-page" data-compact={live.compact || undefined}>
    <header className="live-header"><div className="live-header__identity"><Link className="back-link" href="/sessions"><Icon name="arrowLeft" size={18} />Sessions</Link><div><h1 dir="auto">{live.session?.title ?? 'Live interpretation'}</h1><p>{live.session && `${languageName(live.session.sourceLanguage)} → ${languageName(live.session.targetLanguage)}`}</p></div></div><div className="live-header__status"><Badge tone={presentation.tone} dot={live.state === 'live' || live.state === 'reconnecting'}>{presentation.label}</Badge>{live.elapsedMs > 0 && <time dateTime={`PT${Math.floor(live.elapsedMs / 1000)}S`}>{formatDuration(live.elapsedMs)}</time>}<span className="sr-only" role="status">Interpretation status: {presentation.label}</span></div></header>
    {(live.state === 'reconnecting' || live.error) && <div className={`live-notice live-notice--${live.state === 'error' ? 'error' : 'warning'}`} role={live.state === 'error' ? 'alert' : 'status'}><Icon name="warning" size={19} /><div><strong>{live.state === 'reconnecting' ? 'Connection interrupted — restoring automatically' : live.state === 'error' ? 'Live interpretation paused' : 'Provider notice'}</strong><p dir="auto">{live.error || 'Audio resumes after the connection is restored. Already received text is safe.'}</p></div></div>}
    <div className="live-layout">
      <Card className="transcript-stage" aria-label="Live transcript">
        <div className="transcript-stage__header"><div><span className="transcript-label">Original</span><strong>{live.session && languageName(live.session.sourceLanguage)}</strong></div><div><span className="transcript-label">Translation</span><strong>{live.session && languageName(live.session.targetLanguage)}</strong></div></div>
        <div ref={feedRef} className="transcript-feed" tabIndex={0} role="log" aria-label="Live transcript entries" aria-live="polite" aria-relevant="additions" onScroll={updateFollowState}>
          {live.segments.length === 0 && !live.partial ? <EmptyState icon="microphone" title={live.state === 'idle' ? 'Ready when you are' : live.state === 'requesting' ? 'Waiting for microphone permission' : 'Listening for speech…'} description={live.state === 'idle' ? 'Your microphone stays off until you press Start interpretation.' : 'Final transcript lines and translations will appear here in real time.'} /> : live.segments.map((segment) => <article className="transcript-row" key={segment.id}><div className="transcript-original"><span className="transcript-sequence">{String(segment.sequence).padStart(2, '0')}</span><p dir="auto">{segment.sourceText}</p></div><div className="transcript-translations"><div className={`translation translation--${segment.translationStatus}`}>{segment.translationStatus === 'pending' ? <><span className="translation-dots" aria-hidden="true"><i /><i /><i /></span><span>Translating…</span></> : segment.translationStatus === 'failed' ? <><Icon name="warning" size={16} /><span dir="auto">{segment.translationError || 'Translation unavailable'}</span></> : segment.translationStatus === 'succeeded' ? <><span className="translation-language">{live.session && languageName(live.session.targetLanguage)}</span><p dir="auto">{segment.translation}</p></> : <span className="translation-empty">Translation not requested</span>}</div></div></article>)}
          {live.partial && <article className="transcript-row transcript-row--partial" aria-hidden="true"><div className="transcript-original"><span className="transcript-sequence"><Icon name="wave" size={16} /></span><p dir="auto">{live.partial}<span className="partial-caret" /></p></div><div className="transcript-translations"><span className="translation-empty">Waiting for a complete phrase…</span></div></article>}
        </div>
        {!followingLatest && <Button className="live-jump-latest" size="sm" icon="chevronDown" onClick={jumpToLatest}>Jump to latest</Button>}
      </Card>
      <aside className="live-control-column">
        <Card className="live-control-card" raised>
          <div className={`mic-orb mic-orb--${live.state}`}><span className="mic-orb__pulse" /><Icon name={live.state === 'live' ? 'microphone' : live.state === 'ended' ? 'check' : 'wave'} size={31} /></div>
          <div className="live-control-card__copy"><h2>{live.state === 'idle' ? 'Start interpretation' : live.state === 'live' ? 'Listening now' : live.state === 'ended' ? 'Session complete' : presentation.label}</h2><p dir={live.error ? 'auto' : undefined}>{live.state === 'idle' ? 'You’ll be asked for microphone access.' : live.state === 'live' ? 'Speak naturally. Short pauses help translations arrive sooner.' : live.state === 'ended' ? 'The final transcript has been reconciled with the server.' : live.error || 'Preparing the secure live connection…'}</p></div>
          <LevelMeter active={live.state === 'live'} />
          {terminalSession || live.state === 'ended' ? <Link className={buttonClassName({ variant: 'primary', size: 'lg' })} href={`/history/${sessionId}`}><Icon name="history" size={19} />View transcript</Link> : live.state === 'idle' || live.state === 'error' ? <Button variant="primary" size="lg" icon="microphone" onClick={() => void live.start()}>{live.state === 'error' ? 'Try again' : 'Start interpretation'}</Button> : <Button variant="danger" size="lg" icon="stop" loading={live.state === 'stopping'} disabled={live.state === 'requesting'} onClick={() => void live.stop()}>End session</Button>}
          <p className="live-privacy"><Icon name="shield" size={14} />Audio is streamed only while this control is active.</p>
        </Card>
        <Card className="live-tips"><h3><Icon name="spark" size={17} />For clearer interpretation</h3><ul><li>Keep the microphone close to the speaker.</li><li>Reduce overlapping speech where possible.</li><li>A short pause marks the end of a phrase.</li></ul></Card>
      </aside>
    </div>
  </div>
}
