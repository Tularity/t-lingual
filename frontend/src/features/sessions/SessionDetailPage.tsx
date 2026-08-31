import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { SessionDetailResponse } from '../../api/contracts'
import { Badge, Button, Card, EmptyState, Icon, Skeleton, buttonClassName, useToast } from '../../design-system'
import { Link } from '../../app/router'
import { errorMessage, formatDate, formatDuration, formatTimestamp, languageName } from '../../app/utils'
import { StatusBadge } from './StatusBadge'
import './detail.css'

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadState, setLoadState] = useState<{ sessionId: string; attempt: number; detail: SessionDetailResponse | null; error: string }>(() => ({ sessionId, attempt: 0, detail: null, error: '' }))
  const [loadingMoreRequest, setLoadingMoreRequest] = useState<{ sessionId: string; generation: number } | null>(null)
  const requestGenerationRef = useRef(0); const { push } = useToast()
  const isCurrentLoad = loadState.sessionId === sessionId && loadState.attempt === loadAttempt
  const detail = isCurrentLoad ? loadState.detail : null
  const error = isCurrentLoad ? loadState.error : ''
  const loadingMore = loadingMoreRequest?.sessionId === sessionId
  useEffect(() => {
    let active = true
    const generation = requestGenerationRef.current + 1
    requestGenerationRef.current = generation
    api.sessions.get(sessionId).then((value) => {
      if (active && requestGenerationRef.current === generation) setLoadState({ sessionId, attempt: loadAttempt, detail: value, error: '' })
    }).catch((caught) => {
      if (active && requestGenerationRef.current === generation) setLoadState({ sessionId, attempt: loadAttempt, detail: null, error: errorMessage(caught) })
    })
    return () => { active = false; if (requestGenerationRef.current === generation) requestGenerationRef.current += 1 }
  }, [loadAttempt, sessionId])
  const copyTranscript = async () => {
    if (!detail) return
    const text = detail.segments.map((segment) => `${segment.sourceText}${segment.translation ? `\n${segment.translation}` : ''}`).join('\n\n')
    try { await navigator.clipboard.writeText(text); push({ tone: 'success', title: detail.segmentPage.hasMore ? 'Loaded transcript copied' : 'Transcript copied', message: detail.segmentPage.hasMore ? 'Load the remaining pages to copy the complete transcript.' : undefined }) } catch { push({ tone: 'error', title: 'Clipboard access was denied' }) }
  }
  const loadMore = async () => {
    if (!detail || !detail.segmentPage.hasMore) return
    const generation = requestGenerationRef.current
    setLoadingMoreRequest({ sessionId, generation })
    try {
      const page = await api.sessions.segments(sessionId, { after: detail.segmentPage.nextAfter, limit: 100 })
      if (requestGenerationRef.current !== generation) return
      setLoadState((current) => {
        if (current.sessionId !== sessionId || current.attempt !== loadAttempt || !current.detail || current.detail.session.id !== sessionId) return current
        const segments = new Map(current.detail.segments.map((segment) => [segment.id, segment]))
        page.items.forEach((segment) => segments.set(segment.id, segment))
        return { ...current, detail: { ...current.detail, segments: [...segments.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)), segmentPage: { nextAfter: page.nextAfter, hasMore: page.hasMore, limit: page.limit } } }
      })
    } catch (caught) {
      if (requestGenerationRef.current === generation) push({ tone: 'error', title: 'More transcript could not be loaded', message: errorMessage(caught) })
    }
    finally { setLoadingMoreRequest((current) => current?.sessionId === sessionId && current.generation === generation ? null : current) }
  }
  if (error) return <Card className="detail-error"><EmptyState icon="warning" title="Session unavailable" description={error} action={<div className="detail-error__actions"><Link className={buttonClassName()} href="/history">Back to history</Link><Button variant="primary" onClick={() => setLoadAttempt((current) => current + 1)}>Try again</Button></div>} /></Card>
  if (!detail) return <div className="detail-loading" role="status" aria-label="Loading session transcript"><Skeleton width="36%" height={36} /><Skeleton width="100%" height={125} /><Skeleton width="100%" height={400} /></div>
  const { session, segments } = detail
  const elapsed = session.startedAt && session.endedAt ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() : 0
  return <div className="detail-page"><header className="detail-header"><div><Link className="back-link" href="/history"><Icon name="arrowLeft" size={18} />History</Link><div className="detail-title"><h1 dir="auto">{session.title}</h1><StatusBadge status={session.status} /></div><p>Created {formatDate(session.createdAt)}</p></div><div className="detail-actions"><Button icon="copy" disabled={segments.length === 0} onClick={() => void copyTranscript()}>Copy transcript</Button><Button icon="printer" aria-label={detail.segmentPage.hasMore ? 'Print loaded transcript; more segments remain' : 'Print complete transcript'} title={detail.segmentPage.hasMore ? 'Load the remaining transcript before printing the complete session.' : undefined} onClick={() => window.print()}>{detail.segmentPage.hasMore ? 'Print loaded' : 'Print'}</Button></div></header>
    <Card className="detail-summary"><div><span>Languages</span><strong>{languageName(session.sourceLanguage)} <Icon name="arrowRight" size={14} /> {languageName(session.targetLanguage)}</strong></div><div><span>Duration</span><strong>{formatDuration(elapsed)}</strong></div><div><span>Transcript</span><strong>{detail.segmentPage.hasMore ? `${segments.length}+ loaded` : `${segments.length} ${segments.length === 1 ? 'segment' : 'segments'}`}</strong></div><div><span>Last updated</span><strong>{formatDate(session.updatedAt, { dateStyle: 'medium' })}</strong></div></Card>
    <section className="detail-transcript"><div className="detail-transcript__heading"><div><h2>Transcript</h2><p>Persisted final source speech and translation.</p></div><Badge tone="neutral">{segments.length} shown</Badge></div>{segments.length === 0 ? <Card><EmptyState icon="wave" title="No final transcript" description={session.status === 'live' ? 'This session is still live. Final speech will appear after it is persisted.' : 'This session ended before any complete speech was recognized.'} /></Card> : <Card className="detail-segments">{segments.map((segment) => <article key={segment.id} className="detail-segment"><div className="detail-segment__time">{formatTimestamp(segment.startMs)}</div><div className="detail-segment__content"><p className="detail-segment__original" dir="auto">{segment.sourceText}</p><div className="detail-translation"><span>{languageName(session.targetLanguage)}</span>{segment.translationStatus === 'succeeded' ? <p dir="auto">{segment.translation}</p> : segment.translationStatus === 'failed' ? <p className="detail-translation__error" dir="auto"><Icon name="warning" size={14} />{segment.translationError || 'Translation unavailable'}</p> : <p className="detail-translation__pending">{segment.translationStatus === 'pending' ? 'Translation pending…' : 'Translation was not requested.'}</p>}</div></div></article>)}</Card>}{detail.segmentPage.hasMore && <div className="detail-load-more"><Button loading={loadingMore} onClick={() => void loadMore()}>Load more transcript</Button></div>}</section>
  </div>
}
