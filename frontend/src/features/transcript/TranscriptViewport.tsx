import { useI18n } from '../../app/i18n'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, EmptyState, Icon, Spinner, Tooltip } from '@t-lingual/ui'
import { api } from '../../api/client'
import type { RecognitionGap, Segment, SegmentPageResponse } from '../../api/contracts'
import { errorMessage, formatTimestamp } from '../../app/utils'
import { mergeWindow, PAGE_SIZE, scrollAnchorTop, speakerDisplay, speakerTone, WINDOW_LIMIT, type TranscriptSegment } from './windowModel'
import { LanguageLabel } from '../languages'
import './transcript.css'

type Page = SegmentPageResponse & { hasEarlier?: boolean; hasLater?: boolean; firstSequence?: number; lastSequence?: number }
type PageQuery = { before?: number; after?: number; tail?: boolean; limit: number; search?: string }

export interface TranscriptViewportProps {
  sessionId: string
  playback?: {timeMs:number;playing:boolean;seekToken:number}
  onSeekTime?: (timeMs:number)=>void
  segments: Segment[]
  sourceLanguage: string
  targetLanguage: string
  live?: boolean
  query?: string
  display?: 'parallel' | 'source' | 'translation'
  compact?: boolean
  emptyTitle?: string
  emptyDescription?: string
  initialHasMore?: boolean
  initialHasEarlier?: boolean
  initialHasLater?: boolean
  onWindowChange?: (rows: Segment[]) => void
  /** Stretches of audio recognition missed; their lines arrive later, in their place. */
  gaps?: RecognitionGap[]
  /**
   * Without its own frame and heading, for a page that draws the frame itself
   * with its reading tools across the top. (The tools cannot live inside: the
   * viewport starts afresh for every search, and would take a search box's
   * focus with it.)
   */
  bare?: boolean
}

function normalized(items: Segment[]) {
  return [...items].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)) as TranscriptSegment[]
}

function translationFailure(code?: string) {
  if (code === 'translator_unavailable') return 'Translation service unavailable'
  if (code === 'source_language_detection_failed') return 'The source language could not be identified'
  if (code === 'source_language_unsupported') return 'This source language is not supported'
  if (code === 'capacity_exhausted') return 'Translation is busy. Try again later'
  return 'Translation unavailable'
}

/** Where recognition missed some audio: waiting to be recognized, being recognized, or not recognized. */
function GapMarker({ gap }: { gap: RecognitionGap }) {
  const { t } = useI18n()
  const span = { from: formatTimestamp(gap.startMs), to: formatTimestamp(gap.endMs) }
  return <div className="tv-gap" data-state={gap.state} role="note">
    <Icon name={gap.state === 'failed' ? 'warning' : gap.state === 'filling' ? 'refresh' : 'history'} size={15} />
    <span>{gap.state === 'failed' ? t('Speech from {from} to {to} couldn’t be recognized. The audio is still saved.', span)
      : gap.state === 'filling' ? t('Recognizing speech from {from} to {to} that was missed while recognition was away…', span)
      : t('Speech from {from} to {to} was missed while recognition was away. It will appear here once recognition catches up.', span)}</span>
  </div>
}

function TranscriptRow({ segment, sourceLanguage, targetLanguage, display, playing, onSeekTime }: {
  segment: TranscriptSegment
  sourceLanguage: string
  targetLanguage: string
  display: NonNullable<TranscriptViewportProps['display']>
  playing?: boolean
  onSeekTime?: (timeMs:number)=>void
}) {
  const {t,formatDate}=useI18n()

  const [detailsOpen, setDetailsOpen] = useState(false)
  const speaker = speakerDisplay(segment,t)
  const details = <div className="tv-row-details"><strong>{t("Phrase")}{' '}{segment.sequence}</strong><span>{formatDate(segment.createdAt)}</span>{speaker && <span>{speaker}</span>}<LanguageLabel code={segment.detectedLanguage ?? sourceLanguage} />{segment.languageSource && <small>{segment.languageSource === 'translator' ? t('Language identified by translator') : segment.languageSource === 'text' ? t("Language inferred from transcript") : segment.languageSource === 'session' ? t("Language selected for this session") : t("Language reported by recognizer")}</small>}{segment.sourceDetection?.uncertain && <small>{t('Language identification is uncertain')}</small>}<span>{segment.final ? t("Speech finalized") : t("Speech in progress")}</span><small className="tv-row-details__id">{segment.id}</small></div>
  return <article className="tv-row" data-transcript-row={segment.sequence} data-segment-id={segment.id} data-speaker-tone={speakerTone(segment.speakerId)} data-final={segment.final || undefined} data-playing={playing || undefined}>
    <div className="tv-row__meta"><Tooltip content={details} open={detailsOpen} onOpenChange={setDetailsOpen} placement="right" openDelay={250}><button type="button" className="tv-row__time" aria-label={onSeekTime?t('Seek to {time}',{time:formatTimestamp(segment.startMs)}):t('Phrase details at {time}',{time:formatTimestamp(segment.startMs)})} onClick={() => {if(onSeekTime){setDetailsOpen(false);onSeekTime(segment.startMs)}else setDetailsOpen(open => !open)}}><time>{formatTimestamp(segment.startMs)}</time></button></Tooltip>{speaker && <span className="tv-row__speaker" dir="auto" title={speaker}>{speaker}</span>}</div>
    {display !== 'translation' && <div className="tv-row__source"><p dir="auto">{segment.sourceText}{!segment.final && <span className="tv-row__caret" aria-hidden="true" />}</p></div>}
    {display !== 'source' && <div className="tv-row__translation">{segment.translationStatus === 'failed' ? <p className="tv-row__failure" dir="auto"><Icon name="warning" size={15} />{t(translationFailure(segment.translationError))}</p> : segment.translation ? <p dir="auto">{segment.translation}{segment.translationStatus === 'pending' && <span className="tv-row__caret" aria-hidden="true" />}</p> : segment.detectedLanguage === targetLanguage && segment.final && segment.translationStatus === 'not_requested' ? <p dir="auto">{segment.sourceText}</p> : <p className="tv-row__pending" aria-label={segment.translationStatus === 'pending' ? t("Translation in progress") : t("No translation yet")}>{segment.final && segment.translationStatus === 'pending' ? <span className="tv-row__caret" aria-hidden="true" /> : null}</p>}</div>}
  </article>
}

function ViewportInner({ sessionId, playback, onSeekTime, segments, sourceLanguage, targetLanguage, live = false, query = '', display = 'parallel', compact = false, emptyTitle = 'No transcript yet', emptyDescription = 'Recognized speech will appear here.', initialHasMore = false, initialHasEarlier, initialHasLater, onWindowChange, gaps = [], bare = false }: TranscriptViewportProps) {
  const {t}=useI18n()

  const search = query.trim()
  const incoming = useMemo(() => normalized(segments), [segments])
  const [rows, setRows] = useState<TranscriptSegment[]>(() => search ? [] : live ? incoming.slice(-WINDOW_LIMIT) : incoming.slice(0, WINDOW_LIMIT))
  const [followPlayback,setFollowPlayback]=useState(true)
  const playbackSeekRef=useRef(-1)
  const playbackEpochRef=useRef(0)
  const playbackBusyRef=useRef(false)
  const rowsRef = useRef(rows)
  const [hasEarlier, setHasEarlier] = useState(initialHasEarlier ?? ((live && incoming.length > WINDOW_LIMIT) || (rows[0]?.sequence ?? 1) > 1))
  const [hasLater, setHasLater] = useState(initialHasLater ?? (initialHasMore || (!live && incoming.length > WINDOW_LIMIT)))
  const laterRef = useRef(hasLater)
  const [following, setFollowing] = useState(live)
  const followingRef = useRef(live)
  const previousLiveRef = useRef(live)
  const [unread, setUnread] = useState(0)
  const newestSeenRef = useRef(incoming.at(-1)?.sequence ?? 0)
  const [busy, setBusy] = useState<'older' | 'newer' | 'latest' | 'search' | null>(search ? 'search' : null)
  const busyRef = useRef(false)
  const [earlierError, setEarlierError] = useState('')
  const [laterError, setLaterError] = useState('')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<{ id: string; top: number; scrollTop: number; previousHeight: number } | null>(null)
  const pinBottomRef = useRef(live && !search)
  const programmaticRef = useRef(false)
  const programmaticTopRef = useRef(0)
  const activeRef = useRef(true)
  const onWindowChangeRef = useRef(onWindowChange)

  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false } }, [])
  useLayoutEffect(() => { rowsRef.current = rows; laterRef.current = hasLater }, [rows, hasLater])
  useLayoutEffect(() => { onWindowChangeRef.current = onWindowChange }, [onWindowChange])
  useEffect(() => { onWindowChangeRef.current?.(rows) }, [rows])
  useEffect(() => {
    const becameLive = live && !previousLiveRef.current
    previousLiveRef.current = live
    if (!becameLive) return
    queueMicrotask(() => {
      if (!activeRef.current) return
      followingRef.current = true
      setFollowing(true)
      setUnread(0)
      pinBottomRef.current = true
      if (incoming.length) {
        setRows(incoming.slice(-WINDOW_LIMIT))
        setHasEarlier((incoming[0]?.sequence ?? 1) > 1 || incoming.length > WINDOW_LIMIT)
        setHasLater(false)
      }
    })
  }, [incoming, live])

  // A reader may be paging outside the live tail when translation begins.
  // Reconcile only visible pending rows; SSE still supplies normal live updates.
  useEffect(() => {
    if (__TLINGUAL_DEVELOPMENT_MOCK__ || !rows.some(row => row.final && row.translationStatus === 'pending')) return
    let active = true
    let busy = false
    const first = rows[0]?.sequence
    if (first === undefined) return
    const timer = window.setInterval(() => {
      if (busy) return
      busy=true
      void api.sessions.segments(sessionId,{after:Math.max(0,first-1),limit:WINDOW_LIMIT,...(search ? {search} : {})}).then(page => {
        if (!active) return
        setRows(current => mergeWindow(current,page.items.filter(item => current.some(row => row.id === item.id)),'newer'))
      }).catch(() => undefined).finally(() => {busy=false})
    },1000)
    return () => {active=false;window.clearInterval(timer)}
  },[rows,search,sessionId])

  const playbackTime=playback?.timeMs
  const playbackPlaying=playback?.playing
  const playbackSeek=playback?.seekToken
  useEffect(()=>{
    if(playbackTime===undefined||playbackSeek===undefined){playbackEpochRef.current++;playbackBusyRef.current=false;return}
    const explicit=playbackSeek!==playbackSeekRef.current
    if(explicit){playbackSeekRef.current=playbackSeek;setFollowPlayback(true)}
    if(!explicit&&(!playbackPlaying||!followPlayback))return
    const time=playbackTime
    const current=rowsRef.current
    const first=current[0],last=current.at(-1)
    const scrollToTime=(items:TranscriptSegment[])=>{
      const match=[...items].reverse().find(item=>item.startMs<=time)??items[0]
      window.requestAnimationFrame(()=>{
        const viewport=scrollRef.current
        const row=viewport?.querySelector<HTMLElement>(`[data-transcript-row="${match?.sequence}"]`)
        if(!viewport||!row)return
        const box=viewport.getBoundingClientRect(),item=row.getBoundingClientRect()
        if(explicit||item.top<box.top+8||item.bottom>box.bottom-8){programmaticRef.current=true;viewport.scrollTop+=item.top-box.top-24;programmaticTopRef.current=viewport.scrollTop}
      })
    }
    if(first&&last&&time>=first.startMs&&(time<=last.endMs||!laterRef.current)){scrollToTime(current);return}
    if(playbackBusyRef.current&&!explicit)return
    const epoch=++playbackEpochRef.current
    const timer=window.setTimeout(()=>{
      playbackBusyRef.current=true
      void api.sessions.segments(sessionId,{atMs:time,limit:WINDOW_LIMIT}).then(page=>{
        if(epoch!==playbackEpochRef.current||!activeRef.current)return
        const next=normalized(page.items).slice(0,WINDOW_LIMIT)
        setRows(next);setHasEarlier(page.hasEarlier??false);setHasLater(page.hasLater??page.hasMore)
        setFollowing(false);followingRef.current=false;scrollToTime(next)
      }).catch(caught=>{if(epoch===playbackEpochRef.current&&activeRef.current)setLaterError(errorMessage(caught))}).finally(()=>{if(epoch===playbackEpochRef.current)playbackBusyRef.current=false})
    },explicit?100:0)
    return ()=>{window.clearTimeout(timer)}
  },[playbackTime,playbackPlaying,playbackSeek,followPlayback,sessionId])

  const captureAnchor = () => {
    const viewport = scrollRef.current
    if (!viewport) return
    const top = viewport.getBoundingClientRect().top
    const firstVisible = Array.from(viewport.querySelectorAll<HTMLElement>('[data-transcript-row]')).find((row) => row.getBoundingClientRect().bottom > top + 4)
    if (firstVisible?.dataset.transcriptRow) anchorRef.current = { id: firstVisible.dataset.transcriptRow, top: firstVisible.getBoundingClientRect().top, scrollTop: viewport.scrollTop, previousHeight: viewport.scrollHeight }
  }

  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const anchor = anchorRef.current
    if (anchor) {
      const match = Array.from(viewport.querySelectorAll<HTMLElement>('[data-transcript-row]')).find((row) => row.dataset.transcriptRow === anchor.id)
      programmaticRef.current = true
      viewport.scrollTop = match ? scrollAnchorTop(anchor.scrollTop, anchor.top, match.getBoundingClientRect().top) : Math.max(0, anchor.scrollTop + viewport.scrollHeight - anchor.previousHeight)
      programmaticTopRef.current = viewport.scrollTop
      anchorRef.current = null
    } else if (pinBottomRef.current) {
      programmaticRef.current = true
      viewport.scrollTop = viewport.scrollHeight
      programmaticTopRef.current = viewport.scrollTop
      pinBottomRef.current = false
    }
  }, [rows])

  const requestPage = useCallback(async (direction: 'older' | 'newer') => {
    const boundary = direction === 'older' ? rowsRef.current[0]?.sequence : rowsRef.current.at(-1)?.sequence
    if (boundary === undefined || busyRef.current) return
    busyRef.current = true
    setBusy(direction)
    if (direction === 'older') setEarlierError(''); else setLaterError('')
    try {
      const queryParams: PageQuery = { [direction === 'older' ? 'before' : 'after']: boundary, limit: PAGE_SIZE, ...(search ? { search } : {}) }
      const page = await api.sessions.segments(sessionId, queryParams as Parameters<typeof api.sessions.segments>[1]) as Page
      if (!activeRef.current) return
      const fetched = normalized(page.items)
      if (!fetched.length) {
        if (direction === 'older') setHasEarlier(false); else setHasLater(false)
        return
      }
      captureAnchor()
      const current = rowsRef.current
      const merged = mergeWindow(current, fetched, direction)
      const trimmedHead = merged[0]!.sequence > Math.min(current[0]!.sequence, fetched[0]!.sequence)
      const trimmedTail = merged.at(-1)!.sequence < Math.max(current.at(-1)!.sequence, fetched.at(-1)!.sequence)
      setRows(merged)
      if (direction === 'older') {
        setHasEarlier(page.hasEarlier ?? (fetched.length === PAGE_SIZE && fetched[0]!.sequence > 1))
        if (trimmedTail) { setHasLater(true); followingRef.current = false; setFollowing(false) }
      } else {
        setHasLater(page.hasLater ?? page.hasMore)
        if (trimmedHead) setHasEarlier(true)
      }
    } catch (caught) {
      if (activeRef.current) (direction === 'older' ? setEarlierError : setLaterError)(errorMessage(caught))
    } finally { if (activeRef.current) { busyRef.current = false; setBusy(null) } }
  }, [search, sessionId])

  useEffect(() => {
    if (!search) return
    let active = true
    const timer = window.setTimeout(async () => {
      busyRef.current = true
      try {
        const page = await api.sessions.segments(sessionId, { limit: WINDOW_LIMIT, search } as Parameters<typeof api.sessions.segments>[1]) as Page
        if (!active || !activeRef.current) return
        setRows(normalized(page.items).slice(0, WINDOW_LIMIT))
        setHasEarlier(page.hasEarlier ?? false)
        setHasLater(page.hasLater ?? page.hasMore)
      } catch (caught) { if (active && activeRef.current) setLaterError(errorMessage(caught)) }
      finally { if (active && activeRef.current) { busyRef.current = false; setBusy(null) } }
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [search, searchAttempt, sessionId])

  useEffect(() => {
    if (search || incoming.length === 0) return
    const latest = incoming.at(-1)!.sequence
    const newlyArrived = incoming.filter((segment) => segment.sequence > newestSeenRef.current).length
    newestSeenRef.current = Math.max(newestSeenRef.current, latest)
    if (rowsRef.current.length === 0) {
      const next = live ? incoming.slice(-WINDOW_LIMIT) : incoming.slice(0, WINDOW_LIMIT)
      setRows(next)
      setHasEarlier(initialHasEarlier ?? (next[0]?.sequence ?? 1) > 1)
      setHasLater(initialHasLater ?? (initialHasMore || (!live && incoming.length > WINDOW_LIMIT)))
      if (live) pinBottomRef.current = true
      return
    }
    const known = new Set(rowsRef.current.map((segment) => segment.sequence))
    const first = rowsRef.current[0]?.sequence ?? 0
    const last = rowsRef.current.at(-1)?.sequence ?? 0
    // Lines recognized late, from audio recognition missed, belong between
    // lines already shown: their sequence numbers were kept free for them.
    const inside = incoming.filter((segment) => !known.has(segment.sequence) && segment.sequence > first && segment.sequence < last)
    const updates = [...incoming.filter((segment) => known.has(segment.sequence)), ...inside]
    if (inside.length && rowsRef.current.length + inside.length > WINDOW_LIMIT) setHasEarlier(true)
    const tail = incoming.filter((segment) => segment.sequence > (rowsRef.current.at(-1)?.sequence ?? 0))
    const canAppend = live && followingRef.current && !laterRef.current
    if (updates.length || canAppend && tail.length) {
      if (canAppend) pinBottomRef.current = true
      setRows((current) => mergeWindow(current, canAppend ? [...updates, ...tail] : updates, 'newer'))
      if (canAppend && tail.length && rowsRef.current.length + tail.length > WINDOW_LIMIT) setHasEarlier(true)
    }
    if (!canAppend && newlyArrived > 0) {
      setUnread((count) => count + newlyArrived)
      // The live tail can advance beyond the client cache while someone reads.
      // Walk forward through persisted pages instead of skipping the hidden gap.
      setHasLater(true)
    }
  }, [incoming, initialHasEarlier, initialHasLater, initialHasMore, live, search])

  const jumpToLatest = async () => {
    if (busyRef.current) return
    setLaterError('')
    if (laterRef.current) {
      busyRef.current = true; setBusy('latest')
      try {
        const page = await api.sessions.segments(sessionId, { tail: true, limit: WINDOW_LIMIT, ...(search ? { search } : {}) } as Parameters<typeof api.sessions.segments>[1]) as Page
        if (!activeRef.current) return
        const tail = normalized(page.items).slice(-WINDOW_LIMIT)
        setRows(mergeWindow([], tail, 'newer'))
        setHasEarlier(page.hasEarlier ?? (tail[0]?.sequence ?? 1) > 1)
        setHasLater(false)
      } catch (caught) { if (activeRef.current) setLaterError(errorMessage(caught)); return }
      finally { if (activeRef.current) { busyRef.current = false; setBusy(null) } }
    } else if (incoming.length) {
      setRows((current) => mergeWindow(current, incoming.slice(-WINDOW_LIMIT), 'newer'))
    }
    followingRef.current = true; setFollowing(true); setUnread(0); pinBottomRef.current = true
    const viewport = scrollRef.current
    if (viewport) { programmaticRef.current = true; viewport.scrollTop = viewport.scrollHeight; programmaticTopRef.current = viewport.scrollTop; viewport.focus() }
  }

  const onScroll = () => {
    const viewport = scrollRef.current
    if (!viewport) return
    if (programmaticRef.current) {
      programmaticRef.current = false
      if (Math.abs(viewport.scrollTop - programmaticTopRef.current) < 2) return
    }
    if(playback?.playing)setFollowPlayback(false)
    if (viewport.scrollTop < 90 && hasEarlier) void requestPage('older')
    const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90
    if (nearBottom && hasLater) void requestPage('newer')
    const shouldFollow = nearBottom && !hasLater
    if (shouldFollow !== followingRef.current) { followingRef.current = shouldFollow; setFollowing(shouldFollow) }
    if (shouldFollow) setUnread(0)
  }

  const visibleLanguages=[...new Set(rows.map(row=>row.detectedLanguage).filter(code=>code&&code!=='auto'))]
  const visibleSource=visibleLanguages.length===1?visibleLanguages[0]!:visibleLanguages.length>1?'auto':sourceLanguage
  const noRows = rows.length === 0 && busy !== 'search'
  // A gap shows after the lines already recognized in it, before the first
  // line after it — and only where this window reaches both sides of it.
  const openGaps = search ? [] : gaps.filter((gap) => gap.state !== 'filled' && (!hasEarlier || (rows[0]?.sequence ?? Infinity) < gap.sequenceFrom))
  const gapsBefore = (index: number) => openGaps.filter((gap) => rows[index]!.sequence > gap.sequenceTo && (index === 0 || rows[index - 1]!.sequence <= gap.sequenceTo))
  const trailingGaps = hasLater ? [] : openGaps.filter((gap) => (rows.at(-1)?.sequence ?? 0) <= gap.sequenceTo)
  return <section className="tv" data-bare={bare || undefined} data-display={display} data-compact={compact || undefined} data-following={following || undefined}>
    {!bare && <div className="tv__top"><div className="tv__heading"><Icon name="wave" size={19} /><h2>{t("Transcript")}</h2>{live && <Badge variant="accent" size="sm" dot>{t("Live")}</Badge>}</div><div className="tv__count">{rows.length ? t('{count} shown',{count:rows.length}) : search ? t("Search results") : t("No phrases")}{hasEarlier || hasLater ? t(" · more available") : ''}</div></div>}
    <div className="tv__columns"><span>{t("Time")}</span>{display !== 'translation' && <span><LanguageLabel code={visibleSource}>{visibleSource === 'auto' ? t("Mixed languages") : undefined}</LanguageLabel> <small>{t("Original")}</small></span>}{display !== 'source' && <span><LanguageLabel code={targetLanguage} /> <small>{t("Translation")}</small></span>}</div>
    <div ref={scrollRef} className="tv__scroll" tabIndex={0} role="region" aria-label={t("Transcript entries")} onScroll={onScroll}>
      {hasEarlier && <div className="tv__edge"><Button size="sm" variant="subtle" icon={<Icon name="arrowUp" size={15} />} loading={busy === 'older'} onClick={() => void requestPage('older')}>{t("Earlier phrases")}</Button>{earlierError && <span role="alert">{earlierError} <button type="button" onClick={() => void requestPage('older')}>{t("Retry")}</button></span>}</div>}
      {busy === 'search' && <div className="tv__loading"><Spinner label={t("Searching transcript")} /></div>}
      {noRows && !laterError && <div className="tv__empty"><EmptyState icon={<Icon name={search ? 'search' : 'wave'} />} title={search ? t("No matching phrases") : emptyTitle} description={search ? t("Try another word or phrase.") : emptyDescription} /></div>}
      {rows.map((segment, index) => <Fragment key={`${sessionId}:${segment.sequence}`}>
        {gapsBefore(index).map((gap) => <GapMarker key={gap.id} gap={gap} />)}
        <TranscriptRow segment={segment} playing={playback!==undefined&&playback.timeMs>=segment.startMs&&playback.timeMs<segment.endMs} onSeekTime={onSeekTime} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage} display={display} />
      </Fragment>)}
      {rows.length ? trailingGaps.map((gap) => <GapMarker key={gap.id} gap={gap} />) : null}
      {hasLater && <div className="tv__edge"><Button size="sm" variant="subtle" icon={<Icon name="arrowDown" size={15} />} loading={busy === 'newer'} onClick={() => void requestPage('newer')}>{t("Newer phrases")}</Button></div>}
      {laterError && <div className="tv__edge tv__edge--error" role="alert"><span>{laterError}</span><Button size="sm" onClick={() => { if (search && rows.length === 0) { setLaterError(''); setBusy('search'); setSearchAttempt((attempt) => attempt + 1) } else void (hasLater ? requestPage('newer') : jumpToLatest()) }}>{t("Retry")}</Button></div>}
    </div>
    {playback && !followPlayback && <div className="tv__bottom"><span>{t("Playback")}</span><Button size="sm" variant="subtle" onClick={()=>{playbackSeekRef.current=-1;setFollowPlayback(true)}}>{t("Follow playback")}</Button></div>}
    {(unread > 0 || hasLater || !following && live) && <div className="tv__bottom"><span aria-live="polite">{unread > 0 ? t(unread===1?'{count} new phrase':'{count} new phrases',{count:unread}) : live ? following ? t("Following live speech") : t("Reading earlier speech") : t("Saved transcript")}</span>{(unread > 0 || hasLater || !following && live) && <Button size="sm" variant="subtle" icon={<Icon name="arrowDown" size={15} />} loading={busy === 'latest'} onClick={() => void jumpToLatest()}>{t("Jump to latest")}</Button>}</div>}
  </section>
}

export function TranscriptViewport(props: TranscriptViewportProps) {
  return <ViewportInner key={`${props.sessionId}:${props.query?.trim() ?? ''}`} {...props} />
}
